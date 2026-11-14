import type { Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import type { ExchangeId, MarketType } from '../src/types';
import { normalizeExchangeSymbol } from '../src/utils/marketSymbols';
import { parseSharedKlineMessage, type LiveKline } from '../src/components/hookchart/sharedKlineStream';

type Scope = { exchange: ExchangeId; market: MarketType; symbol: string; timeframe: string };
type SourceFactory = (url: string) => WebSocket;
type Entry = {
  key: string;
  scope: Scope;
  clients: Set<WebSocket>;
  upstream: WebSocket | null;
  retry: ReturnType<typeof setTimeout> | null;
  ping: ReturnType<typeof setInterval> | null;
  failures: number;
  last: LiveKline | null;
  lastReceivedAt: number;
  closed: boolean;
};

const BINANCE_INTERVALS = new Set(['1m', '5m', '15m', '1h', '4h', '1d']);
const BYBIT_INTERVALS: Record<string, string> = {
  '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D',
};

function maxConfigured(key: string, fallback: number, absoluteMax: number) {
  const value = Number(process.env[key]);
  return Number.isSafeInteger(value) && value >= 1 ? Math.min(value, absoluteMax) : fallback;
}
function parseScope(requestUrl: string): Scope | null {
  const q = new URL(requestUrl, 'http://localhost').searchParams;
  const exchange = q.get('exchange'), market = q.get('market');
  const symbol = normalizeExchangeSymbol(q.get('symbol') || '');
  const timeframe = q.get('timeframe') || '';
  if ((exchange !== 'binance' && exchange !== 'bybit') ||
      (market !== 'futures' && market !== 'spot') ||
      !/^[A-Z0-9]{3,30}$/.test(symbol) || !BINANCE_INTERVALS.has(timeframe)) return null;
  return { exchange, market, symbol, timeframe };
}
function sourceUrl({ exchange, market, symbol, timeframe }: Scope) {
  if (exchange === 'binance')
    return (market === 'futures' ? 'wss://fstream.binance.com/market/ws/' : 'wss://stream.binance.com:9443/ws/') +
      symbol.toLowerCase() + '@kline_' + timeframe;
  return market === 'futures'
    ? 'wss://stream.bybit.com/v5/public/linear'
    : 'wss://stream.bybit.com/v5/public/spot';
}

/**
 * Public, single-process market-data fanout. No user IDs, auth or per-user
 * settings enter the shared cache. This relay is ONLY for live kline candles.
 * Replay remains historical and never connects to this endpoint.
 */
export function installHookChartKlineRelay(
  server: Server,
  connectExchange: SourceFactory = url => new WebSocket(url, { handshakeTimeout: 8000 }),
) {
  const clients = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const entries = new Map<string, Entry>();
  const limitClients = maxConfigured('H00K_MAX_KLINE_CLIENTS', 128, 2000);
  const limitScopes = maxConfigured('H00K_MAX_KLINE_MARKETS', 48, 512);
  const counters = { accepted: 0, rejected: 0, reconnects: 0, failures: 0, sent: 0, slowConsumers: 0 };
  let closed = false;
  const keyOf = (scope: Scope) => [scope.exchange, scope.market, scope.symbol, scope.timeframe].join(':');

  const send = (ws: WebSocket, encoded: string) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 512_000) {
      counters.slowConsumers++;
      ws.close(1013, 'Slow chart consumer');
      return;
    }
    try { ws.send(encoded); counters.sent++; }
    catch { try { ws.close(); } catch {} }
  };
  const broadcast = (entry: Entry, encoded: string) => {
    for (const ws of entry.clients) send(ws, encoded);
  };
  const stop = (entry: Entry) => {
    entry.closed = true;
    if (entry.retry) clearTimeout(entry.retry);
    if (entry.ping) clearInterval(entry.ping);
    entry.retry = entry.ping = null;
    const ws = entry.upstream;
    entry.upstream = null;
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => {});
      try { ws.close(); } catch {}
    }
  };
  const release = (entry: Entry, client: WebSocket) => {
    entry.clients.delete(client);
    if (!entry.clients.size && entries.get(entry.key) === entry) {
      entries.delete(entry.key);
      stop(entry);
    }
  };
  const schedule = (entry: Entry) => {
    if (entry.closed || closed || entry.retry !== null) return;
    counters.reconnects++;
    const base = Math.min(30_000, 1000 * 2 ** Math.min(5, entry.failures++));
    entry.retry = setTimeout(() => {
      entry.retry = null;
      connect(entry);
    }, base + Math.floor(Math.random() * 1000));
  };
  const connect = (entry: Entry) => {
    if (entry.closed || closed) return;
    let ws: WebSocket;
    try { ws = connectExchange(sourceUrl(entry.scope)); }
    catch {
      counters.failures++;
      schedule(entry);
      return;
    }
    entry.upstream = ws;
    ws.on('open', () => {
      if (entry.closed || entry.upstream !== ws) return;
      entry.failures = 0;
      if (entry.scope.exchange === 'bybit') {
        try {
          ws.send(JSON.stringify({ op: 'subscribe', args: [
            'kline.' + BYBIT_INTERVALS[entry.scope.timeframe] + '.' + entry.scope.symbol,
          ] }));
        } catch { try { ws.close(); } catch {} return; }
        entry.ping = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ op: 'ping' })); }
            catch { try { ws.close(); } catch {} }
          }
        }, 20_000);
      }
    });
    ws.on('message', data => {
      if (entry.closed || entry.upstream !== ws) return;
      try {
        const candle = parseSharedKlineMessage(entry.scope.exchange,
          JSON.parse(data.toString()), entry.scope.symbol, entry.scope.timeframe);
        if (!candle) return;
        const previous = entry.last;
        if (previous && (candle.time < previous.time ||
            (candle.time === previous.time &&
              ((candle.eventTime ?? 0) < (previous.eventTime ?? 0) ||
                candle.volume < previous.volume)))) return;
        entry.last = candle;
        entry.lastReceivedAt = Date.now();
        // Serialize once for every chart subscribed to this public instrument.
        broadcast(entry, JSON.stringify({ type: 'kline', candle }));
      } catch { counters.failures++; }
    });
    const disconnected = () => {
      if (entry.closed || entry.upstream !== ws) return;
      entry.upstream = null;
      if (entry.ping !== null) clearInterval(entry.ping);
      entry.ping = null;
      broadcast(entry, JSON.stringify({ type: 'status', connected: false }));
      schedule(entry);
    };
    ws.on('close', disconnected);
    ws.on('error', () => {
      counters.failures++;
      try { ws.close(); } catch {}
      disconnected();
    });
  };

  server.on('upgrade', (request, socket, head) => {
    if ((request.url || '').split('?')[0] !== '/api/hookchart/klines') return;
    if (closed) { socket.destroy(); return; }
    clients.handleUpgrade(request, socket, head, ws => clients.emit('connection', ws, request));
  });
  clients.on('connection', (client, request) => {
    const scope = parseScope(request.url || '');
    if (!scope) { counters.rejected++; client.close(1008, 'Invalid market'); return; }
    const key = keyOf(scope);
    if (clients.clients.size > limitClients || (!entries.has(key) && entries.size >= limitScopes)) {
      counters.rejected++;
      client.close(1013, 'Kline capacity reached');
      return;
    }
    let entry = entries.get(key);
    if (!entry) {
      entry = { key, scope, clients: new Set(), upstream: null, retry: null,
        ping: null, failures: 0, last: null, lastReceivedAt: 0, closed: false };
      entries.set(key, entry);
    }
    entry.clients.add(client);
    counters.accepted++;
    send(client, JSON.stringify({ type: 'status', connected: !!entry.last &&
      Date.now() - entry.lastReceivedAt < 15_000 }));
    if (entry.last && Date.now() - entry.lastReceivedAt < 15_000)
      send(client, JSON.stringify({ type: 'kline', candle: entry.last }));
    if (!entry.upstream && entry.retry === null) connect(entry);
    const held = entry;
    client.on('close', () => release(held, client));
    client.on('error', () => { release(held, client); client.terminate(); });
    client.on('message', () => client.close(1008, 'Read-only stream'));
  });
  // If the upstream is silent, clients must be free to use their direct
  // exchange fallback instead of falsely treating a connected VPS as live.
  const watchdog = setInterval(() => {
    const now = Date.now();
    for (const entry of entries.values()) {
      if (entry.lastReceivedAt && now - entry.lastReceivedAt > 25_000) {
        entry.lastReceivedAt = 0;
        entry.last = null;
        broadcast(entry, JSON.stringify({ type: 'status', connected: false }));
        // Do not leave a silent but OPEN exchange socket hanging forever.
        if (entry.upstream) {
          try { entry.upstream.close(); } catch {}
        }
      }
    }
  }, 5000);
  watchdog.unref();
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(watchdog);
    for (const entry of entries.values()) stop(entry);
    entries.clear();
    for (const socket of clients.clients) socket.terminate();
    clients.close();
  };
  server.once('close', close);
  return {
    close,
    stats: () => ({
      activeMarkets: entries.size,
      clients: [...entries.values()].reduce((sum, item) => sum + item.clients.size, 0),
      upstreamSockets: [...entries.values()].filter(item =>
        item.upstream?.readyState === WebSocket.OPEN).length,
      ...counters,
      // No symbols or personal identifiers in this aggregate operator view.
    }),
  };
}
