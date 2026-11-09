import type { DetectedFormation, Kline, RegularIndicatorValues, ScannedCoin } from '../types';
import { calculateATR } from './formationValidation';
/**
 * Exchange-provided taker BUY quote turnover, not a candle-color estimate.
 * Fails closed if any of the last 20 candles lacks verified turnover or has a gap.
 * Binance supplies these fields for SPOT and USD-M futures; Bybit OHLCV does not.
 */
export function calculateBinanceQuoteTradeDelta(
  candles: Kline[],
): Pick<RegularIndicatorValues, 'deltaPct' | 'deltaUsd' | 'cvd20Pct' | 'cvd20Usd'> {
  const selected = candles.slice(-20);
  if (selected.length !== 20) return {};
  const interval = selected[1].time - selected[0].time;
  if (!Number.isFinite(interval) || interval <= 0) return {};
  let sumTotal = 0, sumDelta = 0, lastTotal = 0, lastDelta = 0;
  for (let i = 0; i < selected.length; i++) {
    const bar = selected[i];
    const total = bar.quoteVolume, buys = bar.buyQuoteVolume;
    if (i && bar.time - selected[i-1].time !== interval) return {};
    if (total === undefined || buys === undefined ||
      !Number.isFinite(total) || !Number.isFinite(buys) ||
      total <= 0 || buys < 0 || buys > total * (1 + 1e-8)) return {};
    const delta = 2 * buys - total;
    sumTotal += total;
    sumDelta += delta;
    if (i === selected.length - 1) { lastTotal = total; lastDelta = delta; }
  }
  if (sumTotal <= 0 || lastTotal <= 0) return {};
  return {
    deltaPct: Number((lastDelta / lastTotal * 100).toFixed(2)),
    deltaUsd: Number(lastDelta.toFixed(2)),
    cvd20Pct: Number((sumDelta / sumTotal * 100).toFixed(2)),
    cvd20Usd: Number(sumDelta.toFixed(2)),
  };
}


/** These settings belong only to the regular screener, never the early W/M mode. */
export interface RegularIndicatorFilters {
  atrBand: 'all' | 'low' | 'medium' | 'high' | 'veryHigh';
  /** Volume of the confirmed breakout candle versus its 20 prior closed candles. */
  minBreakoutRvol: 0 | 1 | 1.2 | 1.5 | 2;
  rsiZone: 'all' | 'oversold' | 'bearish' | 'neutral' | 'bullish' | 'overbought';
  oiChange: 'all' | 'rising' | 'falling' | 'stable';
  delta: 'all' | 'positive' | 'negative' | 'strongPositive' | 'strongNegative';
  cvd20: 'all' | 'positive' | 'negative';
}

export const DEFAULT_REGULAR_INDICATOR_FILTERS: Readonly<RegularIndicatorFilters> = Object.freeze({
  atrBand: 'all',
  minBreakoutRvol: 0,
  rsiZone: 'all',
  oiChange: 'all',
  delta: 'all',
  cvd20: 'all',
});

/** Wilder's RSI(14), computed exclusively from the already closed candle set. */
export function calculateClosedRsi14(candles: Kline[]): number | null {
  const period = 14;
  if (candles.length < period + 1 || !candles.every(c => Number.isFinite(c.close) && c.close > 0)) return null;
  let totalGain = 0;
  let totalLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    totalGain += Math.max(0, change);
    totalLoss += Math.max(0, -change);
  }
  let averageGain = totalGain / period;
  let averageLoss = totalLoss / period;
  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period;
  }
  if (averageGain === 0 && averageLoss === 0) return 50;
  if (averageLoss === 0) return 100;
  if (averageGain === 0) return 0;
  const rsi = 100 - 100 / (1 + averageGain / averageLoss);
  return Number.isFinite(rsi) ? Math.max(0, Math.min(100, rsi)) : null;
}

/**
 * Only supply candles already confirmed closed by the market data pipeline.
 * Reject gapped / invalid datasets instead of displaying invented indicators.
 */
