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
const { spawn, exec } = require('child_process');

let configWin = null;
let overlayWin = null;
let overlayInteractive = false; // false = click-through (default), true = draggable/resizable
let mirrorProc = null; // child process running wakfu-log-mirror.ps1, or null if stopped

// The overlay window is click-through by default, so a hover-based trick is
// needed for its in-page controls to be clickable at all (see overlay:hover
// below) — and that trick is inherently a little laggy/miss-prone over a
// tiny target. The drag handle instead gets its own always-on-top window
// that is NEVER click-through, floating over the overlay's corner, so it's
// unconditionally interactive. Dragging it just mirrors its movement onto
// the real overlay window.
let dragHandleWin = null;
let handleLastPos = null;
let suppressHandleSync = false; // true while we're repositioning the handle programmatically
let suppressOverlaySync = false; // true while we're repositioning the overlay from a handle drag
const HANDLE_SIZE = 18;
const HANDLE_MARGIN = 6;

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
  overlayWin.on('closed', () => {
    overlayWin = null;
    if(dragHandleWin && !dragHandleWin.isDestroyed()) dragHandleWin.close();
  });
  overlayWin.on('move', () => { if(!suppressOverlaySync) repositionDragHandle(); });
  overlayWin.on('resize', () => repositionDragHandle());
}

