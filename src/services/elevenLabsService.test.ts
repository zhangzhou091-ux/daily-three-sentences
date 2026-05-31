import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

function setupIOS(): void {
  Object.defineProperty(navigator, 'userAgent', {
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    writable: true,
    configurable: true,
  });
  Object.defineProperty(navigator, 'platform', {
    value: 'iPhone',
    writable: true,
    configurable: true,
  });
  Object.defineProperty(navigator, 'maxTouchPoints', {
    value: 5,
    writable: true,
    configurable: true,
  });
}

function setupNonIOS(): void {
  Object.defineProperty(navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
    writable: true,
    configurable: true,
  });
  Object.defineProperty(navigator, 'platform', {
    value: 'Win32',
    writable: true,
    configurable: true,
  });
  Object.defineProperty(navigator, 'maxTouchPoints', {
    value: 0,
    writable: true,
    configurable: true,
  });
}

const createdAudioInstances: MockAudio[] = [];

class MockAudio {
  private _src: string = '';
  loop: boolean = false;
  volume: number = 1.0;
  preload: string = '';
  crossOrigin: string = '';
  playbackRate: number = 1;
  currentTime: number = 0;
  paused: boolean = true;
  readyState: number = 0;
  duration: number = 3;
  error: { code: number } | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  oncanplay: (() => void) | null = null;
  onloadeddata: (() => void) | null = null;
  onpause: (() => void) | null = null;

  constructor() {
    createdAudioInstances.push(this);
  }

  get src(): string {
    return this._src;
  }

  set src(value: string) {
    this._src = value;
    if (value && value.startsWith('blob:')) {
      this.readyState = 4;
      queueMicrotask(() => {
        if (this.onloadeddata) this.onloadeddata();
        if (this.oncanplay) this.oncanplay();
      });
    }
  }

  get currentSrc(): string {
    return this._src;
  }

  play() {
    this.paused = false;
    queueMicrotask(() => {
      if (this.onended && !this.loop) this.onended();
    });
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    if (this.onpause) this.onpause();
  }

  load() {}
  removeAttribute() {}
}

const mockCacheGet = vi.fn().mockResolvedValue(null);
const mockCacheGetStale = vi.fn().mockResolvedValue(null);
const mockCachePut = vi.fn().mockResolvedValue(true);
const mockCacheClear = vi.fn().mockResolvedValue(undefined);
const mockCacheFormatSize = vi.fn().mockReturnValue('1.0 KB');

const mockCloudCacheGet = vi.fn().mockResolvedValue(null);
const mockCloudCachePut = vi.fn().mockResolvedValue(true);

vi.mock('./elevenLabsCacheService', () => ({
  elevenLabsCacheService: {
    get: (...args: unknown[]) => mockCacheGet(...args),
    getStale: (...args: unknown[]) => mockCacheGetStale(...args),
    put: (...args: unknown[]) => mockCachePut(...args),
    clear: (...args: unknown[]) => mockCacheClear(...args),
    formatSize: (...args: unknown[]) => mockCacheFormatSize(...args),
  },
}));

vi.mock('./ttsCloudCacheService', () => ({
  ttsCloudCacheService: {
    get: (...args: unknown[]) => mockCloudCacheGet(...args),
    put: (...args: unknown[]) => mockCloudCachePut(...args),
  },
}));

const validAudioBytes = new Uint8Array([0xFF, 0xFB, 0x90, 0x00]).buffer;
const validApiKey = 'sk_0000000000000000000000000000000000000000';

function mockFetchForSpeak(responseOverride?: Response): void {
  const mockFetch = vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/v1/voices')) {
      return { ok: true, status: 200, headers: new Headers() };
    }
    if (typeof url === 'string' && url.includes('/v1/user')) {
      return { ok: true, status: 200, json: () => Promise.resolve({ subscription: {} }) };
    }
    if (responseOverride) {
      return responseOverride;
    }
    const validBlob = new Blob([validAudioBytes], { type: 'audio/mpeg' });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'audio/mpeg', 'Content-Length': String(validAudioBytes.byteLength) }),
      blob: () => Promise.resolve(validBlob),
      arrayBuffer: () => Promise.resolve(validAudioBytes),
    };
  });
  vi.stubGlobal('fetch', mockFetch);
}

function createMockResponse(body: ArrayBuffer | null, blobOverride?: Blob): Response {
  const blob = blobOverride ?? (body ? new Blob([body], { type: 'audio/mpeg' }) : new Blob([], { type: 'audio/mpeg' }));
  const headers = new Headers({
    'Content-Type': 'audio/mpeg',
    'Content-Length': body ? String(body.byteLength) : '0',
  });
  return {
    ok: true,
    status: 200,
    headers,
    blob: vi.fn().mockResolvedValue(blob),
    arrayBuffer: vi.fn().mockResolvedValue(body ?? new ArrayBuffer(0)),
    json: vi.fn().mockRejectedValue(new Error('not json')),
    text: vi.fn().mockRejectedValue(new Error('not text')),
  } as unknown as Response;
}

