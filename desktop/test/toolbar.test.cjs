'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('gear button remains a local HTML view with a working click handler', () => {
  const html = read('toolbar.html');
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script, 'inline handler exists');
  assert.doesNotThrow(() => new vm.Script(script[1], { filename: 'desktop/toolbar.html' }));
  assert.match(html, /id="dock"/);
  assert.match(html, /Налаштування прикріплення/);
  const preload = read('toolbar-preload.cjs');
  assert.match(preload, /contextBridge\.exposeInMainWorld/);
  assert.match(preload, /ipcRenderer\.send\('desktop:toolbar-menu'\)/);
  assert.doesNotMatch(preload, /desktop:save|desktop:pick|desktop:attach/);
});

test('remote h00k site is sandboxed and cannot access the toolbar IPC', () => {
  const main = read('main.cjs');
  const start = main.indexOf('function makeContentWindow(');
  const end = main.indexOf('function createSettingsWindow(');
  const contentWindow = main.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(contentWindow, /nodeIntegration: false, contextIsolation: true, sandbox: true/);
  const site = contentWindow.slice(contentWindow.indexOf('const site = new WebContentsView('),contentWindow.indexOf('site.setBackgroundColor('));
  assert.doesNotMatch(site, /preload:/);
  assert.match(main, /const owner = toolbarOwners\.get\(event\.sender\.id\)/);
  assert.match(main, /ipcMain\.on\('desktop:toolbar-menu', openToolbarMenu\)/);
});

test('all dock layout options are available from local native menu', () => {
  const main = read('main.cjs');
  for (const text of ['Праворуч', 'Ліворуч', 'Зверху', 'Знизу',
    'Увесь h00k', 'Вибрані блоки', 'Плаваючі вікна', 'Відкріпити']) {
    assert.ok(main.includes(text), 'Missing quick action: ' + text);
  }
  assert.match(main, /frame: false/); // dock seam unchanged; floating uses local titlebar
  assert.match(main, /hasShadow: mode === 'floating'/);
  assert.match(main, /toolbarOwners\.delete\(toolbarId\)/);
  assert.match(main, /openSettingsWindow\(provider\)/);
});

test('Win32 agent uses visible DWM bounds and faster tracking snapshots', () => {
  const agent = read('win-agent.ps1');
  assert.match(agent, /DwmGetWindowAttribute\(hwnd, 9/);
  assert.match(agent, /GetWindowRect\(hwnd/);
  assert.match(agent, /Start-Sleep -Milliseconds 160/);
});

test('independent full h00k window gets the same isolated settings gear', () => {
  const main = read('main.cjs');
  assert.match(main, /openStandaloneWindow\(\)/);
  assert.match(main, /if \(!provider\) \{/);
  assert.match(main, /PROVIDERS\.map\(id =>/);
  assert.match(main, /settings\.setupComplete && profile\.enabled/);
});

test('quick menu exposes auto-attach, follow and always-on-top toggles', () => {
  const main = read('main.cjs');
  for (const option of ['Прикріплювати автоматично', 'Слідувати за вікном',
    'Завжди поверх інших вікон']) assert.ok(main.includes(option));
  for (const field of ['autoAttach', 'follow', 'alwaysOnTop']) {
    assert.ok(main.includes(field + ': !profile.' + field));
  }
});

test('local shell is the sole owner of window control IPC', () => {
  const main = read('main.cjs'), preload = read('window-shell-preload.cjs');
  assert.match(main, /event\.sender !== owner\.win\.webContents/);
  assert.match(main, /ipcMain\.on\('desktop:shell-command'/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\('h00kShell'/);
  assert.doesNotMatch(preload, /desktop:save|desktop:pick|desktop:attach/);
});

test('floating panels use branded shell without covering remote site or adding remote IPC', () => {
  const main = read('main.cjs');
  assert.match(main,/registerShell\(win, provider\)/);
  assert.match(main,/showProviderMenu\(win, provider\)/);
  assert.match(main,/win\.__remoteContents = site\.webContents/);
  assert.match(main,/win\.loadFile\(path\.join\(__dirname, 'window-shell\.html'\)/);
  assert.match(main,/\(win\.__remoteContents \|\| win\.webContents\)\.loadURL/);
  assert.match(main,/site\.setBounds\(\{ x: 0, y: SHELL_HEIGHT/);
  assert.match(main,/if \(win\.__remoteContents\) win\.__remoteContents\.on\('before-input-event'/);
});

test('main h00k gear provides attach/detach, side, mode and immediate terminal preferences', () => {
  const main = read('main.cjs');
  const a = main.indexOf('function showStandaloneMenu(');
  const b = main.indexOf('function openStandaloneWindow(');
  const menu = main.slice(a,b);
  for (const item of ['Прикріпити зараз','Відкріпити','Розташування','Режим',
                      'Автоматичне прикріплення','Слідувати за терміналом',
                      'Поверх інших вікон','Повні налаштування']) {
    assert.ok(menu.includes(item),'Missing main gear action: '+item);
  }
  assert.match(menu,/manualAttached\.add\(id\)/);
  assert.match(menu,/manualAttached\.delete\(id\)/);
  assert.match(menu,/patchQuickProfile\(id, \{ side \}\)/);
  assert.match(menu,/patchQuickProfile\(id, \{ mode,/);
});
