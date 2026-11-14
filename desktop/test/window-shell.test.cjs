'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname,'..');
const read = p => fs.readFileSync(path.join(root,p),'utf8');

test('all local shell assets are shipped in Windows app',()=>{
  const files = require('../package.json').build.files;
  for(const f of ['window-shell.html','window-shell.css','window-shell.js','window-shell-preload.cjs','robot-logo.svg'])
    assert.ok(files.includes(f),'Missing packaged '+f);
});
test('standalone app uses separate trusted titlebar and remote web view',()=>{
  const m=read('main.cjs'), html=read('window-shell.html');
  assert.match(m,/frame: false, thickFrame: true, resizable: true/);
  assert.match(m,/site\.setBounds\(\{ x: 0, y: SHELL_HEIGHT, width, height: Math\.max\(0, height - SHELL_HEIGHT\) \}\)/);
  assert.match(m,/partition: 'persist:h00k'/);
  assert.match(m,/site\.webContents\.loadURL\(WEBSITE\)/);
  assert.match(m,/guardWebsite\(site\)/);
  assert.match(m,/site\.webContents\.on\('before-input-event', onSettingsShortcut\)/);
  assert.doesNotMatch(m.slice(m.indexOf('const site = new WebContentsView('),m.indexOf('site.setBackgroundColor(')),/preload:/);
  assert.match(html,/window-shell\.css/);
  assert.match(html,/robot-logo\.svg/);
  assert.match(html,/data-action="settings"/);
  for(const x of ['minimize','toggle-maximize','close'])assert.ok(html.includes('data-action="'+x+'"'));
  assert.match(read('window-shell.css'),/height:54px/);
});
test('window shell script parses and has no inline executable HTML handlers',()=>{
  assert.doesNotThrow(()=>new vm.Script(read('window-shell.js'),{filename:'window-shell.js'}));
  const html=read('window-shell.html');
  assert.match(html,/default-src 'none'/);
  assert.doesNotMatch(html,/onclick=/);
});
test('first launch config then later app launch; settings remain reachable by gear',()=>{
  const m=read('main.cjs');
  assert.match(m,/if \(settings\.setupComplete\) openStandaloneWindow\(\);\s*else createSettingsWindow\(\);/);
  assert.match(m,/if \(firstRun\) finishInitialSetup\(\)/);
  assert.match(m,/showStandaloneMenu\(win\)/);
  assert.match(m,/showProviderMenu\(win, provider\)/);
});

test('narrow floating h00k windows preserve the quick gear and window controls', () => {
  const css = read('window-shell.css');
  assert.match(css, /@media\(max-width:360px\)/);
  assert.match(css, /\.window-actions button\{width:30px/);
  assert.match(css, /\.desktop-title\{display:none\}/);
});
