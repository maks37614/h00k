import type { ExchangeId, MarketType } from '../../types';
import { adaptiveCut, type MarketPrint } from './marketAnalytics';

/** One public-trade transport and one adaptive threshold per exchange/market/symbol per browser tab. */
export type MarketTrade = { id: string; t: number; p: number; q: number; side: 'BUY' | 'SELL' };
export type AggressiveMarketTrade = { id: string; t: number; p: number; usd: number; side: 'BUY' | 'SELL' };
type Listener = { onTrade: (trade: AggressiveMarketTrade) => void; onPrints: (prints: MarketPrint[]) => void };
type Burst = {
  id: string; side: 'BUY' | 'SELL'; start: number; last: number;
  usd: number; weightedPrice: number; count: number;
  seconds: Map<number, number>;
};

const BINANCE_FUTURES_API = 'https://fapi.binance.com';
const BINANCE_SPOT_APIS = ['https://data-api.binance.vision', 'https://api.binance.com'];
const BYBIT_API = 'https://api.bybit.com';
const BINANCE_FUTURES_WS = 'wss://fstream.binance.com/market/ws';
const BINANCE_SPOT_WS = 'wss://stream.binance.com:9443/ws';
const BYBIT_WS = {
  futures: 'wss://stream.bybit.com/v5/public/linear',
  spot: 'wss://stream.bybit.com/v5/public/spot',
} as const;
const MAX_SAMPLE = 8192;
const MAX_SEEN = 30000;

/** Pure accumulator: skips overlapping REST/WS trade IDs before volume or threshold calculations. */
export class LargeMarketTradeTracker {
  private seen = new Map<string, number>();
  private seenPruneAt = 0;
  private sample: Array<{ t: number; usd: number }> = [];
  private active: Burst | null = null;
  private prints = new Map<string, MarketPrint>();
  private cut = 0;
  private cutAt = 0;
  revision = 0;

  get thresholdUsd() { return this.cut; }

  seedThreshold(rows: readonly MarketTrade[]) {
    const notionals = rows.filter(trade => trade.p > 0 && trade.q > 0)
      .map(trade => trade.p * trade.q).filter(Number.isFinite);
    if (notionals.length) {
      this.cut = adaptiveCut(notionals, .95, .995, 2.8);
      this.cutAt = Math.max(...rows.map(row => row.t).filter(Number.isFinite), 0);
    }
  }

  private commit() {
    const burst = this.active;
    if (!burst || !this.cut || burst.usd < this.cut) return;
    const item: MarketPrint = {
      id: burst.id, side: burst.side, t: burst.start,
      p: burst.weightedPrice / burst.usd, usd: burst.usd,
      count: burst.count, touches: 1, lastTouch: burst.last,
      score: Math.min(100, Math.round(100 * burst.usd / Math.max(1, this.cut * 2))),
      segments: [...burst.seconds].map(([t, usd]) => ({ t, usd })),
    };
    this.prints.set(item.id, item);
    while (this.prints.size > 60) this.prints.delete(this.prints.keys().next().value!);
    this.revision++;
  }

  accept(trade: MarketTrade): AggressiveMarketTrade | null {
    if (!trade.id || !Number.isFinite(trade.t) || !Number.isFinite(trade.p) ||
        !Number.isFinite(trade.q) || trade.p <= 0 || trade.q <= 0 ||
        (trade.side !== 'BUY' && trade.side !== 'SELL')) return null;
    // The exchange trade ID is unique within a symbol; never count its REST/WS replay twice.
    if (this.seen.has(trade.id)) return null;
    this.seen.set(trade.id, trade.t);
    if (this.seen.size > MAX_SEEN || trade.t - this.seenPruneAt > 15_000) {
      const oldest = trade.t - 300_000;
      for (const [id, t] of this.seen) {
        if (t < oldest || this.seen.size > MAX_SEEN) this.seen.delete(id);
      }
      this.seenPruneAt = trade.t;
    }
    const usd = trade.p * trade.q;
    if (!Number.isFinite(usd) || usd <= 0) return null;
    this.sample.push({ t: trade.t, usd });
    const windowStart = trade.t - 120_000;
    if (this.sample.length > MAX_SAMPLE || (this.sample[0] && this.sample[0].t < windowStart)) {
      let start = 0;
      while (start < this.sample.length && this.sample[start].t < windowStart) start++;
      this.sample = this.sample.slice(Math.max(start, this.sample.length - MAX_SAMPLE));
    }
    if (!this.cut || trade.t - this.cutAt > 3000) {
      this.cut = adaptiveCut(this.sample.map(row => row.usd), .95, .995, 2.8);
      this.cutAt = trade.t;
    }
    const second = Math.floor(trade.t / 1000) * 1000;
    if (!this.active || this.active.side !== trade.side ||
        trade.t - this.active.last > 450 || trade.t - this.active.start > 1400) {
      this.commit();
      this.active = {
        id: trade.side + ':' + trade.t + ':' + trade.id,
        side: trade.side, start: trade.t, last: trade.t,
        usd, weightedPrice: trade.p * usd, count: 1,
        seconds: new Map([[second, usd]]),
      };
    } else {
      this.active.last = trade.t;
      this.active.usd += usd;
      this.active.weightedPrice += trade.p * usd;
      this.active.count++;
      this.active.seconds.set(second, (this.active.seconds.get(second) || 0) + usd);
    }
    // Publish the same group ID with its updated total, never append a second copy.
    this.commit();
    return { id: trade.id, t: trade.t, p: trade.p, usd, side: trade.side };
  }

