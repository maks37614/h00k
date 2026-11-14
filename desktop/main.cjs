'use strict';
const { app, BrowserWindow, WebContentsView, Menu, ipcMain, screen, shell, nativeTheme } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');
const { dockRects, floatingRects } = require('./layout.cjs');
const { normalizeFloatingBounds, restoreFloatingBounds, floatingLayoutKey } = require('./workspace.cjs');
const { PROVIDERS, PANELS, normalizeSettings, normalizeProfile, matchesTerminal, availablePanels } = require('./profiles.cjs');

const WEBSITE = 'https://h00k.top/';
// Make the native Windows captions match the dark h00k desktop surfaces.
if (process.platform === 'win32' && nativeTheme) nativeTheme.themeSource = 'dark';
// Align Windows taskbar notifications and pinned shortcuts with the branded EXE.
if (process.platform === 'win32') app.setAppUserModelId('top.h00k.desktop');
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
const SHELL_HEIGHT = 54; // Local chrome never overlaps the remote website.
const toolbarOwners = new Map(); // local-only WebContentsView IDs, never exposed to h00k.top
const shellOwners = new Map(); // local titlebars for full and floating windows only
const lastLayoutKeys = new Map(); // detect explicit side/mode/size changes, even when follow is off
const hiddenProviders = new Map(); // reclaim hidden webviews after prolonged terminal absence
const HIDDEN_RECLAIM_MS = 30_000;

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
    console.error('Не вдалося зберегти налаштування h00k Desktop:', err.message);
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
  const contents = win.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isTrustedWebURL(url)) {
      event.preventDefault();
      if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    }
  });
}
function attachDockToolbar(win, provider) {
  // Local, privileged toolbar overlays the *unprivileged* h00k web page.
  // The remote h00k renderer has no preload and cannot invoke Desktop IPC.
  const toolbar = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'toolbar-preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true,
    },
  });
  toolbar.setBackgroundColor('#00000000');
  win.contentView.addChildView(toolbar);
  const place = () => {
    if (win.isDestroyed()) return;
    const width = win.getContentBounds().width;
    toolbar.setBounds({ x: Math.max(0, width - 47), y: 6, width: 41, height: 41 });
  };
  place();
  win.on('resize', place);
  toolbar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  toolbar.webContents.on('will-navigate', event => event.preventDefault());
  toolbar.webContents.loadFile(path.join(__dirname, 'toolbar.html'))
    .catch(error => console.error('h00k Desktop toolbar failed:', error.message));
  const toolbarId = toolbar.webContents.id;
  toolbarOwners.set(toolbarId, { win, provider });
  win.on('closed', () => {
    toolbarOwners.delete(toolbarId);
    if (!toolbar.webContents.isDestroyed()) toolbar.webContents.close();
  });
}

function registerShell(win, provider = null) {
  shellOwners.set(win.webContents.id, { win, provider });
  const publishState = () => {
    if (!win.isDestroyed() && !win.webContents.isLoading())
      win.webContents.send('desktop:window-state', { maximized: win.isMaximized() });
  };
  win.webContents.on('did-finish-load', publishState);
  win.on('maximize', publishState);
  win.on('unmaximize', publishState);
  win.on('closed', () => shellOwners.delete(win.webContents.id));
}

