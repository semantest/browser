import { PluginSandbox } from './plugin-sandbox';
import { SecurityError } from '../errors/security-error';

export interface PluginAction {
  type: string;
  selector?: string;
  value?: any;
  domain?: string;
}

export interface PluginResult {
  success: boolean;
  data?: any;
  error?: string;
  executionTime: number;
  memoryUsed: number;
}

interface WorkerMessage {
  type: string;
  id?: string;
  action?: PluginAction;
  result?: any;
  error?: string;
  level?: string;
  args?: any[];
}

interface PluginMetadata {
  id: string;
  name: string;
  version: string;
  codeHash: string;
  permissions: string[];
  author: string;
  signature?: string;
}

export interface SandboxConfig {
  timeout: number;
  memory: number;
  cpu: number;
  allowedAPIs: string[];
}

export class PluginSandboxManager {
  private workers = new Map<string, Worker>();
  private sandboxes = new Map<string, PluginSandbox>();
  private pluginMetadata = new Map<string, PluginMetadata>();
  private executionQueue = new Map<string, Promise<any>>();
  
  async loadPlugin(pluginId: string, pluginCode: string): Promise<void> {
    // Check if already loaded
    if (this.workers.has(pluginId)) {
      throw new Error(`Plugin ${pluginId} is already loaded`);
    }
    
    // Validate plugin signature
    const validation = await this.validatePlugin(pluginId, pluginCode);
    if (!validation.isValid) {
      throw new SecurityError(`Plugin validation failed: ${validation.error}`);
    }
    
    // Create isolated worker
    const workerBlob = new Blob([this.getWorkerWrapper(pluginCode)], {
      type: 'application/javascript'
    });
    const workerUrl = URL.createObjectURL(workerBlob);
    const worker = new Worker(workerUrl);
    
    // Create sandbox environment
    const sandbox = new PluginSandbox(pluginId, worker, {
      timeout: 30000, // 30 second execution timeout
      memory: 50 * 1024 * 1024, // 50MB memory limit
      cpu: 0.5, // 50% CPU limit
      allowedAPIs: this.getPluginPermissions(pluginId)
    });
    
    // Set up message handling
    worker.onmessage = (event) => this.handleWorkerMessage(pluginId, event);
    worker.onerror = (error) => this.handleWorkerError(pluginId, error);
    
    this.workers.set(pluginId, worker);
    this.sandboxes.set(pluginId, sandbox);
    
    // Initialize plugin
    await sandbox.initialize();
    
    // Clean up blob URL
    URL.revokeObjectURL(workerUrl);
  }
  
  async unloadPlugin(pluginId: string): Promise<void> {
    const worker = this.workers.get(pluginId);
    const sandbox = this.sandboxes.get(pluginId);
    
    if (worker) {
      worker.terminate();
      this.workers.delete(pluginId);
    }
    
    if (sandbox) {
      await sandbox.cleanup();
      this.sandboxes.delete(pluginId);
    }
    
    this.pluginMetadata.delete(pluginId);
    this.executionQueue.delete(pluginId);
  }
  
  async executePlugin(
    pluginId: string, 
    action: PluginAction
  ): Promise<PluginResult> {
    const sandbox = this.sandboxes.get(pluginId);
    if (!sandbox) {
      throw new Error(`Plugin ${pluginId} not loaded`);
    }
    
    // Check if plugin is already executing
    const existingExecution = this.executionQueue.get(pluginId);
    if (existingExecution) {
      await existingExecution;
    }
    
    // Check resource limits
    if (!sandbox.checkResourceLimits()) {
      throw new Error('Plugin resource limits exceeded');
    }
    
    // Create execution promise
    const executionPromise = this.executeWithTimeout(sandbox, action);
    this.executionQueue.set(pluginId, executionPromise);
    
    try {
      const result = await executionPromise;
      return result;
    } finally {
      this.executionQueue.delete(pluginId);
    }
  }
  
  private async executeWithTimeout(
    sandbox: PluginSandbox, 
    action: PluginAction
  ): Promise<PluginResult> {
    const timeoutPromise = new Promise<PluginResult>((_, reject) => {
      setTimeout(() => reject(new Error('Plugin execution timeout')), sandbox.config.timeout);
    });
    
    const executionPromise = sandbox.execute(action);
    
    const result = await Promise.race([executionPromise, timeoutPromise]);
    
    // Update resource usage
    sandbox.updateResourceUsage(result);
    
    return result;
  }
  
