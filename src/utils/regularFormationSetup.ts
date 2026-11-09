import type { DetectedFormation, Kline } from '../types';
import { formatCryptoPrice } from './formatters';
import { calculateATR, validateFormation } from './formationValidation';
import { reassessRegularFormationQuality } from './regularFormationQuality';

export interface RegularSetupAdjustment {
  originalTarget: number;
  measuredTarget: number;
  atr14: number;
  tickVerified: boolean;
  reasons: Array<'ATR' | 'R:R limit' | 'price range' | 'swing obstacle'>;
}

const valid = (n: number) => Number.isFinite(n) && n > 0;
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-12, Math.abs(a) * 1e-9);

function previousObstacle(
  candles: Kline[], formation: DetectedFormation, entry: number, rawTarget: number, atr: number,
): number | null {
  const boundary = Math.max(0, Math.min(candles.length, formation.candleStartIndex ?? candles.length - 20));
  const old = candles.slice(Math.max(0, boundary - 60), boundary);
  if (old.length < 7) return null;
  const bullish = formation.bias === 'bullish';
  const nearest: number[] = [];
  const minimum = Math.max(atr * .6, entry * .0015);
  for (let i = 2; i < old.length - 2; i++) {
    const c = old[i];
    const swing = bullish ? c.high : c.low;
    const confirmed = bullish
      ? old.slice(i - 2, i + 3).every((x, j) => j === 2 || swing > x.high)
      : old.slice(i - 2, i + 3).every((x, j) => j === 2 || swing < x.low);
    if (!confirmed) continue;
    const distance = bullish ? swing - entry : entry - swing;
    if (distance > minimum && distance < Math.abs(rawTarget - entry)) nearest.push(distance);
  }
  return nearest.length ? Math.min(...nearest) : null;
}

function align(price: number, tick: number | null, side: 'up' | 'down'): number {
  if (!tick || !valid(tick)) return Number(price.toPrecision(11));
  const steps = side === 'up'
    ? Math.ceil(price / tick - 1e-9)
    : Math.floor(price / tick + 1e-9);
  return Number((steps * tick).toPrecision(12));
}

/**
 * Conservative target execution model for STANDARD formation scans only.
 *
 * Never extend the detector's measured target to manufacture a minimum R:R.
 * Cap extreme projections by measured ATR, structural risk, and the nearby
 * prior swing. Revalidate all confirmation and confluence scores afterwards.
 * This function is NOT called by the full early W/M scanner.
 */
export function refineRegularFormationSetup(
  candles: Kline[], formation: DetectedFormation, tickSize: number | null = null,
): DetectedFormation {
  const { entryPrice: rawEntry, targetPrice: measuredTP, stopLossPrice: rawStop } = formation.levels;
  if (formation.bias === 'neutral' || formation.status === 'target_reached'
    || ![rawEntry, measuredTP, rawStop].every(valid) || candles.length < 35) return formation;
  const long = formation.bias === 'bullish';
  // An order-triggering entry rounds against the trader, never optimistically.
  const entry = align(rawEntry, tickSize, long ? 'up' : 'down');
  if (!(long ? rawStop < entry && measuredTP > entry : measuredTP < entry && entry < rawStop)) return formation;
  const atr = calculateATR(candles, 14);
  if (!valid(atr)) return formation;

  // Stops stay behind original invalidation levels. Only widen unrealistically
  // tight stops; never tighten them to improve R:R.
  const minStop = atr * .65;
  const stop = long
    ? align(Math.min(rawStop, entry - minStop), tickSize, 'down')
    : align(Math.max(rawStop, entry + minStop), tickSize, 'up');
  if (!valid(stop)) return formation;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(measuredTP - entry);
  const maxima: Array<{ reason: RegularSetupAdjustment['reasons'][number]; dist: number }> = [
    { reason: 'ATR', dist: atr * 3.2 },
    { reason: 'R:R limit', dist: risk * 2.6 },
    { reason: 'price range', dist: entry * .045 },
  ];
  const obstacle = previousObstacle(candles, formation, entry, measuredTP, atr);
  if (obstacle !== null && obstacle > atr * .18) {
    maxima.push({ reason: 'swing obstacle', dist: obstacle - atr * .15 });
  }
  const maxDistance = Math.max(0, Math.min(reward, ...maxima.map(x => x.dist)));
  if (!valid(maxDistance) || maxDistance >= reward && near(stop, rawStop) && near(entry, rawEntry)) return formation;
  const calculatedTP = long ? entry + maxDistance : entry - maxDistance;
  // A profit target is rounded inward; a stop is rounded away from entry.
  const target = align(calculatedTP, tickSize, long ? 'down' : 'up');
  if (!valid(target) || (long ? target <= entry : target >= entry)) return formation;
  // Rounding to a coarse exchange tick can collapse a proposed entry/target.
  if (Math.abs(target - entry) < (tickSize || 0)) return formation;

  // Existing confluence formation component derives from the detector's
  // pre-confluence geometry score. Feeding final confidence back to the
  // validator would inflate/deflate quality on every recalculation.
  const formationScore = formation.validation?.confluence?.components.formation.score;
  const baseConfidence = formationScore === undefined
    ? formation.confidence : formationScore / 15 * 100;
  const originalLabel = formation.statusLabel
    .replace(/ · кругле число$/u, '')
    .replace(/(?: · (?:ПІДТВЕРДЖЕНО|очікування пробою|очікування підтвердження))+$/gu, '');
  const newLevels = { ...formation.levels, entryPrice: entry, targetPrice: target, stopLossPrice: stop };
  let result = validateFormation(candles, {
    ...formation, confidence: baseConfidence, statusLabel: originalLabel,
    levels: newLevels,
  }, tickSize);
  const oldLabel = '$' + formatCryptoPrice(measuredTP);
  const newLabel = '$' + formatCryptoPrice(target);
  // Keep narrative and chart levels consistent for all formation families.
  const description = formation.description.includes(oldLabel)
    ? formation.description.replaceAll(oldLabel, newLabel)
    : formation.description;
  const reasons = maxima.filter(item => reward > item.dist + Math.max(1e-12, reward * 1e-8)
    && near(maxDistance, item.dist)).map(item => item.reason);
  result = {
    ...result,
    id: formation.id,
    description,
    roundNumberContext: formation.roundNumberContext,
    statusLabel: formation.roundNumberContext?.detected
      ? result.statusLabel + ' · кругле число' : result.statusLabel,
    regularSetupAdjustment: {
      originalTarget: measuredTP, measuredTarget: target, atr14: atr,
      tickVerified: valid(tickSize || 0), reasons,
    },
  };
  return result;
}

export function refineRegularFormationSet(
  candles: Kline[], formations: DetectedFormation[], tickSize: number | null = null,
): DetectedFormation[] {
  return formations.map(formation => reassessRegularFormationQuality(candles,
    refineRegularFormationSetup(candles, formation, tickSize)));
}