export function calculateRegularIndicatorValues(candles: Kline[]): RegularIndicatorValues {
  const missing: RegularIndicatorValues = { atrPct: null, rsi14: null };
  if (candles.length < 15 || !candles.every((c, i) =>
    Number.isFinite(c.time) && (!i || c.time > candles[i - 1].time) &&
    [c.open, c.high, c.low, c.close].every(v => Number.isFinite(v) && v > 0) &&
    Number.isFinite(c.volume) && c.volume >= 0 &&
    c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close) &&
    c.high >= c.low)) return missing;
  const last = candles[candles.length - 1];
  const atr = calculateATR(candles, 14);
  return {
    atrPct: Number.isFinite(atr) && atr >= 0 ? atr / last.close * 100 : null,
    rsi14: calculateClosedRsi14(candles),
    ...calculateBinanceQuoteTradeDelta(candles),
  };
}

export function countActiveRegularIndicatorFilters(filters: RegularIndicatorFilters): number {
  return Number(filters.atrBand !== 'all')
    + Number(filters.minBreakoutRvol > 0)
    + Number(filters.rsiZone !== 'all')
    + Number(filters.oiChange !== 'all')
    + Number(filters.delta !== 'all')
    + Number(filters.cvd20 !== 'all');
}

export function matchesRegularIndicatorFilters(
  coin: ScannedCoin, formation: DetectedFormation, filters: RegularIndicatorFilters,
): boolean {
  if (countActiveRegularIndicatorFilters(filters) === 0) return true;
  const indicators = coin.regularIndicators;
  if (filters.atrBand !== 'all') {
    const atr = indicators?.atrPct;
    if (atr === null || atr === undefined || !Number.isFinite(atr)) return false;
    if (filters.atrBand === 'low' && !(atr < 0.5)) return false;
    if (filters.atrBand === 'medium' && !(atr >= 0.5 && atr < 1.5)) return false;
    if (filters.atrBand === 'high' && !(atr >= 1.5 && atr < 3)) return false;
    if (filters.atrBand === 'veryHigh' && !(atr >= 3)) return false;
  }
  if (filters.rsiZone !== 'all') {
    const rsi = indicators?.rsi14;
    if (rsi === null || rsi === undefined || !Number.isFinite(rsi)) return false;
    if (filters.rsiZone === 'oversold' && !(rsi < 30)) return false;
    if (filters.rsiZone === 'bearish' && !(rsi >= 30 && rsi < 45)) return false;
    if (filters.rsiZone === 'neutral' && !(rsi >= 45 && rsi < 55)) return false;
    if (filters.rsiZone === 'bullish' && !(rsi >= 55 && rsi < 70)) return false;
    if (filters.rsiZone === 'overbought' && !(rsi >= 70)) return false;
  }
  if (filters.oiChange !== 'all') {
    // Open interest is a derivatives-only metric.
    const oi = indicators?.oiChangePct;
    if (coin.marketType !== 'futures' || oi === undefined || !Number.isFinite(oi)) return false;
    if (filters.oiChange === 'rising' && oi < 1) return false;
    if (filters.oiChange === 'falling' && oi > -1) return false;
    if (filters.oiChange === 'stable' && Math.abs(oi) >= 1) return false;
  }
  if (filters.delta !== 'all') {
    const delta = indicators?.deltaPct;
    if (delta === undefined || !Number.isFinite(delta)) return false;
    if (filters.delta === 'positive' && delta <= 0) return false;
    if (filters.delta === 'negative' && delta >= 0) return false;
    if (filters.delta === 'strongPositive' && delta < 20) return false;
    if (filters.delta === 'strongNegative' && delta > -20) return false;
  }
  if (filters.cvd20 !== 'all') {
    const cvd = indicators?.cvd20Pct;
    if (cvd === undefined || !Number.isFinite(cvd)) return false;
    if (filters.cvd20 === 'positive' && cvd <= 0) return false;
    if (filters.cvd20 === 'negative' && cvd >= 0) return false;
  }
  if (filters.minBreakoutRvol > 0) {
    // No confirmed breakout means no breakout candle to evaluate; the
    // unrelated last candle's volume must not make the setup pass this filter.
    const validation = formation.validation;
    if (!validation?.breakoutConfirmed ||
      !Number.isFinite(validation.volumeRatio) ||
      validation.volumeRatio < filters.minBreakoutRvol) return false;
  }
  return true;
}
