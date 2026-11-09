import type { ExchangeId, MarketType } from '../../src/types';
import { normalizeExchangeSymbol } from '../../src/utils/marketSymbols';
import { ExchangeStreamClient, type RawDepthDelta } from './exchangeStream';
import { isFreshDepthTime, parseDepthLevels } from '../../src/utils/orderBookValidation';

type Listener = (...args: any[]) => void;
type Entry = {
  key: string;
  source: ExchangeStreamClient;
  refs: number;
  lastResyncAt: number;
  bids: Map<number, number>;
  asks: Map<number, number>;
  depthSequence: number;
  depthEventTime: number;
  depthReceivedAt: number;
};

const entries = new Map<string, Entry>();
let isolatedStreamCounter = 0;

/**
 * Ref-count public exchange streams by instrument. Each consumer owns only its
 * listeners, so a user's worker can stop without tearing down the exchange
 * socket used by other users. No private user/alert data lives in this registry.
 */
export class SharedExchangeStreamHandle {
  private readonly entry: Entry;
  private readonly handlers: Array<[string, Listener]> = [];
  private disposed = false;

  constructor(symbol: string, exchange: ExchangeId, market: MarketType, depthOnly = false) {
    const cleanSymbol = normalizeExchangeSymbol(symbol);
    const baseKey = `${exchange}:${market}:${cleanSymbol}:${depthOnly ? 'depth' : 'full'}`;
    // Emergency rollback option for a rollout if consumers must use the
    // original one-source-per-worker behavior until a regression is fixed.
    const key = process.env.H00K_SHARED_STREAMS === '0'
      ? `${baseKey}:isolated:${++isolatedStreamCounter}` : baseKey;
    let entry = entries.get(key);
    if (!entry) {
      const source = new ExchangeStreamClient(cleanSymbol, exchange, market, depthOnly);
      // Do not issue a memory-leak warning for many legitimate subscribers.
      // The registry still drops each consumer's listeners at release time.
      source.setMaxListeners(0);
      entry = { key, source, refs: 0, lastResyncAt: 0,
        bids: new Map(), asks: new Map(), depthSequence: 0, depthEventTime: 0, depthReceivedAt: 0 };
      entries.set(key, entry);
      // Maintain an instrument-level snapshot so a subscriber joining an
      // already-running WS can initialize its own book without reconnecting
      // or resetting the stream for every existing user.
      const shared = entry;
      source.on('status', (status: string) => {
        if (status !== 'LIVE') {
          shared.depthSequence = 0;
          shared.depthReceivedAt = 0;
          shared.bids.clear(); shared.asks.clear();
        }
      });
      source.on('depth', (delta: RawDepthDelta) => {
        const bids = parseDepthLevels(delta.bids), asks = parseDepthLevels(delta.asks);
        const time = delta.eventTime ?? Date.now();
        if (!bids || !asks || !Number.isSafeInteger(delta.sequence) ||
            delta.sequence! <= 0 || !isFreshDepthTime(time)) {
          shared.depthSequence = 0;
          shared.bids.clear(); shared.asks.clear();
          return;
        }
        if (delta.isSnapshot) {
          shared.bids.clear(); shared.asks.clear();
        } else if (!shared.depthSequence || delta.sequence! <= shared.depthSequence) {
          return;
        }
        for (const [p, q] of bids) q > 0 ? shared.bids.set(p, q) : shared.bids.delete(p);
        for (const [p, q] of asks) q > 0 ? shared.asks.set(p, q) : shared.asks.delete(p);
        shared.depthSequence = delta.sequence!;
        shared.depthEventTime = time;
        shared.depthReceivedAt = Date.now();
      });
    }
    entry.refs++;
    this.entry = entry;
  }

  get status() { return this.entry.source.status; }

  on(event: string, listener: Listener): this {
    if (this.disposed) return this;
    this.entry.source.on(event, listener);
    this.handlers.push([event, listener]);
    if (event === 'depth' && this.entry.depthSequence > 0) {
      const entry = this.entry;
      queueMicrotask(() => {
        if (this.disposed || !this.handlers.some(([type, fn]) => type === 'depth' && fn === listener) ||
            !entry.depthSequence || Date.now() - entry.depthReceivedAt > 5_000 ||
            !isFreshDepthTime(entry.depthEventTime) || !entry.bids.size || !entry.asks.size) return;
        listener({ isSnapshot: true, sequence: entry.depthSequence, eventTime: entry.depthEventTime,
          bids: [...entry.bids], asks: [...entry.asks] } satisfies RawDepthDelta);
      });
    }
    return this;
  }

  removeAllListeners(): this {
    for (const [event, listener] of this.handlers) this.entry.source.removeListener(event, listener);
    this.handlers.length = 0;
    return this;
  }

  /** Multiple users noticing the same order-book gap must request one resync. */
  resyncOrderBook() {
    if (this.disposed) return;
    const now = Date.now();
    if (now - this.entry.lastResyncAt < 1_000) return;
    this.entry.lastResyncAt = now;
    this.entry.source.resyncOrderBook();
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.removeAllListeners();
    if (--this.entry.refs === 0 && entries.get(this.entry.key) === this.entry) {
      entries.delete(this.entry.key);
      this.entry.source.destroy();
    }
  }
}

export function acquireExchangeStream(symbol: string, exchange: ExchangeId,
  market: MarketType, depthOnly = false): SharedExchangeStreamHandle {
  return new SharedExchangeStreamHandle(symbol, exchange, market, depthOnly);
}

export function getSharedExchangeStreamStats() {
  return Array.from(entries.values(), entry => ({ scope: entry.key, subscribers: entry.refs }));
}