function makeContentWindow(provider, id, mode = 'full') {
  const win = new BrowserWindow({
    title: 'h00k • ' + LABELS[provider] + ' • ' + (id === 'full' ? 'Desktop' : PANELS.find(x=>x.id===id)?.name),
    x: 100, y: 100, width: 480, height: 470,
    minWidth: 200, minHeight: mode === 'floating' ? 230 : 140,
    show: false, backgroundColor: '#070d18',
    // Docked panels remain pixel-perfect and frameless; floating panels now
    // use the SAME local h00k titlebar as the full Desktop window.
    frame: false,
    hasShadow: mode === 'floating',
    thickFrame: mode === 'floating',
    roundedCorners: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: mode === 'floating' ? path.join(__dirname, 'window-shell-preload.cjs') : undefined,
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, partition: mode === 'floating' ? undefined : 'persist:h00k',
    },
  });
  win.__h00kMode = mode === 'floating' ? 'floating' : 'docked';
  win.__h00kUrl = webURL(id);
  win.__h00kLoaded = false; // Never load a scanner for a panel without display space.
  win.__nextLoadAt = 0;
  win.__autoPlacing = false;
  if (mode === 'floating') {
    const site = new WebContentsView({
      webPreferences: {
        partition: 'persist:h00k',
        nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      },
    });
    site.setBackgroundColor('#070d18');
    win.__remoteContents = site.webContents;
    win.contentView.addChildView(site);
    const placeSite = () => {
      if (win.isDestroyed()) return;
      const { width, height } = win.getContentBounds();
      site.setBounds({ x: 0, y: SHELL_HEIGHT, width, height: Math.max(0, height - SHELL_HEIGHT) });
    };
    placeSite();
    win.on('resize', placeSite);
    guardWebsite(site);
    registerShell(win, provider);
    win.loadFile(path.join(__dirname, 'window-shell.html'), { query: { provider: LABELS[provider] } })
      .catch(error => console.error('Floating h00k chrome error:', error.message));
    win.on('closed', () => {
      if (!site.webContents.isDestroyed()) site.webContents.close();
    });
  } else {
    guardWebsite(win);
    attachDockToolbar(win, provider);
  }
  let persistTimer = null;
  const persistManualBounds = () => {
    if (win.isDestroyed() || win.__autoPlacing || !win.isVisible()) return;
    const profile = settings.profiles[provider];
    if (profile.mode !== 'floating' || profile.follow || win.__h00kMode !== 'floating') return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      if (win.isDestroyed() || win.__autoPlacing) return;
      const active = settings.profiles[provider];
      if (active.mode !== 'floating' || active.follow) return;
      const bounds = normalizeFloatingBounds(win.getBounds());
      if (!bounds || !PANELS.some(panel => panel.id === id)) return;
      const previous = active.floatingBounds[id];
      if (previous && Object.keys(bounds).every(key => previous[key] === bounds[key])) return;
      active.floatingBounds[id] = bounds;
      saveSettings();
      pushSnapshot();
    }, 450);
  };
  win.on('moved', persistManualBounds);
  win.on('resized', persistManualBounds);
  win.on('closed', () => clearTimeout(persistTimer));
  const settingsHotkey = (event, input) => {
    if (input.type === 'keyDown' && (input.control || input.meta) && input.key === ',') {
      event.preventDefault();
      openSettingsWindow(provider);
    }
  };
  win.webContents.on('before-input-event', settingsHotkey);
  if (win.__remoteContents) win.__remoteContents.on('before-input-event', settingsHotkey);
  win.on('closed', () => {
    const collection = windows.get(provider);
    if (collection?.get(id) === win) collection.delete(id);
  });
  return win;
}
function createSettingsWindow() {
  settingsWindow = new BrowserWindow({
    title: 'h00k Desktop • Налаштування прикріплення', width: 780, height: 830, minWidth: 580, minHeight: 590,
    backgroundColor: '#070d18', autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b2131', symbolColor: '#67e8f9', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false,
      contextIsolation: true, sandbox: true,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.webContents.on('did-finish-load', () => {
    previousSnapshots = '';
    pushSnapshot();
  });
  settingsWindow.on('closed', () => { settingsWindow = null; });
}
function openSettingsWindow(provider) {
  if (!settingsWindow || settingsWindow.isDestroyed()) createSettingsWindow();
  const show = () => {
    if (!settingsWindow || settingsWindow.isDestroyed()) return;
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    if (PROVIDERS.includes(provider)) settingsWindow.webContents.send('desktop:select-provider', provider);
  };
  if (settingsWindow.webContents.isLoading()) settingsWindow.webContents.once('did-finish-load', show);
  else show();
}
function patchQuickProfile(provider, patch) {
  settings.profiles[provider] = normalizeProfile(provider, { ...settings.profiles[provider], ...patch });
  saveSettings(); syncWindows(); pushSnapshot();
}
function openToolbarMenu(event) {
  const owner = toolbarOwners.get(event.sender.id);
  if (!owner || event.sender.isDestroyed() || owner.win.isDestroyed()) return;
  const { provider, win } = owner;
  if (!provider) { showStandaloneMenu(win); return; }
  showProviderMenu(win, provider);
}
function showProviderMenu(win, provider) {
  const profile = settings.profiles[provider];
  const label = LABELS[provider];
  const sides = [
    ['right', 'Праворуч'], ['left', 'Ліворуч'], ['top', 'Зверху'], ['bottom', 'Знизу'],
  ];
  const modes = [
    ['full', 'Увесь h00k'], ['blocks', 'Вибрані блоки'], ['floating', 'Плаваючі вікна'],
  ];
  const menu = Menu.buildFromTemplate([
    { label: '⚙ Налаштування прикріплення…', click: () => openSettingsWindow(provider) },
    { type: 'separator' },
    { label: 'Розташування', submenu: sides.map(([side, name]) => ({
      label: name, type: 'radio', checked: profile.side === side,
      click: () => patchQuickProfile(provider, { side }),
    })) },
    { label: 'Режим', submenu: modes.map(([mode, name]) => ({
      label: name, type: 'radio', checked: profile.mode === mode,
      click: () => patchQuickProfile(provider, { mode, follow: mode !== 'floating' }),
    })) },
    { type: 'separator' },
    { label: 'Прикріплювати автоматично', type: 'checkbox', checked: profile.autoAttach,
      click: () => patchQuickProfile(provider, { autoAttach: !profile.autoAttach }) },
    { label: 'Слідувати за вікном', type: 'checkbox', checked: profile.follow,
      click: () => patchQuickProfile(provider, { follow: !profile.follow }) },
    { label: 'Завжди поверх інших вікон', type: 'checkbox', checked: profile.alwaysOnTop,
      click: () => patchQuickProfile(provider, { alwaysOnTop: !profile.alwaysOnTop }) },
    { type: 'separator' },
    { label: 'Відкрити h00k.top у браузері', click: () => void shell.openExternal(WEBSITE) },
    { label: 'Відкріпити від ' + label, click: () => {
      settings.profiles[provider].enabled = false;
      manualAttached.delete(provider);
      saveSettings(); closeProvider(provider); pushSnapshot();
    } },
  ]);
  menu.popup({ window: win });
}

function showStandaloneMenu(win) {
  if (!win || win.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    { label: '⚙ Налаштування прикріплення…', click: () => openSettingsWindow() },
    { type: 'separator' },
    ...PROVIDERS.map(id => ({
      label: LABELS[id],
      submenu: [
        { label: 'Повні налаштування…', click: () => openSettingsWindow(id) },
        { type: 'separator' },
        { label: 'Автоматичне прикріплення', type: 'checkbox',
          checked: settings.profiles[id].autoAttach,
          click: () => patchQuickProfile(id, { autoAttach: !settings.profiles[id].autoAttach }) },
        { label: 'Слідувати за терміналом', type: 'checkbox',
          checked: settings.profiles[id].follow,
          click: () => patchQuickProfile(id, { follow: !settings.profiles[id].follow }) },
        { label: 'Поверх інших вікон', type: 'checkbox',
          checked: settings.profiles[id].alwaysOnTop,
          click: () => patchQuickProfile(id, { alwaysOnTop: !settings.profiles[id].alwaysOnTop }) },
      ],
    })),
    { type: 'separator' },
    { label: 'Відкрити h00k.top у браузері', click: () => void shell.openExternal(WEBSITE) },
  ]);
  menu.popup({ window: win });
}

// The full desktop app is a local branded window with a remote, unprivileged
// WebContentsView starting BELOW its title bar. The website never receives
// the local window preload or any native window-management IPC capability.
function openStandaloneWindow() {
  if (standalone && !standalone.isDestroyed()) {
    if (standalone.isMinimized()) standalone.restore();
    standalone.show();
    standalone.focus();
    return standalone;
  }
  const win = new BrowserWindow({
    title: 'h00k Desktop',
    width: 1280, height: 850, minWidth: 500, minHeight: 360,
    backgroundColor: '#070d18',
    frame: false, thickFrame: true, resizable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'window-shell-preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    },
  });
  standalone = win;
  registerShell(win);
  const site = new WebContentsView({
    webPreferences: {
      partition: 'persist:h00k',
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      backgroundThrottling: true,
    },
  });
  site.setBackgroundColor('#070d18');
  win.contentView.addChildView(site);
  const placeSite = () => {
    if (win.isDestroyed()) return;
    const { width, height } = win.getContentBounds();
    site.setBounds({ x: 0, y: SHELL_HEIGHT, width, height: Math.max(0, height - SHELL_HEIGHT) });
  };
  placeSite();
  win.on('resize', placeSite);
  guardWebsite(site);
  const onSettingsShortcut = (event, input) => {
    if (input.type === 'keyDown' && (input.control || input.meta) && input.key === ',') {
      event.preventDefault();
      openSettingsWindow();
    }
  };
  site.webContents.on('before-input-event', onSettingsShortcut);
  win.webContents.on('before-input-event', onSettingsShortcut);
  win.loadFile(path.join(__dirname, 'window-shell.html'))
    .catch(error => console.error('h00k Desktop chrome error:', error.message));
  site.webContents.loadURL(WEBSITE)
    .catch(error => console.warn('h00k website load error:', error.message));
  win.on('closed', () => {
    if (!site.webContents.isDestroyed()) site.webContents.close();
    if (standalone === win) standalone = null;
  });
  return win;
}

// First-run setup is deliberately local. Complete it before launching or
// auto-attaching the h00k website, then open the branded application window.
function finishInitialSetup() {
  setTimeout(() => {
    if (quitting || !settings.setupComplete) return;
    openStandaloneWindow();
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
  }, 350);
}

function candidateWindows() {
  // Only native OS window metadata is exposed to the local settings panel.
  // Exclude only this app, not every Electron.exe window (some terminals use Electron).
  return detected.filter(item => item.width >= 140 && item.height >= 80
    && item.pid !== process.pid && !/^h00k desktop$/i.test(item.exe));
}
function findTarget(provider) {
  const all = candidateWindows();
  const manualId = manualTargets.get(provider);
  const explicit = all.find(item => item.id === manualId);
  if (explicit) return explicit;
  const hint = settings.profiles[provider].targetHint;
  if (hint) {
    const sameExecutable = all.filter(item => item.exe === hint.exe);
    const selected = sameExecutable.find(item => item.title === hint.title);
    if (selected) return selected;
    // Dynamic price/PnL titles can change; recover only if exactly one window matches.
    if (sameExecutable.length === 1) return sameExecutable[0];
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
function ensureContentWindows(provider, ids, mode = 'full') {
  let group = windows.get(provider);
  if (!group) { group = new Map(); windows.set(provider,group); }
  const windowMode = mode === 'floating' ? 'floating' : 'docked';
  for (const [id,win] of group) {
    if (!ids.includes(id) || win.__h00kMode !== windowMode) {
      group.delete(id);
      if (!win.isDestroyed()) win.destroy();
    }
  }
  for (const id of ids) if (!group.has(id) || group.get(id).isDestroyed()) group.set(id,makeContentWindow(provider,id,mode));
  return group;
}
function closeProvider(provider) {
  hiddenProviders.delete(provider);
  lastLayoutKeys.delete(provider);
  const group = windows.get(provider);
  if (!group) return;
  for (const win of group.values()) if (!win.isDestroyed()) win.destroy();
  windows.delete(provider);
}
function applyBounds(win, bounds, alwaysOnTop) {
  if (win.isDestroyed()) return;
  const old = win.getBounds();
  if (old.x !== bounds.x || old.y !== bounds.y || old.width !== bounds.width || old.height !== bounds.height) {
    win.__autoPlacing = true;
    win.setBounds(bounds, false);
    // Win32 moved/resized events may arrive after setBounds returns; do not persist them as user drag.
    clearTimeout(win.__autoPlaceReset);
    win.__autoPlaceReset = setTimeout(() => { win.__autoPlacing = false; }, 320);
  }
  if (win.isAlwaysOnTop() !== alwaysOnTop) win.setAlwaysOnTop(alwaysOnTop);
  if (!win.__h00kLoaded && Date.now() >= win.__nextLoadAt) {
    win.__h00kLoaded = true;
    (win.__remoteContents || win.webContents).loadURL(win.__h00kUrl).catch(err => {
      if (win.isDestroyed()) return;
      win.__h00kLoaded = false;
      win.__nextLoadAt = Date.now() + 15_000; // bounded retry; never flood h00k.top on outage
      console.warn('h00k load error (retry in 15s):', err.message);
    });
  }
  if (!win.isVisible()) win.showInactive();
}
function hideDockedWindows(provider, message) {
  const group = windows.get(provider);
  if (group) for (const win of group.values()) if (!win.isDestroyed()) win.hide();
  const now = Date.now();
  if (!hiddenProviders.has(provider)) hiddenProviders.set(provider, now);
  else if (now - hiddenProviders.get(provider) >= HIDDEN_RECLAIM_MS) {
    // A hidden h00k webview still runs timers and network requests; reclaim it after inactivity.
    closeProvider(provider);
  }
  lastDockStatus[provider] = message;
}
function preferredFloatingBounds(provider, id, profile, fallback, restore) {
  if (!restore) return fallback;
  return restoreFloatingBounds(profile.floatingBounds[id], screen.getAllDisplays(), fallback);
}
function syncWindows() {
  for (const provider of PROVIDERS) {
    const profile = settings.profiles[provider];
    const ready = settings.setupComplete && profile.enabled && (profile.autoAttach || manualAttached.has(provider));
    if (!ready) { closeProvider(provider); lastDockStatus[provider] = 'Вимкнено'; continue; }
    const target = findTarget(provider);
    const layoutKey = floatingLayoutKey(profile);
    const layoutChanged = lastLayoutKeys.has(provider) && lastLayoutKeys.get(provider) !== layoutKey;
    lastLayoutKeys.set(provider, layoutKey);
    if (!target) {
      if (profile.mode === 'floating') {
        // Truly independent floating panels can be launched without a terminal.
        hiddenProviders.delete(provider);
        const ids = availablePanels(profile);
        const group = ensureContentWindows(provider, ids, profile.mode);
        const work = screen.getPrimaryDisplay().workArea;
        const boxes = floatingRects(null, work, profile.width, profile.height, ids.length, profile.side);
        ids.forEach((id, index) => {
          const win = group.get(id);
          if (!win || win.isDestroyed()) return;
          const firstPlacement = !win.isVisible();
          if (!profile.follow && !layoutChanged && !firstPlacement) {
            if (win.isAlwaysOnTop() !== profile.alwaysOnTop) win.setAlwaysOnTop(profile.alwaysOnTop);
            return;
          }
          const restore = firstPlacement && !profile.follow && !layoutChanged;
          applyBounds(win, preferredFloatingBounds(provider, id, profile, boxes[index], restore), profile.alwaysOnTop);
        });
        lastDockStatus[provider] = 'Плаваючі панелі без термінала';
        continue;
      }
      hideDockedWindows(provider, 'Термінал не знайдено');
      continue;
    }
    if (target.minimized && profile.mode !== 'floating') {
      hideDockedWindows(provider, 'Термінал згорнуто');
      continue;
    }
    hiddenProviders.delete(provider);
    const ids = availablePanels(profile);
    const rect = externalRect(target);
    const work = screen.getDisplayMatching(rect).workArea;
    const boxes = profile.mode === 'floating'
      ? floatingRects(rect, work, profile.width, profile.height, ids.length, profile.side)
      : dockRects(rect, work, profile.side, profile.width, profile.height, ids.length);
    if (boxes.length !== ids.length) {
      // Never cover the terminal's order-entry controls just to make room.
      hideDockedWindows(provider, 'Замало місця з вибраного боку; змініть сторону або розмір');
      continue;
    }
    const group = ensureContentWindows(provider, ids, profile.mode);
    ids.forEach((id,index) => {
      const win = group.get(id);
      if (!win || win.isDestroyed()) return;
      const firstPlacement = !win.isVisible();
      if (!profile.follow && !layoutChanged && !firstPlacement) {
        if (win.isAlwaysOnTop() !== profile.alwaysOnTop) win.setAlwaysOnTop(profile.alwaysOnTop);
        return; // Follow-off freezes the dock or preserves the manually moved floating window.
      }
      const restore = profile.mode === 'floating' && !profile.follow && firstPlacement && !layoutChanged;
      applyBounds(win, profile.mode === 'floating'
        ? preferredFloatingBounds(provider, id, profile, boxes[index], restore)
        : boxes[index], profile.alwaysOnTop);
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
  ipcMain.on('desktop:toolbar-menu', openToolbarMenu);
  ipcMain.handle('desktop:snapshot',event => { verifySettingsSender(event); return snapshot(); });
  ipcMain.handle('desktop:save',(event,provider,patch) => {
    verifySettingsSender(event);
    if (!PROVIDERS.includes(provider) || !patch || typeof patch !== 'object') throw new Error('Invalid profile');
    const previous = settings.profiles[provider];
    const firstRun = !settings.setupComplete;
    const update = normalizeProfile(provider,{...previous,...patch});
    // Floating panels are manually draggable by default.
    if (previous.mode !== 'floating' && update.mode === 'floating' && !Object.hasOwn(patch,'follow')) update.follow = false;
    settings.profiles[provider] = update;
    settings.setupComplete = true; // Saving the first-run configuration completes onboarding.
    saveSettings(); syncWindows(); pushSnapshot();
    if (firstRun) finishInitialSetup();
    return snapshot();
  });
  ipcMain.handle('desktop:pick',(event,provider,id) => {
    verifySettingsSender(event);
    if (!PROVIDERS.includes(provider)) throw new Error('Invalid terminal');
    if (id === '') {
      // "Автоматично знайти" must actually remove the previous manual target.
      manualTargets.delete(provider);
      settings.profiles[provider].targetHint = null;
    } else {
      const target = candidateWindows().find(item => item.id === id);
      if (!target) throw new Error('Window not found');
      manualTargets.set(provider,id);
      settings.profiles[provider].targetHint = {exe:target.exe,title:target.title};
    }
    saveSettings(); syncWindows(); pushSnapshot(); return snapshot();
  });
  ipcMain.handle('desktop:attach',(event,provider) => {
    verifySettingsSender(event);
    if (!PROVIDERS.includes(provider)) throw new Error('Invalid terminal');
    const firstRun = !settings.setupComplete;
    settings.profiles[provider].enabled = true;
    settings.setupComplete = true;
    manualAttached.add(provider);
    saveSettings(); syncWindows(); pushSnapshot();
    if (firstRun) finishInitialSetup();
    return snapshot();
  });
  ipcMain.handle('desktop:detach',(event,provider) => {
    verifySettingsSender(event);
    if (!PROVIDERS.includes(provider)) throw new Error('Invalid terminal');
    settings.profiles[provider].enabled = false;
    manualAttached.delete(provider);
    closeProvider(provider); saveSettings(); pushSnapshot(); return snapshot();
  });
  ipcMain.handle('desktop:open-browser',event => {
    verifySettingsSender(event);
    return shell.openExternal(WEBSITE); // Never accept an arbitrary URL from the renderer.
  });
  ipcMain.handle('desktop:standalone',event => {
    verifySettingsSender(event);
    openStandaloneWindow();
    return true;
  });
  ipcMain.on('desktop:shell-command', (event, action) => {
    // Only the local shell may manage windows: the unprivileged remote website
    // is in a DIFFERENT WebContentsView and never gets this preload.
    const owner = shellOwners.get(event.sender.id);
    if (!owner || owner.win.isDestroyed() || event.sender !== owner.win.webContents) return;
    const { win, provider } = owner;
    if (action === 'settings') {
      if (provider) showProviderMenu(win, provider);
      else showStandaloneMenu(win);
    } else if (action === 'minimize') win.minimize();
    else if (action === 'toggle-maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === 'close') win.close();
  });
}
if(!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (!settings.setupComplete) openSettingsWindow();
    else openStandaloneWindow();
  });
  app.whenReady().then(() => {
    loadSettings(); registerIpc();
    if (settings.setupComplete) openStandaloneWindow();
    else createSettingsWindow();
    runAgent();
    if (process.platform !== 'win32') {
      for (const provider of PROVIDERS) lastDockStatus[provider] = 'Прикріплення вікон підтримується лише у Windows';
    }
  });
  app.on('before-quit',()=>{quitting=true;if(agent){agent.kill();agent=null;}});
  app.on('window-all-closed',()=>app.quit());
}
