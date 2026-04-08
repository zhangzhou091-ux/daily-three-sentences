/**
 * IndexedDB 存储服务
 * 用于存储大体积数据，解决 localStorage 容量限制问题
 */

const DB_NAME = 'D3S_IndexedDB';
const DB_VERSION = 1;
const STORE_NAMES = {
  DICTATIONS: 'dictations',
  LEARNING_RECORDS: 'learning_records',
  BACKUP: 'backup'
} as const;

interface StorageWarningData {
  type: 'storageFull' | 'migrationError' | 'truncationWarning';
  message: string;
  details?: {
    totalSource?: number;
    totalMigrated?: number;
    truncated?: boolean;
  };
}

export class IndexedDBService {
  private db: IDBDatabase | null = null;
  private isInitialized = false;

  async init(): Promise<void> {
    if (this.isInitialized) return;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error('❌ IndexedDB 初始化失败');
        reject(new Error('IndexedDB 初始化失败'));
      };

      request.onsuccess = () => {
        this.db = request.result;
        this.isInitialized = true;
        
        // 监听数据库升级
        this.db.onversionchange = () => {
          this.db?.close();
          console.log('数据库版本变更，重新连接...');
        };
        
        if (import.meta.env.DEV) {
          console.log('✅ IndexedDB 初始化成功');
        }
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        // 创建对象存储
        if (!db.objectStoreNames.contains(STORE_NAMES.DICTATIONS)) {
          const dictationsStore = db.createObjectStore(STORE_NAMES.DICTATIONS, { 
            keyPath: 'id',
            autoIncrement: true 
          });
          dictationsStore.createIndex('date', 'date', { unique: false });
          dictationsStore.createIndex('sentenceId', 'sentenceId', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_NAMES.LEARNING_RECORDS)) {
          const recordsStore = db.createObjectStore(STORE_NAMES.LEARNING_RECORDS, {
            keyPath: 'id',
            autoIncrement: true
          });
          recordsStore.createIndex('date', 'date', { unique: false });
          recordsStore.createIndex('sentenceId', 'sentenceId', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_NAMES.BACKUP)) {
          db.createObjectStore(STORE_NAMES.BACKUP, { keyPath: 'id' });
        }
      };
    });
  }

  /**
   * 迁移 localStorage 中的大体积数据到 IndexedDB
   */
  async migrateLargeData(): Promise<{ migrated: number; errors: number }> {
    if (!this.isInitialized) await this.init();

    let migrated = 0;
    let errors = 0;

    try {
      // 迁移默写记录
      const dictationKeys = Object.keys(localStorage).filter(key => 
        key.startsWith('d3s_dictations_')
      );

      for (const key of dictationKeys) {
        try {
          const data = localStorage.getItem(key);
          if (data) {
            const dictations = JSON.parse(data);
            const date = key.replace('d3s_dictations_', '');
            
            await this.addDictations(date, dictations);
            localStorage.removeItem(key);
            migrated++;
          }
        } catch (error) {
          errors++;
          console.warn(`迁移失败: ${key}`, error);
        }
      }

      if (import.meta.env.DEV) {
        console.log(`📦 数据迁移完成: ${migrated} 条成功, ${errors} 条失败`);
      }

      // 发送迁移完成通知
      if (migrated > 0) {
        this.emitStorageWarning({
          type: 'truncationWarning',
          message: `已将 ${migrated} 条默写记录迁移到更安全的存储空间`,
          details: { totalSource: dictationKeys.length, totalMigrated: migrated }
        });
      }

    } catch (error) {
      console.error('数据迁移过程出错:', error);
      this.emitStorageWarning({
        type: 'migrationError',
        message: '数据迁移失败，请检查存储空间',
        details: { totalSource: 0, totalMigrated: migrated }
      });
    }

    return { migrated, errors };
  }

  /**
   * 添加默写记录
   */
  async addDictations(date: string, dictations: any[]): Promise<void> {
    if (!this.isInitialized) await this.init();

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('数据库未初始化'));
        return;
      }

      const transaction = this.db.transaction([STORE_NAMES.DICTATIONS], 'readwrite');
      const store = transaction.objectStore(STORE_NAMES.DICTATIONS);

      dictations.forEach((dictation, index) => {
        const record = {
          ...dictation,
          date,
          timestamp: Date.now() + index // 确保唯一性
        };
        store.add(record);
      });

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  /**
   * 获取某天的默写记录
   */
  async getDictationsByDate(date: string): Promise<any[]> {
    if (!this.isInitialized) await this.init();

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('数据库未初始化'));
        return;
      }

      const transaction = this.db.transaction([STORE_NAMES.DICTATIONS], 'readonly');
      const store = transaction.objectStore(STORE_NAMES.DICTATIONS);
      const index = store.index('date');
      const request = index.getAll(date);

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 紧急备份关键数据
   */
  async backupCriticalData(): Promise<boolean> {
    if (!this.isInitialized) await this.init();

    try {
      const criticalData = {
        id: 'emergency_backup_' + Date.now(),
        timestamp: Date.now(),
        stats: localStorage.getItem('d3s_user_stats_v3'),
        settings: localStorage.getItem('d3s_settings_v3'),
        sentences: await this.getRecentSentencesBackup()
      };

      return new Promise((resolve) => {
        if (!this.db) {
          resolve(false);
          return;
        }

        const transaction = this.db.transaction([STORE_NAMES.BACKUP], 'readwrite');
        const store = transaction.objectStore(STORE_NAMES.BACKUP);
        
        const request = store.add(criticalData);
        
        request.onsuccess = () => {
          if (import.meta.env.DEV) {
            console.log('✅ 紧急备份完成');
          }
          resolve(true);
        };
        
        request.onerror = () => {
          console.error('紧急备份失败:', request.error);
          resolve(false);
        };
      });

    } catch (error) {
      console.error('紧急备份过程出错:', error);
      return false;
    }
  }

  /**
   * 检查存储空间状态
   */
  async checkStorageHealth(): Promise<{
    isHealthy: boolean;
    localStorageUsage: number;
    estimatedFreeSpace: number;
  }> {
    try {
      // 估算 localStorage 使用量
      let localStorageUsage = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) {
          const value = localStorage.getItem(key);
          localStorageUsage += (key.length + (value ? value.length : 0)) * 2; // UTF-16
        }
      }

      // 简单估算剩余空间（不精确，但能提示风险）
      const estimatedFreeSpace = 5 * 1024 * 1024 - localStorageUsage; // 假设5MB限制

      return {
        isHealthy: estimatedFreeSpace > 500 * 1024, // 剩余500KB以上算健康
        localStorageUsage,
        estimatedFreeSpace
      };

    } catch (error) {
      console.error('存储健康检查失败:', error);
      return {
        isHealthy: false,
        localStorageUsage: 0,
        estimatedFreeSpace: 0
      };
    }
  }

  private async getRecentSentencesBackup(): Promise<any> {
    // 实现获取最近学习句子的备份逻辑
    return null;
  }

  private emitStorageWarning(warning: StorageWarningData): void {
    window.dispatchEvent(new CustomEvent('d3s:storage_warning', { detail: warning }));
  }

  /**
   * 清理旧数据
   */
  async cleanupOldData(daysToKeep: number = 30): Promise<number> {
    if (!this.isInitialized) await this.init();

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffTimestamp = cutoffDate.getTime();

    let deletedCount = 0;

    try {
      // 清理旧的默写记录
      const dictations = await this.getAllDictations();
      const oldDictations = dictations.filter(d => 
        new Date(d.date).getTime() < cutoffTimestamp
      );

      for (const dictation of oldDictations) {
        await this.deleteDictation(dictation.id);
        deletedCount++;
      }

      if (import.meta.env.DEV) {
        console.log(`🧹 清理了 ${deletedCount} 条旧数据`);
      }

    } catch (error) {
      console.error('清理旧数据失败:', error);
    }

    return deletedCount;
  }

  private async getAllDictations(): Promise<any[]> {
    if (!this.db) return [];
    
    return new Promise((resolve) => {
      const transaction = this.db!.transaction([STORE_NAMES.DICTATIONS], 'readonly');
      const store = transaction.objectStore(STORE_NAMES.DICTATIONS);
      const request = store.getAll();
      
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => resolve([]);
    });
  }

  private async deleteDictation(id: number): Promise<void> {
    if (!this.db) return;
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAMES.DICTATIONS], 'readwrite');
      const store = transaction.objectStore(STORE_NAMES.DICTATIONS);
      const request = store.delete(id);
      
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.isInitialized = false;
    }
  }
}

// 全局单例
export const indexedDBService = new IndexedDBService();