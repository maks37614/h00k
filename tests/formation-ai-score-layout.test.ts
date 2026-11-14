import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAISetupScore } from '../server/geminiService';

const source = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const ui = source('../src/components/FormationDetailsModal.tsx');
const server = source('../server.ts');
const gemini = source('../server/geminiService.ts');

const smart = source('../src/components/SmartAnalysisBlock.tsx');

test('restore AI + Quant and replace ONLY its two top ratings with the detected setup', () => {
  assert.match(ui, /<SmartAnalysisBlock coin=\{coin\} formation=\{formation\} klines=\{klines\} timeframe=\{timeframe\}/);
  assert.match(ui, /tradeSetup=\{tradeSetupPanel\} onCollapse=\{toggleSmartAnalysis\}/);
  assert.match(ui, /smartAnalysisCollapsed \? \(/);
  assert.match(ui, /onClick=\{toggleSmartAnalysis\}/);
  assert.match(ui, /readSmartAnalysisPanelCollapsed/);
  assert.match(ui, /saveSmartAnalysisPanelCollapsed/);
  assert.match(ui, /updateProfileData\(\{ smartAnalysisCollapsed: next \}\)/);
  assert.equal((smart.match(/\{tradeSetup\}/g) || []).length, 4,
    'detected setup is rendered once per branch, including loading and error');
  assert.equal((ui.match(/id="formation-trade-setup-card"/g) || []).length, 1,
    'Entry/TP/SL and Telegram form only one logical setup card');
  assert.match(smart, /РОЗУМНИЙ АНАЛІЗ/);
  assert.match(smart, /AI \+ Quant/);
  assert.doesNotMatch(smart, /Ринкова оцінка \(не сигнал входу\)/);
  assert.doesNotMatch(smart, /Автоматично згенероване резюме/);
  const start = smart.indexOf('      {/* Canonical detected setup:');
  const atr = smart.indexOf('      {/* Only ATR remains', start);
  assert.ok(start > 0 && atr > start, 'detected setup replaces top two ratings, followed by ATR');
  assert.match(smart.slice(start, atr), /\{tradeSetup\}/);
  assert.match(smart, /fetch\(`\/api\/market\/smart-analysis\?\$\{queryParams\.toString\(\)\}`/);
  assert.match(smart, /analysisAbortRef\.current\?\.abort\(\)/);
  for (const retained of ['ATR (14) / Волатильність', 'Аналіз Holders', 'Великий учасник',
    'Маркет-мейкер', 'Маніпулятивність', 'Контекст BTC', 'RSI, EMA, Об\'єми та Спред',
    'Стакан, POC та Ліквідність', 'Open Interest та Деривативи']) {
    assert.ok(smart.includes(retained), 'AI+Quant module missing: ' + retained);
  }
  assert.match(smart, /onClick=\{fetchAnalysis\}/);
  for (const label of ['Виявлена формація','Якість сетапу','Торгові рівні (Setup)',
    'Точка входу (Entry):','Ціль (Take Profit):','Стоп-лос (Stop Loss):',
    'Сповіщення в Telegram']) {
    assert.ok(ui.includes(label), 'preserve existing formation feature: '+label);
  }
  assert.match(ui, /onClick=\{\(\) => handleSetAlert\('entry'/);
  assert.match(ui, /onClick=\{handleSetAllAlerts\}/);
});

test('the quality score folds out all existing validation factors and their actual evidence', () => {
  assert.match(ui, /aria-expanded=\{qualityExpanded\}/);
  assert.match(ui, /onClick=\{\(\) => setQualityExpanded\(expanded => !expanded\)\}/);
  assert.match(ui, /aria-controls="formation-setup-quality-details"/);
  assert.match(ui, /\{qualityExpanded && \(/);
  assert.match(ui, /Object\.entries\(formation\.validation\.confluence\.components\)/);
  assert.match(ui, /\.filter\(\(\[key\]\) => key !== 'density'\)/);
  assert.match(ui, /item\.available === false \? `н\/д \/ \$\{item\.max\}`/);
  assert.match(ui, /\{item\.evidence\}/);
  assert.match(ui, /formation\.validation\.confluence\.rawTotal/);
  assert.match(ui, /Детальний розподіл балів для цієї формації недоступний/);
  assert.match(ui, /formation\.confidence\}\/100/, 'the scanner score remains unchanged');
});

test('the AI-only score never runs automatically or displays generated commentary', () => {
  assert.match(ui, /onClick=\{handleRequestAi\}/);
  assert.match(ui, /<Sparkles className=/);
  assert.match(ui, /fetch\('\/api\/ai\/setup-score'/);
  assert.match(ui, /credentials: 'same-origin'/);
  assert.match(ui, /signal: controller\.signal/);
  assert.match(ui, /aiAbortRef\.current\?\.abort\(\)/);
  assert.match(ui, /aiContextKey = \[coin\.exchange, coin\.marketType, coin\.symbol, timeframe, formation\.id\]/);
  assert.match(ui, /aiScore !== null \? `AI: \$\{aiScore\}\/100`/);
  assert.doesNotMatch(ui, /aiAnalysis\.(?:summary|patternConfirmation|targetAnalysis)/);
  assert.doesNotMatch(ui, /fetch\('\/api\/market\/smart-analysis'/);
  assert.match(server, /app\.post\('\/api\/ai\/setup-score', requireUserAuth/);
  assert.match(server, /userWorkQuota\.allow\(userId, 'formation-ai-score', 10, 60 \* 60_000\)/);
  assert.match(server, /userWorkThrottle\.allow\(userId, 'formation-ai-score', 20_000\)/);
  assert.match(server, /GEMINI_API_KEY_NOT_CONFIGURED|Gemini не налаштовано/);
  assert.match(gemini, /model: 'gemini-2\.5-flash'/);
  assert.match(gemini, /responseMimeType: 'application\/json'/);
  assert.doesNotMatch(gemini.slice(gemini.indexOf('export async function evaluateFormationScoreWithAI')), /technical fallback|return formation\.confidence/);
});

test('AI numeric response parser accepts only independent integer /100 values', () => {
  assert.equal(parseAISetupScore('{"score":0}'),0);
  assert.equal(parseAISetupScore('{"score":79}'),79);
  assert.equal(parseAISetupScore('{"score":100}'),100);
  assert.equal(parseAISetupScore('```json\n{"score":63}\n```'),63);
  for (const raw of ['{"score":-1}', '{"score":101}', '{"score":99.5}',
    '{"score":"97"}', '{}', 'analysis unavailable', 'null', '[]']) {
    assert.throws(()=>parseAISetupScore(raw), 'must reject non-numeric/out-of-range results');
  }
});
