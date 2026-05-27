import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

class MockMediaMetadata {
  title: string;
  artist: string;
  album: string;
  constructor(init: { title: string; artist: string; album: string }) {
    this.title = init.title;
    this.artist = init.artist;
    this.album = init.album;
  }
}

vi.stubGlobal('MediaMetadata', MockMediaMetadata);

const mockAudioPlay = vi.fn();
const mockAudioPause = vi.fn();
const mockAudioLoad = vi.fn();
let mockAudioSrc: string = '';
let mockAudioLoop: boolean = false;
let mockAudioVolume: number = 1.0;
let mockAudioCurrentTime: number = 0;
let mockAudioPaused: boolean = true;
let mockAudioReadyState: number = 0;
let mockAudioErrorCode: number | null = null;

const createdAudioInstances: MockAudio[] = [];

class MockAudio {
  src: string = '';
  loop: boolean = false;
  volume: number = 1.0;
  preload: string = '';
  crossOrigin: string = '';
  currentTime: number = 0;
  paused: boolean = true;
  readyState: number = 0;
  error: { code: number } | null = null;

  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  oncanplay: (() => void) | null = null;
  onloadeddata: (() => void) | null = null;
  onpause: (() => void) | null = null;

  constructor() {
    createdAudioInstances.push(this);
  }

  play() {
    mockAudioPlay();
    this.paused = false;
    mockAudioPaused = false;
    return Promise.resolve();
  }

  pause() {
    mockAudioPause();
    this.paused = true;
    mockAudioPaused = true;
    if (this.onpause) {
      this.onpause();
    }
  }

  load() {
    mockAudioLoad();
  }

  removeAttribute(_name: string) {
    if (_name === 'src') {
      this.src = '';
      mockAudioSrc = '';
    }
  }
}

vi.stubGlobal('Audio', MockAudio);

