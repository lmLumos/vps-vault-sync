import fs from 'fs';
import path from 'path';
import {
  FileMetadata,
  VaultManifest,
  ManifestDiff,
  hashBuffer,
  hashString,
  isBinaryFile,
  IgnoreFilter,
  threeWayMerge,
  generateConflictPath
} from '@vps-vault-sync/shared';
import { ArchiveManager } from './archive-manager';
import { EchoFilter } from './echo-filter';

export class VaultManager {
  private vaultPath: string;
  private archiveManager: ArchiveManager;
  private echoFilter: EchoFilter;
  private ignoreFilter: IgnoreFilter;
  private lockQueue = new Map<string, Promise<void>>();

  constructor(
    vaultPath: string,
    archiveManager: ArchiveManager,
    echoFilter: EchoFilter,
    ignoreFilter: IgnoreFilter
  ) {
    this.vaultPath = path.resolve(vaultPath);
    this.archiveManager = archiveManager;
    this.echoFilter = echoFilter;
    this.ignoreFilter = ignoreFilter;

    this.ensureVaultDirectory();
  }

  private ensureVaultDirectory(): void {
    if (!fs.existsSync(this.vaultPath)) {
      fs.mkdirSync(this.vaultPath, { recursive: true });
    }
  }

  /**
   * Safely resolves a relative path to an absolute path within the vault root.
   * Throws an error if directory traversal is attempted.
   */
  public getAbsolutePath(relativePath: string): string {
    if (typeof relativePath !== 'string') {
      throw new Error('Security Error: Invalid path');
    }

    if (relativePath.includes('\0')) {
      throw new Error('Security Error: Directory traversal attempt blocked');
    }

    // Check for URI-encoded traversal attempts (e.g. %2e%2e)
    try {
      const decoded = decodeURIComponent(relativePath);
      if (decoded !== relativePath) {
        const decodedResolved = path.resolve(this.vaultPath, decoded);
        const rootWithSep = this.vaultPath.endsWith(path.sep) ? this.vaultPath : this.vaultPath + path.sep;
        const isDecodedContained = process.platform === 'win32'
          ? (decodedResolved.toLowerCase() === this.vaultPath.toLowerCase() || decodedResolved.toLowerCase().startsWith(rootWithSep.toLowerCase()))
          : (decodedResolved === this.vaultPath || decodedResolved.startsWith(rootWithSep));
        if (!isDecodedContained) {
          throw new Error('Security Error: Directory traversal attempt blocked');
        }
      }
    } catch (err: any) {
      if (err.message && err.message.includes('Security Error')) {
        throw err;
      }
    }

    const resolved = path.resolve(this.vaultPath, relativePath);
    const rootWithSep = this.vaultPath.endsWith(path.sep) ? this.vaultPath : this.vaultPath + path.sep;

    const isContained = process.platform === 'win32'
      ? (resolved.toLowerCase() === this.vaultPath.toLowerCase() || resolved.toLowerCase().startsWith(rootWithSep.toLowerCase()))
      : (resolved === this.vaultPath || resolved.startsWith(rootWithSep));

    if (!isContained) {
      throw new Error('Security Error: Directory traversal attempt blocked');
    }

    return resolved;
  }

  public getRelativePath(absolutePath: string): string {
    const resolved = path.resolve(absolutePath);
    const rootWithSep = this.vaultPath.endsWith(path.sep) ? this.vaultPath : this.vaultPath + path.sep;
    const isContained = process.platform === 'win32'
      ? (resolved.toLowerCase() === this.vaultPath.toLowerCase() || resolved.toLowerCase().startsWith(rootWithSep.toLowerCase()))
      : (resolved === this.vaultPath || resolved.startsWith(rootWithSep));

    if (!isContained) {
      throw new Error('Security Error: Directory traversal attempt blocked');
    }

    const rel = path.relative(this.vaultPath, resolved);
    return rel.replace(/\\/g, '/');
  }

  /**
   * Retrieves metadata for a file in the vault safely.
   */
  public async getMetadata(relativePath: string): Promise<FileMetadata | null> {
    const fullPath = this.getAbsolutePath(relativePath);
    if (!fs.existsSync(fullPath)) return null;

    const stat = await fs.promises.stat(fullPath);
    const isBin = isBinaryFile(relativePath);
    const buf = await fs.promises.readFile(fullPath);
    const hash = hashBuffer(buf);

    return {
      path: relativePath,
      hash,
      mtime: stat.mtimeMs,
      size: stat.size,
      isBinary: isBin
    };
  }

