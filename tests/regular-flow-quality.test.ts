import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConfluenceComponent, DetectedFormation, Kline, RegularIndicatorValues, ScannedCoin } from '../src/types';
import { hydrateMissingRegularOIFromBrowser } from '../src/utils/directExchangeClient';
import {
  REGULAR_BASE_QUALITY_WEIGHTS, REGULAR_FLOW_QUALITY_WEIGHTS,
  REGULAR_TECHNICAL_QUALITY_WEIGHTS,
  scoreRegularFlowQuality,
} from '../src/utils/regularFlowQuality';

const baseWeights = {
  formation: 15, extremeLocation: 10, trigger: 20, retest: 10,
  volume: 10, volatility: 5, level: 10, riskReward: 10, dataQuality: 10,
};
const row = (max: number): ConfluenceComponent => ({
  score: max * .7, max, status: 'PARTIAL', evidence: 'Original rubric',
});

function formation(
  bias: 'bullish' | 'bearish' = 'bullish', passed = true,
): DetectedFormation {
  return {
    id: 'reg-1', patternKey: 'bull_flag', name: 'Flag',
    nameEn: 'Flag', category: 'continuation', bias,
    confidence: 70, status: 'breakout', statusLabel: 'Пробій · ПІДТВЕРДЖЕНО',
    description: 'Geometry and risk are evaluated independently of order flow.',
    levels: { entryPrice: 100, targetPrice: bias === 'bullish' ? 104 : 96,
      stopLossPrice: bias === 'bullish' ? 98 : 102 },
    riskRewardRatio: 2, potentialProfitPct: 4, potentialRiskPct: 2, detectedAt: 1,
    validation: {
      passed, confirmed: passed, closedCandleOnly: true, lookAheadSafe: true,
      enoughData: true, finiteData: true, swingQuality: 70,
      equalExtremaTolerancePct: .5, atrPct: 1, breakoutConfirmed: true,
      entryMode: 'BREAKOUT', entryPrice: 100, stopPrice: 98, targetPrice: 104,
      riskReward: 2, minRiskReward: 2, volumeRatio: 2, volatilityPct: 1,
      nearbyLevelDistancePct: .1,
      filters: { volume: true, volatility: true, nearbyLevel: true, structure: true },
      rejectionReasons: [],
      confluence: {
        total: 70, grade: 'C',
        components: Object.fromEntries(
          Object.entries(baseWeights).map(([key,max]) => [key,row(max)]),
        ) as any,
        independentConfirmations: 6, conflicts: [], missing: [], notes: [],
      },
    },
  };
}

const bars = (direction: 1|-1): Kline[] => Array.from({ length: 50 }, (_, i) => {
  const close = 100 + direction * i * .01;
  return {
    time: 1_700_000_000 + i * 300, open: close,
    high: close+.1, low: close-.1, close, volume: 100,
  };
});
const indicator = (
  changes: Partial<RegularIndicatorValues> = {},
): RegularIndicatorValues => ({
  atrPct: 1, rsi14: 54, oiChangePct: 1.5, deltaPct: 26,
  cvd20Pct: 12, ...changes,
});

test('standard geometry 72 + order flow 13 + round/density/RSI/ATR/RVOL 15 equals 100', () => {
  assert.equal(Object.values(REGULAR_BASE_QUALITY_WEIGHTS).reduce((a,b)=>a+b, 0), 72);
  assert.deepEqual(REGULAR_FLOW_QUALITY_WEIGHTS, { openInterest: 5, delta: 5, cvd20: 3 });
  assert.deepEqual(REGULAR_TECHNICAL_QUALITY_WEIGHTS,
    { roundNumber: 4, density: 5, rsi: 3, atr: 2, rvol: 1 });
  assert.equal([
    ...Object.values(REGULAR_BASE_QUALITY_WEIGHTS),
    ...Object.values(REGULAR_FLOW_QUALITY_WEIGHTS),
    ...Object.values(REGULAR_TECHNICAL_QUALITY_WEIGHTS),
  ].reduce((a,b) => a + b, 0), 100);
});

