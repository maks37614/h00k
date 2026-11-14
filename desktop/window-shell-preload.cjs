'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Only the local window-shell.html receives this bridge.
// The website is hosted by an isolated WebContentsView without a preload.
const allowed = new Set(['settings', 'minimize', 'toggle-maximize', 'close']);
contextBridge.exposeInMainWorld('h00kShell', Object.freeze({
  command(action) {
    if (allowed.has(action)) ipcRenderer.send('desktop:shell-command', action);
  },
  onState(callback) {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, state) => callback({ maximized: state?.maximized === true });
    ipcRenderer.on('desktop:window-state', handler);
    return () => ipcRenderer.removeListener('desktop:window-state', handler);
  },
}));