const mockSetActionHandler = vi.fn();
const mockNavigatorMediaSession = {
  metadata: null as MediaMetadata | null,
  setActionHandler: mockSetActionHandler,
};

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
  Object.defineProperty(navigator, 'mediaSession', {
    value: mockNavigatorMediaSession,
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
  Object.defineProperty(navigator, 'mediaSession', {
    value: mockNavigatorMediaSession,
    writable: true,
    configurable: true,
  });
}

function resetAudioMocks(): void {
  mockAudioPlay.mockClear();
  mockAudioPause.mockClear();
  mockAudioLoad.mockClear();
  mockSetActionHandler.mockClear();
  mockAudioSrc = '';
  mockAudioLoop = false;
  mockAudioVolume = 1.0;
  mockAudioCurrentTime = 0;
  mockAudioPaused = true;
  mockAudioReadyState = 0;
  mockAudioErrorCode = null;
  mockNavigatorMediaSession.metadata = null;
  createdAudioInstances.length = 0;
}

describe('audioUnlockService - iOS 音频引擎解锁', () => {
  beforeEach(() => {
    vi.resetModules();
    setupIOS();
    resetAudioMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isIOSAudio() 应在 iOS 环境下返回 true', async () => {
    const { isIOSAudio } = await import('./audioUnlockService');
    expect(isIOSAudio()).toBe(true);
  });

  it('isIOSAudio() 应在非 iOS 环境下返回 false', async () => {
    setupNonIOS();
    const { isIOSAudio } = await import('./audioUnlockService');
    expect(isIOSAudio()).toBe(false);
  });

  it('unlockAudioEngine() 应在 iOS 下成功解锁音频引擎', async () => {
    const { unlockAudioEngine, isAudioEngineUnlocked } = await import('./audioUnlockService');
    const result = await unlockAudioEngine();
    expect(result).toBe(true);
    expect(mockAudioPlay).toHaveBeenCalled();
    expect(isAudioEngineUnlocked()).toBe(true);
  });

  it('unlockAudioEngine() 重复调用应返回已缓存的结果', async () => {
    const { unlockAudioEngine } = await import('./audioUnlockService');
    await unlockAudioEngine();
    mockAudioPlay.mockClear();
    const result = await unlockAudioEngine();
    expect(result).toBe(true);
    expect(mockAudioPlay).not.toHaveBeenCalled();
  });
});

describe('mediaSessionService - 静音保活核心服务', () => {
  beforeEach(async () => {
    vi.resetModules();
    setupIOS();
    resetAudioMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isKeepAliveActive() 初始应为 false', async () => {
    const { mediaSessionService } = await import('./mediaSessionService');
    expect(mediaSessionService.isKeepAliveActive()).toBe(false);
  });

  it('startSilenceKeepAlive() 应启动静音保活', async () => {
    const { mediaSessionService } = await import('./mediaSessionService');
    mediaSessionService.startSilenceKeepAlive();
    expect(mediaSessionService.isKeepAliveActive()).toBe(true);
    expect(mockAudioPlay).toHaveBeenCalled();
  });

  it('startSilenceKeepAlive() 重复调用不应重复启动', async () => {
    const { mediaSessionService } = await import('./mediaSessionService');
    mediaSessionService.startSilenceKeepAlive();
    mockAudioPlay.mockClear();
    mediaSessionService.startSilenceKeepAlive();
    expect(mockAudioPlay).not.toHaveBeenCalled();
    expect(mediaSessionService.isKeepAliveActive()).toBe(true);
  });

  it('stopSilenceKeepAlive() 应停止静音保活', async () => {
    const { mediaSessionService } = await import('./mediaSessionService');
    mediaSessionService.startSilenceKeepAlive();
    mediaSessionService.stopSilenceKeepAlive();
    expect(mediaSessionService.isKeepAliveActive()).toBe(false);
    expect(mockAudioPause).toHaveBeenCalled();
  });

  it('holdAudioFocus() 应保持音频焦点', async () => {
    const { mediaSessionService } = await import('./mediaSessionService');
    mediaSessionService.holdAudioFocus();
    expect(mockAudioPlay).toHaveBeenCalled();
    expect(mediaSessionService.isHoldingAudioFocus()).toBe(true);
  });

  it('holdAudioFocus() 重复调用不应重复播放', async () => {
    const { mediaSessionService } = await import('./mediaSessionService');
    mediaSessionService.holdAudioFocus();
    mockAudioPlay.mockClear();
    mediaSessionService.holdAudioFocus();
    expect(mockAudioPlay).not.toHaveBeenCalled();
  });

  it('releaseAudioFocus() 应释放音频焦点', async () => {
    const { mediaSessionService } = await import('./mediaSessionService');
    mediaSessionService.holdAudioFocus();
    mediaSessionService.releaseAudioFocus();
    expect(mediaSessionService.isHoldingAudioFocus()).toBe(false);
  });

  it('updateMetadata() 应设置 MediaSession 元数据', async () => {
    const { mediaSessionService } = await import('./mediaSessionService');
    mediaSessionService.updateMetadata('Hello, this is a test sentence');
    expect(mockNavigatorMediaSession.metadata).not.toBeNull();
    expect(mediaSessionService.getCurrentMetadataText()).toBe('Hello, this is a test sentence');
  });

  it('updateMetadata() 长文本应截断', async () => {
    const { mediaSessionService } = await import('./mediaSessionService');
    const longText = 'A'.repeat(100);
    mediaSessionService.updateMetadata(longText);
    const meta = mockNavigatorMediaSession.metadata as MediaMetadata;
    expect(meta.title.length).toBeLessThanOrEqual(33);
  });

  it('setActionHandlers() 应注册 MediaSession 操作处理器', async () => {
    const { mediaSessionService } = await import('./mediaSessionService');
    const handlers = {
      onPlay: vi.fn(),
      onPause: vi.fn(),
      onStop: vi.fn(),
    };
    mediaSessionService.setActionHandlers(handlers);
    expect(mockSetActionHandler).toHaveBeenCalledTimes(3);
  });

  it('stopAll() 应清理所有状态', async () => {
    const { mediaSessionService } = await import('./mediaSessionService');
    mediaSessionService.startSilenceKeepAlive();
    mediaSessionService.holdAudioFocus();
    mediaSessionService.updateMetadata('Test');
    mediaSessionService.stopAll();
    expect(mediaSessionService.isKeepAliveActive()).toBe(false);
    expect(mediaSessionService.isHoldingAudioFocus()).toBe(false);
    expect(mediaSessionService.getCurrentMetadataText()).toBeNull();
    expect(mockAudioPause).toHaveBeenCalled();
  });

  it('非 iOS 环境下所有操作应被跳过', async () => {
    vi.resetModules();
    setupNonIOS();
    resetAudioMocks();
    const { mediaSessionService } = await import('./mediaSessionService');
    mediaSessionService.startSilenceKeepAlive();
    expect(mockAudioPlay).not.toHaveBeenCalled();
    expect(mediaSessionService.isKeepAliveActive()).toBe(false);
    mediaSessionService.holdAudioFocus();
    expect(mediaSessionService.isHoldingAudioFocus()).toBe(false);
  });
});

describe('mediaSessionService - 息屏静音恢复', () => {
  beforeEach(async () => {
    vi.resetModules();
    setupIOS();
    resetAudioMocks();
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const getSilenceAudioInstance = (): MockAudio => {
    const instance = createdAudioInstances[createdAudioInstances.length - 1];
    if (!instance) throw new Error('没有创建 Audio 实例');
    return instance;
  };

  it('息屏后系统暂停静音音频 → onpause 自动恢复播放', async () => {
    const { mediaSessionService } = await import('./mediaSessionService');

    mediaSessionService.startSilenceKeepAlive();
    expect(mediaSessionService.isKeepAliveActive()).toBe(true);
    expect(mockAudioPlay).toHaveBeenCalledTimes(1);

    mockAudioPlay.mockClear();

    // 模拟 iOS 息屏后系统暂停了静音音频
    const audio = getSilenceAudioInstance();
    audio.pause();

    // onpause 已触发，500ms 延迟后应重试播放
    expect(mockAudioPlay).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(500);

    // 恢复延迟到期，应调用 play()
    expect(mockAudioPlay).toHaveBeenCalledTimes(1);
    expect(mediaSessionService.isKeepAliveActive()).toBe(true);
  });

  it('息屏后系统多次暂停静音音频 → 每次都能恢复', async () => {
    const { mediaSessionService } = await import('./mediaSessionService');

    mediaSessionService.startSilenceKeepAlive();
    expect(mockAudioPlay).toHaveBeenCalledTimes(1);
    mockAudioPlay.mockClear();

    const audio = getSilenceAudioInstance();

    // 第 1 次系统暂停
    audio.pause();
    vi.advanceTimersByTime(500);
    expect(mockAudioPlay).toHaveBeenCalledTimes(1);
    mockAudioPlay.mockClear();

    // 第 2 次系统暂停
    audio.pause();
    vi.advanceTimersByTime(500);
    expect(mockAudioPlay).toHaveBeenCalledTimes(1);
    mockAudioPlay.mockClear();

    // 第 3 次系统暂停
    audio.pause();
    vi.advanceTimersByTime(500);
    expect(mockAudioPlay).toHaveBeenCalledTimes(1);
    expect(mediaSessionService.isKeepAliveActive()).toBe(true);
  });

  it('恢复播放成功后重试计数器应归零', async () => {
    const { mediaSessionService } = await import('./mediaSessionService');

    mediaSessionService.startSilenceKeepAlive();
    mockAudioPlay.mockClear();

    const audio = getSilenceAudioInstance();

    // 连续触发多次暂停-恢复
    for (let i = 0; i < 5; i++) {
      audio.pause();
      vi.advanceTimersByTime(500);
    }

    // 每次恢复后计数器归零，所以 5 次都能恢复，不会耗尽
    expect(mediaSessionService.isKeepAliveActive()).toBe(true);
  });

  it('显式 stopSilenceKeepAlive 后系统暂停不应恢复', async () => {
    const { mediaSessionService } = await import('./mediaSessionService');

    mediaSessionService.startSilenceKeepAlive();
    mockAudioPlay.mockClear();

    mediaSessionService.stopSilenceKeepAlive();
    expect(mediaSessionService.isKeepAliveActive()).toBe(false);

    // 显式停止后再发生系统暂停
    const audio = getSilenceAudioInstance();
    audio.pause();
    vi.advanceTimersByTime(500);

    // 不应有恢复播放
    expect(mockAudioPlay).toHaveBeenCalledTimes(0);
  });

  it('完整息屏场景: 启动保活 → 息屏 → 中断 → 恢复 → 亮屏 → 停止', async () => {
    const { mediaSessionService } = await import('./mediaSessionService');

    // 用户点击开始朗读
    mediaSessionService.startSilenceKeepAlive();
    expect(mediaSessionService.isKeepAliveActive()).toBe(true);
    mockAudioPlay.mockClear();

    // 模拟进入后台（visibilityState = hidden）
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(mediaSessionService.isKeepAliveActive()).toBe(true);

    // 息屏后系统暂停了静音音频
    const audio = getSilenceAudioInstance();
    audio.pause();
    vi.advanceTimersByTime(500);

    // 恢复成功
    expect(mockAudioPlay).toHaveBeenCalledTimes(1);
    expect(mediaSessionService.isKeepAliveActive()).toBe(true);

    // 模拟亮屏回到前台
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(mediaSessionService.isKeepAliveActive()).toBe(true);

    // 用户点击停止
    mediaSessionService.stopSilenceKeepAlive();
    expect(mediaSessionService.isKeepAliveActive()).toBe(false);
  });
});

describe('continuousAudioPlayer - 连续播放器 iOS 兼容', () => {
  beforeEach(async () => {
    vi.resetModules();
    setupIOS();
    resetAudioMocks();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock-url'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('activate() 应在 iOS 上先解锁再激活', async () => {
    const { continuousAudioPlayer } = await import('./continuousAudioPlayer');
    const result = continuousAudioPlayer.activate();
    expect(result).toBe(true);
    expect(continuousAudioPlayer.isActivated()).toBe(true);
  });

  it('activate() 重复调用应返回 true 而不重复初始化', async () => {
    const { continuousAudioPlayer } = await import('./continuousAudioPlayer');
    continuousAudioPlayer.activate();
    mockAudioPlay.mockClear();
    const result = continuousAudioPlayer.activate();
    expect(result).toBe(true);
    expect(mockAudioPlay).not.toHaveBeenCalled();
  });

  it('deactivate() 应停用播放器', async () => {
    const { continuousAudioPlayer } = await import('./continuousAudioPlayer');
    continuousAudioPlayer.activate();
    continuousAudioPlayer.deactivate();
    expect(continuousAudioPlayer.isActivated()).toBe(false);
  });

  it('stop() 应停止播放并清理资源', async () => {
    const { continuousAudioPlayer } = await import('./continuousAudioPlayer');
    continuousAudioPlayer.activate();
    continuousAudioPlayer.stop();
    expect(mockAudioPause).toHaveBeenCalled();
  });

  it('getAudioElement() 应返回 Audio 元素', async () => {
    const { continuousAudioPlayer } = await import('./continuousAudioPlayer');
    const el = continuousAudioPlayer.getAudioElement();
    expect(el).toBeInstanceOf(MockAudio);
  });

  it('resumeAudioFocus() 未激活时不应操作', async () => {
    const { continuousAudioPlayer } = await import('./continuousAudioPlayer');
    continuousAudioPlayer.resumeAudioFocus();
    expect(mockAudioPlay).not.toHaveBeenCalled();
  });
});

describe('continuousAudioPlayer - 息屏播放恢复', () => {
  beforeEach(async () => {
    vi.resetModules();
    setupIOS();
    resetAudioMocks();
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock-url'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const activateAndSettle = async () => {
    const { continuousAudioPlayer } = await import('./continuousAudioPlayer');
    continuousAudioPlayer.activate();

    // activate() 的 iOS 解锁流程会触发 play().then(pause()).then(onpause)
    // advance 500ms 让解锁恢复回调完成，避免干扰后续断言
    await vi.advanceTimersByTimeAsync(500);
    mockAudioPlay.mockClear();
    mockAudioPause.mockClear();
    return continuousAudioPlayer;
  };

  const getPlayerAudio = (): MockAudio => {
    const instance = createdAudioInstances[0];
    if (!instance) throw new Error('continuousAudioPlayer 没有创建 Audio 实例');
    return instance;
  };

  it('播放中息屏 → 系统暂停 → onpause 自动恢复播放', async () => {
    const continuousAudioPlayer = await activateAndSettle();

    const audio = getPlayerAudio();

    // 模拟正在播放句子
    audio.src = 'blob:sentence-audio';
    audio.paused = false;
    audio.readyState = 4;

    // iOS 息屏 → 系统暂停了句子音频
    audio.pause();

    // onpause 已触发，500ms 延迟后应重试播放
    expect(mockAudioPlay).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(500);

    expect(mockAudioPlay).toHaveBeenCalledTimes(1);
    expect(continuousAudioPlayer.isActivated()).toBe(true);
  });

  it('息屏后系统多次暂停句子音频 → 每次都能恢复', async () => {
    const continuousAudioPlayer = await activateAndSettle();

    const audio = getPlayerAudio();
    audio.src = 'blob:sentence-audio';
    audio.paused = false;
    audio.readyState = 4;

    for (let i = 0; i < 3; i++) {
      audio.pause();
      expect(mockAudioPlay).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(500);
      expect(mockAudioPlay).toHaveBeenCalledTimes(1);
      mockAudioPlay.mockClear();
    }

    expect(continuousAudioPlayer.isActivated()).toBe(true);
  });

  it('恢复成功后重试计数器归零，不会耗尽', async () => {
    const continuousAudioPlayer = await activateAndSettle();

    const audio = getPlayerAudio();
    audio.src = 'blob:sentence-audio';
    audio.paused = false;
    audio.readyState = 4;

    for (let i = 0; i < 5; i++) {
      audio.pause();
      await vi.advanceTimersByTimeAsync(500);
      mockAudioPlay.mockClear();
    }

    expect(continuousAudioPlayer.isActivated()).toBe(true);
  });

  it('无 src 的系统暂停不应触发恢复', async () => {
    const continuousAudioPlayer = await activateAndSettle();

    const audio = getPlayerAudio();
    audio.src = '';       // 没有播放任何句子
    audio.paused = false;

    audio.pause();
    await vi.advanceTimersByTimeAsync(500);

    // 没有 src 意味着没有在播放句子内容，不应恢复
    expect(mockAudioPlay).toHaveBeenCalledTimes(0);
  });

  it('deactivate() 后系统暂停不应恢复', async () => {
    const continuousAudioPlayer = await activateAndSettle();

    const audio = getPlayerAudio();
    audio.src = 'blob:sentence-audio';

    continuousAudioPlayer.deactivate();
    expect(continuousAudioPlayer.isActivated()).toBe(false);

    // deactivate 已清除 onpause，此时系统暂停不应触发恢复
    audio.pause();
    await vi.advanceTimersByTimeAsync(500);

    expect(mockAudioPlay).toHaveBeenCalledTimes(0);
  });

  it('stop() 后系统暂停不应恢复', async () => {
    const continuousAudioPlayer = await activateAndSettle();

    const audio = getPlayerAudio();
    audio.src = 'blob:sentence-audio';

    continuousAudioPlayer.stop();

    // stop 已清除 onpause，此时系统暂停不应触发恢复
    audio.pause();
    await vi.advanceTimersByTimeAsync(500);

    expect(mockAudioPlay).toHaveBeenCalledTimes(0);
  });

  it('完整息屏播放场景: 激活 → 播放 → 息屏 → 中断 → 恢复 → 亮屏 → 停止', async () => {
    const continuousAudioPlayer = await activateAndSettle();

    const audio = getPlayerAudio();
    audio.src = 'blob:sentence-audio';
    audio.paused = false;
    audio.readyState = 4;

    // 模拟进入后台/息屏
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(continuousAudioPlayer.isActivated()).toBe(true);

    // 息屏后系统暂停了句子音频
    audio.pause();
    await vi.advanceTimersByTimeAsync(500);

    // 恢复成功 → 句子继续播放
    expect(mockAudioPlay).toHaveBeenCalledTimes(1);
    expect(continuousAudioPlayer.isActivated()).toBe(true);

    // 亮屏回到前台
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(continuousAudioPlayer.isActivated()).toBe(true);

    // 用户停止
    continuousAudioPlayer.deactivate();
    expect(continuousAudioPlayer.isActivated()).toBe(false);
  });

  it('息屏期间 sentence 播放完 → 换句 → 再被暂停 → 仍能恢复', async () => {
    const continuousAudioPlayer = await activateAndSettle();

    const audio = getPlayerAudio();

    // 第一句正在播放
    audio.src = 'blob:sentence-1';
    audio.paused = false;
    audio.readyState = 4;

    audio.pause();
    await vi.advanceTimersByTimeAsync(500);
    expect(mockAudioPlay).toHaveBeenCalledTimes(1);
    mockAudioPlay.mockClear();

    // 第一句播放完毕，换第二句
    audio.src = 'blob:sentence-2';
    // 模拟 oncanplay → play → paused = false
    mockAudioPlay.mockClear();

    // 第二句播放中又被系统暂停
    audio.pause();
    await vi.advanceTimersByTimeAsync(500);

    // 第二句也能恢复
    expect(mockAudioPlay).toHaveBeenCalledTimes(1);
    expect(continuousAudioPlayer.isActivated()).toBe(true);
  });
});

describe('iOS 保活集成流程测试', () => {
  beforeEach(async () => {
    vi.resetModules();
    setupIOS();
    resetAudioMocks();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock-url'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('完整保活流程: unlock → activate → startKeepAlive → stop', async () => {
    const { unlockAudioEngine, isAudioEngineUnlocked } = await import('./audioUnlockService');
    const { continuousAudioPlayer } = await import('./continuousAudioPlayer');
    const { mediaSessionService } = await import('./mediaSessionService');

    const unlocked = await unlockAudioEngine();
    expect(unlocked).toBe(true);
    expect(isAudioEngineUnlocked()).toBe(true);

    const activated = continuousAudioPlayer.activate();
    expect(activated).toBe(true);
    expect(continuousAudioPlayer.isActivated()).toBe(true);

    mediaSessionService.startSilenceKeepAlive();
    expect(mediaSessionService.isKeepAliveActive()).toBe(true);

    mediaSessionService.stopSilenceKeepAlive();
    expect(mediaSessionService.isKeepAliveActive()).toBe(false);

    continuousAudioPlayer.deactivate();
    expect(continuousAudioPlayer.isActivated()).toBe(false);

    mediaSessionService.stopAll();
    expect(mediaSessionService.isHoldingAudioFocus()).toBe(false);
  });

  it('模拟后台切换: 保活应持续运行', async () => {
    const { mediaSessionService } = await import('./mediaSessionService');

    mediaSessionService.startSilenceKeepAlive();
    expect(mediaSessionService.isKeepAliveActive()).toBe(true);

    // 模拟进入后台
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));

    // 保活状态不应因为进入后台而改变
    expect(mediaSessionService.isKeepAliveActive()).toBe(true);

    // 模拟回到前台
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(mediaSessionService.isKeepAliveActive()).toBe(true);

    mediaSessionService.stopSilenceKeepAlive();
  });
});