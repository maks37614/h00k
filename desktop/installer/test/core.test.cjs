'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const core=require('../install-core.cjs');

test('only a validated Windows local folder can be passed to NSIS',()=>{
  assert.equal(core.validateInstallPath('C:\\Users\\Trader\\AppData\\Local\\Programs\\h00k Desktop','win32'),
    'C:\\Users\\Trader\\AppData\\Local\\Programs\\h00k Desktop');
  for(const value of ['C:\\','C:\\Windows','C:\\Users','\\\\server\\share\\setup',
    'D:relative','C:\\Fake"\n/S','']) {
    assert.throws(()=>core.validateInstallPath(value,'win32'),value);
  }
  assert.throws(()=>core.validateInstallPath('/tmp/h00k','linux'));
});
test('NSIS install destination is always the last raw argument',()=>{
  const args=core.buildInstallArgs({folder:'C:\\Users\\John Doe\\AppData\\Local\\h00k',language:'uk',shortcut:false});
  assert.deepEqual(args,['/S','/H00K_LANG=uk','/NO_DESKTOP_SHORTCUT','/D=C:\\Users\\John Doe\\AppData\\Local\\h00k']);
  assert.deepEqual(core.buildInstallArgs({folder:'D:\\Apps\\h00k',language:'??',shortcut:true}),
    ['/S','/H00K_LANG=en','/DESKTOP_SHORTCUT','/D=D:\\Apps\\h00k']);
});
test('reported progress is based on observed bytes, never elapsed time',()=>{
  assert.equal(core.observedPercent(0,100),0);
  assert.equal(core.observedPercent(20,100),20);
  assert.equal(core.observedPercent(100,100),96);
  assert.equal(core.observedPercent(200,100),96);
  assert.equal(core.observedPercent(50,0),0);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'h00k-setup-test-'));
  try{
    const started=Date.now();
    fs.mkdirSync(path.join(root,'resources'));
    fs.writeFileSync(path.join(root,'h00k Desktop.exe'),Buffer.alloc(4096));
    fs.writeFileSync(path.join(root,'resources','app.asar'),Buffer.alloc(8192));
    // NSIS may preserve a source archive's old modification timestamp;
    // a newly extracted file still counts as real disk activity.
    const oldTime=new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(path.join(root,'resources','app.asar'),oldTime,oldTime);
    const actual=core.folderScan(root,started);
    assert.equal(actual.files,2);
    assert.equal(actual.bytes,12288);
    const future=core.folderScan(root,started+120_000);
    assert.equal(future.bytes,0);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('UI uses genuine h00k eyes, moving legs and a separate guide page',()=>{
  const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
  const template=read('ui.template.html'),css=read('ui.css'),ui=read('ui.js'),main=read('main.cjs'),guide=read('guide.html');
  assert.match(template,/ROBOT_FACE_FROM_H00K_TOP/);
  assert.match(template,/class="leg leg-left"/);
  assert.match(template,/class="leg leg-right"/);
  assert.match(css,/@keyframes blink/);
  assert.match(css,/@keyframes step/);
  assert.match(ui,/pointermove/);
  assert.match(ui,/next>showProgress&&view==='installing'/);
  assert.match(main,/folderScan\(installedFolder,startedAt\)/);
  assert.match(main,/showGuide\(\)/);
  assert.match(guide,/guide\.js/);
  assert.match(template,/id="browse"/);
  assert.match(template,/id="shortcut"/);
  assert.match(main,/windowsVerbatimArguments:true/);
  assert.match(main,/shell:false/);
});
test('every setup and guide UI string is translated and English is first',()=>{
  const data=require('../locales.json');
  assert.deepEqual(Object.keys(data),['en','pl','ru','uk']);
  const keys=Object.keys(data.en);
  assert.ok(keys.length>=35);
  for(const language of Object.keys(data)){
    assert.deepEqual(Object.keys(data[language]),keys);
    for(const key of keys)assert.ok(data[language][key].trim(), language+'.'+key);
  }
  assert.match(fs.readFileSync(path.join(__dirname,'..','ui.js'),'utf8'),/language='en'/);
});
test('portable manifest is generated from an existing NSIS .exe and actual unpacked app',()=>{
  const prepare=fs.readFileSync(path.join(__dirname,'..','prepare.cjs'),'utf8');
  assert.match(prepare,/h00k Desktop Setup/);
  assert.match(prepare,/win-unpacked/);
  assert.match(prepare,/workerSha256/);
  assert.match(prepare,/h00k-robot-logo.svg/);
  assert.match(prepare,/expectedInstalledBytes/);
  assert.match(prepare,/guide.json/);
});

test('setup guide uses the same h00k robot artwork and styled window controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'guide.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'guide.css'), 'utf8');
  const logo = fs.readFileSync(path.join(__dirname, '..', 'h00k-logo.svg'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  const pkg = require('../package.json');
  assert.match(html, /class="native-titlebar"/);
  assert.match(html, /h00k-logo\.svg/);
  assert.match(css, /app-region:drag/);
  assert.match(logo, /robot-eye-blink/);
  assert.match(main, /titleBarStyle:'hidden'/);
  assert.ok(pkg.build.files.includes('h00k-logo.svg'));
});
