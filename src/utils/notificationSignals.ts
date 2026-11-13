import type { ScannedCoin, SurveillanceEvent, DetectedFormation } from '../types';
import type { SiteNotificationKind, SiteNotificationSettings } from './siteNotifications';
import { DEFAULT_SITE_NOTIFICATIONS, classifySurveillanceEventType, matchesNotificationScope, notificationEnabled } from './siteNotifications';

type ProximitySample = { near: boolean; lastFiredAt: number };
/** Notify on an actual entry into the proximity zone; rearm only after leaving. */
export class ProximityAlertTracker {
  private readonly states = new Map<string, ProximitySample>();
  constructor(snapshot: unknown = {}) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;
    for (const [key, value] of Object.entries(snapshot).slice(-2500)) {
      if (value && typeof value === 'object') {
        const data = value as Record<string, unknown>;
        if (typeof data.near === 'boolean' && Number.isFinite(data.lastFiredAt)) {
          this.states.set(key, { near: data.near, lastFiredAt: Number(data.lastFiredAt) });
        }
      }
    }
  }
  enter(key: string, near: boolean, now: number, cooldownMinutes: number): boolean {
    if (!key || !Number.isFinite(now)) return false;
    const state = this.states.get(key);
    if (!state) {
      this.states.set(key, { near, lastFiredAt: near ? now : 0 });
      return near;
    }
    if (!near) { state.near = false; return false; }
    if (state.near) return false;
    state.near = true;
    if (state.lastFiredAt && now - state.lastFiredAt < cooldownMinutes * 60_000) return false;
    state.lastFiredAt = now;
    return true;
  }
  snapshot(): Record<string, ProximitySample> {
    return Object.fromEntries([...this.states].slice(-2500));
  }
}

export interface QualityTransition {
  kind: 'reached' | 'crossed' | 'improved';
  current: number;
  previous: number | null;
}
type QualitySample = { latest: number; reference: number };
/** Tracks the last observed/announced score so "improved" means a real increase. */
export class QualityScoreTracker {
  private readonly scores = new Map<string, QualitySample>();
  constructor(snapshot: unknown = {}) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;
    for (const [id, value] of Object.entries(snapshot).slice(-2500)) {
      if (!value || typeof value !== 'object') continue;
      const item = value as Record<string, unknown>;
      if (typeof item.latest === 'number' && Number.isFinite(item.latest)
        && typeof item.reference === 'number' && Number.isFinite(item.reference)) {
        this.scores.set(id, { latest: item.latest, reference: item.reference });
      }
    }
  }
  observe(id: string, score: number, threshold: number, improvement: number): QualityTransition | null {
    if (!id || !Number.isFinite(score)) return null;
    const prior = this.scores.get(id);
    if (!prior) {
      this.scores.set(id, { latest: score, reference: score });
      return score >= threshold ? { kind: 'reached', current: score, previous: null } : null;
    }
    const previous = prior.latest;
    prior.latest = score;
    if (previous < threshold && score >= threshold) {
      prior.reference = score;
      return { kind: 'crossed', current: score, previous };
    }
    if (score < threshold) {
      prior.reference = score;
      return null;
    }
    if (score > previous && score - prior.reference >= improvement) {
      const reference = prior.reference;
      prior.reference = score;
      return { kind: 'improved', current: score, previous: reference };
    }
    return null;
  }
  snapshot(): Record<string, QualitySample> {
    return Object.fromEntries([...this.scores].slice(-2500));
  }
}

