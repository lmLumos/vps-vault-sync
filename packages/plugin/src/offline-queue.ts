import { SyncEvent } from '@vps-vault-sync/shared';

export class OfflineQueue {
  private queue: SyncEvent[] = [];
  private saveCallback: () => Promise<void>;

  constructor(initialQueue: SyncEvent[] = [], saveCallback: () => Promise<void>) {
    this.queue = initialQueue.map(e => this.stripContent(e));
    this.saveCallback = saveCallback;
  }

  private stripContent(event: SyncEvent): SyncEvent {
    if (event.type === 'create' || event.type === 'modify') {
      const { content, ...rest } = event;
      return rest as SyncEvent;
    }
    if (event.type === 'rename') {
      const { content, ...rest } = event;
      return rest as SyncEvent;
    }
    return event;
  }

  public getEvents(): SyncEvent[] {
    return [...this.queue];
  }

  public size(): number {
    return this.queue.length;
  }

  public async enqueue(event: SyncEvent): Promise<void> {
    const lightweight = this.stripContent(event);
    const targetPath = 'path' in lightweight ? lightweight.path : ('newPath' in lightweight ? lightweight.newPath : '');

    // Deduplicate: if there is already an event for this path, update or replace it
    const existingIndex = this.queue.findIndex(e => {
      const p = 'path' in e ? e.path : ('newPath' in e ? e.newPath : '');
      return p === targetPath;
    });

    if (existingIndex !== -1) {
      this.queue[existingIndex] = lightweight;
    } else {
      this.queue.push(lightweight);
    }

    await this.saveCallback();
  }

  public async dequeue(): Promise<SyncEvent | undefined> {
    const item = this.queue.shift();
    if (item) {
      await this.saveCallback();
    }
    return item;
  }

  public async clear(): Promise<void> {
    this.queue = [];
    await this.saveCallback();
  }

  public serialize(): SyncEvent[] {
    return this.queue.map(e => this.stripContent(e));
  }
}