  private getWorkerWrapper(pluginCode: string): string {
    return `
      // Sandbox environment setup
      const globalThis = {};
      const window = undefined;
      const document = undefined;
      const chrome = undefined;
      const fetch = undefined;
      const XMLHttpRequest = undefined;
      const WebSocket = undefined;
      const localStorage = undefined;
      const sessionStorage = undefined;
      const indexedDB = undefined;
      
      // Safe APIs
      const console = {
        log: (...args) => postMessage({ type: 'console', level: 'log', args }),
        error: (...args) => postMessage({ type: 'console', level: 'error', args }),
        warn: (...args) => postMessage({ type: 'console', level: 'warn', args }),
        info: (...args) => postMessage({ type: 'console', level: 'info', args })
      };
      
      // Math and Date are safe
      const Math = self.Math;
      const Date = self.Date;
      const JSON = self.JSON;
      
      // Plugin API
      const semantest = {
        version: '1.0.0',
        
        async executeAction(action) {
          return new Promise((resolve, reject) => {
            const id = Math.random().toString(36).substr(2, 9);
            
            const handler = (event) => {
              if (event.data.type === 'action-response' && event.data.id === id) {
                self.removeEventListener('message', handler);
                if (event.data.error) {
                  reject(new Error(event.data.error));
                } else {
                  resolve(event.data.result);
                }
              }
            };
            
            self.addEventListener('message', handler);
            
            postMessage({
              type: 'action',
              id,
              action
            });
            
            // Timeout for action response
            setTimeout(() => {
              self.removeEventListener('message', handler);
              reject(new Error('Action timeout'));
            }, 5000);
          });
        },
        
        async queryElements(selector) {
          return semantest.executeAction({
            type: 'query',
            selector
          });
        },
        
        async fillInput(selector, value) {
          return semantest.executeAction({
            type: 'fill',
            selector,
            value
          });
        },
        
        async click(selector) {
          return semantest.executeAction({
            type: 'click',
            selector
          });
        },
        
        async waitForElement(selector, timeout = 5000) {
          return semantest.executeAction({
            type: 'wait',
            selector,
            timeout
          });
        },
        
        async getText(selector) {
          return semantest.executeAction({
            type: 'getText',
            selector
          });
        }
      };
      
      // Error handling
      self.addEventListener('error', (event) => {
        postMessage({
          type: 'error',
          error: event.message,
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno
        });
      });
      
      // Resource usage monitoring
      let memoryUsage = 0;
      const checkMemory = () => {
        // Estimate memory usage (simplified)
        if (memoryUsage > 50 * 1024 * 1024) {
          throw new Error('Memory limit exceeded');
        }
      };
      
      // Plugin definition
      let plugin = null;
      
      // Wrap plugin code in strict mode
      (function() {
        'use strict';
        
        // Prevent access to global scope
        const window = undefined;
        const self = undefined;
        const global = undefined;
        
        ${pluginCode}
        
        // Plugin should define itself
        if (typeof Plugin !== 'undefined') {
          plugin = new Plugin();
        }
      })();
      
      if (!plugin) {
        throw new Error('Plugin must define a Plugin class');
      }
      
      // Handle incoming messages
      self.addEventListener('message', async (event) => {
        const { type, id, data } = event.data;
        
        try {
          checkMemory();
          
          switch (type) {
            case 'execute':
              if (!plugin.execute) {
                throw new Error('Plugin must implement execute method');
              }
              
              const startTime = Date.now();
              const result = await plugin.execute(data);
              const executionTime = Date.now() - startTime;
              
              postMessage({
                type: 'result',
                id,
                result: {
                  success: true,
                  data: result,
                  executionTime,
                  memoryUsed: memoryUsage
                }
              });
              break;
              
            case 'initialize':
              if (plugin.initialize) {
                await plugin.initialize();
              }
              postMessage({
                type: 'initialized',
                id
              });
              break;
              
            case 'cleanup':
              if (plugin.cleanup) {
                await plugin.cleanup();
              }
              postMessage({
                type: 'cleaned',
                id
              });
              break;
              
            default:
              throw new Error(\`Unknown message type: \${type}\`);
          }
        } catch (error) {
          postMessage({
            type: 'error',
            id,
            error: error.message,
            stack: error.stack
          });
        }
      });
      
      // Signal ready
      postMessage({ type: 'ready' });
    `;
  }
  