export interface MarketNotificationSignal {
  id: string;
  kind: SiteNotificationKind;
  title: string;
  description: string;
  timestamp: number;
  symbol?: string;
  exchange?: string;
  marketType?: string;
  timeframe?: string;
  changePct?: number;
}
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const pct = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const formatPrice = (n: number) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 8 });
const OI_PERIOD_MS: Readonly<Record<string, number>> = {
  '5m': 300_000, '15m': 900_000, '1h': 3_600_000,
  '4h': 14_400_000, '1d': 86_400_000,
};
function hasFreshVerifiedOI(coin: ScannedCoin, now: number): boolean {
  const oi = coin.regularIndicators;
  const interval = OI_PERIOD_MS[coin.timeframe];
  if (coin.marketType !== 'futures' || !interval
    || oi?.oiAvailability !== 'available' || !finite(oi.oiChangePct)
    || !finite(oi.oiUpdatedAt)) return false;
  const age = now - oi.oiUpdatedAt;
  // OI is sampled approximately every minute, independently of the chart timeframe.
  // A 15m/1h chart must never make a 10-minute-old OI reading actionable.
  return age >= -60_000 && age <= Math.min(interval * 2 + 90_000, 180_000);
}

const distance = (price: number, level: number) =>
  level > 0 && Number.isFinite(price) && price > 0 ? Math.abs(price / level - 1) * 100 : Infinity;

function favoriteMatches(coin: ScannedCoin, favorites: readonly string[]): boolean {
  return matchesNotificationScope({ ...DUMMY_FAVORITES_SCOPE, onlyFavorites: true },
    coin, favorites);
}
const DUMMY_FAVORITES_SCOPE: SiteNotificationSettings = {
  ...DEFAULT_SITE_NOTIFICATIONS, scopeExchange: 'all', scopeMarket: 'all', scopeTimeframe: 'all',
};

export function surveillanceNotificationKind(event: SurveillanceEvent): SiteNotificationKind {
  // Older worker snapshots contain details.type; newly adapted snapshots use
  // details.notificationType. Both are exchange event codes, not UI labels.
  return classifySurveillanceEventType(event.details?.notificationType ?? event.details?.type);
}

export function marketSurveillanceSignal(
  event: SurveillanceEvent & { coinId: string; symbol: string; exchange: string; marketType: string },
  settings: SiteNotificationSettings,
  favorites: readonly string[] = [],
): MarketNotificationSignal | null {
  const kind = surveillanceNotificationKind(event);
  if (!notificationEnabled(settings, kind)) return null;
  const timeframe = typeof event.details?.timeframe === 'string' ? event.details.timeframe : undefined;
  if (!matchesNotificationScope(settings, { symbol: event.symbol, exchange: event.exchange,
    marketType: event.marketType, timeframe }, favorites)) return null;
  if (!finite(event.timestamp) || !event.id) return null;
  return {
    id: ['surveillance', event.exchange, event.marketType, event.coinId, event.id].join(':'),
    kind, title: event.title || 'Моніторинг · ' + event.symbol,
    description: event.description || 'Подія нагляду',
    symbol: event.symbol, exchange: event.exchange, marketType: event.marketType,
    timeframe, timestamp: event.timestamp,
  };
}

