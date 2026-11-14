import { exchangeFetch } from './exchangeHttp';
import { ExchangeId, MarketType, Timeframe, Kline, SmartAnalysisData, DetectedFormation } from '../src/types';
import { fetchKlines } from './marketService';
import { fetchHookChartOIHistory } from './hookchartOI';
import { summarizeVerifiedUsdOI } from './oiIntegrity';

// In-memory cache for smart analysis
const analysisCache = new Map<string, { timestamp: number; data: SmartAnalysisData }>();
const CACHE_TTL_MS = 15 * 1000; // 15s cache

// Technical calculations
function calculateRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(diff)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(1));
}

function calculateEMA(closes: number[], period: number): number {
  if (closes.length === 0) return 0;
  if (closes.length < period) return closes[closes.length - 1];

  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateATR(klines: Kline[], period: number = 14): number {
  if (klines.length < 2) return 0;
  const trs: number[] = [];

  for (let i = 1; i < klines.length; i++) {
    const high = klines[i].high;
    const low = klines[i].low;
    const prevClose = klines[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }

  const slice = trs.slice(-period);
  if (slice.length === 0) return 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// Calculate Volume POC (Point of Control)
function calculatePOC(klines: Kline[]): { pocPrice: number | null; pocVolumePct: number | null } {
  if (klines.length < 10) return { pocPrice: null, pocVolumePct: null };

  let minPrice = Infinity;
  let maxPrice = -Infinity;
  for (const k of klines) {
    if (k.low < minPrice) minPrice = k.low;
    if (k.high > maxPrice) maxPrice = k.high;
  }

  if (minPrice >= maxPrice || minPrice === Infinity) {
    return { pocPrice: null, pocVolumePct: null };
  }

  const BINS = 24;
  const binSize = (maxPrice - minPrice) / BINS;
  const bins = new Array(BINS).fill(0);
  let totalVol = 0;

  for (const k of klines) {
    const mid = (k.high + k.low + k.close) / 3;
    const binIdx = Math.min(Math.max(Math.floor((mid - minPrice) / binSize), 0), BINS - 1);
    bins[binIdx] += k.volume;
    totalVol += k.volume;
  }

  let maxBinIdx = 0;
  let maxBinVol = 0;
  bins.forEach((vol, idx) => {
    if (vol > maxBinVol) {
      maxBinVol = vol;
      maxBinIdx = idx;
    }
  });

  const pocPrice = minPrice + (maxBinIdx + 0.5) * binSize;
  if (totalVol <= 0 || maxBinVol <= 0) return { pocPrice: null, pocVolumePct: null };
  const pocVolumePct = Math.round((maxBinVol / totalVol) * 100);
  return {
    pocPrice: Number(pocPrice.toPrecision(6)),
    pocVolumePct,
  };
}

// Verified BTC futures context. Never substitute made-up price, structure, or calendar events.
async function analyzeBTCStructure(): Promise<SmartAnalysisData['btcContext']> {
  const get = async (path: string): Promise<unknown> => {
    try {
      const response = await exchangeFetch('https://fapi.binance.com' + path, {
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) return null;
      return await response.json();
    } catch { return null; }
  };
  const [raw15m, raw5m, raw1m, ticker] = await Promise.all([
    get('/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=25'),
    get('/fapi/v1/klines?symbol=BTCUSDT&interval=5m&limit=25'),
    get('/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=25'),
    get('/fapi/v1/ticker/24hr?symbol=BTCUSDT'),
  ]);
  type Slice = SmartAnalysisData['btcContext']['timeframes']['15m'];
  const unavailable: Slice = {
    direction: 'sideways', structure: 'unknown', label: 'Немає даних біржі',
  };
  const parse = (raw: unknown, minutes: number): Slice => {
    if (!Array.isArray(raw)) return unavailable;
    const now = Date.now();
    const candles = raw.filter((entry): entry is unknown[] =>
      Array.isArray(entry) && entry.length >= 5 &&
      Number.isFinite(Number(entry[0])) && Number(entry[0]) + minutes * 60_000 <= now &&
      [entry[2], entry[3], entry[4]].every(value => Number.isFinite(Number(value)) && Number(value) > 0));
    if (candles.length < 6) return unavailable;
    const previous = candles.slice(-6, -3);
    const recent = candles.slice(-3);
    const prevHigh = Math.max(...previous.map(c => Number(c[2])));
    const prevLow = Math.min(...previous.map(c => Number(c[3])));
    const lastHigh = Math.max(...recent.map(c => Number(c[2])));
    const lastLow = Math.min(...recent.map(c => Number(c[3])));
    if (lastHigh > prevHigh && lastLow > prevLow) return {
      direction: 'up', structure: 'HH_HL', label: 'Вищі максимуми та мінімуми',
    };
    if (lastHigh < prevHigh && lastLow < prevLow) return {
      direction: 'down', structure: 'LH_LL', label: 'Нижчі максимуми та мінімуми',
    };
    return { direction: 'sideways', structure: 'range', label: 'Змішана структура / діапазон' };
  };
  const tf15 = parse(raw15m, 15);
  const tf5 = parse(raw5m, 5);
  const tf1 = parse(raw1m, 1);
  const tickerValue = ticker && typeof ticker === 'object' ? ticker as Record<string, unknown> : null;
  const priceValue = Number(tickerValue?.lastPrice);
  const changeValue = Number(tickerValue?.priceChangePercent);
  const btcPrice = tickerValue?.lastPrice != null && Number.isFinite(priceValue) && priceValue > 0
    ? priceValue : null;
  const change24h = tickerValue?.priceChangePercent != null && Number.isFinite(changeValue)
    ? changeValue : null;
  const valid15 = tf15.structure !== 'unknown';
  const valid5 = tf5.structure !== 'unknown';
  const overallStructure: SmartAnalysisData['btcContext']['overallStructure'] =
    !valid15 || !valid5 ? 'unknown'
      : tf15.structure === tf5.structure ? tf15.structure : 'range';
  const overallStructureLabel = overallStructure === 'unknown'
    ? 'Структура BTC недоступна: потрібні підтверджені свічки Binance Futures'
    : overallStructure === 'HH_HL'
      ? 'Вищі максимуми та мінімуми BTC на 15m і 5m'
      : overallStructure === 'LH_LL'
        ? 'Нижчі максимуми та мінімуми BTC на 15m і 5m'
        : 'Структура BTC неоднозначна на 15m і 5m';
  let hasSharpImpulse = false;
  let impulseType: SmartAnalysisData['btcContext']['impulseType'] = 'none';
  let impulseDescription = 'Немає підтвердженого імпульсу в останній закритій 5m свічці';
  if (Array.isArray(raw5m)) {
    const complete = raw5m.filter(row => Array.isArray(row) &&
      Number(row[0]) + 5 * 60_000 <= Date.now() &&
      Number(row[1]) > 0 && Number.isFinite(Number(row[4])));
    const last = complete.at(-1);
    if (last) {
      const change = (Number(last[4]) / Number(last[1]) - 1) * 100;
      hasSharpImpulse = Number.isFinite(change) && Math.abs(change) >= 0.75;
      if (hasSharpImpulse) {
        impulseType = change > 0 ? 'pump' : 'dump';
        impulseDescription = 'Остання закрита 5m свічка BTC: ' +
          (change > 0 ? '+' : '') + change.toFixed(2) + '%';
      }
    } else {
      impulseDescription = 'Дані 5m недоступні';
    }
  } else {
    impulseDescription = 'Дані 5m недоступні';
  }
  return {
    btcPrice, change24h,
    available: btcPrice !== null || valid15 || valid5 || tf1.structure !== 'unknown',
    timeframes: { '15m': tf15, '5m': tf5, '1m': tf1 },
    overallStructure, overallStructureLabel,
    hasSharpImpulse, impulseType, impulseDescription,
    // No calendar provider is connected; synthetic CPI/session countdowns are misleading.
    upcomingNews: [],
  };
}

// Exchange-specific, time-bounded orderbook snapshot. No fabricated bids/asks
// on REST failure, and never substitute Binance Futures for Bybit or spot.
async function fetchOrderbookAnalysis(
  symbol: string, exchange: ExchangeId, marketType: MarketType,
): Promise<SmartAnalysisData['orderbook'] & { spread: SmartAnalysisData['spread'] }> {
  const source = exchange + ' ' + marketType;
  const missing: SmartAnalysisData['orderbook'] & { spread: SmartAnalysisData['spread'] } = {
    available: false, source, bidAskRatio: null, dominantSide: 'unavailable',
    bidWallUsd: null, bidWallPrice: null, askWallUsd: null, askWallPrice: null,
    largeOrders: [], spread: { spreadUsd: null, spreadPct: null, quality: 'unavailable' },
  };
  try {
    const url = exchange === 'bybit'
      ? 'https://api.bybit.com/v5/market/orderbook?category=' +
        (marketType === 'spot' ? 'spot' : 'linear') +
        '&symbol=' + encodeURIComponent(symbol) + '&limit=50'
      : marketType === 'spot'
        ? 'https://data-api.binance.vision/api/v3/depth?symbol=' +
          encodeURIComponent(symbol) + '&limit=50'
        : 'https://fapi.binance.com/fapi/v1/depth?symbol=' +
          encodeURIComponent(symbol) + '&limit=50';
    const response = await exchangeFetch(url, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return missing;
    const payload = await response.json();
    const book = exchange === 'bybit'
      ? (payload?.retCode === 0 ? payload?.result : null) : payload;
    const validate = (side: unknown): [number, number][] => Array.isArray(side)
      ? side.map((row: unknown) => {
        if (!Array.isArray(row)) return [NaN, NaN] as [number, number];
        return [Number(row[0]), Number(row[1])] as [number, number];
      }).filter(([price, quantity]) =>
        Number.isFinite(price) && price > 0 &&
        Number.isFinite(quantity) && quantity > 0)
      : [];
    const bids = validate(exchange === 'bybit' ? book?.b : book?.bids);
    const asks = validate(exchange === 'bybit' ? book?.a : book?.asks);
    if (!bids.length || !asks.length) return missing;
    bids.sort((a,b) => b[0] - a[0]);
    asks.sort((a,b) => a[0] - b[0]);
    const bestBid = bids[0][0], bestAsk = asks[0][0];
    if (!(bestAsk > bestBid)) return missing;
    const spreadUsd = Number((bestAsk - bestBid).toPrecision(6));
    const spreadPct = Number(((bestAsk - bestBid) / bestBid * 100).toFixed(5));
    const usd = ([price, qty]: [number,number]) => price * qty;
    const totalBidUsd = bids.reduce((sum,row) => sum + usd(row), 0);
    const totalAskUsd = asks.reduce((sum,row) => sum + usd(row), 0);
    if (!(totalAskUsd > 0) || !(totalBidUsd > 0)) return missing;
    const bidWall = bids.reduce((largest,row) => usd(row) > usd(largest) ? row : largest,bids[0]);
    const askWall = asks.reduce((largest,row) => usd(row) > usd(largest) ? row : largest,asks[0]);
    const meanOrderUsd = (totalBidUsd + totalAskUsd) / (bids.length + asks.length);
    const threshold = meanOrderUsd * 2.8;
    const largeOrders = [
      ...bids.map(row => ({row,side:'bid' as const})),
      ...asks.map(row => ({row,side:'ask' as const})),
    ].filter(({row}) => usd(row) >= threshold)
      .sort((a,b) => usd(b.row) - usd(a.row)).slice(0,16)
      .map(({row,side}) => ({
        side, price: row[0], amountUsd: Math.round(usd(row)),
        distancePct: Number((Math.abs(row[0] - (side === 'bid' ? bestBid : bestAsk)) /
          (side === 'bid' ? bestBid : bestAsk) * 100).toFixed(3)),
        // A large resting order is NOT evidence of an executed whale transaction.
        significance: usd(row) > threshold * 1.5 ? 'large' as const : 'medium' as const,
      }));
    const bidAskRatio = Number((totalBidUsd / totalAskUsd).toFixed(3));
    return {
      available: true, source, bidAskRatio,
      dominantSide: bidAskRatio > 1.25 ? 'bids' : bidAskRatio < .8 ? 'asks' : 'balanced',
      bidWallUsd: Math.round(usd(bidWall)), bidWallPrice: bidWall[0],
      askWallUsd: Math.round(usd(askWall)), askWallPrice: askWall[0],
      largeOrders,
      spread: {
        spreadUsd, spreadPct,
        quality: spreadPct <= .03 ? 'ultra_tight' : spreadPct <= .1 ? 'normal' : 'wide',
      },
    };
  } catch {
    return missing;
  }
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

// Real derivatives data only; never manufacture OI, change or sparkline history.
async function fetchDerivatives(
  symbol: string, marketType: MarketType,
): Promise<SmartAnalysisData['derivatives']> {
  const absent = { currentUsd: null, change1hPct: null, history: [] as number[] };
  if (marketType !== 'futures') return {
    hasPerpFutures: false, fundingRate: null, predictedFundingRate: null,
    fundingBias: 'neutral', binanceOI: absent, bybitOI: absent,
    totalOIUsd: null, oiCoverage: 'spot', oiTrend: 'unknown',
  };

  let fundingRate: number | null = null;
  let predictedFundingRate: number | null = null;
  const [oiResult] = await Promise.allSettled([
    fetchHookChartOIHistory(symbol, '1h'),
  ]);
  const oi = oiResult.status === 'fulfilled' ? oiResult.value : null;
  const now = Date.now();
  const binanceOI = oi ? summarizeVerifiedUsdOI(oi.binance, now) : absent;
  const bybitOI = oi ? summarizeVerifiedUsdOI(oi.bybit, now) : absent;

  try {
    const res = await exchangeFetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`, {
      headers: BROWSER_HEADERS, signal: AbortSignal.timeout(3500),
    });
    if (res.ok) {
      const payload = await res.json();
      const value = Number(payload?.lastFundingRate);
      if (payload?.lastFundingRate !== null && payload?.lastFundingRate !== undefined
        && Number.isFinite(value)) fundingRate = Number((value * 100).toFixed(4));
    }
  } catch { /* No funding estimate on network failure. */ }
  try {
    const res = await exchangeFetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`, {
      headers: BROWSER_HEADERS, signal: AbortSignal.timeout(3500),
    });
    if (res.ok) {
      const payload = await res.json();
      const ticker = payload?.retCode === 0 ? payload.result?.list?.[0] : undefined;
      const raw = ticker?.predictedFundingRate ?? ticker?.fundingRate;
      if (raw !== null && raw !== undefined && raw !== '') {
        const value = Number(raw);
        if (Number.isFinite(value)) predictedFundingRate = Number((value * 100).toFixed(4));
      }
    }
  } catch { /* Unknown, not 0%. */ }

  const hasBinance = binanceOI.currentUsd !== null;
  const hasBybit = bybitOI.currentUsd !== null;
  const count = Number(hasBinance) + Number(hasBybit);
  const totalOIUsd = count ? (binanceOI.currentUsd ?? 0) + (bybitOI.currentUsd ?? 0) : null;
  const changes = [binanceOI.change1hPct, bybitOI.change1hPct]
    .filter((value): value is number => value !== null);
  const average = changes.length
    ? changes.reduce((sum, value) => sum + value, 0) / changes.length : null;
  return {
    hasPerpFutures: true,
    fundingRate,
    predictedFundingRate,
    fundingBias: fundingRate === null ? 'neutral'
      : fundingRate > 0.04 ? 'bullish' : fundingRate < -0.01 ? 'bearish' : 'neutral',
    binanceOI, bybitOI, totalOIUsd,
    oiCoverage: count === 2 ? 'complete' : count === 1 ? 'partial' : 'none',
    oiTrend: average === null ? 'unknown'
      : average > 1.2 ? 'increasing' : average < -1.2 ? 'decreasing' : 'stable',
  };
}

// Generate Comprehensive Smart Analysis
export async function generateSmartAnalysis(params: {
  symbol: string;
  exchange?: ExchangeId;
  marketType?: MarketType;
  timeframe?: Timeframe;
  formation?: DetectedFormation | null;
  currentPrice?: number;
  klines?: Kline[];
}): Promise<SmartAnalysisData> {
  const symbol = params.symbol.toUpperCase();
  const exchange = params.exchange || 'binance';
  const marketType = params.marketType || 'futures';
  const tf = params.timeframe || '1h';

  const cacheKey = `${symbol}_${exchange}_${marketType}_${tf}`;
  const cached = analysisCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  // At least 200 bars for EMA200; do not invent RSI/EMA on insufficient history.
  let klines = params.klines || [];
  if (klines.length < 201) {
    klines = (await fetchKlines(exchange, marketType, symbol, tf, 220)) || [];
  }
  const finiteBar = (c: Kline) => c &&
    [c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) &&
    c.close > 0 && c.high >= c.low && c.volume >= 0;
  if (klines.length < 201 || !klines.every(finiteBar)) {
    throw new Error('Недостатньо достовірних свічок для індикаторів (EMA200)');
  }
  // Use a real exchange close, not a user-supplied price or arbitrary $100.
  const currentPrice = klines[klines.length - 1].close;

  const closes = klines.map((k) => k.close);
  const highs = klines.map((k) => k.high);
  const lows = klines.map((k) => k.low);

  // Technical calculations
  const rsi = calculateRSI(closes, 14);
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  const atr = calculateATR(klines, 14);

  // Cross signals & alignment
  let crossSignal: SmartAnalysisData['trend']['crossSignal'] = 'compression';
  let crossSignalLabel = 'Консолідація та стиснення середніх (EMA Compression)';

  if (ema20 > ema50 && ema50 > ema200) {
    crossSignal = 'bullish_alignment';
    crossSignalLabel = 'Ідеальне бичаче вирівнювання (EMA 20 > 50 > 200)';
  } else if (ema20 < ema50 && ema50 < ema200) {
    crossSignal = 'bearish_alignment';
    crossSignalLabel = 'Повне низхідне вирівнювання (EMA 20 < 50 < 200)';
  } else if (ema20 > ema50 && closes[closes.length - 1] > ema50) {
    crossSignal = 'golden_cross';
    crossSignalLabel = 'Бичачий золотий перетин (Golden Cross EMA 20/50)';
  } else if (ema20 < ema50 && closes[closes.length - 1] < ema50) {
    crossSignal = 'death_cross';
    crossSignalLabel = 'Ведмежий перетин (Death Cross EMA 20/50)';
  }

  const priceVsEma =
    currentPrice > ema20
      ? `Ціна вище EMA20 на +${(((currentPrice - ema20) / ema20) * 100).toFixed(2)}% (Імпульсний контроль покупців)`
      : `Ціна нижче EMA20 на -${(((ema20 - currentPrice) / ema20) * 100).toFixed(2)}% (Корекційний відкат під опір)`;

  // Independently measure 24h from 24 *completed* one-hour candles, never
  // from 24 bars of an arbitrary selected timeframe.
  const hourly = tf === '1h' ? klines :
    (await fetchKlines(exchange, marketType, symbol, '1h', 26).catch(() => [])) || [];
  const closedHours = hourly.filter((c) => finiteBar(c) &&
    c.time * 1000 + 60 * 60_000 <= Date.now()).slice(-24);
  // USD-equivalent volume only for USD-like quoted pairs. Never label BTC
  // quote turnover as USD or compare it against USD thresholds.
  const quoteIsUsdLike = /(USDT|USDC|BUSD|FDUSD|USD)$/.test(symbol);
  const has24h = quoteIsUsdLike && closedHours.length === 24;
  const barUsd = (bar: Kline) => Number.isFinite(bar.quoteVolume)
    ? bar.quoteVolume! : bar.volume * bar.close;
  const total24hVolUsd = has24h
    ? closedHours.reduce((sum, c) => sum + barUsd(c), 0) : null;
  const last1hVolUsd = has24h ? barUsd(closedHours[closedHours.length - 1]) : null;
  const mean1h = has24h
    ? closedHours.slice(0, -1).reduce((sum,c) => sum + barUsd(c),0) / 23 : null;
  const volume1hSpikeRatio = mean1h !== null && mean1h > 0 && last1hVolUsd !== null
    ? Number((last1hVolUsd / mean1h).toFixed(2)) : null;
  const hasVolumeSpike = volume1hSpikeRatio !== null && volume1hSpikeRatio >= 1.7;

  const dayHigh = has24h ? Math.max(...closedHours.map(c => c.high)) : null;
  const dayLow = has24h ? Math.min(...closedHours.map(c => c.low)) : null;
  const dayRange = dayHigh !== null && dayLow !== null ? dayHigh - dayLow : null;
  const positionInDayRangePct = dayRange !== null && dayRange > 0 && dayLow !== null
    ? Math.max(0,Math.min(100,Math.round((currentPrice-dayLow)/dayRange*100))) : null;
  const dailyRangePct = dayRange !== null && dayLow !== null && dayLow > 0
    ? Number((dayRange/dayLow*100).toFixed(2)) : null;

  // The POC is a candle-typical-price approximation, NOT tick volume-at-price.
  const { pocPrice, pocVolumePct } = calculatePOC(klines);
  const strongSupport = Number((Math.min(...lows.slice(-15)) * .996).toPrecision(6));
  const strongResistance = Number((Math.max(...highs.slice(-15)) * 1.004).toPrecision(6));
  const liquidityLevels: SmartAnalysisData['levels']['liquidityLevels'] = [];
  if (dayHigh !== null && dayLow !== null) {
    liquidityLevels.push({
      label: 'Максимум 24 закритих 1h свічок (можлива зона стопів)',
      price: dayHigh, type: 'sell_side',
      distancePct: Number(((dayHigh-currentPrice)/currentPrice*100).toFixed(2)),
    }, {
      label: 'Мінімум 24 закритих 1h свічок (можлива зона стопів)',
      price: dayLow, type: 'buy_side',
      distancePct: Number(((currentPrice-dayLow)/currentPrice*100).toFixed(2)),
    });
  }
  if (pocPrice !== null) {
    liquidityLevels.push({
      label: 'Оціночний POC за обсягами OHLCV (не ордери стопів)',
      price: pocPrice, type: 'buy_side',
      distancePct: Number(((pocPrice-currentPrice)/currentPrice*100).toFixed(2)),
    });
  }

  // Async parallel external data
  const [btcContext, orderbookData, derivatives] = await Promise.all([
    analyzeBTCStructure(),
    fetchOrderbookAnalysis(symbol, exchange, marketType),
    fetchDerivatives(symbol, marketType),
  ]);

  // Scoring engine (1 to 10)
  let score = 6.0;

  // RSI score
  if (rsi >= 45 && rsi <= 62) score += 1.2; // Healthy momentum
  else if (rsi < 35) score += 0.8; // Oversold potential bounce
  else if (rsi > 75) score -= 1.0; // Overheated

  // Trend EMA score
  if (crossSignal === 'bullish_alignment') score += 1.4;
  else if (crossSignal === 'golden_cross') score += 1.1;
  else if (crossSignal === 'death_cross') score -= 1.2;
  else if (crossSignal === 'bearish_alignment') score -= 1.4;

  // BTC alignment
  if (btcContext.overallStructure === 'HH_HL') score += 1.0;
  else if (btcContext.overallStructure === 'LH_LL') score -= 1.0;

  // Volume confirmation
  if (hasVolumeSpike) score += 0.9;

  // Orderbook bias
  if (orderbookData.dominantSide === 'bids') score += 0.6;
  else if (orderbookData.dominantSide === 'asks') score -= 0.6;

  // Pattern presence
  if (params.formation) {
    if (params.formation.bias === 'bullish') score += 0.8;
    else if (params.formation.bias === 'bearish') score -= 0.5;
  }

  score = Math.min(Math.max(parseFloat(score.toFixed(1)), 1.0), 9.9);

  let verdict: SmartAnalysisData['verdict'] = 'NEUTRAL_WAIT';
  let verdictLabel = 'НЕЙТРАЛЬНО / ОЧІКУВАННЯ ПІДТВЕРДЖЕННЯ';

  if (score >= 8.2) {
    verdict = 'STRONG_BUY';
    verdictLabel = 'СИЛЬНИЙ ВХІД В ЛОНГ (STRONG BUY)';
  } else if (score >= 6.8) {
    verdict = 'BUY';
    verdictLabel = 'ПЕРЕВАГА ПОКУПЦЯ (BUY)';
  } else if (score <= 3.4) {
    verdict = 'AVOID';
    verdictLabel = 'ВИСОКИЙ РИЗИК / УНИКАТИ ВХОДУ (AVOID)';
  } else if (score <= 4.8) {
    verdict = 'SELL';
    verdictLabel = 'ТИСК ПРОДАВЦІВ / ПРІОРИТЕТ ШОРТ (SELL)';
  }

  // Recommended Trade Scenario
  const entryMin = Number((currentPrice * 0.993).toPrecision(6));
  const entryMax = Number((currentPrice * 1.002).toPrecision(6));
  const optimalEntry = currentPrice;

  const slPct = Math.max(parseFloat(((atr / currentPrice) * 1.6 * 100).toFixed(2)), 1.2);
  const stopLoss = Number((currentPrice * (1 - slPct / 100)).toPrecision(6));

  const tp1Pct = parseFloat((slPct * 1.6).toFixed(2));
  const tp2Pct = parseFloat((slPct * 2.8).toFixed(2));
  const tp3Pct = parseFloat((slPct * 4.5).toFixed(2));

  const tp1 = Number((currentPrice * (1 + tp1Pct / 100)).toPrecision(6));
  const tp2 = Number((currentPrice * (1 + tp2Pct / 100)).toPrecision(6));
  const tp3 = Number((currentPrice * (1 + tp3Pct / 100)).toPrecision(6));
  const riskRewardRatio = parseFloat((tp2Pct / slPct).toFixed(2));

  const positionSizingRecommendation =
    'Не визначається без параметрів ризику користувача. Технічний індикатор не є сигналом або рекомендацією плеча.';

  // 1. Actual holder concentration and wallet activity require an on-chain
  // indexer. OHLCV and depth cannot establish who owns tokens or where they move.
  const holdersStatus: SmartAnalysisData['participants']['holders']['status'] = 'unavailable';
  const holdersStatusLabel = 'Ончейн-дані не підключено';
  const top10ConcentrationPct: number | null = null;
  const activeWalletsGrowthPct: number | null = null;
  const retailVsWhaleRatio: string | null = null;
  const phaseDescription = 'Немає підтверджених ончейн-даних про топ-10 гаманців, активні адреси та накопичення. Біржовий обсяг не дозволяє встановити ці показники.';

  // 2. A snapshot shows RESTING LIMIT ORDERS, never executed whale trades,
  // institutional identity, TWAP executions, iceberg orders or absorption.
  const whaleOrders = orderbookData.largeOrders;
  const largePlayerDetected: boolean | null = orderbookData.available ? whaleOrders.length > 0 : null;
  const clusterVolumeUsd: number | null = orderbookData.available
    ? whaleOrders.reduce((sum, order) => sum + order.amountUsd, 0) : null;
  const actionType: SmartAnalysisData['participants']['largePlayer']['actionType'] = 'none';
  const actionLabel = orderbookData.available
    ? 'Великі лімітні заявки у поточному стакані (не виконані угоди)'
    : 'Немає даних стакана';
  const trackedClusters: SmartAnalysisData['participants']['largePlayer']['trackedClusters'] =
    whaleOrders.slice(0, 8).map(order => ({
      type: 'limit_order',
      side: order.side === 'bid' ? 'buy' : 'sell',
      price: order.price, volumeUsd: order.amountUsd,
      timestampDesc: 'Поточний знімок стакана, виконання не підтверджено',
    }));
  const largePlayerNote = orderbookData.available
    ? 'Ці заявки реально присутні у знімку стакана ' + orderbookData.source +
      '. Особа власника, виконання, айсберги та інституційна активність не встановлені.'
    : 'Дані про великі заявки недоступні для вибраного ринку.';

  // 3. Maker identity, HFT algorithm and replenishment speed cannot be
  // verified from one snapshot. The actual quoted spread is shown separately.
  const marketMakerDetected: boolean | null = null;
  const activityLevel: SmartAnalysisData['participants']['marketMaker']['activityLevel'] = 'unknown';
  const activityLabel = 'Немає підтверджених даних про маркет-мейкера';
  const algorithmType: SmartAnalysisData['participants']['marketMaker']['algorithmType'] = null;
  const spreadSupportScore: number | null = null;
  const orderbookReplenishmentSpeed: SmartAnalysisData['participants']['marketMaker']['orderbookReplenishmentSpeed'] = 'unknown';
  const antiSqueezeProtection: boolean | null = null;
  const marketMakerNote = 'Один знімок стакана не визначає HFT/grid-алгоритм, швидкість поновлення заявок або захист від сквизів.';

  // 4. Quantitative MARKET VULNERABILITY signals (not proof of manipulation).
  // Skip each factor completely when its required market data is unavailable.
  const signals: SmartAnalysisData['participants']['manipulativeCoin']['signals'] = [];
  let riskPoints = 10;
  let measuredSignals = 0;
  if (total24hVolUsd !== null) {
    const thinVolume = total24hVolUsd < 800_000;
    measuredSignals++;
    if (thinVolume) riskPoints += 35;
    signals.push({
      name: 'Низький обсяг за 24 закриті 1h свічки (<800k USDT)',
      detected: thinVolume, severity: thinVolume ? 'high' : 'low',
      description: 'Виміряний обсяг ≈ ' + (total24hVolUsd / 1000).toFixed(0) +
        'K у котируваній валюті. Це показник ліквідності, а не доказ маніпуляції.',
    });
  }
  if (dailyRangePct !== null) {
    const highRange = dailyRangePct > 24;
    measuredSignals++;
    if (highRange) riskPoints += 25;
    signals.push({
      name: 'Великий діапазон 24 закритих 1h свічок (>24%)',
      detected: highRange, severity: highRange ? 'high' : 'low',
      description: 'Виміряний діапазон ' + dailyRangePct +
        '%. Велика волатильність сама по собі не доводить маніпуляцій.',
    });
  }
  if (orderbookData.bidAskRatio !== null) {
    const extremeImbalance = orderbookData.bidAskRatio > 3 ||
      orderbookData.bidAskRatio < 1/3;
    measuredSignals++;
    if (extremeImbalance) riskPoints += 20;
    signals.push({
      name: 'Значний дисбаланс заявок Bid/Ask (>3× або <1/3×)',
      detected: extremeImbalance, severity: extremeImbalance ? 'medium' : 'low',
      description: 'Зріз стакана ' + orderbookData.source + ': Bid/Ask = ' +
        orderbookData.bidAskRatio + '. Дисбаланс не доводить спуфінгу.',
    });
  }
  const riskScore: number | null = measuredSignals >= 2
    ? Math.max(0, Math.min(100, riskPoints)) : null;
  const manipulativeRiskLevel: SmartAnalysisData['participants']['manipulativeCoin']['riskLevel'] =
    riskScore === null ? 'unknown' : riskScore >= 75 ? 'extreme' :
    riskScore >= 50 ? 'high' : riskScore >= 30 ? 'medium' : 'low';
  const riskLabel = riskScore === null
    ? 'Індекс вразливості: даних недостатньо'
    : manipulativeRiskLevel === 'low'
      ? 'Низька вразливість за доступними факторами'
      : manipulativeRiskLevel === 'medium'
        ? 'Помірна вразливість за доступними факторами'
        : manipulativeRiskLevel === 'high'
          ? 'Підвищена вразливість за доступними факторами'
          : 'Висока вразливість за доступними факторами';
  const warningSummary = riskScore === null
    ? 'Недостатньо виміряних показників, щоб оцінювати ринкову вразливість.'
    : 'Це евристичний індекс вразливості на основі ' + measuredSignals +
      ' виміряних індикаторів. Маніпуляції, спуфінг і Pump & Dump не доведені.';
  const isManipulativeCoin: boolean | null = null;
  const manipulativeReasons = signals.filter(item => item.detected === true).map(item => item.description);

  // Describe observed data and limitations, never imply institutional proof.
  const summary = 'Технічні показники ' + symbol + ' (' + exchange + ' ' + marketType +
    ', ' + tf + '): RSI14=' + rsi + ', ' + crossSignalLabel + '. ' +
    (btcContext.overallStructure === 'unknown' ? 'BTC: немає структури. ' :
      'BTC: ' + btcContext.overallStructureLabel + '. ') +
    (orderbookData.spread.spreadPct === null
      ? 'Стакан: дані недоступні. '
      : 'Спред у поточному стакані: ' + orderbookData.spread.spreadPct + '%. ') +
    (pocPrice === null ? 'Оціночний POC недоступний. '
      : 'Оціночний POC з OHLCV: ' + pocPrice + '. ') +
    (derivatives.totalOIUsd === null ? 'OI не підтверджено. '
      : 'Перевірений OI: ' + (derivatives.totalOIUsd / 1e6).toFixed(1) + 'M (' +
      (derivatives.oiCoverage === 'partial' ? 'одна біржа' : 'дві біржі') + '). ') +
    'Ончейн-активність, особу власників заявок та маніпуляції не перевірено.';

  const result: SmartAnalysisData = {
    symbol,
    exchange,
    marketType,
    currentPrice,
    lastUpdated: Date.now(),
    score,
    verdict,
    verdictLabel,
    summary,
    positionSizingRecommendation,
    tradeScenario: {
      entryZoneMin: entryMin,
      entryZoneMax: entryMax,
      optimalEntry,
      stopLoss,
      stopLossPct: slPct,
      tp1,
      tp1Pct,
      tp2,
      tp2Pct,
      tp3,
      tp3Pct,
      riskRewardRatio,
    },
    trend: {
      rsi14: rsi,
      rsiStatus: rsi >= 70 ? 'overbought' : rsi <= 30 ? 'oversold' : 'neutral',
      rsiLabel: rsi >= 70 ? 'Перекупленість (>70)' : rsi <= 30 ? 'Перепроданість (<30)' : 'Нейтральний баланс',
      ema20: Number(ema20.toPrecision(6)),
      ema50: Number(ema50.toPrecision(6)),
      ema200: Number(ema200.toPrecision(6)),
      priceVsEma,
      crossSignal,
      crossSignalLabel,
      strengthPct: Math.min(Math.max(Math.round(Math.abs(rsi - 50) * 2 + 40), 20), 98),
    },
    btcContext,
    volumeMetrics: {
      volume24hUsd: total24hVolUsd,
      volume1hUsd: last1hVolUsd,
      volume1hSpikeRatio,
      hasVolumeSpike,
    },
    spread: orderbookData.spread,
    volatility: {
      dailyRangePct,
      atr: Number(atr.toPrecision(5)),
      atrPct: parseFloat(((atr / currentPrice) * 100).toFixed(2)),
      positionInDayRangePct,
      high24h: dayHigh,
      low24h: dayLow,
    },
    orderbook: {
      available: orderbookData.available,
      source: orderbookData.source,
      bidAskRatio: orderbookData.bidAskRatio,
      dominantSide: orderbookData.dominantSide,
      bidWallUsd: orderbookData.bidWallUsd,
      bidWallPrice: orderbookData.bidWallPrice,
      askWallUsd: orderbookData.askWallUsd,
      askWallPrice: orderbookData.askWallPrice,
      largeOrders: orderbookData.largeOrders,
    },
    derivatives,
    levels: {
      pocPrice,
      pocVolumePct,
      liquidityLevels,
      strongSupport,
      strongResistance,
    },
    participants: {
      holders: {
        status: holdersStatus,
        statusLabel: holdersStatusLabel,
        top10ConcentrationPct,
        activeWalletsGrowthPct,
        retailVsWhaleRatio,
        phaseDescription,
      },
      largePlayer: {
        detected: largePlayerDetected,
        confidencePct: null,
        actionType,
        actionLabel,
        clusterVolumeUsd,
        details: largePlayerNote,
        trackedClusters,
      },
      marketMaker: {
        detected: marketMakerDetected,
        activityLevel,
        activityLabel,
        algorithmType,
        spreadSupportScore,
        orderbookReplenishmentSpeed,
        antiSqueezeProtection,
        details: marketMakerNote,
      },
      manipulativeCoin: {
        isManipulative: isManipulativeCoin,
        riskScore,
        riskLevel: manipulativeRiskLevel,
        riskLabel,
        signals,
        warningSummary,
      },
      // Backwards compatibility legacy fields
      holdersStatus,
      holdersConcentrationPct: top10ConcentrationPct,
      largePlayerDetected,
      largePlayerNote,
      marketMakerDetected,
      marketMakerNote,
      isManipulativeCoin,
      manipulativeRiskLevel,
      manipulativeReasons,
    },
  };

  analysisCache.set(cacheKey, { timestamp: Date.now(), data: result });
  return result;
}
