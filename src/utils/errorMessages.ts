export const ERROR_MESSAGES: Record<string, string> = {
  NETWORK_ERROR: '网络连接失败，请检查网络后重试',
  STORAGE_FULL: '存储空间不足，请清理浏览器缓存',
  TIMEOUT_ERROR: '请求超时，请重试',
  AUTH_ERROR: '登录状态已过期，请重新登录',
  VALIDATION_ERROR: '输入信息有误，请检查后重试',
  SYNC_ERROR: '数据同步失败，请稍后重试',
  UNKNOWN_ERROR: '操作失败，请稍后重试',
  DB_ERROR: '数据库操作失败，请刷新页面重试',
  FILE_READ_ERROR: '文件读取失败，请重试',
  IMPORT_ERROR: '导入失败，请检查文件格式',
  EXPORT_ERROR: '导出失败，请稍后重试',
  NOT_FOUND: '数据不存在',
  PERMISSION_DENIED: '权限不足，请检查登录状态',
  QUOTA_EXCEEDED: '存储空间已满，请清理数据后重试'
};

const ERROR_CODE_MAP: Record<string, string> = {
  'NetworkError': 'NETWORK_ERROR',
  'TypeError': 'NETWORK_ERROR',
  'AbortError': 'TIMEOUT_ERROR',
  'QuotaExceededError': 'QUOTA_EXCEEDED',
  'NotAllowedError': 'PERMISSION_DENIED',
  'NotFoundError': 'NOT_FOUND',
  'Unauthorized': 'AUTH_ERROR',
  'UnauthorizedError': 'AUTH_ERROR',
  'ValidationError': 'VALIDATION_ERROR',
  'DBError': 'DB_ERROR',
  'StorageError': 'STORAGE_FULL',
  'SyncError': 'SYNC_ERROR'
};

const ERROR_KEYWORD_MAP: Array<{ keywords: string[]; code: string }> = [
  { keywords: ['network', '网络', 'fetch', '连接'], code: 'NETWORK_ERROR' },
  { keywords: ['timeout', '超时', 'timed out'], code: 'TIMEOUT_ERROR' },
  { keywords: ['quota', 'storage', '空间', '容量', 'full'], code: 'STORAGE_FULL' },
  { keywords: ['auth', 'unauthorized', '登录', 'token', 'session'], code: 'AUTH_ERROR' },
  { keywords: ['validation', 'invalid', '格式', '验证'], code: 'VALIDATION_ERROR' },
  { keywords: ['sync', '同步'], code: 'SYNC_ERROR' },
  { keywords: ['not found', '不存在', '未找到'], code: 'NOT_FOUND' },
  { keywords: ['permission', '权限', 'denied'], code: 'PERMISSION_DENIED' }
];

export function getFriendlyError(error: Error | string | unknown): string {
  if (typeof error === 'string') {
    if (isChineseMessage(error)) {
      return error;
    }
    return mapByKeywords(error) || ERROR_MESSAGES.UNKNOWN_ERROR;
  }
  
  if (error instanceof Error) {
    if (isChineseMessage(error.message)) {
      return error.message;
    }
    
    const code = ERROR_CODE_MAP[error.name] || ERROR_CODE_MAP[error.constructor.name];
    if (code && ERROR_MESSAGES[code]) {
      return ERROR_MESSAGES[code];
    }
    
    const keywordMatch = mapByKeywords(error.message);
    if (keywordMatch) {
      return keywordMatch;
    }
    
    return ERROR_MESSAGES.UNKNOWN_ERROR;
  }
  
  return ERROR_MESSAGES.UNKNOWN_ERROR;
}

function isChineseMessage(message: string): boolean {
  return /[\u4e00-\u9fa5]/.test(message);
}

function mapByKeywords(message: string): string | null {
  const lowerMessage = message.toLowerCase();
  
  for (const { keywords, code } of ERROR_KEYWORD_MAP) {
    if (keywords.some(kw => lowerMessage.includes(kw.toLowerCase()))) {
      return ERROR_MESSAGES[code] || null;
    }
  }
  
  return null;
}

export function logError(context: string, error: unknown): void {
  console.error(`[${context}]`, error);
}

export function handleError(context: string, error: unknown): string {
  logError(context, error);
  return getFriendlyError(error);
}
