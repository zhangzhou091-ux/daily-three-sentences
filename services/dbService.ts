
import { Sentence } from '../types';

const DB_NAME = 'D3S_Database';
const DB_VERSION = 1;
const STORE_NAME = 'sentences';

class DBService {
  private db: IDBDatabase | null = null;

  /**
   * Initializes the IndexedDB connection.
   * Handles creation of object stores and indexes if needed.
   */
  async init(): Promise<IDBDatabase> {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('english', 'english', { unique: false });
          store.createIndex('intervalIndex', 'intervalIndex', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve(this.db);
      };

      request.onerror = (event) => {
        const error = (event.target as IDBOpenDBRequest).error;
        console.error('IndexedDB initialization failed:', error);
        reject(new Error(`IndexedDB initialization failed: ${error?.message || 'Unknown error'}`));
      };

      request.onblocked = () => {
        console.warn('IndexedDB initialization blocked. Please close other tabs.');
        reject(new Error('IndexedDB initialization blocked. Close other tabs and refresh.'));
      };
    });
  }

  /**
   * Retrieves all sentences from the store.
   */
  async getAll(): Promise<Sentence[]> {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error(`Failed to retrieve sentences: ${request.error?.message}`));
        transaction.onerror = () => reject(new Error(`Transaction error during retrieval: ${transaction.error?.message}`));
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Unknown error during getAll'));
      }
    });
  }

  /**
   * Adds or updates a single sentence.
   */
  async put(sentence: Sentence): Promise<void> {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(sentence);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(new Error(`Failed to save sentence: ${request.error?.message}`));
        transaction.onerror = () => reject(new Error(`Transaction error during save: ${transaction.error?.message}`));
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Unknown error during put'));
      }
    });
  }

  /**
   * Bulk adds or updates multiple sentences within a single transaction.
   */
  async putAll(sentences: Sentence[]): Promise<void> {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        sentences.forEach((s) => {
          const request = store.put(s);
          request.onerror = () => console.error(`Failed to put sentence ${s.id}:`, request.error);
        });

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(new Error(`Bulk save transaction failed: ${transaction.error?.message}`));
        transaction.onabort = () => reject(new Error('Bulk save transaction was aborted.'));
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Unknown error during putAll'));
      }
    });
  }

  /**
   * Deletes a sentence by ID.
   */
  async delete(id: string): Promise<void> {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(id);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(new Error(`Failed to delete sentence: ${request.error?.message}`));
        transaction.onerror = () => reject(new Error(`Transaction error during deletion: ${transaction.error?.message}`));
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Unknown error during delete'));
      }
    });
  }

  /**
   * Clears all data from the object store.
   */
  async clear(): Promise<void> {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.clear();

        request.onsuccess = () => resolve();
        request.onerror = () => reject(new Error(`Failed to clear store: ${request.error?.message}`));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(new Error(`Transaction error during clear: ${transaction.error?.message}`));
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Unknown error during clear'));
      }
    });
  }
}

export const dbService = new DBService();
