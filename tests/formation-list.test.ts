import assert from 'node:assert/strict';
import test from 'node:test';
import { getVisibleFormations, groupVisibleFormations } from '../src/utils/formationList';
import type { DetectedFormation, ScannedCoin, ScreenerFilterState } from '../src/types';

const filters: ScreenerFilterState = {
  exchange: 'binance', marketType: 'futures', timeframe: '5m',
  category: 'all', bias: 'all', status: 'all', minVolumeUsd: 0,
  densityConfirmedOnly: false, searchQuery: '', sortBy: 'confidence', sortOrder: 'desc'
};

function pattern(id: string, options: Partial<DetectedFormation> = {}): DetectedFormation {
  return {
    id, patternKey: id, name: id, nameEn: id, category: 'reversal', bias: 'bullish',
    confidence: 75, status: 'forming', statusLabel: 'Формується', description: id,
    levels: { entryPrice: 10, targetPrice: 11, stopLossPrice: 9 },
    potentialProfitPct: 10, potentialRiskPct: 10, riskRewardRatio: 1,
    detectedAt: 1000, ...options,
  };
}

function coin(symbol: string, formations: DetectedFormation[], exchange: 'binance' | 'bybit' = 'binance'): ScannedCoin {
  return {
    symbol, baseAsset: symbol.replace('USDT', ''), quoteAsset: 'USDT', exchange, marketType: 'futures',
    currentPrice: 10, priceChange24h: 1, highPrice24h: 12, lowPrice24h: 8, volume24hUsd: 100_000,
    formations, timeframe: '5m', lastUpdated: 1000, exchangeUrl: '',
  };
}

test('grouping shows one coin per exchange/market/timeframe but preserves distinct patterns', () => {
  const a = pattern('triangle', { confidence: 90 });
  const b = pattern('double-bottom', { confidence: 70 });
  const input = [coin('ZROUSDT', [a, b, a]), coin('ZROUSDT', [pattern('bybit-w')], 'bybit')];
  const groups = groupVisibleFormations(getVisibleFormations(input, { ...filters, exchange: 'all' }));
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.find(g => g.coin.exchange === 'binance')?.formations.map(f => f.id), ['triangle', 'double-bottom']);
});

test('density-only filter rejects proximity to a round number without order-book proof', () => {
  const round = pattern('round', { roundNumberContext: { detected: true, distancePct: 0.1, step: 1, strength: 1, densityConfirmed: false } });
  const real = pattern('density', { roundNumberContext: { detected: true, distancePct: 0.1, step: 1, strength: 1, densityConfirmed: true, densityUsd: 100_000 } });
  const results = getVisibleFormations([coin('ZROUSDT', [round, real, pattern('missing')])], { ...filters, densityConfirmedOnly: true });
  assert.deepEqual(results.map(i => i.formation.id), ['density']);
});

test('status, direction and category filters apply independently to each pattern', () => {
  const long = pattern('long');
  const short = pattern('short', { category: 'breakout', status: 'breakout', bias: 'bearish' });
  const results = getVisibleFormations([coin('ZROUSDT', [long, short])], {
    ...filters, bias: 'bearish', category: 'breakout', status: 'breakout'
  });
  assert.deepEqual(groupVisibleFormations(results)[0].formations.map(f => f.id), ['short']);
});

test('profit sorting uses target percentage, not R:R, and respects ascending order', () => {
  const highRr = pattern('high-rr', { potentialProfitPct: 2, riskRewardRatio: 8 });
  const highProfit = pattern('high-profit', { potentialProfitPct: 12, riskRewardRatio: 1.5 });
  const coins = [coin('ZROUSDT', [highRr, highProfit])];
  assert.deepEqual(getVisibleFormations(coins, { ...filters, sortBy: 'profitPotential' }).map(i => i.formation.id), ['high-profit', 'high-rr']);
  assert.deepEqual(getVisibleFormations(coins, { ...filters, sortBy: 'profitPotential', sortOrder: 'asc' }).map(i => i.formation.id), ['high-rr', 'high-profit']);
});

test('search and volume filters do not reintroduce hidden patterns', () => {
  const coins = [coin('ZROUSDT', [pattern('long')]), coin('QNTUSDT', [pattern('other')])];
  assert.deepEqual(groupVisibleFormations(getVisibleFormations(coins, { ...filters, searchQuery: 'zro' })).map(g => g.coin.symbol), ['ZROUSDT']);
  assert.equal(getVisibleFormations(coins, { ...filters, minVolumeUsd: 500_000 }).length, 0);
});
