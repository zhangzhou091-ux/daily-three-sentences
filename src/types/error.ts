/**
 * 应用错误类型定义
 * 统一错误处理，减少 any 类型使用
 */

export enum ErrorCode {
  NETWORK_ERROR = 'NETWORK_ERROR',
  STORAGE_ERROR = 'STORAGE_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  SYNC_ERROR = 'SYNC_ERROR',
  DATABASE_ERROR = 'DATABASE_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}

export interface AppError {
  code: ErrorCode;
  message: string;
  details?: unknown;
  timestamp?: number;
}

export interface ValidationError extends AppError {
  code: ErrorCode.VALIDATION_ERROR;
  field?: string;
}

export interface NetworkError extends AppError {
  code: ErrorCode.NETWORK_ERROR;
  statusCode?: number;
  url?: string;
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof Error && 'code' in error;
}

export function isNetworkError(error: unknown): error is NetworkError {
  return isAppError(error) && error.code === ErrorCode.NETWORK_ERROR;
}

export function isValidationError(error: unknown): error is ValidationError {
  return isAppError(error) && error.code === ErrorCode.VALIDATION_ERROR;
}

export function handleError(error: unknown): AppError {
  if (error instanceof Error) {
    if (error.message.includes('network') || error.message.includes('fetch') || error.name === 'TypeError') {
      return { code: ErrorCode.NETWORK_ERROR, message: '网络连接失败', details: error, timestamp: Date.now() };
    }
    if (error.message.includes('storage') || error.name === 'QuotaExceededError') {
      return { code: ErrorCode.STORAGE_ERROR, message: '存储空间不足', details: error, timestamp: Date.now() };
    }
    if (error.message.includes('validation') || error.message.includes('invalid')) {
      return { code: ErrorCode.VALIDATION_ERROR, message: error.message, details: error, timestamp: Date.now() };
    }
    if (error.message.includes('sync') || error.message.includes('supabase')) {
      return { code: ErrorCode.SYNC_ERROR, message: '同步失败', details: error, timestamp: Date.now() };
    }
  }
  return { code: ErrorCode.UNKNOWN_ERROR, message: '发生未知错误', details: error, timestamp: Date.now() };
}

export function getErrorMessage(error: unknown): string {
  if (isAppError(error)) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return '未知错误';
}
