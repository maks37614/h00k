import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OriginalHookChartSettings, normalizeOriginalHookChartPreferences } from '../src/components/hookchart/OriginalHookChartSettings';
import {
  VISUAL_CONTEXTS, captureVisualProfile, getVisualProfile, makeVisualProfileKey,
  normalizedVisualProfiles, patchVisualProfile, visualContextForTerminalWidth,
  visualDeviceForWidth,
} from '../src/components/hookchart/visualProfiles';

const src = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

test('visual settings have seven independent chart contexts and separate phone/desktop keys', () => {
  assert.deepEqual(VISUAL_CONTEXTS.map(item => item.id), [
    'screenerQuick','screenerFull','formationsQuick','formationsFull',
    'terminalLarge','terminalMedium','terminalCompact',
  ]);
  assert.notEqual(makeVisualProfileKey('screenerQuick','mobile'),makeVisualProfileKey('screenerFull','mobile'));
  assert.notEqual(makeVisualProfileKey('formationsQuick','desktop'),makeVisualProfileKey('formationsQuick','mobile'));
  assert.equal(visualDeviceForWidth(390),'mobile');
  assert.equal(visualDeviceForWidth(767),'mobile');
  assert.equal(visualDeviceForWidth(768),'desktop');
  assert.equal(visualContextForTerminalWidth(330),'terminalCompact');
  assert.equal(visualContextForTerminalWidth(550),'terminalMedium');
  assert.equal(visualContextForTerminalWidth(1024),'terminalLarge');
});

test('visual chart profiles sanitize invalid JSON while preserving other contexts', () => {
  const key = makeVisualProfileKey('screenerQuick','mobile');
  const another = makeVisualProfileKey('terminalCompact','desktop');
  const prefs = patchVisualProfile(undefined,key,{visibleBars:80,verticalZoom:1.5,autoPriceScale:false,rightGapBars:7});
  const both = patchVisualProfile(prefs,another,{visibleBars:30});
  assert.equal(getVisualProfile({ visualProfiles: both },'screenerQuick','mobile').visibleBars,80);
  assert.equal(getVisualProfile({ visualProfiles: both },'terminalCompact','desktop').visibleBars,30);
  assert.equal(getVisualProfile({ visualProfiles: both },'screenerQuick','mobile').verticalZoom,1.5);
  const reset = patchVisualProfile(both,key,null);
  assert.equal(reset[key],undefined);
  assert.equal(reset[another]?.visibleBars,30);
  const normalized = normalizedVisualProfiles({
    [key]:{visibleBars:NaN,verticalZoom:Infinity,autoPriceScale:'false',rightGapBars:-700},
    'unexpected:danger':{visibleBars:100},
  });
  assert.ok(!('unexpected:danger' in normalized));
  assert.equal(normalized[key]?.rightGapBars,0);
  assert.equal(normalized[key]?.autoPriceScale,true);
  assert.equal(normalized[key]?.visibleBars,65);
  assert.equal(normalized[key]?.verticalZoom,1);
});

test('capture records relative viewport properties, not fixed prices or ticker', () => {
  const base = getVisualProfile(undefined,'formationsQuick','desktop');
  const captured = captureVisualProfile(base,800,{
    barWidth:8,rightOffset:12,autoY:false,manualRange:50,
  },100);
  assert.deepEqual(captured,{
    visibleBars:100,verticalZoom:2,autoPriceScale:false,rightGapBars:12,
  });
  const auto = captureVisualProfile(base,800,{
    barWidth:10,rightOffset:15,autoY:true,manualRange:null,yZoom:1.3,
  });
  assert.equal(auto.verticalZoom,1.3);
  assert.equal(auto.visibleBars,80);
  assert.ok(!('manualCenter' in captured));
  assert.ok(!('price' in captured));
});

