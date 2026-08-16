import fs from 'fs';
import path from 'path';
import { hashBuffer } from '@vps-vault-sync/shared';

export class ArchiveManager {
  private archiveDir: string;
  private retentionDays: number;
  private historyDir: string;
  private trashDir: string;

  constructor(archiveDir: string, retentionDays = 30) {
    this.archiveDir = archiveDir;
    this.retentionDays = retentionDays;
    this.historyDir = path.join(archiveDir, 'history');
    this.trashDir = path.join(archiveDir, 'trash');

    this.ensureDirectories();
  }

  public getArchiveDir(): string {
    return this.archiveDir;
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.archiveDir)) {
      fs.mkdirSync(this.archiveDir, { recursive: true });
    }
    if (!fs.existsSync(this.historyDir)) {
      fs.mkdirSync(this.historyDir, { recursive: true });
    }
    if (!fs.existsSync(this.trashDir)) {
      fs.mkdirSync(this.trashDir, { recursive: true });
    }
  }

  /**
   * Archives a file before it is modified.
   */
  public async archiveVersion(fullFilePath: string, relativePath: string): Promise<void> {
    try {
      if (!fs.existsSync(fullFilePath)) return;

      const stat = await fs.promises.stat(fullFilePath);
      if (!stat.isFile()) return;

      const fileBuf = await fs.promises.readFile(fullFilePath);
      const hash = hashBuffer(fileBuf);

      const timestamp = Date.now();
      const safeRelPath = relativePath.replace(/[/\\:]/g, '_');
      const targetPath = path.join(this.historyDir, `${safeRelPath}.${timestamp}.bak`);

      await fs.promises.writeFile(targetPath, fileBuf);

      // Also write metadata file
      const meta = {
        originalPath: relativePath,
        archivedAt: timestamp,
        size: stat.size,
        mtime: stat.mtimeMs,
        hash,
        type: 'history'
      };
      await fs.promises.writeFile(`${targetPath}.json`, JSON.stringify(meta, null, 2), 'utf8');
    } catch (err) {
      console.error(`[Archive] Failed to archive version of ${relativePath}:`, err);
    }
  }

  /**
   * Retrieves the content of an archived version by relativePath and optionally matching hash.
   */
  public async getArchivedVersion(relativePath: string, baseHash?: string): Promise<string | null> {
    try {
      if (!fs.existsSync(this.historyDir)) return null;

      const safeRelPath = relativePath.replace(/[/\\:]/g, '_');
      const prefix = `${safeRelPath}.`;
      const files = await fs.promises.readdir(this.historyDir);

      // Find all bak files for this relativePath
      const matching = files
        .filter(f => f.startsWith(prefix) && f.endsWith('.bak'))
        .sort((a, b) => {
          // Sort newest first by timestamp in filename: safeRelPath.timestamp.bak
          const tsA = parseInt(a.slice(prefix.length, -4), 10) || 0;
          const tsB = parseInt(b.slice(prefix.length, -4), 10) || 0;
          return tsB - tsA;
        });

      if (matching.length === 0) return null;

      if (baseHash) {
        // Try to find exact hash match
        for (const file of matching) {
          const bakPath = path.join(this.historyDir, file);
          const metaPath = `${bakPath}.json`;
          if (fs.existsSync(metaPath)) {
            try {
              const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
              if (meta.hash === baseHash) {
                return await fs.promises.readFile(bakPath, 'utf8');
              }
            } catch {
              // ignore json parse error
            }
          }
          // Fallback check: read file and compare hash
          const buf = await fs.promises.readFile(bakPath);
          if (hashBuffer(buf) === baseHash) {
            return buf.toString('utf8');
          }
        }
      }

      // If no exact hash match was found or no baseHash provided, return the most recent archived version
      const latestBakPath = path.join(this.historyDir, matching[0]);
      return await fs.promises.readFile(latestBakPath, 'utf8');
    } catch (err) {
      console.error(`[Archive] Failed to retrieve archived version for ${relativePath}:`, err);
      return null;
    }
  }

  /**
   * Archives a file when it is deleted.
   */
  public async archiveTrash(fullFilePath: string, relativePath: string): Promise<void> {
    try {
      if (!fs.existsSync(fullFilePath)) return;

      const stat = await fs.promises.stat(fullFilePath);
      if (!stat.isFile()) return;

      const timestamp = Date.now();
      const safeRelPath = relativePath.replace(/[/\\:]/g, '_');
      const targetPath = path.join(this.trashDir, `${safeRelPath}.${timestamp}.bak`);

      await fs.promises.copyFile(fullFilePath, targetPath);

      const meta = {
        originalPath: relativePath,
        deletedAt: timestamp,
        size: stat.size,
        mtime: stat.mtimeMs,
        type: 'trash'
      };
      await fs.promises.writeFile(`${targetPath}.json`, JSON.stringify(meta, null, 2), 'utf8');
    } catch (err) {
      console.error(`[Archive] Failed to archive deleted file ${relativePath}:`, err);
    }
  }

  /**
   * Prunes archived files older than the retention threshold.
   */
  public async pruneOldArchives(): Promise<number> {
    const cutoffMs = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    let prunedCount = 0;

    const pruneDir = async (dir: string) => {
      if (!fs.existsSync(dir)) return;
      const files = await fs.promises.readdir(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        try {
          const stat = await fs.promises.stat(filePath);
          if (stat.isFile() && stat.mtimeMs < cutoffMs) {
            await fs.promises.unlink(filePath);
            prunedCount++;
          }
        } catch {
          // ignore
        }
      }
    };

    await pruneDir(this.historyDir);
    await pruneDir(this.trashDir);

    return prunedCount;
  }
}
