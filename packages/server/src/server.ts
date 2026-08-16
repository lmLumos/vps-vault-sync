import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  AuthRequestMessage,
  AuthResponseMessage,
  ErrorNotificationMessage,
  FileCreateOrModifyEvent,
  FileDeleteEvent,
  FileGetRequestMessage,
  FileGetResponseMessage,
  FilePutRequestMessage,
  FilePutResponseMessage,
  ManifestDiffRequestMessage,
  ManifestDiffResponseMessage,
  ManifestRequestMessage,
  ManifestResponseMessage,
  PROTOCOL_VERSION,
  SyncEvent,
  SyncEventAckMessage,
  SyncEventMessage,
  WebSocketMessage
} from '@vps-vault-sync/shared';
import { ServerConfig } from './config';
import { VaultManager } from './vault-manager';
import { VaultWatcher } from './watcher';

interface ClientSession {
  clientId: string;
  clientName: string;
  deviceType: 'desktop' | 'mobile';
  ws: WebSocket;
  authenticated: boolean;
  connectedAt: number;
  lastPing: number;
}

export class SyncServer {
  private config: ServerConfig;
  private vaultManager: VaultManager;
  private vaultWatcher: VaultWatcher;
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private clients = new Map<WebSocket, ClientSession>();
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(
    config: ServerConfig,
    vaultManager: VaultManager,
    vaultWatcher: VaultWatcher
  ) {
    this.config = config;
    this.vaultManager = vaultManager;
    this.vaultWatcher = vaultWatcher;

    this.httpServer = http.createServer((req, res) => this.handleHttpRequest(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.setupWebSocketServer();
    this.setupVaultWatcherEvents();
  }

  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      const session: ClientSession = {
        clientId: '',
        clientName: 'Unknown',
        deviceType: 'desktop',
        ws,
        authenticated: false,
        connectedAt: Date.now(),
        lastPing: Date.now()
      };
      this.clients.set(ws, session);

      console.log(`[SyncServer] New WebSocket connection from client`);

      ws.on('message', async (data: Buffer | string) => {
        try {
          const rawStr = typeof data === 'string' ? data : data.toString('utf8');
          const message = JSON.parse(rawStr) as WebSocketMessage;
          await this.handleWebSocketMessage(ws, session, message);
        } catch (err) {
          console.error('[SyncServer] Error processing message:', err);
          this.sendMessage(ws, {
            id: `err-${Date.now()}`,
            type: 'ERROR_NOTIFICATION',
            timestamp: Date.now(),
            code: 'INVALID_PAYLOAD',
            message: err instanceof Error ? err.message : 'Invalid JSON payload'
          });
        }
      });

      ws.on('close', () => {
        if (session.authenticated) {
          console.log(`[SyncServer] Client disconnected: ${session.clientName} (${session.clientId})`);
        }
        this.clients.delete(ws);
      });

      ws.on('error', (err) => {
        console.error(`[SyncServer] WebSocket error on client ${session.clientId}:`, err);
      });
    });

