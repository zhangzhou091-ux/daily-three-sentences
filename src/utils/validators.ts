/**
 * 数据验证和去重工具
 */
import { Sentence } from '../types';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export const MAX_SENTENCE_LENGTH = 500;
export const MIN_SENTENCE_LENGTH = 1;
export const MAX_CHINESE_LENGTH = 200;

const HTML_TAG_PATTERN = /<[^>]*>/g;
const DANGEROUS_CHARS_PATTERN = /<script|<\/script|javascript:|on\w+\s*=/gi;
const HTML_ENTITY_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
  '`': '&#x60;',
  '=': '&#x3D;'
};

export function stripHtmlTags(input: string): string {
  if (typeof input !== 'string') return '';
  return input.replace(HTML_TAG_PATTERN, '');
}

export function escapeHtml(input: string): string {
  if (typeof input !== 'string') return '';
  return input.replace(/[&<>"'`=/]/g, char => HTML_ENTITY_MAP[char] || char);
}

export function containsDangerousContent(input: string): boolean {
  if (typeof input !== 'string') return false;
  return DANGEROUS_CHARS_PATTERN.test(input);
}

export function sanitizeHtml(input: string): string {
  if (typeof input !== 'string') return '';
  let sanitized = stripHtmlTags(input);
  sanitized = escapeHtml(sanitized);
  return sanitized;
}

export function validateSentenceEnglish(english: string): ValidationResult {
  if (!english || typeof english !== 'string') {
    return { valid: false, error: '英文句子不能为空' };
  }

  const trimmed = english.trim();

  if (trimmed.length < MIN_SENTENCE_LENGTH) {
    return { valid: false, error: '英文句子长度不能少于1个字符' };
  }

  if (trimmed.length > MAX_SENTENCE_LENGTH) {
    return { valid: false, error: `英文句子长度不能超过${MAX_SENTENCE_LENGTH}个字符` };
  }

  if (containsDangerousContent(trimmed)) {
    return { valid: false, error: '英文句子包含不允许的内容' };
  }

  return { valid: true };
}

export function validateSentenceChinese(chinese: string): ValidationResult {
  if (!chinese || typeof chinese !== 'string') {
    return { valid: false, error: '中文翻译不能为空' };
  }

  const trimmed = chinese.trim();

  if (trimmed.length > MAX_CHINESE_LENGTH) {
    return { valid: false, error: `中文翻译长度不能超过${MAX_CHINESE_LENGTH}个字符` };
  }

  if (containsDangerousContent(trimmed)) {
    return { valid: false, error: '中文翻译包含不允许的内容' };
  }

  return { valid: true };
}

export function validateSentence(sentence: Partial<Sentence>): ValidationResult {
  if (!sentence.english) {
    return { valid: false, error: '英文句子不能为空' };
  }

  const englishValidation = validateSentenceEnglish(sentence.english);
  if (!englishValidation.valid) {
    return englishValidation;
  }

  if (sentence.chinese !== undefined) {
    const chineseValidation = validateSentenceChinese(sentence.chinese);
    if (!chineseValidation.valid) {
      return chineseValidation;
    }
  }

  if (sentence.tags) {
    if (!Array.isArray(sentence.tags)) {
      return { valid: false, error: '标签必须是数组' };
    }
    if (sentence.tags.some(tag => typeof tag !== 'string' || tag.length > 50)) {
      return { valid: false, error: '标签格式不正确' };
    }
  }

  if (sentence.addedAt && !isValidTimestamp(sentence.addedAt)) {
    return { valid: false, error: '添加时间格式不正确' };
  }

  if (sentence.updatedAt && !isValidTimestamp(sentence.updatedAt)) {
    return { valid: false, error: '更新时间格式不正确' };
  }

  return { valid: true };
}

export function validateUserName(userName: string): ValidationResult {
  if (!userName || typeof userName !== 'string') {
    return { valid: false, error: '用户名不能为空' };
  }

  const trimmed = userName.trim();

  if (trimmed.length < 2) {
    return { valid: false, error: '用户名长度不能少于2个字符' };
  }

  if (trimmed.length > 50) {
    return { valid: false, error: '用户名长度不能超过50个字符' };
  }

  if (!/^[\w\u4e00-\u9fa5]+$/.test(trimmed)) {
    return { valid: false, error: '用户名只能包含字母、数字、中文和下划线' };
  }

  return { valid: true };
}

export function sanitizeInput(input: string): string {
  if (typeof input !== 'string') return '';
  return sanitizeHtml(input).trim();
}

export function isValidTimestamp(timestamp: number): boolean {
  return !isNaN(timestamp) && timestamp > 0 && timestamp < Date.now() + 86400000;
}

export function sanitizeEnglish(english: string): string {
  if (typeof english !== 'string') return '';
  return sanitizeHtml(english)
    .replace(/['";\\]/g, '')
    .trim()
    .toLowerCase()
    .substring(0, MAX_SENTENCE_LENGTH);
}

export function sanitizeChinese(chinese: string): string {
  if (typeof chinese !== 'string') return '';
  return sanitizeHtml(chinese)
    .replace(/['";\\]/g, '')
    .trim()
    .substring(0, MAX_CHINESE_LENGTH);
}

export function sanitizeUserName(userName: string): string {
  if (typeof userName !== 'string') return '';
  return userName
    .replace(/['";\\<>]/g, '')
    .trim()
    .substring(0, 50);
}

export function sanitizeTags(tags: string[]): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .filter(tag => typeof tag === 'string')
    .map(tag => tag.replace(/['";\\<>]/g, '').trim().substring(0, 50))
    .filter(tag => tag.length > 0);
}

export function sanitizeSentenceForQuery(sentence: Sentence): Sentence {
  return {
    ...sentence,
    english: sanitizeEnglish(sentence.english),
    chinese: sanitizeChinese(sentence.chinese),
    tags: sanitizeTags(sentence.tags || [])
  };
}

export function normalizeEnglish(english: string): string {
  return english.trim().toLowerCase();
}

export function dedupeSentences(sentences: Sentence[]): Sentence[] {
  const seen = new Map<string, Sentence>();
  
  sentences.forEach(s => {
    const key = normalizeEnglish(s.english);
    const existing = seen.get(key);
    
    if (!existing || (!s.updatedAt || !existing.updatedAt || new Date(s.updatedAt) > new Date(existing.updatedAt))) {
      seen.set(key, s);
    }
  });
  
  return Array.from(seen.values());
}

export function dedupeSentencesUtil(sentences: Sentence[]): { unique: Sentence[]; skippedIds: string[] } {
  const seen = new Map<string, Sentence>();
  const skippedIds: string[] = [];
  
  sentences.forEach(s => {
    const key = normalizeEnglish(s.english);
    const existing = seen.get(key);
    
    if (!existing || (!s.updatedAt || !existing.updatedAt || new Date(s.updatedAt) > new Date(existing.updatedAt))) {
      if (existing) {
        skippedIds.push(existing.id);
      }
      seen.set(key, s);
    } else {
      skippedIds.push(s.id);
    }
  });
  
  return {
    unique: Array.from(seen.values()),
    skippedIds
  };
}

export function findSentenceByEnglish(sentences: Sentence[], english: string): Sentence | null {
  const normalized = normalizeEnglish(english);
  
  for (const sentence of sentences) {
    if (normalizeEnglish(sentence.english) === normalized) {
      return sentence;
    }
  }
  
  return null;
}