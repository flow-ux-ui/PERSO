// Shared preload for both windows (config + overlay). contextIsolation is on,
// so this is the only bridge between renderer JS and Node/Electron — the
// renderers never get direct fs/ipcRenderer access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Live mode: native file picker + plain fs reads, done in the main
  // process. Replaces the browser's File System Access API.
  selectLogFile: () => ipcRenderer.invoke('dialog:selectLogFile'),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  saveLog: (text, suggestedName, watchPath) => ipcRenderer.invoke('dialog:saveLog', text, suggestedName, watchPath),

  // Overlay relay: the config window sends a snapshot on every re-render,
  // the overlay window listens for it.
  sendOverlaySnapshot: (data) => ipcRenderer.send('overlay:snapshot', data),
  onOverlayUpdate: (cb) => ipcRenderer.on('overlay:update', (_event, data) => cb(data)),
  onOverlayMode: (cb) => ipcRenderer.on('overlay:mode', (_event, interactive) => cb(interactive)),
});
