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
import { app, BrowserWindow, dialog, protocol, safeStorage, shell } from 'electron';
import { ATTACHMENT_SCHEME } from '@shared/attachments';
import { PRODUCT_NAME } from '@shared/product';
import { registerIpcHandlers, type Engine } from './ipc';
import { formatError, getLogPath, logMain } from './log';

// Nothing in main used to report a failure anywhere the user could see it. A throw
// during startup (v0.25.0 on Linux: a wrong-ABI better_sqlite3.node) left the window
// open with ZERO ipcMain handlers registered, so every screen sat on its spinner
// forever with no clue why. These two handlers make any such failure loud.
process.on('uncaughtException', (err) => reportFatal('Unexpected error', err));
process.on('unhandledRejection', (reason) => reportFatal('Unexpected error', reason));

// Windows white-flash-on-restore fix. Chromium's "native window occlusion"
// detection marks a minimized window as occluded and discards its rendered frame;
// restoring it from the taskbar then shows a blank WHITE client area for a moment
// until the page repaints. Disabling this feature keeps the content painted across
// minimize/restore. Must be set before the app is ready.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// A Linux box without a keyring — WSL, a headless session, a minimal desktop — has no
// OS secret store, so `safeStorage.isEncryptionAvailable()` is false and the JIRA token
// could never be saved at all: Settings just disabled "Save token" with a one-line hint
// and the whole integration was unreachable. Opting into Electron's own fallback makes
// storage possible there, at a cost the UI states plainly (`plainTextStorage` in
// `jira:getConfigStatus`): the key comes from a fixed built-in password instead of the
// keyring, so the token is obfuscated on disk rather than secret from anyone with
// access to the machine.
//
// This does NOT weaken machines that have a real backend — Electron only falls back
// when it cannot determine a password manager (gnome-libsecret, kwallet, … still win)
// — and it is a no-op on Windows/macOS. It MUST run before the app is ready, because
// Electron fixes the encryption config as it starts up.
if (process.platform === 'linux') safeStorage.setUsePlainTextEncryption(true);

// The scheme an attachment image is previewed over. Chromium fixes the properties of a
// scheme while it starts up, so — like the two switches above — this MUST run at module
// scope, before the app is ready; `protocol.handle` (the half that needs the store, and
// therefore a ready app) is called from `ipc.ts` instead.
//
// What each flag buys, since a privileged scheme is exactly as trusted as it is declared:
//
// - `standard` makes it a hierarchical URL, so `vipper-attachment://a/<id>` parses with a
//   host and a path at all — and is why the id lives in the PATH: a standard scheme's
//   authority is canonicalised (lower-cased, IDNA-mapped), which a UUID must not be.
// - `secure` puts it in a secure context, so the page may load it without Chromium
//   treating it as mixed content.
// - `supportFetchAPI` + `stream` let the handler answer with a `Response` object, which is
//   what the modern `protocol.handle` API takes.
//
// Deliberately NOT `bypassCSP`. That flag would exempt the scheme from the page's policy
// entirely — including `script-src`, which is not what is being asked for. Widening
// `img-src` by one token in `renderer/index.html` says precisely the true thing: this
// scheme may supply IMAGES.
protocol.registerSchemesAsPrivileged([
  {
    scheme: ATTACHMENT_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

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
    title: PRODUCT_NAME,
    // Frameless: no OS title bar/border — the renderer draws its own title bar and
    // window controls (see src/renderer/src/TitleBar.tsx). Resizing from the window
    // edges still works. The dark backgroundColor avoids a white flash before paint.
    frame: false,
    backgroundColor: '#1f1f1f',
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

/** Guard so a cascade of rejections can't stack a dozen modal dialogs. */
let reportedFatal = false;

/**
 * Log a fatal error to file and show it to the user, because in a packaged app there
 * is no console to print it to. `fatal: true` means the app cannot usefully continue
 * (the engine never came up), so we quit rather than leave dead windows on screen.
 */
function reportFatal(title: string, err: unknown, fatal = false): void {
  logMain(title, err);
  if (reportedFatal) return;
  reportedFatal = true;
  // Resolving the log path touches app.getPath, which can itself fail very early.
  let logHint = 'the app log';
  try {
    logHint = getLogPath();
  } catch {
    /* keep the generic wording */
  }
  const detail =
    `${formatError(err)}\n\n` +
    `A full log was written to:\n${logHint}\n\n` +
    `If this says NODE_MODULE_VERSION, the installed build is packaged against the ` +
    `wrong Electron ABI — please report it with the version number.`;
  // showErrorBox works before the app is ready, unlike the other dialog APIs.
  dialog.showErrorBox(`${PRODUCT_NAME} — ${title}`, detail);
  if (fatal) app.exit(1);
}

// app.whenReady() resolves once Electron has finished starting up; only then may
// we create windows.
void app.whenReady().then(() => {
  const window = createWindow();
  try {
    // The engine needs the window so it can push live session events to the UI.
    // Everything here — opening the database, migrations, the scheduler — happens
    // BEFORE the first ipcMain.handle(), so a throw leaves the UI with no backend
    // at all. Catch it and say so instead of failing silently.
    engine = registerIpcHandlers(window);
  } catch (err) {
    reportFatal('failed to start', err, true);
    return;
  }

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
  engine?.windowTracker.dispose(); // last geometry write, before the DB goes away
  engine?.updater.dispose();
  engine?.syncPoller.dispose();
  engine?.watcher.dispose();
  engine?.scheduler.dispose();
  engine?.sessions.stopAll();
  engine?.broker.close();
  engine?.store.close();
});

// Quit when all windows are closed, except on macOS where apps typically stay
// alive until the user explicitly quits (Cmd+Q).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
