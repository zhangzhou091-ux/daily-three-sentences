/**
 * EdgeTTS Service - 微软 Edge 文本转语音服务
 * 
 * 特点：
 * - 无需注册、无需密钥、永久免费
 * - 高质量自然语音
 * - 支持多种语言和声音
 * - 前端直接调用，无需后端
 * - 自动检测可用性，不可用时快速回退
 * 
 * 协议说明：
 * - WebSocket 连接后先发送 speech.config 指定音频格式
 * - 再发送 SSML 合成请求
 * - 接收的二进制消息格式：文本头 + \r\n\r\n + 音频数据
 */

export interface EdgeVoice {
  name: string;
  shortName: string;
  gender: string;
  locale: string;
  friendlyName: string;
}

export interface SpeakResult {
  success: boolean;
  error?: string;
}

const EDGE_TTS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

const DEFAULT_VOICE = 'en-US-AvaMultilingualNeural';
const DEFAULT_RATE = '+0%';
const DEFAULT_PITCH = '+0Hz';

const speechRateToSSML = (rate: number): string => {
  const clampedRate = Math.max(0.1, Math.min(10, rate));
  const percentage = Math.round((clampedRate - 1) * 100);
  return percentage >= 0 ? `+${percentage}%` : `${percentage}%`;
};

const CONNECT_TIMEOUT = 3000;
const AUDIO_TIMEOUT = 20000;
const TURN_START_TIMEOUT = 3000;

const AVAILABILITY_CACHE_TTL = 5 * 60 * 1000;

let availabilityCache: { available: boolean; timestamp: number } | null = null;

let taskQueue: Array<{
  text: string;
  voice: string;
  rate: string;
  loop: boolean;
  resolve: (result: SpeakResult) => void;
  reject: (error: Error) => void;
}> = [];
let isProcessing = false;
let currentAudioElement: HTMLAudioElement | null = null;
let audioGeneration = 0;

export const POPULAR_VOICES: EdgeVoice[] = [
  { name: 'Microsoft Ava Online (Natural) - English (United States)', shortName: 'en-US-AvaMultilingualNeural', gender: 'Female', locale: 'en-US', friendlyName: 'Ava (美式女声)' },
  { name: 'Microsoft Andrew Online (Natural) - English (United States)', shortName: 'en-US-AndrewMultilingualNeural', gender: 'Male', locale: 'en-US', friendlyName: 'Andrew (美式男声)' },
  { name: 'Microsoft Jenny Online (Natural) - English (United States)', shortName: 'en-US-JennyMultilingualNeural', gender: 'Female', locale: 'en-US', friendlyName: 'Jenny (美式女声)' },
  { name: 'Microsoft Guy Online (Natural) - English (United States)', shortName: 'en-US-GuyMultilingualNeural', gender: 'Male', locale: 'en-US', friendlyName: 'Guy (美式男声)' },
  { name: 'Microsoft Aria Online (Natural) - English (United States)', shortName: 'en-US-AriaNeural', gender: 'Female', locale: 'en-US', friendlyName: 'Aria (美式女声)' },
  { name: 'Microsoft Davis Online (Natural) - English (United States)', shortName: 'en-US-DavisNeural', gender: 'Male', locale: 'en-US', friendlyName: 'Davis (美式男声)' },
  { name: 'Microsoft Ana Online (Natural) - English (United States)', shortName: 'en-US-AnaNeural', gender: 'Female', locale: 'en-US', friendlyName: 'Ana (美式女声)' },
  { name: 'Microsoft Eric Online (Natural) - English (United States)', shortName: 'en-US-EricNeural', gender: 'Male', locale: 'en-US', friendlyName: 'Eric (美式男声)' },
  { name: 'Microsoft Sonia Online (Natural) - English (United Kingdom)', shortName: 'en-GB-SoniaNeural', gender: 'Female', locale: 'en-GB', friendlyName: 'Sonia (英式女声)' },
  { name: 'Microsoft Ryan Online (Natural) - English (United Kingdom)', shortName: 'en-GB-RyanNeural', gender: 'Male', locale: 'en-GB', friendlyName: 'Ryan (英式男声)' },
];

const generateConnectionId = (): string => {
  return crypto.randomUUID?.().replace(/-/g, '') || 
    `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 18)}`;
};

