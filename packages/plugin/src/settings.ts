import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type VPSVaultSyncPlugin from './main';

export interface SyncPluginSettings {
  serverUrl: string;
  authToken: string;
  deviceName: string;
  clientId: string;
  syncObsidianConfig: boolean;
  syncWorkspace: boolean;
  conflictStrategy: 'three-way' | 'last-write-wins';
  autoSyncOnStart: boolean;
  liveSyncEnabled: boolean;
  debounceMs: number;
  lastSyncedTimestamp: number;
}

export const DEFAULT_SETTINGS: SyncPluginSettings = {
  serverUrl: 'ws://localhost:3000',
  authToken: '',
  deviceName: 'My Device',
  clientId: '',
  syncObsidianConfig: true,
  syncWorkspace: false,
  conflictStrategy: 'three-way',
  autoSyncOnStart: true,
  liveSyncEnabled: true,
  debounceMs: 500,
  lastSyncedTimestamp: 0
};

export class SyncSettingTab extends PluginSettingTab {
  plugin: VPSVaultSyncPlugin;

  constructor(app: App, plugin: VPSVaultSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'VPS Live Vault Sync' });
    containerEl.createEl('p', {
      text: 'Synchronize your notes, attachments, themes, and plugins seamlessly in real time with your VPS server.',
      cls: 'setting-item-description'
    });

    // Server Connection Section
    const serverUrlSetting = new Setting(containerEl)
      .setName('Server URL')
      .setDesc('WebSocket or HTTP address of your VPS sync server (e.g. wss://sync.yourdomain.com). For non-local hosts, wss:// or https:// is strongly recommended.')
      .addText(text => text
        .setPlaceholder('wss://sync.example.com')
        .setValue(this.plugin.settings.serverUrl)
        .onChange(async (value) => {
          this.plugin.settings.serverUrl = value.trim();
          await this.plugin.saveSettings();
          this.display(); // re-render to update TLS warning
        }));

    // Insecure Transport Warning (Issue 7)
    const url = this.plugin.settings.serverUrl.trim().toLowerCase();
    const isInsecure = (url.startsWith('ws://') || url.startsWith('http://')) &&
      !url.includes('localhost') && !url.includes('127.0.0.1') && !url.includes('[::1]');

    if (isInsecure) {
      const warnEl = containerEl.createEl('div', {
        cls: 'setting-item-description',
        text: '⚠️ Security Warning: Unencrypted transport (ws:// or http://) in use for a non-local host. Note contents and authentication tokens will be transmitted in cleartext over the network. We strongly recommend configuring TLS with wss:// via a reverse proxy (Caddy, Nginx, or Cloudflare Tunnel).'
      });
      warnEl.style.color = 'var(--text-warning, #e5a50a)';
      warnEl.style.marginBottom = '12px';
      warnEl.style.fontSize = '12px';
    }

    new Setting(containerEl)
      .setName('Secret API Token')
      .setDesc('The secret authentication token configured on your VPS server (SYNC_TOKEN). Stored locally on this device and excluded from sync.')
      .addText(text => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('Enter your secret token')
          .setValue(this.plugin.settings.authToken)
          .onChange(async (value) => {
            this.plugin.settings.authToken = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Device Name')
      .setDesc('Identifier for this device shown in sync logs and conflict markers.')
      .addText(text => text
        .setPlaceholder('e.g. MacBook Pro, iPhone, Windows Desktop')
        .setValue(this.plugin.settings.deviceName)
        .onChange(async (value) => {
          this.plugin.settings.deviceName = value.trim();
          await this.plugin.saveSettings();
        }));

    // Connection actions
    new Setting(containerEl)
      .setName('Connection Status')
      .setDesc(`Current state: ${this.plugin.syncClient.getStatus()}`)
      .addButton(btn => btn
        .setButtonText('Test Connection')
        .setCta()
        .onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText('Testing...');
          try {
            const success = await this.plugin.syncClient.testConnection();
            if (success) {
              new Notice('✅ Connection to VPS sync server successful!');
            } else {
              new Notice('❌ Connection failed. Check server URL and secret token.');
            }
          } catch (err) {
            new Notice(`❌ Connection error: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            btn.setDisabled(false);
            btn.setButtonText('Test Connection');
            this.display();
          }
        }))
      .addButton(btn => btn
        .setButtonText('Reconnect')
        .onClick(() => {
          this.plugin.syncClient.reconnect();
          new Notice('Reconnecting to VPS sync server...');
          this.display();
        }));

    containerEl.createEl('h3', { text: 'Synchronization Preferences' });

    new Setting(containerEl)
      .setName('Live Real-Time Sync')
      .setDesc('Continuously push and pull changes as they happen.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.liveSyncEnabled)
        .onChange(async (value) => {
          this.plugin.settings.liveSyncEnabled = value;
          await this.plugin.saveSettings();
          if (value) {
            this.plugin.syncClient.connect();
          } else {
            this.plugin.syncClient.disconnect();
          }
        }));

    new Setting(containerEl)
      .setName('Sync .obsidian Configuration')
      .setDesc('Sync community plugins, themes, snippets, and app settings.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.syncObsidianConfig)
        .onChange(async (value) => {
          this.plugin.settings.syncObsidianConfig = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Sync Workspace Layout')
      .setDesc('Sync open tabs and sidebars (workspace.json). Disable if you prefer different layouts on mobile vs desktop.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.syncWorkspace)
        .onChange(async (value) => {
          this.plugin.settings.syncWorkspace = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Conflict Resolution Strategy')
      .setDesc('How to handle simultaneous edits to the same file.')
      .addDropdown(drop => drop
        .addOption('three-way', '3-Way Line Merge (Auto-merge non-overlapping lines, create conflict file on collision)')
        .addOption('last-write-wins', 'Last-Write-Wins (Overwrite with latest timestamp)')
        .setValue(this.plugin.settings.conflictStrategy)
        .onChange(async (value) => {
          this.plugin.settings.conflictStrategy = value as 'three-way' | 'last-write-wins';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Debounce Delay (ms)')
      .setDesc('Delay after typing before broadcasting changes to prevent server spam.')
      .addSlider(slider => slider
        .setLimits(200, 2000, 100)
        .setValue(this.plugin.settings.debounceMs)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.debounceMs = value;
          await this.plugin.saveSettings();
        }));

    // Manual Sync & Recovery
    containerEl.createEl('h3', { text: 'Manual Operations & Diagnostics' });

    new Setting(containerEl)
      .setName('Force Full Reconciliation')
      .setDesc('Compare all files with server and synchronize differences immediately.')
      .addButton(btn => btn
        .setButtonText('Sync Now')
        .onClick(async () => {
          new Notice('Starting full vault reconciliation...');
          await this.plugin.syncClient.reconcileVault();
        }));

    new Setting(containerEl)
      .setName('View Sync Activity Log')
      .setDesc('Review recent file transfers, connection events, and conflict records.')
      .addButton(btn => btn
        .setButtonText('Open Activity Log')
        .onClick(() => {
          this.plugin.openActivityLogModal();
        }));
  }
}
