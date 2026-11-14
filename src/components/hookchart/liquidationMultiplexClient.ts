import type { ExchangeId } from '../../types';
import type { Liquidation } from './engine';

type Listener = {
  exchange: ExchangeId;
  symbol: string;
  onSnapshot: (events: Liquidation[], connected: boolean) => void;
  onLiquidation: (event: Liquidation) => void;
  onStatus: (connected: boolean) => void;
};

function validRow(value: unknown): value is Liquidation {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && row.id.length < 180 &&
    (row.side === 'LONG' || row.side === 'SHORT') &&
    typeof row.t === 'number' && Number.isSafeInteger(row.t) &&
    typeof row.p === 'number' && Number.isFinite(row.p) && row.p > 0 &&
    typeof row.q === 'number' && Number.isFinite(row.q) && row.q > 0 &&
    typeof row.usd === 'number' && Number.isFinite(row.usd) && row.usd > 0;
}

/**
 * Browser-only optional upgrade: one socket carries multiple coin streams.
 * No render timers or network requests exist until a chart subscribes.
 * The legacy transport remains the default until VPS rollout validates this.
 */
export function createMultiplexBrowserLiquidations(
  socketFactory: (url: string) => WebSocket = url => new WebSocket(url),
) {
  const listeners = new Map<string, Listener>();
  let socket: WebSocket | null = null;
  let reconnect: ReturnType<typeof setTimeout> | null = null;
  let firstSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  const hadSnapshot = new Set<string>();
  const keyOf = (exchange: ExchangeId, symbol: string) => exchange + ':' + symbol.toUpperCase();
  const setStatus = (connected: boolean) => {
    for (const sub of [...listeners.values()])
      try { sub.onStatus(connected); } catch {}
  };
  const clearTimers = () => {
    if (reconnect) clearTimeout(reconnect);
    if (firstSnapshotTimer) clearTimeout(firstSnapshotTimer);
    reconnect = null;
    firstSnapshotTimer = null;
  };
  const transmit = (type: 'subscribe' | 'unsubscribe', sub: Listener) => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({
        type, exchange: sub.exchange, symbol: sub.symbol.toUpperCase(),
      }));
    } catch {}
  };
  const schedule = () => {
    if (!listeners.size || reconnect) return;
    const wait = Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5));
    reconnect = setTimeout(() => {
      reconnect = null;
      connect();
    }, wait + Math.floor(Math.random() * 250));
  };
  const connect = () => {
    if (!listeners.size || socket) return;
    if (typeof window === 'undefined') return;
    const url = new URL('/api/hookchart/liquidations-multi', window.location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let current: WebSocket;
    try { current = socketFactory(url.toString()); }
    catch { schedule(); return; }
    socket = current;
    const disconnect = () => {
      if (socket !== current) return;
      socket = null;
      if (firstSnapshotTimer) clearTimeout(firstSnapshotTimer);
      firstSnapshotTimer = null;
      hadSnapshot.clear();
      setStatus(false);
      schedule();
    };
    current.onopen = () => {
      if (socket !== current) return;
      hadSnapshot.clear();
      for (const sub of listeners.values()) transmit('subscribe',sub);
      if (firstSnapshotTimer) clearTimeout(firstSnapshotTimer);
      firstSnapshotTimer = setTimeout(() => {
        if (socket === current && [...listeners.keys()].some(k => !hadSnapshot.has(k)))
          try { current.close(); } catch {}
      }, 15_000);
    };
    current.onmessage = event => {
      if (socket !== current) return;
      let packet: Record<string, unknown>;
      try { packet = JSON.parse(String(event.data)); }
      catch { return; }
      if (!packet || (packet.exchange !== 'binance' && packet.exchange !== 'bybit') ||
          typeof packet.symbol !== 'string') return;
      const k = keyOf(packet.exchange, packet.symbol);
      const sub = listeners.get(k);
      if (!sub) return;
      if (packet.type === 'snapshot' && Array.isArray(packet.events)) {
        hadSnapshot.add(k);
        attempts = 0;
        if (hadSnapshot.size === listeners.size && firstSnapshotTimer) {
          clearTimeout(firstSnapshotTimer); firstSnapshotTimer = null;
        }
        const rows = packet.events.slice(-1500).filter(validRow);
        try { sub.onSnapshot(rows, packet.connected === true); } catch {}
      } else if (packet.type === 'liquidation' && validRow(packet.event)) {
        try { sub.onLiquidation(packet.event); } catch {}
      } else if (packet.type === 'status') {
        try { sub.onStatus(packet.connected === true); } catch {}
      }
    };
    current.onclose = disconnect;
    current.onerror = disconnect;
  };
  const subscribe = (listener: Listener): (() => void) => {
    const key = keyOf(listener.exchange, listener.symbol);
    // The caller's sharedLiquidationStream already deduplicates each scope.
    if (listeners.has(key)) throw new Error('Duplicate browser liquidation subscription');
    listeners.set(key, listener);
    try { listener.onStatus(false); } catch {}
    if (socket?.readyState === WebSocket.OPEN) transmit('subscribe',listener);
    else connect();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      listeners.delete(key);
      hadSnapshot.delete(key);
      transmit('unsubscribe', listener);
      if (listeners.size) return;
      clearTimers();
      const old = socket;
      socket = null;
      if (old) try { old.close(); } catch {}
    };
  };
  return {subscribe, activeScopes: () => listeners.size};
}

export const multiplexBrowserLiquidations = createMultiplexBrowserLiquidations();
