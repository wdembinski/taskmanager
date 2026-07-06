/**
 * Electron MAIN process entry point — the first code that runs when the app
 * starts. Its job in Phase 0 is small but foundational:
 *
 *   1. Create the application window (a Chromium window that loads our React UI).
 *   2. Lock down that window's security (sandbox on, Node access off, preload on).
 *   3. Register the IPC handlers so the UI can talk to the engine.
 *
 * Later phases start the orchestration engine (scheduler, session runner,
 * usage-limit gate) from here too.
 */
import { join } from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import { registerIpcHandlers, type Engine } from './ipc';

/**
 * Create the main window.
 *
 * SECURITY NOTE: `contextIsolation: true` + `nodeIntegration: false` are the
 * important protections — the web page runs in its own isolated world and has no
 * direct Node/OS access; the ONLY bridge is our preload script's small explicit
 * API. `sandbox` is left off because we ship an ES-module preload (`index.mjs`),
 * and Electron does not allow ESM preload scripts inside the OS sandbox. This is
 * the standard electron-vite configuration.
 */
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false, // reveal only once the page is painted, to avoid a white flash
    title: 'Claude Orchestrator',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  window.on('ready-to-show', () => window.show());

  // Open target=_blank / external links in the user's real browser, not inside
  // the app window (which should only ever host our own UI).
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // In development electron-vite serves the renderer over HTTP with hot-reload;
  // in production we load the built HTML file from disk.
  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}

// Holds the engine so we can shut its sessions and database down cleanly on quit.
let engine: Engine | undefined;

// app.whenReady() resolves once Electron has finished starting up; only then may
// we create windows.
void app.whenReady().then(() => {
  const window = createWindow();
  // The engine needs the window so it can push live session events to the UI.
  engine = registerIpcHandlers(window);

  // macOS convention: re-create a window when the dock icon is clicked and no
  // windows are open. Harmless on Windows/Linux.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Never leave orphaned `claude` processes running after the app closes, and
// close the database so its WAL is checkpointed cleanly. Dispose the scheduler
// FIRST so the `exited` events from killed sessions don't try to write to a
// database we're about to close.
app.on('before-quit', () => {
  engine?.scheduler.dispose();
  engine?.sessions.stopAll();
  engine?.store.close();
});

// Quit when all windows are closed, except on macOS where apps typically stay
// alive until the user explicitly quits (Cmd+Q).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