describe('elevenLabsService - iOS 兼容性修复验证', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('Audio', MockAudio);
    vi.stubGlobal('MediaError', {
      MEDIA_ERR_ABORTED: 1,
      MEDIA_ERR_NETWORK: 2,
      MEDIA_ERR_DECODE: 3,
      MEDIA_ERR_SRC_NOT_SUPPORTED: 4,
    });
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn().mockReturnValue('blob:mock-url'),
      revokeObjectURL: vi.fn(),
    });
    createdAudioInstances.length = 0;
    mockCacheGet.mockResolvedValue(null);
    mockCacheGetStale.mockResolvedValue(null);
    mockCachePut.mockResolvedValue(true);
    mockCloudCacheGet.mockResolvedValue(null);
    mockCloudCachePut.mockResolvedValue(true);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('方案 A: fetchAudioBlob - iOS 使用 arrayBuffer() 替代 response.blob()', () => {
    it('iOS 下 response.blob() 返回空时，应使用 arrayBuffer() 降级并成功构造 Blob', async () => {
      setupIOS();

      const emptyBlob = new Blob([], { type: 'audio/mpeg' });
      const mockResponse = createMockResponse(validAudioBytes, emptyBlob);
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const { elevenLabsService } = await import('./elevenLabsService');
      const result = await elevenLabsService.fetchAudioBlob(
        'Hello world',
        'sk-test-api-key',
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result).not.toBeNull();
      expect(result!.size).toBe(validAudioBytes.byteLength);
      expect(result!.type).toBe('audio/mpeg');
      expect(mockResponse.arrayBuffer).toHaveBeenCalled();
    });

    it('iOS 下 fetch 返回空 body 时应返回 null', async () => {
      setupIOS();

      const emptyBlob = new Blob([], { type: 'audio/mpeg' });
      const mockResponse = createMockResponse(new ArrayBuffer(0), emptyBlob);
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const { elevenLabsService } = await import('./elevenLabsService');
      const result = await elevenLabsService.fetchAudioBlob(
        'Hello world',
        'sk-test-api-key',
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result).toBeNull();
    });

    it('非 iOS 下 response.blob() 正常时应使用 blob() 获取音频', async () => {
      setupNonIOS();

      const validBlob = new Blob([validAudioBytes], { type: 'audio/mpeg' });
      const mockResponse = createMockResponse(validAudioBytes, validBlob);
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const { elevenLabsService } = await import('./elevenLabsService');
      const result = await elevenLabsService.fetchAudioBlob(
        'Hello world',
        'sk-test-api-key',
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result).not.toBeNull();
      expect(result!.size).toBe(validAudioBytes.byteLength);
      expect(mockResponse.blob).toHaveBeenCalled();
    });

    it('API 返回非 200 状态码时应返回 null', async () => {
      setupNonIOS();

      const mockResponse = {
        ok: false,
        status: 401,
        headers: new Headers(),
      } as unknown as Response;
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const { elevenLabsService } = await import('./elevenLabsService');
      const result = await elevenLabsService.fetchAudioBlob(
        'Hello world',
        'sk-test-api-key',
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result).toBeNull();
    });
  });

  describe('方案 A 补充: speak() 中非 iOS 下 response.blob() 异常降级 arrayBuffer()', () => {
    it('非 iOS 下 response.blob() 抛出异常时，应降级到 arrayBuffer() 并成功播放', async () => {
      setupNonIOS();

      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'audio/mpeg' }),
        blob: vi.fn().mockRejectedValue(new Error('blob() not available')),
        arrayBuffer: vi.fn().mockResolvedValue(validAudioBytes),
        json: vi.fn().mockRejectedValue(new Error('not json')),
        text: vi.fn().mockRejectedValue(new Error('not text')),
      } as unknown as Response;
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const { elevenLabsService } = await import('./elevenLabsService');
      const result = await elevenLabsService.speak(
        'Hello world',
        'sk-test-api-key',
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result.success).toBe(true);
      expect(mockResponse.blob).toHaveBeenCalled();
      expect(mockResponse.arrayBuffer).toHaveBeenCalled();

      const audio = createdAudioInstances[0];
      expect(audio).toBeDefined();
      expect(audio.crossOrigin).toBe('anonymous');
    });
  });

  describe('方案 B: playAudioBlob - iOS 跳过 crossOrigin', () => {
    it('iOS 下通过 speak() 使用缓存时应跳过 crossOrigin = anonymous', async () => {
      setupIOS();
      mockCacheGet.mockResolvedValue(new Blob([validAudioBytes], { type: 'audio/mpeg' }));

      const { elevenLabsService } = await import('./elevenLabsService');

      const result = await elevenLabsService.speak(
        'Hello world',
        'sk-test-api-key',
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result.success).toBe(true);
      const audio = createdAudioInstances[0];
      expect(audio).toBeDefined();
      expect(audio.crossOrigin).toBe('');
    });

    it('非 iOS 下通过 speak() 使用缓存时应设置 crossOrigin = anonymous', async () => {
      setupNonIOS();
      mockCacheGet.mockResolvedValue(new Blob([validAudioBytes], { type: 'audio/mpeg' }));

      const { elevenLabsService } = await import('./elevenLabsService');

      const result = await elevenLabsService.speak(
        'Hello world',
        'sk-test-api-key',
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result.success).toBe(true);
      const audio = createdAudioInstances[0];
      expect(audio).toBeDefined();
      expect(audio.crossOrigin).toBe('anonymous');
    });
  });

  describe('方案 A+B 组合验证: speak() 完整链路', () => {
    it('iOS 下 API 返回空 blob() 时，应降级 arrayBuffer 并成功播放（crossOrigin 不设置）', async () => {
      setupIOS();

      const emptyBlob = new Blob([], { type: 'audio/mpeg' });
      const mockResponse = createMockResponse(validAudioBytes, emptyBlob);
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const { elevenLabsService } = await import('./elevenLabsService');
      const result = await elevenLabsService.speak(
        'Hello world',
        'sk-test-api-key',
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result.success).toBe(true);
      expect(mockResponse.arrayBuffer).toHaveBeenCalled();

      const audio = createdAudioInstances[0];
      expect(audio).toBeDefined();
      expect(audio.crossOrigin).toBe('');
    });

    it('非 iOS 下正常 API 调用应播放成功（crossOrigin 设置 anonymous）', async () => {
      setupNonIOS();

      const validBlob = new Blob([validAudioBytes], { type: 'audio/mpeg' });
      const mockResponse = createMockResponse(validAudioBytes, validBlob);
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const { elevenLabsService } = await import('./elevenLabsService');
      const result = await elevenLabsService.speak(
        'Hello world',
        'sk-test-api-key',
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result.success).toBe(true);
      expect(mockResponse.blob).toHaveBeenCalled();

      const audio = createdAudioInstances[0];
      expect(audio).toBeDefined();
      expect(audio.crossOrigin).toBe('anonymous');
    });
  });

  describe('iOS 播放行为: NotAllowedError 重试机制', () => {
    it('iOS 下第一次 play() 抛出 NotAllowedError 时，应重试（最多 3 次）', async () => {
      setupIOS();
      vi.useFakeTimers();

      let playCallCount = 0;

      class RetryMockAudio extends MockAudio {
        play() {
          playCallCount++;
          this.paused = false;
          if (playCallCount < 3) {
            return Promise.reject(new DOMException('The request is not allowed', 'NotAllowedError'));
          }
          queueMicrotask(() => {
            if (this.onended && !this.loop) this.onended();
          });
          return Promise.resolve();
        }
      }

      vi.stubGlobal('Audio', RetryMockAudio);
      mockCacheGet.mockResolvedValue(new Blob([validAudioBytes], { type: 'audio/mpeg' }));

      const { elevenLabsService } = await import('./elevenLabsService');

      const speakPromise = elevenLabsService.speak(
        'Hello world',
        'sk-test-api-key',
        '21m00Tcm4TlvDq8ikWAM',
      );

      await vi.advanceTimersByTimeAsync(200);
      await vi.advanceTimersByTimeAsync(400);
      await vi.advanceTimersByTimeAsync(100);

      const result = await speakPromise;

      expect(result.success).toBe(true);
      expect(playCallCount).toBe(3);

      vi.useRealTimers();
    });

    it('iOS 下 NotAllowedError 重试 3 次均失败时，应返回错误', async () => {
      setupIOS();
      mockFetchForSpeak();
      vi.useFakeTimers();

      let playCallCount = 0;

      class FailMockAudio extends MockAudio {
        play() {
          playCallCount++;
          this.paused = false;
          return Promise.reject(new DOMException('The request is not allowed', 'NotAllowedError'));
        }
      }

      vi.stubGlobal('Audio', FailMockAudio);
      mockCacheGet.mockResolvedValue(new Blob([validAudioBytes], { type: 'audio/mpeg' }));

      const { elevenLabsService } = await import('./elevenLabsService');

      const speakPromise = elevenLabsService.speak(
        'Hello world',
        validApiKey,
        '21m00Tcm4TlvDq8ikWAM',
      );

      await vi.advanceTimersByTimeAsync(200);
      await vi.advanceTimersByTimeAsync(400);
      await vi.advanceTimersByTimeAsync(100);

      const result = await speakPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('请先点击页面后重试');

      vi.useRealTimers();
    });

    it('非 iOS 下 NotAllowedError 不应重试，直接返回错误', async () => {
      setupNonIOS();
      mockFetchForSpeak();

      class FailMockAudio extends MockAudio {
        play() {
          this.paused = false;
          return Promise.reject(new DOMException('The request is not allowed', 'NotAllowedError'));
        }
      }

      vi.stubGlobal('Audio', FailMockAudio);
      mockCacheGet.mockResolvedValue(new Blob([validAudioBytes], { type: 'audio/mpeg' }));

      const { elevenLabsService } = await import('./elevenLabsService');

      const result = await elevenLabsService.speak(
        'Hello world',
        validApiKey,
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('请先点击页面后重试');
    });
  });

  describe('iOS 播放行为: AbortError 重试机制', () => {
    it('iOS 下第一次 play() 抛出 AbortError 时，应重试（最多 3 次）', async () => {
      setupIOS();
      vi.useFakeTimers();

      let playCallCount = 0;

      class RetryMockAudio extends MockAudio {
        play() {
          playCallCount++;
          this.paused = false;
          if (playCallCount < 3) {
            return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
          }
          queueMicrotask(() => {
            if (this.onended && !this.loop) this.onended();
          });
          return Promise.resolve();
        }
      }

      vi.stubGlobal('Audio', RetryMockAudio);
      mockCacheGet.mockResolvedValue(new Blob([validAudioBytes], { type: 'audio/mpeg' }));

      const { elevenLabsService } = await import('./elevenLabsService');

      const speakPromise = elevenLabsService.speak(
        'Hello world',
        'sk-test-api-key',
        '21m00Tcm4TlvDq8ikWAM',
      );

      await vi.advanceTimersByTimeAsync(200);
      await vi.advanceTimersByTimeAsync(400);
      await vi.advanceTimersByTimeAsync(100);

      const result = await speakPromise;

      expect(result.success).toBe(true);
      expect(playCallCount).toBe(3);

      vi.useRealTimers();
    });

    it('非 iOS 下 AbortError 不应重试，直接返回错误', async () => {
      setupNonIOS();
      mockFetchForSpeak();

      class FailMockAudio extends MockAudio {
        play() {
          this.paused = false;
          return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
        }
      }

      vi.stubGlobal('Audio', FailMockAudio);
      mockCacheGet.mockResolvedValue(new Blob([validAudioBytes], { type: 'audio/mpeg' }));

      const { elevenLabsService } = await import('./elevenLabsService');

      const result = await elevenLabsService.speak(
        'Hello world',
        validApiKey,
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('播放被中断');
    });
  });

  describe('iOS 完整链路 E2E: API 请求 → arrayBuffer → Blob → 播放 → 缓存', () => {
    it('iOS 下完整 speak() 链路应使用 arrayBuffer 构造 Blob 并成功播放', async () => {
      setupIOS();

      const mockResponse = createMockResponse(validAudioBytes);
      const fetchFn = vi.fn(async (url: string, options?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/v1/voices')) {
          return { ok: true, status: 200, headers: new Headers() };
        }
        if (typeof url === 'string' && url.includes('/v1/user')) {
          return { ok: true, status: 200, json: () => Promise.resolve({ subscription: {} }) };
        }
        return mockResponse;
      });
      vi.stubGlobal('fetch', fetchFn);

      const { elevenLabsService } = await import('./elevenLabsService');

      const result = await elevenLabsService.speak(
        'Hello iOS',
        validApiKey,
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result.success).toBe(true);
      expect(result.fromCache).toBe(false);

      expect(mockResponse.arrayBuffer).toHaveBeenCalled();

      const audio = createdAudioInstances[0];
      expect(audio).toBeDefined();
      expect(audio.crossOrigin).toBe('');
      expect(audio.src).toContain('blob:');
      expect(audio.playbackRate).toBe(1);

      expect(mockCachePut).toHaveBeenCalled();
    });

    it('iOS 下 API 返回的 arrayBuffer 为空时应返回错误', async () => {
      setupIOS();

      const emptyResponse = {
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'audio/mpeg' }),
        blob: vi.fn().mockResolvedValue(new Blob([], { type: 'audio/mpeg' })),
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
        json: vi.fn().mockRejectedValue(new Error('not json')),
        text: vi.fn().mockRejectedValue(new Error('not text')),
      } as unknown as Response;

      const fetchFn = vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.includes('/v1/voices')) {
          return { ok: true, status: 200, headers: new Headers() };
        }
        if (typeof url === 'string' && url.includes('/v1/user')) {
          return { ok: true, status: 200, json: () => Promise.resolve({ subscription: {} }) };
        }
        return emptyResponse;
      });
      vi.stubGlobal('fetch', fetchFn);

      const { elevenLabsService } = await import('./elevenLabsService');

      const result = await elevenLabsService.speak(
        'Hello iOS',
        validApiKey,
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('未收到音频数据');
    });

    it('iOS 下应使用 Content-Type 头构造 Blob 类型', async () => {
      setupIOS();

      const customContentType = 'audio/mp4';
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': customContentType }),
        blob: vi.fn().mockResolvedValue(new Blob([validAudioBytes], { type: customContentType })),
        arrayBuffer: vi.fn().mockResolvedValue(validAudioBytes),
        json: vi.fn().mockRejectedValue(new Error('not json')),
        text: vi.fn().mockRejectedValue(new Error('not text')),
      } as unknown as Response;

      const fetchFn = vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.includes('/v1/voices')) {
          return { ok: true, status: 200, headers: new Headers() };
        }
        if (typeof url === 'string' && url.includes('/v1/user')) {
          return { ok: true, status: 200, json: () => Promise.resolve({ subscription: {} }) };
        }
        return mockResponse;
      });
      vi.stubGlobal('fetch', fetchFn);

      const { elevenLabsService } = await import('./elevenLabsService');

      const result = await elevenLabsService.speak(
        'Hello iOS',
        validApiKey,
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result.success).toBe(true);
      expect(mockResponse.arrayBuffer).toHaveBeenCalled();
    });
  });

  describe('iOS onerror 网络错误重试', () => {
    it('iOS 下 onerror 触发 MEDIA_ERR_NETWORK 时应重建 Blob URL 重试', async () => {
      setupIOS();
      mockFetchForSpeak();
      vi.useFakeTimers();

      let srcSetCount = 0;
      let loadCallCount = 0;

      class NetworkErrorMockAudio extends MockAudio {
        private _errorSet = false;

        set src(value: string) {
          this._src = value;
          srcSetCount++;
          if (value && value.startsWith('blob:')) {
            this.readyState = 4;
            queueMicrotask(() => {
              if (this.onloadeddata) this.onloadeddata();
              if (this.oncanplay) this.oncanplay();
            });
          }
        }

        get src() { return this._src; }

        load() {
          loadCallCount++;
        }

        play() {
          this.paused = false;
          if (!this._errorSet) {
            this._errorSet = true;
            this.error = { code: 2 };
            queueMicrotask(() => {
              if (this.onerror) this.onerror();
            });
            return Promise.resolve();
          }
          queueMicrotask(() => {
            if (this.onended && !this.loop) this.onended();
          });
          return Promise.resolve();
        }
      }

      vi.stubGlobal('Audio', NetworkErrorMockAudio);
      mockCacheGet.mockResolvedValue(new Blob([validAudioBytes], { type: 'audio/mpeg' }));

      const { elevenLabsService } = await import('./elevenLabsService');

      const speakPromise = elevenLabsService.speak(
        'Network error test',
        validApiKey,
        '21m00Tcm4TlvDq8ikWAM',
      );

      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(500);

      const result = await speakPromise;

      expect(result.success).toBe(true);
      expect(srcSetCount).toBeGreaterThanOrEqual(2);

      vi.useRealTimers();
    });

    it('iOS 下 onerror MEDIA_ERR_NETWORK 重试超过上限时应返回错误', async () => {
      setupIOS();
      mockFetchForSpeak();
      vi.useFakeTimers();

      class PersistentNetworkErrorMockAudio extends MockAudio {
        private _playCount = 0;

        set src(value: string) {
          this._src = value;
          if (value && value.startsWith('blob:')) {
            this.readyState = 4;
            queueMicrotask(() => {
              if (this.onloadeddata) this.onloadeddata();
              if (this.oncanplay) this.oncanplay();
            });
          }
        }

        get src() { return this._src; }

        load() {}

        play() {
          this._playCount++;
          this.paused = false;
          this.error = { code: 2 };
          queueMicrotask(() => {
            if (this.onerror) this.onerror();
          });
          return Promise.resolve();
        }
      }

      vi.stubGlobal('Audio', PersistentNetworkErrorMockAudio);
      mockCacheGet.mockResolvedValue(new Blob([validAudioBytes], { type: 'audio/mpeg' }));

      const { elevenLabsService } = await import('./elevenLabsService');

      const speakPromise = elevenLabsService.speak(
        'Persistent network error',
        validApiKey,
        '21m00Tcm4TlvDq8ikWAM',
      );

      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(500);

      const result = await speakPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('音频网络加载失败');

      vi.useRealTimers();
    });

    it('非 iOS 下 onerror MEDIA_ERR_NETWORK 不应重试，直接返回错误', async () => {
      setupNonIOS();
      mockFetchForSpeak();

      class NetworkErrorNoRetryMockAudio extends MockAudio {
        set src(value: string) {
          this._src = value;
          if (value && value.startsWith('blob:')) {
            this.readyState = 4;
            queueMicrotask(() => {
              if (this.onloadeddata) this.onloadeddata();
              if (this.oncanplay) this.oncanplay();
            });
          }
        }

        get src() { return this._src; }

        play() {
          this.paused = false;
          this.error = { code: 2 };
          queueMicrotask(() => {
            if (this.onerror) this.onerror();
          });
          return Promise.resolve();
        }
      }

      vi.stubGlobal('Audio', NetworkErrorNoRetryMockAudio);
      mockCacheGet.mockResolvedValue(new Blob([validAudioBytes], { type: 'audio/mpeg' }));

      const { elevenLabsService } = await import('./elevenLabsService');

      const result = await elevenLabsService.speak(
        'Non-iOS network error',
        validApiKey,
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('音频网络加载失败');
    });
  });

  describe('iOS onloadeddata 延迟播放', () => {
    it('iOS 下 onloadeddata 应触发 100ms 延迟播放', async () => {
      setupIOS();
      vi.useFakeTimers();

      let playCalledAt: number | null = null;
      let loadedDataFiredAt: number | null = null;

      class DelayedPlayMockAudio extends MockAudio {
        set src(value: string) {
          this._src = value;
          if (value && value.startsWith('blob:')) {
            this.readyState = 4;
            loadedDataFiredAt = Date.now();
            queueMicrotask(() => {
              if (this.onloadeddata) this.onloadeddata();
            });
          }
        }

        get src() { return this._src; }

        play() {
          playCalledAt = Date.now();
          this.paused = false;
          queueMicrotask(() => {
            if (this.onended && !this.loop) this.onended();
          });
          return Promise.resolve();
        }
      }

      vi.stubGlobal('Audio', DelayedPlayMockAudio);
      mockCacheGet.mockResolvedValue(new Blob([validAudioBytes], { type: 'audio/mpeg' }));

      const { elevenLabsService } = await import('./elevenLabsService');

      const speakPromise = elevenLabsService.speak(
        'Delayed play test',
        validApiKey,
        '21m00Tcm4TlvDq8ikWAM',
      );

      await vi.advanceTimersByTimeAsync(200);

      const result = await speakPromise;

      expect(result.success).toBe(true);

      vi.useRealTimers();
    });

    it('iOS 下 oncanplay 也应触发播放', async () => {
      setupIOS();
      vi.useFakeTimers();

      class CanPlayOnlyMockAudio extends MockAudio {
        set src(value: string) {
          this._src = value;
          if (value && value.startsWith('blob:')) {
            this.readyState = 4;
            queueMicrotask(() => {
              if (this.oncanplay) this.oncanplay();
            });
          }
        }

        get src() { return this._src; }

        play() {
          this.paused = false;
          queueMicrotask(() => {
            if (this.onended && !this.loop) this.onended();
          });
          return Promise.resolve();
        }
      }

      vi.stubGlobal('Audio', CanPlayOnlyMockAudio);
      mockCacheGet.mockResolvedValue(new Blob([validAudioBytes], { type: 'audio/mpeg' }));

      const { elevenLabsService } = await import('./elevenLabsService');

      const speakPromise = elevenLabsService.speak(
        'Canplay test',
        validApiKey,
        '21m00Tcm4TlvDq8ikWAM',
      );

      await vi.advanceTimersByTimeAsync(200);

      const result = await speakPromise;

      expect(result.success).toBe(true);

      vi.useRealTimers();
    });
  });

  describe('iOS AudioContext 跳过', () => {
    it('iOS 下不应创建 AudioContext，也不设置 crossOrigin', async () => {
      setupIOS();
      mockFetchForSpeak();

      const { elevenLabsService } = await import('./elevenLabsService');

      const result = await elevenLabsService.speak(
        'AudioContext skip test',
        validApiKey,
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result.success).toBe(true);

      const audio = createdAudioInstances[0];
      expect(audio).toBeDefined();
      expect(audio.crossOrigin).toBe('');
    });

    it('非 iOS 下应设置 crossOrigin = anonymous', async () => {
      setupNonIOS();
      mockFetchForSpeak();

      const { elevenLabsService } = await import('./elevenLabsService');

      const result = await elevenLabsService.speak(
        'AudioContext test',
        validApiKey,
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result.success).toBe(true);

      const audio = createdAudioInstances[0];
      expect(audio).toBeDefined();
      expect(audio.crossOrigin).toBe('anonymous');
    });
  });

  describe('iOS 缓存命中完整链路', () => {
    it('iOS 下本地缓存命中应直接播放，不调用 API', async () => {
      setupIOS();

      const cachedBlob = new Blob([validAudioBytes], { type: 'audio/mpeg' });
      mockCacheGet.mockResolvedValue(cachedBlob);

      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const { elevenLabsService } = await import('./elevenLabsService');

      const result = await elevenLabsService.speak(
        'Cached text',
        validApiKey,
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result.success).toBe(true);
      expect(result.fromCache).toBe(true);

      const ttsCalls = fetchSpy.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/v1/text-to-speech/'),
      );
      expect(ttsCalls.length).toBe(0);

      const audio = createdAudioInstances[0];
      expect(audio).toBeDefined();
      expect(audio.crossOrigin).toBe('');
    });

    it('iOS 下本地缓存播放失败后应降级到 API 请求', async () => {
      setupIOS();
      vi.useFakeTimers();

      mockCacheGet.mockResolvedValue(new Blob([validAudioBytes], { type: 'audio/mpeg' }));

      let firstAudioFailed = false;

      class FailFirstPlayAudio extends MockAudio {
        private _instanceId: number;

        constructor() {
          super();
          this._instanceId = createdAudioInstances.length;
        }

        set src(value: string) {
          this._src = value;
          if (value && value.startsWith('blob:')) {
            this.readyState = 4;
            queueMicrotask(() => {
              if (this.onloadeddata) this.onloadeddata();
              if (this.oncanplay) this.oncanplay();
            });
          }
        }

        get src() { return this._src; }

        play() {
          this.paused = false;
          if (!firstAudioFailed) {
            firstAudioFailed = true;
            return Promise.reject(new DOMException('The request is not allowed', 'NotAllowedError'));
          }
          queueMicrotask(() => {
            if (this.onended && !this.loop) this.onended();
          });
          return Promise.resolve();
        }
      }

      vi.stubGlobal('Audio', FailFirstPlayAudio);
      mockFetchForSpeak();

      const { elevenLabsService } = await import('./elevenLabsService');

      const speakPromise = elevenLabsService.speak(
        'Cache fail then API',
        validApiKey,
        '21m00Tcm4TlvDq8ikWAM',
      );

      await vi.advanceTimersByTimeAsync(200);
      await vi.advanceTimersByTimeAsync(400);
      await vi.advanceTimersByTimeAsync(500);

      const result = await speakPromise;

      expect(result.success).toBe(true);

      vi.useRealTimers();
    });

    it('iOS 下云端缓存命中应直接播放', async () => {
      setupIOS();

      mockCacheGet.mockResolvedValue(null);
      mockCloudCacheGet.mockResolvedValue(new Blob([validAudioBytes], { type: 'audio/mpeg' }));

      const fetchSpy = vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.includes('/v1/voices')) {
          return { ok: true, status: 200, headers: new Headers() };
        }
        return { ok: true, status: 200 };
      });
      vi.stubGlobal('fetch', fetchSpy);

      const { elevenLabsService } = await import('./elevenLabsService');

      const result = await elevenLabsService.speak(
        'Cloud cached text',
        validApiKey,
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result.success).toBe(true);
      expect(result.fromCache).toBe(true);

      const audio = createdAudioInstances[0];
      expect(audio).toBeDefined();
      expect(audio.crossOrigin).toBe('');
    });
  });

  describe('iOS 离线/弱网降级', () => {
    it('iOS 离线状态有陈旧缓存时应使用陈旧缓存播放', async () => {
      setupIOS();

      Object.defineProperty(navigator, 'onLine', {
        value: false,
        writable: true,
        configurable: true,
      });

      mockCacheGet.mockResolvedValue(null);
      mockCacheGetStale.mockResolvedValue(new Blob([validAudioBytes], { type: 'audio/mpeg' }));

      const { elevenLabsService } = await import('./elevenLabsService');

      const result = await elevenLabsService.speak(
        'Offline stale cache',
        validApiKey,
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result.success).toBe(true);
      expect(result.fromCache).toBe(true);

      Object.defineProperty(navigator, 'onLine', {
        value: true,
        writable: true,
        configurable: true,
      });
    });

    it('iOS 离线状态无缓存且队列已满时应返回错误', async () => {
      setupIOS();

      Object.defineProperty(navigator, 'onLine', {
        value: false,
        writable: true,
        configurable: true,
      });

      mockCacheGet.mockResolvedValue(null);
      mockCacheGetStale.mockResolvedValue(null);
      mockCloudCacheGet.mockResolvedValue(null);

      const { elevenLabsService } = await import('./elevenLabsService');

      const pending1 = elevenLabsService.speak('Offline 1', validApiKey, '21m00Tcm4TlvDq8ikWAM');
      const pending2 = elevenLabsService.speak('Offline 2', validApiKey, '21m00Tcm4TlvDq8ikWAM');
      const pending3 = elevenLabsService.speak('Offline 3', validApiKey, '21m00Tcm4TlvDq8ikWAM');

      const result = await elevenLabsService.speak(
        'Offline no cache',
        validApiKey,
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('离线');

      Object.defineProperty(navigator, 'onLine', {
        value: true,
        writable: true,
        configurable: true,
      });
    });
  });

  describe('iOS 特有设备检测', () => {
    it('iPad OS 应被识别为 iOS', async () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
        writable: true,
        configurable: true,
      });
      Object.defineProperty(navigator, 'platform', {
        value: 'MacIntel',
        writable: true,
        configurable: true,
      });
      Object.defineProperty(navigator, 'maxTouchPoints', {
        value: 5,
        writable: true,
        configurable: true,
      });

      mockCacheGet.mockResolvedValue(new Blob([validAudioBytes], { type: 'audio/mpeg' }));

      const { elevenLabsService } = await import('./elevenLabsService');

      const result = await elevenLabsService.speak(
        'iPad test',
        validApiKey,
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result.success).toBe(true);

      const audio = createdAudioInstances[0];
      expect(audio).toBeDefined();
      expect(audio.crossOrigin).toBe('');
    });

    it('iPod 应被识别为 iOS', async () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 17_0 like Mac OS X)',
        writable: true,
        configurable: true,
      });
      Object.defineProperty(navigator, 'platform', {
        value: 'iPod',
        writable: true,
        configurable: true,
      });
      Object.defineProperty(navigator, 'maxTouchPoints', {
        value: 2,
        writable: true,
        configurable: true,
      });

      mockCacheGet.mockResolvedValue(new Blob([validAudioBytes], { type: 'audio/mpeg' }));

      const { elevenLabsService } = await import('./elevenLabsService');

      const result = await elevenLabsService.speak(
        'iPod test',
        validApiKey,
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result.success).toBe(true);

      const audio = createdAudioInstances[0];
      expect(audio).toBeDefined();
      expect(audio.crossOrigin).toBe('');
    });
  });

  describe('iOS 循环播放', () => {
    it('iOS 下循环播放应正常工作', async () => {
      setupIOS();

      mockCacheGet.mockResolvedValue(new Blob([validAudioBytes], { type: 'audio/mpeg' }));

      const { elevenLabsService } = await import('./elevenLabsService');

      const result = await elevenLabsService.speak(
        'Loop test',
        validApiKey,
        '21m00Tcm4TlvDq8ikWAM',
        true,
      );

      expect(result.success).toBe(true);

      const audio = createdAudioInstances[0];
      expect(audio).toBeDefined();
      expect(audio.loop).toBe(true);
      expect(audio.crossOrigin).toBe('');
    });
  });

  describe('iOS 语速控制', () => {
    it('iOS 下自定义语速应正确设置', async () => {
      setupIOS();

      mockCacheGet.mockResolvedValue(new Blob([validAudioBytes], { type: 'audio/mpeg' }));

      const { elevenLabsService } = await import('./elevenLabsService');

      const result = await elevenLabsService.speak(
        'Rate test',
        validApiKey,
        '21m00Tcm4TlvDq8ikWAM',
        false,
        'eleven_multilingual_v2',
        0.75,
      );

      expect(result.success).toBe(true);

      const audio = createdAudioInstances[0];
      expect(audio).toBeDefined();
      expect(audio.playbackRate).toBe(0.75);
    });
  });

  describe('speak() 输入验证', () => {
    it('空文本应返回错误', async () => {
      setupNonIOS();

      const { elevenLabsService } = await import('./elevenLabsService');

      const result = await elevenLabsService.speak(
        '',
        'sk-test-api-key',
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('文本为空');
    });

    it('空 API key 应返回错误', async () => {
      setupNonIOS();

      const { elevenLabsService } = await import('./elevenLabsService');

      const result = await elevenLabsService.speak(
        'Hello world',
        '',
        '21m00Tcm4TlvDq8ikWAM',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('API 密钥');
    });

    it('空 voiceId 应返回错误', async () => {
      setupNonIOS();

      const { elevenLabsService } = await import('./elevenLabsService');

      const result = await elevenLabsService.speak(
        'Hello world',
        'sk-test-api-key',
        '',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('语音');
    });
  });
});