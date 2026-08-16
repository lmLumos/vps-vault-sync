import { SyncEvent } from '@vps-vault-sync/shared';

export class OfflineQueue {
  private queue: SyncEvent[] = [];
  private saveCallback: () => Promise<void>;

  constructor(initialQueue: SyncEvent[] = [], saveCallback: () => Promise<void>) {
    this.queue = [...initialQueue];
    this.saveCallback = saveCallback;
  }

  public getEvents(): SyncEvent[] {
    return [...this.queue];
  }

  public size(): number {
    return this.queue.length;
  }

  public async enqueue(event: SyncEvent): Promise<void> {
    const targetPath = 'path' in event ? event.path : ('newPath' in event ? event.newPath : '');

    // Deduplicate: if there is already an event for this path, update or replace it
    const existingIndex = this.queue.findIndex(e => {
      const p = 'path' in e ? e.path : ('newPath' in e ? e.newPath : '');
      return p === targetPath;
    });

    if (existingIndex !== -1) {
      this.queue[existingIndex] = event;
    } else {
      this.queue.push(event);
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
    return this.queue;
  }
}
