/**
 * Bounded, exchange-ID-keyed history for one HookChart liquidation display.
 * A map makes cumulative fills and deduplicated bursts O(1) per event rather
 * than scanning the previous 1,500 labels for every incoming liquidation.
 * Sorting and eviction happen only when a display snapshot is requested.
 */
export class LiquidationEventBuffer<T extends { id: string; usd: number; t: number }> {
  private byId = new Map<string, T>();

  get size(): number { return this.byId.size; }

  upsert(event: T): boolean {
    const previous = this.byId.get(event.id);
    if (previous && event.usd <= previous.usd) return false;
    this.byId.set(event.id, event);
    return true;
  }

  replace(events: readonly T[]): void {
    this.byId.clear();
    for (const event of events) this.upsert(event);
  }

  newestEventTime(): number {
    let latest = 0;
    for (const row of this.byId.values()) latest = Math.max(latest, row.t);
    return latest;
  }

  snapshot(now = Date.now(), maxAgeMs = 30 * 60_000, maxRows = 1500): T[] {
    const oldest = now - maxAgeMs;
    for (const [id, event] of this.byId) {
      if (event.t < oldest) this.byId.delete(id);
    }
    const sorted = [...this.byId.values()].sort((a, b) => a.t - b.t);
    const keep = Number.isSafeInteger(maxRows) && maxRows >= 0 ? maxRows : 1500;
    const visible = keep === 0 ? [] : sorted.slice(-keep);
    if (visible.length !== this.byId.size) {
      this.byId = new Map(visible.map(row => [row.id, row]));
    }
    return visible;
  }
}
