import fs from 'fs';
import path from 'path';

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

      const timestamp = Date.now();
      const safeRelPath = relativePath.replace(/[/\\:]/g, '_');
      const targetPath = path.join(this.historyDir, `${safeRelPath}.${timestamp}.bak`);

      await fs.promises.copyFile(fullFilePath, targetPath);

      // Also write metadata file
      const meta = {
        originalPath: relativePath,
        archivedAt: timestamp,
        size: stat.size,
        mtime: stat.mtimeMs,
        type: 'history'
      };
      await fs.promises.writeFile(`${targetPath}.json`, JSON.stringify(meta, null, 2), 'utf8');
    } catch (err) {
      console.error(`[Archive] Failed to archive version of ${relativePath}:`, err);
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
