// Resource Manager for Remote Desktop
import { REMOTE_CONFIG } from "./REMOTE_CONFIG.js";
import { unregisterProtocol } from "../../transport/broadcast.js";

export interface RemoteClientData {
  tileManager?: any;
  protocol?: any;
  monitorManager?: any;
  screenInterval?: NodeJS.Timeout | null;
  streamingTimeout?: NodeJS.Timeout | null;
  isStreaming?: boolean;
  authenticated?: boolean;
  apiKey?: string;
  lastActivity?: number;
  streamGen?: number;
  idleFrameCount?: number;
  inFlight?: Set<number>;
  ackTimers?: Map<number, NodeJS.Timeout>;
  captureErrorCount?: number;
  lastStreamErrorAt?: number;
  [key: string]: any;
}

export class ResourceManager {
  activeClients: Map<string, RemoteClientData>;
  activeTimers: Map<string, Set<NodeJS.Timeout>>;
  chunkTimers: Map<string, Set<NodeJS.Timeout>>;
  memoryCheckInterval: NodeJS.Timeout | null;

  constructor() {
    this.activeClients = new Map();
    this.activeTimers = new Map();
    this.chunkTimers = new Map();
    this.memoryCheckInterval = null;
  }

  startResourceMonitoring(): void {
    this.memoryCheckInterval = setInterval(() => {
      // A throw during cleanup would escape the timer as an uncaught exception
      try {
        const usage = process.memoryUsage();
        const memoryMB = Math.round(usage.heapUsed / 1024 / 1024);

        if (memoryMB > REMOTE_CONFIG.resourceManagement.memoryWarningThreshold) {
          console.warn(`⚠️ High memory: ${memoryMB}MB`);
          this.cleanupInactiveClients();
        }
      } catch (err: any) {
        console.error("Memory monitor error:", err.message);
      }
    }, REMOTE_CONFIG.resourceManagement.memoryCheckInterval);
  }

  stopResourceMonitoring(): void {
    if (this.memoryCheckInterval) {
      clearInterval(this.memoryCheckInterval);
      this.memoryCheckInterval = null;
    }
  }

  addClient(socketId: string, clientData: RemoteClientData): void {
    this.activeClients.set(socketId, {
      ...clientData,
      lastActivity: Date.now()
    });
  }

  getClient(socketId: string): RemoteClientData | undefined {
    return this.activeClients.get(socketId);
  }

  updateClientActivity(socketId: string): void {
    const clientData = this.activeClients.get(socketId);
    if (clientData) {
      clientData.lastActivity = Date.now();
    }
  }

  cleanupInactiveClients(): void {
    const now = Date.now();
    const inactiveTimeout = REMOTE_CONFIG.resourceManagement.inactiveTimeout;
    
    for (const [socketId, clientData] of this.activeClients.entries()) {
      if (now - (clientData.lastActivity || 0) > inactiveTimeout) {
        console.log(`🧹 Cleaning inactive client: ${socketId}`);
        this.cleanupClientResources(socketId, clientData);
        this.activeClients.delete(socketId);
      }
    }
  }

  cleanupClientResources(socketId: string, clientData: RemoteClientData): void {
    try {
      // Stop adaptive streaming
      clientData.isStreaming = false;
      if (clientData?.streamingTimeout) {
        clearTimeout(clientData.streamingTimeout);
        clientData.streamingTimeout = null;
      }
      
      // Legacy interval cleanup
      if (clientData?.screenInterval) {
        clearInterval(clientData.screenInterval);
        clientData.screenInterval = null;
      }
      
      const clientTimers = this.activeTimers.get(socketId);
      if (clientTimers) {
        clientTimers.forEach(timerId => clearTimeout(timerId));
        this.activeTimers.delete(socketId);
      }
      
      const clientChunkTimers = this.chunkTimers.get(socketId);
      if (clientChunkTimers) {
        clientChunkTimers.forEach(timerId => clearTimeout(timerId));
        this.chunkTimers.delete(socketId);
      }
      
      if (clientData?.tileManager) {
        clientData.tileManager.clearMemory();
        clientData.tileManager.cleanup();
        clientData.tileManager.reset();
      }

      // Release the PeerConnection + drop PM from broadcast Set (GC root)
      if (clientData?.protocol) {
        clientData.protocol.close();
        unregisterProtocol(clientData.protocol);
      }
    } catch (error: any) {
      console.error(`Error cleaning up ${socketId}:`, error.message);
    }
  }

  getStreamingConfig(): typeof REMOTE_CONFIG.streaming {
    return REMOTE_CONFIG.streaming;
  }

  getWebRTCConfig(): typeof REMOTE_CONFIG.webrtc {
    return REMOTE_CONFIG.webrtc;
  }

  removeClient(socketId: string): void {
    const clientData = this.activeClients.get(socketId);
    if (clientData) {
      this.cleanupClientResources(socketId, clientData);
      this.activeClients.delete(socketId);
    }
  }

  getChunkTimers(socketId: string): Set<NodeJS.Timeout> {
    if (!this.chunkTimers.has(socketId)) {
      this.chunkTimers.set(socketId, new Set());
    }
    return this.chunkTimers.get(socketId)!;
  }

  cleanupAll(): void {
    this.stopResourceMonitoring();
    for (const [socketId, clientData] of this.activeClients.entries()) {
      this.cleanupClientResources(socketId, clientData);
    }
    this.activeClients.clear();
    this.activeTimers.clear();
    this.chunkTimers.clear();
  }
}
