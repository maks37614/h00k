import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
import { HookChartVisualPreview } from '../src/components/hookchart/HookChartVisualPreview';
import { captureVisualProfile, getVisualProfile } from '../src/components/hookchart/visualProfiles';

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
const previewSource = source('../src/components/hookchart/HookChartVisualPreview.tsx');
const settingsSource = source('../src/components/hookchart/OriginalHookChartSettings.tsx');
const canvasSource = source('../src/components/hookchart/HookChartCanvas.tsx');

const candles = Array.from({ length: 80 }, (_, index) => ({
  t: 1700000000000 + index * 3600000,
  o: 42500 + index * 12, h: 42580 + index * 12,
  l: 42450 + index * 12, c: 42545 + index * 12,
  v: 12 + index / 2, n: 0,
}));

test('real settings preview renders the HookChart canvas with actual OHLCV, price and time axis', () => {
  const html = renderToStaticMarkup(React.createElement(HookChartVisualPreview, {
    candles,
    symbol: 'BTCUSDT',
    timeframe: '1h',
    exchange: 'binance',
    marketType: 'futures',
    visualContext: 'screenerQuick',
    visualDevice: 'desktop',
    profile: getVisualProfile(undefined, 'screenerQuick', 'desktop'),
    onChange: () => {},
  }));
  assert.match(html, /class="hookchart-visual-preview-frame"/);
  assert.match(html, /class="chartWrap"/);
  assert.match(html, /<canvas/);
  assert.match(html, /aria-label="Графік BTCUSDT"/);
  assert.match(html, /class="chartTimeAxis"/);
  assert.match(html, /Binance/);
  assert.match(html, /Дані відкритого HookChart/);
  assert.match(html, /Зберегти масштаб/);
  assert.doesNotMatch(html, /Приклад відносного масштабу|не реальні котирування/);
});

