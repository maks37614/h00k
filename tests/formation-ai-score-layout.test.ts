import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAISetupScore } from '../server/geminiService';

const source = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const ui = source('../src/components/FormationDetailsModal.tsx');
const server = source('../server.ts');
const gemini = source('../server/geminiService.ts');

test('the large auto-updating Smart Analysis block is replaced with a single detected setup panel', () => {
  assert.doesNotMatch(ui, /<SmartAnalysisBlock/);
  assert.doesNotMatch(ui, /РОЗУМНИЙ АНАЛІЗ/);
  assert.doesNotMatch(ui, /Інституційний Розбір Формації/);
  assert.match(ui, /const tradeSetupPanel = \(/);
  assert.match(ui, /id="formation-trade-setup-card"/);
  assert.match(ui, /\{tradeSetupPanel\}/);
  assert.equal((ui.match(/\{tradeSetupPanel\}/g) || []).length, 1,
    'the detected setup is mounted once, never duplicated');
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
