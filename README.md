# Ayenyzer — Wakfu combat log overlay

This is the original **Ayenyzer** combat log analyzer (single HTML file,
vanilla JS, Chart.js) ported into a small Electron desktop app so its live
stats can float over the Wakfu window as a real overlay, instead of living
in a browser tab.

Almost none of the parsing logic changed — `config/index.html` is the same
file, with only the live-mode file access swapped from the browser's File
System Access API to plain Node `fs` calls in the main process (see
"What changed" below).

## Why Electron

A browser tab can never draw on top of another application's window — that's
a hard limit of the browser sandbox, not something fixable in JS. Electron
wraps the same web page in a real OS window that *can* be borderless,
transparent, always-on-top and click-through. The parsing/rendering code
stays JS; only the "container" around it changes.

## How it's laid out

- **Config window** (`config/index.html`) — the original app: paste/upload
  a log offline, or point Live mode at a mirrored log file, tune the regex
  patterns, ownership rules, hide characters, dedup, etc. This is where you
  set things up and where all the charts/tables live.
- **Overlay window** (`overlay/index.html`) — a small transparent,
  always-on-top window that mirrors the *current* fight (top damage list +
  turn counter) over the game. It never touches the log file itself — the
  config window pushes a compact snapshot to it (via the main process) every
  time its own results re-render, whether that's from offline parsing or a
  live poll.
- **`main.js`** — creates both windows, and hosts the three bits that need
  real OS/Node access: the native "pick a log file" dialog, reading that
  file, and the native "save parsed log" dialog. Everything else runs in the
  renderers exactly like the original single-file version.

## Running it

```
npm install
npm start
```

Two windows open: the config window (normal, resizable) and the overlay
(transparent, top-right of your primary screen by default).

### Prerequisite: a log file to watch

Nothing here reads Wakfu's memory or process — same as the original tool,
Live mode just tails a **plain text file** that mirrors the game's combat
log (whatever you were already using to produce that file before still
applies here — the app doesn't generate it). In the config window: Live
mode → "Watch File (Live)" → pick that file.

### Overlay controls

- **Ctrl+Shift+O** — toggle the overlay between click-through (default —
  clicks pass through to the game underneath) and interactive (drag it by
  its header, resize it, etc). The little dot in its header turns gold
  while interactive.
- **Ctrl+Shift+H** — show/hide the overlay entirely.
- The "In-game overlay" section in the config window's sidebar has a
  checkbox to stop pushing stats to it altogether.
- Fullscreen: Wakfu needs to run in **borderless windowed** mode for the
  overlay to actually show above it — true exclusive fullscreen gives the
  game sole ownership of the screen and blocks every overlay by design,
  Electron included.

## What changed vs. the original single-file version

- **Live mode file access**: `showOpenFilePicker`/`showSaveFilePicker`
  (Chromium-only, and needed a user click to re-grant permission whenever
  it lapsed) were replaced with `dialog.showOpenDialog`/`showSaveDialog` +
  `fs.promises.readFile`/`writeFile` in the main process, called over IPC
  (`window.api.selectLogFile()`, `readFile()`, `saveLog()` — see
  `preload.js`). Same polling-every-1.5s design, same incremental
  parsing/dedup/turn-tracking state — only *how* the bytes get read changed.
  This also removes the old permission-lost/"Resume Watching" dance
  entirely: a plain file read either works or it doesn't (e.g. the file was
  moved), there's no OS permission prompt to fail.
- **New "In-game overlay" section** in the sidebar (enable/disable pushing
  to the overlay, hotkey reminders).
- **`pushOverlaySnapshot()`** hooks into the existing `finalizeAndRender()`
  — the single place offline parsing, live polling and fight
  navigation already funnel through — so the overlay always mirrors
  whatever fight is currently being viewed, with no new state to keep in
  sync.
- Everything else — the regex-based parsing, ownership/DOT/summon
  attribution rules, dedup window, multi-fight boundary splitting, hide
  characters, drag-reorder panels, Chart.js charts — is untouched.

## Ideas for further work

- **Track the game window**: right now the overlay sits wherever you drag
  it. To have it follow Wakfu if you move/resize its window, you'd add a
  native window-tracking package (e.g. `electron-overlay-window`, which
  wraps the Win32 APIs for this) and reposition `overlayWin` on every tick.
- **Perf for very long fights**: `total()` re-sums each character's full
  `dmg`/`heal` array on every render tick. Fine at normal fight lengths;
  for very long farming sessions you'd want running totals updated
  incrementally instead of re-summed from scratch each poll.
- **Packaging**: `npm run package:win` (via `electron-packager`, already a
  devDependency) produces a standalone `.exe` folder under `dist/` so you
  don't need Node/npm installed to just run it day-to-day.
