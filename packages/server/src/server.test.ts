import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { WebSocket } from 'ws';
import {
  AuthRequestMessage,
  AuthResponseMessage,
  FileGetRequestMessage,
  FileGetResponseMessage,
  FilePutRequestMessage,
  FilePutResponseMessage,
  IgnoreFilter,
  PROTOCOL_VERSION,
  SyncEventMessage
} from '@vps-vault-sync/shared';
import { ArchiveManager } from './archive-manager';
import { EchoFilter } from './echo-filter';
import { VaultManager } from './vault-manager';
import { VaultWatcher } from './watcher';
import { SyncServer } from './server';
import { ServerConfig } from './config';

describe('VPS Sync Server Integration Tests', () => {
  const testDir = path.join(os.tmpdir(), `vps-sync-test-${Date.now()}`);
  const testPort = 39485;
  const testToken = 'super-secret-test-token-123';

  let config: ServerConfig;
  let archiveManager: ArchiveManager;
  let echoFilter: EchoFilter;
  let ignoreFilter: IgnoreFilter;
  let vaultManager: VaultManager;
  let vaultWatcher: VaultWatcher;
  let server: SyncServer;

  before(async () => {
    fs.mkdirSync(testDir, { recursive: true });

    config = {
      vaultPath: testDir,
      syncToken: testToken,
      port: testPort,
      host: '127.0.0.1',
      archiveDir: path.join(testDir, '.sync-archive'),
      archiveRetentionDays: 30,
      maxFileSizeBytes: 10 * 1024 * 1024,
      debounceMs: 150,
      syncObsidianConfig: true,
      syncWorkspace: false
    };

    archiveManager = new ArchiveManager(config.archiveDir, config.archiveRetentionDays);
    echoFilter = new EchoFilter(3000);
    ignoreFilter = new IgnoreFilter({ syncObsidianConfig: true, syncWorkspace: false });
    vaultManager = new VaultManager(config.vaultPath, archiveManager, echoFilter, ignoreFilter);
    vaultWatcher = new VaultWatcher(config.vaultPath, vaultManager, echoFilter, ignoreFilter, config.debounceMs);
    server = new SyncServer(config, vaultManager, vaultWatcher);

    vaultWatcher.start();
    await server.start();
  });

  after(async () => {
    await vaultWatcher.stop();
    await server.stop();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('should reject unauthenticated connections with invalid token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        const msg: AuthRequestMessage = {
          id: 'test-1',
          type: 'AUTH_REQUEST',
          timestamp: Date.now(),
          token: 'wrong-token',
          clientId: 'client-test',
          clientName: 'Test Client',
          protocolVersion: PROTOCOL_VERSION,
          deviceType: 'desktop'
        };
        ws.send(JSON.stringify(msg));
      });

      ws.on('message', (data) => {
        const resp = JSON.parse(data.toString()) as AuthResponseMessage;
        assert.strictEqual(resp.type, 'AUTH_RESPONSE');
        assert.strictEqual(resp.success, false);
        ws.close();
        resolve();
      });

      ws.on('error', reject);
    });
  });

  it('should authenticate client and write file to physical disk on VPS', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        const authMsg: AuthRequestMessage = {
          id: 'auth-req',
          type: 'AUTH_REQUEST',
          timestamp: Date.now(),
          token: testToken,
          clientId: 'client-test',
          clientName: 'Test Client',
          protocolVersion: PROTOCOL_VERSION,
          deviceType: 'desktop'
        };
        ws.send(JSON.stringify(authMsg));
      });

      ws.on('message', async (data) => {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'AUTH_RESPONSE') {
          assert.strictEqual(msg.success, true);

          // Now put a file
          const putMsg: FilePutRequestMessage = {
            id: 'put-1',
            type: 'FILE_PUT_REQUEST',
            timestamp: Date.now(),
            path: 'Folder/Welcome.md',
            content: '# Welcome to Obsidian Live Sync\nSyncing directly to VPS disk.',
            isBinary: false,
            mtime: Date.now(),
            hash: 'somehash'
          };
          ws.send(JSON.stringify(putMsg));
        }

        if (msg.type === 'FILE_PUT_RESPONSE') {
          assert.strictEqual(msg.success, true);
          assert.strictEqual(msg.path, 'Folder/Welcome.md');

          // Verify file exists physically on disk
          const physicalPath = path.join(testDir, 'Folder', 'Welcome.md');
          assert.ok(fs.existsSync(physicalPath), 'File should exist on disk');
          const diskContent = fs.readFileSync(physicalPath, 'utf8');
          assert.strictEqual(diskContent, '# Welcome to Obsidian Live Sync\nSyncing directly to VPS disk.');

          ws.close();
          resolve();
        }
      });

      ws.on('error', reject);
    });
  });

  it('should detect direct edits on VPS disk and broadcast them to connected clients', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        const authMsg: AuthRequestMessage = {
          id: 'auth-2',
          type: 'AUTH_REQUEST',
          timestamp: Date.now(),
          token: testToken,
          clientId: 'client-listener',
          clientName: 'Listener Device',
          protocolVersion: PROTOCOL_VERSION,
          deviceType: 'desktop'
        };
        ws.send(JSON.stringify(authMsg));
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'AUTH_RESPONSE') {
          assert.strictEqual(msg.success, true);

          // Simulate user editing a file directly on the VPS filesystem
          setTimeout(() => {
            const vpsNotePath = path.join(testDir, 'VPS-Direct.md');
            fs.writeFileSync(vpsNotePath, 'Note created directly in vim on the server!', 'utf8');
          }, 100);
        }

        if (msg.type === 'SYNC_EVENT') {
          const syncMsg = msg as SyncEventMessage;
          if ('path' in syncMsg.event && syncMsg.event.path === 'VPS-Direct.md') {
            assert.strictEqual(syncMsg.event.clientId, 'server');
            assert.strictEqual(syncMsg.event.type, 'create');
            ws.close();
            resolve();
          }
        }
      });

      ws.on('error', reject);
    });
  });

  it('should archive historical revisions into .sync-archive/history', async () => {
    const filePath = 'Folder/Welcome.md';
    const physicalPath = path.join(testDir, 'Folder', 'Welcome.md');

    assert.ok(fs.existsSync(physicalPath));

    // Overwrite file
    await vaultManager.writeFile(
      filePath,
      'Updated content on note',
      false,
      Date.now(),
      'test-editor'
    );

    const historyDir = path.join(testDir, '.sync-archive', 'history');
    assert.ok(fs.existsSync(historyDir));

    const archivedFiles = fs.readdirSync(historyDir).filter(f => f.endsWith('.bak'));
    assert.ok(archivedFiles.length > 0, 'Old version should be saved in history archive');
  });
});