test('verified Binance futures OI, positive delta and CVD raise weighted /100 score', () => {
  const src = formation();
  const scored = scoreRegularFlowQuality(src, indicator(), 'binance', 'futures', bars(1));
  const con = scored.validation!.confluence!;
  assert.equal(con.availableMax, 91);
  assert.equal(con.components.openInterest?.score, 5);
  assert.equal(con.components.delta?.score, 5);
  assert.equal(con.components.cvd20?.score, 3);
  assert.equal(con.flow?.supportive, 3);
  assert.equal(con.flow?.independentSupport, 2, 'delta and CVD share one independent confirmation');
  assert.equal(con.independentConfirmations, 8);
  assert.equal(con.flow?.entryConfirmedWithFlow, true);
  assert.equal(scored.validation!.passed, true);
  assert.ok(con.total > src.validation!.confluence!.total);
  assert.ok(con.total <= 100);
  assert.equal(scored.confidence, Math.round(con.total));
  assert.equal(con.rawTotal, 67.4);
  assert.equal(con.total, 74.1);
  assert.deepEqual(scored.levels, src.levels, 'flow does not change Entry/TP/SL');
  assert.equal(scoreRegularFlowQuality(scored, indicator(), 'binance', 'futures', bars(1)), scored,
    'scoring twice must not compound the weights');
});

test('unavailable indicators never count as measured failures or punish Bybit or spot', () => {
  const src = formation();
  const noData = scoreRegularFlowQuality(src, undefined, 'bybit', 'futures', bars(1));
  const con = noData.validation!.confluence!;
  assert.equal(con.availableMax, 73);
  assert.equal(con.flow?.status, 'unavailable');
  assert.equal(con.flow?.available, 0);
  assert.equal(con.components.openInterest?.available, false);
  assert.equal(con.components.delta?.available, false);
  assert.equal(con.components.cvd20?.available, false);
  assert.ok(Math.abs(con.total - 70) < 1, 'original score is retained when all flow data are absent');
  assert.equal(noData.validation!.passed, src.validation!.passed);

  const bybit = scoreRegularFlowQuality(src, indicator(), 'bybit', 'futures', bars(1));
  assert.equal(bybit.validation!.confluence?.availableMax, 83);
  assert.equal(bybit.validation!.confluence?.components.delta?.available, false);
  assert.equal(bybit.validation!.confluence?.components.cvd20?.available, false);
  assert.equal(bybit.validation!.confluence?.components.openInterest?.score, 5);

  const spot = scoreRegularFlowQuality(src, indicator(), 'binance', 'spot', bars(1));
  assert.equal(spot.validation!.confluence?.availableMax, 86);
  assert.equal(spot.validation!.confluence?.components.openInterest?.available, false);
  assert.equal(spot.validation!.confluence?.components.delta?.score, 5);
  assert.equal(spot.validation!.confluence?.components.cvd20?.score, 3);
});

test('OI rising with opposite closed price direction is NOT a directional confirmation', () => {
  const scored = scoreRegularFlowQuality(formation('bullish'), indicator(), 'bybit', 'futures', bars(-1));
  const con = scored.validation!.confluence!;
  assert.equal(con.components.openInterest?.score, 1);
  assert.equal(con.flow?.independentSupport, 0);
  assert.equal(con.flow?.entryConfirmedWithFlow, false);
  assert.equal(scored.validation!.passed, true);
});

test('strong opposing delta and CVD block entry without changing existing levels', () => {
  const src = formation('bullish');
  const scored = scoreRegularFlowQuality(src,
    indicator({ oiChangePct: -2, deltaPct: -30, cvd20Pct: -12 }),
    'binance', 'futures', bars(1));
  const v = scored.validation!;
  assert.equal(v.passed, false);
  assert.equal(v.confirmed, true, 'pattern geometry remains separately confirmed');
  assert.equal(v.confluence?.flow?.entryBlockedByFlow, true);
  assert.equal(v.confluence?.flow?.status, 'contradicted');
  assert.equal(v.confluence?.components.delta?.score, 0);
  assert.equal(v.confluence?.components.cvd20?.score, 0);
  assert.match(scored.statusLabel, /розбіжність дельти\/CVD/);
  assert.ok(v.rejectionReasons.some(reason => /CVD20/.test(reason)));
  assert.deepEqual(scored.levels, src.levels);
});

test('SHORT with negative taker delta and falling prices earns bullish-like directionally aligned scores', () => {
  const scored = scoreRegularFlowQuality(formation('bearish'),
    indicator({ deltaPct: -25, cvd20Pct: -15 }), 'binance', 'futures', bars(-1));
  assert.equal(scored.validation!.confluence?.components.delta?.score, 5);
  assert.equal(scored.validation!.confluence?.components.cvd20?.score, 3);
  assert.equal(scored.validation!.confluence?.flow?.status, 'supported');
  assert.equal(scored.validation!.passed, true);
});

