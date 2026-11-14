'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const mainPath = path.join(__dirname, '..', 'main.cjs');

function simulateDesktop(platform = process.platform) {
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
    loadURL(url){return this.webContents.loadURL(url);}
    loadFile(){return Promise.resolve();}
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
    app:{requestSingleInstanceLock(){return false;},quit(){},setAppUserModelId(){}},
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
      findTarget, candidateWindows, snapshot, runAgent, manualTargets,
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
    console, setTimeout, clearTimeout, URL, process:{platform,pid:process.pid},
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
  assert.equal(win.options.frame, false);
  assert.ok(win.__remoteContents);
  assert.equal(win.__remoteContents.urls.length, 1, 'floating website loaded in isolated view');
  assert.equal(win.webContents.urls.length, 0, 'local floating chrome is not a remote page');
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

test('always-on-top can be toggled for an independent floating pane without a running terminal',()=>{
  const {engine}=simulateDesktop();
  engine.setSettings({profiles:{metascalp:{
    enabled:true,mode:'floating',follow:false,widgets:['screener'],
  }}});
  engine.acceptWindows([]);
  const win=engine.getWindows().get('metascalp').get('screener');
  assert.equal(win.isAlwaysOnTop(),false);
  engine.patchQuickProfile('metascalp',{alwaysOnTop:true});
  assert.equal(win.isAlwaysOnTop(),true);
});

const tiger={id:'200',pid:433,exe:'Tiger.Trade',title:'Tiger.Trade Terminal',
  left:1000,top:80,width:420,height:220,minimized:false};
const vataga={id:'300',pid:434,exe:'Vataga',title:'Vataga Orderbook',
  left:100,top:580,width:500,height:280,minimized:false};
const metaCompact={...meta,id:'100',left:80,top:80,width:380,height:220};

test('auto-attachment runs independently for MetaScalp, Tiger.Trade and Vataga',()=>{
  const {engine}=simulateDesktop('win32');
  engine.setSettings({setupComplete:true,profiles:{
    metascalp:{enabled:true,autoAttach:true,mode:'full'},
    tiger:{enabled:true,autoAttach:true,mode:'full'},
    vataga:{enabled:true,autoAttach:true,mode:'full'},
  }});
  engine.acceptWindows([metaCompact,tiger,vataga]);
  for (const [provider,target] of [['metascalp',metaCompact],['tiger',tiger],['vataga',vataga]]) {
    const win=engine.getWindows().get(provider)?.get('full');
    assert.ok(win && win.isVisible(),provider+' is automatically docked');
    assert.equal(win.getBounds().x,target.left+target.width);
    assert.equal(win.webContents.urls.length,1,'site loaded exactly once for '+provider);
    assert.equal(engine.findTarget(provider)?.id,target.id);
  }
  // Removing Tiger should not disturb the other two provider workspaces.
  engine.acceptWindows([metaCompact,vataga]);
  const tigerWin=engine.getWindows().get('tiger').get('full');
  assert.equal(tigerWin.isVisible(),false);
  assert.equal(engine.getWindows().get('metascalp').get('full').isVisible(),true);
  assert.equal(engine.getWindows().get('vataga').get('full').isVisible(),true);
  engine.acceptWindows([metaCompact,tiger,vataga]);
  assert.equal(tigerWin.isVisible(),true);
  assert.equal(tigerWin.webContents.urls.length,1,'reconnecting terminal does not reload an already loaded website');
});

test('first-run onboarding and manual-only profiles do not auto-attach',()=>{
  const {engine}=simulateDesktop('win32');
  engine.setSettings({setupComplete:false,profiles:{
    metascalp:{enabled:true,autoAttach:true},tiger:{enabled:true,autoAttach:true},
  }});
  engine.acceptWindows([metaCompact,tiger]);
  assert.equal(engine.getWindows().size,0,'no attachment before initial setup is saved');
  engine.setSettings({setupComplete:true,profiles:{
    metascalp:{enabled:true,autoAttach:false},tiger:{enabled:false,autoAttach:true},
  }});
  engine.acceptWindows([metaCompact,tiger]);
  assert.equal(engine.getWindows().size,0,'manual attach and disabled profiles must not auto-attach');
  engine.patchQuickProfile('metascalp',{autoAttach:true});
  assert.ok(engine.getWindows().get('metascalp')?.get('full')?.isVisible());
  assert.equal(engine.getWindows().has('tiger'),false);
});

test('a reused HWND or ambiguous pinned terminal never switches to another instance',()=>{
  const {engine}=simulateDesktop('win32');
  engine.setSettings({setupComplete:true,profiles:{metascalp:{
    enabled:true,autoAttach:true,targetHint:{exe:'MetaScalp',title:'Chosen terminal'},
  }}});
  engine.manualTargets.set('metascalp','100');
  const other={...metaCompact,id:'101',title:'Other terminal'};
  const recycled={...metaCompact,id:'100',exe:'explorer',title:'Explorer'};
  const third={...metaCompact,id:'102',title:'Another terminal'};
  engine.acceptWindows([recycled,other,third]);
  assert.equal(engine.findTarget('metascalp'),null,'do not follow reused HWND into a different executable');
  assert.equal(engine.getWindows().has('metascalp'),false,'ambiguous pinned target remains hidden');
  engine.acceptWindows([recycled,other]);
  assert.equal(engine.findTarget('metascalp')?.id,'101','unambiguous same-exe recovery remains supported');
  assert.ok(engine.getWindows().get('metascalp')?.get('full')?.isVisible());
});

test('docked panels never overlap a different trading terminal window',()=>{
  const {engine}=simulateDesktop('win32');
  engine.setSettings({setupComplete:true,profiles:{
    metascalp:{enabled:true,autoAttach:true,mode:'full'},
    tiger:{enabled:true,autoAttach:true,mode:'full'},
  }});
  const first={...metaCompact,left:80,width:550,height:300};
  const second={...tiger,left:700,top:100,width:600,height:380};
  engine.acceptWindows([first,second]);
  assert.equal(engine.getWindows().has('metascalp'),false,'blocked panel would cover Tiger terminal');
  assert.match(engine.snapshot().terminals.find(x=>x.id==='metascalp').status,/перекриває інший термінал/);
  assert.ok(engine.getWindows().get('tiger')?.get('full')?.isVisible());
});

test('macOS and Linux do not start the Windows native discovery agent',()=>{
  for (const platform of ['darwin','linux']) {
    const {engine}=simulateDesktop(platform);
    assert.equal(engine.snapshot().nativeWindowAttachment,false);
    assert.doesNotThrow(()=>engine.runAgent());
    assert.equal(engine.getWindows().size,0);
  }
  assert.equal(simulateDesktop('win32').engine.snapshot().nativeWindowAttachment,true);
});
