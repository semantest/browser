import { StoragePort } from '@semantest/domain';
import { EncryptionService, EncryptedData, EncryptionConfig } from '../security/encryption-service';

export interface StorageConfig extends EncryptionConfig {
  namespace?: string;
}

interface StoredItem {
  encrypted: boolean;
  data?: any;
  encryptedData?: EncryptedData;
}

export class SecureStorageAdapter implements StoragePort {
  private encryptionService: EncryptionService;
  private cache = new Map<string, any>();
  private namespace: string;
  
  private readonly SENSITIVE_KEYS = [
    'apiKey', 'token', 'password', 'secret',
    'credential', 'auth', 'session', 'private',
    'key', 'cert', 'pem'
  ];
  
  constructor(namespace: string = 'semantest') {
    this.encryptionService = new EncryptionService();
    this.namespace = namespace;
  }
  
  async initialize(config?: StorageConfig): Promise<void> {
    if (config?.namespace) {
      this.namespace = config.namespace;
    }
    
    await this.encryptionService.initialize(config?.encryptionKey);
    
    // Migrate existing unencrypted data
    if (config?.migrateExisting) {
      await this.migrateUnencryptedData();
    }
  }
  
  async get<T>(key: string): Promise<T | null> {
    // Check cache first
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }
    
    const storageKey = this.getStorageKey(key);
    
    try {
      const result = await chrome.storage.local.get(storageKey);
      
      if (!result[storageKey]) {
        return null;
      }
      
      const stored: StoredItem = result[storageKey];
      
      // Handle encrypted data
      if (stored.encrypted && stored.encryptedData) {
        const decrypted = await this.encryptionService.decrypt(stored.encryptedData);
        this.cache.set(key, decrypted);
        return decrypted;
      }
      
      // Handle unencrypted data
      if (stored.data !== undefined) {
        this.cache.set(key, stored.data);
        return stored.data;
      }
      
      // Legacy format - direct value
      this.cache.set(key, stored);
      return stored as any;
      
    } catch (error) {
      console.error(`Failed to get ${key}:`, error);
      return null;
    }
  }
  
  async set(key: string, value: any): Promise<void> {
    const storageKey = this.getStorageKey(key);
    let storedItem: StoredItem;
    
    // Determine if data should be encrypted
    if (this.isSensitive(key)) {
      if (!this.encryptionService.isInitialized()) {
        throw new Error('Cannot store sensitive data: encryption not initialized');
      }
      
      const encryptedData = await this.encryptionService.encrypt(value);
      storedItem = {
        encrypted: true,
        encryptedData
      };
    } else {
      storedItem = {
        encrypted: false,
        data: value
      };
    }
    
    await chrome.storage.local.set({
      [storageKey]: storedItem
    });
    
    // Update cache
    this.cache.set(key, value);
  }
  
  async remove(key: string): Promise<void> {
    const storageKey = this.getStorageKey(key);
    await chrome.storage.local.remove(storageKey);
    this.cache.delete(key);
  }
  
  async clear(): Promise<void> {
    // Get all our namespaced keys
    const items = await chrome.storage.local.get(null);
    const keysToRemove = Object.keys(items)
      .filter(key => key.startsWith(`${this.namespace}:`));
    
    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
    }
    
    this.cache.clear();
  }
  
  async keys(): Promise<string[]> {
    const items = await chrome.storage.local.get(null);
    const prefix = `${this.namespace}:`;
    
    return Object.keys(items)
      .filter(key => key.startsWith(prefix))
      .map(key => key.substring(prefix.length));
  }
  
  async has(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== null;
  }
  
  private isSensitive(key: string): boolean {
    const lowerKey = key.toLowerCase();
    return this.SENSITIVE_KEYS.some(sensitive => 
      lowerKey.includes(sensitive)
    );
  }
  
  private getStorageKey(key: string): string {
    return `${this.namespace}:${key}`;
  }
  
  private async migrateUnencryptedData(): Promise<void> {
    console.log('Starting migration of unencrypted sensitive data...');
    
    const allData = await chrome.storage.local.get(null);
    let migratedCount = 0;
    
    for (const [storageKey, value] of Object.entries(allData)) {
      // Check if it's our namespace
      if (!storageKey.startsWith(`${this.namespace}:`)) {
        continue;
      }
      
      const key = storageKey.substring(`${this.namespace}:`.length);
      
      // Check if it's sensitive and needs encryption
      if (this.isSensitive(key)) {
        const stored = value as StoredItem;
        
        // Check if already encrypted
        if (stored.encrypted) {
          continue;
        }
        
        // Migrate unencrypted sensitive data
        try {
          const dataToEncrypt = stored.data !== undefined ? stored.data : stored;
          await this.set(key, dataToEncrypt);
          migratedCount++;
        } catch (error) {
          console.error(`Failed to migrate ${key}:`, error);
        }
      }
    }
    
    console.log(`Migration complete. Encrypted ${migratedCount} sensitive items.`);
  }
  
  // Utility methods for debugging
  async getStorageInfo(): Promise<{
    totalItems: number;
    encryptedItems: number;
    unencryptedItems: number;
    cacheSize: number;
  }> {
    const items = await chrome.storage.local.get(null);
    const ourItems = Object.entries(items)
      .filter(([key]) => key.startsWith(`${this.namespace}:`));
    
    let encryptedCount = 0;
    let unencryptedCount = 0;
    
    for (const [_, value] of ourItems) {
      const stored = value as StoredItem;
      if (stored.encrypted) {
        encryptedCount++;
      } else {
        unencryptedCount++;
      }
    }
    
    return {
      totalItems: ourItems.length,
      encryptedItems: encryptedCount,
      unencryptedItems: unencryptedCount,
      cacheSize: this.cache.size
    };
  }
  
  clearCache(): void {
    this.cache.clear();
  }
}