/** No extra market requests: every signal uses only the existing scanner snapshot. */
export function scanNotificationSignals(
  coins: readonly ScannedCoin[],
  settings: SiteNotificationSettings,
  favorites: readonly string[] = [],
  now = Date.now(),
  qualityTracker?: QualityScoreTracker,
  proximityTracker?: ProximityAlertTracker,
  alreadyDelivered?: (id: string) => boolean,
): MarketNotificationSignal[] {
  if (!settings.optedIn || !settings.enabled || !Array.isArray(coins)) return [];
  const result: MarketNotificationSignal[] = [];
  const seen = new Set<string>();
  const count = new Map<SiteNotificationKind, number>();
  const coolMs = settings.cooldownMinutes * 60_000;
  const emit = (source: ScannedCoin, kind: SiteNotificationKind, anchor: string,
    title: string, description: string, once = false) => {
    if (!notificationEnabled(settings, kind)) return;
    const id = [kind, source.exchange, source.marketType, source.timeframe, source.symbol, anchor,
      ...(once ? [] : [Math.floor(now / coolMs)])].join(':');
    // Quota must exclude historical notifications already stored in the center.
    // Otherwise the first three old signals starve every new coin forever.
    if (seen.has(id) || alreadyDelivered?.(id)) return;
    if ((count.get(kind) || 0) >= 3 || result.length >= 25) return;
    seen.add(id);
    count.set(kind, (count.get(kind) || 0) + 1);
    result.push({
      id, kind, title, description, symbol: source.symbol,
      exchange: source.exchange, marketType: source.marketType, timeframe: source.timeframe,
      timestamp: now,
    });
  };
  for (const coin of coins) {
    if (!matchesNotificationScope(settings, coin, favorites)) continue;
    if (!finite(coin.currentPrice) || coin.currentPrice <= 0) continue;
    // Don't create trading signals from a known-stale market snapshot.
    if (finite(coin.lastUpdated) && now - coin.lastUpdated > 5 * 60_000) {
      emit(coin, 'system', 'stale-market', 'Застарілі котирування · ' + coin.symbol,
        'Дані останнього сканування старші за 5 хвилин');
      continue;
    }
    const favorite = favoriteMatches(coin, favorites);
    for (const formation of coin.formations || []) {
      const formId = formation.id || formation.patternKey;
      const score = formation.confidence;
      const v = formation.validation;
      const ctx = formation.roundNumberContext;
      const levelFields: Array<[string, number | undefined]> = [
        ['Вхід', formation.levels?.entryPrice],
        ['Stop Loss', formation.levels?.stopLossPrice],
        ['Take Profit', formation.levels?.targetPrice],
        ['Підтримка', formation.levels?.supportPrice],
        ['Опір', formation.levels?.resistancePrice],
        ['Neckline', formation.levels?.necklinePrice],
      ];
      if (notificationEnabled(settings, 'levels') && (count.get('levels') || 0) < 3 && result.length < 25) {
        for (const [label, level] of levelFields) {
          if (!finite(level)) continue;
          const levelDistance = distance(coin.currentPrice, level);
          const near = levelDistance <= settings.levelDistancePct;
          const levelKey = [coin.exchange, coin.marketType, coin.timeframe, coin.symbol,
            formId, 'level', label, level].join(':');
          if (!proximityTracker ? !near
            : !proximityTracker.enter(levelKey, near, now, settings.cooldownMinutes)) continue;
          emit(coin, 'levels', formId + ':' + label + ':' + level,
            'Наближення до ' + label + ' · ' + coin.symbol,
            formatPrice(coin.currentPrice) + ' · ' + label + ' ' + formatPrice(level)
            + ' · відстань ' + levelDistance.toFixed(2) + '%', !proximityTracker);
        }
      }
      if (v?.closedCandleOnly && v.breakoutConfirmed) {
        emit(coin, 'breakouts', formId + ':breakout', 'Підтверджений пробій · ' + coin.symbol,
          formation.name + ' · закрита свічка · ' + score + '/100', true);
        if (formation.status === 'retest' && v.entryMode === 'RETEST') {
          emit(coin, 'breakouts', formId + ':retest', 'Підтверджений ретест · ' + coin.symbol,
            formation.name + ' · закрита свічка · ' + score + '/100', true);
        }
        if (finite(v.volumeRatio) && v.volumeRatio >= settings.minBreakoutRvol) {
          emit(coin, 'volume', formId, 'Підвищений обсяг · ' + coin.symbol,
            'Обсяг свічки пробою: RVOL ' + v.volumeRatio.toFixed(2) + '×', true);
        }
      }
      // A stored ROUND badge can outlive a move away from its level. Check
      // the actual scan price, not the original badge distance.
      const roundDistance = finite(ctx?.level) ? distance(coin.currentPrice, ctx.level) : Infinity;
      if (ctx?.detected === true && finite(ctx.level) && (count.get('round') || 0) < 3 && result.length < 25) {
        const near = roundDistance <= settings.roundDistancePct;
        const roundKey = [coin.exchange, coin.marketType, coin.timeframe, coin.symbol,
          formId, 'round', ctx.level].join(':');
        if (!proximityTracker ? near
          : proximityTracker.enter(roundKey, near, now, settings.cooldownMinutes)) {
          emit(coin, 'round', formId + ':' + ctx.level, 'ROUND · ' + coin.symbol,
            'Біля круглого рівня ' + formatPrice(ctx.level) +
            ' · відстань ' + roundDistance.toFixed(2) + '%', !proximityTracker);
        }
      }
      if (ctx?.densityConfirmed === true && finite(ctx.densityUsd) && ctx.densityUsd > 0) {
        emit(coin, 'density', formId, 'Підтверджена щільність · ' + coin.symbol,
          (ctx.side || 'BID/ASK') + ' · ' + formatPrice(ctx.densityUsd) + ' · ' + formation.name, true);
      }
      const qualityKey = [coin.exchange, coin.marketType, coin.timeframe, coin.symbol, formId].join(':');
      const qualityHasRoom = notificationEnabled(settings, 'quality')
        && (count.get('quality') || 0) < 3 && result.length < 25;
      const transition = qualityHasRoom
        ? qualityTracker?.observe(qualityKey, score,
          settings.minQualityScore, settings.qualityImprovement)
        : null;
      if (score >= settings.minQualityScore) {
        emit(coin, 'formation', formId, 'Сильна формація · ' + coin.symbol,
          formation.name + ' · ' + score + '/100', true);
        // Without prior samples, report reaching the threshold. In subsequent
        // scans report only a real upward transition, never a downgrade.
        if (qualityHasRoom && (!qualityTracker || transition)) {
          const newScore = transition?.current ?? score;
          const improved = transition?.kind === 'improved';
          emit(coin, 'quality', formId + ':score:' + newScore,
            (improved ? 'Покращилася якість · ' : 'Досягнуто якості · ') + coin.symbol,
            formation.name + ' · ' +
              (improved && transition?.previous != null ? transition.previous + ' → ' : '') +
              newScore + '/100', true);
        }
        if (favorite) {
          emit(coin, 'favorites', formId, 'Формація з обраного · ' + coin.symbol,
            formation.name + ' · ' + score + '/100', true);
        }
      }
      const i = coin.regularIndicators;
      const directional = formation.bias === 'bullish' ? 1 : formation.bias === 'bearish' ? -1 : 0;
      if (score >= settings.minQualityScore && v?.closedCandleOnly && directional) {
        const reasons: string[] = [];
        if (v.breakoutConfirmed) reasons.push('підтверджена структура');
        if (finite(v.volumeRatio) && v.volumeRatio >= settings.minBreakoutRvol) reasons.push('RVOL');
        if (hasFreshVerifiedOI(coin, now)
          && i!.oiChangePct! >= settings.oiThresholdPct) reasons.push('OI');
        if (coin.exchange === 'binance'
          && (finite(i?.deltaPct) && i.deltaPct * directional >= settings.flowThresholdPct
            || finite(i?.cvd20Pct) && i.cvd20Pct * directional >= settings.flowThresholdPct))
          reasons.push('Delta або CVD20');
        // ROUND and liquidity at that same level share one context.
        if (ctx?.densityConfirmed && finite(ctx.densityUsd) && ctx.densityUsd > 0)
          reasons.push('стакан BID/ASK');
        else if (ctx?.detected && roundDistance <= settings.roundDistancePct)
          reasons.push('ROUND');
        if (reasons.length >= settings.minConfirmations) {
          emit(coin, 'composite', formId, 'Комплексне Quant-підтвердження · ' + coin.symbol,
            score + '/100 · ' + reasons.length + ' факторів: ' + reasons.join(', '), true);
        }
      }
    }
    const i = coin.regularIndicators;
    // Diagnostic events are optional and use actual exchange data statuses.
    const oiFault = i?.oiAvailability;
    if (coin.marketType === 'futures'
      && (oiFault === 'stale-history' || oiFault === 'rate-limited'
        || oiFault === 'network-error' || oiFault === 'http-error')) {
      emit(coin, 'system', 'oi:' + oiFault, 'Дані OI недоступні · ' + coin.symbol,
        'Причина: ' + oiFault + ' · перевірка потоку даних потрібна');
    }
    // These are exchange-data anomalies, not inferred position directions.
    if (hasFreshVerifiedOI(coin, now)
        && Math.abs(i!.oiChangePct!) >= settings.oiThresholdPct) {
      emit(coin, 'openInterest', 'oi', 'Аномалія OI · ' + coin.symbol,
        'Open Interest ' + pct(i.oiChangePct) + ' за ' + coin.timeframe);
    }
    if (coin.exchange === 'binance' && finite(i?.deltaPct)
        && Math.abs(i.deltaPct) >= settings.flowThresholdPct) {
      emit(coin, 'flow', 'delta', 'Delta · ' + coin.symbol,
        'Delta агресивних угод ' + pct(i.deltaPct) + ' за ' + coin.timeframe);
    } else if (coin.exchange === 'binance' && finite(i?.cvd20Pct)
        && Math.abs(i.cvd20Pct) >= settings.flowThresholdPct) {
      emit(coin, 'flow', 'cvd20', 'CVD20 · ' + coin.symbol,
        'CVD20 ' + pct(i.cvd20Pct) + ' за 20 закритих свічок');
    }
    for (const candidate of coin.earlyFormations || []) {
      if (!candidate.id || !finite(candidate.observedAt)) continue;
      emit(coin, 'early', candidate.id, 'Раннє виявлення W/M · ' + coin.symbol,
        'Можлива формація: ' + candidate.name + ' · ' + candidate.stage
        + ' · очікує підтвердження', true);
    }
  }
  return result;
}

