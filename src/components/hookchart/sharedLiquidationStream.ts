import type { Liquidation } from './engine';
import { canonicalLiquidationId, deduplicateLiquidations } from './liquidationDisplay';
import { connectHookChartLiquidations } from './liquidationStream';

type Options = Parameters<typeof connectHookChartLiquidations>[0];
type Subscriber = Pick<Options, 'onSnapshot' | 'onLiquidation' | 'onStatus'>;
type Connector = (options: Options) => () => void;

type Entry = {
  listeners: Set<Subscriber>;
  hasSnapshot: boolean;
  connected: boolean;
  rows: Map<string, Liquidation>;
  lastPrunedAt: number;
  stop: () => void;
};

const RETAIN_MS = 30 * 60_000;
const MAX_ROWS = 1500;

/** Expiration needs a full scan only occasionally, not on every liquidation.
 * Hard cap enforcement still runs on every update to avoid unbounded memory.
 */
function trimSharedLiquidations(entry: Entry, now = Date.now(), force = false): void {
  if (force || now - entry.lastPrunedAt >= 2000) {
    const oldest = now - RETAIN_MS;
    for (const [id, row] of entry.rows) if (row.t < oldest) entry.rows.delete(id);
    entry.lastPrunedAt = now;
  }
  while (entry.rows.size > MAX_ROWS) entry.rows.delete(entry.rows.keys().next().value!);
}

/** Share a single site-bound liquidation WS per coin in the current browser tab. */
export function createSharedLiquidationSubscriptions(connect: Connector = connectHookChartLiquidations) {
  const active = new Map<string, Entry>();

  const subscribe = (options: Options): (() => void) => {
    const key = options.exchange + ':' + options.symbol.toUpperCase();
    const listener: Subscriber = {
      onSnapshot: options.onSnapshot,
      onLiquidation: options.onLiquidation,
      onStatus: options.onStatus,
    };
    let entry = active.get(key);
    if (entry) {
      trimSharedLiquidations(entry, Date.now(), true);
      entry.listeners.add(listener);
      try {
        if (entry.hasSnapshot) listener.onSnapshot([...entry.rows.values()], entry.connected);
        else listener.onStatus(entry.connected);
      } catch { /* listener errors do not break the other graphs */ }
      return () => {
        entry!.listeners.delete(listener);
        if (!entry!.listeners.size && active.get(key) === entry) {
          active.delete(key);
          entry!.stop();
        }
      };
    }
    entry = {
      listeners: new Set([listener]), hasSnapshot: false, connected: false,
      rows: new Map(), lastPrunedAt: 0, stop: () => {},
    };
    const current = entry;
    active.set(key, current);

    try {
      current.stop = connect({
        ...options,
        onSnapshot: (rows, connected) => {
          // A reconnect snapshot can lag behind a live cumulative Binance
          // liquidation we already observed (for example after a server
          // restart). Never roll an order's notional backwards or erase
          // recent real events just because a snapshot is incomplete.
          const previous = current.rows;
          const merged = new Map<string, Liquidation>();
          for (const row of deduplicateLiquidations(rows)) {
            merged.set(canonicalLiquidationId(row.id), row);
          }
          const oldest = Date.now() - RETAIN_MS;
          for (const [id, row] of previous) {
            if (row.t < oldest) continue;
            const newer = merged.get(id);
            if (!newer || row.usd > newer.usd) merged.set(id, row);
          }
          current.rows = merged;
          trimSharedLiquidations(current, Date.now(), true);
          current.hasSnapshot = true;
          current.connected = connected;
          // Each independent chart still receives the initial snapshot so it
          // can calculate its own display thresholds and cascade risk.
          const snapshot = [...current.rows.values()];
          for (const subscriber of [...current.listeners]) {
            try { subscriber.onSnapshot(snapshot, connected); } catch {}
          }
        },
        onLiquidation: row => {
          const id = canonicalLiquidationId(row.id);
          const old = current.rows.get(id);
          // Binance cumulative fills may grow. Repeated events do not need a
          // new chart render and must not inflate session totals.
          if (old && row.usd <= old.usd) return;
          if (old) current.rows.delete(id);
          current.rows.set(id, row);
          trimSharedLiquidations(current);
          for (const subscriber of [...current.listeners]) {
            try { subscriber.onLiquidation(row); } catch {}
          }
        },
        onStatus: connected => {
          current.connected = connected;
          for (const subscriber of [...current.listeners]) {
            try { subscriber.onStatus(connected); } catch {}
          }
        },
      });
    } catch {
      active.delete(key);
      for (const subscriber of [...current.listeners]) {
        try { subscriber.onStatus(false); } catch {}
      }
    }
    return () => {
      current.listeners.delete(listener);
      if (!current.listeners.size && active.get(key) === current) {
        active.delete(key);
        current.stop();
      }
    };
  };
  return { subscribe, activeScopes: () => active.size };
}

export const connectSharedHookChartLiquidations = createSharedLiquidationSubscriptions().subscribe;
