import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { captureChartPageBackdrop } from '../src/utils/chartPageBackdrop';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('chart background is an inert detached DOM snapshot, not a mounted copy of the Screener', () => {
  const dom = new JSDOM(`<!doctype html><div id="root"><div class="min-h-screen">
    <header class="app-header"><button id="tab">Скрінер</button></header>
    <main class="screener-content"><section id="coins">
      <button id="btc">BTCUSDT</button><span>Об’єм</span>
      <input type="password" value="sensitive" />
      <input type="text" value="secret search" />
      <iframe src="https://example.com/embed"></iframe>
      <video autoplay src="https://example.com/video"></video>
      <canvas width="500"></canvas>
    </section></main><footer>© h00k</footer>
  </div></div>`, {url: 'http://localhost/#screener'});
  const original = {
    window: (globalThis as any).window,
    HTMLElement: (globalThis as any).HTMLElement,
    HTMLInputElement: (globalThis as any).HTMLInputElement,
    HTMLTextAreaElement: (globalThis as any).HTMLTextAreaElement,
  };
  Object.assign(globalThis, {
    window: dom.window,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  });
  const proto = dom.window.HTMLElement.prototype;
  const oldRect = proto.getBoundingClientRect;
  proto.getBoundingClientRect = () => ({
    x:0, y:0, left:0, top:0, width:600, height:750, right:600, bottom:750,
    toJSON(){return {}},
  });
  try {
    const root = dom.window.document.querySelector('#root > div') as HTMLElement;
    let clicked = 0;
    root.querySelector('#btc')!.addEventListener('click', () => clicked++);
    const snapshot = captureChartPageBackdrop(root)!;
    assert.ok(snapshot);
    assert.notEqual(snapshot, root);
    assert.equal(snapshot.isConnected, false, 'snapshot remains detached until routed chart renders');
    assert.equal(snapshot.inert, true);
    assert.match(snapshot.textContent || '', /BTCUSDT/);
    assert.match(snapshot.textContent || '', /Скрінер/);
    assert.equal(snapshot.querySelector('iframe,video,canvas,script,object,embed'), null);
    assert.equal(snapshot.querySelector('[id]'), null);
    assert.ok([...snapshot.querySelectorAll('input')].every(input => input.value === ''));
    assert.ok([...snapshot.querySelectorAll('input')].every(input => !input.hasAttribute('value')));
    snapshot.querySelector('#btc')?.dispatchEvent(new dom.window.Event('click', {bubbles: true}));
    assert.equal(clicked,0,'native event listener from live Screener must not be copied');
    dom.window.document.body.appendChild(snapshot);
    assert.equal(snapshot.isConnected, true);
    assert.equal(root.isConnected,true,'capturing must not mutate or unmount the original page');
    assert.equal(root.querySelector('iframe')?.getAttribute('src'), 'https://example.com/embed');
    assert.equal(root.querySelector('input[type=password]')?.getAttribute('value'), 'sensitive');
  } finally {
    proto.getBoundingClientRect = oldRect;
    Object.assign(globalThis, original);
    dom.window.close();
  }
});

test('large DOM and offscreen content fail closed instead of adding heavy chart background work', () => {
  const dom = new JSDOM('<!doctype html><div id="root"><div><main></main></div></div>', {url:'http://localhost/'});
  const previousWindow=(globalThis as any).window;
  const previousHTMLElement=(globalThis as any).HTMLElement;
  (globalThis as any).window=dom.window;
  (globalThis as any).HTMLElement=dom.window.HTMLElement;
  const proto=dom.window.HTMLElement.prototype;
  const oldRect=proto.getBoundingClientRect;
  proto.getBoundingClientRect=()=>({left:0,right:640,top:0,bottom:800,width:640,height:800} as DOMRect);
  try {
    const root=dom.window.document.querySelector('#root > div') as HTMLElement;
    assert.ok(captureChartPageBackdrop(root));
    const fragment=dom.window.document.createDocumentFragment();
    for(let i=0;i<9100;i++) fragment.appendChild(dom.window.document.createElement('span'));
    root.querySelector('main')!.appendChild(fragment);
    assert.equal(captureChartPageBackdrop(root), null,'too many DOM nodes: use inert gradient fallback');
  } finally {
    proto.getBoundingClientRect=oldRect;
    (globalThis as any).window=previousWindow;
    (globalThis as any).HTMLElement=previousHTMLElement;
    dom.window.close();
  }
});

test('routed chart shows backdrop behind a readable opaque HookChart and unmounts the original page', () => {
  const app=source('../src/App.tsx');
  const details=source('../src/components/FormationDetailsModal.tsx');
  const full=source('../src/components/FullscreenChartModal.tsx');
  const css=source('../src/index.css');
  assert.match(app, /captureChartPageBackdrop\(/);
  assert.match(app, /chartPageActive && <div ref=\{attachChartBackdrop\}/);
  assert.match(app, /data-chart-page-backdrop="static"/);
  assert.match(app, /relative z-10 w-full min-w-0 flex-1/);
  assert.match(app, /chartBackdropSnapshotRef\.current = null/);
  assert.match(app, /\{chartPageActive \? \(/, 'previous page must remain unmounted while chart route is active');
  assert.match(details, /pageMode\s*\? 'relative w-full min-h-0 bg-transparent/);
  assert.match(full, /pageMode\s*\? 'relative flex w-full min-h-\[100dvh\] flex-col bg-transparent/);
  assert.match(full, /overflow-hidden bg-\[#090d16\]/,'the actual chart area remains opaque for legibility');
  assert.match(css, /\.chart-page-backdrop__frozen\s*\{/);
  assert.match(css, /\.chart-page-backdrop__frozen \*,/);
  assert.match(css, /animation:none!important/);
  assert.match(css, /pointer-events:none!important/);
  assert.match(css, /\.chart-page-backdrop::after/);
});