export interface LiquidationNotificationRow {
  id: string; side: 'LONG' | 'SHORT'; usd: number; t: number;
}
export function liquidationNotificationSignal(
  row: LiquidationNotificationRow,
  settings: SiteNotificationSettings,
  source: { symbol: string; exchange: string; marketType: string },
): MarketNotificationSignal | null {
  if (!notificationEnabled(settings, 'liquidations')
    || !finite(row.usd) || row.usd < settings.liquidationMinUsd
    || !finite(row.t) || !row.id || !['LONG','SHORT'].includes(row.side)) return null;
  return {
    id: ['liquidations', source.exchange, source.marketType, source.symbol, row.id].join(':'),
    kind: 'liquidations', symbol: source.symbol,
    exchange: source.exchange, marketType: source.marketType,
    timestamp: row.t,
    title: 'Ліквідація ' + row.side + ' · ' + source.symbol,
    description: 'Обсяг ' + formatPrice(row.usd) + ' · ' + source.exchange.toUpperCase(),
  };
}

/** Side-specific, de-duplicated 5-minute liquidation cascade; live trades only. */
export class LiquidationCascadeTracker {
  private rows = new Map<string, LiquidationNotificationRow>();
  private lastBySide = new Map<string, number>();
  push(row: LiquidationNotificationRow, minUsd: number, now = Date.now()):
    { side: 'LONG' | 'SHORT'; usd: number; count: number } | null {
    if (!row || !row.id || !['LONG','SHORT'].includes(row.side)
      || !finite(row.usd) || row.usd <= 0 || !finite(row.t)) return null;
    const cutoff = now - 5 * 60_000;
    for (const [id, previous] of this.rows) if (previous.t < cutoff) this.rows.delete(id);
    if (row.t < cutoff || row.t > now + 10_000) return null;
    const previous = this.rows.get(row.id);
    if (previous && (previous.side !== row.side || row.usd <= previous.usd)) return null;
    this.rows.set(row.id, row);
    if (this.rows.size > 1000) this.rows.delete(this.rows.keys().next().value!);
    const selected = [...this.rows.values()].filter(item => item.side === row.side);
    const total = selected.reduce((sum, item) => sum + item.usd, 0);
    const threshold = Math.max(1000, minUsd);
    if (selected.length < 3 || total < threshold * 3) return null;
    const last = this.lastBySide.get(row.side) || 0;
    if (last && now - last < 5 * 60_000) return null;
    this.lastBySide.set(row.side, now);
    return { side: row.side, usd: Math.round(total), count: selected.length };
  }
}