    // Periodic ping/pong health check
    this.pingInterval = setInterval(() => {
      const now = Date.now();
      for (const [ws, session] of this.clients.entries()) {
        if (ws.readyState === WebSocket.OPEN) {
          if (now - session.lastPing > 45000) {
            // Heartbeat timeout
            console.log(`[SyncServer] Client ${session.clientId} timed out, terminating connection`);
            ws.terminate();
            this.clients.delete(ws);
          } else {
            ws.ping();
          }
        }
      }
    }, 20000);
    this.pingInterval.unref();
  }

  private setupVaultWatcherEvents(): void {
    this.vaultWatcher.on('change', (event: FileCreateOrModifyEvent | FileDeleteEvent) => {
      console.log(`[SyncServer] Local VPS filesystem change detected: [${event.type.toUpperCase()}] ${event.path}`);
      this.broadcastSyncEvent(event);
    });
  }

  private async handleWebSocketMessage(
    ws: WebSocket,
    session: ClientSession,
    message: WebSocketMessage
  ): Promise<void> {
    // 1. Authentication
    if (message.type === 'AUTH_REQUEST') {
      const authReq = message as AuthRequestMessage;
      if (authReq.token !== this.config.syncToken) {
        console.warn(`[SyncServer] Auth failed for client: ${authReq.clientName} (${authReq.clientId})`);
        const resp: AuthResponseMessage = {
          id: message.id,
          type: 'AUTH_RESPONSE',
          timestamp: Date.now(),
          success: false,
          serverVersion: PROTOCOL_VERSION,
          serverTime: Date.now(),
          vaultName: 'Obsidian Vault',
          error: 'Invalid authentication secret token'
        };
        this.sendMessage(ws, resp);
        ws.close(4001, 'Unauthorized');
        return;
      }

      session.authenticated = true;
      session.clientId = authReq.clientId;
      session.clientName = authReq.clientName;
      session.deviceType = authReq.deviceType;

      console.log(`[SyncServer] Client authenticated: ${session.clientName} [${session.deviceType}] (${session.clientId})`);

      const authResp: AuthResponseMessage = {
        id: message.id,
        type: 'AUTH_RESPONSE',
        timestamp: Date.now(),
        success: true,
        serverVersion: PROTOCOL_VERSION,
        serverTime: Date.now(),
        vaultName: 'Obsidian Vault'
      };
      this.sendMessage(ws, authResp);
      return;
    }

    // Require authentication for all other messages
    if (!session.authenticated) {
      this.sendMessage(ws, {
        id: message.id,
        type: 'ERROR_NOTIFICATION',
        timestamp: Date.now(),
        code: 'UNAUTHENTICATED',
        message: 'Must authenticate first'
      });
      return;
    }

    session.lastPing = Date.now();

    // 2. Ping / Pong
    if (message.type === 'PING') {
      this.sendMessage(ws, {
        id: message.id,
        type: 'PONG',
        timestamp: Date.now()
      });
      return;
    }

    // 3. Manifest Request
    if (message.type === 'MANIFEST_REQUEST') {
      const manifest = await this.vaultManager.buildManifest();
      const resp: ManifestResponseMessage = {
        id: message.id,
        type: 'MANIFEST_RESPONSE',
        timestamp: Date.now(),
        manifest,
        serverTime: Date.now()
      };
      this.sendMessage(ws, resp);
      return;
    }

    // 4. Manifest Diff Request
    if (message.type === 'MANIFEST_DIFF_REQUEST') {
      const diffReq = message as ManifestDiffRequestMessage;
      const serverManifest = await this.vaultManager.buildManifest();
      const diff = this.vaultManager.computeDiff(diffReq.clientManifest, serverManifest);

      const resp: ManifestDiffResponseMessage = {
        id: message.id,
        type: 'MANIFEST_DIFF_RESPONSE',
        timestamp: Date.now(),
        diff,
        serverManifest
      };
      this.sendMessage(ws, resp);
      return;
    }

    // 5. Direct File Get
    if (message.type === 'FILE_GET_REQUEST') {
      const getReq = message as FileGetRequestMessage;
      const fileData = await this.vaultManager.readFile(getReq.path);
      const resp: FileGetResponseMessage = {
        id: message.id,
        type: 'FILE_GET_RESPONSE',
        timestamp: Date.now(),
        path: getReq.path,
        exists: Boolean(fileData),
        metadata: fileData?.metadata,
        content: fileData?.content,
        isBinary: fileData?.isBinary
      };
      this.sendMessage(ws, resp);
      return;
    }

    // 6. Direct File Put
    if (message.type === 'FILE_PUT_REQUEST') {
      const putReq = message as FilePutRequestMessage;
      try {
        const result = await this.vaultManager.writeFile(
          putReq.path,
          putReq.content,
          putReq.isBinary,
          putReq.mtime,
          session.clientId,
          putReq.baseHash
        );

        const resp: FilePutResponseMessage = {
          id: message.id,
          type: 'FILE_PUT_RESPONSE',
          timestamp: Date.now(),
          path: putReq.path,
          success: true,
          metadata: result.metadata,
          conflictOccurred: result.conflictOccurred,
          conflictPath: result.conflictPath
        };
        this.sendMessage(ws, resp);

        // Broadcast file change to other connected clients
        const event: FileCreateOrModifyEvent = {
          id: `evt-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          clientId: session.clientId,
          timestamp: Date.now(),
          type: 'modify',
          path: putReq.path,
          hash: result.metadata.hash,
          mtime: result.metadata.mtime,
          size: result.metadata.size,
          isBinary: putReq.isBinary,
          content: putReq.content.length < 500 * 1024 ? putReq.content : undefined,
          chunked: putReq.content.length >= 500 * 1024
        };
        this.broadcastSyncEvent(event, session.clientId);
      } catch (err) {
        console.error(`[SyncServer] Error saving file ${putReq.path}:`, err);
        const resp: FilePutResponseMessage = {
          id: message.id,
          type: 'FILE_PUT_RESPONSE',
          timestamp: Date.now(),
          path: putReq.path,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown write error'
        };
        this.sendMessage(ws, resp);
      }
      return;
    }

    // 7. Sync Event from Client
    if (message.type === 'SYNC_EVENT') {
      const eventMsg = message as SyncEventMessage;
      const event = eventMsg.event;

      try {
        if (event.type === 'create' || event.type === 'modify') {
          if (event.content !== undefined) {
            const res = await this.vaultManager.writeFile(
              event.path,
              event.content,
              event.isBinary,
              event.mtime,
              session.clientId,
              event.baseHash
            );

            const ack: SyncEventAckMessage = {
              id: message.id,
              type: 'SYNC_EVENT_ACK',
              timestamp: Date.now(),
              eventId: event.id,
              path: event.path,
              success: true,
              newHash: res.metadata.hash,
              newMtime: res.metadata.mtime,
              conflictDetected: res.conflictOccurred,
              conflictPath: res.conflictPath
            };
            this.sendMessage(ws, ack);

            // Broadcast to other clients
            this.broadcastSyncEvent(event, session.clientId);
          } else {
            // Need chunked download or separate put
            const ack: SyncEventAckMessage = {
              id: message.id,
              type: 'SYNC_EVENT_ACK',
              timestamp: Date.now(),
              eventId: event.id,
              path: event.path,
              success: true
            };
            this.sendMessage(ws, ack);
          }
        } else if (event.type === 'delete') {
          await this.vaultManager.deleteFile(event.path, session.clientId);
          const ack: SyncEventAckMessage = {
            id: message.id,
            type: 'SYNC_EVENT_ACK',
            timestamp: Date.now(),
            eventId: event.id,
            path: event.path,
            success: true
          };
          this.sendMessage(ws, ack);

          // Broadcast deletion
          this.broadcastSyncEvent(event, session.clientId);
        } else if (event.type === 'rename') {
          await this.vaultManager.renameFile(event.oldPath, event.newPath, session.clientId);
          const ack: SyncEventAckMessage = {
            id: message.id,
            type: 'SYNC_EVENT_ACK',
            timestamp: Date.now(),
            eventId: event.id,
            path: event.newPath,
            success: true
          };
          this.sendMessage(ws, ack);

          // Broadcast rename
          this.broadcastSyncEvent(event, session.clientId);
        }
      } catch (err) {
        const eventTarget = 'path' in event ? event.path : event.newPath;
        console.error(`[SyncServer] Error processing sync event for ${eventTarget}:`, err);
        const ack: SyncEventAckMessage = {
          id: message.id,
          type: 'SYNC_EVENT_ACK',
          timestamp: Date.now(),
          eventId: event.id,
          path: eventTarget,
          success: false,
          error: err instanceof Error ? err.message : 'Event execution failed'
        };
        this.sendMessage(ws, ack);
      }
    }
  }

  public broadcastSyncEvent(event: SyncEvent, excludeClientId?: string): void {
    const message: SyncEventMessage = {
      id: `bc-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      type: 'SYNC_EVENT',
      timestamp: Date.now(),
      event
    };

    const payload = JSON.stringify(message);

    for (const [ws, session] of this.clients.entries()) {
      if (session.authenticated && ws.readyState === WebSocket.OPEN) {
        if (!excludeClientId || session.clientId !== excludeClientId) {
          ws.send(payload);
        }
      }
    }
  }

  private sendMessage(ws: WebSocket, message: WebSocketMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check endpoint
    if (url.pathname === '/health' || url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        version: PROTOCOL_VERSION,
        connectedClients: Array.from(this.clients.values()).filter(c => c.authenticated).length,
        time: Date.now()
      }));
      return;
    }

    // Verify token for all other API endpoints
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '') || url.searchParams.get('token');

    if (token !== this.config.syncToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid token' }));
      return;
    }

    // GET /api/manifest
    if (url.pathname === '/api/manifest' && req.method === 'GET') {
      this.vaultManager.buildManifest().then(manifest => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ manifest, serverTime: Date.now() }));
      }).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // GET /api/file?path=...
    if (url.pathname === '/api/file' && req.method === 'GET') {
      const filePath = url.searchParams.get('path');
      if (!filePath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing path query parameter' }));
        return;
      }

      this.vaultManager.readFile(filePath).then(fileData => {
        if (!fileData) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'File not found' }));
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-File-Hash': fileData.metadata.hash,
          'X-File-Mtime': fileData.metadata.mtime.toString()
        });
        res.end(JSON.stringify(fileData));
      }).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // POST /api/file
    if (url.pathname === '/api/file' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > this.config.maxFileSizeBytes) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large' }));
          req.destroy();
        }
      });

      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          const clientId = (req.headers['x-client-id'] as string) || 'http-client';
          const result = await this.vaultManager.writeFile(
            payload.path,
            payload.content,
            payload.isBinary,
            payload.mtime || Date.now(),
            clientId,
            payload.baseHash
          );

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, metadata: result.metadata, conflictOccurred: result.conflictOccurred }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Write failed' }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  public async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.port, this.config.host, () => {
        console.log(`\n\x1b[32m=======================================================`);
        console.log(`🚀 Obsidian VPS Sync Server is RUNNING`);
        console.log(`   Host / Port: http://${this.config.host}:${this.config.port}`);
        console.log(`   WebSocket:   ws://${this.config.host}:${this.config.port}`);
        console.log(`   Vault Path:  ${this.config.vaultPath}`);
        console.log(`   Retention:   ${this.config.archiveRetentionDays} days`);
        console.log(`=======================================================\x1b[0m\n`);
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    return new Promise((resolve) => {
      for (const [ws] of this.clients.entries()) {
        ws.close(1000, 'Server stopping');
      }
      this.wss.close(() => {
        this.httpServer.close(() => {
          resolve();
        });
      });
    });
  }
}
