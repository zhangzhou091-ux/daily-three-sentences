/**
 * UUID 生成工具
 * 提供 crypto.randomUUID 的降级方案，兼容 HTTP 环境和旧版浏览器
 */

/**
 * 使用 crypto.getRandomValues 生成安全的随机字节
 * 比 Math.random() 更安全，随机性更强
 */
function getSecureRandomBytes(length: number): Uint8Array {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  }
  
  throw new Error('无法生成安全的随机数，请使用支持 crypto API 的现代浏览器');
}

/**
 * 将字节数组转换为十六进制字符串
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 生成 UUID v4
 * 优先使用 crypto.randomUUID，不可用时使用 crypto.getRandomValues 作为降级方案
 * 
 * 安全性说明：
 * - crypto.randomUUID: 使用操作系统熵池，真随机，最安全
 * - crypto.getRandomValues: 使用操作系统熵池，真随机，安全性高
 * - Math.random: 伪随机，可预测，不安全（已弃用）
 */
export const generateUUID = (): string => {
  // 方案 1: 使用 crypto.randomUUID（需要 HTTPS 或 localhost）
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    try {
      return crypto.randomUUID();
    } catch {
      // HTTP 环境下可能抛出 SecurityError，继续使用降级方案
    }
  }
  
  // 方案 2: 使用 crypto.getRandomValues（HTTP 环境也可用）
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = getSecureRandomBytes(16);
    
    // 设置 UUID v4 版本位（第 6 字节的高 4 位为 0100，即版本 4）
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    
    // 设置 UUID 变体位（第 8 字节的高 2 位为 10，即 RFC 4122 变体）
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    
    const hex = bytesToHex(bytes);
    
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  
  // 方案 3: 完全不支持 crypto API，抛出错误
  // 不再使用 Math.random()，因为它不安全
  throw new Error(
    '无法生成安全的 UUID。请使用 HTTPS 环境或支持 crypto API 的现代浏览器。' +
    '当前环境不支持安全的随机数生成。'
  );
};

/**
 * 验证 UUID 格式是否有效
 */
export const isValidUUID = (id: string): boolean => {
  if (!id || typeof id !== 'string') return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
};

/**
 * 确保 ID 是有效的 UUID
 * 如果不是有效 UUID，则生成一个新的
 */
export const ensureValidUUID = (id: string | undefined | null): string => {
  if (id && isValidUUID(id)) {
    return id;
  }
  return generateUUID();
};

/**
 * 批量生成 UUID（性能优化版本）
 * 一次性获取足够的随机字节，减少 crypto API 调用次数
 */
export const generateUUIDs = (count: number): string[] => {
  if (count <= 0) return [];
  if (count === 1) return [generateUUID()];
  
  // 批量获取随机字节
  const bytesNeeded = count * 16;
  const allBytes = getSecureRandomBytes(bytesNeeded);
  const uuids: string[] = [];
  
  for (let i = 0; i < count; i++) {
    const offset = i * 16;
    const bytes = allBytes.slice(offset, offset + 16);
    
    // 设置版本位和变体位
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    
    const hex = bytesToHex(bytes);
    uuids.push(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
  }
  
  return uuids;
};
