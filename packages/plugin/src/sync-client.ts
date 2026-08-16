import { App, Notice, TFile, TFolder } from 'obsidian';
import {
  AuthRequestMessage,
  AuthResponseMessage,
  FileCreateOrModifyEvent,
  FileDeleteEvent,
  FileGetRequestMessage,
  FileGetResponseMessage,
  FilePutRequestMessage,
  FilePutResponseMessage,
  FileRenameEvent,
  hashBuffer,
  hashString,
  isBinaryFile,
  ManifestDiffRequestMessage,
  ManifestDiffResponseMessage,
  ManifestRequestMessage,
  ManifestResponseMessage,
  PROTOCOL_VERSION,
  SyncEvent,
  SyncEventAckMessage,
  SyncEventMessage,
  VaultManifest,
  WebSocketMessage
} from '@vps-vault-sync/shared';
import type VPSVaultSyncPlugin from './main';

export type SyncStatus = 'disconnected' | 'connecting' | 'authenticating' | 'reconciling' | 'synced' | 'syncing' | 'error';

export interface ActivityLogEntry {
  id: string;
  timestamp: number;
  type: 'upload' | 'download' | 'delete' | 'conflict' | 'info' | 'error';
  path: string;
  message: string;
}

export class SyncClient {
  private app: App;
  private plugin: VPSVaultSyncPlugin;
  private ws: WebSocket | null = null;
  private status: SyncStatus = 'disconnected';
  private reconnectTimeout: number | null = null;
  private reconnectAttempts = 0;
  private pendingRequests = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void; timer: number }>();
  private statusListeners: Array<(status: SyncStatus, detail?: string) => void> = [];
  private activityLogs: ActivityLogEntry[] = [];
  private isReconciling = false;
  private reloadTimers = new Map<string, number>();

  constructor(app: App, plugin: VPSVaultSyncPlugin) {
    this.app = app;
    this.plugin = plugin;
  }

  public getStatus(): SyncStatus {
    return this.status;
  }

  public getLogs(): ActivityLogEntry[] {
    return [...this.activityLogs];
  }

  public logActivity(type: ActivityLogEntry['type'], path: string, message: string): void {
    const entry: ActivityLogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      timestamp: Date.now(),
      type,
      path,
      message
    };
    this.activityLogs.unshift(entry);
    if (this.activityLogs.length > 200) {
      this.activityLogs.pop();
    }
  }

  public onStatusChange(listener: (status: SyncStatus, detail?: string) => void): void {
    this.statusListeners.push(listener);
  }

  private setStatus(newStatus: SyncStatus, detail?: string): void {
    this.status = newStatus;
    for (const listener of this.statusListeners) {
      try {
        listener(newStatus, detail);
      } catch (err) {
        console.error('[SyncClient] Error in status listener:', err);
      }
    }
  }

  public connect(): void {
    if (!this.plugin.settings.liveSyncEnabled || !this.plugin.settings.serverUrl || !this.plugin.settings.authToken) {
      this.setStatus('disconnected', 'Server URL or token not configured');
      return;
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.clearReconnectTimeout();
    this.setStatus('connecting');

    try {
      let wsUrl = this.plugin.settings.serverUrl.trim();
      if (wsUrl.startsWith('http://')) {
        wsUrl = wsUrl.replace('http://', 'ws://');
      } else if (wsUrl.startsWith('https://')) {
        wsUrl = wsUrl.replace('https://', 'wss://');
      }

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.setStatus('authenticating');
        this.sendHandshake();
      };

      this.ws.onmessage = async (event) => {
        try {
          const rawData = typeof event.data === 'string' ? event.data : await (event.data as Blob).text();
          const message = JSON.parse(rawData) as WebSocketMessage;
          await this.handleMessage(message);
        } catch (err) {
          console.error('[SyncClient] Failed to parse incoming WebSocket message:', err);
        }
      };

      this.ws.onclose = (event) => {
        this.cleanupWs();
        if (event.code === 4001) {
          this.setStatus('error', 'Authentication failed (check token)');
          this.logActivity('error', '', 'Authentication failed: Invalid secret token');
          new Notice('❌ VPS Sync: Authentication failed. Please verify your secret token in settings.');
        } else {
          this.setStatus('disconnected', 'Connection closed');
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (err) => {
        console.error('[SyncClient] WebSocket error:', err);
        this.setStatus('error', 'Connection error');
      };
    } catch (err) {
      console.error('[SyncClient] Connect error:', err);
      this.setStatus('error', err instanceof Error ? err.message : 'Connect failed');
      this.scheduleReconnect();
    }
  }

  public disconnect(): void {
    this.clearReconnectTimeout();
    if (this.ws) {
      this.ws.close(1000, 'User disconnected');
      this.cleanupWs();
    }
    this.setStatus('disconnected');
  }

  public reconnect(): void {
    this.disconnect();
    this.connect();
  }

  public async testConnection(): Promise<boolean> {
    return new Promise((resolve) => {
      let testWs: WebSocket | null = null;
      let timeout: number | null = null;

      try {
        let wsUrl = this.plugin.settings.serverUrl.trim();
        if (wsUrl.startsWith('http://')) wsUrl = wsUrl.replace('http://', 'ws://');
        else if (wsUrl.startsWith('https://')) wsUrl = wsUrl.replace('https://', 'wss://');

        testWs = new WebSocket(wsUrl);

        timeout = window.setTimeout(() => {
          if (testWs) testWs.close();
          resolve(false);
        }, 6000);

        testWs.onopen = () => {
          const authMsg: AuthRequestMessage = {
            id: `test-${Date.now()}`,
            type: 'AUTH_REQUEST',
            timestamp: Date.now(),
            token: this.plugin.settings.authToken,
            clientId: this.plugin.settings.clientId,
            clientName: this.plugin.settings.deviceName,
            protocolVersion: PROTOCOL_VERSION,
            deviceType: 'desktop'
          };
          testWs?.send(JSON.stringify(authMsg));
        };

        testWs.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data) as WebSocketMessage;
            if (msg.type === 'AUTH_RESPONSE') {
              const resp = msg as AuthResponseMessage;
              if (timeout) window.clearTimeout(timeout);
              testWs?.close();
              resolve(resp.success);
            }
          } catch {
            resolve(false);
          }
        };

        testWs.onerror = () => {
          if (timeout) window.clearTimeout(timeout);
          resolve(false);
        };
      } catch {
        if (timeout) window.clearTimeout(timeout);
        resolve(false);
      }
    });
  }

  private sendHandshake(): void {
    const authMsg: AuthRequestMessage = {
      id: `auth-${Date.now()}`,
      type: 'AUTH_REQUEST',
      timestamp: Date.now(),
      token: this.plugin.settings.authToken,
      clientId: this.plugin.settings.clientId,
      clientName: this.plugin.settings.deviceName,
      protocolVersion: PROTOCOL_VERSION,
      deviceType: 'desktop'
    };
    this.send(authMsg);
  }

  private scheduleReconnect(): void {
    if (!this.plugin.settings.liveSyncEnabled) return;
    this.clearReconnectTimeout();

    this.reconnectAttempts++;
    const delay = Math.min(30000, 1000 * Math.pow(1.5, this.reconnectAttempts) + Math.random() * 1000);

    this.reconnectTimeout = window.setTimeout(() => {
      if (this.status !== 'synced' && this.status !== 'syncing') {
        this.connect();
      }
    }, delay);
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimeout !== null) {
      window.clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private cleanupWs(): void {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws = null;
    }
    // Reject any pending requests
    for (const req of this.pendingRequests.values()) {
      window.clearTimeout(req.timer);
      req.reject(new Error('WebSocket connection closed'));
    }
    this.pendingRequests.clear();
  }

  public isConnected(): boolean {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  public async processOfflineQueue(): Promise<void> {
    if (!this.isConnected()) return;
    const queue = this.plugin.offlineQueue.getQueue();
    if (!queue || queue.length === 0) return;

    this.logActivity('info', '', `Processing ${queue.length} offline queued items...`);
    const remaining: SyncEvent[] = [];

    for (const event of queue) {
      try {
        await this.onLocalSyncEvent(event);
      } catch {
        remaining.push(event);
      }
    }

    this.plugin.offlineQueue.clear();
    for (const item of remaining) {
      await this.plugin.offlineQueue.enqueue(item);
    }
  }

  public send(message: WebSocketMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  public async request<T = any>(message: WebSocketMessage, timeoutMs = 15000): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket not connected'));
      }

      const timer = window.setTimeout(() => {
        this.pendingRequests.delete(message.id);
        reject(new Error(`Request timeout for message type: ${message.type}`));
      }, timeoutMs);

      this.pendingRequests.set(message.id, { resolve, reject, timer });
      this.send(message);
    });
  }

  private async handleMessage(message: WebSocketMessage): Promise<void> {
    // Check pending request-response matching
    if (this.pendingRequests.has(message.id)) {
      const { resolve, timer } = this.pendingRequests.get(message.id)!;
      window.clearTimeout(timer);
      this.pendingRequests.delete(message.id);
      resolve(message);
    }

    switch (message.type) {
      case 'AUTH_RESPONSE': {
        const resp = message as AuthResponseMessage;
        if (resp.success) {
          this.logActivity('info', '', `Connected and authenticated with ${resp.vaultName}`);
          this.setStatus('reconciling');
          await this.reconcileVault();
          await this.processOfflineQueue();
        } else {
          this.setStatus('error', resp.error || 'Auth failed');
          this.logActivity('error', '', `Authentication error: ${resp.error}`);
        }
        break;
      }

      case 'SYNC_EVENT': {
        const eventMsg = message as SyncEventMessage;
        await this.handleRemoteSyncEvent(eventMsg.event);
        break;
      }

      case 'ERROR_NOTIFICATION': {
        console.error('[SyncClient] Server error notification:', message);
        this.logActivity('error', '', `Server Error: ${(message as any).message}`);
        break;
      }
    }
  }

  /**
   * Applies incoming sync event from server (originating from VPS filesystem or another device)
   */
  private async handleRemoteSyncEvent(event: SyncEvent): Promise<void> {
    this.setStatus('syncing');

    try {
      if (event.type === 'create' || event.type === 'modify') {
        await this.applyRemoteFileWrite(event);
      } else if (event.type === 'delete') {
        await this.applyRemoteFileDelete(event);
      } else if (event.type === 'rename') {
        await this.applyRemoteFileRename(event);
      }
      this.setStatus('synced');
    } catch (err) {
      console.error(`[SyncClient] Error applying remote sync event:`, err);
      this.logActivity('error', 'path' in event ? event.path : '', `Failed to apply update: ${err instanceof Error ? err.message : String(err)}`);
      this.setStatus('synced');
    }
  }

  private async applyRemoteFileWrite(event: FileCreateOrModifyEvent): Promise<void> {
    let content = event.content;

    // Fetch content if chunked / not inline
    if (content === undefined) {
      const getResp = await this.request<FileGetResponseMessage>({
        id: `get-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        type: 'FILE_GET_REQUEST',
        timestamp: Date.now(),
        path: event.path
      });
      content = getResp.content || '';
    }

    const adapter = this.app.vault.adapter;
    const isBin = event.isBinary;
    const normalizedPath = event.path.replace(/\\/g, '/');

    // Suppress local watcher echo
    this.plugin.vaultWatcher.suppressPath(normalizedPath, 4000);

    const exists = await adapter.exists(normalizedPath);

    if (!isBin) {
      let incomingText = content;
      if (exists) {
        const currentLocalText = await adapter.read(normalizedPath);

        const isMarkdown = normalizedPath.endsWith('.md') || normalizedPath.endsWith('.txt');
        if (isMarkdown && this.plugin.settings.conflictStrategy === 'three-way') {
          const res = await this.plugin.conflictHandler.resolveTextConflict(
            normalizedPath,
            currentLocalText,
            incomingText
          );

          if (res.conflictOccurred) {
            this.logActivity('conflict', normalizedPath, `Conflict detected! Created ${res.conflictFileCreated}`);
            return;
          }
          incomingText = res.textToWrite;
        }
      }

      await this.ensureParentFolder(normalizedPath);
      await adapter.write(normalizedPath, incomingText);
      this.plugin.conflictHandler.recordBaseSnapshot(normalizedPath, incomingText);
      this.logActivity('download', normalizedPath, `Downloaded note (${event.type})`);
    } else {
      // Binary file
      const buf = Buffer.from(content, 'base64');
      const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

      await this.ensureParentFolder(normalizedPath);
      await adapter.writeBinary(normalizedPath, arrayBuf);
      this.logActivity('download', normalizedPath, `Downloaded binary asset`);
    }

    const configPrefix = (this.app.vault.configDir || '.obsidian') + '/';
    if (normalizedPath.startsWith('.obsidian/') || normalizedPath.startsWith(configPrefix)) {
      this.plugin.vaultWatcher.recordConfigHash(normalizedPath, event.hash);
      this.hotReloadPluginOrTheme(normalizedPath);
    }
  }

  /**
   * Dynamically hot-reloads running plugins, themes, and views when their data.json or styles change
   */
  private hotReloadPluginOrTheme(normalizedPath: string): void {
    try {
      // 1. Theme / CSS / Appearance reload
      if (normalizedPath.includes('appearance.json')) {
        this.app.vault.adapter.read(normalizedPath).then((contentStr) => {
          try {
            const conf = JSON.parse(contentStr);
            const customCss = (this.app as any).customCss;

            if (conf.cssTheme !== undefined && typeof customCss?.setTheme === 'function') {
              customCss.setTheme(conf.cssTheme);
            }
            if (conf.theme !== undefined && typeof (this.app as any).setTheme === 'function') {
              (this.app as any).setTheme(conf.theme);
            }
            if (conf.accentColor !== undefined && typeof (this.app as any).vault?.setConfig === 'function') {
              (this.app as any).vault.setConfig('accentColor', conf.accentColor);
            }

            if (typeof customCss?.requestLoadTheme === 'function') customCss.requestLoadTheme();
            if (typeof customCss?.loadTheme === 'function') customCss.loadTheme();
            if (typeof customCss?.requestLoadSnippets === 'function') customCss.requestLoadSnippets();
            if (typeof customCss?.readSnippets === 'function') customCss.readSnippets();
            this.app.workspace.trigger('css-change');
          } catch {
            // ignore JSON parse
          }
        }).catch(() => {});
      } else if (normalizedPath.includes('/themes/') || normalizedPath.includes('/snippets/')) {
        const customCss = (this.app as any).customCss;
        if (customCss) {
          if (typeof customCss.requestLoadTheme === 'function') customCss.requestLoadTheme();
          if (typeof customCss.requestLoadSnippets === 'function') customCss.requestLoadSnippets();
          if (typeof customCss.loadTheme === 'function') customCss.loadTheme();
          if (typeof customCss.readSnippets === 'function') customCss.readSnippets();
        }
        this.app.workspace.trigger('css-change');
      }

      // 2. Plugin data or manifest changes (Icons, Themes, Minimal settings, etc.)
      const pluginMatch = normalizedPath.match(/(?:\.obsidian|[^\/]+)\/plugins\/([^\/]+)\//);
      if (pluginMatch) {
        const pluginId = pluginMatch[1];
        if (pluginId && pluginId !== 'vps-vault-sync') {
          // Debounce reload to avoid re-enabling multiple times during multi-file download
          if (this.reloadTimers.has(pluginId)) {
            window.clearTimeout(this.reloadTimers.get(pluginId)!);
          }

          const timer = window.setTimeout(async () => {
            this.reloadTimers.delete(pluginId);
            const plugins = (this.app as any).plugins;
            if (!plugins) return;

            // If manifest updated or new plugin, refresh manifests
            if (typeof plugins.loadManifests === 'function') {
              await plugins.loadManifests();
            }

            const isEnabled = Boolean(
              plugins.plugins?.[pluginId] ||
              (plugins.enabledPlugins instanceof Set && plugins.enabledPlugins.has(pluginId)) ||
              (Array.isArray(plugins.enabledPlugins) && plugins.enabledPlugins.includes(pluginId))
            );

            // If plugin is enabled, trigger its exact in-memory reload functions
            if (isEnabled) {
              console.log(`[SyncClient] Live reloading plugin "${pluginId}" after sync...`);
              const pluginInstance = plugins.plugins?.[pluginId];

              if (pluginInstance) {
                // Folder Icons / Iconize
                if (pluginId === 'obsidian-icon-folder' || pluginId === 'iconize') {
                  try {
                    const text = await this.app.vault.adapter.read(normalizedPath);
                    pluginInstance.data = Object.assign({}, pluginInstance.data, JSON.parse(text));
                  } catch {}
                  if (typeof pluginInstance.loadIconFolderData === 'function') {
                    await pluginInstance.loadIconFolderData();
                  }
                  if (typeof pluginInstance.handleChangeLayout === 'function') {
                    pluginInstance.handleChangeLayout();
                  }
                  this.app.workspace.trigger('layout-change');
                }

                // Minimal Theme Settings
                if (pluginId === 'obsidian-minimal-settings') {
                  try {
                    const text = await this.app.vault.adapter.read(normalizedPath);
                    pluginInstance.settings = Object.assign({}, pluginInstance.settings, JSON.parse(text));
                  } catch {}
                  if (typeof pluginInstance.refresh === 'function') pluginInstance.refresh();
                  if (typeof pluginInstance.updateDarkScheme === 'function') pluginInstance.updateDarkScheme();
                  if (typeof pluginInstance.updateLightScheme === 'function') pluginInstance.updateLightScheme();
                  if (typeof pluginInstance.updateDarkStyle === 'function') pluginInstance.updateDarkStyle();
                  if (typeof pluginInstance.updateLightStyle === 'function') pluginInstance.updateLightStyle();
                  this.app.workspace.trigger('css-change');
                }

                // Style Settings
                if (pluginInstance.settingsManager) {
                  if (typeof pluginInstance.settingsManager.load === 'function') {
                    await pluginInstance.settingsManager.load();
                  }
                  if (typeof pluginInstance.settingsManager.initClasses === 'function') {
                    pluginInstance.settingsManager.initClasses();
                  }
                  if (typeof pluginInstance.settingsManager.setCSSVariables === 'function') {
                    pluginInstance.settingsManager.setCSSVariables();
                  }
                  this.app.workspace.trigger('css-change');
                }

                // Generic plugin settings re-read
                if (typeof pluginInstance.loadData === 'function' && typeof pluginInstance.settings === 'object') {
                  pluginInstance.settings = Object.assign({}, pluginInstance.settings, await pluginInstance.loadData());
                }
                if (typeof pluginInstance.refresh === 'function') pluginInstance.refresh();
                if (typeof pluginInstance.updateStyles === 'function') pluginInstance.updateStyles();
                if (typeof pluginInstance.applySettings === 'function') pluginInstance.applySettings();
              }
            }

            // Always trigger CSS change for style plugins (Minimal, Style Settings, etc.)
            this.app.workspace.trigger('css-change');
            this.app.workspace.trigger('layout-change');

            // Refresh file explorer views so icon changes render immediately
            const leaves = this.app.workspace.getLeavesOfType('file-explorer');
            for (const leaf of leaves) {
              const view = leaf.view as any;
              if (view) {
                if (typeof view.requestSort === 'function') view.requestSort();
                if (typeof view.render === 'function') view.render();
                if (view.tree?.render) view.tree.render();
              }
            }
          }, 350);

          this.reloadTimers.set(pluginId, timer);
        }
      } else if (normalizedPath.includes('community-plugins.json')) {
        const plugins = (this.app as any).plugins;
        if (plugins && typeof plugins.loadManifests === 'function') {
          plugins.loadManifests();
        }
      }
    } catch (err) {
      console.warn('[SyncClient] Error in hot-reload:', err);
    }
  }

  private async applyRemoteFileDelete(event: FileDeleteEvent): Promise<void> {
    const adapter = this.app.vault.adapter;
    const normalizedPath = event.path.replace(/\\/g, '/');

    this.plugin.vaultWatcher.suppressPath(normalizedPath, 4000);
    this.plugin.conflictHandler.removeBaseSnapshot(normalizedPath);

    if (await adapter.exists(normalizedPath)) {
      await adapter.trashLocal(normalizedPath);
      this.logActivity('delete', normalizedPath, 'Deleted file (moved to local trash)');
    }
  }

  private async applyRemoteFileRename(event: FileRenameEvent): Promise<void> {
    const adapter = this.app.vault.adapter;
    const oldNorm = event.oldPath.replace(/\\/g, '/');
    const newNorm = event.newPath.replace(/\\/g, '/');

    this.plugin.vaultWatcher.suppressPath(oldNorm, 4000);
    this.plugin.vaultWatcher.suppressPath(newNorm, 4000);

    if (await adapter.exists(oldNorm)) {
      await this.ensureParentFolder(newNorm);
      await adapter.rename(oldNorm, newNorm);
      this.logActivity('download', newNorm, `Renamed from ${oldNorm}`);
    }
  }

  private async ensureParentFolder(filePath: string): Promise<void> {
    const parts = filePath.split('/');
    if (parts.length <= 1) return;

    parts.pop(); // remove file name
    const folderPath = parts.join('/');
    const adapter = this.app.vault.adapter;

    if (!(await adapter.exists(folderPath))) {
      await adapter.mkdir(folderPath);
    }
  }

  /**
   * Called by VaultWatcher when a local file change happens in Obsidian
   */
  public async onLocalSyncEvent(event: SyncEvent, inlineContent?: string): Promise<void> {
    if (this.status !== 'synced' && this.status !== 'syncing' && this.status !== 'reconciling') {
      // Offline: enqueue in persistent offline queue
      await this.plugin.offlineQueue.enqueue(event);
      this.logActivity('upload', 'path' in event ? event.path : '', 'Queued for sync (offline)');
      return;
    }

    this.setStatus('syncing');

    try {
      if (event.type === 'create' || event.type === 'modify') {
        const contentToSend = inlineContent !== undefined ? inlineContent : (event.content || '');

        const putMsg: FilePutRequestMessage = {
          id: `put-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          type: 'FILE_PUT_REQUEST',
          timestamp: Date.now(),
          path: event.path,
          content: contentToSend,
          isBinary: event.isBinary,
          mtime: event.mtime,
          hash: event.hash,
          baseHash: event.baseHash
        };

        const resp = await this.request<FilePutResponseMessage>(putMsg);

        if (resp.conflictOccurred) {
          this.logActivity('conflict', event.path, `Server collision: conflict saved as ${resp.conflictPath}`);
          new Notice(`⚠️ Server Conflict on ${event.path}. Backup saved as ${resp.conflictPath}`);
        } else {
          this.logActivity('upload', event.path, `Uploaded ${event.type}`);
        }
      } else {
        const syncMsg: SyncEventMessage = {
          id: `evt-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          type: 'SYNC_EVENT',
          timestamp: Date.now(),
          event
        };
        const ack = await this.request<SyncEventAckMessage>(syncMsg);
        if (ack.success) {
          this.logActivity('upload', 'path' in event ? event.path : '', `Synced ${event.type}`);
        }
      }
    } catch (err) {
      console.error('[SyncClient] Error sending local sync event:', err);
      await this.plugin.offlineQueue.enqueue(event);
    } finally {
      this.setStatus('synced');
    }
  }

  /**
   * Performs complete vault reconciliation with VPS server manifest
   */
  public async reconcileVault(): Promise<void> {
    if (this.isReconciling) return;
    this.isReconciling = true;
    this.setStatus('reconciling');

    try {
      this.logActivity('info', '', 'Building local vault manifest...');
      const localManifest = await this.buildLocalManifest();

      this.logActivity('info', '', 'Requesting manifest diff from server...');
      const diffResp = await this.request<ManifestDiffResponseMessage>({
        id: `diff-${Date.now()}`,
        type: 'MANIFEST_DIFF_REQUEST',
        timestamp: Date.now(),
        clientManifest: localManifest
      });

      const { diff, serverManifest } = diffResp;
      this.logActivity('info', '', `Diff summary: ${diff.toDownload.length} to download, ${diff.toUpload.length} to upload`);

      // 1. Process Downloads (Server -> Client)
      for (const p of diff.toDownload) {
        const serverMeta = serverManifest[p];
        if (!serverMeta) continue;

        try {
          const getResp = await this.request<FileGetResponseMessage>({
            id: `get-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            type: 'FILE_GET_REQUEST',
            timestamp: Date.now(),
            path: p
          });

          if (getResp.exists && getResp.content !== undefined) {
            await this.applyRemoteFileWrite({
              id: `rec-${Date.now()}`,
              clientId: 'server',
              timestamp: Date.now(),
              type: 'modify',
              path: p,
              hash: getResp.metadata?.hash || serverMeta.hash,
              mtime: getResp.metadata?.mtime || serverMeta.mtime,
              size: getResp.metadata?.size || serverMeta.size,
              isBinary: getResp.isBinary || false,
              content: getResp.content
            });
          }
        } catch (err) {
          console.error(`[SyncClient] Failed to download ${p}:`, err);
        }
      }

      // 2. Process Uploads (Client -> Server)
      const adapter = this.app.vault.adapter;
      for (const p of diff.toUpload) {
        try {
          if (await adapter.exists(p)) {
            const isBin = isBinaryFile(p);
            let contentStr = '';
            let hash = '';

            if (isBin) {
              const buf = await adapter.readBinary(p);
              hash = hashBuffer(buf);
              contentStr = Buffer.from(buf).toString('base64');
            } else {
              contentStr = await adapter.read(p);
              hash = hashString(contentStr);
            }

            const stat = await adapter.stat(p);

            await this.request<FilePutResponseMessage>({
              id: `put-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
              type: 'FILE_PUT_REQUEST',
              timestamp: Date.now(),
              path: p,
              content: contentStr,
              isBinary: isBin,
              mtime: stat?.mtime || Date.now(),
              hash
            });

            this.logActivity('upload', p, 'Reconciliation: Uploaded to server');
          }
        } catch (err) {
          console.error(`[SyncClient] Failed to upload ${p}:`, err);
        }
      }

      // 3. Flush any queued offline events
      while (this.plugin.offlineQueue.size() > 0) {
        const evt = await this.plugin.offlineQueue.dequeue();
        if (evt) {
          await this.onLocalSyncEvent(evt);
        }
      }

      this.plugin.settings.lastSyncedTimestamp = Date.now();
      await this.plugin.saveSettings();

      this.logActivity('info', '', 'Reconciliation complete! Vault is in sync.');
      this.setStatus('synced');
    } catch (err) {
      console.error('[SyncClient] Error during reconciliation:', err);
      this.logActivity('error', '', `Reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
      this.setStatus('error', 'Reconciliation failed');
    } finally {
      this.isReconciling = false;
    }
  }

  public async buildLocalManifest(): Promise<VaultManifest> {
    const manifest: VaultManifest = {};
    const adapter = this.app.vault.adapter;

    const scanDir = async (dir: string) => {
      const listing = await adapter.list(dir);

      for (const filePath of listing.files) {
        const normalized = filePath.replace(/\\/g, '/');
        if (this.plugin.ignoreFilter.isIgnored(normalized)) continue;

        try {
          const isBin = isBinaryFile(normalized);
          let hash = '';
          if (isBin) {
            const buf = await adapter.readBinary(normalized);
            hash = hashBuffer(buf);
          } else {
            const text = await adapter.read(normalized);
            hash = hashString(text);
          }

          const stat = await adapter.stat(normalized);
          manifest[normalized] = {
            path: normalized,
            hash,
            mtime: stat?.mtime || Date.now(),
            size: stat?.size || 0,
            isBinary: isBin
          };
        } catch {
          // ignore transient read lock
        }
      }

      for (const subDir of listing.folders) {
        const normalizedFolder = subDir.replace(/\\/g, '/');
        if (!this.plugin.ignoreFilter.isIgnored(normalizedFolder)) {
          await scanDir(subDir);
        }
      }
    };

    await scanDir('');
    if (this.plugin.settings.syncObsidianConfig) {
      await scanDir(this.app.vault.configDir || '.obsidian');
    }
    return manifest;
  }
}