const generateRequestId = (): string => {
  return crypto.randomUUID?.() || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

const generateSSML = (text: string, voice: string, rate: string, pitch: string): string => {
  const escapedText = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
  
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
    <voice name="${voice}">
      <prosody pitch="${pitch}" rate="${rate}">
        ${escapedText}
      </prosody>
    </voice>
  </speak>`;
};

const findAudioDataOffset = (data: Uint8Array): number => {
  for (let i = 0; i < data.length - 3; i++) {
    if (data[i] === 0x0D && data[i + 1] === 0x0A && data[i + 2] === 0x0D && data[i + 3] === 0x0A) {
      return i + 4;
    }
  }
  return -1;
};

const playAudioBlob = async (audioData: Uint8Array, loop: boolean = false): Promise<void> => {
  return new Promise((resolve, reject) => {
    try {
      const gen = ++audioGeneration;

      if (currentAudioElement) {
        currentAudioElement.pause();
        currentAudioElement.src = '';
        currentAudioElement.load();
        currentAudioElement = null;
      }

      const blob = new Blob([audioData.buffer as ArrayBuffer], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      
      const audio = new Audio(url);
      audio.loop = loop;
      currentAudioElement = audio;

      const isCurrentGen = () => gen === audioGeneration;

      const cleanup = () => {
        URL.revokeObjectURL(url);
        if (currentAudioElement === audio) currentAudioElement = null;
      };
      
      audio.oncanplaythrough = () => {
        if (!isCurrentGen()) { cleanup(); resolve(); return; }
        audio.play().then(() => {
          if (loop) {
            resolve();
          }
        }).catch((err) => {
          cleanup();
          reject(new Error(err.name === 'NotAllowedError' ? '请先点击页面后重试' : '播放被阻止'));
        });
      };

      if (!loop) {
        audio.onended = () => {
          if (!isCurrentGen()) return;
          cleanup();
          resolve();
        };
      }

      audio.onpause = () => {
        if (loop && currentAudioElement !== audio) {
          cleanup();
          resolve();
        }
      };
      
      audio.onerror = () => {
        cleanup();
        reject(new Error('音频解码失败'));
      };
      
      audio.load();
      
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
};

export const checkEdgeTtsAvailability = async (): Promise<boolean> => {
  if (availabilityCache !== null) {
    const elapsed = Date.now() - availabilityCache.timestamp;
    if (elapsed < AVAILABILITY_CACHE_TTL) {
      return availabilityCache.available;
    }
  }
  
  return new Promise((resolve) => {
    const connectionId = generateConnectionId();
    const wsUrl = `${EDGE_TTS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&ConnectionId=${connectionId}`;
    
    let settled = false;
    
    const ws = new WebSocket(wsUrl);
    
    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        availabilityCache = { available: false, timestamp: Date.now() };
        console.warn('EdgeTTS 可用性检测：连接超时，标记为不可用');
        resolve(false);
      }
    }, CONNECT_TIMEOUT);
    
    ws.onopen = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        ws.close();
        availabilityCache = { available: true, timestamp: Date.now() };
        console.log('EdgeTTS 可用性检测：连接成功');
        resolve(true);
      }
    };
    
    ws.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        availabilityCache = { available: false, timestamp: Date.now() };
        console.warn('EdgeTTS 可用性检测：连接失败，标记为不可用');
        resolve(false);
      }
    };
    
    ws.onclose = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        availabilityCache = { available: false, timestamp: Date.now() };
        resolve(false);
      }
    };
  });
};

export const resetAvailabilityCache = (): void => {
  availabilityCache = null;
};

const synthesize = async (text: string, voice: string = DEFAULT_VOICE, rate: string = DEFAULT_RATE, loop: boolean = false): Promise<SpeakResult> => {
  return new Promise((resolve) => {
    const connectionId = generateConnectionId();
    const wsUrl = `${EDGE_TTS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&ConnectionId=${connectionId}`;
    const ws = new WebSocket(wsUrl);
    
    let audioChunks: Uint8Array[] = [];
    let isReceivingAudio = false;
    let turnStarted = false;
    let isResolved = false;
    
    const connectTimeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        ws.close();
        audioChunks = [];
        availabilityCache = { available: false, timestamp: Date.now() };
        resolve({ success: false, error: '连接超时' });
      }
    }, CONNECT_TIMEOUT);
    
    const turnStartTimeoutId = setTimeout(() => {
      if (!turnStarted && !isResolved) {
        isResolved = true;
        ws.close();
        audioChunks = [];
        resolve({ success: false, error: '服务器响应超时' });
      }
    }, TURN_START_TIMEOUT);
    
    const audioTimeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(connectTimeoutId);
        clearTimeout(turnStartTimeoutId);
        ws.close();
        audioChunks = [];
        resolve({ success: false, error: '音频合成超时' });
      }
    }, AUDIO_TIMEOUT);

    const cleanup = () => {
      clearTimeout(connectTimeoutId);
      clearTimeout(turnStartTimeoutId);
      clearTimeout(audioTimeoutId);
    };

    ws.onopen = () => {
      clearTimeout(connectTimeoutId);
      availabilityCache = { available: true, timestamp: Date.now() };
      
      const requestId = generateRequestId();
      const timestamp = new Date().toString();
      
      const speechConfig = `X-Timestamp:${timestamp}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n` +
        `\r\n` +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: {
                  sentenceBoundaryEnabled: 'false',
                  wordBoundaryEnabled: 'true'
                },
                outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
              }
            }
          }
        });
      
      ws.send(speechConfig);
      
      const ssml = generateSSML(text, voice, rate, DEFAULT_PITCH);
      const synthesisRequest = `X-RequestId:${requestId}\r\n` +
        `X-Timestamp:${timestamp}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `Path:ssml\r\n` +
        `\r\n` +
        ssml;
      
      ws.send(synthesisRequest);
    };

    ws.onmessage = (event) => {
      if (isResolved) return;
      
      if (typeof event.data === 'string') {
        if (event.data.includes('Path:turn.start')) {
          turnStarted = true;
          clearTimeout(turnStartTimeoutId);
          isReceivingAudio = true;
        } else if (event.data.includes('Path:turn.end')) {
          isReceivingAudio = false;
          
          cleanup();
          ws.close();
          
          const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
          if (totalLength === 0) {
            isResolved = true;
            resolve({ success: false, error: '未收到音频数据' });
            return;
          }
          
          const combinedAudio = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of audioChunks) {
            combinedAudio.set(chunk, offset);
            offset += chunk.length;
          }
          
          audioChunks = [];
          
          playAudioBlob(combinedAudio, loop)
            .then(() => {
              isResolved = true;
              resolve({ success: true });
            })
            .catch((err) => {
              isResolved = true;
              resolve({ success: false, error: err.message || '音频播放失败' });
            });
        }
      } else if (event.data instanceof ArrayBuffer) {
        if (isReceivingAudio) {
          const rawData = new Uint8Array(event.data);
          const headerEndIndex = findAudioDataOffset(rawData);
          
          if (headerEndIndex >= 0 && headerEndIndex < rawData.length) {
            const audioData = rawData.slice(headerEndIndex);
            audioChunks.push(audioData);
          }
        }
      } else if (event.data instanceof Blob) {
        if (isReceivingAudio) {
          event.data.arrayBuffer().then(buffer => {
            const rawData = new Uint8Array(buffer);
            const headerEndIndex = findAudioDataOffset(rawData);
            
            if (headerEndIndex >= 0 && headerEndIndex < rawData.length) {
              const audioData = rawData.slice(headerEndIndex);
              audioChunks.push(audioData);
            }
          });
        }
      }
    };

    ws.onerror = () => {
      if (!isResolved) {
        cleanup();
        audioChunks = [];
        isResolved = true;
        availabilityCache = { available: false, timestamp: Date.now() };
        resolve({ success: false, error: 'WebSocket 连接失败' });
      }
    };

    ws.onclose = (event) => {
      if (!isResolved) {
        cleanup();
        audioChunks = [];
        if (!event.wasClean) {
          isResolved = true;
          resolve({ success: false, error: '连接意外关闭' });
        }
      }
    };
  });
};

