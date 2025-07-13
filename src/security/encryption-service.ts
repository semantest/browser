import { webcrypto } from 'crypto';

export interface EncryptedData {
  data: string;
  iv: string;
  algorithm: string;
  timestamp: number;
}

export interface EncryptionConfig {
  encryptionKey?: string;
  migrateExisting?: boolean;
}

export class EncryptionService {
  private masterKey: CryptoKey | null = null;
  private readonly ALGORITHM = 'AES-GCM';
  private readonly KEY_LENGTH = 256;
  private readonly IV_LENGTH = 12;
  private readonly SALT_LENGTH = 16;
  private readonly PBKDF2_ITERATIONS = 100000;
  
  async initialize(password?: string): Promise<void> {
    if (password) {
      // Derive key from password
      this.masterKey = await this.deriveKeyFromPassword(password);
    } else {
      // Generate and store master key
      this.masterKey = await this.generateMasterKey();
    }
  }
  
  async encrypt(data: any): Promise<EncryptedData> {
    if (!this.masterKey) {
      throw new Error('Encryption service not initialized');
    }
    
    const plaintext = JSON.stringify(data);
    const textEncoder = new TextEncoder();
    const encodedData = textEncoder.encode(plaintext);
    
    // Generate random IV
    const iv = webcrypto.getRandomValues(new Uint8Array(this.IV_LENGTH));
    
    // Encrypt data
    const encryptedData = await webcrypto.subtle.encrypt(
      {
        name: this.ALGORITHM,
        iv: iv
      },
      this.masterKey,
      encodedData
    );
    
    return {
      data: this.arrayBufferToBase64(encryptedData),
      iv: this.arrayBufferToBase64(iv),
      algorithm: this.ALGORITHM,
      timestamp: Date.now()
    };
  }
  
  async decrypt(encryptedData: EncryptedData): Promise<any> {
    if (!this.masterKey) {
      throw new Error('Encryption service not initialized');
    }
    
    if (encryptedData.algorithm !== this.ALGORITHM) {
      throw new Error(`Unsupported algorithm: ${encryptedData.algorithm}`);
    }
    
    const encryptedBuffer = this.base64ToArrayBuffer(encryptedData.data);
    const iv = this.base64ToArrayBuffer(encryptedData.iv);
    
    try {
      const decryptedData = await webcrypto.subtle.decrypt(
        {
          name: this.ALGORITHM,
          iv: new Uint8Array(iv)
        },
        this.masterKey,
        encryptedBuffer
      );
      
      const textDecoder = new TextDecoder();
      const plaintext = textDecoder.decode(decryptedData);
      
      return JSON.parse(plaintext);
    } catch (error) {
      throw new Error('Decryption failed. Data may be corrupted or key is incorrect.');
    }
  }
  
  private async deriveKeyFromPassword(password: string): Promise<CryptoKey> {
    const textEncoder = new TextEncoder();
    const passwordBuffer = textEncoder.encode(password);
    
    // Generate or retrieve salt
    const salt = await this.getSalt();
    
    // Import password as key material
    const keyMaterial = await webcrypto.subtle.importKey(
      'raw',
      passwordBuffer,
      'PBKDF2',
      false,
      ['deriveBits', 'deriveKey']
    );
    
    // Derive encryption key
    return webcrypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: this.PBKDF2_ITERATIONS,
        hash: 'SHA-256'
      },
      keyMaterial,
      {
        name: this.ALGORITHM,
        length: this.KEY_LENGTH
      },
      false,
      ['encrypt', 'decrypt']
    );
  }
  
  private async generateMasterKey(): Promise<CryptoKey> {
    // Generate cryptographically secure key
    return webcrypto.subtle.generateKey(
      {
        name: this.ALGORITHM,
        length: this.KEY_LENGTH
      },
      true,
      ['encrypt', 'decrypt']
    );
  }
  
  private async getSalt(): Promise<Uint8Array> {
    // In a real implementation, this would retrieve a stored salt
    // For now, generate a new one (should be stored securely)
    return webcrypto.getRandomValues(new Uint8Array(this.SALT_LENGTH));
  }
  
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
  
  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
  
  async exportKey(): Promise<string> {
    if (!this.masterKey) {
      throw new Error('No key to export');
    }
    
    const exported = await webcrypto.subtle.exportKey('raw', this.masterKey);
    return this.arrayBufferToBase64(exported);
  }
  
  async importKey(keyData: string): Promise<void> {
    const keyBuffer = this.base64ToArrayBuffer(keyData);
    
    this.masterKey = await webcrypto.subtle.importKey(
      'raw',
      keyBuffer,
      {
        name: this.ALGORITHM,
        length: this.KEY_LENGTH
      },
      true,
      ['encrypt', 'decrypt']
    );
  }
  
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    // Verify old password
    const oldKey = await this.deriveKeyFromPassword(oldPassword);
    
    // Test decryption with old key
    // (In real implementation, would test against stored encrypted test data)
    
    // Derive new key
    this.masterKey = await this.deriveKeyFromPassword(newPassword);
    
    // Re-encrypt all data with new key would happen here
  }
  
  isInitialized(): boolean {
    return this.masterKey !== null;
  }
}