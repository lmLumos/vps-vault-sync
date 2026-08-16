import crypto from 'crypto';
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

export interface Tombstone {
  path: string;
  deletedAt: number;
  clientId?: string;
}

export class VaultManager {
  private vaultPath: string;
  private archiveManager: ArchiveManager;
  private echoFilter: EchoFilter;
  private ignoreFilter: IgnoreFilter;
  private lockQueue = new Map<string, Promise<void>>();
  private tombstones = new Map<string, Tombstone>();
  private tombstonesFile: string;

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
    this.tombstonesFile = path.join(this.archiveManager.getArchiveDir(), 'tombstones.json');

    this.ensureVaultDirectory();
    this.loadTombstones();
  }

  private ensureVaultDirectory(): void {
    if (!fs.existsSync(this.vaultPath)) {
      fs.mkdirSync(this.vaultPath, { recursive: true });
    }
  }

  private async loadTombstones(): Promise<void> {
    try {
      if (fs.existsSync(this.tombstonesFile)) {
        const data = await fs.promises.readFile(this.tombstonesFile, 'utf8');
        const list = JSON.parse(data) as Tombstone[];
        for (const t of list) {
          if (t && t.path && typeof t.deletedAt === 'number') {
            this.tombstones.set(t.path, t);
          }
        }
      }
    } catch (err) {
      console.error('[VaultManager] Failed to load tombstones:', err);
    }
  }

  private async saveTombstones(): Promise<void> {
    try {
      const dir = path.dirname(this.tombstonesFile);
      if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
      }
      const list = Array.from(this.tombstones.values());
      await fs.promises.writeFile(this.tombstonesFile, JSON.stringify(list, null, 2), 'utf8');
    } catch (err) {
      console.error('[VaultManager] Failed to save tombstones:', err);
    }
  }

  /**
   * Records a tombstone for a deleted file.
   */
  public async recordTombstone(relativePath: string, deletedAt = Date.now(), clientId = 'server'): Promise<void> {
    this.tombstones.set(relativePath, {
      path: relativePath,
      deletedAt,
      clientId
    });
    await this.saveTombstones();
  }

  /**
   * Removes a tombstone when a file is created or overwritten.
   */
  public async removeTombstone(relativePath: string): Promise<void> {
    if (this.tombstones.has(relativePath)) {
      this.tombstones.delete(relativePath);
      await this.saveTombstones();
    }
  }

  /**
   * Gets a tombstone record for a path.
   */
  public getTombstone(relativePath: string): Tombstone | undefined {
    return this.tombstones.get(relativePath);
  }

  /**
   * Returns a copy of all active tombstones.
   */
  public getTombstones(): Map<string, Tombstone> {
    return new Map(this.tombstones);
  }

  /**
   * Purges tombstones older than maxAgeMs.
   */
  public async purgeOldTombstones(maxAgeMs = 30 * 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    let purged = 0;
    for (const [p, t] of this.tombstones.entries()) {
      if (t.deletedAt < cutoff) {
        this.tombstones.delete(p);
        purged++;
      }
    }
    if (purged > 0) {
      await this.saveTombstones();
    }
    return purged;
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

    // Normalize Windows backslashes to forward slashes for cross-platform containment checks
    const normalized = relativePath.replace(/\\/g, '/');

    // Check for URI-encoded traversal attempts (e.g. %2e%2e)
    try {
      const decoded = decodeURIComponent(normalized);
      if (decoded !== normalized) {
        const decodedNormalized = decoded.replace(/\\/g, '/');
        const decodedResolved = path.resolve(this.vaultPath, decodedNormalized);
        const rootWithSep = this.vaultPath.endsWith(path.sep) ? this.vaultPath : this.vaultPath + path.sep;
        const isDecodedContained = process.platform === 'win32'
          ? (decodedResolved.toLowerCase() === this.vaultPath.toLowerCase() || decodedResolved.toLowerCase().startsWith(rootWithSep.toLowerCase()))
          : (decodedResolved === this.vaultPath || decodedResolved.startsWith(rootWithSep));
        if (!isDecodedContained || (process.platform !== 'win32' && /^[a-zA-Z]:/.test(decodedNormalized))) {
          throw new Error('Security Error: Directory traversal attempt blocked');
        }
      }
    } catch (err: any) {
      if (err.message && err.message.includes('Security Error')) {
        throw err;
      }
    }

    // Explicit check for Windows drive paths on non-Windows platforms
    if (process.platform !== 'win32' && /^[a-zA-Z]:/.test(normalized)) {
      throw new Error('Security Error: Directory traversal attempt blocked');
    }

    const resolved = path.resolve(this.vaultPath, normalized);
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
   * Computes SHA-256 hash using streams to avoid memory spikes on large files.
   */
  public async computeFileHash(fullFilePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const rs = fs.createReadStream(fullFilePath);
      rs.on('data', chunk => hash.update(chunk));
      rs.on('end', () => resolve(hash.digest('hex')));
      rs.on('error', err => reject(err));
    });
  }

  /**
   * Retrieves metadata for a file in the vault safely.
   */
  public async getMetadata(relativePath: string): Promise<FileMetadata | null> {
    const fullPath = this.getAbsolutePath(relativePath);
    if (!fs.existsSync(fullPath)) return null;

    const stat = await fs.promises.stat(fullPath);
    const isBin = isBinaryFile(relativePath);
    const hash = await this.computeFileHash(fullPath);

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
            const hash = await this.computeFileHash(fullPath);

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
   * Compares client manifest with server manifest to calculate needed synchronization diffs,
   * including tombstone-aware deletion resolution.
   */
  public computeDiff(clientManifest: VaultManifest, serverManifest: VaultManifest): ManifestDiff {
    const toUpload: string[] = [];
    const toDownload: string[] = [];
    const conflicts: string[] = [];
    const toDeleteOnServer: string[] = [];
    const toDeleteOnClient: string[] = [];

    const allPaths = new Set([
      ...Object.keys(clientManifest),
      ...Object.keys(serverManifest),
      ...this.tombstones.keys()
    ]);

    for (const p of allPaths) {
      if (this.ignoreFilter.isIgnored(p)) continue;

      const clientMeta = clientManifest[p];
      const serverMeta = serverManifest[p];
      const tombstone = this.tombstones.get(p);

      // Case A: Client explicitly marks as deleted
      if (clientMeta?.isDeleted) {
        if (serverMeta && !serverMeta.isDeleted) {
          if (clientMeta.mtime >= serverMeta.mtime) {
            toDeleteOnServer.push(p);
          } else {
            toDownload.push(p);
          }
        }
        continue;
      }

      // Case B: Server explicitly marks as deleted in manifest
      if (serverMeta?.isDeleted) {
        if (clientMeta && !clientMeta.isDeleted) {
          if (serverMeta.mtime >= clientMeta.mtime) {
            toDeleteOnClient.push(p);
          } else {
            toUpload.push(p);
          }
        }
        continue;
      }

      // Case C: Exists on server, missing on client
      if (!clientMeta && serverMeta) {
        if (tombstone && tombstone.deletedAt >= serverMeta.mtime) {
          toDeleteOnServer.push(p);
        } else {
          toDownload.push(p);
        }
      }

      // Case D: Exists on client, missing on server
      else if (clientMeta && !serverMeta) {
        if (tombstone && tombstone.deletedAt >= clientMeta.mtime) {
          toDeleteOnClient.push(p);
        } else {
          toUpload.push(p);
        }
      }

      // Case E: Exists on both sides (neither deleted)
      else if (clientMeta && serverMeta) {
        if (clientMeta.hash !== serverMeta.hash) {
          if (clientMeta.mtime > serverMeta.mtime) {
            toUpload.push(p);
          } else if (serverMeta.mtime > clientMeta.mtime) {
            toDownload.push(p);
          } else {
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

          // Retrieve common ancestor base from archive
          const baseText = (await this.archiveManager.getArchivedVersion(relativePath, baseHash)) || '';

          // Attempt 3-way merge
          const mergeResult = threeWayMerge(baseText, existingText, incomingText, relativePath);

          if (!mergeResult.hasConflict) {
            finalContentBuf = Buffer.from(mergeResult.mergedText, 'utf8');
            // Archive previous version before overwriting with merged content
            await this.archiveManager.archiveVersion(fullPath, relativePath);
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

      // Atomic write using temp file (ends with .tmp and matches ignore filter)
      const tmpPath = `${fullPath}.${Date.now()}.tmp`;
      await fs.promises.writeFile(tmpPath, finalContentBuf);
      await fs.promises.rename(tmpPath, fullPath);

      // Set mtime
      if (mtime > 0) {
        const date = new Date(mtime);
        await fs.promises.utimes(fullPath, date, date).catch(() => {});
      }

      const stat = await fs.promises.stat(fullPath);

      // Remove any existing tombstone when file is written
      await this.removeTombstone(relativePath);

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
   * Deletes a file from the vault, archiving it to trash first and recording a tombstone.
   */
  public async deleteFile(relativePath: string, clientId: string): Promise<boolean> {
    const fullPath = this.getAbsolutePath(relativePath);
    if (!fs.existsSync(fullPath)) return false;

    return this.acquireLock(relativePath, async () => {
      await this.archiveManager.archiveTrash(fullPath, relativePath);
      await this.recordTombstone(relativePath, Date.now(), clientId);
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

        await this.recordTombstone(oldRelativePath, Date.now(), clientId);
        await this.removeTombstone(newRelativePath);

        this.echoFilter.recordRemoteWrite(oldRelativePath, '__RENAMED__', clientId);
        this.echoFilter.recordRemoteWrite(newRelativePath, '__RENAMED__', clientId);

        await fs.promises.rename(oldFullPath, newFullPath);
        return true;
      });
    });
  }
}
