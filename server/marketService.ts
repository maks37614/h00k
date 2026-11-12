import { chartExchangeFetch, exchangeFetch } from './exchangeHttp';
import { exchangeHistoryCache } from './exchangeHistoryCache';
import { normalizeExchangeSymbol } from '../src/utils/marketSymbols';
import { ExchangeId, MarketType, Timeframe, Kline, ScannedCoin, MarketCoin } from '../src/types';
import { detectFormations } from '../src/utils/patternRecognition';
import { alignEarlyFormationToTick, detectEarlyReversalFormations } from '../src/utils/earlyFormations';
import { refineRegularFormationSet } from '../src/utils/regularFormationSetup';
import { scoreRegularFlowQuality } from '../src/utils/regularFlowQuality';
import { fetchRegularOIResult } from './regularOI';
import { calculateRegularIndicatorValues } from '../src/utils/regularFormationIndicators';
import { identifyRegularRoundNumberDensity } from './regularOrderbookDensity';
import { fetchExchangeTickSize } from '../src/utils/exchangeTickSize';
import { MarketLocationCache } from '../src/utils/marketLocationCache';
import { marketTickerFeed, type RawTicker } from './marketTickerFeed';
import { formationScanPlan, FORMATION_CANDIDATE_BUDGET } from './formationScanPlan';

// Cache structure
interface CacheEntry {
  timestamp: number;
  data: ScannedCoin[];
  candidateLimit: number;
}

const scanCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 45 * 1000; // 45 seconds

/** Read existing results only. Exporting never starts another formation scan. */
export function getPaperFormationSnapshots(now = Date.now(), timeframe?: Timeframe) {
  return Array.from(scanCache.entries())
    .filter(([key, entry]) => now >= entry.timestamp && now - entry.timestamp <= 180_000
      && (!timeframe || key.split('_')[2] === timeframe))
    .sort((a, b) => b[1].timestamp - a[1].timestamp)
    .slice(0, timeframe ? 4 : 64)
    .map(([key, entry]) => ({
      key, generatedAt: entry.timestamp,
      data: entry.data.map(({ exchangeUrl, ...coin }) => coin),
    }));
}

// Helper to map timeframe to exchange interval
function toBinanceInterval(tf: Timeframe): string {
  switch (tf) {
    case '1m': return '1m';
    case '5m': return '5m';
    case '15m': return '15m';
    case '1h': return '1h';
    case '4h': return '4h';
    case '1d': return '1d';
    default: return '1h';
  }
}

function toBybitInterval(tf: Timeframe): string {
  switch (tf) {
    case '1m': return '1';
    case '5m': return '5';
    case '15m': return '15';
    case '1h': return '60';
    case '4h': return '240';
    case '1d': return 'D';
    default: return '60';
  }
}

const BROWSER_HEADERS = { 'User-Agent': 'SignalHook/1.0', Accept: 'application/json' };

async function fetchBinanceTickers(market: MarketType, minVolume = 0, maxVolume = Number.MAX_VALUE): Promise<RawTicker[]> {
  return (await marketTickerFeed.get('binance', market)).filter(t => t.volumeUsd >= minVolume && t.volumeUsd <= maxVolume);
}

async function fetchBybitTickers(market: MarketType, minVolume = 0, maxVolume = Number.MAX_VALUE): Promise<RawTicker[]> {
  return (await marketTickerFeed.get('bybit', market)).filter(t => t.volumeUsd >= minVolume && t.volumeUsd <= maxVolume);
}

// In-memory cache for high-frequency kline requests to reduce latency to < 1ms
interface KlineCacheEntry {
  data: Kline[];
  timestamp: number;
}
const klinesMemoryCache = new Map<string, KlineCacheEntry>();
const KLINES_CACHE_TTL_MS = 1500; // 1.5s TTL for ultra-fast repeated requests
const CANDLE_SECONDS: Record<Timeframe, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };

function rememberKlines(key: string, data: Kline[]) {
  klinesMemoryCache.delete(key);
  klinesMemoryCache.set(key, { data, timestamp: Date.now() });
  // Both exchanges share the same hard cap, including historical query keys.
  while (klinesMemoryCache.size > 500) klinesMemoryCache.delete(klinesMemoryCache.keys().next().value!);
}

/** Bounded memory export for the PHP bot; no fetches, timers or cache refreshes. */
export function getPaperMarketSnapshot(watch: string[], timeframes: string[], now = Date.now()) {
  const wanted = new Set(watch.slice(0, 12));
  const wantedTimeframes = new Set(timeframes.slice(0, 6));
  const quotes = marketTickerFeed.cached().flatMap(source => source.data
    .filter((ticker, index) => index < 25 || wanted.has(`${ticker.exchange}:${ticker.marketType}:${ticker.symbol}`))
    .map(ticker => ({ ...ticker, updatedAt: source.updatedAt })));
  const latest = new Map<string, { instrument: string; timeframe: string; updatedAt: number; candles: number[][] }>();
  for (const [key, entry] of klinesMemoryCache) {
    const [exchange, market, symbol, timeframe, , start, end] = key.split(':');
    const instrument = `${exchange}:${market}:${symbol}`;
    if (!wanted.has(instrument) || !wantedTimeframes.has(timeframe) || start || end
      || now < entry.timestamp || now - entry.timestamp > 180_000) continue;
    const id = `${instrument}:${timeframe}`;
    if ((latest.get(id)?.updatedAt || 0) >= entry.timestamp) continue;
    const seconds = CANDLE_SECONDS[timeframe as Timeframe];
    if (!seconds) continue;
    latest.set(id, { instrument, timeframe, updatedAt: entry.timestamp,
      // A candle fetched while live cannot become a final candle just because time passed.
      candles: entry.data.filter(c => (c.time + seconds) * 1000 <= Math.min(now, entry.timestamp))
        .slice(-200).map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]) });
  }
  return { quotes, series: Array.from(latest.values()).slice(0, 72) };
}

/** A successful cache read must not relabel old, gapped or invalid candles as a live signal. */
export function formationCandleData(klines: Kline[], timeframe: Timeframe, collectedAt: number, now = Date.now()) {
  const seconds = CANDLE_SECONDS[timeframe];
  if (!Number.isFinite(collectedAt) || collectedAt > now || now - collectedAt > 180_000) return null;
  const closed = klines.filter(c => (c.time + seconds) * 1000 <= Math.min(now, collectedAt));
  if (closed.length < 35) return null;
  if (closed.some((c, i) => ![c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite)
    || !Number.isInteger(c.time) || c.time <= 0 || c.time % seconds !== 0
    || Math.min(c.open, c.high, c.low, c.close) <= 0 || c.volume < 0
    || c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close) || c.high < c.low
    || (i > 0 && c.time !== closed[i - 1].time + seconds))) return null;
  const lastClosedAt = (closed[closed.length - 1].time + seconds) * 1000;
  if (now - lastClosedAt > seconds * 1000 + 90_000) return null;
  return { collectedAt, lastClosedAt, contiguous: true as const };
}

