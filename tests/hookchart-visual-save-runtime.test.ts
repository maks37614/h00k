import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { captureVisualProfile, getVisualProfile } from '../src/components/hookchart/visualProfiles';

/** Execute the real HookChart visual-profile effect, not a duplicate algorithm. */
const source = readFileSync(new URL('../src/components/hookchart/engine.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('engine.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const chartNode = ast.statements.find(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'Chart');
assert.ok(chartNode, 'the real Chart function must exist');

function buildEffect(needle: string) {
  let found: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)
        && node.expression.getText(ast) === 'useLayoutEffect'
        && node.arguments[0]?.getText(ast).includes(needle)) {
      found = node.arguments[0];
    }
    ts.forEachChild(node, visit);
  }
  visit(chartNode!);
  assert.ok(found, 'HookChart effect missing: ' + needle);
  const callback = found!.getText(ast);
  const vars = [
    'visualProfile','visualProfileKey','visualProfileCaptureVersion','lastVisualCaptureRef',
    'visualAppliedRef','ref','initialLogicalRange','candles','symbol','tf','terminalMode',
    'terminalNavigation','terminalAutoScale','setVp','hookChartPlotWidth','rangeRestored',
    'restoredHookViewport','rightPaddingBars','rightPadding',
  ];
  const script = `exports.run=(env)=>{const {${vars.join(',')}}=env;(${callback})();};`;
  const code = ts.transpileModule(script, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: { run?: (environment: Record<string, any>) => void } = {};
  new Function('exports', code)(exports);
  assert.ok(exports.run);
  return exports.run!;
}

const applyProfile = buildEffect('lastVisualCaptureRef.current!==visualProfileCaptureVersion');
const restorePreviousRange = buildEffect('rangeRestored.current');

function fixture() {
  const updates: Array<Record<string, any>> = [];
  let viewport: Record<string, any> | undefined;
  const candles = Array.from({ length: 150 }, (_, index) => ({
    t: 1700000000000 + index * 3600000,
    o: 100 + index, h: 105 + index, l: 95 + index, c: 102 + index,
  }));
  const env: Record<string, any> = {
    visualProfile: getVisualProfile(undefined, 'screenerFull', 'desktop'),
    visualProfileKey: 'screenerFull:desktop',
    visualProfileCaptureVersion: 0,
    lastVisualCaptureRef: { current: 0 },
    visualAppliedRef: { current: null },
    ref: { current: { getBoundingClientRect: () => ({ width: 600 }) } },
    initialLogicalRange: null, candles, symbol: 'BTCUSDT', tf: '1h',
    terminalMode: false, terminalAutoScale: false, terminalNavigation: { current: false },
    hookChartPlotWidth: (width: number) => width - 60,
    rangeRestored: { current: false },
    restoredHookViewport: () => ({ barWidth: 3, rightOffset: 88, autoY: true }),
    rightPaddingBars: 0, rightPadding: 0,
    setVp(value: Record<string, any>) { viewport = value; updates.push(value); },
  };
  return { env, updates, getViewport: () => viewport };
}

test('capturing the actual preview zoom does not reset it; next slider change still applies', () => {
  const { env, updates, getViewport } = fixture();
  applyProfile(env);
  assert.equal(updates.length, 1);
  assert.ok(getViewport()!.barWidth > 0);

  // A real gesture zoom/pan is different from the visual preset's initial view.
  const manual = {
    ...getViewport()!, barWidth: 16.5, rightOffset: 23,
    autoY: false, manualCenter: 210, manualRange: 44,
  };
  env.setVp(manual);
  const saved = captureVisualProfile(env.visualProfile, 540, manual, 88);
  assert.ok(saved.visibleBars < env.visualProfile.visibleBars);
  assert.equal(saved.rightGapBars, env.visualProfile.rightGapBars,
    'capturing a gesture must never silently overwrite the Graph tab right margin');
  const before = updates.length;
  env.visualProfile = saved;
  env.visualProfileCaptureVersion = 1;
  applyProfile(env);
  assert.equal(updates.length, before, 'Save must not overwrite the gesture-adjusted viewport');
  assert.deepEqual(getViewport(), manual);

  // Streaming candles must also not re-apply an unchanged profile.
  applyProfile(env);
  assert.equal(updates.length, before);

  // Deliberately changing a slider does apply the newly selected profile.
  env.visualProfile = { ...saved, visibleBars: saved.visibleBars + 10 };
  applyProfile(env);
  assert.equal(updates.length, before + 1);
});

