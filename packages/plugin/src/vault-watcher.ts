import { App, EventRef, TAbstractFile, TFile, TFolder } from 'obsidian';
import {
  FileCreateOrModifyEvent,
  FileDeleteEvent,
  FileRenameEvent,
  hashBuffer,
  hashString,
  IgnoreFilter,
  isBinaryFile,
  SyncEvent
} from '@vps-vault-sync/shared';
import type VPSVaultSyncPlugin from './main';

export class VaultWatcher {
  private app: App;
  private plugin: VPSVaultSyncPlugin;
  private ignoreFilter: IgnoreFilter;
  private eventRefs: EventRef[] = [];
  private debounceTimers = new Map<string, number>();
  private localSuppressions = new Map<string, number>(); // path -> expiresAt
  private obsidianConfigHashes = new Map<string, string>(); // path -> last hash for .obsidian files
  private initialConfigScanned = false;
  private configPollInterval: number | null = null;

  public recordConfigHash(path: string, hash: string): void {
    this.obsidianConfigHashes.set(path.replace(/\\/g, '/'), hash);
  }

  constructor(app: App, plugin: VPSVaultSyncPlugin, ignoreFilter: IgnoreFilter) {
    this.app = app;
    this.plugin = plugin;
    this.ignoreFilter = ignoreFilter;
  }

  public start(): void {
    // 1. Hook normal Obsidian Vault events
    this.eventRefs.push(
      this.app.vault.on('create', (file) => this.handleVaultCreate(file)),
      this.app.vault.on('modify', (file) => this.handleVaultModify(file)),
      this.app.vault.on('delete', (file) => this.handleVaultDelete(file)),
      this.app.vault.on('rename', (file, oldPath) => this.handleVaultRename(file, oldPath))
    );

    // 2. Start .obsidian/ configuration poller (if enabled)
    if (this.plugin.settings.syncObsidianConfig) {
      this.startObsidianConfigPoller();
    }
  }

  public stop(): void {
    for (const ref of this.eventRefs) {
      this.app.vault.offref(ref);
    }
    this.eventRefs = [];

    for (const timer of this.debounceTimers.values()) {
      window.clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.configPollInterval !== null) {
      window.clearInterval(this.configPollInterval);
      this.configPollInterval = null;
    }
  }

  /**
   * Temporarily suppresses change detection for a path when written by sync client
   */
  public suppressPath(path: string, durationMs = 3000): void {
    const normalized = path.replace(/\\/g, '/');
    this.localSuppressions.set(normalized, Date.now() + durationMs);
  }