// Fetch Klines for a specific coin with multi-mirror resilience
export async function fetchKlines(
  exchange: ExchangeId,
  market: MarketType,
  symbol: string,
  timeframe: Timeframe,
  limit: number = 70,
  startTime?: number,
  endTime?: number,
  options: { requireFresh?: boolean; chart?: boolean } = {}
): Promise<Kline[]> {
  const cleanSymbol = normalizeExchangeSymbol(symbol);
  const safeLimit = Math.min(Math.max(limit, 10), 1000);
  const cacheKey = `${exchange}:${market}:${cleanSymbol}:${timeframe}:${safeLimit}:${startTime || ''}:${endTime || ''}`;

  const marketRequest = options.chart ? chartExchangeFetch : exchangeFetch;
  const cached = klinesMemoryCache.get(cacheKey);
  const now = Date.now();
  if (!options.requireFresh && cached && now - cached.timestamp < KLINES_CACHE_TTL_MS && cached.data.length > 0) {
    return cached.data;
  }

  const extraBinance = `${startTime ? `&startTime=${startTime}` : ''}${endTime ? `&endTime=${endTime}` : ''}`;
  const extraBybit = `${startTime ? `&start=${startTime}` : ''}${endTime ? `&end=${endTime}` : ''}`;

  if (exchange === 'binance') {
    const interval = toBinanceInterval(timeframe);
    const mirrors = market === 'futures'
      ? [`https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(cleanSymbol)}&interval=${interval}&limit=${safeLimit}${extraBinance}`]
      : [
          `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(cleanSymbol)}&interval=${interval}&limit=${safeLimit}${extraBinance}`,
          `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(cleanSymbol)}&interval=${interval}&limit=${safeLimit}${extraBinance}`,
          `https://api1.binance.com/api/v3/klines?symbol=${encodeURIComponent(cleanSymbol)}&interval=${interval}&limit=${safeLimit}${extraBinance}`,
        ];

    for (const url of mirrors) {
      try {
        const res = await marketRequest(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(2500) });
        if (options.requireFresh && ([403, 429, 451].includes(res.status) ||
            (res.ok && !res.headers.get('content-type')?.includes('application/json')))) return [];
        if (!res.ok) continue;
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) continue;

        const result: Kline[] = data.map((d: any) => ({
          time: Math.floor(d[0] / 1000),
          open: parseFloat(d[1]),
          high: parseFloat(d[2]),
          low: parseFloat(d[3]),
          close: parseFloat(d[4]),
          volume: parseFloat(d[5]),
          quoteVolume: Number(d[7]),
          buyVolume: Number(d[9]),
          buyQuoteVolume: Number(d[10]),
        }));

        rememberKlines(cacheKey, result);

        return result;
      } catch {
        // Try next mirror
      }
    }
    return options.requireFresh ? [] : cached?.data || [];
  } else {
    // Bybit
    const primaryCategory = market === 'futures' ? 'linear' : 'spot';
    const interval = toBybitInterval(timeframe);

    const categories = [primaryCategory];
    const hosts = [
      'https://api.bybit.com',
      'https://api.bytick.com',
      'https://api.bybit.nl',
    ];

    for (const cat of categories) {
      for (const host of hosts) {
        try {
          const url = `${host}/v5/market/kline?category=${cat}&symbol=${encodeURIComponent(cleanSymbol)}&interval=${interval}&limit=${safeLimit}${extraBybit}`;
          const res = await marketRequest(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(2500) });
          if (options.requireFresh && ([403, 429, 451].includes(res.status) ||
              (res.ok && !res.headers.get('content-type')?.includes('application/json')))) return [];
          if (!res.ok) continue;
          const json = await res.json();
          if (json.retCode !== 0 || (json.result?.category && json.result.category !== primaryCategory) ||
              (json.result?.symbol && json.result.symbol !== cleanSymbol)) continue;
          const list = json?.result?.list;
          if (!Array.isArray(list) || list.length === 0) continue;

          const result: Kline[] = list
            .slice()
            .reverse()
            .map((d: any) => ({
              time: Math.floor(parseInt(d[0], 10) / 1000),
              open: parseFloat(d[1]),
              high: parseFloat(d[2]),
              low: parseFloat(d[3]),
              close: parseFloat(d[4]),
              volume: parseFloat(d[5]),
            }));

          rememberKlines(cacheKey, result);
          return result;
        } catch {
          // Try next mirror
        }
      }
    }
    return options.requireFresh ? [] : cached?.data || [];
  }
}

// Simple concurrency runner
async function pMap<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency = 6): Promise<R[]> {
  const results: R[] = [];
  const executing: Promise<void>[] = [];

  for (const item of items) {
    const p = fn(item).then((res) => {
      results.push(res);
    });
    executing.push(p);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
      // remove resolved
      for (let i = executing.length - 1; i >= 0; i--) {
        // @ts-ignore
        if (executing[i].settled) {
          executing.splice(i, 1);
        }
      }
    }
  }

  await Promise.all(executing);
  return results;
}

// Build trade URL
function getExchangeUrl(exchange: ExchangeId, market: MarketType, symbol: string): string {
  if (exchange === 'binance') {
    return market === 'futures'
      ? `https://www.binance.com/en/futures/${symbol}`
      : `https://www.binance.com/en/trade/${symbol}`;
  } else {
    return market === 'futures'
      ? `https://www.bybit.com/trade/usdt/${symbol}`
      : `https://www.bybit.com/en/trade/spot/${symbol.replace('USDT', '')}/USDT`;
  }
}

// Main screener scan engine

/** Fetch ONE validated market-depth snapshot per coin and inspect all standard
 * formations against that same snapshot, without extra exchange calls. */
