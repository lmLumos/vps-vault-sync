interface InFlightWrite {
  path: string;
  hash: string;
  clientId: string;
  timestamp: number;
}

export class EchoFilter {
  private recentWrites = new Map<string, InFlightWrite>();
  private readonly ttlMs: number;

  constructor(ttlMs = 4000) {
    this.ttlMs = ttlMs;

    // Periodically clean up expired entries
    setInterval(() => this.cleanup(), 10000).unref();
  }

  /**
   * Registers a file write initiated by a specific remote client.
   */
  public recordRemoteWrite(relativePath: string, hash: string, clientId: string): void {
    const normalized = relativePath.replace(/\\/g, '/');
    this.recentWrites.set(normalized, {
      path: normalized,
      hash,
      clientId,
      timestamp: Date.now()
    });
  }

  /**
   * Checks if an observed filesystem event corresponds to a known remote write.
   * If yes, returns the clientId that caused the write and removes the entry.
   */
  public matchAndConsume(relativePath: string, currentHash?: string): string | null {
    const normalized = relativePath.replace(/\\/g, '/');
    const entry = this.recentWrites.get(normalized);
    if (!entry) return null;

    // Check expiration
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.recentWrites.delete(normalized);
      return null;
    }

    // If currentHash is provided, verify it matches
    if (currentHash && entry.hash && entry.hash !== currentHash) {
      return null;
    }

    this.recentWrites.delete(normalized);
    return entry.clientId;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [path, entry] of this.recentWrites.entries()) {
      if (now - entry.timestamp > this.ttlMs) {
        this.recentWrites.delete(path);
      }
    }
  }
}
