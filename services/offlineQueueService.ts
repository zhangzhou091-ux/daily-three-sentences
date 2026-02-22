// services/offlineQueueService.ts
import { Sentence } from '../types';
import { storageService } from './storageService';

// 定义离线操作类型
export type OfflineOperationType = 'markLearned' | 'reviewFeedback' | 'addSentence' | 'dictationRecord';

export interface OfflineOperation {
  id: string;
  type: OfflineOperationType;
  payload: {
    id?: string;
    updatedSentence?: Sentence;
    sentence?: Sentence;
    feedback?: 'easy' | 'hard' | 'forgot';
    record?: any;
    timestamp: number;
    version?: number;
  };
  timestamp: number;
  status: 'pending' | 'syncing' | 'failed';
  retryCount: number;
}

export const offlineQueueService = {
  // 添加操作到队列
  addOperation(
    operation: Omit<OfflineOperation, 'id' | 'timestamp' | 'status' | 'retryCount'>
  ): void {
    try {
      const queue = this.getQueue();
      const newOp: OfflineOperation = {
        ...operation,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        timestamp: Date.now(),
        status: 'pending',
        retryCount: 0,
        payload: {
          ...operation.payload,
          timestamp: Date.now(),
          version: operation.payload.updatedSentence?.updatedAt || operation.payload.sentence?.updatedAt || Date.now()
        }
      };
      queue.push(newOp);
      
      // 兼容两种 storageService 写法
      if (typeof storageService.save === 'function') {
        storageService.save('offlineQueue', queue);
      } else if (typeof storageService.setItem === 'function') {
        storageService.setItem('offlineQueue', JSON.stringify(queue));
      } else {
        throw new Error('storageService 缺少 save/setItem 方法');
      }
      
      console.log(`✅ 离线操作已入队: ${operation.type} - ${newOp.id}`);
    } catch (err) {
      console.error('❌ 添加离线操作失败:', err);
    }
  },

  // 获取队列
  getQueue(): OfflineOperation[] {
    try {
      let data: any;
      // 兼容两种 storageService 写法
      if (typeof storageService.get === 'function') {
        data = storageService.get('offlineQueue');
      } else if (typeof storageService.getItem === 'function') {
        const raw = storageService.getItem('offlineQueue');
        data = raw ? JSON.parse(raw) : null;
      } else {
        throw new Error('storageService 缺少 get/getItem 方法');
      }
      return data || [];
    } catch (err) {
      console.error('❌ 获取离线队列失败，返回空队列:', err);
      return [];
    }
  },

  // 更新操作状态
  updateOperationStatus(id: string, status: OfflineOperation['status']): void {
    try {
      const queue = this.getQueue();
      const opIndex = queue.findIndex(op => op.id === id);
      if (opIndex >= 0) {
        queue[opIndex].status = status;
        if (status === 'failed') queue[opIndex].retryCount += 1;
        
        if (typeof storageService.save === 'function') {
          storageService.save('offlineQueue', queue);
        } else if (typeof storageService.setItem === 'function') {
          storageService.setItem('offlineQueue', JSON.stringify(queue));
        }
      }
    } catch (err) {
      console.error('❌ 更新操作状态失败:', err);
    }
  },

  // 移除操作
  removeOperation(id: string): void {
    try {
      const queue = this.getQueue();
      const newQueue = queue.filter(op => op.id !== id);
      
      if (typeof storageService.save === 'function') {
        storageService.save('offlineQueue', newQueue);
      } else if (typeof storageService.setItem === 'function') {
        storageService.setItem('offlineQueue', JSON.stringify(newQueue));
      }
      
      console.log(`✅ 离线操作已移除队列: ${id}`);
    } catch (err) {
      console.error('❌ 移除操作失败:', err);
    }
  },

  // 清空队列
  clearQueue(): void {
    try {
      if (typeof storageService.save === 'function') {
        storageService.save('offlineQueue', []);
      } else if (typeof storageService.setItem === 'function') {
        storageService.setItem('offlineQueue', JSON.stringify([]));
      }
      console.log('✅ 离线队列已清空');
    } catch (err) {
      console.error('❌ 清空队列失败:', err);
    }
  },

  // 获取待同步操作
  getPendingOperations(): OfflineOperation[] {
    return this.getQueue().filter(
      op => (op.status === 'pending' || op.status === 'failed') && op.retryCount < 3
    );
  },

  // 按时间排序待同步操作
  getSortedPendingOperations(): OfflineOperation[] {
    return this.getPendingOperations().sort((a, b) => a.payload.timestamp - b.payload.timestamp);
  }
};