async function fetchVerifiedRegularDepth(
  exchange: ExchangeId, marketType: MarketType, symbol: string,
): Promise<{ bids: [number, number][]; asks: [number, number][] } | null> {
  const book = await fetchOrderBook(exchange, marketType, symbol, 50).catch(() => null);
  // Bybit exposes an exchange timestamp; Binance is stamped when the REST
  // response arrives. Do not reward a stale or future depth snapshot.
  const snapshotTimestamp = Number(book?.timestamp);
  if (!Number.isFinite(snapshotTimestamp) || Math.abs(Date.now() - snapshotTimestamp) > 60_000) {
    return null;
  }
  // A failed/empty book is unavailable, not proof of no order-book liquidity.
  const validSide = (levels: [number, number][] | undefined): boolean =>
    Array.isArray(levels) && levels.filter(([price, qty]) =>
      Number.isFinite(price) && price > 0 && Number.isFinite(qty) && qty > 0).length >= 8;
  if (!book || !validSide(book.bids) || !validSide(book.asks)) return null;
  return { bids: book.bids, asks: book.asks };
}

interface ScreenerScanParams {
  exchange: 'all' | ExchangeId;
  marketType: 'all' | MarketType;
  timeframe: Timeframe;
  minVolumeUsd?: number;
}

export async function loadScreenerTickers(params: ScreenerScanParams): Promise<RawTicker[]> {
  const minVol = typeof params.minVolumeUsd === 'number' ? params.minVolumeUsd : 50_000;
  // Determine tickers to fetch
  const tickerPromises: Promise<RawTicker[]>[] = [];

  if (params.exchange === 'all' || params.exchange === 'binance') {
    if (params.marketType === 'all' || params.marketType === 'futures') {
      tickerPromises.push(fetchBinanceTickers('futures', minVol));
    }
    if (params.marketType === 'all' || params.marketType === 'spot') {
      tickerPromises.push(fetchBinanceTickers('spot', minVol));
    }
  }

  if (params.exchange === 'all' || params.exchange === 'bybit') {
    if (params.marketType === 'all' || params.marketType === 'futures') {
      tickerPromises.push(fetchBybitTickers('futures', minVol));
    }
    if (params.marketType === 'all' || params.marketType === 'spot') {
      tickerPromises.push(fetchBybitTickers('spot', minVol));
    }
  }

  const tickerBatches = await Promise.all(tickerPromises);
  const allTickers = tickerBatches.flat();

  // Deduplicate tickers by exchange + symbol + marketType and sort by volume
  const seenKeys = new Set<string>();
  const uniqueTickers: RawTicker[] = [];

  for (const t of allTickers) {
    const key = `${t.exchange}_${t.symbol}_${t.marketType}`;
    if (!seenKeys.has(key) && t.volumeUsd >= minVol) {
      seenKeys.add(key);
      uniqueTickers.push(t);
    }
  }

  uniqueTickers.sort((a, b) => b.volumeUsd - a.volumeUsd);
  return uniqueTickers;
}

export async function runScreenerScan(params: ScreenerScanParams,
  context?: { tickers: readonly RawTicker[]; maxCandidates: number }): Promise<ScannedCoin[]> {
  const minVol = typeof params.minVolumeUsd === 'number' ? params.minVolumeUsd : 50_000;
  const candidateLimit = context && Number.isFinite(context.maxCandidates)
    ? Math.max(1, Math.min(FORMATION_CANDIDATE_BUDGET, Math.floor(context.maxCandidates)))
    : FORMATION_CANDIDATE_BUDGET;
  const cacheKey = `${params.exchange}_${params.marketType}_${params.timeframe}_${minVol}`;
  const cached = scanCache.get(cacheKey);
  // A limited background snapshot must not silently truncate a full foreground scan.
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS && cached.candidateLimit >= candidateLimit) {
    return cached.data;
  }
  const tickers = context?.tickers ?? await loadScreenerTickers(params);

  const selectedTickers = tickers.filter(ticker => ticker.volumeUsd >= minVol
    && (params.exchange === 'all' || ticker.exchange === params.exchange)
    && (params.marketType === 'all' || ticker.marketType === params.marketType)).slice(0, candidateLimit);

  // Scan klines and detect patterns in parallel
  const scannedCoins: ScannedCoin[] = [];

  // Batch process with higher concurrency
  const BATCH_SIZE = 25;
  for (let i = 0; i < selectedTickers.length; i += BATCH_SIZE) {
    const batch = selectedTickers.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (ticker) => {
        const klines = await fetchKlines(ticker.exchange, ticker.marketType, ticker.symbol, params.timeframe, 70);
        if (!klines || klines.length < 25) return null;

        const candleCache = klinesMemoryCache.get(`${ticker.exchange}:${ticker.marketType}:${normalizeExchangeSymbol(ticker.symbol)}:${params.timeframe}:70::`);
        const formationData = formationCandleData(klines, params.timeframe, candleCache?.timestamp ?? NaN);
        if (!formationData) return null;

        const closedKlines = klines.filter(c => (c.time + CANDLE_SECONDS[params.timeframe]) * 1000 <= formationData.lastClosedAt);
        const baseFormations = detectFormations(closedKlines, ticker.symbol)
          .filter(f => f.validation?.enoughData && f.validation.finiteData);
        // Early W/M uses the original detector output, not the standard-mode
        // ATR target optimizer. This preserves its existing duplicate gating.
        const rawEarly = detectEarlyReversalFormations(closedKlines, ticker.symbol, baseFormations);
        const tickSize = baseFormations.length || rawEarly.length
          ? await fetchExchangeTickSize(ticker.exchange, ticker.marketType, ticker.symbol, exchangeFetch)
          : null;
        const formations = refineRegularFormationSet(closedKlines, baseFormations, tickSize);
        const earlyFormations = rawEarly.flatMap(candidate => {
          const aligned = alignEarlyFormationToTick(candidate, tickSize);
          return aligned ? [aligned] : [];
        });
        const bestFormation = formations[0];
        // Only ordinary formation scans use depth; early W/M was detected
        // above using the original unchanged detector output.
        const densityBook = formations.length
          ? await fetchVerifiedRegularDepth(ticker.exchange, ticker.marketType, ticker.symbol)
          : null;
        const densityById = new Map(formations.map(formation => {
          const reference = formation.levels.necklinePrice ?? formation.levels.entryPrice;
          const density = densityBook
            ? identifyRegularRoundNumberDensity(densityBook, reference, ticker.price, formation.bias)
            : undefined;
          return [formation.id, density] as const;
        }));
        const roundNumberDensity = bestFormation ? densityById.get(bestFormation.id) : undefined;
        const enrichedFormations = formations.map(formation => {
          const density = densityById.get(formation.id);
          if (!density) return formation;
          return {
            ...formation,
            roundNumberContext: {
              ...(formation.roundNumberContext || { detected: true, distancePct: 0, step: 0, strength: 0 }),
              detected: true,
              level: density.level,
              distancePct: density.distancePct,
              densityConfirmed: true,
              densityUsd: density.notionalUsd,
              side: density.side,
              strength: Math.max(formation.roundNumberContext?.strength || 0, density.quality),
            },
          };
        });

        const regularIndicators = calculateRegularIndicatorValues(closedKlines);
        if (ticker.marketType === 'spot') regularIndicators.oiAvailability = 'spot';
        if (baseFormations.length && ticker.marketType === 'futures') {
          const oi = await fetchRegularOIResult(ticker.exchange, ticker.marketType, ticker.symbol, params.timeframe);
          regularIndicators.oiAvailability = oi.reason;
          if (oi.snapshot) {
            regularIndicators.oiChangePct = oi.snapshot.changePct;
            regularIndicators.oiUpdatedAt = oi.snapshot.timestamp;
            regularIndicators.oiSource = 'server';
          }
        }

        // Score standard formations only after all verified OI and taker-flow
        // metrics have arrived. Early W/M candidates remain untouched.
        const scoredFormations = enrichedFormations.map(formation =>
          scoreRegularFlowQuality(formation, regularIndicators, ticker.exchange,
            ticker.marketType, closedKlines,
            densityBook !== null && formation.roundNumberContext?.detected === true));

        const scanned: ScannedCoin = {
          symbol: ticker.symbol,
          baseAsset: ticker.baseAsset,
          quoteAsset: ticker.quoteAsset,
          exchange: ticker.exchange,
          marketType: ticker.marketType,
          currentPrice: ticker.price,
          priceChange24h: ticker.change24h,
          highPrice24h: ticker.high24h,
          lowPrice24h: ticker.low24h,
          volume24hUsd: ticker.volumeUsd,
          formations: scoredFormations,
          earlyFormations,
          regularIndicators,
          roundNumberDensity,
          timeframe: params.timeframe,
          lastUpdated: Date.now(),
          formationData,
          exchangeUrl: getExchangeUrl(ticker.exchange, ticker.marketType, ticker.symbol),
        };
        return scanned;
      })
    );

    for (const res of batchResults) {
      if (res) scannedCoins.push(res);
    }
  }

  // Update cache
  scanCache.set(cacheKey, {
    timestamp: Date.now(),
    data: scannedCoins,
    candidateLimit,
  });

  return scannedCoins;
}

