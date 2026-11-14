import type { ExchangeId, MarketType } from '../../types';
import { adaptiveCut, type MarketPrint } from './marketAnalytics';
import { fetchMarketTradeSeedJson } from './marketTradeSeed';

/** One public-trade transport and one adaptive threshold per exchange/market/symbol per browser tab. */
export type MarketTrade = { id: string; t: number; p: number; q: number; side: 'BUY' | 'SELL' };
export type AggressiveMarketTrade = { id: string; t: number; p: number; usd: number; side: 'BUY' | 'SELL' };
type Listener = { onTrade: (trade: AggressiveMarketTrade) => void; onPrints: (prints: MarketPrint[]) => void; wantsPrints?: () => boolean; liveOnly?: boolean };
type Burst = {
  id: string; side: 'BUY' | 'SELL'; start: number; last: number;
  usd: number; weightedPrice: number; count: number;
  seconds: Map<number, { usd: number; count: number; accountedUsd: number; accountedCount: number }>;
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
const PRINT_HISTORY_MS = 60 * 60_000;
const MAX_PRINT_SECONDS = 7200;

/** Exponential retry with per-browser jitter, to prevent mass reconnect bursts. */
export function marketTradeReconnectDelay(attempt: number, randomValue = Math.random()): number {
  const exponent = Number.isFinite(attempt) ? Math.max(0, Math.min(4, Math.floor(attempt))) : 0;
  const base = Math.min(20_000, 1000 * 2 ** exponent);
  const fraction = Number.isFinite(randomValue) ? Math.max(0, Math.min(1, randomValue)) : 0;
  return base + Math.floor(fraction * Math.min(1000, base));
}

/** Pure accumulator: skips overlapping REST/WS trade IDs before volume or threshold calculations. */
export class LargeMarketTradeTracker {
  private seen = new Map<string, number>();
  private seenPruneAt = 0;
  private sample: Array<{ t: number; usd: number }> = [];
  private sampleHead = 0;
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
    // Preserve *all* qualifying volume in per-second accumulators, not only
    // the last 40 individual bursts (which made busy BTC candles undercount).
    for (const [second, segment] of burst.seconds) {
      const delta = segment.usd - segment.accountedUsd;
      const countDelta = segment.count - segment.accountedCount;
      if (delta <= 0) continue;
      const id = burst.side + ':' + second;
      const previous = this.prints.get(id);
      const newUsd = (previous?.usd || 0) + delta;
      const weightedPrice = burst.weightedPrice / Math.max(burst.usd, 1);
      const item: MarketPrint = {
        id, side: burst.side, t: second,
        p: previous ? (previous.p * previous.usd + weightedPrice * delta) / newUsd : weightedPrice,
        usd: newUsd, count: (previous?.count || 0) + countDelta,
        touches: 1, lastTouch: burst.last,
        score: Math.min(100, Math.round(100 * newUsd / Math.max(1, this.cut * 2))),
      };
      this.prints.set(id, item);
      segment.accountedUsd = segment.usd;
      segment.accountedCount = segment.count;
      this.revision++;
    }
    // Bound the lifetime and memory of accumulated second buckets.
    while (this.prints.size > MAX_PRINT_SECONDS) this.prints.delete(this.prints.keys().next().value!);
  }

  accept(trade: MarketTrade): AggressiveMarketTrade | null {
    if (!trade.id || !Number.isFinite(trade.t) || !Number.isFinite(trade.p) ||
        !Number.isFinite(trade.q) || trade.p <= 0 || trade.q <= 0 ||
        (trade.side !== 'BUY' && trade.side !== 'SELL')) return null;
    // The exchange trade ID is unique within a symbol; never count its REST/WS replay twice.
    if (this.seen.has(trade.id)) return null;
    const usd = trade.p * trade.q;
    if (!Number.isFinite(usd) || usd <= 0) return null;
    this.seen.set(trade.id, trade.t);
    if (trade.t - this.seenPruneAt > 15_000) {
      const oldest = trade.t - 300_000;
      for (const [id, t] of this.seen) if (t < oldest) this.seen.delete(id);
      this.seenPruneAt = trade.t;
    }
    // Trim only the excess IDs: scanning all 30k IDs on every BTC trade
    // would be more expensive than the shared socket was meant to save.
    while (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.keys().next().value!);
    this.sample.push({ t: trade.t, usd });
    const windowStart = trade.t - 120_000;
    while (this.sampleHead < this.sample.length &&
      (this.sampleHead < this.sample.length - MAX_SAMPLE ||
        this.sample[this.sampleHead].t < windowStart)) this.sampleHead++;
    // Compact in blocks, not an 8192-element copy for every busy BTC tick.
    if (this.sampleHead > 1024) {
      this.sample = this.sample.slice(this.sampleHead);
      this.sampleHead = 0;
    }
    if (!this.cut || trade.t - this.cutAt > 3000) {
      this.cut = adaptiveCut(this.sample.slice(this.sampleHead).map(row => row.usd), .95, .995, 2.8);
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
        seconds: new Map([[second, { usd, count: 1, accountedUsd: 0, accountedCount: 0 }]]),
      };
    } else {
      this.active.last = trade.t;
      this.active.usd += usd;
      this.active.weightedPrice += trade.p * usd;
      this.active.count++;
      const segment = this.active.seconds.get(second) ||
        { usd: 0, count: 0, accountedUsd: 0, accountedCount: 0 };
      segment.usd += usd;
      segment.count++;
      this.active.seconds.set(second, segment);
    }
    // Publish the same group ID with its updated total, never append a second copy.
    this.commit();
    return { id: trade.id, t: trade.t, p: trade.p, usd, side: trade.side };
  }

  snapshot(now = Date.now()): MarketPrint[] {
    const cutoff = now - PRINT_HISTORY_MS;
    for (const [id, item] of this.prints) if (item.t < cutoff) this.prints.delete(id);
    return [...this.prints.values()].sort((a, b) => a.t - b.t);
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
  private recentHead = 0;
  private socket: WebSocket | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: MarketTrade[] = [];
  private buffering = true;
  private liveWithoutSeed = false;
  private stopped = false;
  private retries = 0;
  private abort = new AbortController();

  constructor(readonly scope: FeedScope) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (!listener.liveOnly) {
      const cutoff = Date.now() - 300_000;
      for (let i = this.recentHead; i < this.recent.length; i++) {
        const trade = this.recent[i];
        if (trade.t >= cutoff) {
          // One chart's callback must not break replay for a newly mounted
          // Terminal chart or leave it registered without a cleanup handle.
          try { listener.onTrade(trade); } catch { /* isolate faulty chart */ }
        }
      }
    }
    try {
      if (listener.wantsPrints?.() !== false) listener.onPrints(this.tracker.snapshot());
    } catch { /* an unavailable chart must not interrupt the shared feed */ }
    return () => this.listeners.delete(listener);
  }

  private publish() {
    if (this.publishTimer || this.stopped ||
        ![...this.listeners].some(listener => {
          try { return listener.wantsPrints?.() !== false; } catch { return false; }
        })) return;
    // One bounded update per 500ms per coin, and none when all charts hide the labels.
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      if (this.stopped) return;
      const watching = [...this.listeners].filter(listener => {
        try { return listener.wantsPrints?.() !== false; } catch { return false; }
      });
      if (!watching.length) return;
      const prints = this.tracker.snapshot();
      for (const listener of watching) {
        try { listener.onPrints(prints); } catch { /* keep other charts updating */ }
      }
    }, 500);
  }

  private accept(trade: MarketTrade, fromHistory = false) {
    const revision = this.tracker.revision;
    const accepted = this.tracker.accept(trade);
    if (!accepted) return;
    this.recent.push(accepted);
    if (this.recent.length - this.recentHead > 2500) this.recentHead++;
    if (this.recentHead > 512) {
      this.recent = this.recent.slice(this.recentHead);
      this.recentHead = 0;
    }
    for (const listener of [...this.listeners]) {
      if (fromHistory && listener.liveOnly) continue;
      try { listener.onTrade(accepted); } catch { /* isolate faulty chart */ }
    }
    if (revision !== this.tracker.revision) this.publish();
  }

  private receive(trade: MarketTrade) {
    if (this.stopped) return;
    if (this.buffering) {
      this.pending.push(trade);
      if (this.pending.length > 20000) {
        // A slow REST seed must never silently discard live execution amounts.
        // Fall back to the already-buffered WS events and disregard the stale
        // REST response when it eventually arrives.
        this.liveWithoutSeed = true;
        const buffered = this.pending.sort((a, b) => a.t - b.t);
        this.pending = [];
        this.buffering = false;
        for (const item of buffered) this.accept(item);
      }
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
            const data = await fetchMarketTradeSeedJson(host + path, this.abort.signal);
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
        const data = await fetchMarketTradeSeedJson(url, this.abort.signal);
        history = (data?.result?.list || []).map((row: any) => ({
          t: Number(row.time), p: Number(row.price), q: Number(row.size),
          side: String(row.side).toLowerCase() === 'sell' ? 'SELL' : 'BUY',
          id: String(row.execId ?? ''),
        }));
      }
    } catch {
      // A temporary REST failure must not prevent the live public-trade stream.
    }
    if (this.stopped || this.liveWithoutSeed) return;
    history.sort((a, b) => a.t - b.t);
    this.tracker.seedThreshold(history);
    // REST and WebSocket overlap by design; merge in time order and deduplicate by trade ID.
    const combined = [
      ...history.map(trade => ({ trade, fromHistory: true })),
      ...this.pending.map(trade => ({ trade, fromHistory: false })),
    ].sort((a, b) => a.trade.t - b.trade.t);
    this.pending = [];
    for (const { trade, fromHistory } of combined) this.accept(trade, fromHistory);
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
      // A socket that opens but closes immediately is not a successful
      // recovery. Preserve exponential backoff until the connection has
      // remained established for a meaningful interval.
      let openedAt = 0;
      ws.onopen = () => {
        if (this.stopped || this.socket !== ws) return;
        openedAt = Date.now();
        if (exchange !== 'binance') {
          try {
            ws.send(JSON.stringify({ op: 'subscribe', args: ['publicTrade.' + symbol] }));
          } catch {
            // A failed subscription is not a healthy open market feed.
            try { ws.close(); } catch {}
            reconnect();
            return;
          }
          this.ping = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              try { ws.send(JSON.stringify({ op: 'ping' })); }
              catch { try { ws.close(); } catch {} reconnect(); }
            }
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
        // A late close/error from an older socket must NEVER cancel the
        // heartbeat belonging to the already established replacement.
        if (this.stopped || this.socket !== ws || this.reconnectTimer) return;
        if (this.ping) { clearInterval(this.ping); this.ping = null; }
        // Only a stable connection resets the retry budget. Otherwise an
        // exchange that briefly accepts then drops connections would induce
        // a permanent one-second reconnect storm across Terminal coins.
        if (openedAt > 0 && Date.now() - openedAt >= 30_000) this.retries = 0;
        const delay = marketTradeReconnectDelay(this.retries++);
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, delay);
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
      ws.onclose = reconnect;
    } catch {
      if (!this.stopped && !this.reconnectTimer) {
        const delay = marketTradeReconnectDelay(this.retries++);
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
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
      if (!stream!.listeners.size && marketStreams.get(key) === stream) {
        marketStreams.delete(key);
        stream!.stop();
      }
    };
  }
  const unsubscribe = stream.subscribe(listener);
  return () => {
    unsubscribe();
    if (!stream!.listeners.size && marketStreams.get(key) === stream) {
      marketStreams.delete(key);
      stream!.stop();
    }
  };
}

export function getSharedMarketPrints(scope: FeedScope): MarketPrint[] {
  return marketStreams.get(scopeKey(scope))?.tracker.snapshot() ?? [];
}
