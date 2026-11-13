'use strict';
const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');
const { dockRects, floatingRects } = require('./layout.cjs');
const { PROVIDERS, PANELS, normalizeSettings, normalizeProfile, matchesTerminal, availablePanels } = require('./profiles.cjs');

const WEBSITE = 'https://h00k.top/';
const LABELS = { metascalp: 'MetaScalp', tiger: 'Tiger.Trade', vataga: 'Vataga' };
let settingsWindow = null;
let settings = normalizeSettings();
let statePath = '';
let agent = null;
let quitting = false;
let detected = [];
let manualTargets = new Map(); // handle choices last only for this run
let manualAttached = new Set();
let windows = new Map(); // provider -> Map(panel -> BrowserWindow)
let previousSnapshots = '';
let lastDockStatus = {};
let standalone = null;

function loadSettings() {
  statePath = path.join(app.getPath('userData'), 'smartdock.json');
  try { settings = normalizeSettings(JSON.parse(fs.readFileSync(statePath, 'utf8'))); }
  catch { settings = normalizeSettings(); }
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const temp = statePath + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(settings, null, 2), { mode: 0o600 });
    fs.renameSync(temp, statePath);
  } catch (err) {
    console.error('Cannot persist Smart Dock settings:', err.message);
  }
}
function isTrustedWebURL(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'h00k.top' && !u.username && !u.password; }
  catch { return false; }
}
function webURL(id) {
  if (id === 'full') return WEBSITE;
  const panel = PANELS.find(x => x.id === id);
  if (!panel) throw new Error('Unknown panel');
  const url = new URL(WEBSITE);
  url.searchParams.set('desktopPanel', id);
  url.hash = panel.hash;
  return url.href;
}
function guardWebsite(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedWebURL(url)) {
      event.preventDefault();
      if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    }
  });
}
function makeContentWindow(provider, id) {
  const win = new BrowserWindow({
    title: 'h00k • ' + LABELS[provider] + ' • ' + (id === 'full' ? 'Desktop' : PANELS.find(x=>x.id===id)?.name),
    x: 100, y: 100, width: 480, height: 470,
    minWidth: 200, minHeight: 140, show: false, backgroundColor: '#070a12',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, partition: 'persist:h00k',
    },
  });
  guardWebsite(win);
  win.loadURL(webURL(id)).catch(err => console.warn('h00k load error:', err.message));
  win.on('closed', () => {
    const collection = windows.get(provider);
    if (collection?.get(id) === win) collection.delete(id);
  });
  return win;
}
function createSettingsWindow() {
  settingsWindow = new BrowserWindow({
    title: 'h00k Desktop • Smart Dock', width: 740, height: 810, minWidth: 550, minHeight: 590,
    backgroundColor: '#070a12', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false,
      contextIsolation: true, sandbox: true,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}
function candidateWindows() {
  // Only native OS window metadata is exposed to the local settings panel.
  return detected.filter(item => item.width >= 140 && item.height >= 80
    && !/^(?:h00k desktop|electron)$/i.test(item.exe));
}
function findTarget(provider) {
  const all = candidateWindows();
  const manualId = manualTargets.get(provider);
  const explicit = all.find(item => item.id === manualId);
  if (explicit) return explicit;
  const hint = settings.profiles[provider].targetHint;
  if (hint) {
    const selected = all.find(item => item.exe === hint.exe && item.title === hint.title);
    if (selected) return selected;
  }
  return all.filter(item => matchesTerminal(provider, item))
    .sort((a,b) => (b.width*b.height)-(a.width*a.height))[0] || null;
}
function externalRect(item) {
  // The Win32 agent reports physical pixels. Electron expects DIP coordinates.
  const topLeft = screen.screenToDipPoint({ x: item.left, y: item.top });
  const bottomRight = screen.screenToDipPoint({ x: item.left+item.width, y: item.top+item.height });
  return {
    x: topLeft.x, y: topLeft.y,
    width: Math.max(1,bottomRight.x-topLeft.x), height: Math.max(1,bottomRight.y-topLeft.y),
  };
}
function ensureContentWindows(provider, ids) {
  let group = windows.get(provider);
  if (!group) { group = new Map(); windows.set(provider,group); }
  for (const [id,win] of group) if (!ids.includes(id)) { group.delete(id); if(!win.isDestroyed())win.destroy(); }
  for (const id of ids) if (!group.has(id) || group.get(id).isDestroyed()) group.set(id,makeContentWindow(provider,id));
  return group;
}
function closeProvider(provider) {
  const group = windows.get(provider);
  if (!group) return;
  for (const win of group.values()) if (!win.isDestroyed()) win.destroy();
  windows.delete(provider);
}
function applyBounds(win, bounds, alwaysOnTop) {
  if (win.isDestroyed()) return;
  const old = win.getBounds();
  if (old.x !== bounds.x || old.y !== bounds.y || old.width !== bounds.width || old.height !== bounds.height)
    win.setBounds(bounds, false);
  if (win.isAlwaysOnTop() !== alwaysOnTop) win.setAlwaysOnTop(alwaysOnTop);
  if (!win.isVisible()) win.showInactive();
}
function syncWindows() {
  for (const provider of PROVIDERS) {
    const profile = settings.profiles[provider];
    const ready = profile.enabled && (profile.autoAttach || manualAttached.has(provider));
    const target = findTarget(provider);
    if (!ready) { closeProvider(provider); lastDockStatus[provider] = 'Вимкнено'; continue; }
    if (!target) {
      // Keep detached full windows open if the terminal closes; never pretend they are docked.
      const group = windows.get(provider);
      if (group) for (const win of group.values()) if (!win.isDestroyed() && profile.mode !== 'floating') win.hide();
      lastDockStatus[provider] = 'Термінал не знайдено';
      continue;
    }
    if (target.minimized && profile.mode !== 'floating') {
      const group = windows.get(provider);
      if (group) for (const win of group.values()) if (!win.isDestroyed()) win.hide();
      lastDockStatus[provider] = 'Термінал згорнуто';
      continue;
    }
    const ids = availablePanels(profile);
    const group = ensureContentWindows(provider, ids);
    const rect = externalRect(target);
    const work = screen.getDisplayMatching(rect).workArea;
    const boxes = profile.mode === 'floating'
      ? floatingRects(rect, work, profile.width, profile.height, ids.length)
      : dockRects(rect, work, profile.side, profile.width, profile.height, ids.length);
    if (boxes.length !== ids.length) {
      // Never cover the terminal's order-entry controls just to make room.
      for(const win of group.values()) if(!win.isDestroyed()) win.hide();
      lastDockStatus[provider] = 'Замало місця з вибраного боку; змініть сторону або розмір';
      continue;
    }
    ids.forEach((id,index) => {
      const win = group.get(id);
      if (!win || win.isDestroyed()) return;
      if (profile.mode === 'floating' && win.isVisible() && !profile.follow) {
        if(win.isAlwaysOnTop() !== profile.alwaysOnTop)win.setAlwaysOnTop(profile.alwaysOnTop);
        return; // manual drag is respected
      }
      applyBounds(win,boxes[index],profile.alwaysOnTop);
    });
    lastDockStatus[provider] = profile.mode === 'floating' ? 'Плаваючі панелі' : 'Прикріплено до ' + target.title;
  }
}
function snapshot() {
  return {
    settings, terminals: PROVIDERS.map(provider=>({
      id:provider, label:LABELS[provider],
      target:findTarget(provider), status:lastDockStatus[provider] || 'Очікування',
    })),
    windows:candidateWindows().map(item=>({
      id:item.id, exe:item.exe, title:item.title, minimized:item.minimized, width:item.width, height:item.height,
    })),
  };
}
function pushSnapshot() {
  if (!settingsWindow || settingsWindow.isDestroyed() || settingsWindow.webContents.isLoading()) return;
  const data = snapshot();
  const key = JSON.stringify(data);
  if (key === previousSnapshots) return;
  previousSnapshots = key;
  settingsWindow.webContents.send('desktop:snapshot-pushed',data);
}
function acceptWindows(rows) {
  if (!Array.isArray(rows)) return;
  detected = rows.filter(item => item && typeof item.id === 'string'
    && typeof item.exe === 'string' && typeof item.title === 'string'
    && [item.left,item.top,item.width,item.height].every(Number.isFinite))
    .slice(0,300);
  syncWindows(); pushSnapshot();
}
function runAgent() {
  if (process.platform !== 'win32' || quitting) return;
  const script = app.isPackaged
    ? path.join(process.resourcesPath,'win-agent.ps1')
    : path.join(__dirname,'win-agent.ps1');
  const child = spawn('powershell.exe',[
    '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,
  ],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  agent = child;
  const reader = readline.createInterface({input:child.stdout});
  reader.on('line',line => {
    try { acceptWindows(JSON.parse(line)); } catch { /* diagnostic output is not window JSON */ }
  });
  child.stderr.on('data',chunk => console.warn('Windows window-agent:',String(chunk).slice(0,400)));
  child.on('error',err => console.warn('Cannot start window-agent:',err.message));
  child.on('close',() => {
    if (agent === child) agent = null;
    if (!quitting) setTimeout(runAgent,3000);
  });
}
function verifySettingsSender(event) {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) throw new Error('Untrusted IPC sender');
}
function registerIpc() {
  ipcMain.handle('desktop:snapshot',event => { verifySettingsSender(event); return snapshot(); });
  ipcMain.handle('desktop:save',(event,provider,patch) => {
    verifySettingsSender(event);
    if (!PROVIDERS.includes(provider) || !patch || typeof patch !== 'object') throw new Error('Invalid profile');
    const previous = settings.profiles[provider];
    const update = normalizeProfile(provider,{...previous,...patch});
    // Floating panels are manually draggable by default.
    if (previous.mode !== 'floating' && update.mode === 'floating' && !Object.hasOwn(patch,'follow')) update.follow = false;
    settings.profiles[provider] = update;
    saveSettings(); syncWindows(); pushSnapshot();
    return snapshot();
  });
  ipcMain.handle('desktop:pick',(event,provider,id) => {
    verifySettingsSender(event);
    if (!PROVIDERS.includes(provider)) throw new Error('Invalid terminal');
    const target = candidateWindows().find(item => item.id === id);
    if (!target) throw new Error('Window not found');
    manualTargets.set(provider,id);
    settings.profiles[provider].targetHint = {exe:target.exe,title:target.title};
    saveSettings(); syncWindows(); pushSnapshot(); return snapshot();
  });
  ipcMain.handle('desktop:attach',(event,provider) => {
    verifySettingsSender(event);
    if (!PROVIDERS.includes(provider)) throw new Error('Invalid terminal');
    settings.profiles[provider].enabled = true;
    manualAttached.add(provider);
    saveSettings(); syncWindows(); pushSnapshot(); return snapshot();
  });
  ipcMain.handle('desktop:detach',(event,provider) => {
    verifySettingsSender(event);
    if (!PROVIDERS.includes(provider)) throw new Error('Invalid terminal');
    settings.profiles[provider].enabled = false;
    manualAttached.delete(provider);
    closeProvider(provider); saveSettings(); pushSnapshot(); return snapshot();
  });
  ipcMain.handle('desktop:standalone',event => {
    verifySettingsSender(event);
    if (!standalone || standalone.isDestroyed()) {
      standalone = new BrowserWindow({
        title:'h00k.top', width:1280,height:850,minWidth:400,minHeight:300,
        backgroundColor:'#070a12',autoHideMenuBar:true,
        webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,
          partition:'persist:h00k',webSecurity:true},
      });
      guardWebsite(standalone);
      standalone.loadURL(WEBSITE).catch(err=>console.warn('h00k load error:',err.message));
      standalone.on('closed',()=>{standalone=null;});
    } else standalone.show();
    return true;
  });
}
if(!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',()=>{if(settingsWindow&&!settingsWindow.isDestroyed())settingsWindow.show();});
  app.whenReady().then(() => {
    loadSettings();registerIpc();createSettingsWindow();runAgent();
    settingsWindow.webContents.on('did-finish-load',pushSnapshot);
    if (process.platform !== 'win32') {
      for (const provider of PROVIDERS) lastDockStatus[provider] = 'Smart Dock підтримується лише у Windows';
    }
  });
  app.on('before-quit',()=>{quitting=true;if(agent){agent.kill();agent=null;}});
  app.on('window-all-closed',()=>app.quit());
}
