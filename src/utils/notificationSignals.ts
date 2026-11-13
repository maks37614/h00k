import type { ScannedCoin, SurveillanceEvent, DetectedFormation } from '../types';
import type { SiteNotificationKind, SiteNotificationSettings } from './siteNotifications';
import { matchesNotificationScope, notificationEnabled } from './siteNotifications';

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
const distance = (price: number, level: number) =>
  level > 0 && Number.isFinite(price) && price > 0 ? Math.abs(price / level - 1) * 100 : Infinity;

function favoriteMatches(coin: ScannedCoin, favorites: readonly string[]): boolean {
  return favorites.some(raw => {
    const key = raw.toUpperCase().replace(/\s+/g, '');
    return key.includes(coin.symbol.toUpperCase())
      && (!key.includes(':') || (key.includes(coin.exchange.toUpperCase())
        && key.includes(coin.marketType.toUpperCase())));
  });
}

export function surveillanceNotificationKind(event: SurveillanceEvent): SiteNotificationKind {
  const id = String(event.details?.notificationType || '').toUpperCase();
  if (id.startsWith('DENSITY') || id.includes('ORDERBOOK')) return 'density';
  if (id.startsWith('OI_')) return 'openInterest';
  if (id.startsWith('LEVEL') || id.includes('BREAKOUT') || id === 'STRUCTURE_SHIFT'
    || id === 'BOS' || id === 'CHOCH' || id.includes('RETEST')) return 'breakouts';
  if (id.startsWith('FIBONACCI') || id.startsWith('THIRD_TOUCH')) return 'levels';
  if (id === 'MOMENTUM' || id === 'IMPULSE') return 'impulse';
  if (id.startsWith('FORMATION') || id.includes('SETUP')) return 'formation';
  return 'surveillance';
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
): MarketNotificationSignal[] {
  if (!settings.optedIn || !settings.enabled || !Array.isArray(coins)) return [];
  const result: MarketNotificationSignal[] = [];
  const seen = new Set<string>();
  const count = new Map<SiteNotificationKind, number>();
  const coolMs = settings.cooldownMinutes * 60_000;
  const emit = (source: ScannedCoin, kind: SiteNotificationKind, anchor: string,
    title: string, description: string, once = false) => {
    if (!notificationEnabled(settings, kind)) return;
    if ((count.get(kind) || 0) >= 3 || result.length >= 25) return;
    const id = [kind, source.exchange, source.marketType, source.timeframe, source.symbol, anchor,
      ...(once ? [] : [Math.floor(now / coolMs)])].join(':');
    if (seen.has(id)) return;
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
      if (notificationEnabled(settings, 'levels')) {
        for (const [label, level] of levelFields) {
          if (!finite(level) || distance(coin.currentPrice, level) > settings.levelDistancePct) continue;
          emit(coin, 'levels', formId + ':' + label, 'Наближення до ' + label + ' · ' + coin.symbol,
            formatPrice(coin.currentPrice) + ' · ' + label + ' ' + formatPrice(level)
            + ' · відстань ' + distance(coin.currentPrice, level).toFixed(2) + '%', true);
        }
      }
      if (v?.closedCandleOnly && v.breakoutConfirmed) {
        emit(coin, 'breakouts', formId, 'Підтверджений пробій · ' + coin.symbol,
          formation.name + ' · закрита свічка · ' + score + '/100', true);
        if (finite(v.volumeRatio) && v.volumeRatio >= settings.minBreakoutRvol) {
          emit(coin, 'volume', formId, 'Підвищений обсяг · ' + coin.symbol,
            'Обсяг свічки пробою: RVOL ' + v.volumeRatio.toFixed(2) + '×', true);
        }
      }
      if (ctx?.detected === true && finite(ctx.distancePct) && ctx.distancePct <= settings.roundDistancePct) {
        emit(coin, 'round', formId, 'ROUND · ' + coin.symbol,
          'Біля круглого рівня ' + (finite(ctx.level) ? formatPrice(ctx.level) : '')
          + ' · відстань ' + ctx.distancePct.toFixed(2) + '%', true);
      }
      if (ctx?.densityConfirmed === true && finite(ctx.densityUsd) && ctx.densityUsd > 0) {
        emit(coin, 'density', formId, 'Підтверджена щільність · ' + coin.symbol,
          (ctx.side || 'BID/ASK') + ' · ' + formatPrice(ctx.densityUsd) + ' · ' + formation.name, true);
      }
      if (score >= settings.minQualityScore) {
        emit(coin, 'formation', formId, 'Сильна формація · ' + coin.symbol,
          formation.name + ' · ' + score + '/100', true);
        const scoreBand = Math.floor(score / Math.max(1, settings.qualityImprovement));
        emit(coin, 'quality', formId + ':band' + scoreBand, 'Якість сигналу · ' + coin.symbol,
          formation.name + ' · оцінка ' + score + '/100', true);
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
        if (coin.marketType === 'futures' && finite(i?.oiChangePct)
          && i.oiChangePct >= settings.oiThresholdPct) reasons.push('OI');
        if (coin.exchange === 'binance' && finite(i?.deltaPct)
          && i.deltaPct * directional >= settings.flowThresholdPct) reasons.push('Delta/CVD');
        if (ctx?.detected && ctx.distancePct <= settings.roundDistancePct) reasons.push('ROUND');
        if (ctx?.densityConfirmed && finite(ctx.densityUsd) && ctx.densityUsd > 0) reasons.push('стакан BID/ASK');
        if (reasons.length >= settings.minConfirmations) {
          emit(coin, 'composite', formId, 'Комплексне Quant-підтвердження · ' + coin.symbol,
            score + '/100 · ' + reasons.length + ' факторів: ' + reasons.join(', '), true);
        }
      }
    }
    const i = coin.regularIndicators;
    // These are exchange-data anomalies, not inferred position directions.
    if (coin.marketType === 'futures' && finite(i?.oiChangePct)
        && Math.abs(i.oiChangePct) >= settings.oiThresholdPct) {
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
