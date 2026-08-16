import { loadConfig } from './config';
import { ArchiveManager } from './archive-manager';
import { EchoFilter } from './echo-filter';
import { VaultManager } from './vault-manager';
import { VaultWatcher } from './watcher';
import { SyncServer } from './server';
import { IgnoreFilter } from '@vps-vault-sync/shared';
import fs from 'fs';
import path from 'path';

async function main() {
  const config = loadConfig();

  // Read custom .syncignore if present in vault directory
  let customIgnore = '';
  const syncIgnorePath = path.join(config.vaultPath, '.syncignore');
  if (fs.existsSync(syncIgnorePath)) {
    try {
      customIgnore = fs.readFileSync(syncIgnorePath, 'utf8');
      console.log('[Main] Loaded custom .syncignore from vault root');
    } catch {
      // ignore
    }
  }

  const ignoreFilter = new IgnoreFilter(
    {
      syncObsidianConfig: config.syncObsidianConfig,
      syncWorkspace: config.syncWorkspace
    },
    customIgnore
  );

  const archiveManager = new ArchiveManager(config.archiveDir, config.archiveRetentionDays);
  const echoFilter = new EchoFilter(4000);
  const vaultManager = new VaultManager(config.vaultPath, archiveManager, echoFilter, ignoreFilter);
  const vaultWatcher = new VaultWatcher(config.vaultPath, vaultManager, echoFilter, ignoreFilter, config.debounceMs);
  const server = new SyncServer(config, vaultManager, vaultWatcher);

  // Start filesystem watcher
  vaultWatcher.start();

  // Start HTTP / WS Server
  await server.start();

  // Schedule daily archive cleanup
  setInterval(async () => {
    try {
      const pruned = await archiveManager.pruneOldArchives();
      if (pruned > 0) {
        console.log(`[Archive] Cleaned up ${pruned} expired archive snapshots`);
      }
    } catch (err) {
      console.error('[Archive] Pruning error:', err);
    }
  }, 24 * 60 * 60 * 1000).unref();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    console.log(`\n[Main] Received ${signal}, gracefully shutting down...`);
    await vaultWatcher.stop();
    await server.stop();
    console.log('[Main] Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('[Main] Fatal server error:', err);
  process.exit(1);
});