/** One cycle, one shared ticker snapshot, <=75 candidate checks, <=25 concurrent coins. */
export async function runBackgroundFormationScans(): Promise<void> {
  const plan = formationScanPlan();
  const base = { exchange: 'all' as const, marketType: 'futures' as const, minVolumeUsd: 100_000 };
  const now = Date.now();
  const pending = plan.allocations.filter(allocation => {
    const cached = scanCache.get(`${base.exchange}_${base.marketType}_${allocation.timeframe}_${base.minVolumeUsd}`);
    return !cached || now - cached.timestamp >= CACHE_TTL_MS || cached.candidateLimit < allocation.maxCandidates;
  });
  if (!pending.length) return;
  const tickers = await loadScreenerTickers({ ...base, timeframe: plan.timeframes[0] });
  const failed: string[] = [];
  // Sequential timeframes preserve the existing 25-coin concurrency ceiling.
  for (const allocation of pending) {
    try {
      await runScreenerScan({ ...base, timeframe: allocation.timeframe }, { tickers, maxCandidates: allocation.maxCandidates });
    } catch {
      failed.push(allocation.timeframe);
    }
  }
  if (failed.length) throw new Error(`Formation background scan failed for: ${failed.join(', ')}`);
}

// Optional volatility enrichment must never delay the current quote snapshot.
let volatilityRefresh: Promise<unknown> | null = null;

// Cache for 5m volatility per coin
const volatility5mCache = new Map<string, { timestamp: number; volatility5mPct: number }>();
const VOL_5M_CACHE_TTL = 30 * 1000; // 30 seconds

// Cache of valid Binance spot symbols for bulk windowSize=5m requests
let binanceSpotSymbolsCache: Set<string> | null = null;
let binanceSpotSymbolsTimestamp = 0;

async function getBinanceSpotSymbols(): Promise<Set<string>> {
  if (binanceSpotSymbolsCache && Date.now() - binanceSpotSymbolsTimestamp < 3600_000) {
    return binanceSpotSymbolsCache;
  }
  try {
    const res = await exchangeFetch('https://data-api.binance.vision/api/v3/ticker/24hr', {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        binanceSpotSymbolsCache = new Set(data.map((d: any) => d.symbol));
        binanceSpotSymbolsTimestamp = Date.now();
        return binanceSpotSymbolsCache;
      }
    }
  } catch {}
  return binanceSpotSymbolsCache || new Set();
}

/**
 * Calculates 5m volatility for an array of coins:
 * Queries bulk 5m rolling window from Binance for spot-supported pairs,
 * and fetches 5m klines for futures/Bybit pairs.
 */
