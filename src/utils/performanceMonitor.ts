/**
 * 性能监控工具
 * 使用 Performance API 监控应用性能
 */

interface PerformanceMetrics {
  navigationStart: number;
  domContentLoaded: number;
  loadComplete: number;
  firstPaint: number;
  firstContentfulPaint: number;
  totalBlockingTime: number;
  maxPotentialFID: number;
  customMetrics: Record<string, number>;
}

class PerformanceMonitor {
  private metrics: PerformanceMetrics = {
    navigationStart: 0,
    domContentLoaded: 0,
    loadComplete: 0,
    firstPaint: 0,
    firstContentfulPaint: 0,
    totalBlockingTime: 0,
    maxPotentialFID: 0,
    customMetrics: {}
  };

  private performanceEntries: PerformanceEntry[] = [];
  private observers: Map<string, PerformanceObserver> = new Map();

  constructor() {
    this.init();
  }

  private init(): void {
    // 获取导航时间
    const performance = window.performance;
    if (performance) {
      const navEntries = performance.getEntriesByType('navigation');
      if (navEntries.length > 0) {
        const navEntry = navEntries[0] as PerformanceNavigationTiming;
        this.metrics.navigationStart = navEntry.startTime;
        this.metrics.domContentLoaded = navEntry.domContentLoadedEventEnd;
        this.metrics.loadComplete = navEntry.loadEventEnd;
      }
    }

    // 获取渲染时间
    const paintEntries = performance.getEntriesByType('paint');
    paintEntries.forEach(entry => {
      if (entry.name === 'first-paint') {
        this.metrics.firstPaint = entry.startTime;
      } else if (entry.name === 'first-contentful-paint') {
        this.metrics.firstContentfulPaint = entry.startTime;
      }
    });

    // 监听长任务（Total Blocking Time）
    this.setupLongTaskObserver();

    // 监听最大潜在 FID（First Input Delay）
    this.setupFIDObserver();

    // 标记应用初始化完成
    this.mark('appInitialized');
  }

  private setupLongTaskObserver(): void {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const duration = entry.duration;
          const startTime = entry.startTime;
          
          // 计算总阻塞时间（超过 50ms 的部分）
          if (duration > 50) {
            this.metrics.totalBlockingTime += duration - 50;
          }
          
          // 记录长任务（仅在开发环境）
          if (import.meta.env.DEV) {
            console.log(`⚠️ 长任务检测: ${duration.toFixed(2)}ms at ${startTime.toFixed(2)}ms`);
          }
        }
      });

      observer.observe({ entryTypes: ['longtask'] });
      this.observers.set('longtask', observer);
    } catch (e) {
      console.warn('性能监控: 长任务观察器不可用', e);
    }
  }

  private setupFIDObserver(): void {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          // @ts-expect-error FID entry has processingStart property
          this.metrics.maxPotentialFID = entry.processingStart - entry.startTime;
          
          // 记录 FID（仅在开发环境）
          if (import.meta.env.DEV) {
            console.log(`👆 最大潜在 FID: ${this.metrics.maxPotentialFID.toFixed(2)}ms`);
          }
        }
      });

      observer.observe({ entryTypes: ['first-input'] });
      this.observers.set('first-input', observer);
    } catch (e) {
      console.warn('性能监控: FID 观察器不可用', e);
    }
  }

  /**
   * 定期上报性能数据（生产环境）
   */
  startPeriodicReporting() {
    // 每5分钟上报一次性能数据
    const reportingInterval = 5 * 60 * 1000;
    
    setInterval(async () => {
      try {
        const metrics = this.getSummary();
        
        // 仅当有意义的指标时上报
        if (metrics.totalBlockingTime > 0 || metrics.maxPotentialFID > 0) {
          // 检查是否有 Supabase 服务可用
          if (typeof window !== 'undefined' && (window as any).supabaseService) {
            const supabaseService = (window as any).supabaseService;
            if (supabaseService.isReady) {
              // 匿名上报性能数据
              await supabaseService.uploadPerformanceMetrics(metrics);
            }
          }
        }
      } catch (error) {
        // 静默处理上报错误，不影响应用
        if (import.meta.env.DEV) {
          console.warn('性能数据上报失败:', error);
        }
      }
    }, reportingInterval);
  }

  /**
   * 添加自定义性能标记
   */
  mark(name: string): void {
    try {
      window.performance.mark(name);
    } catch (e) {
      console.warn(`性能监控: 标记 ${name} 失败`, e);
    }
  }

  /**
   * 测量两个标记之间的时间
   */
  measure(name: string, startMark: string, endMark?: string): number | null {
    try {
      const measures = window.performance.getEntriesByName(name, 'measure');
      if (measures.length > 0) {
        return measures[0].duration;
      }
      return null;
    } catch (e) {
      console.warn(`性能监控: 测量 ${name} 失败`, e);
      return null;
    }
  }

  /**
   * 记录自定义指标
   */
  setMetric(name: string, value: number): void {
    this.metrics.customMetrics[name] = value;
  }

  /**
   * 获取所有性能指标
   */
  getMetrics(): PerformanceMetrics {
    return { ...this.metrics };
  }

  /**
   * 获取性能摘要
   */
  getSummary(): Record<string, number> {
    return {
      ...this.metrics.customMetrics,
      firstPaint: this.metrics.firstPaint,
      firstContentfulPaint: this.metrics.firstContentfulPaint,
      totalBlockingTime: this.metrics.totalBlockingTime,
      maxPotentialFID: this.metrics.maxPotentialFID
    };
  }

  /**
   * 清除所有观察器
   */
  destroy(): void {
    this.observers.forEach(observer => observer.disconnect());
    this.observers.clear();
  }
}

export const performanceMonitor = new PerformanceMonitor();
