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
import { ServerConfig, loadConfig } from './config';

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

  describe('HTTP API Authentication & Security (Issue 3)', () => {
    it('should reject HTTP requests with token in query params without Authorization header (401)', async () => {
      const res = await fetch(`http://127.0.0.1:${testPort}/api/manifest?token=${testToken}`);
      assert.strictEqual(res.status, 401);
      const data = await res.json() as { error?: string };
      assert.strictEqual(data.error, 'Unauthorized: Invalid token');
    });

    it('should reject HTTP requests without Authorization header (401)', async () => {
      const res = await fetch(`http://127.0.0.1:${testPort}/api/manifest`);
      assert.strictEqual(res.status, 401);
      const data = await res.json() as { error?: string };
      assert.strictEqual(data.error, 'Unauthorized: Invalid token');
    });

    it('should reject HTTP requests with invalid Bearer token (401)', async () => {
      const res = await fetch(`http://127.0.0.1:${testPort}/api/manifest`, {
        headers: {
          'Authorization': 'Bearer wrong-secret-token'
        }
      });
      assert.strictEqual(res.status, 401);
      const data = await res.json() as { error?: string };
      assert.strictEqual(data.error, 'Unauthorized: Invalid token');
    });

    it('should allow HTTP requests with valid Bearer Authorization header (200)', async () => {
      const res = await fetch(`http://127.0.0.1:${testPort}/api/manifest`, {
        headers: {
          'Authorization': `Bearer ${testToken}`
        }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json() as { manifest?: any };
      assert.ok(data.manifest);
    });
  });

  describe('Config Security Validation (loadConfig - Issue 2)', () => {
    const originalEnv = { ...process.env };

    after(() => {
      process.env = originalEnv;
    });

    it('should allow default token in test environment', () => {
      process.env.NODE_ENV = 'test';
      delete process.env.SYNC_TOKEN;
      delete process.env.VAULT_SYNC_TOKEN;
      const cfg = loadConfig();
      assert.strictEqual(cfg.syncToken, 'default-secret-token-change-me');
    });

    it('should use SYNC_TOKEN if provided', () => {
      process.env.NODE_ENV = 'production';
      process.env.SYNC_TOKEN = 'custom-prod-secret-token-999';
      const cfg = loadConfig();
      assert.strictEqual(cfg.syncToken, 'custom-prod-secret-token-999');
    });

    it('should exit when SYNC_TOKEN is missing or default in non-test environment', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.SYNC_TOKEN;
      delete process.env.VAULT_SYNC_TOKEN;

      let exitCalled = false;
      let exitCode: number | undefined;
      const originalExit = process.exit;
      const originalError = console.error;
      console.error = () => {};
      (process as any).exit = (code?: number) => {
        exitCalled = true;
        exitCode = code;
        throw new Error(`process.exit called with ${code}`);
      };

      try {
        assert.throws(() => loadConfig(), /process\.exit called with 1/);
        assert.strictEqual(exitCalled, true);
        assert.strictEqual(exitCode, 1);
      } finally {
        process.exit = originalExit;
        console.error = originalError;
      }
    });

    it('should exit when SYNC_TOKEN is set to default placeholder in non-test environment', () => {
      process.env.NODE_ENV = 'production';
      process.env.SYNC_TOKEN = 'default-secret-token-change-me';

      let exitCalled = false;
      let exitCode: number | undefined;
      const originalExit = process.exit;
      const originalError = console.error;
      console.error = () => {};
      (process as any).exit = (code?: number) => {
        exitCalled = true;
        exitCode = code;
        throw new Error(`process.exit called with ${code}`);
      };

      try {
        assert.throws(() => loadConfig(), /process\.exit called with 1/);
        assert.strictEqual(exitCalled, true);
        assert.strictEqual(exitCode, 1);
      } finally {
        process.exit = originalExit;
        console.error = originalError;
      }
    });
  });

  describe('Path Traversal Security & Boundary Containment (Issue 1 & Issue 8)', () => {
    it('should allow valid relative paths within the vault', () => {
      const p1 = vaultManager.getAbsolutePath('note.md');
      assert.strictEqual(p1, path.join(testDir, 'note.md'));

      const p2 = vaultManager.getAbsolutePath('folder/sub/note.md');
      assert.strictEqual(p2, path.join(testDir, 'folder', 'sub', 'note.md'));

      const p3 = vaultManager.getAbsolutePath('folder/../folder/note.md');
      assert.strictEqual(p3, path.join(testDir, 'folder', 'note.md'));

      const root = vaultManager.getAbsolutePath('');
      assert.strictEqual(root, testDir);

      const dot = vaultManager.getAbsolutePath('.');
      assert.strictEqual(dot, testDir);
    });

    it('should reject relative path traversal attempts with leading ..', () => {
      assert.throws(
        () => vaultManager.getAbsolutePath('../../etc/passwd'),
        /Security Error: Directory traversal attempt blocked/
      );
      assert.throws(
        () => vaultManager.getAbsolutePath('../secret.txt'),
        /Security Error: Directory traversal attempt blocked/
      );
    });

    it('should reject Windows-style backslash traversal attempts', () => {
      assert.throws(
        () => vaultManager.getAbsolutePath('..\\..\\windows\\system32'),
        /Security Error: Directory traversal attempt blocked/
      );
      assert.throws(
        () => vaultManager.getAbsolutePath('..\\secret.txt'),
        /Security Error: Directory traversal attempt blocked/
      );
    });

    it('should reject internal path traversal that escapes vault root', () => {
      assert.throws(
        () => vaultManager.getAbsolutePath('sub/../../etc/passwd'),
        /Security Error: Directory traversal attempt blocked/
      );
      assert.throws(
        () => vaultManager.getAbsolutePath('a/b/../../../secret.txt'),
        /Security Error: Directory traversal attempt blocked/
      );
    });

    it('should reject absolute paths', () => {
      assert.throws(
        () => vaultManager.getAbsolutePath('/etc/passwd'),
        /Security Error: Directory traversal attempt blocked/
      );
      if (process.platform === 'win32') {
        assert.throws(
          () => vaultManager.getAbsolutePath('C:\\Windows\\System32\\cmd.exe'),
          /Security Error: Directory traversal attempt blocked/
        );
        assert.throws(
          () => vaultManager.getAbsolutePath('C:/Windows/System32'),
          /Security Error: Directory traversal attempt blocked/
        );
      }
    });

    it('should reject null byte injection and URL-encoded traversals', () => {
      assert.throws(
        () => vaultManager.getAbsolutePath('note.md\0../../etc/passwd'),
        /Security Error: Directory traversal attempt blocked/
      );
      assert.throws(
        () => vaultManager.getAbsolutePath('%2e%2e%2f%2e%2e%2fetc%2fpasswd'),
        /Security Error: Directory traversal attempt blocked/
      );
      assert.throws(
        () => vaultManager.getAbsolutePath('%2e%2e%5c%2e%2e%5cwindows'),
        /Security Error: Directory traversal attempt blocked/
      );
    });

    it('should guard readFile, writeFile, deleteFile, getMetadata, and ensureDirectory against traversal', async () => {
      await assert.rejects(
        () => vaultManager.readFile('../../etc/passwd'),
        /Security Error: Directory traversal attempt blocked/
      );

      await assert.rejects(
        () => vaultManager.writeFile('../../etc/cron.d/malicious', 'malicious', false, Date.now(), 'client-evil'),
        /Security Error: Directory traversal attempt blocked/
      );

      await assert.rejects(
        () => vaultManager.deleteFile('../../etc/shadow', 'client-evil'),
        /Security Error: Directory traversal attempt blocked/
      );

      await assert.rejects(
        () => vaultManager.getMetadata('../../etc/passwd'),
        /Security Error: Directory traversal attempt blocked/
      );

      await assert.rejects(
        () => vaultManager.ensureDirectory('../../etc/newdir'),
        /Security Error: Directory traversal attempt blocked/
      );
    });

    it('should reject path traversal in renameFile (Issue 8)', async () => {
      // Create a valid file first
      await vaultManager.writeFile('safe-file.md', '# Safe', false, Date.now(), 'client-test');

      // Attempt to rename valid file to outside vault
      await assert.rejects(
        () => vaultManager.renameFile('safe-file.md', '../../etc/cron.d/evil', 'client-test'),
        /Security Error: Directory traversal attempt blocked/
      );

      await assert.rejects(
        () => vaultManager.renameFile('safe-file.md', '..\\..\\windows\\system32\\evil.dll', 'client-test'),
        /Security Error: Directory traversal attempt blocked/
      );

      // Attempt to rename outside system file into vault
      await assert.rejects(
        () => vaultManager.renameFile('../../etc/shadow', 'stolen-shadow.txt', 'client-test'),
        /Security Error: Directory traversal attempt blocked/
      );

      // Valid rename within vault should succeed
      const renameResult = await vaultManager.renameFile('safe-file.md', 'safe-renamed.md', 'client-test');
      assert.strictEqual(renameResult, true);
      assert.ok(fs.existsSync(path.join(testDir, 'safe-renamed.md')));
      assert.ok(!fs.existsSync(path.join(testDir, 'safe-file.md')));
    });

    it('should reject path traversal via WebSocket FILE_PUT_REQUEST', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${testPort}`);

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          const authMsg: AuthRequestMessage = {
            id: 'auth-traversal-test',
            type: 'AUTH_REQUEST',
            timestamp: Date.now(),
            token: testToken,
            clientId: 'client-attacker',
            clientName: 'Attacker Client',
            protocolVersion: PROTOCOL_VERSION,
            deviceType: 'desktop'
          };
          ws.send(JSON.stringify(authMsg));
        });

        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'AUTH_RESPONSE') {
            assert.strictEqual(msg.success, true);
            const putMsg: FilePutRequestMessage = {
              id: 'put-traversal',
              type: 'FILE_PUT_REQUEST',
              timestamp: Date.now(),
              path: '../../evil-file.md',
              content: 'malicious content',
              isBinary: false,
              mtime: Date.now(),
              hash: 'evilhash'
            };
            ws.send(JSON.stringify(putMsg));
          }

          if (msg.type === 'FILE_PUT_RESPONSE') {
            assert.strictEqual(msg.success, false);
            assert.ok(msg.error.includes('Directory traversal attempt blocked'));
            ws.close();
            resolve();
          }
        });

        ws.on('error', reject);
      });
    });

    it('should reject path traversal via HTTP API GET /api/file', async () => {
      const res = await fetch(`http://127.0.0.1:${testPort}/api/file?path=../../etc/passwd`, {
        headers: {
          'Authorization': `Bearer ${testToken}`
        }
      });
      assert.strictEqual(res.status, 500);
      const data = await res.json() as { error?: string };
      assert.ok(data.error?.includes('Directory traversal attempt blocked'));
    });
  });
});
