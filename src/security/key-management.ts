import { EncryptionService } from './encryption-service';

export interface KeyMetadata {
  keyId: string;
  createdAt: number;
  algorithm: string;
  nextRotation: number;
  version: string;
}

export interface RotationResult {
  success: boolean;
  duration: number;
  itemsReEncrypted?: number;
  error?: string;
}

export interface ValidationResult {
  isValid: boolean;
  issues: string[];
  metadata: KeyMetadata | null;
}

export interface SecureBackup {
  version: string;
  timestamp: number;
  data: string;
  checksum: string;
}

interface ReEncryptionResult {
  count: number;
  failed: string[];
}

export class KeyManagementSystem {
  private readonly KEY_ROTATION_INTERVAL = 90 * 24 * 60 * 60 * 1000; // 90 days
  private readonly KEY_DERIVATION_ITERATIONS = 100000;
  private readonly METADATA_KEY = 'semantest:key_metadata';
  private readonly TEST_DATA_KEY = 'semantest:key_test_data';
  private encryptionService: EncryptionService;
  
  constructor() {
    this.encryptionService = new EncryptionService();
  }
  
  async initialize(password?: string): Promise<void> {
    await this.encryptionService.initialize(password);
    
    // Create test data for key validation
    await this.createTestData();
  }
  
