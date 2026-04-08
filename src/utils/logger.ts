const isDev = import.meta.env.DEV;

interface LogEntry {
  timestamp: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  message: string;
  context?: Record<string, unknown>;
  operationId?: string;
  duration?: number;
}

interface LogConfig {
  enableConsole: boolean;
  enableStorage: boolean;
  maxStorageEntries: number;
  storageKey: string;
}

const defaultConfig: LogConfig = {
  enableConsole: true,
  enableStorage: true,
  maxStorageEntries: 100,
  storageKey: 'd3s_logs'
};

class StructuredLogger {
  private config: LogConfig;
  private operationStartTimes: Map<string, number> = new Map();

  constructor(config: Partial<LogConfig> = {}) {
    this.config = { ...defaultConfig, ...config };
  }

  private formatTimestamp(): string {
    return new Date().toISOString();
  }

  private createEntry(
    level: LogEntry['level'],
    message: string,
    context?: Record<string, unknown>,
    operationId?: string,
    duration?: number
  ): LogEntry {
    return {
      timestamp: this.formatTimestamp(),
      level,
      message,
      context,
      operationId,
      duration
    };
  }

  private saveToStorage(entry: LogEntry): void {
    if (!this.config.enableStorage) return;
    
    try {
      const logs = this.getStoredLogs();
      logs.push(entry);
      
      while (logs.length > this.config.maxStorageEntries) {
        logs.shift();
      }
      
      localStorage.setItem(this.config.storageKey, JSON.stringify(logs));
    } catch {
      // Ignore storage errors
    }
  }

  private getStoredLogs(): LogEntry[] {
    try {
      const data = localStorage.getItem(this.config.storageKey);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  private output(entry: LogEntry): void {
    if (!this.config.enableConsole) return;

    const prefix = `[${entry.timestamp}] [${entry.level.toUpperCase()}]`;
    const contextStr = entry.context ? ` ${JSON.stringify(entry.context)}` : '';
    const opStr = entry.operationId ? ` [op:${entry.operationId}]` : '';
    const durationStr = entry.duration !== undefined ? ` (${entry.duration}ms)` : '';

    const fullMessage = `${prefix}${opStr} ${entry.message}${contextStr}${durationStr}`;

    switch (entry.level) {
      case 'error':
        console.error(fullMessage);
        break;
      case 'warn':
        console.warn(fullMessage);
        break;
      case 'info':
        console.info(fullMessage);
        break;
      case 'debug':
        if (isDev) {
          console.log(fullMessage);
        }
        break;
    }
  }

  private log(
    level: LogEntry['level'],
    message: string,
    context?: Record<string, unknown>,
    operationId?: string,
    duration?: number
  ): void {
    const entry = this.createEntry(level, message, context, operationId, duration);
    this.output(entry);
    
    if (level === 'error' || level === 'warn') {
      this.saveToStorage(entry);
    }
  }

  error(message: string, context?: Record<string, unknown>, operationId?: string): void {
    this.log('error', message, context, operationId);
  }

  warn(message: string, context?: Record<string, unknown>, operationId?: string): void {
    this.log('warn', message, context, operationId);
  }

  info(message: string, context?: Record<string, unknown>, operationId?: string): void {
    this.log('info', message, context, operationId);
  }

  debug(message: string, context?: Record<string, unknown>, operationId?: string): void {
    this.log('debug', message, context, operationId);
  }

  startOperation(operationId: string): void {
    this.operationStartTimes.set(operationId, Date.now());
  }

  endOperation(operationId: string, message: string, level: LogEntry['level'] = 'info', context?: Record<string, unknown>): void {
    const startTime = this.operationStartTimes.get(operationId);
    const duration = startTime ? Date.now() - startTime : undefined;
    
    this.log(level, message, context, operationId, duration);
    this.operationStartTimes.delete(operationId);
  }

  getRecentLogs(count: number = 20): LogEntry[] {
    const logs = this.getStoredLogs();
    return logs.slice(-count);
  }

  clearLogs(): void {
    localStorage.removeItem(this.config.storageKey);
  }

  exportLogs(): string {
    const logs = this.getStoredLogs();
    return JSON.stringify(logs, null, 2);
  }
}

export const logger = new StructuredLogger();

export const createOperationLogger = (operationName: string) => {
  const operationId = `${operationName}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  
  return {
    id: operationId,
    start: () => logger.startOperation(operationId),
    end: (message: string, level: LogEntry['level'] = 'info', context?: Record<string, unknown>) => {
      logger.endOperation(operationId, message, level, context);
    },
    info: (message: string, context?: Record<string, unknown>) => {
      logger.info(message, context, operationId);
    },
    error: (message: string, context?: Record<string, unknown>) => {
      logger.error(message, context, operationId);
    }
  };
};

export type { LogEntry, LogConfig };
