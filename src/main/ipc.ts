/**
 * Registers the main-process handlers for every INVOKE channel in the IPC
 * contract (src/shared/ipc.ts). Think of this as the app's "backend routes".
 *
 * `ipcMain.handle(channel, fn)` says: "when the UI calls `channel`, run `fn` and
 * send whatever it returns back as the reply." The small `handle()` helper below
 * makes each registration type-safe against the shared `IpcApi` interface, so a
 * handler whose return type doesn't match the contract won't compile.
 */
import { app, ipcMain, type BrowserWindow } from 'electron';
import type { IpcApi } from '@shared/ipc';
import { getClaudeStatus } from './claudeStatus';
import { SessionManager } from './sessionManager';

/**
 * Type-safe wrapper around ipcMain.handle. `K` is constrained to a real channel
 * name, and the handler's return type must match that channel's contract.
 */
function handle<K extends keyof IpcApi>(
  channel: K,
  handler: (...args: Parameters<IpcApi[K]>) => ReturnType<IpcApi[K]>,
): void {
  ipcMain.handle(channel, (_event, ...args) => handler(...(args as Parameters<IpcApi[K]>)));
}

/**
 * Wire up all invoke handlers and the session engine. Called once during app
 * startup with the main window (needed so the engine can push events to the UI).
 * Returns the SessionManager so the caller can stop all sessions on quit.
 */
export function registerIpcHandlers(mainWindow: BrowserWindow): SessionManager {
  // The engine pushes normalized session events to the UI over 'session:event'.
  const sessions = new SessionManager((envelope) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('session:event', envelope);
  });

  handle('app:getInfo', async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
  }));

  handle('claude:getStatus', () => getClaudeStatus());

  handle('session:start', async (request) => sessions.start(request));
  handle('session:stop', async (runId) => sessions.stop(runId));

  return sessions;
}
