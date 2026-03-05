/**
 * UUID 生成工具
 * 提供 crypto.randomUUID 的降级方案，兼容 HTTP 环境和旧版浏览器
 */

/**
 * 生成 UUID v4
 * 优先使用 crypto.randomUUID，不可用时使用 polyfill
 */
export const generateUUID = (): string => {
  // 检查 crypto.randomUUID 是否可用（需要 HTTPS 或 localhost）
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    try {
      return crypto.randomUUID();
    } catch {
      // 在 HTTP 环境下可能抛出错误，继续使用 polyfill
    }
  }
  
  // Polyfill: 使用 Math.random 生成 UUID v4
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
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