function createDragHandleWindow(){
  const b = overlayWin.getBounds();
  dragHandleWin = new BrowserWindow({
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    x: b.x + b.width - HANDLE_SIZE - HANDLE_MARGIN,
    y: b.y + HANDLE_MARGIN,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true, // needed on Windows for -webkit-app-region:drag to actually accept mouse input
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  dragHandleWin.setAlwaysOnTop(true, 'screen-saver');
  dragHandleWin.loadFile(path.join(__dirname, 'overlay', 'drag-handle.html'));
  handleLastPos = dragHandleWin.getPosition();
  dragHandleWin.on('closed', () => { dragHandleWin = null; });

  // Dragging this window (native OS drag via app-region:drag) fires 'move'
  // repeatedly; mirror each delta onto the real overlay window so it looks
  // like you're dragging the overlay itself by its corner grip.
  dragHandleWin.on('move', () => {
    if(suppressHandleSync) return;
    if(!overlayWin || overlayWin.isDestroyed()) return;
    const [hx, hy] = dragHandleWin.getPosition();
    if(handleLastPos){
      const dx = hx - handleLastPos[0];
      const dy = hy - handleLastPos[1];
      if(dx || dy){
        const [ox, oy] = overlayWin.getPosition();
        suppressOverlaySync = true;
        overlayWin.setPosition(ox + dx, oy + dy);
        suppressOverlaySync = false;
      }
    }
    handleLastPos = dragHandleWin.getPosition();
  });
}

function repositionDragHandle(){
  if(!overlayWin || overlayWin.isDestroyed() || !dragHandleWin || dragHandleWin.isDestroyed()) return;
  const b = overlayWin.getBounds();
  suppressHandleSync = true;
  dragHandleWin.setPosition(b.x + b.width - HANDLE_SIZE - HANDLE_MARGIN, b.y + HANDLE_MARGIN);
  suppressHandleSync = false;
  handleLastPos = dragHandleWin.getPosition();
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
  createDragHandleWindow();

  // register() returns false (no exception) if the accelerator is already
  // held by another app — that failure is otherwise silent, so log it: a
  // shortcut that "does nothing" is usually a conflict, not a code bug.
  const oOk = globalShortcut.register('CommandOrControl+Shift+O', () => setOverlayInteractive(!overlayInteractive));
  if(!oOk) console.error('[Ayenyzer] Could not register Ctrl+Shift+O — it is likely already bound by another running app.');

  const hOk = globalShortcut.register('CommandOrControl+Shift+H', () => {
    if(!overlayWin || overlayWin.isDestroyed()) return;
    const show = !overlayWin.isVisible();
    if(show) overlayWin.show(); else overlayWin.hide();
    if(dragHandleWin && !dragHandleWin.isDestroyed()){
      if(show) dragHandleWin.show(); else dragHandleWin.hide();
    }
  });
  if(!hOk) console.error('[Ayenyzer] Could not register Ctrl+Shift+H — it is likely already bound by another running app.');

  app.on('activate', () => {
    if(BrowserWindow.getAllWindows().length === 0){
      createConfigWindow();
      createOverlayWindow();
      createDragHandleWindow();
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if(mirrorProc) exec(`taskkill /pid ${mirrorProc.pid} /t /f`);
});
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

// The overlay is click-through by default so clicks reach the game behind
// it. That also swallows clicks on the overlay's own controls (the Start/
// Stop button), so those controls report when the cursor is hovering them
// and we temporarily disable click-through for as long as that's true.
// Skipped while the user has explicitly toggled interactive mode (Ctrl+Shift+O)
// — in that mode everything already accepts input.
ipcMain.on('overlay:hover', (_event, hovering) => {
  if(overlayInteractive) return;
  if(!overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.setIgnoreMouseEvents(!hovering, { forward: true });
});

// ---- IPC: start/stop the wakfu-log-mirror.ps1 helper script from the
// overlay's Start/Stop button. This is the thing that actually produces the
// mirrored log file that Live mode watches. ----

function broadcastMirrorStatus(running){
  const payload = { running };
  if(overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('mirror:status', payload);
  if(configWin && !configWin.isDestroyed()) configWin.webContents.send('mirror:status', payload);
}

ipcMain.handle('mirror:start', async () => {
  if(mirrorProc) return { ok: true, running: true };
  const scriptPath = path.join(app.getPath('documents'), 'wakfu-log-mirror.ps1');
  try{
    mirrorProc = spawn(
      'powershell.exe',
      ['-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true }
    );
  }catch(e){
    mirrorProc = null;
    return { ok: false, error: e.message };
  }
  mirrorProc.on('exit', () => { mirrorProc = null; broadcastMirrorStatus(false); });
  mirrorProc.on('error', () => { mirrorProc = null; broadcastMirrorStatus(false); });
  broadcastMirrorStatus(true);
  return { ok: true, running: true };
});

ipcMain.handle('mirror:stop', async () => {
  if(!mirrorProc) return { ok: true, running: false };
  const pid = mirrorProc.pid;
  mirrorProc = null;
  await new Promise((resolve) => exec(`taskkill /pid ${pid} /t /f`, () => resolve()));
  broadcastMirrorStatus(false);
  return { ok: true, running: false };
});

ipcMain.handle('mirror:getStatus', () => ({ running: !!mirrorProc }));

// The overlay's Start button also kicks off Live mode: it can't pick a file
// or poll it itself (that state lives entirely in the config renderer), so
// it just asks the config window to run its own "Watch File (Live)" flow,
// native file picker and all.
ipcMain.on('overlay:requestStartWatching', () => {
  if(configWin && !configWin.isDestroyed()) configWin.webContents.send('config:startWatching');
});

// Manual vertical resize (see overlay/index.html's .resize-top/.resize-bottom
// handles). Frameless + transparent + always-on-top windows on Windows are
// notoriously unreliable for native top/bottom edge resize (left/right work
// fine through the OS border, top/bottom often silently don't) — so those
// handles drive setBounds directly from the renderer instead of relying on
// the native resize border at all.
const OVERLAY_MIN_WIDTH = 200;
const OVERLAY_MIN_HEIGHT = 120;

ipcMain.handle('overlay:getBounds', () => {
  if(!overlayWin || overlayWin.isDestroyed()) return null;
  return overlayWin.getBounds();
});

ipcMain.on('overlay:setBounds', (_event, bounds) => {
  if(!overlayWin || overlayWin.isDestroyed() || !bounds) return;
  overlayWin.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(OVERLAY_MIN_WIDTH, Math.round(bounds.width)),
    height: Math.max(OVERLAY_MIN_HEIGHT, Math.round(bounds.height)),
  });
});