test('positive flow cannot turn an unconfirmed formation into a confirmed entry', () => {
  const src = formation('bullish', false);
  const scored = scoreRegularFlowQuality(src, indicator(), 'binance', 'futures', bars(1));
  assert.equal(scored.validation?.passed, false);
  assert.equal(scored.validation?.confluence?.flow?.entryConfirmedWithFlow, false);
  assert.equal(scored.validation?.confluence?.flow?.status, 'supported');
});

test('conflict requires BOTH opposing delta and CVD, not just noisy single-candle delta', () => {
  const scored = scoreRegularFlowQuality(formation(),
    indicator({ deltaPct: -28, cvd20Pct: 5 }), 'binance', 'futures', bars(1));
  assert.equal(scored.validation?.passed, true);
  assert.equal(scored.validation?.confluence?.flow?.entryBlockedByFlow, false);
});

test('round number and verified correct-side order-book wall each have separate points', () => {
  const src = formation('bullish');
  src.roundNumberContext = {
    detected: true, level: 100, distancePct: 0.04, step: 10,
    strength: 94, densityConfirmed: true, densityUsd: 25_000, side: 'BID',
  };
  const result = scoreRegularFlowQuality(src, indicator(), 'binance', 'futures', bars(1), true);
  const con = result.validation!.confluence!;
  assert.equal(con.availableMax, 100);
  assert.equal(con.components.roundNumber?.score, 4);
  assert.equal(con.components.density?.score, 5);
  assert.equal(con.components.density?.status, 'CONFIRMED');
  assert.equal(con.components.rsi?.score, 2);
  assert.equal(con.components.atr?.score, 1);
  assert.equal(con.components.rvol?.score, 1);
  assert.equal(con.rawTotal, 76.4);
  assert.equal(con.total, 76.4);
  assert.equal(result.confidence, 76);
  assert.equal(result.validation!.passed, true);
  assert.deepEqual(result.levels, src.levels);
});

test('round price without order book NEVER earns density points, but unavailable wall is no penalty', () => {
  const src = formation();
  src.roundNumberContext = {
    detected: true, level: 100, distancePct: 0.02, step: 10,
    strength: 88, densityConfirmed: false,
  };
  const unavailable = scoreRegularFlowQuality(src, indicator(), 'binance', 'futures', bars(1));
  assert.equal(unavailable.validation?.confluence?.components.roundNumber?.score, 4);
  assert.equal(unavailable.validation?.confluence?.components.density?.available, false);
  assert.equal(unavailable.validation?.confluence?.components.density?.score, 0);
  assert.equal(unavailable.validation?.confluence?.availableMax, 95);
  const inspected = scoreRegularFlowQuality(src, indicator(), 'binance', 'futures', bars(1), true);
  assert.equal(inspected.validation?.confluence?.components.density?.available, true);
  assert.equal(inspected.validation?.confluence?.components.density?.score, 0);
  assert.equal(inspected.validation?.confluence?.availableMax, 100);
  assert.ok(inspected.validation!.confluence!.total < unavailable.validation!.confluence!.total);
});

test('snapshot with wrong-side ASK density does not support bullish entry', () => {
  const src = formation();
  src.roundNumberContext = {
    detected: true, level: 100, distancePct: 0, step: 10,
    strength: 90, densityConfirmed: true, densityUsd: 50_000, side: 'ASK',
  };
  const result = scoreRegularFlowQuality(src, indicator(), 'binance', 'futures', bars(1), true);
  assert.equal(result.validation?.confluence?.components.density?.available, true);
  assert.equal(result.validation?.confluence?.components.density?.score, 0);
  assert.equal(result.validation?.passed, true, 'a mismatched single depth wall cannot override confirmed geometry');
});

