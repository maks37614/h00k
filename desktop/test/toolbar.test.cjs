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
  assert.doesNotMatch(contentWindow, /preload:/);
  assert.match(main, /const owner = toolbarOwners\.get\(event\.sender\.id\)/);
  assert.match(main, /ipcMain\.on\('desktop:toolbar-menu', openToolbarMenu\)/);
});

test('all dock layout options are available from local native menu', () => {
  const main = read('main.cjs');
  for (const text of ['Праворуч', 'Ліворуч', 'Зверху', 'Знизу',
    'Увесь h00k', 'Вибрані блоки', 'Плаваючі вікна', 'Відкріпити']) {
    assert.ok(main.includes(text), 'Missing quick action: ' + text);
  }
  assert.match(main, /frame: mode === 'floating'/); // no native frame on the dock seam
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
  assert.match(main, /attachDockToolbar\(standalone, null\)/);
  assert.match(main, /if \(!provider\) \{/);
  assert.match(main, /PROVIDERS\.map\(id =>/);
  assert.match(main, /settings\.setupComplete && profile\.enabled/);
});