test('settings editor replaces synthetic SVG with real HookChart preview and wires existing candles', () => {
  assert.match(settingsSource, /<HookChartVisualPreview/);
  assert.match(settingsSource, /profile=\{selectedProfile\}/);
  assert.match(settingsSource, /onChange=\{onProfileChange\}/);
  assert.match(settingsSource, /previewCandles=\{previewCandles\}/);
  assert.doesNotMatch(settingsSource, /const bars = Math\.max\(14, Math\.min\(72/);
  assert.doesNotMatch(settingsSource, /Приклад відносного масштабу/);
  assert.match(canvasSource, /previewCandles=\{candles\}/);
  assert.match(canvasSource, /previewSymbol=\{symbol\}/);
  assert.match(canvasSource, /previewTimeframe=\{timeframe\}/);
  assert.match(canvasSource, /!replay && panel === 'settings'/);
});

test('live preview never creates another exchange feed or changes drawing and alert persistence', () => {
  assert.match(previewSource, /import \{\s*Chart, ChartTimeAxis,/);
  assert.match(previewSource, /const useParentCandles = candles !== undefined/);
  assert.match(previewSource, /if \(useParentCandles\) return/);
  assert.match(previewSource, /fetchDirectKlines\(marketExchange, marketTypeSelected, marketSymbol, marketTimeframe, 900\)/);
  assert.match(previewSource, /showLiqRiskBlock=\{false\}/);
  assert.match(previewSource, /controlsContainer=\{null\}/);
  assert.match(previewSource, /onViewportGesture=\{onGesture\}/);
  assert.match(previewSource, /onViewportChange=\{next =>/);
  assert.match(previewSource, /captureVisualProfile\(/);
  assert.doesNotMatch(previewSource, /new WebSocket|setInterval|onCreatePriceAlert=|onNeedHistory=/);
});

test('profile chart uses real measured width, matching engine viewports instead of a fixed-width illustration', () => {
  assert.match(previewSource, /const \[chartWidth, setChartWidth\] = useState\(0\)/);
  assert.match(previewSource, /new ResizeObserver\(update\)/);
  assert.match(previewSource, /hookChartPlotWidth\(chartWidth\) \/ viewport\.barWidth/);
  assert.doesNotMatch(previewSource, /profilePreviewWidth\(|maxWidth: profilePreviewWidth/);
  const css = source('../src/components/hookchart/integration.css');
  assert.match(css, /hookchart-visual-preview-chart/);
  assert.match(css, /hookchart-visual-preview-frame \{\s*max-width:none;\s*width:100%;/);
  assert.match(css, /touch-action:none/);
  assert.match(css, /@media \(max-width:600px\)/);
  assert.match(previewSource, /Свічки вибраної біржі · реальний HookChart/);
});

test('profile real HookChart picker uses Binance or Bybit spot/futures and the selected timeframe', () => {
  assert.match(previewSource, /marketDefaults\?: \{ exchange\?: ExchangeId; marketType\?: MarketType; timeframe\?: Timeframe \}/);
  assert.match(previewSource, /marketDefaults\?\.exchange \|\| 'binance'/);
  assert.match(previewSource, /marketDefaults\?\.timeframe \|\| '15m'/);
  assert.match(previewSource, /marketExchange, marketTypeSelected, marketSymbol, marketTimeframe, 900/);
  assert.match(previewSource, /aria-label="Біржа HookChart у профілі"/);
  assert.match(previewSource, /aria-label="Ринок HookChart у профілі"/);
  assert.match(previewSource, /aria-label="Таймфрейм HookChart у профілі"/);
  assert.match(previewSource, /aria-label="Монета HookChart у профілі"/);
  assert.match(previewSource, /showVolumes=\{chartPreferences\?\.showVolumes !== false\}/);
  assert.doesNotMatch(previewSource, /new WebSocket|setInterval/);
  assert.match(settingsSource, /marketDefaults=\{marketDefaults\}/);
  assert.match(settingsSource, /chartPreferences=\{prefs\}/);
  const profile = source('../src/components/profile/ProfileHookChartSettings.tsx');
  assert.match(profile, /exchange: profile\.defaultExchange === 'all'/);
  assert.match(profile, /previewLongColor=\{draft\.candleLongColor\}/);
});
test('Replay chart is unaffected by the new chart-only settings preview', () => {
  const replay = source('../src/components/replay/ReplayChart.tsx');
  assert.doesNotMatch(replay, /HookChartVisualPreview|previewCandles|visualProfileEditor/);
});


test('preview accepts mouse-wheel zoom inside the settings dialog, but ignores other dialog controls', () => {
  const engine = source('../src/components/hookchart/engine.tsx');
  assert.match(engine, /const surface=target\.closest\('\.chartStage,\.chartWrap,\.chartTimeAxis'\)/);
  assert.match(engine, /target\.closest\('\.originalSettingsBackdrop'\)&&!target\.closest\('\.hookchart-visual-preview'\)/);
  assert.doesNotMatch(engine, /timeJumpPopover,\.originalSettingsBackdrop,\.densityQuickPopup/);
  assert.match(engine, /host\.addEventListener\('wheel',onWheel,\{capture:true,passive:false\}\)/);
  assert.match(engine, /wheelHandlerRef\.current\(event\)/);
});

test('saved visual profiles reinitialize on coin and timeframe changes but not on every candle tick', () => {
  const engine = source('../src/components/hookchart/engine.tsx');
  assert.match(engine, /const signature=\[symbol,tf,visualProfileKey,visualProfile\.visibleBars/);
  assert.match(engine, /\},\[symbol,tf,visualProfileKey,visualProfileCaptureVersion,visualProfile\?\.visibleBars/);
  assert.match(engine, /if\(visualAppliedRef\.current===signature\)return/);
  // A stored wide overview must not be capped at three-pixel bars.
  assert.match(engine, /const minBar=\.12/);
  const horizontal = source('../src/utils/hookchartData.ts');
  assert.match(horizontal, /Math\.max\(\.12, viewport\.barWidth\)/);
  assert.match(engine, /const denseBars=g\.step\*scaleX<1\.15/);
});


test('saving a manually zoomed preview preserves the viewport rather than reapplying defaults', () => {
  const preview = source('../src/components/hookchart/HookChartVisualPreview.tsx');
  const engine = source('../src/components/hookchart/engine.tsx');
  assert.match(preview, /visualProfileCaptureVersion, setVisualProfileCaptureVersion/);
  assert.match(preview, /onChange\(captured\);\s*setVisualProfileCaptureVersion\(version => version \+ 1\)/);
  assert.match(preview, /visualProfileCaptureVersion=\{visualProfileCaptureVersion\}/);
  assert.match(engine, /lastVisualCaptureRef=useRef\(visualProfileCaptureVersion\)/);
  assert.match(engine, /if\(lastVisualCaptureRef\.current!==visualProfileCaptureVersion\)/);
  assert.match(engine, /lastVisualCaptureRef\.current=visualProfileCaptureVersion;[\s\S]*?const gapDelta=rightPaddingBars-lastVisualGapRef\.current/);
  assert.match(engine, /\[symbol,tf,visualProfileKey,visualProfileCaptureVersion,/);
});

test('saved chart visual profile overrides stale per-coin logical ranges', () => {
  const engine = source('../src/components/hookchart/engine.tsx');
  const canvas = source('../src/components/hookchart/HookChartCanvas.tsx');
  const preview = source('../src/components/hookchart/HookChartVisualPreview.tsx');
  assert.match(engine, /if\(!visualProfile\|\|!visualProfileKey\|\|!candles\.length\)return/);
  assert.doesNotMatch(engine, /if\(!visualProfile\|\|!visualProfileKey\|\|initialLogicalRange\|\|/);
  assert.match(engine, /if\(visualProfile\|\|rangeRestored\.current\|\|!candles\.length\|\|!initialLogicalRange\)return/);
  assert.match(canvas, /initialLogicalRange=\{savedChartParams\?\.visibleRange\}/);
  assert.match(canvas, /visualProfile=\{activeVisualProfile\}/);
  assert.match(preview, /rightPaddingBars=\{profile\.rightGapBars\}/);
  assert.match(engine, /barWidth,rightOffset:0,autoY:priceAuto/);
});

test('wheel zoom is isolated between preview and its underlying live chart', () => {
  const engine = source('../src/components/hookchart/engine.tsx');
  assert.match(engine, /const ownPreview=box\.current\?\.closest\('\.hookchart-visual-preview'\)/);
  assert.match(engine, /ownPreview \? !ownPreview\.contains\(surface\) : !!surface\.closest\('\.hookchart-visual-preview'\)/);
  assert.match(engine, /if\(target\.closest\('\.originalSettingsBackdrop'\)&&!target\.closest\('\.hookchart-visual-preview'\)\)return/);
});


test('preview user gestures publish changes to the actual settings profile immediately', () => {
  const ast = ts.createSourceFile('HookChartVisualPreview.tsx', previewSource,
    ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let callback: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'onGesture'
        && node.initializer && ts.isCallExpression(node.initializer)) {
      callback = node.initializer.arguments[0]?.getText(ast);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(callback, 'real onGesture callback must exist in preview source');
  const vars = ['profileRef', 'previewRef', 'activeCandles', 'visualContext', 'hookChartPlotWidth',
    'captureVisualProfile', 'dragBaseline', 'viewportRef', 'VISUAL_GAP_MAX',
    'setGestureEdited', 'setVisualProfileCaptureVersion', 'onChange'];
  const script = 'exports.run=(env,viewport,kind)=>{const {' + vars.join(',') + '}=env;(' + callback + ')(viewport,kind);};';
  const code = ts.transpileModule(script,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: { run?: (env: Record<string, unknown>, viewport: Record<string, unknown>, kind: string) => void } = {};
  new Function('exports', code)(exports);
  assert.ok(exports.run);

  const selected = getVisualProfile(undefined, 'screenerFull', 'mobile');
  const profileRef = { current: { ...selected, visibleBars: 144, verticalZoom: 1,
    autoPriceScale: true, rightGapBars: 40 } };
  const values: typeof selected[] = [];
  const activeCandles = Array.from({ length: 210 }, (_, i) => ({
    t: i * 3600000, o: 80 + i, h: 85 + i, l: 75 + i, c: 82 + i, v: 1, n: 0,
  }));
  let captures = 0, edits = 0;
  const env = {
    profileRef,
    previewRef: { current: { getBoundingClientRect: () => ({ width: 600 }) } },
    activeCandles, visualContext: 'screenerFull',
    hookChartPlotWidth: (width: number) => width - 60,
    captureVisualProfile,
    dragBaseline: { current: { gap: 40, offset: 0 } },
    viewportRef: { current: null },
    VISUAL_GAP_MAX: 2000,
    setGestureEdited: () => { edits++; },
    setVisualProfileCaptureVersion: (apply: (old: number) => number) => { captures = apply(captures); },
    onChange: (next: typeof selected) => values.push(next),
  };
  const initialBarWidth = 540 / (144 + 40);
  exports.run!(env, { barWidth: initialBarWidth, rightOffset: -5, autoY: true,
    manualRange: null, fitAll: false }, 'pan');
  assert.equal(profileRef.current.rightGapBars, 45);
  // Subsequent drag move is based on the original pointer-down state.
  // Engine compensates the previous 5-bar update so offset is -5 again.
  exports.run!(env, { barWidth: initialBarWidth, rightOffset: -5, autoY: true,
    manualRange: null, fitAll: false }, 'pan');
  assert.equal(profileRef.current.rightGapBars, 50, 'continuous dragging must not accumulate gap twice');

  exports.run!(env, { barWidth: 540 / (90 + 50), rightOffset: 0,
    autoY: true, manualRange: null, fitAll: false }, 'zoom');
  assert.equal(profileRef.current.visibleBars, 90);
  assert.equal(profileRef.current.rightGapBars, 50);

  exports.run!(env, { barWidth: 540 / (90 + 50), rightOffset: 0,
    autoY: false, manualCenter: 180, manualRange: 20, fitAll: false }, 'price');
  assert.equal(profileRef.current.autoPriceScale, false);
  assert.ok(profileRef.current.verticalZoom > 1);
  assert.equal(captures, 4);
  assert.equal(edits, 4);
  assert.equal(values.length, 4);

  assert.match(previewSource, /onViewportGesture=\{onGesture\}/);
  assert.match(previewSource, /onPointerDownCapture=\{rememberDragStart\}/);
  assert.match(previewSource, /Зберегти масштаб/);
  assert.match(previewSource, /Автофокус/);
  const engine = source('../src/components/hookchart/engine.tsx');
  assert.match(engine, /onViewportGesture\?\.\(vp,kind\)/);
  assert.match(engine, /startRightPaddingBars:rightPaddingBars/);
  assert.match(engine, /rightPaddingBars-\(d\.startRightPaddingBars\?\?rightPaddingBars\)/);
});
