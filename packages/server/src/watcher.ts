import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import EventEmitter from 'events';
import {
  FileCreateOrModifyEvent,
  FileDeleteEvent,
  hashBuffer,
  isBinaryFile,
  IgnoreFilter
} from '@vps-vault-sync/shared';
import { VaultManager } from './vault-manager';
import { EchoFilter } from './echo-filter';

export interface WatcherEvents {
  'change': (event: FileCreateOrModifyEvent | FileDeleteEvent) => void;
}

export class VaultWatcher extends EventEmitter {
  private vaultPath: string;
  private vaultManager: VaultManager;
  private echoFilter: EchoFilter;
  private ignoreFilter: IgnoreFilter;
  private watcher: chokidar.FSWatcher | null = null;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private debounceMs: number;

  constructor(
    vaultPath: string,
    vaultManager: VaultManager,
    echoFilter: EchoFilter,
    ignoreFilter: IgnoreFilter,
    debounceMs = 400
  ) {
    super();
    this.vaultPath = vaultPath;
    this.vaultManager = vaultManager;
    this.echoFilter = echoFilter;
    this.ignoreFilter = ignoreFilter;
    this.debounceMs = debounceMs;
  }

  public start(): void {
    if (this.watcher) return;

    this.watcher = chokidar.watch(this.vaultPath, {
      ignored: (filePath: string) => {
        const rel = this.vaultManager.getRelativePath(filePath);
        return Boolean(rel && this.ignoreFilter.isIgnored(rel));
      },
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100
      }
    });

    this.watcher
      .on('add', (filePath: string) => this.handleFileChange('create', filePath))
      .on('change', (filePath: string) => this.handleFileChange('modify', filePath))
      .on('unlink', (filePath: string) => this.handleFileDelete(filePath))
      .on('error', (error: Error) => {
        console.error('[VaultWatcher] Error in filesystem watcher:', error);
      });

    console.log(`[VaultWatcher] Watching vault directory: ${this.vaultPath}`);
  }

  public async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private handleFileChange(type: 'create' | 'modify', filePath: string): void {
    const relPath = this.vaultManager.getRelativePath(filePath);
    if (this.ignoreFilter.isIgnored(relPath)) return;

    if (this.debounceTimers.has(relPath)) {
      clearTimeout(this.debounceTimers.get(relPath)!);
    }

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(relPath);
      try {
        if (!fs.existsSync(filePath)) return;

        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) return;

        const isBin = isBinaryFile(relPath);
        const buf = await fs.promises.readFile(filePath);
        const hash = hashBuffer(buf);

        // Check echo filter
        const initiatingClientId = this.echoFilter.matchAndConsume(relPath, hash);
        if (initiatingClientId) {
          // This change was originated by a connected client, suppress local broadcast to that client
          return;
        }

        const inlineContent = stat.size < 500 * 1024 // 500KB inline limit
          ? (isBin ? buf.toString('base64') : buf.toString('utf8'))
          : undefined;

        const event: FileCreateOrModifyEvent = {
          id: `srv-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
          clientId: 'server',
          timestamp: Date.now(),
          type,
          path: relPath,
          hash,
          mtime: stat.mtimeMs,
          size: stat.size,
          isBinary: isBin,
          content: inlineContent,
          chunked: !inlineContent
        };

        this.emit('change', event);
      } catch (err) {
        console.error(`[VaultWatcher] Failed to process change on ${relPath}:`, err);
      }
    }, this.debounceMs);

    this.debounceTimers.set(relPath, timer);
  }

  private handleFileDelete(filePath: string): void {
    const relPath = this.vaultManager.getRelativePath(filePath);
    if (this.ignoreFilter.isIgnored(relPath)) return;

    const initiatingClientId = this.echoFilter.matchAndConsume(relPath);
    if (initiatingClientId) {
      return;
    }

    const event: FileDeleteEvent = {
      id: `srv-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      clientId: 'server',
      timestamp: Date.now(),
      type: 'delete',
      path: relPath
    };

    this.emit('change', event);
  }
}
