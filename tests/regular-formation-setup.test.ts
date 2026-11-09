import test from 'node:test';
import assert from 'node:assert/strict';
import type { DetectedFormation, Kline } from '../src/types';
import { formatCryptoPrice } from '../src/utils/formatters';
import { validateFormation } from '../src/utils/formationValidation';
import { refineRegularFormationSet, refineRegularFormationSetup } from '../src/utils/regularFormationSetup';
import { reassessRegularFormationQuality } from '../src/utils/regularFormationQuality';
import { identifyRegularRoundNumberDensity } from '../server/regularOrderbookDensity';

function bars(): Kline[] {
  return Array.from({ length: 65 }, (_, i) => {
    const close = 100 + Math.sin(i / 3.2) * .6 + Math.cos(i / 8) * .2;
    return {
      time: 1700000000 + i * 300,
      open: close, high: close + .35, low: close - .35, close,
      volume: 100,
    };
  });
}
function pattern(bias: 'bullish' | 'bearish', entry: number, stop: number, target: number): DetectedFormation {
  return {
    id: 'regular-flag-1',
    patternKey: bias === 'bullish' ? 'bull_flag' : 'bear_flag',
    name: bias === 'bullish' ? 'Бичачий прапор' : 'Ведмежий прапор',
    nameEn: bias === 'bullish' ? 'Bull Flag' : 'Bear Flag',
    category: 'continuation', bias, confidence: 65,
    status: 'forming', statusLabel: 'Очікування пробою',
    description: `Виміряна ціль $ ${formatCryptoPrice(target)}; raw $${formatCryptoPrice(target)}.`,
    levels: {
      entryPrice: entry, stopLossPrice: stop, targetPrice: target,
      supportPrice: 99.7, resistancePrice: 100.3,
    },
    riskRewardRatio: Math.abs(target - entry) / Math.abs(entry - stop),
    potentialProfitPct: Math.abs(target - entry) / entry * 100,
    potentialRiskPct: Math.abs(entry - stop) / entry * 100,
    detectedAt: 1700000000, candleStartIndex: 40,
    candleEndIndex: 64, structureEndIndex: 55,
  };
}

test('standard bearish flag caps oversized take-profit without moving it farther away', () => {
  const source = pattern('bearish', 100, 103, 85);
  const result = refineRegularFormationSet(bars(), [source])[0];
  assert.ok(result.levels.targetPrice < 100 && result.levels.targetPrice > 85);
  assert.ok((100 - result.levels.targetPrice) < 3);
  assert.equal(result.validation?.targetPrice, result.levels.targetPrice);
  assert.equal(result.validation?.stopPrice, result.levels.stopLossPrice);
  assert.equal(result.validation?.riskReward, result.riskRewardRatio);
  assert.ok(result.riskRewardRatio < source.riskRewardRatio);
  assert.ok(result.validation?.confluence);
  assert.equal(result.confidence, Math.round(result.validation.confluence.total));
  assert.ok((result.regularSetupAdjustment?.reasons.length ?? 0) >= 1);
  assert.ok(result.description.includes('$' + formatCryptoPrice(result.levels.targetPrice)));
  assert.ok(!result.description.includes('$' + formatCryptoPrice(source.levels.targetPrice)));
  assert.ok(!result.validation?.passed, 'low realistic R:R must not become a confirmed setup');
});

test('standard bullish targets are capped conservatively and stop stays behind structure', () => {
  const source = pattern('bullish', 100, 97, 115);
  const result = refineRegularFormationSet(bars(), [source])[0];
  assert.ok(result.levels.targetPrice > 100 && result.levels.targetPrice < 115);
  assert.ok(result.levels.stopLossPrice <= 97);
  assert.ok(result.potentialProfitPct < 15);
  assert.ok(result.validation?.confluence?.components.riskReward.score !== undefined);
});

test('exchange price ticks round entry against trader and TP inward', () => {
  for (const bias of ['bullish', 'bearish'] as const) {
    const source = bias === 'bullish'
      ? pattern(bias, 100.03, 99, 110)
      : pattern(bias, 100.07, 101.2, 90);
    const refined = refineRegularFormationSetup(bars(), source, .1);
    assert.ok(refined.levels.entryPrice > 0);
    assert.ok(Math.abs(refined.levels.entryPrice / .1 - Math.round(refined.levels.entryPrice / .1)) < 1e-8);
    assert.ok(Math.abs(refined.levels.targetPrice / .1 - Math.round(refined.levels.targetPrice / .1)) < 1e-8);
    assert.ok(Math.abs(refined.levels.stopLossPrice / .1 - Math.round(refined.levels.stopLossPrice / .1)) < 1e-8);
    if (bias === 'bullish') {
      assert.ok(refined.levels.entryPrice >= source.levels.entryPrice);
      assert.ok(refined.levels.targetPrice <= source.levels.targetPrice);
      assert.ok(refined.levels.stopLossPrice <= source.levels.stopLossPrice);
    } else {
      assert.ok(refined.levels.entryPrice <= source.levels.entryPrice);
      assert.ok(refined.levels.targetPrice >= source.levels.targetPrice);
      assert.ok(refined.levels.stopLossPrice >= source.levels.stopLossPrice);
    }
  }
});