test('saved visual profiles take precedence over per-coin old ranges and survive TF changes', () => {
  const { env, updates } = fixture();
  env.initialLogicalRange = { from: 4, to: 65 };
  applyProfile(env);
  assert.equal(updates.length, 1, 'old chart range must not block a saved visual profile');
  restorePreviousRange(env);
  assert.equal(updates.length, 1, 'old range must not overwrite user profile');

  const firstWidth = updates[0].barWidth;
  env.tf = '4h';
  applyProfile(env);
  assert.equal(updates.length, 2, 'changing timeframe should reapply user profile');
  assert.equal(updates[1].barWidth, firstWidth);

  env.visualProfile = undefined; // Replay/legacy chart
  restorePreviousRange(env);
  assert.equal(updates.length, 3, 'legacy per-coin ranges remain available without a profile');
});

test('Replay/no-profile still bypasses visual presets entirely', () => {
  const { env, updates } = fixture();
  env.visualProfile = undefined;
  applyProfile(env);
  assert.equal(updates.length, 0);
});

test('144 visible candles, vertical zoom 0.4 and 81-bar gap update the preview immediately', () => {
  const { env, updates, getViewport } = fixture();
  env.visualProfile = {
    visibleBars: 144, verticalZoom: .4, autoPriceScale: true, rightGapBars: 81,
  };
  env.visualProfileKey = 'terminalCompact:mobile';
  env.terminalMode = true;
  env.rightPaddingBars = 81;
  applyProfile(env);
  assert.equal(updates.length, 1);
  const width = env.hookChartPlotWidth(600);
  assert.ok(Math.abs(getViewport()!.barWidth - width / (144 + 81)) < 1e-8);
  assert.equal(Math.round(width / getViewport()!.barWidth - env.rightPaddingBars), 144);
  assert.equal(getViewport()!.rightOffset, 0);
  assert.equal(getViewport()!.yZoom, .4);
  assert.equal(getViewport()!.autoY, true);
  assert.equal(getViewport()!.manualRange, null);

  env.visualProfile = { ...env.visualProfile, rightGapBars: 50 };
  env.rightPaddingBars = 50;
  applyProfile(env);
  assert.equal(updates.length, 2, 'changing the gap must update the preview without a Save click');
  assert.ok(Math.abs(getViewport()!.barWidth - width / (144 + 50)) < 1e-8);

  env.visualProfile = { ...env.visualProfile, visibleBars: 100 };
  applyProfile(env);
  assert.equal(updates.length, 3, 'moving the candle count slider updates width');
  assert.ok(Math.abs(getViewport()!.barWidth - width / (100 + 50)) < 1e-8);

  env.visualProfile = { ...env.visualProfile, autoPriceScale: false };
  applyProfile(env);
  assert.equal(updates.length, 4, 'switching auto price off updates the price range');
  assert.equal(getViewport()!.autoY, false);
  assert.ok(getViewport()!.manualRange > 0);
  assert.equal(getViewport()!.yZoom, .4);

  env.visualProfile = { ...env.visualProfile, verticalZoom: 1.4 };
  applyProfile(env);
  assert.equal(updates.length, 5, 'vertical zoom slider applies immediately');
  assert.equal(getViewport()!.yZoom, 1.4);
  assert.equal(getViewport()!.autoY, false);
});

test('visual preview passes the same right margin to candles and time axis', () => {
  const preview = readFileSync(new URL('../src/components/hookchart/HookChartVisualPreview.tsx', import.meta.url), 'utf8');
  const editor = readFileSync(new URL('../src/components/hookchart/OriginalHookChartSettings.tsx', import.meta.url), 'utf8');
  assert.match(preview, /visualProfile=\{profile\}/);
  assert.equal((preview.match(/rightPaddingBars=\{profile\.rightGapBars\}/g) || []).length, 2);
  assert.match(editor, /profile=\{selectedProfile\}/);
  assert.match(editor, /onChange=\{onProfileChange\}/);
  for (const key of ['visibleBars', 'verticalZoom', 'autoPriceScale', 'rightGapBars']) {
    assert.match(editor, new RegExp('onProfileChange\\(\\{ ' + key + ':'));
  }
});
