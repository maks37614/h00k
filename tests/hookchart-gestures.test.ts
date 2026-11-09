import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createChartTouchHold, isChartControlTarget } from '../src/components/hookchart/touchHold';

// Execute the real handlers without a browser so transitions between gestures
// are covered together, rather than testing only the individual timer/helper.
const source = readFileSync(new URL('../src/components/hookchart/engine.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('engine.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const chart = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'Chart')!;
const declarations = new Map<string, string>();
function collect(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
    declarations.set(node.name.text, node.initializer.getText(ast));
  ts.forEachChild(node, collect);
}
collect(chart);

function setup(overrides: Record<string, unknown> = {}) {
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const hold = createChartTouchHold({
    schedule(callback) { timers.set(++nextTimer, callback); return nextTimer; },
    cancel(id) { timers.delete(Number(id)); },
  });
  const captured = new Set<number>(), viewportUpdates: unknown[] = [];
  const owner = {
    setPointerCapture(id: number) { captured.add(id); },
    hasPointerCapture(id: number) { return captured.has(id); },
    releasePointerCapture(id: number) { captured.delete(id); },
  };
  const g = {r:{left:0,top:0,width:350,height:700},plotW:300,priceX:300,plotH:700,
    step:9,virtualStart:0,hi:110,lo:90,timeAtX:(x:number)=>x*1000,p:(y:number)=>110-y/35};
  const env: Record<string, any> = {
    ref:{current:{getBoundingClientRect:()=>g.r}},box:{current:owner},geom:{current:g},geometry:()=>g,
    isChartControlTarget,terminalMode:false,terminalNavigation:{current:false},transientRuler:true,
    transient:{current:null},touchHold:{current:hold},cancelTouchHold:()=>hold.cancel(),
    touchCursorVisible:{current:false},suppressTouchClick:{current:false},magnifierPointer:{current:null},
    mouseRef:{current:null},pointers:{current:new Map()},drag:{current:null},lastTap:{current:0},
    scheduleDraw:()=>{},editingDrawingId:null,drawings:[],draft:null,tool:'cursor',levelLabelMode:'always',timeMarkers:[],
    vp:{barWidth:9,rightOffset:0,autoY:true,manualCenter:null,manualRange:null},candles:[{t:0}],rightPaddingBars:0,rightPadding:0,
    setVp:(update:any)=>viewportUpdates.push(update(env.vp)),
    interactionRef:{current:{width:1,height:1}},interactionDrawRef:{current:()=>{}},
    lastCrosshair:{current:null},onCrosshairChange:()=>{},backgroundColor:'#131722',
    ...overrides,
  };
  const names=['point','zone','handlePointerDown','handlePointerMove','handlePointerUp','drawInteraction','draw'];
  if (declarations.has('resetInteraction')) names.push('resetInteraction');
  const factory = `exports.build = (env) => {const {${Object.keys(env).join(',')}} = env;
    ${names.map(name=>`const ${name} = ${declarations.get(name)};`).join('\n')}
    return {${names.join(',')}};};`;
  const compiled = ts.transpileModule(factory,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const exports:Record<string,any>={};new Function('exports',compiled)(exports);
  const handlers=exports.build(env);
  env.interactionDrawRef.current=handlers.drawInteraction;
  const event=(x:number,y:number,id=1,type='pointermove')=>({clientX:x,clientY:y,pointerId:id,pointerType:'touch',button:0,type,
    target:{closest:()=>null},currentTarget:owner,preventDefault(){}});
  const fireHold=()=>{const callbacks=[...timers.values()];timers.clear();callbacks.forEach(callback=>callback());};
  return {env,handlers,event,fireHold,captured,viewportUpdates,timers};
}

test('a second finger starts zoom even after a long hold has activated the screener ruler', () => {
  const t=setup();
  t.handlers.handlePointerDown(t.event(100,200));t.fireHold();
  assert.ok(t.env.transient.current);
  assert.equal(t.env.magnifierPointer.current,1);
  t.handlers.handlePointerDown(t.event(200,200,2));
  t.handlers.handlePointerMove(t.event(240,200,2));
  assert.equal(t.viewportUpdates.length,1,'the previous ruler must not consume pinch movement');
  assert.equal(t.env.transient.current,null);
  assert.equal(t.env.magnifierPointer.current,null);
  t.handlers.handlePointerUp(t.event(240,200,2,'pointerup'));
  t.handlers.handlePointerMove(t.event(130,220));
  assert.equal(t.viewportUpdates.length,2,'the remaining finger must resume panning');
  t.handlers.handlePointerUp(t.event(130,220,1,'pointerup'));
  assert.equal(t.captured.size,0);
});

test('a chart waiting for candles cannot inspect cached data from the previous coin', () => {
  const t=setup({candles:[]});
  t.handlers.handlePointerDown(t.event(100,200));t.fireHold();
  assert.equal(t.captured.size,0);
  assert.equal(t.env.magnifierPointer.current,null);
  assert.equal(t.env.mouseRef.current,null);
  assert.equal(t.timers.size,0);
});

test('losing candle data clears the old chart, held lens and selected date immediately', () => {
  const fills:unknown[][]=[],positions:unknown[]=[];
  const main={width:700,height:1400,getContext:()=>({setTransform(){},fillRect(...args:unknown[]){fills.push(args);}})};
  const layer={width:700,height:1400};
  const t=setup({candles:[],geometry:()=>null,ref:{current:main},interactionRef:{current:layer},
    lastCrosshair:{current:{x:100,time:1234}},onCrosshairChange:(position:unknown)=>positions.push(position)});
  t.env.mouseRef.current={x:100,y:200};t.env.transient.current={t:1,p:100};
  t.env.magnifierPointer.current=1;t.env.pointers.current.set(1,{x:100,y:200});t.captured.add(1);
  t.env.touchHold.current.start(1,{x:100,y:200},()=>assert.fail('stale hold activated'));
  t.handlers.draw();t.fireHold();
  assert.deepEqual(fills,[[0,0,700,1400]]);
  assert.equal(t.env.geom.current,null);
  assert.equal(t.env.mouseRef.current,null);
  assert.equal(t.env.magnifierPointer.current,null);
  assert.equal(t.env.transient.current,null);
  assert.equal(t.captured.size,0);
  assert.deepEqual(layer,{width:1,height:1});
  assert.deepEqual(positions,[null]);
});

test('changing chart identity cancels pending or active inspection and accepts a fresh hold', () => {
  for(const activate of [false,true]) {
    const t=setup();
    t.handlers.handlePointerDown(t.event(100,200));
    if(activate)t.fireHold();
    t.handlers.resetInteraction();t.fireHold();
    assert.equal(t.env.magnifierPointer.current,null);
    assert.equal(t.env.transient.current,null);
    assert.equal(t.env.mouseRef.current,null);
    assert.equal(t.env.drag.current,null);
    assert.equal(t.env.touchCursorVisible.current,false);
    assert.equal(t.env.suppressTouchClick.current,false);
    assert.equal(t.env.geom.current,null);
    assert.equal(t.env.pointers.current.size,0);
    assert.equal(t.captured.size,0);
    assert.equal(t.timers.size,0);
    t.handlers.handlePointerDown(t.event(180,300,2));
    assert.equal(t.env.magnifierPointer.current,null);
    t.fireHold();assert.equal(t.env.magnifierPointer.current,2);
  }
});