  private isSuppressed(path: string): boolean {
    const normalized = path.replace(/\\/g, '/');
    const expiresAt = this.localSuppressions.get(normalized);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
      this.localSuppressions.delete(normalized);
      return false;
    }
    return true;
  }

  private async handleVaultCreate(file: TAbstractFile): Promise<void> {
    if (file instanceof TFolder) return;
    if (this.isSuppressed(file.path) || this.ignoreFilter.isIgnored(file.path)) return;

    await this.scheduleFileChange('create', file.path);
  }

  private async handleVaultModify(file: TAbstractFile): Promise<void> {
    if (file instanceof TFolder) return;
    if (this.isSuppressed(file.path) || this.ignoreFilter.isIgnored(file.path)) return;

    await this.scheduleFileChange('modify', file.path);
  }

  private async handleVaultDelete(file: TAbstractFile): Promise<void> {
    if (file instanceof TFolder) return;
    if (this.isSuppressed(file.path) || this.ignoreFilter.isIgnored(file.path)) return;

    const event: FileDeleteEvent = {
      id: `cli-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      clientId: this.plugin.settings.clientId,
      timestamp: Date.now(),
      type: 'delete',
      path: file.path
    };

    await this.plugin.syncClient.onLocalSyncEvent(event);
  }

  private async handleVaultRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (file instanceof TFolder) return;
    if (this.isSuppressed(file.path) || this.isSuppressed(oldPath)) return;
    if (this.ignoreFilter.isIgnored(file.path) && this.ignoreFilter.isIgnored(oldPath)) return;

    const isBin = isBinaryFile(file.path);
    let hash = '';
    let mtime = Date.now();

    if (file instanceof TFile) {
      mtime = file.stat.mtime;
      if (isBin) {
        const buf = await this.app.vault.readBinary(file);
        hash = hashBuffer(buf);
      } else {
        const text = await this.app.vault.read(file);
        hash = hashString(text);
      }
    }

    const event: FileRenameEvent = {
      id: `cli-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      clientId: this.plugin.settings.clientId,
      timestamp: Date.now(),
      type: 'rename',
      oldPath,
      newPath: file.path,
      hash,
      mtime
    };

    await this.plugin.syncClient.onLocalSyncEvent(event);
  }

  private async scheduleFileChange(type: 'create' | 'modify', path: string): Promise<void> {
    if (this.debounceTimers.has(path)) {
      window.clearTimeout(this.debounceTimers.get(path)!);
    }

    const timer = window.setTimeout(async () => {
      this.debounceTimers.delete(path);
      try {
        if (this.isSuppressed(path)) return;

        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file || !(file instanceof TFile)) return;

        const isBin = isBinaryFile(path);
        let content: string;
        let hash: string;

        if (isBin) {
          const buf = await this.app.vault.readBinary(file);
          content = Buffer.from(buf).toString('base64');
          hash = hashBuffer(buf);
        } else {
          content = await this.app.vault.read(file);
          hash = hashString(content);
        }

        const baseHash = this.plugin.conflictHandler.getBaseSnapshot(path);

        const event: FileCreateOrModifyEvent = {
          id: `cli-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          clientId: this.plugin.settings.clientId,
          timestamp: Date.now(),
          type,
          path,
          hash,
          mtime: file.stat.mtime,
          size: file.stat.size,
          isBinary: isBin,
          baseHash: baseHash ? hashString(baseHash) : undefined,
          content: content.length < 500 * 1024 ? content : undefined,
          chunked: content.length >= 500 * 1024
        };

        // Update base snapshot
        if (!isBin) {
          this.plugin.conflictHandler.recordBaseSnapshot(path, content);
        }

        await this.plugin.syncClient.onLocalSyncEvent(event, content);
      } catch (err) {
        console.error(`[VaultWatcher] Failed to process change on ${path}:`, err);
      }
    }, this.plugin.settings.debounceMs);

    this.debounceTimers.set(path, timer);
  }

  /**
   * Scans .obsidian configuration folder periodically using vault adapter
   */
  private startObsidianConfigPoller(): void {
    if (this.configPollInterval !== null) return;

    // Scan every 2.5 seconds for plugin/theme/setting updates
    this.configPollInterval = window.setInterval(async () => {
      await this.scanObsidianConfigFolder();
    }, 2500);

    // Initial scan
    this.scanObsidianConfigFolder();
  }

  public async scanObsidianConfigFolder(): Promise<void> {
    if (!this.plugin.settings.syncObsidianConfig) return;

    try {
      const adapter = this.app.vault.adapter;
      const configDir = this.app.vault.configDir || '.obsidian';
      const seenConfigPaths = new Set<string>();

      const scanSubDir = async (dir: string) => {
        const listing = await adapter.list(dir);

        for (const filePath of listing.files) {
          const normalized = filePath.replace(/\\/g, '/');
          if (this.ignoreFilter.isIgnored(normalized)) continue;
          if (this.isSuppressed(normalized)) continue;

          seenConfigPaths.add(normalized);

          try {
            const isBin = isBinaryFile(normalized);
            let contentStr: string;
            let currentHash: string;

            if (isBin) {
              const buf = await adapter.readBinary(normalized);
              currentHash = hashBuffer(buf);
              contentStr = Buffer.from(buf).toString('base64');
            } else {
              contentStr = await adapter.read(normalized);
              currentHash = hashString(contentStr);
            }

            const previousHash = this.obsidianConfigHashes.get(normalized);
            if (previousHash !== undefined && previousHash !== currentHash) {
              // File changed in .obsidian!
              this.obsidianConfigHashes.set(normalized, currentHash);

              const stat = await adapter.stat(normalized);
              const event: FileCreateOrModifyEvent = {
                id: `cli-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
                clientId: this.plugin.settings.clientId,
                timestamp: Date.now(),
                type: 'modify',
                path: normalized,
                hash: currentHash,
                mtime: stat?.mtime || Date.now(),
                size: stat?.size || contentStr.length,
                isBinary: isBin,
                content: contentStr
              };

              await this.plugin.syncClient.onLocalSyncEvent(event, contentStr);
            } else if (previousHash === undefined) {
              this.obsidianConfigHashes.set(normalized, currentHash);

              if (this.initialConfigScanned) {
                // New theme, plugin, or snippet created after startup!
                const stat = await adapter.stat(normalized);
                const event: FileCreateOrModifyEvent = {
                  id: `cli-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
                  clientId: this.plugin.settings.clientId,
                  timestamp: Date.now(),
                  type: 'create',
                  path: normalized,
                  hash: currentHash,
                  mtime: stat?.mtime || Date.now(),
                  size: stat?.size || contentStr.length,
                  isBinary: isBin,
                  content: contentStr
                };

                await this.plugin.syncClient.onLocalSyncEvent(event, contentStr);
              }
            }
          } catch {
            // ignore temporary read locks
          }
        }

        for (const subDir of listing.folders) {
          const normalizedFolder = subDir.replace(/\\/g, '/');
          if (!this.ignoreFilter.isIgnored(normalizedFolder)) {
            await scanSubDir(subDir);
          }
        }
      };

      await scanSubDir(configDir);

      // Check for deleted config files
      if (this.initialConfigScanned) {
        for (const [trackedPath] of this.obsidianConfigHashes.entries()) {
          if (!seenConfigPaths.has(trackedPath) && !this.isSuppressed(trackedPath)) {
            this.obsidianConfigHashes.delete(trackedPath);
            const deleteEvent: FileDeleteEvent = {
              id: `cli-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
              clientId: this.plugin.settings.clientId,
              timestamp: Date.now(),
              type: 'delete',
              path: trackedPath
            };
            await this.plugin.syncClient.onLocalSyncEvent(deleteEvent);
          }
        }
      }

      this.initialConfigScanned = true;
    } catch (err) {
      console.error('[VaultWatcher] Error scanning .obsidian folder:', err);
    }
  }
}
