import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const analysis = readFileSync(new URL('../src/components/ChartTopAnalysisText.tsx', import.meta.url), 'utf8');
const chartPage = readFileSync(new URL('../src/components/FormationDetailsModal.tsx', import.meta.url), 'utf8');
const view = analysis.slice(analysis.lastIndexOf('  return (\n    <div className='));

test('chart top analysis centers the pair of columns within the chart on desktop', () => {
  assert.match(view, /data-testid="chart-top-analysis-columns"/);
  assert.match(view, /className="mx-auto grid w-full max-w-\[680px\] min-w-0 grid-cols-2/);
  assert.match(view, /items-start gap-x-3 gap-y-2 px-1/);
  assert.match(view, /sm:gap-x-6 sm:px-2 sm:text-xs lg:gap-x-10/);
  assert.equal((view.match(/<div className="min-w-0 space-y-1 break-words \[overflow-wrap:anywhere\]">/g) ?? []).length, 2);
  assert.doesNotMatch(view, /absolute|translate-x|left-1\/2|right-0/);
});

test('both columns remain visible on mobile with no fixed minimum width or clipping', () => {
  assert.match(view, /grid-cols-2/);
  assert.match(view, /w-full max-w-\[680px\] min-w-0/);
  assert.doesNotMatch(view, /overflow-hidden|overflow-x-auto|whitespace-nowrap|hidden sm:/);
  for (const label of ['Стопи шорт:', 'POC:', 'Стопи лонг:', 'Супротив:', 'Підтримка:', 'OI Binance:', 'OI Bybit:']) {
    assert.ok(view.includes(label), label);
  }
});

test('analysis stays directly above the chart and does not change its computation or data requests', () => {
  assert.match(chartPage, /<div ref=\{chartSectionRef\} tabIndex=\{-1\} className="space-y-3 outline-none">\s*\{\/\* Real-time Analysis Plain Text/);
  assert.match(chartPage, /<ChartTopAnalysisText[\s\S]*?\/>\s*\{loadingKlines/);
  assert.match(analysis, /fetchOI\(true\)/);
  assert.match(analysis, /formatCryptoPrice\(analysis\.sslPrice\)/);
  assert.match(analysis, /formatCryptoPrice\(analysis\.strongSupply\)/);
});
