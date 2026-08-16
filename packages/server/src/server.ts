import http from 'http';
import crypto from 'crypto';
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

export function timingSafeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Perform dummy comparison against itself to avoid leaking timing info about length
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

interface RateLimitRecord {
  count: number;
  firstAttempt: number;
  lastAttempt: number;
  blockedUntil?: number;
}

export class AuthRateLimiter {
  private attempts = new Map<string, RateLimitRecord>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly blockDurationMs: number;

  constructor(maxAttempts = 5, windowMs = 60000, blockDurationMs = 60000) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.blockDurationMs = blockDurationMs;
  }

  public isBlocked(ip: string): boolean {
    const normalizedIp = normalizeIp(ip);
    const record = this.attempts.get(normalizedIp);
    if (!record) return false;
    const now = Date.now();
    if (record.blockedUntil && now < record.blockedUntil) {
      return true;
    }
    if (now - record.firstAttempt > this.windowMs && (!record.blockedUntil || now >= record.blockedUntil)) {
      this.attempts.delete(normalizedIp);
      return false;
    }
    return false;
  }

  public recordFailure(ip: string): void {
    const normalizedIp = normalizeIp(ip);
    const now = Date.now();
    let record = this.attempts.get(normalizedIp);
    if (!record || now - record.firstAttempt > this.windowMs) {
      record = { count: 1, firstAttempt: now, lastAttempt: now };
      this.attempts.set(normalizedIp, record);
    } else {
      record.count += 1;
      record.lastAttempt = now;
    }

    if (record.count >= this.maxAttempts) {
      record.blockedUntil = now + this.blockDurationMs;
    }
  }

  public recordSuccess(ip: string): void {
    const normalizedIp = normalizeIp(ip);
    this.attempts.delete(normalizedIp);
  }

  public reset(): void {
    this.attempts.clear();
  }
}

export function normalizeIp(ip: string): string {
  if (ip.startsWith('::ffff:')) {
    return ip.substring(7);
  }
  if (ip === '::1') {
    return '127.0.0.1';
  }
  return ip;
}

function getClientIp(req: http.IncomingMessage | { headers: http.IncomingHttpHeaders; socket?: { remoteAddress?: string } }): string {
  let ip = '127.0.0.1';
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    ip = forwarded.split(',')[0].trim();
  } else if (Array.isArray(forwarded) && forwarded.length > 0) {
    ip = forwarded[0].trim();
  } else if (req.socket?.remoteAddress) {
    ip = req.socket.remoteAddress;
  }
  return normalizeIp(ip);
}

interface ClientSession {
  clientId: string;
  clientName: string;
  deviceType: 'desktop' | 'mobile';
  ws: WebSocket;
  authenticated: boolean;
  connectedAt: number;
  lastPing: number;
  ip: string;
  authTimeout: NodeJS.Timeout | null;
}

export class SyncServer {
  private config: ServerConfig;
  private vaultManager: VaultManager;
  private vaultWatcher: VaultWatcher;
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private clients = new Map<WebSocket, ClientSession>();
  private pingInterval: NodeJS.Timeout | null = null;
  private rateLimiter: AuthRateLimiter;

  constructor(
    config: ServerConfig,
    vaultManager: VaultManager,
    vaultWatcher: VaultWatcher,
    rateLimiter?: AuthRateLimiter
  ) {
    this.config = config;
    this.vaultManager = vaultManager;
    this.vaultWatcher = vaultWatcher;
    this.rateLimiter = rateLimiter || new AuthRateLimiter();

    this.httpServer = http.createServer((req, res) => this.handleHttpRequest(req, res));
    this.wss = new WebSocketServer({
      server: this.httpServer,
      maxPayload: Math.max(150 * 1024 * 1024, this.config.maxFileSizeBytes * 2)
    });

    this.setupWebSocketServer();
    this.setupVaultWatcherEvents();
  }

  public getRateLimiter(): AuthRateLimiter {
    return this.rateLimiter;
  }

  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
      const ip = getClientIp(req);
      const session: ClientSession = {
        clientId: '',
        clientName: 'Unknown',
        deviceType: 'desktop',
        ws,
        authenticated: false,
        connectedAt: Date.now(),
        lastPing: Date.now(),
        ip,
        authTimeout: null
      };

      // 10-second authentication timeout (Issue 9)
      session.authTimeout = setTimeout(() => {
        if (!session.authenticated && ws.readyState === WebSocket.OPEN) {
          console.warn(`[SyncServer] Client from ${ip} failed to authenticate within 10s timeout`);
          this.sendMessage(ws, {
            id: `err-${crypto.randomUUID()}`,
            type: 'ERROR_NOTIFICATION',
            timestamp: Date.now(),
            code: 'AUTH_TIMEOUT',
            message: 'Authentication timeout: failed to authenticate within 10 seconds'
          });
          ws.close(4001, 'Authentication timeout');
          this.clients.delete(ws);
        }
      }, 10000);

      this.clients.set(ws, session);

      console.log(`[SyncServer] New WebSocket connection from client at ${ip}`);

      ws.on('message', async (data: Buffer | string) => {
        try {
          const rawStr = typeof data === 'string' ? data : data.toString('utf8');
          const message = JSON.parse(rawStr) as WebSocketMessage;
          await this.handleWebSocketMessage(ws, session, message);
        } catch (err) {
          console.error('[SyncServer] Error processing message:', err);
          this.sendMessage(ws, {
            id: `err-${crypto.randomUUID()}`,
            type: 'ERROR_NOTIFICATION',
            timestamp: Date.now(),
            code: 'INVALID_PAYLOAD',
            message: err instanceof Error ? err.message : 'Invalid JSON payload'
          });
        }
      });

