import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const service = source('../server/smartAnalysisService.ts');
const ui = source('../src/components/SmartAnalysisBlock.tsx');
const details = source('../src/components/FormationDetailsModal.tsx');

test('AI score icon is gone, but detected setup and full Quant panel work', () => {
  assert.doesNotMatch(details, /<Sparkles/);
  assert.doesNotMatch(details, /Оцінка AI/);
  assert.doesNotMatch(details, /\/api\/ai\/setup-score/);
  assert.match(details, /<SmartAnalysisBlock coin=\{coin\}/);
  assert.match(details, /tradeSetup=\{tradeSetupPanel\}/);
  assert.match(details, /aria-expanded=\{qualityExpanded\}/);
  assert.match(ui, /fetch\(`\/api\/market\/smart-analysis\?\$\{queryParams\.toString\(\)\}`/);
});

test('exchange / market type are respected for live depth and missing depth cannot invent walls', () => {
  assert.match(service, /marketType === 'spot' \? 'spot' : 'linear'/);
  assert.match(service, /data-api\.binance\.vision\/api\/v3\/depth/);
  assert.match(service, /fapi\.binance\.com\/fapi\/v1\/depth/);
  assert.match(service, /api\.bybit\.com\/v5\/market\/orderbook/);
  assert.match(service, /fetchOrderbookAnalysis\(symbol, exchange, marketType\)/);
  assert.match(service, /available: false, source, bidAskRatio: null/);
  assert.match(service, /spread: \{ spreadUsd: null, spreadPct: null, quality: 'unavailable' \}/);
  assert.doesNotMatch(service, /amountUsd: 145000|amountUsd: 92000|amountUsd: 120000|amountUsd: 180000/);
  assert.doesNotMatch(service, /bidWallUsd: Math\.round\(currentPrice \* 25000\)/);
  assert.match(ui, /priceOrNA\(data\.orderbook\.bidWallPrice\)/);
  assert.match(ui, /volumeOrNA\(data\.orderbook\.askWallUsd\)/);
});

test('no invented BTC quotes, structural signals, dates or pseudo-24h from arbitrary TF candles', () => {
  assert.doesNotMatch(service, /btcPrice: 85200|btcPrice = .*85000|change24h = .*1\.2/);
  assert.match(service, /structure: 'unknown', label: 'Немає даних біржі'/);
  assert.match(service, /upcomingNews: \[\]/);
  assert.match(service, /if \(klines\.length < 201\)/);
  assert.match(service, /if \(klines\.length < 201 \|\| !klines\.every\(finiteBar\)\)/);
  assert.doesNotMatch(service, /currentPrice \* 1\.03|currentPrice \* 0\.97/);
  assert.match(service, /fetchKlines\(exchange, marketType, symbol, '1h', 26\)/);
  assert.match(service, /closedHours\.length === 24/);
  assert.match(service, /quoteIsUsdLike/);
  assert.match(service, /const currentPrice = klines\[klines\.length - 1\]\.close/);
  assert.match(ui, /Календар новин не підключено/);
  assert.match(ui, /data\.btcContext\.change24h === null \? 'н\/д'/);
  assert.match(ui, /volumeOrNA\(data\.volumeMetrics\.volume24hUsd\)/);
});

test('holder wallets, iceberg trades, HFT algorithms and manipulation are not fabricated', () => {
  assert.match(service, /const top10ConcentrationPct: number \| null = null/);
  assert.match(service, /const activeWalletsGrowthPct: number \| null = null/);
  assert.match(service, /const retailVsWhaleRatio: string \| null = null/);
  assert.match(service, /const algorithmType: SmartAnalysisData\['participants'\]\['marketMaker'\]\['algorithmType'\] = null/);
  assert.match(service, /const isManipulativeCoin: boolean \| null = null/);
  assert.match(service, /type: 'limit_order'/);
  assert.doesNotMatch(service, /185000|140000|45000|top10ConcentrationPct = total24hVolUsd/);
  assert.doesNotMatch(service, /TWAP-набір|Айсберг у стакані|активних адрес за добу/);
  assert.doesNotMatch(ui, /54\}%|62% Whales & Insiders|HFT_GRID|95% Conf|320000/);
  assert.match(ui, /CoinGecko Holders недоступні/);
  assert.match(ui, /holderSnapshot\?\.status === 'available'/);
  assert.match(ui, /Одного зрізу стакана недостатньо/);
  assert.match(ui, /Евристика, не доказ маніпуляцій/);
  assert.match(ui, /Підтверджений спред вибраного ринку/);
});

test('POC and trade-level claims are explicitly approximate, not executed-volume evidence', () => {
  assert.match(service, /function calculatePOC\(klines: Kline\[\]\)/);
  assert.match(service, /pocVolumePct: null/);
  assert.doesNotMatch(service, /Math\.max\(pocVolumePct, 15\)|pocVolumePct: 22/);
  assert.match(ui, /Оціночний POC за свічками/);
  assert.match(ui, /Розрахункові цінові орієнтири/);
  assert.match(ui, /не виконані угоди/);
});
