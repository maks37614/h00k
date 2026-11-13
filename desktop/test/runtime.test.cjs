'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const mainPath = path.join(__dirname, '..', 'main.cjs');

function simulateDesktop() {
  const created = [];
  let nextWebId = 10;
  class FakeWebContents {
    constructor() { this.id = ++nextWebId; this.urls = []; this.callbacks = new Map(); this.closed = false; }
    setWindowOpenHandler() {}
    on(name, listener) { this.callbacks.set(name, listener); }
    loadFile() { return Promise.resolve(); }
    loadURL(url) { this.urls.push(url); return Promise.resolve(); }
    isDestroyed() { return this.closed; }
    isLoading() { return false; }
    close() { this.closed = true; }
  }
  class FakeWindow {
    constructor(options) {
      this.options = options; this.visible = !!options.show; this.dead = false;
      this.bounds = {x: options.x||0, y:options.y||0, width:options.width||480, height:options.height||470};
      this.events = new Map(); this.webContents = new FakeWebContents();
      this.contentView = { addChildView(){} }; this.top = false;
      created.push(this);
    }
    on(name, listener) { const list=this.events.get(name)||[];list.push(listener);this.events.set(name,list); }
    emit(name) { for(const callback of this.events.get(name)||[]) callback(); }
    isDestroyed(){return this.dead;}
    getBounds(){return {...this.bounds};}
    getContentBounds(){return {...this.bounds};}
    setBounds(bounds){this.bounds={...bounds};this.emit('moved');this.emit('resized');}
    isVisible(){return this.visible;}
    hide(){this.visible=false;}
    showInactive(){this.visible=true;}
    destroy(){this.dead=true;this.emit('closed');}
    isAlwaysOnTop(){return this.top;}
    setAlwaysOnTop(value){this.top=value;}
  }
  class FakeView {
    constructor(){this.webContents=new FakeWebContents();}
    setBackgroundColor(){}
    setBounds(){}
  }
  const electron={
    app:{requestSingleInstanceLock(){return false;},quit(){}},
    BrowserWindow:FakeWindow,WebContentsView:FakeView,Menu:{buildFromTemplate(){return {popup(){}};}},
    ipcMain:{},shell:{openExternal(){return Promise.resolve();}},
    screen:{
      screenToDipPoint:point=>point,
      getDisplayMatching:()=>({workArea:{x:0,y:0,width:1920,height:1080}}),
      getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1920,height:1080}}),
      getAllDisplays:()=>[{workArea:{x:0,y:0,width:1920,height:1080}}],
    },
  };
  const files=[];
  const source=fs.readFileSync(mainPath,'utf8')+String.raw`
    globalThis.__audit={
      setSettings(value){settings=normalizeSettings(value)},
      getSettings(){return settings},
      acceptWindows, syncWindows, closeProvider, patchQuickProfile,
      getWindows(){return windows},
    };
  `;
  const actualRequire=createRequire(mainPath);
  const sandbox={
    require:(id)=>{
      if(id==='electron')return electron;
      if(id==='node:fs')return {mkdirSync(){},writeFileSync(){},renameSync(){},readFileSync(){return '{}';}};
      return actualRequire(id);
    },
    __dirname:path.dirname(mainPath),__filename:mainPath,
    console, setTimeout, clearTimeout, URL, process,
  };
  vm.runInNewContext(source,sandbox,{filename:mainPath});
  return {engine:sandbox.__audit,created,files};
}
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const meta={id:'100',pid:432,exe:'MetaScalp',title:'MetaScalp Trading',
  left:250,top:160,width:800,height:610,minimized:false};
test('hidden/no-space terminal never loads a scanner page',()=>{
  const {engine,created}=simulateDesktop();
  engine.setSettings({profiles:{metascalp:{enabled:true,mode:'full',side:'right'}}});
  engine.acceptWindows([]);
  assert.equal(created.length,0);
  engine.acceptWindows([{...meta,left:0,top:0,width:1920,height:1080}]);
  assert.equal(created.length,0,'no h00k BrowserWindow allocated when screen has no space');
});
test('changing side with follow off repositions already visible docked pane',()=>{
  const {engine,created}=simulateDesktop();
  engine.setSettings({profiles:{metascalp:{enabled:true,mode:'full',follow:false,side:'right'}}});
  engine.acceptWindows([meta]);
  const win=engine.getWindows().get('metascalp').get('full');
  assert.ok(win && win.isVisible());
  assert.equal(win.getBounds().x,1050);
  assert.equal(win.webContents.urls.length,1);
  engine.acceptWindows([meta]);
  assert.equal(win.webContents.urls.length,1,'polling does not reload h00k');
  engine.patchQuickProfile('metascalp',{side:'left'});
  assert.equal(win.getBounds().x+win.getBounds().width,250);
  assert.equal(win.webContents.urls.length,1);
  assert.equal(created.filter(x=>!x.dead).length,1);
});
test('dragged floating pane is saved and restored after it is recreated',async()=>{
  const {engine}=simulateDesktop();
  engine.setSettings({profiles:{metascalp:{
    enabled:true,mode:'floating',side:'right',follow:false,widgets:['screener'],
  }}});
  engine.acceptWindows([meta]);
  const win=engine.getWindows().get('metascalp').get('screener');
  assert.ok(win && win.isVisible());
  await tick(370); // auto-layout move events must not count as user drag
  win.bounds={x:310,y:90,width:475,height:370};
  win.emit('moved');
  await tick(530); // user drag is persisted with a short debounce
  assert.equal(engine.getSettings().profiles.metascalp.floatingBounds.screener.x,310);
  engine.closeProvider('metascalp');
  engine.syncWindows();
  const restored=engine.getWindows().get('metascalp').get('screener');
  assert.notEqual(restored,win);
  assert.equal(restored.getBounds().x,310);
  assert.equal(restored.getBounds().width,475);
  engine.patchQuickProfile('metascalp',{side:'left'});
  assert.notEqual(restored.getBounds().x,310,'explicit side change overrides old position');
});
