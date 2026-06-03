import React, { useState, useCallback } from 'react';
import { storageService } from '../services/storage';
import { supabaseService } from '../services/supabaseService';
import { elevenLabsService } from '../services/elevenLabsService';
import { minimaxTtsService } from '../services/minimaxTtsService';
import { checkEdgeTtsAvailability, resetAvailabilityCache } from '../services/edgeTtsService';
import { ttsCloudCacheService } from '../services/ttsCloudCacheService';
import { getSupabaseConfig } from '../constants';
import { TTSEngine, UserSettings } from '../types';

interface DiagnosticItem {
  id: string;
  label: string;
  status: 'pending' | 'checking' | 'pass' | 'fail' | 'warn';
  detail: string;
  suggestion?: string;
}

interface AudioProbeResult {
  engine: string;
  httpStatus: string;
  contentType: string;
  blobType: string;
  blobSize: string;
  duration: string;
  canPlay: string;
  playResult: string;
  playErrorCode: string;
}

const EL_API_BASE = 'https://api.elevenlabs.io';
const MM_API_BASE = 'https://api.minimaxi.com';

const runHealthCheck = async (
  settings: UserSettings,
  onProgress: (items: DiagnosticItem[]) => void
): Promise<DiagnosticItem[]> => {
  const items: DiagnosticItem[] = [
    { id: 'network', label: '网络连接', status: 'pending', detail: '' },
    { id: 'supabase_config', label: 'Supabase 配置', status: 'pending', detail: '' },
    { id: 'supabase_conn', label: 'Supabase 连接', status: 'pending', detail: '' },
    { id: 'tts_engine', label: 'TTS 引擎配置', status: 'pending', detail: '' },
    { id: 'tts_api', label: 'TTS API 可用性', status: 'pending', detail: '' },
    { id: 'audio', label: '音频播放能力', status: 'pending', detail: '' },
    { id: 'storage_local', label: '本地存储', status: 'pending', detail: '' },
    { id: 'storage_indexeddb', label: 'IndexedDB', status: 'pending', detail: '' },
    { id: 'web_speech', label: '浏览器语音', status: 'pending', detail: '' },
    { id: 'cloud_cache', label: '云端缓存', status: 'pending', detail: '' },
  ];

  const update = (id: string, patch: Partial<DiagnosticItem>) => {
    const idx = items.findIndex(i => i.id === id);
    if (idx >= 0) Object.assign(items[idx], patch);
    onProgress([...items]);
  };

  update('network', { status: 'checking', detail: '检测中...' });
  try {
    if (!navigator.onLine) {
      update('network', { status: 'fail', detail: '浏览器报告离线', suggestion: '请检查网络连接，确保 Wi-Fi 或移动数据已开启' });
    } else {
      const start = performance.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        await fetch('https://api.elevenlabs.io/v1/voices', {
          method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const latency = Math.round(performance.now() - start);
        if (latency > 2000) {
          update('network', { status: 'warn', detail: `网络延迟较高 (${latency}ms)`, suggestion: '网络较慢可能导致语音合成超时，建议切换到更稳定的网络' });
        } else {
          update('network', { status: 'pass', detail: `网络正常 (延迟 ${latency}ms)` });
        }
      } catch {
        clearTimeout(timeoutId);
        update('network', { status: 'fail', detail: '无法访问外部网络', suggestion: '请检查网络连接或代理设置，确保可以访问外网' });
      }
    }
  } catch (e) {
    update('network', { status: 'fail', detail: `检测异常: ${e instanceof Error ? e.message : String(e)}` });
  }

  update('supabase_config', { status: 'checking', detail: '检测中...' });
  try {
    const config = getSupabaseConfig();
    if (!config.URL || !config.ANON_KEY) {
      update('supabase_config', { status: 'warn', detail: 'Supabase 环境变量未配置', suggestion: '如需云同步，请在 .env 文件中配置 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY' });
    } else {
      update('supabase_config', { status: 'pass', detail: `URL: ${config.URL.substring(0, 30)}... | Key: 已配置 (${config.ANON_KEY.length}字符)` });
    }
  } catch (e) {
    update('supabase_config', { status: 'fail', detail: `配置读取失败: ${e instanceof Error ? e.message : String(e)}` });
  }

  update('supabase_conn', { status: 'checking', detail: '检测中...' });
  try {
    if (supabaseService.isReady) {
      update('supabase_conn', { status: 'pass', detail: 'Supabase 已连接' });
    } else {
      const config = getSupabaseConfig();
      if (!config.URL || !config.ANON_KEY) {
        update('supabase_conn', { status: 'warn', detail: '未连接（缺少配置）', suggestion: '请先配置 Supabase 环境变量' });
      } else {
        update('supabase_conn', { status: 'fail', detail: 'Supabase 未连接', suggestion: '请检查 Supabase URL 和 Key 是否正确，以及网络是否可以访问 Supabase 服务' });
      }
    }
  } catch (e) {
    update('supabase_conn', { status: 'fail', detail: `连接检测异常: ${e instanceof Error ? e.message : String(e)}` });
  }

  update('tts_engine', { status: 'checking', detail: '检测中...' });
  try {
    const engine: TTSEngine = settings.ttsEngine || 'elevenlabs';
    const engineNames: Record<TTSEngine, string> = {
      elevenlabs: 'ElevenLabs', minimax: 'MiniMax', edgeTts: 'EdgeTTS', webSpeech: 'Web Speech API',
    };
    const name = engineNames[engine];
    if (engine === 'elevenlabs') {
      if (!settings.elevenLabsApiKey?.trim()) {
        update('tts_engine', { status: 'fail', detail: `${name}: 未配置 API 密钥`, suggestion: '请在设置中填写 ElevenLabs API 密钥，或在 elevenlabs.io 注册获取免费额度' });
      } else if (!settings.elevenLabsVoiceId) {
        update('tts_engine', { status: 'warn', detail: `${name}: 已配置密钥但未选择语音`, suggestion: '请选择一个 ElevenLabs 语音' });
      } else {
        update('tts_engine', { status: 'pass', detail: `${name}: 密钥已配置 | 语音: ${settings.elevenLabsVoiceId}` });
      }
    } else if (engine === 'minimax') {
      if (!settings.minimaxApiKey?.trim()) {
        update('tts_engine', { status: 'fail', detail: `${name}: 未配置 API 密钥`, suggestion: '请在设置中填写 MiniMax API 密钥，或在 platform.minimaxi.com 注册获取' });
      } else if (!settings.minimaxVoiceId) {
        update('tts_engine', { status: 'warn', detail: `${name}: 已配置密钥但未选择语音`, suggestion: '请选择一个 MiniMax 语音' });
      } else {
        update('tts_engine', { status: 'pass', detail: `${name}: 密钥已配置 | 语音: ${settings.minimaxVoiceId}` });
      }
    } else if (engine === 'edgeTts') {
      update('tts_engine', { status: 'pass', detail: `${name}: 无需密钥 | 语音: ${settings.edgeTtsVoiceId || '默认'}` });
    } else {
      update('tts_engine', { status: 'pass', detail: `${name}: 浏览器内置` });
    }
  } catch (e) {
    update('tts_engine', { status: 'fail', detail: `检测异常: ${e instanceof Error ? e.message : String(e)}` });
  }

  update('tts_api', { status: 'checking', detail: '检测中...' });
  try {
    const engine: TTSEngine = settings.ttsEngine || 'elevenlabs';
    if (engine === 'elevenlabs') {
      if (settings.elevenLabsApiKey?.trim()) {
        const result = await elevenLabsService.validateApiKey(settings.elevenLabsApiKey.trim());
        if (result.valid) {
          update('tts_api', { status: 'pass', detail: 'ElevenLabs API 密钥有效' });
        } else {
          update('tts_api', { status: 'fail', detail: `ElevenLabs API 密钥无效: ${result.error || '未知错误'}`, suggestion: '请检查密钥是否正确，是否已过期，或在 elevenlabs.io 重新生成密钥' });
        }
      } else {
        update('tts_api', { status: 'fail', detail: '跳过（未配置密钥）', suggestion: '请先配置 ElevenLabs API 密钥' });
      }
    } else if (engine === 'minimax') {
      if (settings.minimaxApiKey?.trim()) {
        const result = await minimaxTtsService.validateApiKey(settings.minimaxApiKey.trim());
        if (result.valid) {
          update('tts_api', { status: 'pass', detail: 'MiniMax API 密钥有效' });
        } else {
          update('tts_api', { status: 'fail', detail: `MiniMax API 密钥无效: ${result.error || '未知错误'}`, suggestion: '请检查密钥是否正确，或在 platform.minimaxi.com 重新获取' });
        }
      } else {
        update('tts_api', { status: 'fail', detail: '跳过（未配置密钥）', suggestion: '请先配置 MiniMax API 密钥' });
      }
    } else if (engine === 'edgeTts') {
      resetAvailabilityCache();
      const available = await checkEdgeTtsAvailability();
      if (available) {
        update('tts_api', { status: 'pass', detail: 'EdgeTTS WebSocket 连接正常' });
      } else {
        update('tts_api', { status: 'fail', detail: 'EdgeTTS WebSocket 连接失败', suggestion: '可能是网络问题或防火墙阻止了 WebSocket 连接，请检查网络或尝试其他 TTS 引擎' });
      }
    } else {
      if ('speechSynthesis' in window) {
        const voices = window.speechSynthesis.getVoices();
        const enVoices = voices.filter(v => v.lang.startsWith('en'));
        if (enVoices.length > 0) {
          update('tts_api', { status: 'pass', detail: `Web Speech API 可用 (${enVoices.length} 个英语语音)` });
        } else {
          update('tts_api', { status: 'warn', detail: 'Web Speech API 可用但未检测到英语语音', suggestion: '请尝试刷新语音列表，或在系统设置中下载英语语音包' });
        }
      } else {
        update('tts_api', { status: 'fail', detail: '浏览器不支持 Web Speech API', suggestion: '请使用 Chrome、Safari 或 Edge 等现代浏览器' });
      }
    }
  } catch (e) {
    update('tts_api', { status: 'fail', detail: `检测异常: ${e instanceof Error ? e.message : String(e)}`, suggestion: '网络可能不稳定，请稍后重试' });
  }

  update('audio', { status: 'checking', detail: '检测中...' });
  try {
    const audio = new Audio();
    const canPlay = audio.canPlayType('audio/mpeg');
    const canPlayWav = audio.canPlayType('audio/wav');
    let audioDetail = `MP3: ${canPlay || '不支持'} | WAV: ${canPlayWav || '不支持'}`;
    let audioStatus: DiagnosticItem['status'] = 'pass';
    let audioSuggestion: string | undefined;

    if (canPlay !== 'probably' && canPlay !== 'maybe') {
      audioStatus = 'fail';
      audioSuggestion = '浏览器不支持 MP3 播放，请使用 Chrome、Safari 或 Edge';
    }

    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        audioDetail += ` | AudioContext: ${ctx.state}`;
        if (ctx.state === 'suspended') {
          audioStatus = 'warn';
          audioSuggestion = 'AudioContext 被挂起，需要用户交互后才能播放音频。请先点击页面任意位置激活';
        }
        ctx.close();
      }
    } catch {
      audioDetail += ' | AudioContext: 不可用';
    }

    update('audio', { status: audioStatus, detail: audioDetail, suggestion: audioSuggestion });
  } catch (e) {
    update('audio', { status: 'fail', detail: `音频检测失败: ${e instanceof Error ? e.message : String(e)}`, suggestion: '浏览器可能不支持音频播放，请更换浏览器' });
  }

  update('storage_local', { status: 'checking', detail: '检测中...' });
  try {
    const testKey = '__d3s_diag_test__';
    localStorage.setItem(testKey, 'ok');
    const val = localStorage.getItem(testKey);
    localStorage.removeItem(testKey);
    if (val === 'ok') {
      let storageInfo = '读写正常';
      try {
        let totalSize = 0;
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key) totalSize += (localStorage.getItem(key) || '').length;
        }
        const usedMB = (totalSize * 2 / 1024 / 1024).toFixed(2);
        storageInfo += ` | 已用约 ${usedMB} MB`;
        if (totalSize * 2 > 4 * 1024 * 1024) {
          update('storage_local', { status: 'warn', detail: storageInfo, suggestion: '本地存储空间较大，建议清理不需要的数据，避免存储满导致数据丢失' });
        } else {
          update('storage_local', { status: 'pass', detail: storageInfo });
        }
      } catch {
        update('storage_local', { status: 'pass', detail: storageInfo });
      }
    } else {
      update('storage_local', { status: 'fail', detail: '读写不一致', suggestion: '本地存储可能被浏览器限制，请检查浏览器隐私设置' });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('quota') || msg.includes('QuotaExceeded')) {
      update('storage_local', { status: 'fail', detail: '存储空间已满', suggestion: '请清理浏览器缓存或减少数据量，也可以在设置中清空数据' });
    } else {
      update('storage_local', { status: 'fail', detail: `不可用: ${msg}`, suggestion: '请检查浏览器是否禁用了本地存储，或尝试在无痕/隐私模式下开启存储权限' });
    }
  }

  update('storage_indexeddb', { status: 'checking', detail: '检测中...' });
  try {
    if (!window.indexedDB) {
      update('storage_indexeddb', { status: 'fail', detail: '浏览器不支持 IndexedDB', suggestion: '请使用现代浏览器，部分功能（如音频缓存）依赖 IndexedDB' });
    } else {
      const testDBName = '__d3s_diag_test__';
      const request = indexedDB.open(testDBName, 1);
      await new Promise<void>((resolve, reject) => {
        request.onupgradeneeded = () => { request.result.createObjectStore('test'); };
        request.onsuccess = () => { request.result.close(); indexedDB.deleteDatabase(testDBName); resolve(); };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('IndexedDB 被阻塞'));
      });
      update('storage_indexeddb', { status: 'pass', detail: 'IndexedDB 读写正常' });
    }
  } catch (e) {
    update('storage_indexeddb', { status: 'warn', detail: `IndexedDB 异常: ${e instanceof Error ? e.message : String(e)}`, suggestion: '音频缓存功能可能受影响，请检查浏览器隐私设置或尝试关闭无痕模式' });
  }

  update('web_speech', { status: 'checking', detail: '检测中...' });
  try {
    if (!('speechSynthesis' in window)) {
      update('web_speech', { status: 'fail', detail: '浏览器不支持 Web Speech API', suggestion: '请使用 Chrome、Safari 或 Edge 等现代浏览器' });
    } else {
      const voices = window.speechSynthesis.getVoices();
      const enVoices = voices.filter(v => v.lang.startsWith('en'));
      const localVoices = enVoices.filter(v => v.localService);
      update('web_speech', {
        status: enVoices.length > 0 ? 'pass' : 'warn',
        detail: `${voices.length} 个语音 | ${enVoices.length} 个英语 | ${localVoices.length} 个本地`,
        ...(enVoices.length === 0 ? { suggestion: '未检测到英语语音，请刷新语音列表或检查系统语音设置' } : {}),
      });
    }
  } catch (e) {
    update('web_speech', { status: 'warn', detail: `检测异常: ${e instanceof Error ? e.message : String(e)}` });
  }

  update('cloud_cache', { status: 'checking', detail: '检测中...' });
  try {
    if (!supabaseService.isReady) {
      update('cloud_cache', { status: 'warn', detail: 'Supabase 未连接，云端缓存不可用', suggestion: '如需跨设备共享音频缓存，请先配置并连接 Supabase' });
    } else {
      const bucketResult = await ttsCloudCacheService.ensureBucket();
      if (bucketResult.success) {
        const stats = await ttsCloudCacheService.getStats();
        update('cloud_cache', { status: 'pass', detail: `云端缓存正常 | EL: ${stats.elevenlabs.count}条 | MM: ${stats.minimax.count}条` });
      } else {
        let suggestion = '请在 Supabase Dashboard 中检查 tts-audio-cache Bucket 及 Storage Policies';
        if (bucketResult.message.includes('RLS') || bucketResult.message.includes('row-level')) {
          suggestion = '请在 Supabase Dashboard → Storage → Policies 中为 tts-audio-cache 添加 SELECT/INSERT/UPDATE 策略';
        }
        update('cloud_cache', { status: 'fail', detail: `Storage Bucket 异常: ${bucketResult.message}`, suggestion });
      }
    }
  } catch (e) {
    update('cloud_cache', { status: 'warn', detail: `检测异常: ${e instanceof Error ? e.message : String(e)}`, suggestion: '云端缓存检测失败，不影响核心功能使用' });
  }

  return items;
};

