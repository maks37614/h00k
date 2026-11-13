'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The privileged bridge exists only in a packaged, local toolbar file.
// h00k.top web content does not get access to the Desktop IPC.
contextBridge.exposeInMainWorld('h00kDockButton', Object.freeze({
  showMenu: () => ipcRenderer.send('desktop:toolbar-menu'),
}));
