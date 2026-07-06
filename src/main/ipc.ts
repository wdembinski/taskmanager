/**
 * Registers the main-process handlers for every INVOKE channel in the IPC
 * contract (src/shared/ipc.ts). Think of this as the app's "backend routes".
 *
 * `ipcMain.handle(channel, fn)` says: "when the UI calls `channel`, run `fn` and
 * send whatever it returns back as the reply." The small `handle()` helper below
 * makes each registration type-safe against the shared `IpcApi` interface, so a
 * handler whose return type doesn't match the contract won't compile.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import type { IpcApi } from '@shared/ipc';
import type { Project, ProjectWithTasks } from '@shared/model';
import { getClaudeStatus } from './claudeStatus';
import { parsePlan } from './planParser';
import { SessionManager } from './sessionManager';
import { createStore, type Store } from './store';

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
 * Read a project's plan file (if present) and reconcile it into the store's task
 * list. A missing/unreadable plan is treated as "no tasks" rather than an error —
 * a project can exist before its plan does.
 */
function syncProjectPlan(store: Store, project: Project): ProjectWithTasks {
  let markdown = '';
  try {
    markdown = readFileSync(project.planPath, 'utf8');
  } catch {
    markdown = '';
  }
  const tasks = store.syncTasksFromPlan(project.id, parsePlan(markdown));
  return { project, tasks };
}

/** What registerIpcHandlers hands back so the app can shut resources down cleanly. */
export interface Engine {
  sessions: SessionManager;
  store: Store;
}

/**
 * Wire up all invoke handlers and the engine. Called once during app startup
 * with the main window (needed so the engine can push events to the UI). Returns
 * the engine so the caller can stop sessions and close the DB on quit.
 */
export function registerIpcHandlers(mainWindow: BrowserWindow): Engine {
  // The engine pushes normalized session events to the UI over 'session:event'.
  const sessions = new SessionManager((envelope) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('session:event', envelope);
  });

  // One SQLite file per user, under Electron's managed userData directory.
  const store = createStore(join(app.getPath('userData'), 'orchestrator.db'));

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

  handle('project:pickDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a project folder',
      properties: ['openDirectory'],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  handle('project:add', async (input) => {
    const project = store.addProject(input);
    return syncProjectPlan(store, project);
  });

  handle('project:list', async () =>
    store.listProjects().map((project) => ({ project, tasks: store.getTasks(project.id) })),
  );

  handle('project:remove', async (id) => store.removeProject(id));

  handle('project:syncPlan', async (id) => {
    const project = store.listProjects().find((p) => p.id === id);
    if (!project) return [];
    return syncProjectPlan(store, project).tasks;
  });

  return { sessions, store };
}