const runAudioProbe = async (
  settings: UserSettings,
  onLog: (msg: string) => void
): Promise<AudioProbeResult[]> => {
  const results: AudioProbeResult[] = [];
  const testText = 'Diagnostic test.';

  onLog('--- 音频链路深度探针启动 ---');

  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      onLog(`AudioContext 状态: ${ctx.state}`);
      if (ctx.state === 'suspended') {
        await ctx.resume();
        onLog(`AudioContext resume 后: ${ctx.state}`);
      }
      ctx.close();
    }
  } catch (e: any) {
    onLog(`AudioContext 异常: ${e.message}`);
  }

  const tempAudio = new Audio();
  onLog(`浏览器 MP3 支持: ${tempAudio.canPlayType('audio/mpeg') || '否'}`);
  onLog(`浏览器 WAV 支持: ${tempAudio.canPlayType('audio/wav') || '否'}`);

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  onLog(`iOS 检测: ${isIOS ? '是' : '否'} | UA: ${navigator.userAgent.substring(0, 80)}`);

  const testEngine = async (
    engineName: string,
    url: string,
    headers: Record<string, string>,
    body: any
  ): Promise<AudioProbeResult> => {
    const result: AudioProbeResult = {
      engine: engineName,
      httpStatus: 'N/A',
      contentType: 'N/A',
      blobType: 'N/A',
      blobSize: 'N/A',
      duration: 'N/A',
      canPlay: '否',
      playResult: 'N/A',
      playErrorCode: '',
    };

    try {
      onLog(`>>> 请求 ${engineName} API...`);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      result.httpStatus = `${response.status} ${response.statusText}`;
      result.contentType = response.headers.get('content-type') || '(null)';

      onLog(`${engineName} HTTP ${response.status} | Content-Type: ${result.contentType}`);

      if (engineName === 'MiniMax') {
        const json = await response.json();
        onLog(`${engineName} base_resp.status_code: ${json?.base_resp?.status_code}`);

        if (json?.base_resp?.status_code !== 0) {
          result.playResult = `API 错误: ${json?.base_resp?.status_msg || '未知'}`;
          onLog(`❌ ${engineName} API 返回错误: ${json?.base_resp?.status_msg}`);
          return result;
        }

        let audioBlob: Blob;
        if (json?.data?.audio) {
          const hex = json.data.audio;
          const bytes = new Uint8Array(hex.length / 2);
          for (let i = 0; i < hex.length; i += 2) {
            bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
          }
          audioBlob = new Blob([bytes], { type: 'audio/mpeg' });
        } else if (json?.audio_file) {
          const binaryStr = atob(json.audio_file);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
          audioBlob = new Blob([bytes], { type: 'audio/mpeg' });
        } else {
          result.playResult = 'API 返回空音频数据';
          onLog(`❌ ${engineName} 返回空音频`);
          return result;
        }

        result.blobType = audioBlob.type;
        result.blobSize = `${(audioBlob.size / 1024).toFixed(1)} KB`;
        onLog(`${engineName} Blob: ${result.blobType} | ${result.blobSize}`);

        return await testPlayback(audioBlob, engineName, result, onLog);
      }

      if (!response.ok) {
        result.playResult = `HTTP ${response.status}`;
        onLog(`❌ ${engineName} HTTP 错误: ${response.status}`);
        return result;
      }

      let blob: Blob;
      if (isIOS) {
        const buffer = await response.arrayBuffer();
        blob = new Blob([buffer], { type: result.contentType || 'audio/mpeg' });
        onLog(`${engineName} iOS: arrayBuffer→Blob | 原始CT: ${result.contentType} | 强制CT: ${blob.type}`);
      } else {
        blob = await response.blob();
      }

      result.blobType = blob.type;
      result.blobSize = `${(blob.size / 1024).toFixed(1)} KB`;
      onLog(`${engineName} Blob: ${result.blobType} | ${result.blobSize}`);

      if (result.contentType !== result.blobType && result.blobType !== 'audio/mpeg') {
        onLog(`⚠️ ${engineName} Content-Type 不匹配! Response: ${result.contentType} | Blob: ${result.blobType}`);
      }

      return await testPlayback(blob, engineName, result, onLog);
    } catch (e: any) {
      onLog(`❌ ${engineName} 请求异常: ${e.message}`);
      if (e.name === 'AbortError') {
        result.playResult = '请求超时 (30s)';
      } else {
        result.playResult = `网络异常: ${e.message}`;
      }
      return result;
    }
  };

  const testPlayback = async (
    blob: Blob,
    engineName: string,
    result: AudioProbeResult,
    log: (msg: string) => void
  ): Promise<AudioProbeResult> => {
    return new Promise<AudioProbeResult>((resolve) => {
      const audio = new Audio();
      const objectUrl = URL.createObjectURL(blob);
      audio.preload = 'auto';
      audio.src = objectUrl;

      log(`${engineName} 创建 Audio | src: blob:... | blob.type: ${blob.type}`);

      const timeoutId = setTimeout(() => {
        if (result.playResult === 'N/A') {
          result.playResult = '超时未响应 (8s)';
          log(`⏰ ${engineName} 播放超时 | readyState: ${audio.readyState}`);
          URL.revokeObjectURL(objectUrl);
          resolve(result);
        }
      }, 8000);

      audio.onerror = () => {
        clearTimeout(timeoutId);
        const err = audio.error;
        const errMap: Record<number, string> = {
          1: 'MEDIA_ERR_ABORTED',
          2: 'MEDIA_ERR_NETWORK',
          3: 'MEDIA_ERR_DECODE',
          4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
        };
        const errCode = err?.code || 0;
        const errName = errMap[errCode] || `UNKNOWN(${errCode})`;
        result.playResult = `失败`;
        result.playErrorCode = `${errCode} ${errName}`;
        log(`❌ ${engineName} onerror | code: ${errCode} | ${errName} | blob.type: ${blob.type}`);
        if (errCode === 4) {
          log(`💡 ${engineName} SRC_NOT_SUPPORTED: 浏览器拒绝播放此 MIME 类型 (${blob.type})，可能需要强制指定 audio/mpeg`);
        }
        if (errCode === 3) {
          log(`💡 ${engineName} DECODE: 音频数据损坏或格式不被解码器支持`);
        }
        URL.revokeObjectURL(objectUrl);
        resolve(result);
      };

      audio.onloadedmetadata = () => {
        result.duration = isFinite(audio.duration) ? `${audio.duration.toFixed(2)}s` : 'Infinity';
        log(`${engineName} onloadedmetadata | duration: ${result.duration}`);
      };

      audio.oncanplay = () => {
        result.canPlay = '是';
        log(`${engineName} oncanplay | readyState: ${audio.readyState}`);
        audio.play()
          .then(() => {
            clearTimeout(timeoutId);
            result.playResult = '成功';
            log(`✅ ${engineName} 播放成功!`);
            setTimeout(() => {
              audio.pause();
              URL.revokeObjectURL(objectUrl);
            }, 500);
            resolve(result);
          })
          .catch((playErr: DOMException) => {
            clearTimeout(timeoutId);
            result.playResult = `被拦截`;
            result.playErrorCode = `${playErr.name}: ${playErr.message}`;
            log(`⚠️ ${engineName} play() 被拦截: ${playErr.name} | ${playErr.message}`);
            if (playErr.name === 'NotAllowedError') {
              log(`💡 浏览器安全策略阻止自动播放，需要用户手势触发`);
            }
            URL.revokeObjectURL(objectUrl);
            resolve(result);
          });
      };
    });
  };

  if (settings.elevenLabsApiKey?.trim()) {
    const voiceId = settings.elevenLabsVoiceId || 'JBFqnCBsd6RMkjVDRZzb';
    const elResult = await testEngine(
      'ElevenLabs',
      `${EL_API_BASE}/v1/text-to-speech/${voiceId}`,
      {
        'Content-Type': 'application/json',
        'xi-api-key': settings.elevenLabsApiKey.trim(),
        'Accept': 'audio/mpeg',
      },
      {
        text: testText,
        model_id: elevenLabsService.getDefaultModel(),
        output_format: 'mp3_44100_128',
      }
    );
    results.push(elResult);
  } else {
    onLog('⚠️ 未配置 ElevenLabs API Key，跳过');
  }

  if (settings.minimaxApiKey?.trim()) {
    const mmResult = await testEngine(
      'MiniMax',
      `${MM_API_BASE}/v1/t2a_v2`,
      {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.minimaxApiKey.trim()}`,
      },
      {
        model: 'speech-02-hd',
        text: testText,
        stream: false,
        voice_setting: {
          voice_id: settings.minimaxVoiceId || 'English_expressive_narrator',
          speed: 1,
          vol: 1.5,
          pitch: 0,
        },
        audio_setting: {
          sample_rate: 44100,
          bitrate: 128000,
          format: 'mp3',
          channel: 2,
        },
        language_boost: 'auto',
        output_format: 'hex',
      }
    );
    results.push(mmResult);
  } else {
    onLog('⚠️ 未配置 MiniMax API Key，跳过');
  }

  if (results.length === 0) {
    onLog('⚠️ 没有可测试的 TTS 引擎（均未配置 API Key）');
  }

  onLog('--- 探针结束 ---');
  return results;
};

const statusIcon = (status: DiagnosticItem['status']): string => {
  switch (status) {
    case 'pass': return '✅';
    case 'fail': return '❌';
    case 'warn': return '⚠️';
    case 'checking': return '🔄';
    case 'pending': return '⏳';
  }
};

const statusBg = (status: DiagnosticItem['status']): string => {
  switch (status) {
    case 'pass': return 'bg-green-50 border-green-200';
    case 'fail': return 'bg-red-50 border-red-200';
    case 'warn': return 'bg-amber-50 border-amber-200';
    case 'checking': return 'bg-blue-50 border-blue-200';
    case 'pending': return 'bg-gray-50 border-gray-200';
  }
};

const DiagnosticsPanel: React.FC = () => {
  const [items, setItems] = useState<DiagnosticItem[]>([]);
  const [running, setRunning] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [activeTab, setActiveTab] = useState<'health' | 'probe'>('health');

  const [probeResults, setProbeResults] = useState<AudioProbeResult[]>([]);
  const [probeLogs, setProbeLogs] = useState<string[]>([]);
  const [probeRunning, setProbeRunning] = useState(false);
  const [probeHasRun, setProbeHasRun] = useState(false);

  const handleHealthCheck = useCallback(async () => {
    setRunning(true);
    setHasRun(true);
    const settings = storageService.getSettings();
    await runHealthCheck(settings, setItems);
    setRunning(false);
  }, []);

  const handleAudioProbe = useCallback(async () => {
    setProbeRunning(true);
    setProbeHasRun(true);
    setProbeResults([]);
    setProbeLogs([]);
    const settings = storageService.getSettings();
    const results = await runAudioProbe(settings, (msg) => {
      setProbeLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
    });
    setProbeResults(results);
    setProbeRunning(false);
  }, []);

  const passCount = items.filter(i => i.status === 'pass').length;
  const failCount = items.filter(i => i.status === 'fail').length;
  const warnCount = items.filter(i => i.status === 'warn').length;

  return (
    <div className="space-y-4">
      <div className="apple-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-lg">🩺</span>
            <div>
              <h4 className="text-xs font-black text-gray-900 uppercase tracking-widest">一键诊断</h4>
              <p className="text-[10px] text-gray-500 mt-0.5">快速巡检 + 深度探针，精确定位问题</p>
            </div>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab('health')}
            className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${
              activeTab === 'health'
                ? 'bg-blue-500 text-white shadow-md'
                : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}
          >
            🏥 系统巡检
          </button>
          <button
            onClick={() => setActiveTab('probe')}
            className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${
              activeTab === 'probe'
                ? 'bg-purple-500 text-white shadow-md'
                : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}
          >
            🔬 音频探针
          </button>
        </div>

        {activeTab === 'health' && (
          <>
            <div className="flex justify-center">
              <button
                onClick={handleHealthCheck}
                disabled={running}
                className={`px-6 py-2.5 rounded-xl text-sm font-bold transition-all ${
                  running
                    ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                    : 'bg-blue-500 text-white hover:bg-blue-600 active:scale-95 shadow-md hover:shadow-lg'
                }`}
              >
                {running ? '巡检中...' : hasRun ? '重新巡检' : '开始巡检'}
              </button>
            </div>

            {hasRun && items.length > 0 && (
              <>
                <div className="flex gap-3">
                  {passCount > 0 && (
                    <div className="flex-1 bg-green-50 rounded-xl p-3 text-center border border-green-100">
                      <div className="text-lg font-black text-green-600">{passCount}</div>
                      <div className="text-[10px] font-bold text-green-500 uppercase">正常</div>
                    </div>
                  )}
                  {warnCount > 0 && (
                    <div className="flex-1 bg-amber-50 rounded-xl p-3 text-center border border-amber-100">
                      <div className="text-lg font-black text-amber-600">{warnCount}</div>
                      <div className="text-[10px] font-bold text-amber-500 uppercase">警告</div>
                    </div>
                  )}
                  {failCount > 0 && (
                    <div className="flex-1 bg-red-50 rounded-xl p-3 text-center border border-red-100">
                      <div className="text-lg font-black text-red-600">{failCount}</div>
                      <div className="text-[10px] font-bold text-red-500 uppercase">异常</div>
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  {items.map(item => (
                    <div key={item.id} className={`rounded-xl border p-3 transition-all ${statusBg(item.status)}`}>
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{statusIcon(item.status)}</span>
                        <span className="text-xs font-black text-gray-800">{item.label}</span>
                      </div>
                      {item.detail && (
                        <p className="text-[11px] text-gray-600 mt-1 ml-6 font-medium">{item.detail}</p>
                      )}
                      {item.suggestion && (
                        <div className="ml-6 mt-1.5 p-2 bg-white/70 rounded-lg border border-dashed border-gray-200">
                          <p className="text-[11px] text-gray-700">
                            <span className="font-bold">💡 建议：</span>{item.suggestion}
                          </p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {failCount === 0 && warnCount === 0 && (
                  <div className="text-center py-3 bg-green-50 rounded-xl border border-green-100">
                    <p className="text-sm font-bold text-green-700">🎉 所有检测项均正常！</p>
                    <p className="text-[10px] text-green-500 mt-1">如果仍有问题，请切换到「音频探针」做深度检测</p>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {activeTab === 'probe' && (
          <>
            <div className="p-3 bg-purple-50 rounded-xl border border-purple-100">
              <p className="text-[11px] text-purple-700 font-medium">
                🔬 深度探针会真实调用 ElevenLabs / MiniMax API 合成音频，并测试完整播放链路。
                能暴露 <span className="font-black">MEDIA_ERR_SRC_NOT_SUPPORTED</span>、
                <span className="font-black">MEDIA_ERR_DECODE</span> 等底层错误，
                特别适合排查 iOS Safari 播放问题。
              </p>
            </div>

            <div className="flex justify-center">
              <button
                onClick={handleAudioProbe}
                disabled={probeRunning}
                className={`px-6 py-2.5 rounded-xl text-sm font-bold transition-all ${
                  probeRunning
                    ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                    : 'bg-purple-500 text-white hover:bg-purple-600 active:scale-95 shadow-md hover:shadow-lg'
                }`}
              >
                {probeRunning ? '探针运行中...' : probeHasRun ? '重新探测' : '开始双路对比诊断'}
              </button>
            </div>

            {probeHasRun && probeResults.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left bg-white rounded-xl overflow-hidden shadow-sm">
                  <thead className="bg-gray-100 text-gray-600 text-[11px] uppercase tracking-widest font-black">
                    <tr>
                      <th className="px-4 py-3">项目</th>
                      {probeResults.map(r => <th key={r.engine} className="px-4 py-3">{r.engine}</th>)}
                    </tr>
                  </thead>
                  <tbody className="text-sm font-medium text-gray-700 divide-y divide-gray-50">
                    <tr>
                      <td className="px-4 py-3 bg-gray-50 font-bold text-xs">HTTP 状态</td>
                      {probeResults.map(r => <td key={r.engine} className="px-4 py-3">{r.httpStatus}</td>)}
                    </tr>
                    <tr>
                      <td className="px-4 py-3 bg-gray-50 font-bold text-xs">Content-Type</td>
                      {probeResults.map(r => (
                        <td key={r.engine} className={`px-4 py-3 ${r.contentType.includes('octet-stream') ? 'text-amber-600 font-bold' : ''}`}>
                          {r.contentType}
                          {r.contentType.includes('octet-stream') && ' ⚠️'}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="px-4 py-3 bg-gray-50 font-bold text-xs">Blob Type</td>
                      {probeResults.map(r => (
                        <td key={r.engine} className={`px-4 py-3 ${r.blobType !== 'audio/mpeg' && r.blobType !== 'N/A' ? 'text-red-600 font-bold' : ''}`}>
                          {r.blobType}
                          {r.blobType !== 'audio/mpeg' && r.blobType !== 'N/A' && ' ❗'}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="px-4 py-3 bg-gray-50 font-bold text-xs">文件大小</td>
                      {probeResults.map(r => <td key={r.engine} className="px-4 py-3">{r.blobSize}</td>)}
                    </tr>
                    <tr>
                      <td className="px-4 py-3 bg-gray-50 font-bold text-xs">Duration</td>
                      {probeResults.map(r => <td key={r.engine} className="px-4 py-3">{r.duration}</td>)}
                    </tr>
                    <tr>
                      <td className="px-4 py-3 bg-gray-50 font-bold text-xs">触发 CanPlay</td>
                      {probeResults.map(r => (
                        <td key={r.engine} className={`px-4 py-3 ${r.canPlay === '是' ? 'text-green-600' : 'text-red-500'} font-bold`}>
                          {r.canPlay}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="px-4 py-3 bg-gray-50 font-bold text-xs">播放结果</td>
                      {probeResults.map(r => (
                        <td key={r.engine} className={`px-4 py-3 font-bold ${r.playResult === '成功' ? 'text-green-500' : 'text-red-500'}`}>
                          {r.playResult}
                        </td>
                      ))}
                    </tr>
                    {probeResults.some(r => r.playErrorCode) && (
                      <tr>
                        <td className="px-4 py-3 bg-red-50 font-bold text-xs text-red-600">错误码</td>
                        {probeResults.map(r => (
                          <td key={r.engine} className="px-4 py-3 text-red-600 font-mono text-xs font-bold">
                            {r.playErrorCode || '-'}
                          </td>
                        ))}
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            <div className="bg-gray-900 text-green-400 p-4 rounded-2xl font-mono text-[11px] overflow-y-auto max-h-64 shadow-inner">
              {probeLogs.length === 0 ? (
                <span className="opacity-50">等待探针启动...</span>
              ) : (
                probeLogs.map((log, i) => (
                  <div key={i} className={`mb-0.5 ${
                    log.includes('❌') ? 'text-red-400' :
                    log.includes('✅') ? 'text-green-300' :
                    log.includes('⚠️') ? 'text-yellow-400' :
                    log.includes('💡') ? 'text-cyan-400' :
                    'text-green-400'
                  }`}>{log}</div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default DiagnosticsPanel;