async function resolve5mVolatilityForCoins(
  coins: { exchange: ExchangeId; symbol: string; marketType: MarketType; volatility24hPct: number }[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const now = Date.now();
  const toFetch: typeof coins = [];

  for (const c of coins) {
    const key = `${c.exchange}_${c.symbol}_${c.marketType}`;
    const cached = volatility5mCache.get(key);
    if (cached && now - cached.timestamp < VOL_5M_CACHE_TTL) {
      result.set(key, cached.volatility5mPct);
    } else {
      toFetch.push(c);
    }
  }

  if (toFetch.length === 0) {
    return result;
  }

  // Prioritize top volume coins for live 5m fetching (up to top 100 coins)
  const priorityCoins = toFetch.slice(0, 100);
  const remainingCoins = toFetch.slice(100);

  // Lower-volume coins keep an estimate until their 5m candles are requested.
  for (const c of remainingCoins) {
    const key = `${c.exchange}_${c.symbol}_${c.marketType}`;
    const est5m = Number(Math.max(0.05, c.volatility24hPct * 0.12).toFixed(2));
    result.set(key, est5m);
    volatility5mCache.set(key, { timestamp: now, volatility5mPct: est5m });
  }

  const spotSymbols = await getBinanceSpotSymbols();
  const binanceSpotPairs: string[] = [];
  const otherPairs: typeof coins = [];

  for (const c of priorityCoins) {
    if (c.exchange === 'binance' && c.marketType === 'spot' && spotSymbols.has(c.symbol)) {
      binanceSpotPairs.push(c.symbol);
    } else {
      otherPairs.push(c);
    }
  }

  // 1. Bulk query Binance 5m rolling window in chunks of 50
  const binanceChunkPromises: Promise<void>[] = [];
  const BATCH_SIZE = 50;
  for (let i = 0; i < binanceSpotPairs.length; i += BATCH_SIZE) {
    const chunk = binanceSpotPairs.slice(i, i + BATCH_SIZE);
    binanceChunkPromises.push(
      (async () => {
        try {
          const url = `https://data-api.binance.vision/api/v3/ticker?symbols=${encodeURIComponent(JSON.stringify(chunk))}&windowSize=5m`;
          const res = await exchangeFetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(4000) });
          if (!res.ok) return;
          const data = await res.json();
          if (Array.isArray(data)) {
            for (const item of data) {
              const symbol = item.symbol;
              const high = parseFloat(item.highPrice) || 0;
              const low = parseFloat(item.lowPrice) || 0;
              if (low > 0 && high >= low) {
                const vol5m = Number((((high - low) / low) * 100).toFixed(2));
                result.set(`binance_${symbol}_spot`, vol5m);
                volatility5mCache.set(`binance_${symbol}_spot`, { timestamp: now, volatility5mPct: vol5m });
              }
            }
          }
        } catch {}
      })()
    );
  }

  // 2. Fetch other pairs (Bybit & futures-only) in parallel batches of 20
  const otherChunkPromises: Promise<void>[] = [];
  const OTHER_BATCH = 20;
  for (let i = 0; i < otherPairs.length; i += OTHER_BATCH) {
    const chunk = otherPairs.slice(i, i + OTHER_BATCH);
    otherChunkPromises.push(
      (async () => {
        await Promise.all(
          chunk.map(async (c) => {
            const key = `${c.exchange}_${c.symbol}_${c.marketType}`;
            try {
              const klines = await fetchKlines(c.exchange, c.marketType, c.symbol, '5m', 2);
              if (klines && klines.length > 0) {
                const last = klines[klines.length - 1];
                const high = last.high;
                const low = last.low;
                if (low > 0 && high >= low) {
                  const vol5m = Number((((high - low) / low) * 100).toFixed(2));
                  result.set(key, vol5m);
                  volatility5mCache.set(key, { timestamp: now, volatility5mPct: vol5m });
                  return;
                }
              }
            } catch {}
            // Fallback estimation
            const est5m = Number(Math.max(0.05, c.volatility24hPct * 0.12).toFixed(2));
            result.set(key, est5m);
            volatility5mCache.set(key, { timestamp: now, volatility5mPct: est5m });
          })
        );
      })()
    );
  }

  await Promise.all([...binanceChunkPromises, ...otherChunkPromises]);

  // Ensure every priority coin has a value
  for (const c of priorityCoins) {
    const key = `${c.exchange}_${c.symbol}_${c.marketType}`;
    if (!result.has(key)) {
      const fallback = Number(Math.max(0.05, c.volatility24hPct * 0.12).toFixed(2));
      result.set(key, fallback);
      volatility5mCache.set(key, { timestamp: now, volatility5mPct: fallback });
    }
  }

  return result;
}

const marketLocationCache = new MarketLocationCache((exchange, market, symbol) =>
  fetchKlines(exchange, market, symbol, '1d', 731));

export async function fetchMarketCoins(params: {
  exchange?: 'all' | ExchangeId;
  marketType?: 'all' | MarketType;
  minVolumeUsd?: number;
  maxVolumeUsd?: number;
}): Promise<MarketCoin[]> {
  const exchange = params.exchange || 'all';
  const marketType = params.marketType || 'all';
  const minVol = params.minVolumeUsd !== undefined ? params.minVolumeUsd : 50_000;
  // When no maximum is requested, do not hide highly traded pairs (e.g. BTCUSDT).
  const maxVol = params.maxVolumeUsd !== undefined ? params.maxVolumeUsd : Number.MAX_VALUE;
  const tickerPromises: Promise<RawTicker[]>[] = [];

  if (exchange === 'all' || exchange === 'binance') {
    if (marketType === 'all' || marketType === 'futures') {
      tickerPromises.push(fetchBinanceTickers('futures', minVol, maxVol));
    }
    if (marketType === 'all' || marketType === 'spot') {
      tickerPromises.push(fetchBinanceTickers('spot', minVol, maxVol));
    }
  }

  if (exchange === 'all' || exchange === 'bybit') {
    if (marketType === 'all' || marketType === 'futures') {
      tickerPromises.push(fetchBybitTickers('futures', minVol, maxVol));
    }
    if (marketType === 'all' || marketType === 'spot') {
      tickerPromises.push(fetchBybitTickers('spot', minVol, maxVol));
    }
  }

  const batches = await Promise.all(tickerPromises);
  const allTickers = batches.flat();

  const seenKeys = new Set<string>();
  const coins: MarketCoin[] = [];

  for (const t of allTickers) {
    const key = `${t.exchange}_${t.symbol}_${t.marketType}`;
    if (!seenKeys.has(key) && t.volumeUsd >= minVol && t.volumeUsd <= maxVol && t.price > 0) {
      seenKeys.add(key);

      const high = t.high24h > 0 ? t.high24h : t.price;
      const low = t.low24h > 0 ? t.low24h : t.price;

      const distanceToHighPct = high > 0 ? Math.max(0, ((high - t.price) / high) * 100) : 0;
      const distanceToLowPct = low > 0 ? Math.max(0, ((t.price - low) / low) * 100) : 0;
      const volatility24hPct = low > 0 ? Math.max(0, ((high - low) / low) * 100) : 0;

      // Daily-history enrichment below owns the multi-period location flags.
      const isNearHigh = false;
      const isNearLow = false;

      coins.push({
        symbol: t.symbol,
        baseAsset: t.baseAsset,
        quoteAsset: t.quoteAsset,
        exchange: t.exchange,
        marketType: t.marketType,
        price: t.price,
        change24h: Number(t.change24h.toFixed(2)),
        volumeUsd: t.volumeUsd,
        high24h: high,
        low24h: low,
        distanceToHighPct: Number(distanceToHighPct.toFixed(2)),
        distanceToLowPct: Number(distanceToLowPct.toFixed(2)),
        volatility24hPct: Number(volatility24hPct.toFixed(2)),
        volatility5mPct: Number((volatility24hPct * 0.12).toFixed(2)),
        ...(t.openInterestUsd !== undefined ? { openInterestUsd: t.openInterestUsd } : {}),
        ...(t.fundingRatePct !== undefined ? { fundingRatePct: t.fundingRatePct } : {}),
        isNearHigh,
        isNearLow,
        isActiveCoin: (volatility24hPct >= 4 && t.volumeUsd >= 2_000_000) || Math.abs(t.change24h) >= 5,
        exchangeUrl: getExchangeUrl(t.exchange, t.marketType, t.symbol),
      });
    }
  }

  // Sort by volume descending by default
  coins.sort((a, b) => b.volumeUsd - a.volumeUsd);

  for (const coin of coins) {
    const cached = volatility5mCache.get(`${coin.exchange}_${coin.symbol}_${coin.marketType}`);
    if (cached && Date.now() - cached.timestamp < VOL_5M_CACHE_TTL) coin.volatility5mPct = cached.volatility5mPct;
    const effectiveVol = coin.volatility5mPct ?? coin.volatility24hPct * 0.12;
    coin.isActiveCoin = (effectiveVol >= 0.8 && coin.volumeUsd >= 1_000_000)
      || coin.volatility24hPct >= 4 || Math.abs(coin.change24h) >= 5;
  }
  if (coins.length && !volatilityRefresh) {
    volatilityRefresh = resolve5mVolatilityForCoins(coins)
      .catch(err => console.warn('Error resolving 5m volatility:', err))
      .finally(() => { volatilityRefresh = null; });
  }

  return marketLocationCache.enrich(coins);
}