      ws.on('pong', () => {
        session.lastPing = Date.now();
      });

      ws.on('ping', () => {
        session.lastPing = Date.now();
        if (ws.readyState === WebSocket.OPEN) {
          ws.pong();
        }
      });

      ws.on('close', () => {
        if (session.authTimeout) {
          clearTimeout(session.authTimeout);
          session.authTimeout = null;
        }
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

      // Rate limit check (Issue 4)
      if (this.rateLimiter.isBlocked(session.ip)) {
        console.warn(`[SyncServer] Auth blocked by rate limiter for IP: ${session.ip}`);
        const resp: AuthResponseMessage = {
          id: message.id,
          type: 'AUTH_RESPONSE',
          timestamp: Date.now(),
          success: false,
          serverVersion: PROTOCOL_VERSION,
          serverTime: Date.now(),
          vaultName: 'Obsidian Vault',
          error: 'Too many failed authentication attempts. Please try again later.'
        };
        this.sendMessage(ws, resp);
        ws.close(4001, 'Rate limit exceeded');
        return;
      }

      // Protocol version verification (Issue 23)
      if (!authReq.protocolVersion || authReq.protocolVersion !== PROTOCOL_VERSION) {
        console.warn(`[SyncServer] Incompatible protocol version from client: ${authReq.protocolVersion} (expected ${PROTOCOL_VERSION})`);
        const resp: AuthResponseMessage = {
          id: message.id,
          type: 'AUTH_RESPONSE',
          timestamp: Date.now(),
          success: false,
          serverVersion: PROTOCOL_VERSION,
          serverTime: Date.now(),
          vaultName: 'Obsidian Vault',
          error: `Incompatible protocol version: client is on ${authReq.protocolVersion || 'unknown'}, server requires ${PROTOCOL_VERSION}`
        };
        this.sendMessage(ws, resp);
        ws.close(4002, 'Incompatible protocol version');
        return;
      }

      // Timing-safe token comparison (Issue 4)
      if (!timingSafeCompare(authReq.token, this.config.syncToken)) {
        this.rateLimiter.recordFailure(session.ip);
        console.warn(`[SyncServer] Auth failed for client: ${authReq.clientName} (${authReq.clientId}) from ${session.ip}`);
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

      // Auth successful: clear rate limiter record and cancel timeout
      this.rateLimiter.recordSuccess(session.ip);
      if (session.authTimeout) {
        clearTimeout(session.authTimeout);
        session.authTimeout = null;
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
          id: `evt-${crypto.randomUUID()}`,
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
          const renameSuccess = await this.vaultManager.renameFile(event.oldPath, event.newPath, session.clientId);
          if (!renameSuccess && event.content !== undefined) {
            // If old path was never on server, write the new file directly
            await this.vaultManager.writeFile(
              event.newPath,
              event.content,
              event.isBinary || false,
              event.mtime || Date.now(),
              session.clientId
            );
          }

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
      id: `bc-${crypto.randomUUID()}`,
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

    // CORS headers (Restricted - Issue 5)
    const origin = req.headers.origin;
    if (origin) {
      const isAllowed = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ||
                        origin === 'app://obsidian.md' ||
                        origin === 'capacitor://localhost';
      if (isAllowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-ID');
      }
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check endpoint (Issue 20: Do not leak connected client count or sensitive state)
    if (url.pathname === '/health' || url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        time: Date.now()
      }));
      return;
    }

    const clientIp = getClientIp(req);

    // Rate limit check (Issue 4)
    if (this.rateLimiter.isBlocked(clientIp)) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      res.end(JSON.stringify({ error: 'Too many failed authentication attempts. Please try again later.' }));
      return;
    }

    // Verify token for all other API endpoints (Authorization: Bearer <token> header only)
    const authHeader = req.headers.authorization || '';
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const token = bearerMatch ? bearerMatch[1].trim() : '';

    if (!token || !timingSafeCompare(token, this.config.syncToken)) {
      this.rateLimiter.recordFailure(clientIp);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid token' }));
      return;
    }

    // Auth succeeded, reset failure record for IP
    this.rateLimiter.recordSuccess(clientIp);

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

    // POST /api/file (Issue 10: Byte size tracking and race-free error handling)
    if (url.pathname === '/api/file' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      let aborted = false;

      req.on('data', (chunk: Buffer) => {
        if (aborted) return;
        receivedBytes += chunk.length;
        if (receivedBytes > this.config.maxFileSizeBytes) {
          aborted = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large' }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', async () => {
        if (aborted) return;
        try {
          const body = Buffer.concat(chunks).toString('utf8');
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
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Write failed' }));
          }
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

        if (this.config.host === '0.0.0.0' || this.config.host === '::') {
          console.warn(`\x1b[33m[SECURITY NOTICE] Server listening on public interface (${this.config.host}) with unencrypted HTTP/WS.`);
          console.warn(`[SECURITY NOTICE] For production use, place this server behind a TLS-terminating reverse proxy (e.g. Caddy, Nginx, Cloudflare Tunnel) to enforce HTTPS/WSS encryption.\x1b[0m\n`);
        }

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
      for (const [ws, session] of this.clients.entries()) {
        if (session.authTimeout) {
          clearTimeout(session.authTimeout);
          session.authTimeout = null;
        }
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
