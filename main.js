// Electron shell around the original Ayenyzer combat log analyzer.
//
// Two windows:
//  - the config window: basically the original app (offline paste/upload,
//    live-mode setup, all the regex/ownership/hide/dedup settings). This is
//    where you actually work.
//  - the overlay window: a small transparent, always-on-top, click-through
//    window that mirrors the current fight's stats over the game itself.
//    It never reads the log on its own — the config window pushes a
//    compact snapshot to it every time its own results re-render.
//
// Why Electron instead of a browser tab: a browser page can never draw on
// top of another application's window. Everything else about the original
// tool (parsing, attribution rules, dedup, charts) is unchanged and still
// lives in config/index.html — only the live-mode file access moved from
// the browser's File System Access API (Chrome/Edge only, clunky
// permission re-grants) to plain Node fs calls here in the main process.
const { app, BrowserWindow, ipcMain, dialog, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');

let configWin = null;
let overlayWin = null;
let overlayInteractive = false; // false = click-through (default), true = draggable/resizable

function createConfigWindow(){
  configWin = new BrowserWindow({
    width: 1320,
    height: 880,
    title: 'Ayenyzer — config',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  configWin.loadFile(path.join(__dirname, 'config', 'index.html'));
  configWin.on('closed', () => { configWin = null; });
}

function createOverlayWindow(){
  const display = screen.getPrimaryDisplay();
  const width = 360, height = 320;
  overlayWin = new BrowserWindow({
    width, height,
    x: display.workArea.x + display.workArea.width - width - 20,
    y: display.workArea.y + 20,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true, // needs to be true for interactive mode to accept drag/resize input at all
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 'screen-saver' level sits above most normal windows and borderless/
  // windowed-fullscreen games. True exclusive-fullscreen games block every
  // overlay by design (the game owns the whole screen) — run Wakfu in
  // borderless windowed mode for the overlay to show up.
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setIgnoreMouseEvents(true, { forward: true }); // click-through by default
  overlayWin.loadFile(path.join(__dirname, 'overlay', 'index.html'));
  overlayWin.on('closed', () => { overlayWin = null; });
}

function setOverlayInteractive(interactive){
  overlayInteractive = interactive;
  if(!overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.setIgnoreMouseEvents(!interactive, { forward: true });
  overlayWin.webContents.send('overlay:mode', overlayInteractive);
}

app.whenReady().then(() => {
  createConfigWindow();
  createOverlayWindow();

  globalShortcut.register('CommandOrControl+Shift+O', () => setOverlayInteractive(!overlayInteractive));
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if(!overlayWin || overlayWin.isDestroyed()) return;
    if(overlayWin.isVisible()) overlayWin.hide(); else overlayWin.show();
  });

  app.on('activate', () => {
    if(BrowserWindow.getAllWindows().length === 0){
      createConfigWindow();
      createOverlayWindow();
    }
  });
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => { if(process.platform !== 'darwin') app.quit(); });

// ---- IPC: file access for live mode (replaces the browser File System
// Access API), native save dialog, and the snapshot relay to the overlay ----

ipcMain.handle('dialog:selectLogFile', async () => {
  const res = await dialog.showOpenDialog(configWin, {
    title: 'Select the (mirrored) combat log file',
    properties: ['openFile'],
    filters: [{ name: 'Log files', extensions: ['txt', 'log'] }, { name: 'All files', extensions: ['*'] }],
  });
  if(res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('file:read', async (_event, filePath) => {
  try{
    const text = await fs.promises.readFile(filePath, 'utf-8');
    return { ok: true, text };
  }catch(e){
    return { ok: false, error: e.message, notFound: e.code === 'ENOENT' };
  }
});

ipcMain.handle('dialog:saveLog', async (_event, text, suggestedName, watchPath) => {
  const defaultPath = watchPath ? path.join(path.dirname(watchPath), suggestedName) : suggestedName;
  const res = await dialog.showSaveDialog(configWin, {
    title: 'Save parsed log',
    defaultPath,
    filters: [{ name: 'Text file', extensions: ['txt'] }],
  });
  if(res.canceled || !res.filePath) return { cancelled: true };
  try{
    await fs.promises.writeFile(res.filePath, text, 'utf-8');
    return { ok: true, name: path.basename(res.filePath) };
  }catch(e){
    return { ok: false, error: e.message };
  }
});

// Fire-and-forget: the config window pushes a snapshot on every re-render,
// we just relay it to whichever window is currently showing the overlay.
ipcMain.on('overlay:snapshot', (_event, data) => {
  if(overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('overlay:update', data);
});