test('RSI scoring is directional, ATR evaluates SL/TP suitability, and RVOL requires real breakout', () => {
  const goodLong = scoreRegularFlowQuality(formation('bullish'),
    indicator({ rsi14: 60, atrPct: 1.5 }), 'binance', 'futures', bars(1));
  assert.equal(goodLong.validation?.confluence?.components.rsi?.score, 3);
  assert.equal(goodLong.validation?.confluence?.components.atr?.score, 2);
  const chasedLong = scoreRegularFlowQuality(formation('bullish'),
    indicator({ rsi14: 85, atrPct: .1 }), 'binance', 'futures', bars(1));
  assert.equal(chasedLong.validation?.confluence?.components.rsi?.score, 0);
  assert.equal(chasedLong.validation?.confluence?.components.atr?.score, 0);
  const short = scoreRegularFlowQuality(formation('bearish'),
    indicator({ rsi14: 40 }), 'binance', 'futures', bars(-1));
  assert.equal(short.validation?.confluence?.components.rsi?.score, 3);
  const noBreakout = formation('bullish', false);
  noBreakout.validation!.breakoutConfirmed = false;
  const r = scoreRegularFlowQuality(noBreakout, indicator(), 'binance', 'futures', bars(1));
  assert.equal(r.validation?.confluence?.components.rvol?.score, 0);
  assert.equal(r.validation?.passed, false);
});

test('Δ +4.5% earns partial LONG credit, not a full directional confirmation', () => {
  const src = formation('bullish');
  const out = scoreRegularFlowQuality(src,
    indicator({ deltaPct: 4.5, cvd20Pct: -1, oiChangePct: undefined }),
    'binance', 'futures', bars(1));
  assert.equal(out.validation!.confluence!.components.delta?.score, 2);
  assert.match(out.validation!.confluence!.components.delta!.evidence, /4\.50%/);
  assert.equal(out.validation!.confluence!.flow?.entryConfirmedWithFlow, false);
  assert.equal(out.validation!.passed, true);
});

test('missing RSI ATR and round-level context are n/d, not zero evidence against the formation', () => {
  const missing = scoreRegularFlowQuality(formation(), { atrPct: null, rsi14: null },
    'bybit', 'spot', bars(1));
  const con = missing.validation!.confluence!;
  assert.equal(con.components.rsi?.available, false);
  assert.equal(con.components.atr?.available, false);
  assert.equal(con.components.roundNumber?.available, false);
  assert.equal(con.components.density?.available, false);
  assert.equal(con.availableMax, 73);
  assert.ok(con.total >= 0 && con.total <= 100);
  assert.deepEqual(Object.entries(con.components)
    .filter(([, part]) => part.available === false).map(([key]) => key).sort(),
    ['atr','cvd20','delta','density','openInterest','roundNumber','rsi'].sort());
});

test('browser OI hydration refreshes n/d / 5 to a real score without compounding old quality or confirmations', () => {
  const source = formation('bullish');
  const missing = scoreRegularFlowQuality(source,
    indicator({ oiChangePct: undefined, oiAvailability: 'network-error' }),
    'binance', 'futures', bars(1));
  const before = missing.validation!.confluence!;
  assert.equal(before.components.openInterest?.available, false);
  assert.match(before.components.openInterest!.evidence, /мережі/);
  assert.equal(before.flow?.available, 2);

  const hydrated = scoreRegularFlowQuality(missing,
    indicator({ oiChangePct: 1.5, oiAvailability: 'available', oiSource: 'browser' }),
    'binance', 'futures', bars(1), false, true);
  const after = hydrated.validation!.confluence!;
  assert.equal(after.components.openInterest?.available, true);
  assert.equal(after.components.openInterest?.score, 5);
  assert.equal(after.availableMax, before.availableMax! + 5);
  assert.equal(after.rawTotal, Number((before.rawTotal! + 5).toFixed(1)));
  assert.equal(after.flow?.available, 3);
  assert.match(after.components.openInterest!.evidence, /браузер/);
  assert.equal(after.independentConfirmations, before.independentConfirmations + 1);
  assert.deepEqual(hydrated.levels, missing.levels);
  assert.equal(hydrated.validation!.entryPrice, missing.validation!.entryPrice);
  assert.equal(hydrated.validation!.stopPrice, missing.validation!.stopPrice);
  assert.equal(hydrated.validation!.targetPrice, missing.validation!.targetPrice);
  assert.equal(hydrated.validation!.passed, missing.validation!.passed);

  const repeated = scoreRegularFlowQuality(hydrated,
    indicator({ oiChangePct: 1.5, oiAvailability: 'available', oiSource: 'browser' }),
    'binance', 'futures', bars(1), false, true);
  assert.equal(repeated.validation!.confluence!.total, after.total);
  assert.equal(repeated.validation!.confluence!.independentConfirmations, after.independentConfirmations);
  assert.equal(repeated.validation!.confluence!.notes.filter(n => n.startsWith('Рейтинг нормовано:')).length, 1);
});

