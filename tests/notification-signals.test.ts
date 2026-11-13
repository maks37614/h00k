import test from 'node:test';
import assert from 'node:assert/strict';
import type { ScannedCoin, SurveillanceEvent } from '../src/types';
import { DEFAULT_SITE_NOTIFICATIONS, normalizeSiteNotificationSettings, notificationEnabled,
  NOTIFICATION_CATEGORIES, matchesNotificationScope } from '../src/utils/siteNotifications';
import { scanNotificationSignals, marketSurveillanceSignal, liquidationNotificationSignal,
  surveillanceNotificationKind } from '../src/utils/notificationSignals';

const settings = normalizeSiteNotificationSettings({
  optedIn: true, enabled: true, formations: true, levels: true, breakouts: true,
  round: true, density: true, openInterest: true, flow: true, volume: true,
  early: true, quality: true, composite: true, favorites: true, system: true,
  surveillance: true, liquidations: true, impulses: true,
  levelDistancePct: 1, roundDistancePct: 1, oiThresholdPct: 2,
  flowThresholdPct: 4, minBreakoutRvol: 2, minConfirmations: 3,
  minQualityScore: 88, cooldownMinutes: 15,
});
const coin = (): ScannedCoin => ({
  symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT',
  exchange: 'binance', marketType: 'futures', timeframe: '15m',
  currentPrice: 100, priceChange24h: 1.3, highPrice24h: 108,
  lowPrice24h: 90, volume24hUsd: 2_000_000, lastUpdated: 10_000,
  exchangeUrl: '',
  regularIndicators: { atrPct: 1, rsi14: 60, oiChangePct: 4.1, deltaPct: 7, cvd20Pct: 5 },
  formations: [{
    id: 'f1', patternKey: 'test', name: 'Пробій опору', confidence: 92, bias: 'bullish',
    levels: { entryPrice: 100.3, stopLossPrice: 96, targetPrice: 108, supportPrice: 99.5 },
    roundNumberContext: { detected: true, level: 100, step: 10, distancePct: .1,
      strength: 87, densityConfirmed: true, densityUsd: 250_000, side: 'BID' },
    validation: { closedCandleOnly: true, breakoutConfirmed: true, volumeRatio: 3.5 },
  }],
  earlyFormations: [{ id: 'early1', name: 'Можлива W', stage: 'forming', observedAt: 200_000 }],
} as unknown as ScannedCoin);

test('no site notification can fire until master switch and explicit user opt-in', () => {
  assert.equal(DEFAULT_SITE_NOTIFICATIONS.enabled, false);
  assert.equal(DEFAULT_SITE_NOTIFICATIONS.optedIn, false);
  assert.deepEqual(scanNotificationSignals([coin()], DEFAULT_SITE_NOTIFICATIONS, ['binance:futures:BTCUSDT']), []);
  const legacy = normalizeSiteNotificationSettings({ enabled: true, formations: true, system: true });
  assert.equal(legacy.enabled, false);
  assert.equal(notificationEnabled(legacy, 'system'), false);
  assert.deepEqual(scanNotificationSignals([coin()], legacy), []);
  assert.equal(NOTIFICATION_CATEGORIES.length, 17);
  assert.equal(NOTIFICATION_CATEGORIES.filter(c => c.group === 'Стакан та потік').length, 6);
});

test('real scanner evidence creates categorized events with bounded IDs and no fabricated metrics', () => {
  const events = scanNotificationSignals([coin()], settings, ['binance:futures:BTCUSDT'], 900_000);
  const kinds = new Set(events.map(e => e.kind));
  for (const kind of ['formation','levels','breakouts','round','density','openInterest',
    'flow','volume','early','quality','composite','favorites']) assert.ok(kinds.has(kind as any), kind);
  assert.ok(events.find(e => e.kind === 'composite')?.description.includes('факторів'));
  assert.ok(events.find(e => e.kind === 'density')?.description.includes('250,000'));
  assert.ok(events.every(e => e.symbol === 'BTCUSDT' && e.exchange === 'binance'));
  const repeated = scanNotificationSignals([coin()], settings, ['binance:futures:BTCUSDT'], 900_000);
  assert.deepEqual(events, repeated, 'stable event identifiers allow center deduplication');
  const withoutRealData = coin();
  withoutRealData.regularIndicators = { atrPct: null, rsi14: null };
  withoutRealData.formations[0].roundNumberContext!.densityConfirmed = false;
  delete withoutRealData.formations[0].roundNumberContext!.densityUsd;
  withoutRealData.formations[0].validation!.volumeRatio = 1;
  const reduced = scanNotificationSignals([withoutRealData], settings, [], 900_000);
  assert.ok(!reduced.some(e => ['openInterest','flow','density','volume','favorites'].includes(e.kind)));
});

test('global exchange, market, timeframe, symbol and favorites scope filters events', () => {
  for (const patch of [
    { scopeExchange: 'bybit' }, { scopeMarket: 'spot' }, { scopeTimeframe: '4h' },
    { scopeSymbols: 'ETHUSDT' }, { onlyFavorites: true },
  ] as const) {
    const scoped = normalizeSiteNotificationSettings({ ...settings, ...patch });
    assert.deepEqual(scanNotificationSignals([coin()], scoped), [], JSON.stringify(patch));
  }
  const favoriteSetting = normalizeSiteNotificationSettings({ ...settings, onlyFavorites: true });
  assert.ok(scanNotificationSignals([coin()], favoriteSetting, ['binance:futures:BTCUSDT']).length > 0);
  assert.equal(matchesNotificationScope(favoriteSetting, coin(), ['bybit:spot:BTCUSDT']), false);
});

test('surveillance event classification is grounded in server notificationType', () => {
  const row = { id: 'ev1', type: 'level', title: 'Пробій 4H', description: 'Закрита свічка',
    price: 100, timestamp: 500_000, severity: 'warning',
    coinId: 'c1', symbol: 'BTCUSDT', exchange: 'binance', marketType: 'futures',
    details: { timeframe: '15m', notificationType: 'LEVEL_CROSS_15M' },
  } as const;
  assert.equal(surveillanceNotificationKind(row as unknown as SurveillanceEvent), 'breakouts');
  assert.equal(marketSurveillanceSignal(row as any, settings)?.kind, 'breakouts');
  assert.equal(marketSurveillanceSignal(row as any,
    normalizeSiteNotificationSettings({ ...settings, breakouts: false })), null);
  assert.equal(surveillanceNotificationKind({ details: { notificationType: 'OI_ANOMALY' } } as any), 'openInterest');
  assert.equal(surveillanceNotificationKind({ details: { notificationType: 'DENSITY_APPEARED' } } as any), 'density');
  assert.equal(surveillanceNotificationKind({ details: { notificationType: 'CHANNEL_BREAKOUT' } } as any), 'breakouts');
});

test('liquidation rules reject historical junk, tiny positions and unauthorized defaults', () => {
  const source = { symbol: 'BTCUSDT', exchange: 'binance', marketType: 'futures' };
  const row = { id: 'liq1', side: 'LONG' as const, usd: 200_000, t: 100_000 };
  assert.equal(liquidationNotificationSignal(row, DEFAULT_SITE_NOTIFICATIONS, source), null);
  assert.equal(liquidationNotificationSignal({ ...row, usd: 500 }, settings, source), null);
  assert.equal(liquidationNotificationSignal(row, settings, source)?.kind, 'liquidations');
});