test('confluence volume uses actual breakout candle, not a high-volume last candle', () => {
  const candles = bars().map((bar, i) => {
    const close = i < 55 ? 101.2 : 99.4;
    return { ...bar, open: close, close, high: close + .35, low: close - .35,
      volume: i === 64 ? 2000 : 100 };
  });
  const raw = pattern('bearish', 100.5, 103, 96);
  raw.levels.supportPrice = 100.5;
  raw.structureEndIndex = 52;
  const v = validateFormation(candles, raw);
  assert.equal(v.validation?.breakoutConfirmed, true);
  assert.ok(v.validation && v.validation.volumeRatio > 10,
    'legacy validator incorrectly used latest 2000-volume candle');
  const improved = reassessRegularFormationQuality(candles, v);
  assert.ok(improved.validation);
  assert.ok(improved.validation.volumeRatio <= 1.1);
  assert.ok(improved.validation.confluence!.components.volume.score <= 3);
  assert.equal(improved.validation.filters.volume, false);
  assert.equal(improved.validation.passed, false);
});

test('retest checks the same support line that the bearish breakout used', () => {
  const candles = bars().map((bar, i) => {
    const close = i <= 54 ? 101.2 : i === 55 ? 99.3 : 99.6;
    return { ...bar, open: close, close, high: i === 57 ? 100.48 : close + .25,
      low: close - .25, volume: 200 };
  });
  const source = pattern('bearish', 99.5, 103, 94);
  source.levels.supportPrice = 100.5;
  source.structureEndIndex = 52;
  const before = validateFormation(candles, source);
  assert.equal(before.validation?.breakoutConfirmed, true);
  const after = reassessRegularFormationQuality(candles, before);
  assert.equal(after.validation?.confluence?.components.retest.score, 10);
});

function orderbook() {
  return {
    bids: Array.from({ length: 20 }, (_, i): [number, number] =>
      i === 0 ? [100, 300] : [100 - i * .01, 10]),
    asks: Array.from({ length: 20 }, (_, i): [number, number] =>
      i === 0 ? [100, 300] : [100 + i * .01, 10]),
  };
}

test('round number density respects order side, notional and actual location', () => {
  const book = orderbook();
  const long = identifyRegularRoundNumberDensity(book, 100, 100, 'bullish');
  const short = identifyRegularRoundNumberDensity(book, 100, 100, 'bearish');
  assert.equal(long?.side, 'BID');
  assert.equal(short?.side, 'ASK');
  assert.ok((long?.notionalUsd ?? 0) >= 5000);
  assert.equal(identifyRegularRoundNumberDensity(book, 100, 99, 'bullish'), undefined);
  assert.equal(identifyRegularRoundNumberDensity(book, 100, 101, 'bearish'), undefined);
  assert.equal(identifyRegularRoundNumberDensity(book, 100, 100, 'neutral'), undefined);
  assert.equal(identifyRegularRoundNumberDensity({ bids: [], asks: book.asks }, 100, 100, 'bullish'), undefined);
  const low = orderbook();
  low.bids[0] = [100, 30]; // $3k is too weak even if >6x median
  assert.equal(identifyRegularRoundNumberDensity(low, 100, 100, 'bullish'), undefined);
});

test('a breakout entry far behind the current price is not treated as an executable signal', () => {
  const candles = bars().map((bar, i) => {
    const close = i <= 54 ? 101.2 : i === 55 ? 99.3 : 95;
    return { ...bar, open: close, close, high: close + .2,
      low: close - .2, volume: i === 55 ? 350 : 100 };
  });
  const source = pattern('bearish', 100.5, 103, 90);
  source.levels.supportPrice = 100.5;
  source.structureEndIndex = 52;
  const validated = validateFormation(candles, source);
  assert.equal(validated.validation?.breakoutConfirmed, true);
  const assessed = reassessRegularFormationQuality(candles, validated);
  assert.equal(assessed.validation?.passed, false);
  assert.ok(assessed.validation?.rejectionReasons.some(reason => reason.includes('1.5 ATR')));
  assert.match(assessed.statusLabel, /очікуйте ретест/u);
});