export interface OrderBookData {
  symbol: string;
  exchange: ExchangeId;
  marketType: MarketType;
  bids: [number, number][]; // [price, qty]
  asks: [number, number][]; // [price, qty]
  lastUpdateId?: number;
  timestamp: number;
}

// Fetch orderbook depth snapshot
export async function fetchOrderBook(
  exchange: ExchangeId = 'binance',
  market: MarketType = 'futures',
  symbol: string = 'BTCUSDT',
  limit: number = 500
): Promise<OrderBookData> {
  const cleanSymbol = normalizeExchangeSymbol(symbol);
  const safeLimit = Math.min(Math.max(limit, 20), 1000);

  if (exchange === 'bybit') {
    const category = market === 'futures' ? 'linear' : 'spot';
    const mirrors = [
      `https://api.bybit.com/v5/market/orderbook?category=${category}&symbol=${encodeURIComponent(cleanSymbol)}&limit=${Math.min(safeLimit, 500)}`,
      `https://api.bytick.com/v5/market/orderbook?category=${category}&symbol=${encodeURIComponent(cleanSymbol)}&limit=${Math.min(safeLimit, 500)}`,
    ];

    for (const url of mirrors) {
      try {
        const res = await exchangeFetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(4000) });
        if (res.ok) {
          const json = await res.json();
          const result = json?.result;
          if (result && Array.isArray(result.b) && Array.isArray(result.a)) {
            const bids: [number, number][] = result.b.map((item: [string, string]) => [parseFloat(item[0]), parseFloat(item[1])]);
            const asks: [number, number][] = result.a.map((item: [string, string]) => [parseFloat(item[0]), parseFloat(item[1])]);
            return {
              symbol: cleanSymbol,
              exchange,
              marketType: market,
              bids,
              asks,
              timestamp: result.ts || Date.now(),
            };
          }
        }
      } catch {
        // Try next
      }
    }
    return { symbol: cleanSymbol, exchange, marketType: market, bids: [], asks: [], timestamp: Date.now() };
  }

  // Binance (Futures or Spot with multi-mirror)
  const mirrors = market === 'futures'
    ? [`https://fapi.binance.com/fapi/v1/depth?symbol=${encodeURIComponent(cleanSymbol)}&limit=${safeLimit}`]
    : [
        `https://data-api.binance.vision/api/v3/depth?symbol=${encodeURIComponent(cleanSymbol)}&limit=${safeLimit}`,
        `https://api.binance.com/api/v3/depth?symbol=${encodeURIComponent(cleanSymbol)}&limit=${safeLimit}`,
      ];

  for (const url of mirrors) {
    try {
      // The 1000-level snapshot is required to bridge live depth deltas.
      // Keep it inside the shared IP limiter, with chart headroom protected
      // from unrelated background scans.
      const marketRequest = safeLimit >= 1000 ? chartExchangeFetch : exchangeFetch;
      const res = await marketRequest(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(4000) });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data.bids || !data.asks) continue;

      const bids: [number, number][] = (data.bids || []).map((item: [string, string]) => [parseFloat(item[0]), parseFloat(item[1])]);
      const asks: [number, number][] = (data.asks || []).map((item: [string, string]) => [parseFloat(item[0]), parseFloat(item[1])]);

      return {
        symbol: cleanSymbol,
        exchange: 'binance',
        marketType: market,
        bids,
        asks,
        lastUpdateId: data.lastUpdateId,
        timestamp: Date.now(),
      };
    } catch {
      // Try next
    }
  }

  // Fallback empty orderbook structure
  return {
    symbol: cleanSymbol,
    exchange,
    marketType: market,
    bids: [],
    asks: [],
    timestamp: Date.now(),
  };
}

// ----------------------------------------------------
// DUAL EXCHANGE OPEN INTEREST (Binance Futures & Bybit Linear)
// ----------------------------------------------------

export interface ExchangeOIData {
  exchange: 'binance' | 'bybit';
  symbol: string;
  valueUsd: number;
  amountCoins: number;
  change5mPct: number | null;
  lastUpdated: number;
}

let binanceSymbolsSet = new Set<string>();
let bybitSymbolsSet = new Set<string>();
let lastOiSymbolsFetchTime = 0;
const OI_SYMBOLS_CACHE_TTL = 30 * 60 * 1000;

const oiResultCache = new Map<string, { timestamp: number; data: { binance: ExchangeOIData | null; bybit: ExchangeOIData | null; totalOIUsd: number } }>();
// Keep the existing dual-exchange response cache short, while a live single-
// instrument OI sample is fetched at most once per minute per Node process.
const OI_RESULT_CACHE_TTL = 15_000;
const SINGLE_OI_CACHE_TTL = 60_000;
const SINGLE_OI_FAILURE_TTL = 60_000; // Preserve one upstream attempt per symbol per minute even during outages.
type OiPair = { binance: ExchangeOIData | null; bybit: ExchangeOIData | null; totalOIUsd: number };
const oiResultInFlight = new Map<string, Promise<OiPair>>();