const processQueue = async () => {
  if (isProcessing || taskQueue.length === 0) return;
  
  isProcessing = true;
  
  while (taskQueue.length > 0) {
    const task = taskQueue.shift()!;
    try {
      const result = await synthesize(task.text, task.voice, task.rate, task.loop);
      task.resolve(result);
    } catch (err) {
      task.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
  
  isProcessing = false;
};

export const edgeTtsService = {
  speechRateToSSML,

  async speak(text: string, voice: string = DEFAULT_VOICE, rate: string = DEFAULT_RATE, loop: boolean = false): Promise<SpeakResult> {
    if (!text || typeof text !== 'string' || !text.trim()) {
      return { success: false, error: '发音文本为空' };
    }
    
    const trimmedText = text.trim();
    if (trimmedText.length > 2000) {
      return { success: false, error: '文本过长，请分段播放' };
    }
    
    return new Promise((resolve, reject) => {
      taskQueue.push({ text: trimmedText, voice, rate, loop, resolve, reject });
      processQueue();
    });
  },

  getVoices(): EdgeVoice[] {
    return POPULAR_VOICES;
  },

  getDefaultVoice(): string {
    return DEFAULT_VOICE;
  },

  stop(): void {
    audioGeneration++;
    taskQueue = [];
    isProcessing = false;
    if (currentAudioElement) {
      currentAudioElement.pause();
      currentAudioElement.src = '';
      currentAudioElement.load();
      currentAudioElement = null;
    }
  }
};

export default edgeTtsService;
