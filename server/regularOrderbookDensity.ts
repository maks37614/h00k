import type { PatternBias, RoundNumberDensity } from '../src/types';

export interface PriceLevelSnapshot {
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
}

const positive = (n: number) => Number.isFinite(n) && n > 0;
const pct = (a: number, b: number) => Math.abs(a - b) / Math.max(b, 1e-12) * 100;

function roundStep(price: number): number {
  if (!positive(price)) return 0;
  const base = 10 ** Math.floor(Math.log10(price));
  return base >= 1 ? base : base / 10;
}

/**
 * Standard-mode snapshot only: do not mistake an ASK sell wall for LONG
 * support or a BID buy wall for SHORT resistance. Compare liquidity against
 * other orders on the SAME side, not a possibly tiny opposite-side median.
 *
 * This snapshot is not evidence that the wall persists or that an order fills.
 */
export function identifyRegularRoundNumberDensity(
  orderbook: PriceLevelSnapshot, reference: number, marketPrice: number,
  bias: PatternBias,
): RoundNumberDensity | undefined {
  if (!positive(reference) || !positive(marketPrice) || bias === 'neutral') return undefined;
  const step = roundStep(reference);
  if (!positive(step)) return undefined;
  const level = Math.round(reference / step) * step;
  if (!positive(level)) return undefined;
  const tolerancePct = Math.min(.6, Math.max(.12, step / reference * 8));
  if (pct(reference, level) > tolerancePct) return undefined;
  const bullish = bias === 'bullish';
  // BID support should be on/below current price; ASK resistance on/above.
  if (bullish && level > marketPrice * 1.002) return undefined;
  if (!bullish && level < marketPrice * .998) return undefined;
  const side = bullish ? 'BID' as const : 'ASK' as const;
  const rows = bullish ? orderbook.bids : orderbook.asks;
  if (!Array.isArray(rows)) return undefined;
  const validRows = rows.map(([price, quantity]) => ({
    price, quantity, notional: price * quantity,
  })).filter(x => positive(x.price) && positive(x.quantity) && positive(x.notional)
    && (bullish ? x.price <= marketPrice * 1.002 : x.price >= marketPrice * .998));
  if (validRows.length < 8) return undefined;
  const medianSorted = validRows.map(x => x.notional).sort((a,b) => a - b);
  const median = medianSorted[Math.floor(medianSorted.length / 2)];
  if (!positive(median)) return undefined;
  const near = validRows
    .filter(x => pct(x.price, level) <= Math.min(.35, tolerancePct))
    .sort((a,b) => b.notional - a.notional);
  const wall = near[0];
  if (!wall || wall.notional < 5000 || wall.notional / median < 6) return undefined;
  const multiple = wall.notional / median;
  const quality = Math.round(Math.max(0, Math.min(100, 35 + Math.log10(multiple) * 45)));
  if (quality < 70) return undefined;
  return {
    level: Number(level.toPrecision(12)), side,
    notionalUsd: Number(wall.notional.toFixed(2)),
    distancePct: Number(pct(wall.price, level).toFixed(3)), quality,
  };
}