async function refreshOiExchangeSymbolsUncoalesced(): Promise<void> {
  const now = Date.now();
  if (binanceSymbolsSet.size > 0 && bybitSymbolsSet.size > 0 && (now - lastOiSymbolsFetchTime) < OI_SYMBOLS_CACHE_TTL) {
    return;
  }

  try {
    const [binanceRes, bybitRes] = await Promise.allSettled([
      exchangeFetch('https://fapi.binance.com/fapi/v1/ticker/price', {
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(4000),
      }).then((r) => (r.ok ? r.json() : [])),
      exchangeFetch('https://api.bybit.com/v5/market/tickers?category=linear', {
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(4000),
      }).then((r) => (r.ok ? r.json() : {})),
    ]);

    if (binanceRes.status === 'fulfilled' && Array.isArray(binanceRes.value)) {
      const bSet = new Set<string>();
      for (const item of binanceRes.value) {
        if (item.symbol) bSet.add(item.symbol);
      }
      if (bSet.size > 0) binanceSymbolsSet = bSet;
    }

    if (bybitRes.status === 'fulfilled') {
      const bybitData = bybitRes.value as any;
      if (Array.isArray(bybitData?.result?.list)) {
        const bySet = new Set<string>();
        for (const item of bybitData.result.list) {
          if (item.symbol) bySet.add(item.symbol);
        }
        if (bySet.size > 0) bybitSymbolsSet = bySet;
      }
    }

    lastOiSymbolsFetchTime = now;
  } catch (err) {
    console.warn('Failed to refresh exchange symbols cache:', err);
  }
}

// Do not launch 2 separate full-market symbol discovery requests per concurrent worker.
let oiSymbolsInFlight: Promise<void> | null = null;
function refreshOiExchangeSymbols(): Promise<void> {
  if (oiSymbolsInFlight) return oiSymbolsInFlight;
  const pending = refreshOiExchangeSymbolsUncoalesced();
  oiSymbolsInFlight = pending;
  pending.then(() => { if (oiSymbolsInFlight === pending) oiSymbolsInFlight = null; },
    () => { if (oiSymbolsInFlight === pending) oiSymbolsInFlight = null; });
  return pending;
}

refreshOiExchangeSymbols().catch(() => {});

function resolveOiSymbols(
  rawSymbol: string,
  baseAsset?: string
): { binanceSymbol: string | null; bybitSymbol: string | null } {
  let clean = (rawSymbol || '')
    .trim()
    .toUpperCase()
    .replace(/[-_:](SWAP|PERP|USDT|USDC)$/i, '')
    .replace(/[-_:\/]/g, '')
    .replace(/(SWAP|PERP)$/i, '');

  if (clean.endsWith('USDT')) {
    clean = clean.replace(/USDT$/, '');
  } else if (clean.endsWith('USDC')) {
    clean = clean.replace(/USDC$/, '');
  }

  let core = (baseAsset || clean)
    .toUpperCase()
    .replace(/[-_:\/]/g, '')
    .replace(/(USDT|USDC|BUSD|PERP|SWAP)$/i, '')
    .replace(/^(10000000|1000000|100000|10000|1000|1M|K)/i, '')
    .replace(/(10000000|1000000|100000|10000|1000|1M|K)$/i, '');

  if (core.endsWith('CTO')) {
    core = core.replace(/CTO$/, '');
  }

  const candidates = [
    `${clean}USDT`,
    `${core}USDT`,
    `1000${core}USDT`,
    `10000${core}USDT`,
    `1000000${core}USDT`,
    `1M${core}USDT`,
    `${core}1000USDT`,
    `1000${core}CTOUSDT`,
    `${clean}USDC`,
    `${core}USDC`,
  ];

  let binanceSymbol: string | null = null;
  let bybitSymbol: string | null = null;

  if (binanceSymbolsSet.size > 0) {
    for (const cand of candidates) {
      if (binanceSymbolsSet.has(cand)) {
        binanceSymbol = cand;
        break;
      }
    }
  } else {
    binanceSymbol = candidates[0];
  }

  if (bybitSymbolsSet.size > 0) {
    for (const cand of candidates) {
      if (bybitSymbolsSet.has(cand)) {
        bybitSymbol = cand;
        break;
      }
    }
  } else {
    bybitSymbol = candidates[0];
  }

  return { binanceSymbol, bybitSymbol };
}

/** Live OI is not the 5-minute historical OI endpoint.
 * Historical observations remain available through regularOI/hookchartOI.
 */
async function fetchBinanceOiSingle(symbol: string, fallbackPrice: number): Promise<ExchangeOIData | null> {
  try {
    const response = await exchangeFetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const coins = Number(payload?.openInterest);
    if (!Number.isFinite(coins) || coins <= 0 ||
        (payload?.symbol && String(payload.symbol).toUpperCase() !== symbol)) return null;
    return {
      exchange: 'binance', symbol, valueUsd: coins * fallbackPrice,
      amountCoins: coins, change5mPct: null, lastUpdated: Date.now(),
    };
  } catch { return null; }
}

/** Historical five-minute change is enrichment for public dual-OI requests,
 * never used to fabricate or delay a surveillance worker's live OI sample. */
async function fetchBinanceOiHistoricalChange5m(symbol: string): Promise<number | null> {
  const url = `https://fapi.binance.com/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=5m&limit=2`;
  const rows = await exchangeHistoryCache.get(url,
    data => Array.isArray(data) && data.length >= 2);
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const previous = Number(rows[rows.length - 2]?.sumOpenInterestValue);
  const current = Number(rows[rows.length - 1]?.sumOpenInterestValue);
  return Number.isFinite(previous) && previous > 0 && Number.isFinite(current) && current >= 0
    ? Number(((current - previous) / previous * 100).toFixed(2)) : null;
}

