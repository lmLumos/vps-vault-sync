import { App, Notice, TFile } from 'obsidian';
import { generateConflictPath, threeWayMerge, MergeResult } from '@vps-vault-sync/shared';

export class ConflictHandler {
  private app: App;
  private baseSnapshots = new Map<string, string>(); // path -> content snapshot when last synced

  constructor(app: App) {
    this.app = app;
  }

  public recordBaseSnapshot(path: string, content: string): void {
    this.baseSnapshots.set(path, content);
  }

  public getBaseSnapshot(path: string): string {
    return this.baseSnapshots.get(path) || '';
  }

  public removeBaseSnapshot(path: string): void {
    this.baseSnapshots.delete(path);
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
