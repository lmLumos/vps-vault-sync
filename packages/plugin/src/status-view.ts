import { App, Modal, Setting, setIcon } from 'obsidian';
import { SyncStatus, ActivityLogEntry } from './sync-client';
import type VPSVaultSyncPlugin from './main';

export class StatusBarItemView {
  private el: HTMLElement | null;
  private plugin: VPSVaultSyncPlugin;

  constructor(el: HTMLElement | null, plugin: VPSVaultSyncPlugin) {
    this.el = el;
    this.plugin = plugin;
    if (this.el) {
      this.init();
    }
  }

  private init(): void {
    if (!this.el) return;
    this.el.addClass('vps-sync-status-bar');
    this.el.setAttribute('aria-label', 'VPS Live Sync: Initializing');
    this.updateStatus('disconnected');

    this.el.addEventListener('click', () => {
      this.plugin.openActivityLogModal();
    });
  }

  public updateStatus(status: SyncStatus, detail?: string): void {
    if (!this.el) return;
    this.el.empty();
    const iconSpan = this.el.createSpan({ cls: 'vps-sync-icon' });
    const textSpan = this.el.createSpan({ cls: 'vps-sync-text' });

    let iconName = 'sync';
    let label = 'VPS Sync';
    let tooltip = 'VPS Live Sync';

    switch (status) {
      case 'synced':
        iconName = 'check-circle';
        label = 'Synced';
        tooltip = 'VPS Sync: All notes up to date';
        this.el.removeClass('is-syncing', 'is-error', 'is-disconnected');
        this.el.addClass('is-synced');
        break;
      case 'syncing':
      case 'reconciling':
        iconName = 'refresh-cw';
        label = status === 'reconciling' ? 'Reconciling...' : 'Syncing...';
        tooltip = `VPS Sync: ${status === 'reconciling' ? 'Checking for changes' : 'Transferring updates'}`;
        this.el.removeClass('is-synced', 'is-error', 'is-disconnected');
        this.el.addClass('is-syncing');
        break;
      case 'connecting':
      case 'authenticating':
        iconName = 'loader';
        label = 'Connecting...';
        tooltip = 'VPS Sync: Connecting to VPS server';
        this.el.removeClass('is-synced', 'is-error', 'is-disconnected');
        this.el.addClass('is-syncing');
        break;
      case 'error':
        iconName = 'alert-triangle';
        label = 'Sync Error';
        tooltip = `VPS Sync Error: ${detail || 'Check settings'}`;
        this.el.removeClass('is-synced', 'is-syncing', 'is-disconnected');
        this.el.addClass('is-error');
        break;
      case 'disconnected':
      default:
        iconName = 'cloud-off';
        label = 'Disconnected';
        tooltip = `VPS Sync: Disconnected (${detail || 'Offline'})`;
        this.el.removeClass('is-synced', 'is-syncing', 'is-error');
        this.el.addClass('is-disconnected');
        break;
    }

    setIcon(iconSpan, iconName);
    textSpan.setText(label);
    this.el.setAttribute('aria-label', tooltip);
  }
}

export class ActivityLogModal extends Modal {
  private plugin: VPSVaultSyncPlugin;

  constructor(app: App, plugin: VPSVaultSyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('vps-sync-log-modal');

    contentEl.createEl('h2', { text: 'VPS Sync Activity Log' });

    const headerBar = contentEl.createDiv({ cls: 'vps-sync-modal-header' });

    const statusBadge = headerBar.createSpan({
      cls: `vps-sync-badge vps-sync-badge-${this.plugin.syncClient.getStatus()}`,
      text: `Status: ${this.plugin.syncClient.getStatus().toUpperCase()}`
    });

    const btnContainer = headerBar.createDiv({ cls: 'vps-sync-header-actions' });

    const syncBtn = btnContainer.createEl('button', { text: 'Sync Now', cls: 'mod-cta' });
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      syncBtn.setText('Syncing...');
      await this.plugin.syncClient.reconcileVault();
      syncBtn.disabled = false;
      syncBtn.setText('Sync Now');
      this.renderLogList(logContainer);
    });

    const reconnectBtn = btnContainer.createEl('button', { text: 'Reconnect' });
    reconnectBtn.addEventListener('click', () => {
      this.plugin.syncClient.reconnect();
      setTimeout(() => this.renderLogList(logContainer), 1000);
    });

    const logContainer = contentEl.createDiv({ cls: 'vps-sync-log-container' });
    this.renderLogList(logContainer);
  }

  private renderLogList(container: HTMLElement): void {
    container.empty();
    const logs = this.plugin.syncClient.getLogs();

    if (logs.length === 0) {
      container.createEl('p', {
        text: 'No sync activity recorded yet. Edits and sync events will appear here.',
        cls: 'vps-sync-empty-log'
      });
      return;
    }

    const table = container.createEl('table', { cls: 'vps-sync-log-table' });
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    headerRow.createEl('th', { text: 'Time' });
    headerRow.createEl('th', { text: 'Type' });
    headerRow.createEl('th', { text: 'File Path' });
    headerRow.createEl('th', { text: 'Details' });

    const tbody = table.createEl('tbody');
    for (const log of logs) {
      const row = tbody.createEl('tr', { cls: `vps-log-row-${log.type}` });
      const timeStr = new Date(log.timestamp).toLocaleTimeString();

      row.createEl('td', { text: timeStr, cls: 'vps-log-time' });
      const typeTd = row.createEl('td', { cls: 'vps-log-type' });
      typeTd.createSpan({ cls: `vps-badge-${log.type}`, text: log.type.toUpperCase() });

      row.createEl('td', { text: log.path || '—', cls: 'vps-log-path' });
      row.createEl('td', { text: log.message, cls: 'vps-log-msg' });
    }
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