test('Graph tab uses existing personal settings persistence and preview without market fetch', () => {
  const prefs = normalizeOriginalHookChartPreferences({
    visualProfiles:patchVisualProfile(undefined,'formationsFull:mobile',{visibleBars:140}),
  });
  assert.equal(prefs.visualProfiles?.['formationsFull:mobile']?.visibleBars,140);
  const html = renderToStaticMarkup(React.createElement(OriginalHookChartSettings,{
    open:true,embedded:true,prefs,onChange:()=>{},onApplyStrategy:()=>{},onClose:()=>{},
  }));
  assert.match(html, />Графік<\/button>/);
  const settings = src('../src/components/hookchart/OriginalHookChartSettings.tsx');
  assert.match(settings,/Візуальні налаштування/);
  assert.match(settings,/Зберегти поточний вигляд графіка/);
  assert.match(settings,/Скинути цей профіль/);
  assert.match(settings,/Вертикальний зум/);
  assert.match(settings,/Кількість видимих свічок/);
  assert.match(settings,/Автоматичний масштаб ціни/);
  assert.match(settings,/Відступ праворуч/);
  assert.doesNotMatch(settings.slice(settings.indexOf('function VisualProfileEditor'),settings.indexOf('export function OriginalHookChartSettings')),/fetch\(|WebSocket|setInterval/);
});

test('Screener, Formations, Terminal carry visual contexts, Replay passes none', () => {
  const canvas = src('../src/components/hookchart/HookChartCanvas.tsx');
  const engine = src('../src/components/hookchart/engine.tsx');
  const trading = src('../src/components/TradingViewChart.tsx');
  const fullscreen = src('../src/components/FullscreenChartModal.tsx');
  const formation = src('../src/components/FormationCard.tsx');
  const early = src('../src/components/EarlyFormationCard.tsx');
  const terminal = src('../src/components/terminal/TerminalChartWidget.tsx');
  const terminalPage = src('../src/components/TerminalPage.tsx');
  const replay = src('../src/components/replay/ReplayChart.tsx');
  assert.match(canvas,/const activeVisualProfile = replay \|\| !settings\.visualProfiles\?\.\[activeVisualKey\]/);
  assert.match(canvas,/const rightPaddingBars = terminalMode && terminalAutoScale/);
  assert.match(canvas,/activeVisualProfile\?\.rightGapBars \?\? 8/);
  assert.match(canvas,/: activeVisualProfile \? 0 : terminalMode \? 8/);
  assert.match(canvas,/onResetVisual=\{key =>/);
  assert.match(canvas,/visualProfileKey=\{replay \? undefined : activeVisualKey\}/);
  assert.match(canvas,/visualContextForTerminalWidth/);
  assert.match(engine,/if\(!visualProfile\|\|!visualProfileKey\|\|initialLogicalRange\|\|!candles\.length\)return/);
  assert.match(engine,/visualAppliedRef\.current===signature/);
  assert.match(engine,/if\(!terminalMode\|\|visualProfile\|\|!candles\.length/);
  assert.match(formation,/visualContext="formationsQuick"/);
  assert.match(early,/visualContext="formationsQuick"/);
  assert.match(fullscreen,/visualContext=\{visualContext \?\? \(formation \|\| earlyCandidate \? 'formationsFull' : 'screenerFull'\)\}/);
  assert.match(trading,/visualContext=\{visualContext\}/);
  assert.match(terminal,/terminalMode=\{useIntegratedHookChartToolbar\}/);
  assert.match(terminalPage, /<ExchangeCandlestickChart\s+visualContext="terminalLarge"\s+symbol=\{activeCoin\.symbol\}/);
  assert.match(src('../src/components/ExchangeCandlestickChart.tsx'),/visualContext=\{visualContext\}/);
  assert.match(src('../src/components/TradingViewChart.tsx'),/visualContext=\{visualContext\}/);
  assert.doesNotMatch(replay,/visualContext=|visualProfiles/);
});