async function fetchBybitOiSingle(symbol: string, fallbackPrice: number): Promise<ExchangeOIData | null> {
  const mirrors = [
    `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`,
    `https://api.bytick.com/v5/market/tickers?category=linear&symbol=${symbol}`,
  ];

  for (const url of mirrors) {
    try {
      const res = await exchangeFetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(2500) });
      if (!res.ok) continue;
      const json = await res.json();
      const item = json?.result?.list?.[0];
      if (item) {
        const val = parseFloat(item.openInterestValue) || 0;
        const coins = parseFloat(item.openInterest) || 0;
        const lastPrice = parseFloat(item.lastPrice) || fallbackPrice;

        if (val > 0 || coins > 0) {
          let change5mPct: number | null = null;
          try {
            const hJson = await exchangeHistoryCache.get(
              `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=5min&limit=2`,
              data => data?.retCode === 0 && Array.isArray(data?.result?.list), 2000);
            if (hJson) {
              const list = hJson.result.list;
              if (Array.isArray(list) && list.length >= 2) {
                const latestOi = parseFloat(list[0].openInterest) || 0;
                const prevOi = parseFloat(list[1].openInterest) || 0;
                if (prevOi > 0 && latestOi > 0) {
                  change5mPct = Number((((latestOi - prevOi) / prevOi) * 100).toFixed(2));
                }
              }
            }
          } catch {}

          const finalVal = val > 0 ? val : coins * lastPrice;
          return {
            exchange: 'bybit',
            symbol,
            valueUsd: finalVal,
            amountCoins: coins,
            change5mPct,
            lastUpdated: Date.now(),
          };
        }
      }
    } catch {}
  }

  return null;
}

// Each worker (even across hundreds of accounts) consumes the same 60-second
// live OI sample for its exchange/instrument. Failures keep the same request budget.
const singleOiCache = new Map<string, { timestamp: number; data: ExchangeOIData | null }>();
const singleOiInFlight = new Map<string, Promise<ExchangeOIData | null>>();
const liveOiCounters = { cacheHits: 0, sharedRequests: 0, cacheMisses: 0,
  upstreamBinance: 0, upstreamBybit: 0, unavailable: 0 };

export function getLiveOiCacheStats() {
  return { ...liveOiCounters, cachedInstruments: singleOiCache.size,
    inFlight: singleOiInFlight.size, refreshMs: SINGLE_OI_CACHE_TTL };
}

// USD notional uses the price of the requesting worker, never the price of
// another account that happened to populate the cache first.
function withCurrentOiPrice(data: ExchangeOIData | null, currentPrice?: number): ExchangeOIData | null {
  if (!data || data.exchange !== 'binance') return data;
  // Never report the instrument's coin quantity as if it were USD when the
  // requesting worker has no usable price. Fall back to the shared quote feed.
  let price = currentPrice;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    price = marketTickerFeed.cached().find(source => source.key === 'binance:futures')
      ?.data.find(ticker => ticker.symbol === data.symbol)?.price;
  }
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
  return { ...data, valueUsd: data.amountCoins * price };
}

export async function fetchSingleExchangeOI(
  exchange: ExchangeId,
  rawSymbol: string,
  baseAsset?: string,
  curPrice?: number,
): Promise<ExchangeOIData | null> {
  const cleanSymbol = normalizeExchangeSymbol(rawSymbol);
  const key = cleanSymbol.endsWith('USDT')
    ? `${exchange}:${cleanSymbol}` : `${exchange}:${cleanSymbol}:${baseAsset || ''}`.toUpperCase();
  const cached = singleOiCache.get(key);
  const ttl = cached?.data ? SINGLE_OI_CACHE_TTL : SINGLE_OI_FAILURE_TTL;
  if (cached && Date.now() - cached.timestamp < ttl) {
    liveOiCounters.cacheHits++;
    return withCurrentOiPrice(cached.data, curPrice);
  }
  const existing = singleOiInFlight.get(key);
  if (existing) {
    liveOiCounters.sharedRequests++;
    return withCurrentOiPrice(await existing, curPrice);
  }

  liveOiCounters.cacheMisses++;
  const pending = (async () => {
    await refreshOiExchangeSymbols();
    const { binanceSymbol, bybitSymbol } = resolveOiSymbols(rawSymbol, baseAsset);
    const symbol = exchange === 'binance' ? binanceSymbol : bybitSymbol;
    const price = curPrice && curPrice > 0 ? curPrice : 0;
    let data: ExchangeOIData | null = null;
    if (symbol) {
      if (exchange === 'binance') {
        liveOiCounters.upstreamBinance++;
        data = await fetchBinanceOiSingle(symbol, price);
      } else {
        liveOiCounters.upstreamBybit++;
        data = await fetchBybitOiSingle(symbol, price);
      }
    }
    if (!data) liveOiCounters.unavailable++;
    singleOiCache.set(key, { timestamp: Date.now(), data });
    if (singleOiCache.size > 1000) singleOiCache.delete(singleOiCache.keys().next().value!);
    return data;
  })();
  singleOiInFlight.set(key, pending);
  try { return withCurrentOiPrice(await pending, curPrice); }
  finally { if (singleOiInFlight.get(key) === pending) singleOiInFlight.delete(key); }
}

export async function fetchDualExchangeOI(
  rawSymbol: string,
  baseAsset?: string,
  curPrice?: number
): Promise<OiPair> {
  const cacheKey = `${rawSymbol}_${baseAsset || ''}`.toUpperCase();
  const cached = oiResultCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < OI_RESULT_CACHE_TTL) return cached.data;

  const existing = oiResultInFlight.get(cacheKey);
  if (existing) return existing;
  const pending = (async (): Promise<OiPair> => {
    const [binanceResult, bybitResult] = await Promise.allSettled([
      fetchSingleExchangeOI('binance', rawSymbol, baseAsset, curPrice),
      fetchSingleExchangeOI('bybit', rawSymbol, baseAsset, curPrice),
    ]);
    const currentBinance = binanceResult.status === 'fulfilled' ? binanceResult.value : null;
    const change5m = currentBinance
      ? await fetchBinanceOiHistoricalChange5m(currentBinance.symbol).catch(() => null) : null;
    const binance = currentBinance && change5m !== null
      ? { ...currentBinance, change5mPct: change5m } : currentBinance;
    const bybit = bybitResult.status === 'fulfilled' ? bybitResult.value : null;
    const result = { binance, bybit, totalOIUsd: (binance?.valueUsd || 0) + (bybit?.valueUsd || 0) };
    oiResultCache.set(cacheKey, { timestamp: Date.now(), data: result });
    // Bound memory while keeping active symbols hot (same strategy as candle cache).
    if (oiResultCache.size > 1000) oiResultCache.delete(oiResultCache.keys().next().value!);
    return result;
  })();
  oiResultInFlight.set(cacheKey, pending);
  try { return await pending; }
  finally { if (oiResultInFlight.get(cacheKey) === pending) oiResultInFlight.delete(cacheKey); }
}
