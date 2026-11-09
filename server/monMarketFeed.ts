import type { Express, Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getPaperFormationSnapshots, getPaperMarketSnapshot, fetchKlines } from './marketService';
import { formationDensityFeed } from './formationDensityFeed';
import { getMarketSourceStatuses } from './marketTickerFeed';
import type { ExchangeId, Timeframe } from '../src/types';

function authorized(req: Request, res: Response): boolean {
  const expected = process.env.HOOK_PAPER_FEED_TOKEN || '';
  if (expected.length < 32) { res.sendStatus(503); return false; }
  const received = req.get('authorization')?.match(/^Bearer (\S+)$/)?.[1] || '';
  const hash = (value: string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(hash(expected), hash(received))) {
    res.sendStatus(401);
    return false;
  }
  return true;
}
const intervals: Record<'1m'|'5m',number> = { '1m':60, '5m':300 };
const symbolPattern = /^[A-Z0-9]{3,40}$/;
/** Explicit concurrency and query budget: the bot cannot launch a new market-wide scan. */
let activeRequests = 0;
let minute = 0;
let minuteRequests = 0;

export function installMonMarketFeed(app: Express) {
  app.get('/api/mon/feed', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!authorized(req, res)) return;
    const now = Date.now();
    const snapshots = getPaperFormationSnapshots(now);
    const selection = new Set<string>();
    for (const group of snapshots) {
      for (const coin of group.data) {
        if (coin.marketType === 'futures' && coin.formations.length &&
          coin.formationData?.contiguous &&
          now - coin.formationData.collectedAt <= 180000)
          selection.add(coin.exchange + ':futures:' + coin.symbol);
      }
    }
    const density = formationDensityFeed.snapshot(now).filter(row => selection.has(row.instrument));
    const market = getPaperMarketSnapshot([...selection].slice(0,12), [], now);
    // Use the freshest genuine exchange ticker from the bounded WS streams.
    // Never synthesize a traded price from a book midpoint.
    type ExportQuote = { exchange: ExchangeId; marketType: 'spot'|'futures'; symbol: string;
      price: number; updatedAt: number | null; };
    const quotes = new Map<string, ExportQuote>(market.quotes.map(q =>
      [q.exchange + ':' + q.marketType + ':' + q.symbol, q]));
    for (const depth of density) {
      const quote = depth.tradeQuote;
      if (!quote) continue;
      const prior = quotes.get(depth.instrument);
      if (!prior || (prior.updatedAt || 0) < quote.updatedAt)
        quotes.set(depth.instrument, quote);
    }
    res.json({
      version: 1, success: true, generatedAt: now,
      snapshots, market: { quotes: [...quotes.values()] },
      density, collection: { type: 'cached-formations', streamCap: 8 },
      sources: getMarketSourceStatuses({ exchange:'all', marketType:'futures' }),
    });
  });

  app.get('/api/mon/candles', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!authorized(req, res)) return;
    const exchange = req.query.exchange;
    const symbol = req.query.symbol;
    const timeframe = req.query.timeframe;
    const limit = Number(req.query.limit);
    if ((exchange !== 'binance' && exchange !== 'bybit') ||
      typeof symbol !== 'string' || !symbolPattern.test(symbol) ||
      (timeframe !== '1m' && timeframe !== '5m') ||
      !Number.isInteger(limit) || limit < 30 || limit > 900) {
      res.status(400).json({ success: false, error: 'Invalid bounded candle request' });
      return;
    }
    const now = Date.now();
    const authorizedInstrument = getPaperFormationSnapshots(now)
      .some(group => group.data.some(coin =>
        coin.marketType === 'futures' && coin.exchange === exchange &&
        coin.symbol === symbol && coin.formations.length > 0 &&
        coin.formationData?.contiguous === true &&
        now >= coin.formationData.collectedAt &&
        now - coin.formationData.collectedAt <= 180000));
    if (!authorizedInstrument) {
      res.status(409).json({ success: false, error: 'Instrument absent from fresh formation feed' });
      return;
    }
    const bucket = Math.floor(now / 60000);
    if (bucket !== minute) { minute = bucket; minuteRequests = 0; }
    if (activeRequests >= 3 || minuteRequests >= 90) {
      res.status(429).json({ success: false, error: 'Feed request budget exceeded' });
      return;
    }
    activeRequests++;
    minuteRequests++;
    try {
      const bars = await fetchKlines(exchange as ExchangeId, 'futures', symbol,
        timeframe as Timeframe, limit, undefined, undefined, { requireFresh: true });
      const collectedAt = Date.now();
      const period = intervals[timeframe];
      const candles = bars.filter(c => Number.isSafeInteger(c.time) &&
        [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
        c.time > 0 && c.open > 0 && c.close > 0 && c.low > 0 &&
        c.high >= Math.max(c.open,c.close,c.low) &&
        c.low <= Math.min(c.open,c.close) && c.volume >= 0 &&
        (c.time + period) * 1000 <= collectedAt).sort((a,b)=>a.time-b.time);
      const contiguous = candles.length >= 30 &&
        candles.every((c,i) => !i || c.time - candles[i-1].time === period);
      const lastClosedAt = candles.length ? (candles[candles.length-1].time + period)*1000 : 0;
      const fresh = contiguous && collectedAt - lastClosedAt >= 0 &&
        collectedAt - lastClosedAt <= period*1000 + 15000;
      if (!fresh) {
        res.status(503).json({ success: false, error: 'Missing, noncontiguous or stale closed exchange candles' });
        return;
      }
      res.json({ version: 1, success: true, exchange, marketType:'futures',
        symbol, timeframe, collectedAt, lastClosedAt, contiguous:true, candles });
    } catch {
      res.status(503).json({ success: false, error: 'Verified exchange candles unavailable' });
    } finally {
      activeRequests--;
    }
  });
}
