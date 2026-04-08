interface ErrorReport {
  timestamp: string;
  message: string;
  stack?: string;
  url: string;
  userAgent: string;
  userId?: string;
  level: 'error' | 'warning' | 'info';
  context?: Record<string, unknown>;
  breadcrumbs: Breadcrumb[];
}

interface Breadcrumb {
  timestamp: string;
  category: string;
  message: string;
  level: 'error' | 'warning' | 'info' | 'debug';
  data?: Record<string, unknown>;
}

interface ErrorReporterConfig {
  enabled: boolean;
  maxBreadcrumbs: number;
  maxStoredReports: number;
  reportInterval: number;
  storageKey: string;
}

const defaultConfig: ErrorReporterConfig = {
  enabled: true,
  maxBreadcrumbs: 50,
  maxStoredReports: 20,
  reportInterval: 60000, // 1分钟
  storageKey: 'd3s_error_reports'
};

class ErrorReporter {
  private config: ErrorReporterConfig;
  private breadcrumbs: Breadcrumb[] = [];
  private userId: string = '';
  private isInitialized: boolean = false;
  private reportTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<ErrorReporterConfig> = {}) {
    this.config = { ...defaultConfig, ...config };
  }

  init(userId?: string): void {
    if (this.isInitialized) return;
    
    this.isInitialized = true;
    this.userId = userId || '';
    
    this.setupGlobalErrorHandler();
    this.setupUnhandledRejectionHandler();
    this.startPeriodicReport();
    
    this.addBreadcrumb('init', 'Error reporter initialized', 'info');
  }

  setUserId(userId: string): void {
    this.userId = userId;
  }

  private setupGlobalErrorHandler(): void {
    const originalOnError = window.onerror;
    
    window.onerror = (message, source, lineno, colno, error) => {
      this.captureError({
        message: String(message),
        stack: error?.stack || `at ${source}:${lineno}:${colno}`,
        level: 'error',
        context: {
          source,
          lineno,
          colno
        }
      });

      if (originalOnError) {
        return originalOnError(message, source, lineno, colno, error);
      }
      
      return false;
    };
  }

  private setupUnhandledRejectionHandler(): void {
    window.addEventListener('unhandledrejection', (event) => {
      const error = event.reason;
      
      this.captureError({
        message: error?.message || 'Unhandled Promise Rejection',
        stack: error?.stack,
        level: 'error',
        context: {
          type: 'unhandledrejection'
        }
      });
    });
  }

  private startPeriodicReport(): void {
    if (this.reportTimer) {
      clearInterval(this.reportTimer);
    }

    this.reportTimer = setInterval(() => {
      this.flushReports();
    }, this.config.reportInterval);
  }

  captureError(options: {
    message: string;
    stack?: string;
    level?: 'error' | 'warning' | 'info';
    context?: Record<string, unknown>;
  }): void {
    if (!this.config.enabled) return;

    const report: ErrorReport = {
      timestamp: new Date().toISOString(),
      message: options.message,
      stack: options.stack,
      url: window.location.href,
      userAgent: navigator.userAgent,
      userId: this.userId,
      level: options.level || 'error',
      context: options.context,
      breadcrumbs: [...this.breadcrumbs]
    };

    this.saveReport(report);
    this.addBreadcrumb('error', options.message, 'error', options.context);
  }

  captureMessage(message: string, level: 'error' | 'warning' | 'info' = 'info'): void {
    if (!this.config.enabled) return;

    const report: ErrorReport = {
      timestamp: new Date().toISOString(),
      message,
      url: window.location.href,
      userAgent: navigator.userAgent,
      userId: this.userId,
      level,
      breadcrumbs: [...this.breadcrumbs]
    };

    this.saveReport(report);
    this.addBreadcrumb('message', message, level);
  }

  addBreadcrumb(
    category: string,
    message: string,
    level: 'error' | 'warning' | 'info' | 'debug' = 'info',
    data?: Record<string, unknown>
  ): void {
    if (!this.config.enabled) return;

    const breadcrumb: Breadcrumb = {
      timestamp: new Date().toISOString(),
      category,
      message,
      level,
      data
    };

    this.breadcrumbs.push(breadcrumb);

    if (this.breadcrumbs.length > this.config.maxBreadcrumbs) {
      this.breadcrumbs = this.breadcrumbs.slice(-this.config.maxBreadcrumbs);
    }
  }

  private saveReport(report: ErrorReport): void {
    try {
      const stored = this.getStoredReports();
      stored.push(report);

      while (stored.length > this.config.maxStoredReports) {
        stored.shift();
      }

      localStorage.setItem(this.config.storageKey, JSON.stringify(stored));
    } catch {
      // 存储失败，忽略
    }
  }

  private getStoredReports(): ErrorReport[] {
    try {
      const data = localStorage.getItem(this.config.storageKey);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  async flushReports(): Promise<void> {
    const reports = this.getStoredReports();
    
    if (reports.length === 0) return;

    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return;
    }

    try {
      const response = await fetch(`${supabaseUrl}/rest/v1/error_reports`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(reports.map(r => ({
          timestamp: r.timestamp,
          message: r.message,
          stack: r.stack,
          url: r.url,
          user_agent: r.userAgent,
          user_id: r.userId,
          level: r.level,
          context: r.context ? JSON.stringify(r.context) : null,
          breadcrumbs: r.breadcrumbs.length > 0 ? JSON.stringify(r.breadcrumbs) : null
        })))
      });

      if (response.ok) {
        localStorage.removeItem(this.config.storageKey);
        this.addBreadcrumb('report', `Successfully reported ${reports.length} errors`, 'info');
      }
    } catch {
      // 上报失败，保留本地数据下次重试
    }
  }

  getRecentReports(count: number = 10): ErrorReport[] {
    const reports = this.getStoredReports();
    return reports.slice(-count);
  }

  clearReports(): void {
    localStorage.removeItem(this.config.storageKey);
  }

  destroy(): void {
    if (this.reportTimer) {
      clearInterval(this.reportTimer);
      this.reportTimer = null;
    }
    this.isInitialized = false;
  }
}

export const errorReporter = new ErrorReporter();

export const initErrorReporter = (userId?: string): void => {
  errorReporter.init(userId);
};

export const captureError = (options: {
  message: string;
  stack?: string;
  level?: 'error' | 'warning' | 'info';
  context?: Record<string, unknown>;
}): void => {
  errorReporter.captureError(options);
};

export const captureMessage = (message: string, level?: 'error' | 'warning' | 'info'): void => {
  errorReporter.captureMessage(message, level);
};

export const addBreadcrumb = (
  category: string,
  message: string,
  level?: 'error' | 'warning' | 'info' | 'debug',
  data?: Record<string, unknown>
): void => {
  errorReporter.addBreadcrumb(category, message, level, data);
};