  /**
   * Ensures that a directory within the vault exists safely.
   */
  public async ensureDirectory(relativePath: string): Promise<string> {
    const fullPath = this.getAbsolutePath(relativePath);
    if (!fs.existsSync(fullPath)) {
      await fs.promises.mkdir(fullPath, { recursive: true });
    }
    return fullPath;
  }

  private async acquireLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const currentLock = this.lockQueue.get(filePath) || Promise.resolve();
    let releaseLock: () => void;
    const newLock = new Promise<void>(resolve => {
      releaseLock = resolve;
    });

    this.lockQueue.set(filePath, currentLock.then(() => newLock));

    try {
      await currentLock;
      return await fn();
    } finally {
      releaseLock!();
      if (this.lockQueue.get(filePath) === newLock) {
        this.lockQueue.delete(filePath);
      }
    }
  }

  /**
   * Builds a full manifest of the current vault contents on disk.
   */
  public async buildManifest(): Promise<VaultManifest> {
    const manifest: VaultManifest = {};

    const scanDir = async (dir: string) => {
      if (!fs.existsSync(dir)) return;
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = this.getRelativePath(fullPath);

        if (this.ignoreFilter.isIgnored(relPath)) {
          continue;
        }

        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else if (entry.isFile()) {
          try {
            const stat = await fs.promises.stat(fullPath);
            const isBin = isBinaryFile(relPath);
            const content = await fs.promises.readFile(fullPath);
            const hash = hashBuffer(content);

            manifest[relPath] = {
              path: relPath,
              hash,
              mtime: stat.mtimeMs,
              size: stat.size,
              isBinary: isBin
            };
          } catch (err) {
            console.error(`[VaultManager] Failed to read ${relPath}:`, err);
          }
        }
      }
    };

    await scanDir(this.vaultPath);
    return manifest;
  }

  /**
   * Compares client manifest with server manifest to calculate needed synchronization diffs.
   */
  public computeDiff(clientManifest: VaultManifest, serverManifest: VaultManifest): ManifestDiff {
    const toUpload: string[] = [];
    const toDownload: string[] = [];
    const conflicts: string[] = [];
    const toDeleteOnServer: string[] = [];
    const toDeleteOnClient: string[] = [];

    const allPaths = new Set([
      ...Object.keys(clientManifest),
      ...Object.keys(serverManifest)
    ]);

    for (const p of allPaths) {
      if (this.ignoreFilter.isIgnored(p)) continue;

      const clientMeta = clientManifest[p];
      const serverMeta = serverManifest[p];

      if (!clientMeta && serverMeta) {
        // Exists on server, missing on client
        toDownload.push(p);
      } else if (clientMeta && !serverMeta) {
        // Exists on client, missing on server
        toUpload.push(p);
      } else if (clientMeta && serverMeta) {
        // Exists on both sides
        if (clientMeta.hash !== serverMeta.hash) {
          // Hashes differ
          if (clientMeta.mtime > serverMeta.mtime) {
            toUpload.push(p);
          } else if (serverMeta.mtime > clientMeta.mtime) {
            toDownload.push(p);
          } else {
            // Equal mtime but different content -> potential conflict
            conflicts.push(p);
          }
        }
      }
    }

    return {
      toUpload,
      toDownload,
      conflicts,
      toDeleteOnServer,
      toDeleteOnClient
    };
  }

  /**
   * Reads a file from the vault.
   */
  public async readFile(relativePath: string): Promise<{
    content: string;
    isBinary: boolean;
    metadata: FileMetadata;
  } | null> {
    const fullPath = this.getAbsolutePath(relativePath);
    if (!fs.existsSync(fullPath)) return null;

    return this.acquireLock(relativePath, async () => {
      const stat = await fs.promises.stat(fullPath);
      const isBin = isBinaryFile(relativePath);
      const buf = await fs.promises.readFile(fullPath);
      const hash = hashBuffer(buf);

      const content = isBin ? buf.toString('base64') : buf.toString('utf8');

      return {
        content,
        isBinary: isBin,
        metadata: {
          path: relativePath,
          hash,
          mtime: stat.mtimeMs,
          size: stat.size,
          isBinary: isBin
        }
      };
    });
  }

  /**
   * Writes a file to the vault with 3-way merge conflict detection and atomic disk write.
   */
  public async writeFile(
    relativePath: string,
    content: string,
    isBinary: boolean,
    mtime: number,
    clientId: string,
    baseHash?: string
  ): Promise<{
    metadata: FileMetadata;
    conflictOccurred?: boolean;
    conflictPath?: string;
  }> {
    const fullPath = this.getAbsolutePath(relativePath);
    const dir = path.dirname(fullPath);

    return this.acquireLock(relativePath, async () => {
      if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
      }

      let finalContentBuf: Buffer;
      let conflictOccurred = false;
      let conflictPath: string | undefined;

      const exists = fs.existsSync(fullPath);

      if (exists) {
        const existingBuf = await fs.promises.readFile(fullPath);
        const existingHash = hashBuffer(existingBuf);

        const isMarkdown = relativePath.endsWith('.md') || relativePath.endsWith('.txt');

        // Check if 3-way merge is needed
        if (!isBinary && isMarkdown && baseHash && existingHash !== baseHash) {
          // File was modified on server concurrently!
          const existingText = existingBuf.toString('utf8');
          const incomingText = isBinary ? Buffer.from(content, 'base64').toString('utf8') : content;

          // Attempt 3-way merge
          const mergeResult = threeWayMerge('', existingText, incomingText, relativePath);

          if (!mergeResult.hasConflict) {
            finalContentBuf = Buffer.from(mergeResult.mergedText, 'utf8');
          } else {
            // Collision! Save incoming as conflict file and preserve existing
            conflictOccurred = true;
            conflictPath = generateConflictPath(relativePath);
            const conflictFullPath = this.getAbsolutePath(conflictPath);

            await fs.promises.writeFile(conflictFullPath, incomingText, 'utf8');
            finalContentBuf = existingBuf; // Keep existing intact
          }
        } else {
          // Archive previous version
          await this.archiveManager.archiveVersion(fullPath, relativePath);
          finalContentBuf = isBinary ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
        }
      } else {
        finalContentBuf = isBinary ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
      }

      const finalHash = hashBuffer(finalContentBuf);

      // Register with echo filter so watcher won't echo back
      this.echoFilter.recordRemoteWrite(relativePath, finalHash, clientId);

      // Atomic write using temp file
      const tmpPath = `${fullPath}.tmp.${Date.now()}`;
      await fs.promises.writeFile(tmpPath, finalContentBuf);
      await fs.promises.rename(tmpPath, fullPath);

      // Set mtime
      if (mtime > 0) {
        const date = new Date(mtime);
        await fs.promises.utimes(fullPath, date, date).catch(() => {});
      }

      const stat = await fs.promises.stat(fullPath);

      return {
        metadata: {
          path: relativePath,
          hash: finalHash,
          mtime: stat.mtimeMs,
          size: stat.size,
          isBinary
        },
        conflictOccurred,
        conflictPath
      };
    });
  }

  /**
   * Deletes a file from the vault, archiving it to trash first.
   */
  public async deleteFile(relativePath: string, clientId: string): Promise<boolean> {
    const fullPath = this.getAbsolutePath(relativePath);
    if (!fs.existsSync(fullPath)) return false;

    return this.acquireLock(relativePath, async () => {
      await this.archiveManager.archiveTrash(fullPath, relativePath);
      this.echoFilter.recordRemoteWrite(relativePath, '__DELETED__', clientId);
      await fs.promises.unlink(fullPath);
      return true;
    });
  }

  /**
   * Renames/moves a file in the vault with strict path validation on both old and new paths.
   */
  public async renameFile(oldRelativePath: string, newRelativePath: string, clientId: string): Promise<boolean> {
    const oldFullPath = this.getAbsolutePath(oldRelativePath);
    const newFullPath = this.getAbsolutePath(newRelativePath);

    if (!fs.existsSync(oldFullPath)) return false;

    return this.acquireLock(oldRelativePath, async () => {
      return this.acquireLock(newRelativePath, async () => {
        if (!fs.existsSync(oldFullPath)) return false;

        const newDir = path.dirname(newFullPath);
        if (!fs.existsSync(newDir)) {
          await fs.promises.mkdir(newDir, { recursive: true });
        }

        this.echoFilter.recordRemoteWrite(oldRelativePath, '__RENAMED__', clientId);
        this.echoFilter.recordRemoteWrite(newRelativePath, '__RENAMED__', clientId);

        await fs.promises.rename(oldFullPath, newFullPath);
        return true;
      });
    });
  }
}
