/**
 * 网络状态检测服务
 * 提供真实的网络连通性检测，不仅依赖 navigator.onLine
 */

import { NETWORK_CONFIG } from '../constants';

class NetworkService {
  private isOnline = navigator.onLine;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private listeners: Set<(online: boolean) => void> = new Set();
  private lastCheckTime = 0;
  private lastCheckResult: boolean | null = null;
  private readonly CACHE_DURATION = 5000;

  constructor() {
    this.setupEventListeners();
    this.startPeriodicCheck();
  }

  private setupEventListeners() {
    window.addEventListener('online', () => {
      this.checkConnectivity(true).then(online => {
        this.updateOnlineStatus(online);
      });
    });

    window.addEventListener('offline', () => {
      this.updateOnlineStatus(false);
    });
  }

  async checkConnectivity(force: boolean = false): Promise<boolean> {
    if (!navigator.onLine) {
      if (import.meta.env.DEV) {
        console.log(`🌐 navigator.onLine 为 false，快速返回离线状态`);
      }
      this.lastCheckTime = Date.now();
      this.lastCheckResult = false;
      return false;
    }
    
    const now = Date.now();
    if (!force && this.lastCheckResult !== null && (now - this.lastCheckTime) < this.CACHE_DURATION) {
      if (import.meta.env.DEV) {
        console.log(`🌐 网络检测缓存命中: ${this.lastCheckResult ? '在线' : '离线'}`);
      }
      return this.lastCheckResult;
    }
    
    const MAX_RETRIES = 2;
    const BASE_RETRY_DELAY = 500;
    const MAX_RETRY_DELAY = 2000;
    const urls = NETWORK_CONFIG.CONNECTIVITY_CHECK_URLS;
    
    let result = false;
    
    for (let urlIndex = 0; urlIndex < urls.length; urlIndex++) {
      const url = urls[urlIndex];
      
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const fetchPromise = fetch(url, {
            method: 'HEAD',
            mode: 'no-cors',
            cache: 'no-store'
          });
          
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('timeout')), NETWORK_CONFIG.CONNECTIVITY_TIMEOUT);
          });
          
          await Promise.race([fetchPromise, timeoutPromise]);
          result = true;
          break;
        } catch (err) {
          if (import.meta.env.DEV && attempt < MAX_RETRIES && urlIndex === urls.length - 1) {
            console.log(`🌐 网络检测重试 (${attempt + 1}/${MAX_RETRIES})`);
          }
          
          if (attempt < MAX_RETRIES) {
            const delay = Math.min(BASE_RETRY_DELAY * Math.pow(2, attempt), MAX_RETRY_DELAY);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }
      
      if (result) break;
    }
    
    if (!result) {
      result = await this.pingWithImage('https://www.baidu.com/favicon.ico');
    }
    
    if (!result) {
      result = navigator.onLine;
      if (import.meta.env.DEV) {
        console.log(`🌐 所有检测失败，降级使用 navigator.onLine: ${result}`);
      }
    }
    
    this.lastCheckTime = now;
    this.lastCheckResult = result;
    
    return result;
  }

  private async pingWithImage(url: string, timeout: number = 5000): Promise<boolean> {
    return new Promise((resolve) => {
      const img = new Image();
      const timer = setTimeout(() => {
        img.onload = null;
        img.onerror = null;
        resolve(false);
      }, timeout);
      
      img.onload = () => {
        clearTimeout(timer);
        resolve(true);
      };
      
      img.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
      
      img.src = url + '?t=' + Date.now();
    });
  }

  /**
   * 更新在线状态并通知监听器
   */
  private updateOnlineStatus(online: boolean) {
    if (this.isOnline !== online) {
      this.isOnline = online;
      this.listeners.forEach(listener => listener(online));
    }
  }

  /**
   * 启动定期检测
   */
  private startPeriodicCheck() {
    this.checkInterval = setInterval(() => {
      this.checkConnectivity().then(online => {
        this.updateOnlineStatus(online);
      });
    }, NETWORK_CONFIG.CHECK_INTERVAL);
  }

  /**
   * 获取当前在线状态
   */
  getIsOnline(): boolean {
    return this.isOnline;
  }

  /**
   * 订阅网络状态变化
   */
  onStatusChange(callback: (online: boolean) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * 销毁服务
   */
  destroy() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
    this.listeners.clear();
  }
}

export const networkService = new NetworkService();
