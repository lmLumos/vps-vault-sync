import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

export interface ServerConfig {
  vaultPath: string;
  syncToken: string;
  port: number;
  host: string;
  archiveDir: string;
  archiveRetentionDays: number;
  maxFileSizeBytes: number;
  debounceMs: number;
  syncObsidianConfig: boolean;
  syncWorkspace: boolean;
}

export function loadConfig(): ServerConfig {
  const syncToken = process.env.SYNC_TOKEN || process.env.VAULT_SYNC_TOKEN || '';
  if (!syncToken || syncToken === 'default-secret-token-change-me') {
    if (process.env.NODE_ENV !== 'test') {
      console.error('\x1b[31m[FATAL] SYNC_TOKEN must be configured with a strong secret. Server refusing to start.\x1b[0m');
      process.exit(1);
    }
  }

  const rawVaultPath = process.env.VAULT_PATH || process.env.VAULT_DIR || path.resolve(process.cwd(), 'vault-data');
  const vaultPath = path.resolve(rawVaultPath);

  const archiveRetentionDays = parseInt(process.env.ARCHIVE_RETENTION_DAYS || '30', 10);
  const maxFileSizeMb = parseInt(process.env.MAX_FILE_SIZE_MB || '100', 10);
  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';
  const debounceMs = parseInt(process.env.DEBOUNCE_MS || '400', 10);

  const syncObsidianConfig = process.env.SYNC_OBSIDIAN_CONFIG !== 'false';
  const syncWorkspace = process.env.SYNC_WORKSPACE === 'true';

  const archiveDir = path.join(vaultPath, '.sync-archive');

  return {
    vaultPath,
    syncToken: syncToken || 'default-secret-token-change-me',
    port,
    host,
    archiveDir,
    archiveRetentionDays,
    maxFileSizeBytes: maxFileSizeMb * 1024 * 1024,
    debounceMs,
    syncObsidianConfig,
    syncWorkspace
  };
}
