import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalCandlePriceRange } from '../src/components/hookchart/terminalAutoScale';
import { readFileSync } from 'node:fs';
import { hookChartHorizontalRange } from '../src/utils/hookchartData';

test('terminal auto-scale keeps the lowest visible wick above volume histogram', () => {
  for (const height of [80, 100, 160, 220, 380, 700]) {
    const range = terminalCandlePriceRange(95, 110, height, true);
    const wickY = height - (95 - range.low) / (range.high - range.low) * height;
    const volumeTop = height - 3 - Math.max(56, Math.min(108, height * .14));
    assert.ok(wickY < volumeTop - 5, `lower wick must clear volume band at ${height}px`);
    const upperWickY = height - (110 - range.low) / (range.high - range.low) * height;
    assert.ok(upperWickY > 0, 'upper wick remains inside the chart');
  }
});

test('terminal auto-scale works with volumes hidden and tiny crypto prices', () => {
  const regular = terminalCandlePriceRange(95, 110, 300, false);
  const withVolumes = terminalCandlePriceRange(95, 110, 300, true);
  assert.ok(regular.low > withVolumes.low, 'volume band receives additional space');
  const tiny = terminalCandlePriceRange(.00000091, .00000105, 180, true);
  assert.ok(Number.isFinite(tiny.low) && Number.isFinite(tiny.high));
  assert.ok(tiny.low < .00000091 && tiny.high > .00000105);
});

test('auto-scale does not change chart history or require a candle feed', () => {
  const first = terminalCandlePriceRange(100, 100, 280, true);
  assert.ok(first.high > first.low);
  assert.ok(Number.isFinite(first.low));
});

test('terminal auto-scale honors the saved right gap and aligns chart with the time axis', () => {
  const chart = readFileSync(new URL('../src/components/hookchart/HookChartCanvas.tsx', import.meta.url), 'utf8');
  assert.match(chart, /terminalMode && terminalAutoScale\s*\? \(activeVisualProfile\?\.rightGapBars \?\? 8\)/);
  assert.match(chart, /<ChartTimeAxis[^>]*rightPaddingBars=\{rightPaddingBars\}/);
  assert.match(chart, /<IndicatorDock[^>]*rightPaddingBars=\{rightPaddingBars\}/);
  const width = 300, count = 120, barWidth = 5;
  for (const savedGapBars of [5, 10, 15, 30]) {
    const range = hookChartHorizontalRange(count, width, { barWidth, rightOffset: 0 }, savedGapBars);
    const latestCandleX = (count - .5 - range.virtualStart) * range.step;
    assert.ok(latestCandleX < width - savedGapBars * barWidth,
      'latest candle must stay left of the right price scale with the configured margin');
  }
});