test('refresh preserves known lack of a correct-side depth wall and its 0/5 penalty', () => {
  const src = formation();
  src.roundNumberContext = {
    detected: true, level: 100, distancePct: .02, step: 10,
    strength: 80, densityConfirmed: false,
  };
  const before = scoreRegularFlowQuality(src, indicator({ oiChangePct: undefined }),
    'binance','futures',bars(1),true);
  assert.equal(before.validation!.confluence!.components.density?.available, true);
  assert.equal(before.validation!.confluence!.components.density?.score, 0);
  const after = scoreRegularFlowQuality(before, indicator(), 'binance','futures',bars(1),
    before.validation!.confluence!.components.density!.available === true, true);
  assert.equal(after.validation!.confluence!.components.density?.available, true);
  assert.equal(after.validation!.confluence!.components.density?.score, 0);
});

test('successful server scan with missing OI is repaired directly by browser data and re-scored', async () => {
  const prevFetch = globalThis.fetch;
  const period = 300_000;
  const t = Math.floor(Date.now() / period) * period;
  const network: string[] = [];
  const oiRecords = [
    { timestamp: t - 3*period, sumOpenInterest: '100' },
    { timestamp: t - 2*period, sumOpenInterest: '101' },
    { timestamp: t - period, sumOpenInterest: '103' },
  ];
  const candles = Array.from({ length: 70 }, (_,i) => {
    const close = 100 + i * .01;
    const data = [t - (69 - i)*period, String(close), String(close+.2), String(close-.2),
      String(close), '100', 0, '10000', 1, '0', '6500'];
    return data;
  });
  const fakeFetch: typeof fetch = async input => {
    const url = String(input);
    network.push(url);
    if (url.includes('/futures/data/openInterestHist')) return new Response(JSON.stringify(oiRecords));
    if (url.includes('/fapi/v1/klines')) return new Response(JSON.stringify(candles));
    throw new Error('Unexpected request: ' + url);
  };
  globalThis.fetch = fakeFetch;
  try {
    const missing = scoreRegularFlowQuality(formation('bullish'),
      indicator({ oiChangePct: undefined, oiAvailability: 'network-error' }),
      'binance','futures',bars(1));
    const coin = {
      exchange: 'binance', marketType: 'futures', symbol: 'BTCUSDT',
      timeframe: '5m', formations: [missing],
      regularIndicators: indicator({ oiChangePct: undefined, oiAvailability: 'network-error' }),
    } as ScannedCoin;
    const result = await hydrateMissingRegularOIFromBrowser([coin]);
    assert.equal(result.length, 1);
    assert.equal(result[0].regularIndicators?.oiSource, 'browser');
    assert.equal(result[0].regularIndicators?.oiChangePct, 1.98);
    assert.equal(result[0].formations[0].validation?.confluence?.components.openInterest?.score, 5);
    assert.equal(result[0].formations[0].validation?.confluence?.flow?.independentSupport, 2);
    assert.deepEqual(result[0].formations[0].levels, missing.levels);
    assert.equal(network.filter(url => url.includes('/openInterestHist')).length, 1);
    assert.equal(network.filter(url => url.includes('/fapi/v1/klines')).length, 1);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('browser OI supplementation skips spot, already-verified OI and coins without formations', async () => {
  const prevFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('unexpected'); }) as typeof fetch;
  try {
    const source = formation('bullish');
    const list = [
      { exchange:'binance', marketType:'spot', timeframe:'5m', symbol:'BTCUSDT',
        formations:[source] },
      { exchange:'binance', marketType:'futures', timeframe:'5m', symbol:'ETHUSDT',
        formations:[], regularIndicators:{oiAvailability:'network-error'} },
      { exchange:'binance', marketType:'futures', timeframe:'5m', symbol:'SOLUSDT',
        formations:[source], regularIndicators:{oiChangePct:1.2, atrPct:1, rsi14:55} },
    ] as ScannedCoin[];
    assert.equal(await hydrateMissingRegularOIFromBrowser(list), list);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = prevFetch;
  }
});
