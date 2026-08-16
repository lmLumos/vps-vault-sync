import { App, Notice, TFile } from 'obsidian';
import { generateConflictPath, threeWayMerge, MergeResult } from '@vps-vault-sync/shared';

export class ConflictHandler {
  private app: App;
  private baseSnapshots = new Map<string, string>(); // path -> content snapshot when last synced
  private storagePath = '.obsidian/plugins/vps-vault-sync/snapshots.json';
  private saveTimeout: number | null = null;

  constructor(app: App) {
    this.app = app;
  }

  public async loadPersistedSnapshots(): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(this.storagePath)) {
        const raw = await adapter.read(this.storagePath);
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) {
          for (const [path, snapshot] of Object.entries(parsed)) {
            if (typeof snapshot === 'string') {
              this.baseSnapshots.set(path, snapshot);
            }
          }
        }
      }
    } catch (err) {
      console.warn('[ConflictHandler] Could not load persisted base snapshots:', err);
    }
  }

  public async savePersistedSnapshots(): Promise<void> {
    if (this.saveTimeout !== null) {
      window.clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = window.setTimeout(async () => {
      this.saveTimeout = null;
      try {
        const adapter = this.app.vault.adapter;
        const parentDir = this.storagePath.substring(0, this.storagePath.lastIndexOf('/'));
        if (parentDir && !(await adapter.exists(parentDir))) {
          await adapter.mkdir(parentDir);
        }
        const obj: Record<string, string> = {};
        for (const [p, content] of this.baseSnapshots.entries()) {
          obj[p] = content;
        }
        await adapter.write(this.storagePath, JSON.stringify(obj));
      } catch (err) {
        console.warn('[ConflictHandler] Could not persist base snapshots:', err);
      }
    }, 1000);
  }

  public recordBaseSnapshot(path: string, content: string): void {
    this.baseSnapshots.set(path, content);
    this.savePersistedSnapshots();
  }

  public getBaseSnapshot(path: string): string {
    return this.baseSnapshots.get(path) || '';
  }

  public removeBaseSnapshot(path: string): void {
    this.baseSnapshots.delete(path);
    this.savePersistedSnapshots();
  }

  /**
   * Resolves a potentially conflicting incoming file update.
   */
  public async resolveTextConflict(
    filePath: string,
    currentLocalText: string,
    incomingRemoteText: string
  ): Promise<{
    textToWrite: string;
    conflictOccurred: boolean;
    conflictFileCreated?: string;
  }> {
    // Only perform 3-way merge on Markdown notes and text files
    const isMarkdown = filePath.endsWith('.md') || filePath.endsWith('.txt');
    if (!isMarkdown || filePath.startsWith('.obsidian/') || filePath.endsWith('.json')) {
      return {
        textToWrite: incomingRemoteText,
        conflictOccurred: false
      };
    }

    // If identical or empty, accept immediately
    if (currentLocalText === incomingRemoteText || !currentLocalText) {
      this.recordBaseSnapshot(filePath, incomingRemoteText);
      return {
        textToWrite: incomingRemoteText,
        conflictOccurred: false
      };
    }

    const baseText = this.getBaseSnapshot(filePath);

    const mergeResult: MergeResult = threeWayMerge(
      baseText,
      currentLocalText,
      incomingRemoteText,
      filePath
    );

    if (!mergeResult.hasConflict) {
      // Auto-merged successfully!
      this.recordBaseSnapshot(filePath, mergeResult.mergedText);
      return {
        textToWrite: mergeResult.mergedText,
        conflictOccurred: false
      };
    }

    // Direct collision: generate conflict file
    const conflictPath = generateConflictPath(filePath);
    try {
      await this.app.vault.create(conflictPath, incomingRemoteText);
      new Notice(`⚠️ Sync Conflict on "${filePath}". Saved incoming copy as "${conflictPath}".`, 8000);
    } catch (err) {
      console.error(`[ConflictHandler] Failed to write conflict file ${conflictPath}:`, err);
    }

    // Keep local version intact and record it
    this.recordBaseSnapshot(filePath, currentLocalText);

    return {
      textToWrite: currentLocalText,
      conflictOccurred: true,
      conflictFileCreated: conflictPath
    };
  }
}
