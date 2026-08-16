import { Plugin, Notice } from 'obsidian';
import { DEFAULT_SETTINGS, SyncPluginSettings, SyncSettingTab } from './settings';
import { SyncClient, SyncStatus } from './sync-client';
import { VaultWatcher } from './vault-watcher';
import { ConflictHandler } from './conflict-handler';
import { OfflineQueue } from './offline-queue';
import { StatusBarItemView, ActivityLogModal } from './status-view';
import { IgnoreFilter, SyncEvent } from '@vps-vault-sync/shared';

interface PluginDataStorage {
  settings: SyncPluginSettings;
  offlineQueue: SyncEvent[];
}

export default class VPSVaultSyncPlugin extends Plugin {
  settings: SyncPluginSettings = DEFAULT_SETTINGS;
  syncClient!: SyncClient;
  vaultWatcher!: VaultWatcher;
  conflictHandler!: ConflictHandler;
  offlineQueue!: OfflineQueue;
  ignoreFilter!: IgnoreFilter;
  statusBarItemView!: StatusBarItemView;

  async onload() {
    console.log('[VPS Vault Sync] Loading plugin...');

    // Load persisted data
    await this.loadPluginData();

    // Generate unique client ID if not set
    if (!this.settings.clientId) {
      this.settings.clientId = `client-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      await this.saveSettings();
    }

    // Initialize subsystems
    this.ignoreFilter = new IgnoreFilter({
      syncObsidianConfig: this.settings.syncObsidianConfig,
      syncWorkspace: this.settings.syncWorkspace
    });

    this.conflictHandler = new ConflictHandler(this.app);
    this.offlineQueue = new OfflineQueue(
      [],
      async () => {
        await this.savePluginData();
      }
    );

    this.syncClient = new SyncClient(this.app, this);
    this.vaultWatcher = new VaultWatcher(this.app, this, this.ignoreFilter);

    // Register Status Bar Item
    const statusBarEl = this.addStatusBarItem();
    this.statusBarItemView = new StatusBarItemView(statusBarEl, this);

    // Register Status Change listener
    this.syncClient.onStatusChange((status: SyncStatus, detail?: string) => {
      this.statusBarItemView.updateStatus(status, detail);
    });

    // Add Ribbon Icon
    this.addRibbonIcon('refresh-cw', 'VPS Live Sync: Open Activity Log', () => {
      this.openActivityLogModal();
    });

    // Register Commands
    this.addCommand({
      id: 'vps-sync-reconcile-now',
      name: 'Force Vault Sync Now',
      callback: async () => {
        new Notice('Starting full vault reconciliation...');
        await this.syncClient.reconcileVault();
      }
    });

    this.addCommand({
      id: 'vps-sync-view-activity-log',
      name: 'View Sync Activity Log',
      callback: () => {
        this.openActivityLogModal();
      }
    });

    this.addCommand({
      id: 'vps-sync-reconnect',
      name: 'Reconnect to VPS Server',
      callback: () => {
        new Notice('Reconnecting to VPS sync server...');
        this.syncClient.reconnect();
      }
    });

    // Register Settings Tab
    this.addSettingTab(new SyncSettingTab(this.app, this));

    // Start Vault Watcher
    this.vaultWatcher.start();

    // Connect Sync Client if enabled
    if (this.settings.liveSyncEnabled && this.settings.serverUrl && this.settings.authToken) {
      this.app.workspace.onLayoutReady(() => {
        this.syncClient.connect();
      });
    }

    console.log('[VPS Vault Sync] Plugin initialized successfully.');
  }

  onunload() {
    console.log('[VPS Vault Sync] Unloading plugin...');
    this.vaultWatcher?.stop();
    this.syncClient?.disconnect();
  }

  public openActivityLogModal(): void {
    new ActivityLogModal(this.app, this).open();
  }

  private async loadPluginData(): Promise<void> {
    const rawData = await this.loadData();
    if (rawData) {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, rawData.settings || rawData);
    } else {
      this.settings = Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  public async saveSettings(): Promise<void> {
    // Update ignore filter options when settings change
    if (this.ignoreFilter) {
      this.ignoreFilter.reloadPatterns();
    }
    await this.savePluginData();
  }

  private async savePluginData(): Promise<void> {
    const dataToSave: PluginDataStorage = {
      settings: this.settings,
      offlineQueue: this.offlineQueue ? this.offlineQueue.serialize() : []
    };
    await this.saveData(dataToSave);
  }
}
