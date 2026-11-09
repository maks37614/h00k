import type { ExchangeId } from '../../types';
import type { Liquidation } from './engine';

type Options = {
  exchange: ExchangeId;
  symbol: string;
  onSnapshot: (events: Liquidation[], connected: boolean) => void;
  onLiquidation: (event: Liquidation) => void;
  onStatus: (connected: boolean) => void;
};

function validLiquidation(row: unknown): row is Liquidation {
  if (!row || typeof row !== 'object') return false;
  const item = row as Record<string, unknown>;
  return typeof item.id === 'string' && item.id.length < 180 &&
    (item.side === 'LONG' || item.side === 'SHORT') &&
    typeof item.t === 'number' && Number.isSafeInteger(item.t) &&
    typeof item.p === 'number' && Number.isFinite(item.p) && item.p > 0 &&
    typeof item.q === 'number' && Number.isFinite(item.q) && item.q > 0 &&
    typeof item.usd === 'number' && Number.isFinite(item.usd) && item.usd > 0;
}

/** One browser-to-site socket; the server multiplexes one exchange WS per coin. */
export function connectHookChartLiquidations({
  exchange, symbol, onSnapshot, onLiquidation, onStatus,
}: Options): () => void {
  let stopped = false;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;

  const url = new URL('/api/hookchart/liquidations', window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('exchange', exchange);
  url.searchParams.set('symbol', symbol);

  const connect = () => {
    if (stopped) return;
    let current: WebSocket;
    try { current = new WebSocket(url.toString()); }
    catch { schedule(); return; }
    socket = current;
    current.onmessage = event => {
      if (stopped || socket !== current) return;
      try {
        const packet = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (packet.type === 'snapshot' && Array.isArray(packet.events)) {
          failures = 0;
          onSnapshot(packet.events.slice(-1500).filter(validLiquidation), packet.connected === true);
        } else if (packet.type === 'liquidation' && validLiquidation(packet.event)) {
          onLiquidation(packet.event);
        } else if (packet.type === 'status') {
          onStatus(packet.connected === true);
        }
      } catch { /* reject invalid or unrelated messages */ }
    };
    current.onerror = () => { try { current.close(); } catch {} };
    current.onclose = () => {
      if (socket !== current || stopped) return;
      onStatus(false);
      socket = null;
      schedule();
    };
  };
  const schedule = () => {
    if (stopped || retry) return;
    retry = setTimeout(() => {
      retry = null;
      connect();
    }, Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)));
  };

  onStatus(false);
  connect();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    retry = null;
    try { socket?.close(); } catch {}
  };
}
