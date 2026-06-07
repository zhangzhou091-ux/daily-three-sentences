/**
 * 敏感数据加密服务
 * 使用 Web Crypto API AES-GCM 加密 API Key 等敏感字段
 * 加密密钥与数据分离存储，提供纵深防御
 */

const CRYPTO_KEY_STORAGE = 'd3s_crypto_key_v1';
const ENCRYPTED_PREFIX = 'aes:';

let cachedKey: CryptoKey | null = null;

async function getOrCreateKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;

  // 尝试从 localStorage 恢复已导出的密钥
  const stored = localStorage.getItem(CRYPTO_KEY_STORAGE);
  if (stored) {
    try {
      const jwk = JSON.parse(stored);
      cachedKey = await crypto.subtle.importKey(
        'jwk', jwk,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
      return cachedKey;
    } catch {
      // 密钥损坏，重新生成
      localStorage.removeItem(CRYPTO_KEY_STORAGE);
    }
  }

  // 生成新密钥
  cachedKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  // 导出并存储密钥
  const jwk = await crypto.subtle.exportKey('jwk', cachedKey);
  localStorage.setItem(CRYPTO_KEY_STORAGE, JSON.stringify(jwk));

  return cachedKey;
}

export const cryptoService = {
  /**
   * 加密文本
   * @param plaintext 明文
   * @returns 加密后的字符串（格式：aes:base64_iv:base64_ciphertext），失败返回 null
   */
  async encrypt(plaintext: string): Promise<string | null> {
    if (!plaintext) return null;
    try {
      const key = await getOrCreateKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encoder = new TextEncoder();
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encoder.encode(plaintext)
      );

      const ivBase64 = btoa(String.fromCharCode(...iv));
      const ctBase64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
      return `${ENCRYPTED_PREFIX}${ivBase64}:${ctBase64}`;
    } catch (err) {
      console.warn('[CryptoService] 加密失败:', err instanceof Error ? err.message : String(err));
      return null;
    }
  },

  /**
   * 解密文本
   * @param encrypted 加密后的字符串
   * @returns 明文，失败返回 null
   */
  async decrypt(encrypted: string): Promise<string | null> {
    if (!encrypted || !encrypted.startsWith(ENCRYPTED_PREFIX)) return null;
    try {
      const key = await getOrCreateKey();
      const payload = encrypted.slice(ENCRYPTED_PREFIX.length);
      const [ivBase64, ctBase64] = payload.split(':');
      if (!ivBase64 || !ctBase64) return null;

      const iv = Uint8Array.from(atob(ivBase64), c => c.charCodeAt(0));
      const ciphertext = Uint8Array.from(atob(ctBase64), c => c.charCodeAt(0));

      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        ciphertext
      );
      return new TextDecoder().decode(plaintext);
    } catch (err) {
      console.warn('[CryptoService] 解密失败:', err instanceof Error ? err.message : String(err));
      return null;
    }
  },

  /**
   * 检测 Web Crypto API 是否可用
   */
  isAvailable(): boolean {
    return typeof crypto !== 'undefined' && !!crypto.subtle;
  },
};