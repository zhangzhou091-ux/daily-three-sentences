import { Sentence } from '../types';
import { elevenLabsCacheService } from './elevenLabsCacheService';
import { minimaxTtsService } from './minimaxTtsService';
import { ttsCloudCacheService } from './ttsCloudCacheService';
import { storageService } from './storage';

export interface DeleteSentenceAudioResult {
  success: boolean;
  localEl: number;
  localMm: number;
  cloudEl: boolean;
  cloudMm: boolean;
  metaCleared: boolean;
}

export const sentenceAudioService = {
  async deleteSentenceAudio(sentence: Sentence): Promise<DeleteSentenceAudioResult> {
    const result: DeleteSentenceAudioResult = {
      success: false,
      localEl: 0,
      localMm: 0,
      cloudEl: false,
      cloudMm: false,
      metaCleared: false,
    };

    try {
      result.localEl = await elevenLabsCacheService.deleteByText(sentence.english);
    } catch (e) {
      console.warn('🔊 [SentenceAudio] ElevenLabs 本地缓存删除异常:', e);
    }

    try {
      result.localMm = await minimaxTtsService.deleteCacheByText(sentence.english);
    } catch (e) {
      console.warn('🔊 [SentenceAudio] MiniMax 本地缓存删除异常:', e);
    }

    try {
      const cloudResult = await ttsCloudCacheService.deleteBySentence(sentence);
      result.cloudEl = cloudResult.el;
      result.cloudMm = cloudResult.mm;
    } catch (e) {
      console.warn('🔊 [SentenceAudio] 云端缓存删除异常:', e);
    }

    try {
      const updated = await storageService.clearSentenceAudio(sentence.id);
      result.metaCleared = updated !== null;
    } catch (e) {
      console.warn('🔊 [SentenceAudio] 元数据清除异常:', e);
    }

    result.success = true;

    const totalLocal = result.localEl + result.localMm;
    const totalCloud = [result.cloudEl, result.cloudMm].filter(Boolean).length;

    console.log(
      `🔊 [SentenceAudio] 句子语音已清除 | [text] ${sentence.english.slice(0, 40)} | ` +
      `本地 ${totalLocal} 条 | 云端 ${totalCloud} 个`
    );

    return result;
  },

  hasAudioCache(sentence: Sentence): boolean {
    return !!(sentence.ttsAudioPathEl || sentence.ttsAudioPathMm);
  },
};