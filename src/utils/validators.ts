/**
 * 数据验证和去重工具
 */
import { Sentence } from '../types';

/**
 * 标准化英文句子
 * @param english 英文句子
 * @returns 标准化后的英文句子
 */
export function normalizeEnglish(english: string): string {
  return english.trim().toLowerCase();
}

/**
 * 按英文句子去重，保留最新版本
 * @param sentences 句子数组
 * @returns 去重后的句子数组
 */
export function dedupeSentences(sentences: Sentence[]): Sentence[] {
  const seen = new Map<string, Sentence>();
  
  sentences.forEach(s => {
    const key = normalizeEnglish(s.english);
    const existing = seen.get(key);
    
    // 保留更新时间较新的版本
    if (!existing || (!s.updatedAt || !existing.updatedAt || new Date(s.updatedAt) > new Date(existing.updatedAt))) {
      seen.set(key, s);
    }
  });
  
  return Array.from(seen.values());
}

/**
 * 查找句子是否存在（按英文）
 * @param sentences 句子数组
 * @param english 英文句子
 * @returns 找到的句子或 null
 */
export function findSentenceByEnglish(sentences: Sentence[], english: string): Sentence | null {
  const normalized = normalizeEnglish(english);
  
  for (const sentence of sentences) {
    if (normalizeEnglish(sentence.english) === normalized) {
      return sentence;
    }
  }
  
  return null;
}
