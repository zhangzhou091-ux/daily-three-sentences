/**
 * 网络请求工具类
 * 提供超时重试机制
 */

export interface RetryOptions {
  maxRetries?: number;
  retryDelay?: number;
  timeout?: number;
  onRetry?: (attempt: number, error: Error) => void;
}

export interface NetworkResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  attempts?: number;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  retryDelay: 1000,
  timeout: 10000,
  onRetry: () => {}
};

export async function fetchWithRetry<T>(
  url: string,
  options: RequestInit = {},
  retryOptions: RetryOptions = {}
): Promise<NetworkResult<T>> {
  const { maxRetries, retryDelay, timeout, onRetry } = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return { success: true, data, attempts: attempt };
    } catch (error) {
      clearTimeout(timeoutId);

      if (attempt <= maxRetries) {
        onRetry(attempt, error as Error);
        await sleep(retryDelay * attempt);
        continue;
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : '请求失败',
        attempts: attempt
      };
    }
  }

  return { success: false, error: '达到最大重试次数' };
}

export async function fetchJson<T>(
  url: string,
  options: RequestInit = {},
  retryOptions: RetryOptions = {}
): Promise<T | null> {
  const result = await fetchWithRetry<T>(url, options, retryOptions);
  return result.success ? result.data ?? null : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return message.includes('network') ||
           message.includes('fetch') ||
           message.includes('timeout') ||
           message.includes('aborted') ||
           error.name === 'TypeError';
  }
  return false;
}