  snapshot(now = Date.now()): MarketPrint[] {
    return [...this.prints.values()]
      .filter(row => row.t >= now - 6 * 60 * 60_000)
      .sort((a, b) => a.t - b.t).slice(-40);
  }
}

type FeedScope = { exchange: ExchangeId; marketType: MarketType; symbol: string };

const marketStreams = new Map<string, SharedMarketTradeStream>();
const scopeKey = ({ exchange, marketType, symbol }: FeedScope) =>
  exchange + ':' + marketType + ':' + symbol.toUpperCase();

class SharedMarketTradeStream {
  readonly tracker = new LargeMarketTradeTracker();
  readonly listeners = new Set<Listener>();
  private recent: AggressiveMarketTrade[] = [];
  private socket: WebSocket | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: MarketTrade[] = [];
  private buffering = true;
  private stopped = false;
  private retries = 0;
  private abort = new AbortController();

  constructor(readonly scope: FeedScope) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    for (const trade of this.recent) if (trade.t >= Date.now() - 300_000) listener.onTrade(trade);
    listener.onPrints(this.tracker.snapshot());
    return () => this.listeners.delete(listener);
  }

  private publish() {
    if (this.publishTimer || this.stopped) return;
    // One state update per 150ms per coin, not one render per incoming print.
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      if (this.stopped) return;
      const prints = this.tracker.snapshot();
      for (const listener of this.listeners) listener.onPrints(prints);
    }, 150);
  }

  private accept(trade: MarketTrade) {
    const revision = this.tracker.revision;
    const accepted = this.tracker.accept(trade);
    if (!accepted) return;
    this.recent.push(accepted);
    if (this.recent.length > 2500) this.recent.splice(0, this.recent.length - 2500);
    for (const listener of this.listeners) listener.onTrade(accepted);
    if (revision !== this.tracker.revision) this.publish();
  }

  private receive(trade: MarketTrade) {
    if (this.stopped) return;
    if (this.buffering) {
      this.pending.push(trade);
      if (this.pending.length > 20000) this.pending.shift();
    } else this.accept(trade);
  }

  async start() {
    this.connect();
    let history: MarketTrade[] = [];
    try {
      const { exchange, marketType, symbol } = this.scope;
      if (exchange === 'binance') {
        const path = (marketType === 'futures' ? '/fapi/v1/aggTrades' : '/api/v3/aggTrades') +
          '?symbol=' + encodeURIComponent(symbol) + '&limit=1000';
        const hosts = marketType === 'futures' ? [BINANCE_FUTURES_API] : BINANCE_SPOT_APIS;
        for (const host of hosts) {
          try {
            const response = await fetch(host + path, { signal: this.abort.signal, cache: 'no-store' });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const data = await response.json();
            history = (Array.isArray(data) ? data : []).map((row: any) => ({
              t: Number(row.T), p: Number(row.p), q: Number(row.q),
              side: row.m ? 'SELL' : 'BUY', id: String(row.a ?? ''),
            }));
            break;
          } catch (error) {
            if (this.abort.signal.aborted) throw error;
          }
        }
      } else {
        const category = marketType === 'futures' ? 'linear' : 'spot';
        const url = BYBIT_API + '/v5/market/recent-trade?category=' + category +
          '&symbol=' + encodeURIComponent(symbol) + '&limit=1000';
        const response = await fetch(url, { signal: this.abort.signal, cache: 'no-store' });
        if (response.ok) {
          const data = await response.json();
          history = (data?.result?.list || []).map((row: any) => ({
            t: Number(row.time), p: Number(row.price), q: Number(row.size),
            side: String(row.side).toLowerCase() === 'sell' ? 'SELL' : 'BUY',
            id: String(row.execId ?? ''),
          }));
        }
      }
    } catch {
      // A temporary REST failure must not prevent the live public-trade stream.
    }
    if (this.stopped) return;
    history.sort((a, b) => a.t - b.t);
    this.tracker.seedThreshold(history);
    // REST and WebSocket overlap by design; merge in time order and deduplicate by trade ID.
    const combined = history.concat(this.pending).sort((a, b) => a.t - b.t);
    this.pending = [];
    for (const trade of combined) this.accept(trade);
    this.buffering = false;
  }

  private connect() {
    if (this.stopped) return;
    const { exchange, marketType, symbol } = this.scope;
    try {
      const ws = exchange === 'binance'
        ? new WebSocket((marketType === 'futures' ? BINANCE_FUTURES_WS : BINANCE_SPOT_WS) +
          '/' + encodeURIComponent(symbol.toLowerCase()) + '@aggTrade')
        : new WebSocket(BYBIT_WS[marketType]);
      this.socket = ws;
      ws.onopen = () => {
        if (this.stopped || this.socket !== ws) return;
        this.retries = 0;
        if (exchange !== 'binance') {
          ws.send(JSON.stringify({ op: 'subscribe', args: ['publicTrade.' + symbol] }));
          this.ping = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) try { ws.send(JSON.stringify({ op: 'ping' })); } catch {}
          }, 20_000);
        }
      };
      ws.onmessage = event => {
        if (this.stopped || this.socket !== ws) return;
        try {
          const data = JSON.parse(event.data);
          if (exchange === 'binance') {
            this.receive({
              t: Number(data.T), p: Number(data.p), q: Number(data.q),
              side: data.m ? 'SELL' : 'BUY', id: String(data.a ?? ''),
            });
          } else if (data.topic === 'publicTrade.' + symbol && Array.isArray(data.data)) {
            const trades: MarketTrade[] = data.data.map((row: any) => ({
              t: Number(row.T), p: Number(row.p), q: Number(row.v),
              side: String(row.S).toLowerCase() === 'sell' ? 'SELL' : 'BUY',
              id: String(row.i ?? ''),
            }));
            trades.sort((a, b) => a.t - b.t);
            for (const trade of trades) this.receive(trade);
          }
        } catch {}
      };
      const reconnect = () => {
        if (this.ping) { clearInterval(this.ping); this.ping = null; }
        if (this.stopped || this.socket !== ws || this.reconnectTimer) return;
        const delay = Math.min(20_000, 1000 * 2 ** Math.min(4, this.retries++));
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, delay);
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
      ws.onclose = reconnect;
    } catch {
      if (!this.stopped && !this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, 2000);
      }
    }
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
    if (this.ping) clearInterval(this.ping);
    if (this.publishTimer) clearTimeout(this.publishTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.listeners.clear();
    this.socket?.close();
  }
}

/** Subscribe from each chart without opening a second WebSocket or repeating the REST seed. */
export function subscribeMarketTrades(scope: FeedScope, listener: Listener): () => void {
  const key = scopeKey(scope);
  let stream = marketStreams.get(key);
  if (!stream) {
    stream = new SharedMarketTradeStream({ ...scope, symbol: scope.symbol.toUpperCase() });
    marketStreams.set(key, stream);
    const unsubscribe = stream.subscribe(listener);
    void stream.start();
    return () => {
      unsubscribe();
      if (!stream!.listeners.size) { stream!.stop(); marketStreams.delete(key); }
    };
  }
  const unsubscribe = stream.subscribe(listener);
  return () => {
    unsubscribe();
    if (!stream!.listeners.size) { stream!.stop(); marketStreams.delete(key); }
  };
}

export function getSharedMarketPrints(scope: FeedScope): MarketPrint[] {
  return marketStreams.get(scopeKey(scope))?.tracker.snapshot() ?? [];
}