  private async validatePlugin(
    pluginId: string, 
    code: string
  ): Promise<{ isValid: boolean; error?: string }> {
    // Get plugin metadata
    const metadata = await this.getPluginMetadata(pluginId);
    if (!metadata) {
      return { isValid: false, error: 'Plugin not registered' };
    }
    
    // Store metadata
    this.pluginMetadata.set(pluginId, metadata);
    
    // Verify code hash
    const codeHash = await this.calculateHash(code);
    if (codeHash !== metadata.codeHash) {
      return { isValid: false, error: 'Plugin code tampered' };
    }
    
    // Check for dangerous patterns
    const dangerousPatterns = [
      /eval\s*\(/g,
      /new\s+Function\s*\(/g,
      /Function\s*\(/g,
      /importScripts/g,
      /require\s*\(/g,
      /import\s+/g,
      /export\s+/g,
      /__proto__/g,
      /constructor\[/g,
      /process\./g,
      /child_process/g
    ];
    
    for (const pattern of dangerousPatterns) {
      if (pattern.test(code)) {
        return { 
          isValid: false, 
          error: `Dangerous pattern detected: ${pattern}` 
        };
      }
    }
    
    // Verify plugin structure
    if (!code.includes('class Plugin')) {
      return { isValid: false, error: 'Plugin must define a Plugin class' };
    }
    
    return { isValid: true };
  }
  
  private async getPluginMetadata(pluginId: string): Promise<PluginMetadata | null> {
    // In a real implementation, this would fetch from a registry
    // For now, return mock data
    return {
      id: pluginId,
      name: 'Test Plugin',
      version: '1.0.0',
      codeHash: await this.calculateHash('mock'),
      permissions: ['dom.read', 'dom.write'],
      author: 'Semantest Team'
    };
  }
  
  private async calculateHash(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
  
  private getPluginPermissions(pluginId: string): string[] {
    const metadata = this.pluginMetadata.get(pluginId);
    return metadata?.permissions || [];
  }
  
  private handleWorkerMessage(pluginId: string, event: MessageEvent<WorkerMessage>): void {
    const { type } = event.data;
    
    switch (type) {
      case 'console':
        this.handleConsoleMessage(pluginId, event.data);
        break;
        
      case 'action':
        this.handleActionRequest(pluginId, event.data);
        break;
        
      case 'ready':
        console.log(`Plugin ${pluginId} is ready`);
        break;
        
      default:
        console.warn(`Unknown message type from plugin ${pluginId}:`, type);
    }
  }
  
  private handleConsoleMessage(pluginId: string, message: WorkerMessage): void {
    const { level, args } = message;
    console.log(`[Plugin ${pluginId}]`, level, ...args);
  }
  
  private async handleActionRequest(pluginId: string, message: WorkerMessage): Promise<void> {
    const { id, action } = message;
    const worker = this.workers.get(pluginId);
    
    if (!worker || !action || !id) {
      return;
    }
    
    try {
      // Validate action permissions
      const sandbox = this.sandboxes.get(pluginId);
      if (!sandbox?.hasPermission(action.type)) {
        throw new Error(`Permission denied for action: ${action.type}`);
      }
      
      // Execute action (would be implemented based on action type)
      let result;
      switch (action.type) {
        case 'query':
          result = await this.executeQuery(action.selector!);
          break;
        case 'click':
          result = await this.executeClick(action.selector!);
          break;
        case 'fill':
          result = await this.executeFill(action.selector!, action.value);
          break;
        default:
          throw new Error(`Unknown action type: ${action.type}`);
      }
      
      // Send response
      worker.postMessage({
        type: 'action-response',
        id,
        result
      });
      
    } catch (error: any) {
      worker.postMessage({
        type: 'action-response',
        id,
        error: error.message
      });
    }
  }
  
  private handleWorkerError(pluginId: string, error: ErrorEvent): void {
    console.error(`Plugin ${pluginId} error:`, error);
    
    // Emit error event
    const sandbox = this.sandboxes.get(pluginId);
    sandbox?.handleError(error);
  }
  
  // Action implementations (simplified)
  private async executeQuery(selector: string): Promise<any> {
    // Would implement actual DOM query
    return { found: true, count: 1 };
  }
  
  private async executeClick(selector: string): Promise<any> {
    // Would implement actual click
    return { clicked: true };
  }
  
  private async executeFill(selector: string, value: any): Promise<any> {
    // Would implement actual fill
    return { filled: true, value };
  }
  
  getLoadedPlugins(): string[] {
    return Array.from(this.workers.keys());
  }
  
  getPluginInfo(pluginId: string): PluginMetadata | undefined {
    return this.pluginMetadata.get(pluginId);
  }
}