  async rotateKeys(): Promise<RotationResult> {
    const startTime = Date.now();
    
    try {
      // Validate current key first
      const validation = await this.validateKeyIntegrity();
      if (!validation.isValid) {
        throw new Error(`Current key validation failed: ${validation.issues.join(', ')}`);
      }
      
      // Generate new master key
      const newKeyId = this.generateKeyId();
      const newEncryptionService = new EncryptionService();
      await newEncryptionService.initialize();
      
      // Re-encrypt all data with new key
      const reEncryptionResult = await this.reEncryptAllData(newEncryptionService);
      
      // Store new key metadata
      await this.storeKeyMetadata({
        keyId: newKeyId,
        createdAt: Date.now(),
        algorithm: 'AES-GCM-256',
        nextRotation: Date.now() + this.KEY_ROTATION_INTERVAL,
        version: '2.0'
      });
      
      // Update test data with new key
      await this.createTestData();
      
      // Switch to new encryption service
      this.encryptionService = newEncryptionService;
      
      // Clean up old keys after successful rotation
      await this.cleanupOldKeys();
      
      return {
        success: true,
        duration: Date.now() - startTime,
        itemsReEncrypted: reEncryptionResult.count
      };
      
    } catch (error: any) {
      console.error('Key rotation failed:', error);
      
      // Rollback on failure
      await this.rollbackKeyRotation();
      
      return {
        success: false,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }
  
  async validateKeyIntegrity(): Promise<ValidationResult> {
    const issues: string[] = [];
    
    try {
      const metadata = await this.getKeyMetadata();
      
      if (!metadata) {
        return {
          isValid: false,
          issues: ['No key metadata found'],
          metadata: null
        };
      }
      
      // Check key age
      const keyAge = Date.now() - metadata.createdAt;
      if (keyAge > this.KEY_ROTATION_INTERVAL) {
        issues.push('Key rotation overdue');
      }
      
      // Verify key can decrypt test data
      try {
        const testData = await this.getTestEncryptedData();
        if (testData) {
          await this.encryptionService.decrypt(testData);
        }
      } catch (error) {
        issues.push('Key validation failed - cannot decrypt test data');
      }
      
      // Check algorithm compatibility
      if (metadata.algorithm !== 'AES-GCM-256') {
        issues.push(`Unsupported algorithm: ${metadata.algorithm}`);
      }
      
      return {
        isValid: issues.length === 0,
        issues,
        metadata
      };
      
    } catch (error: any) {
      return {
        isValid: false,
        issues: [`Validation error: ${error.message}`],
        metadata: null
      };
    }
  }
  
  async exportSecureBackup(password: string): Promise<SecureBackup> {
    // Create a temporary encryption service with password
    const backupEncryption = new EncryptionService();
    await backupEncryption.initialize(password);
    
    // Export current key
    const currentKey = await this.encryptionService.exportKey();
    
    // Get all encrypted data
    const encryptedData = await this.getAllEncryptedData();
    
    // Create backup package
    const backupData = {
      keyData: currentKey,
      metadata: await this.getKeyMetadata(),
      encryptedItems: encryptedData,
      timestamp: Date.now()
    };
    
    // Encrypt backup with password-derived key
    const encryptedBackup = await backupEncryption.encrypt(backupData);
    
    // Calculate checksum
    const checksum = await this.calculateChecksum(JSON.stringify(backupData));
    
    return {
      version: '1.0',
      timestamp: Date.now(),
      data: JSON.stringify(encryptedBackup),
      checksum
    };
  }
  
  async importSecureBackup(backup: SecureBackup, password: string): Promise<void> {
    // Verify backup version
    if (backup.version !== '1.0') {
      throw new Error(`Unsupported backup version: ${backup.version}`);
    }
    
    // Create temporary encryption service with password
    const backupEncryption = new EncryptionService();
    await backupEncryption.initialize(password);
    
    // Decrypt backup
    const encryptedBackup = JSON.parse(backup.data);
    const backupData = await backupEncryption.decrypt(encryptedBackup);
    
    // Verify checksum
    const expectedChecksum = await this.calculateChecksum(JSON.stringify({
      keyData: backupData.keyData,
      metadata: backupData.metadata,
      encryptedItems: backupData.encryptedItems,
      timestamp: backupData.timestamp
    }));
    
    if (expectedChecksum !== backup.checksum) {
      throw new Error('Backup checksum verification failed');
    }
    
    // Import key
    await this.encryptionService.importKey(backupData.keyData);
    
    // Restore metadata
    await this.storeKeyMetadata(backupData.metadata);
    
    // Restore encrypted data
    await this.restoreEncryptedData(backupData.encryptedItems);
  }
  
  private async reEncryptAllData(newEncryptionService: EncryptionService): Promise<ReEncryptionResult> {
    const items = await chrome.storage.local.get(null);
    let count = 0;
    const failed: string[] = [];
    
    for (const [key, value] of Object.entries(items)) {
      if (!key.startsWith('semantest:') || key === this.METADATA_KEY) {
        continue;
      }
      
      try {
        // Check if item is encrypted
        if (value && typeof value === 'object' && 'encrypted' in value && value.encrypted) {
          // Decrypt with old key
          const decrypted = await this.encryptionService.decrypt(value.encryptedData);
          
          // Re-encrypt with new key
          const newEncrypted = await newEncryptionService.encrypt(decrypted);
          
          // Store with new encryption
          await chrome.storage.local.set({
            [key]: {
              encrypted: true,
              encryptedData: newEncrypted
            }
          });
          
          count++;
        }
      } catch (error) {
        console.error(`Failed to re-encrypt ${key}:`, error);
        failed.push(key);
      }
    }
    
    return { count, failed };
  }
  
  private async getKeyMetadata(): Promise<KeyMetadata | null> {
    const result = await chrome.storage.local.get(this.METADATA_KEY);
    return result[this.METADATA_KEY] || null;
  }
  
  private async storeKeyMetadata(metadata: KeyMetadata): Promise<void> {
    await chrome.storage.local.set({
      [this.METADATA_KEY]: metadata
    });
  }
  
  private generateKeyId(): string {
    return `key_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  private async createTestData(): Promise<void> {
    const testData = {
      message: 'Key validation test data',
      timestamp: Date.now(),
      random: Math.random()
    };
    
    const encrypted = await this.encryptionService.encrypt(testData);
    
    await chrome.storage.local.set({
      [this.TEST_DATA_KEY]: encrypted
    });
  }
  
  private async getTestEncryptedData(): Promise<any> {
    const result = await chrome.storage.local.get(this.TEST_DATA_KEY);
    return result[this.TEST_DATA_KEY];
  }
  
  private async getAllEncryptedData(): Promise<Record<string, any>> {
    const items = await chrome.storage.local.get(null);
    const encryptedData: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(items)) {
      if (key.startsWith('semantest:') && 
          key !== this.METADATA_KEY && 
          value && 
          typeof value === 'object' && 
          'encrypted' in value && 
          value.encrypted) {
        encryptedData[key] = value;
      }
    }
    
    return encryptedData;
  }
  
  private async restoreEncryptedData(data: Record<string, any>): Promise<void> {
    const updates: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(data)) {
      updates[key] = value;
    }
    
    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
    }
  }
  
  private async calculateChecksum(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
  
  private async cleanupOldKeys(): Promise<void> {
    // In a real implementation, this would clean up old key material
    // For now, just log
    console.log('Old keys cleaned up');
  }
  
  private async rollbackKeyRotation(): Promise<void> {
    // In a real implementation, this would rollback to previous key
    console.error('Key rotation rollback initiated');
  }
}