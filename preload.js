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

  // Start/stop the wakfu-log-mirror.ps1 helper script (overlay Start/Stop button).
  startMirror: () => ipcRenderer.invoke('mirror:start'),
  stopMirror: () => ipcRenderer.invoke('mirror:stop'),
  getMirrorStatus: () => ipcRenderer.invoke('mirror:getStatus'),
  onMirrorStatus: (cb) => ipcRenderer.on('mirror:status', (_event, data) => cb(data)),

  // Lets overlay controls (e.g. the Start/Stop button) temporarily suspend
  // click-through while the cursor hovers them, so they stay clickable even
  // when the overlay itself is in default click-through mode.
  setOverlayHover: (hovering) => ipcRenderer.send('overlay:hover', hovering),

  // Overlay Start button -> config window's "Watch File (Live)" flow.
  requestStartWatching: () => ipcRenderer.send('overlay:requestStartWatching'),
  onRequestStartWatching: (cb) => ipcRenderer.on('config:startWatching', () => cb()),

  // Stops the mirror script (if running) and deletes its output file + the
  // .offset sidecar, so a long append-only mirror can be started clean.
  resetMirrorFiles: () => ipcRenderer.invoke('mirror:resetFiles'),
});
