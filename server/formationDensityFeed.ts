import type { RawDepthDelta } from './surveillance/exchangeStream';
import { acquireExchangeStream, type SharedExchangeStreamHandle } from './surveillance/sharedExchangeStream';
import { OrderBookEngine } from './surveillance/orderBookEngine';
import { getPaperFormationSnapshots } from './marketService';
import type { DensityItem, OrderBookState } from './surveillance/types';
import type { ExchangeId } from '../src/types';

/**
 * The exchange engine ranks densities by notional, so a top-30 cut can hide
 * a real smaller wall directly at the intended entry. Reserve room for both
 * sides of the nearest *verified* persistent walls before filling remaining
 * places with the largest exchange-observed walls.
 *
 * This only selects existing observed depths; no quality gate is loosened,
 * no additional market scan/stream is started, and execution still independently
 * checks distance <= 0.8% from the actual Ev-Test entry.
 */
export function selectMonDensities(densities: DensityItem[], mid: number): DensityItem[] {
  const max = 30;
  if (!(Number.isFinite(mid) && mid > 0)) return densities.slice(0, max);
  const distance = (d: DensityItem) => Math.abs(d.price - mid) / mid * 100;
  const nearVerified = (d: DensityItem) =>
    d.classification === 'PERSISTENT_LIQUIDITY' &&
    d.ageSeconds >= 15 && Number(d.qualityScore) >= 45 &&
    Number.isFinite(d.price) && d.price > 0 && distance(d) <= 1.25;
  const nearSort = (a: DensityItem, b: DensityItem) =>
    distance(a) - distance(b) ||
    Number(b.qualityScore || 0) - Number(a.qualityScore || 0) ||
    b.notionalUsd - a.notionalUsd;
  const reserved = (['BID','ASK'] as const).flatMap(side =>
    densities.filter(d => d.side === side && nearVerified(d))
      .sort(nearSort).slice(0, 12));
  const selected = new Set(reserved.map(d => d.id));
  const rest = densities.filter(d => !selected.has(d.id))
    .sort((a,b) => Number(nearVerified(b)) - Number(nearVerified(a)) ||
      b.notionalUsd - a.notionalUsd);
  return [...reserved, ...rest].slice(0, max);
}

/** Maximum number of market-depth streams hosted for the separate trading bot. */
export const MON_DEPTH_STREAM_CAP = 8;
type Entry = {
  stream: SharedExchangeStreamHandle;
  engine: OrderBookEngine;
  instrument: string;
  lastEligibleAt: number;
  tradeQuote?: { exchange: ExchangeId; marketType: "futures"; symbol: string;
    price: number; updatedAt: number };
};

/** No private or simulated liquidity: synchronized exchange WS books only. */
export class FormationDensityFeed {
  private streams = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | null = null;

  start() {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 15_000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const item of this.streams.values()) item.stream.destroy();
    this.streams.clear();
  }
  refresh(now = Date.now()) {
    const ranked = new Map<string, { exchange: ExchangeId; symbol: string; volume: number }>();
    for (const snapshot of getPaperFormationSnapshots(now)) {
      for (const coin of snapshot.data) {
        if (coin.marketType !== 'futures' || !coin.formations.length ||
          !coin.formationData?.contiguous ||
          now - coin.formationData.collectedAt > 180_000 ||
          !/^[A-Z0-9]{3,40}$/.test(coin.symbol)) continue;
        const key = coin.exchange + ':futures:' + coin.symbol;
        const volume = Number.isFinite(coin.volume24hUsd) ? coin.volume24hUsd : 0;
        if (!ranked.has(key) || ranked.get(key)!.volume < volume)
          ranked.set(key, { exchange: coin.exchange, symbol: coin.symbol, volume });
      }
    }
    const candidates = [...ranked].sort((a, b) => b[1].volume - a[1].volume);
    // Retain existing eligible streams before adding new ones, avoiding churn
    // and fake persistence resets with each 60-second formation cycle.
    const eligible = new Set(ranked.keys());
    const retained = [...this.streams.keys()].filter(key => eligible.has(key));
    const chosen = new Set([...retained, ...candidates.map(([key]) => key)].slice(0, MON_DEPTH_STREAM_CAP));
    for (const [key, item] of this.streams) {
      if (chosen.has(key)) continue;
      item.stream.destroy();
      this.streams.delete(key);
    }
    for (const [key, info] of candidates) {
      if (!chosen.has(key)) continue;
      const current = this.streams.get(key);
      if (current) { current.engine.setVolume24hUsd(info.volume); continue; }
      const engine = new OrderBookEngine(info.symbol, info.exchange, 'futures');
      engine.setVolume24hUsd(info.volume);
      const stream = acquireExchangeStream(info.symbol, info.exchange, 'futures', false);
      stream.on('depth', (delta: RawDepthDelta) => {
        engine.applyDepth(delta);
        if (engine.sequenceGap) stream.resyncOrderBook();
      });
      stream.on('status', (status) => engine.setStatus(status));
      stream.on('price', (quote: { price: number; time: number }) => {
        const receivedAt = Date.now();
        if (Number.isFinite(quote.price) && quote.price > 0 &&
          Number.isSafeInteger(quote.time) && receivedAt - quote.time >= 0 &&
          receivedAt - quote.time <= 5000) {
          const entry = this.streams.get(key);
          if (entry) entry.tradeQuote = {
            exchange: info.exchange, marketType: 'futures', symbol: info.symbol,
            price: quote.price, updatedAt: quote.time,
          };
        }
      });
      stream.on('error', () => { engine.setStatus('ERROR'); });
      this.streams.set(key, { stream, engine, instrument: key, lastEligibleAt: now });
    }
  }

  snapshot(now = Date.now()): Array<{
    instrument: string;
    source: 'exchange-websocket';
    book: OrderBookState;
    densities: DensityItem[];
    thresholdUsd: number;
    sampledAt: number;
    tradeQuote?: { exchange: ExchangeId; marketType: 'futures'; symbol: string;
      price: number; updatedAt: number };
  }> {
    return [...this.streams.values()].map(item => {
      const book = item.engine.getState();
      const valid = book.status === 'LIVE' && book.dataValid === true &&
        !book.sequenceGap && book.lastReceivedAt > 0 &&
        now >= book.lastReceivedAt && now - book.lastReceivedAt <= 5000 &&
        book.timestamp > 0 && now >= book.timestamp && now - book.timestamp <= 5000 &&
        book.bestBid > 0 && book.bestAsk > book.bestBid;
      return {
        instrument: item.instrument,
        source: 'exchange-websocket' as const,
        book: valid ? book : { ...book, status: 'STALE' as const, bids: [], asks: [], dataValid: false },
        densities: valid ? selectMonDensities(
          item.engine.getDensities().filter(d => d.side === 'BID' || d.side === 'ASK'),
          (book.bestBid + book.bestAsk) / 2,
        ) : [],
        thresholdUsd: item.engine.calculateAdaptiveThreshold(),
        sampledAt: now,
        ...(item.tradeQuote && now >= item.tradeQuote.updatedAt &&
          now - item.tradeQuote.updatedAt <= 5000
          ? { tradeQuote: item.tradeQuote } : {}),
      };
    });
  }
}

export const formationDensityFeed = new FormationDensityFeed();
