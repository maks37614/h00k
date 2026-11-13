import type { ExchangeId, Kline, MarketType } from '../../types';
import { normalizeExchangeSymbol } from '../../utils/marketSymbols';
import { validCandle } from '../../utils/hookchartData';

export type LiveKline = Kline & { eventTime?: number };
type Scope = { exchange: ExchangeId; marketType: MarketType; symbol: string; timeframe: string };
type Listener = { onCandle: (candle: LiveKline) => void; onStatus?: (connected: boolean) => void };
type SocketFactory = (url: string) => WebSocket;

const BINANCE_WS: Record<MarketType, string> = {
  futures: 'wss://fstream.binance.com/market/ws',
  spot: 'wss://stream.binance.com:9443/ws',
};
const BYBIT_WS: Record<MarketType, string> = {
  futures: 'wss://stream.bybit.com/v5/public/linear',
  spot: 'wss://stream.bybit.com/v5/public/spot',
};
const BINANCE_INTERVAL: Record<string, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d',
};
const BYBIT_INTERVAL: Record<string, string> = {
  '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D',
};

export function parseSharedKlineMessage(exchange: ExchangeId, payload: any, symbol: string, timeframe: string): LiveKline | null {
  let source: any = null;
  if (exchange === 'binance') {
    const envelope = payload?.data ?? payload;
    if (envelope?.e !== 'kline' || !envelope.k) return null;
    if (String(envelope.s || envelope.k.s || '').toUpperCase() !== symbol.toUpperCase()) return null;
    if (envelope.k.i !== BINANCE_INTERVAL[timeframe]) return null;
    const row = envelope.k;
    source = {
      time: Number(row.t) / 1000, open: Number(row.o), high: Number(row.h),
      low: Number(row.l), close: Number(row.c), volume: Number(row.v),
      tradeCount: Number(row.n),
      buyVolume: Number(row.V),
      eventTime: Number(envelope.E) || Date.now(),
    };
  } else {
    if (payload?.topic !== 'kline.' + BYBIT_INTERVAL[timeframe] + '.' + symbol) return null;
    const row = Array.isArray(payload.data) ? payload.data[0] : payload.data;
    if (!row) return null;
    source = {
      time: Number(row.start) / 1000, open: Number(row.open),
      high: Number(row.high), low: Number(row.low),
      close: Number(row.close), volume: Number(row.volume),
      eventTime: Number(payload.ts) || Date.now(),
    };
  }
  if (!Number.isSafeInteger(source.time) || !validCandle(source)) return null;
  return source;
}

/** One kline WebSocket per exchange/market/symbol/timeframe in this browser tab. */
export function createSharedKlineSubscriptions(socketFactory: SocketFactory = url => new WebSocket(url)) {
  type Entry = {
    listeners: Set<Listener>; socket: WebSocket | null; closed: boolean;
    ping: ReturnType<typeof setInterval> | null; retry: ReturnType<typeof setTimeout> | null;
    failures: number; connected: boolean; last: LiveKline | null; stop: () => void;
  };
  const entries = new Map<string, Entry>();
  const subscribe = (scope: Scope, listener: Listener): (() => void) => {
    const symbol = normalizeExchangeSymbol(scope.symbol);
    if (!/^[A-Z0-9]{3,30}$/.test(symbol) || !BINANCE_INTERVAL[scope.timeframe] ||
        !['binance', 'bybit'].includes(scope.exchange) ||
        !['futures', 'spot'].includes(scope.marketType)) {
      listener.onStatus?.(false);
      return () => {};
    }
    const key = [scope.exchange, scope.marketType, symbol, scope.timeframe].join(':');
    let entry = entries.get(key);
    if (entry) {
      const shared = entry;
      shared.listeners.add(listener);
      listener.onStatus?.(shared.connected);
      if (shared.last) listener.onCandle(shared.last);
      return () => {
        shared.listeners.delete(listener);
        if (!shared.listeners.size && entries.get(key) === shared) {
          entries.delete(key);
          shared.stop();
        }
      };
    }

    const shared: Entry = {
      listeners: new Set([listener]), socket: null, closed: false, ping: null,
      retry: null, failures: 0, connected: false, last: null, stop: () => {},
    };
    entries.set(key, shared);
    const status = (connected: boolean) => {
      if (shared.connected === connected) return;
      shared.connected = connected;
      for (const sub of [...shared.listeners]) {
        try { sub.onStatus?.(connected); } catch {}
      }
    };
    const clearPing = () => {
      if (shared.ping !== null) clearInterval(shared.ping);
      shared.ping = null;
    };
    const reconnect = () => {
      clearPing();
      status(false);
      if (shared.closed || shared.retry !== null) return;
      // Jitter prevents hundreds of users reconnecting on the exact same millisecond.
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(5, shared.failures++));
      shared.retry = setTimeout(() => {
        shared.retry = null;
        connect();
      }, delay + Math.floor(Math.random() * Math.min(1000, delay)));
    };
    const connect = () => {
      if (shared.closed) return;
      let ws: WebSocket;
      try {
        const url = scope.exchange === 'binance'
          ? BINANCE_WS[scope.marketType] + '/' + encodeURIComponent(symbol.toLowerCase()) +
            '@kline_' + BINANCE_INTERVAL[scope.timeframe]
          : BYBIT_WS[scope.marketType];
        ws = socketFactory(url);
      } catch {
        reconnect();
        return;
      }
      shared.socket = ws;
      ws.onopen = () => {
        if (shared.closed || shared.socket !== ws) return;
        shared.failures = 0;
        if (scope.exchange === 'bybit') {
          try {
            ws.send(JSON.stringify({ op: 'subscribe',
              args: ['kline.' + BYBIT_INTERVAL[scope.timeframe] + '.' + symbol] }));
          } catch { ws.close(); return; }
          shared.ping = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              try { ws.send(JSON.stringify({ op: 'ping' })); } catch { ws.close(); }
            }
          }, 20_000);
        }
        status(true);
      };
      ws.onmessage = event => {
        if (shared.closed || shared.socket !== ws) return;
        try {
          const candle = parseSharedKlineMessage(scope.exchange, JSON.parse(String(event.data)), symbol, scope.timeframe);
          if (!candle) return;
          if (shared.last && candle.time < shared.last.time) return;
          shared.last = candle;
          for (const sub of [...shared.listeners]) {
            try { sub.onCandle(candle); } catch {}
          }
        } catch {}
      };
      ws.onerror = () => { if (!shared.closed && shared.socket === ws) try { ws.close(); } catch {} };
      ws.onclose = () => { if (shared.socket === ws) reconnect(); };
    };
    shared.stop = () => {
      shared.closed = true;
      if (shared.retry !== null) clearTimeout(shared.retry);
      shared.retry = null;
      clearPing();
      status(false);
      shared.socket?.close();
      shared.socket = null;
    };
    listener.onStatus?.(false);
    connect();
    return () => {
      shared.listeners.delete(listener);
      if (!shared.listeners.size && entries.get(key) === shared) {
        entries.delete(key);
        shared.stop();
      }
    };
  };
  return { subscribe, activeScopes: () => entries.size };
}

export const subscribeSharedKlines = createSharedKlineSubscriptions().subscribe;
