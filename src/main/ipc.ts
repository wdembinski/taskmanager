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
import { basename, join } from 'node:path';
import {
  app,
  dialog,
  ipcMain,
  safeStorage,
  screen,
  type BrowserWindow,
  type Rectangle,
} from 'electron';
import type {
  IpcApi,
  IpcEvents,
  JiraIssueTypeOption,
  JiraProjectOption,
  JiraStatusOption,
  JiraUserOption,
} from '@shared/ipc';
import {
  isManualStatus,
  isPersonalBoard,
  PERSONAL_PROJECT_ID,
  type BoardColumn,
  type JiraStatusCategory,
  type Project,
  type ProjectPatch,
  type ProjectWithTasks,
  type Task,
} from '@shared/model';
import { categoryFromKey } from '@shared/board';
import { resolveStatusColumn } from '@shared/statusResolve';
import type { AppSettings } from '@shared/settings';
import { sameExecTarget, type ExecTarget } from '@shared/execTarget';
import { normalizeBaseUrl } from '@shared/jiraUrl';
import { createJiraClient } from './jira/jiraConfig';
import { explainJiraFailure } from './jira/jiraDiagnostics';
import { commentBodyToText, type JiraClient, type JiraIssue } from './jira/jiraClient';
import { blocksToText, parseAdf } from './jira/adf';
import { normalizeIssueTypes, normalizeProjects } from './jira/createMeta';
import { reconcileJiraTasks } from './jira/jiraSync';
import { discoverEpicFieldId, epicKeyFromIssue, epicNameFromIssue } from './jira/epicField';
import { discoverSprintFieldId, withCurrentSprint } from './jira/jiraSprint';
import { authorIsMe, identityFrom, type JiraIdentityCache } from './jira/identity';
import { pickTransition, resolveMove } from './jira/jiraMove';
import { GitLabClient } from './gitlab/gitlabClient';
import { gitlabIdentityFrom, type GitLabIdentityCache } from './gitlab/identity';
import { describeMergeRequest } from './gitlab/describeMergeRequest';
import {
  mergeRequestId,
  needsDetailRefresh,
  reconcileMergeRequests,
  rematchMergeRequests,
  type FetchedMergeRequest,
} from './gitlab/gitlabSync';
import { GitLabPoller } from './gitlabPoller';
import type { MergeRequest } from '@shared/mergeRequest';
import { hostFor, listWslDistros, readinessFor, statusForTargets } from './exec';
import { listClaudeSessions } from './claudeSessions';
import { sanitizeWindowState } from './windowState';
import { appPlanPath } from './projectPaths';
import { logMain } from './log';
import { parsePlan } from './planParser';
import { planHasAlignmentMarkers, validatePlan } from './planValidate';
import { buildAlignPrompt } from './alignPrompt';
import { PermissionBroker } from './permissionBroker';
import { writePermissionServer } from './permissionServerSource';
import { PlanWatcher } from './planWatcher';
import { JiraPoller } from './jiraPoller';
import { validateBranchName } from '@shared/branchName';
import { Scheduler } from './scheduler';
import { SessionManager } from './sessionManager';
import { createStore, type Store } from './store';
import { Updater } from './updater';
import { bucketSeries, rollupWindow } from './usageRollup';
import { WorktreeManager } from './worktreeManager';

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
    markdown = readFileSync(appPlanPath(project), 'utf8');
  } catch {
    markdown = '';
  }
  const parsed = parsePlan(markdown);
  const tasks = store.syncTasksFromPlan(project.id, parsed);
  return { project: ensureAligned(store, project, planHasAlignmentMarkers(parsed)), tasks };
}

/**
 * Confirm a legacy project as "aligned" once its plan actually carries the
 * team-orchestration markers, so it stops being nudged. Upgrade-only: it never
 * flips an aligned project back to needs-review. Returns the effective project.
 */
function ensureAligned(store: Store, project: Project, hasMarkers: boolean): Project {
  if (project.planAligned || !hasMarkers) return project;
  store.setPlanAligned(project.id, true);
  return { ...project, planAligned: true };
}

/** What registerIpcHandlers hands back so the app can shut resources down cleanly. */
export interface Engine {
  sessions: SessionManager;
  scheduler: Scheduler;
  store: Store;
  broker: PermissionBroker;
  watcher: PlanWatcher;
  jiraPoller: JiraPoller;
  gitlabPoller: GitLabPoller;
  updater: Updater;
  /** Flushes the window geometry — must be disposed BEFORE the store closes. */
  windowTracker: { dispose(): void };
}

/**
 * Wire up all invoke handlers and the engine. Called once during app startup
 * with the main window (needed so the engine can push events to the UI). Returns
 * the engine so the caller can stop sessions and close the DB on quit.
 */
export function registerIpcHandlers(mainWindow: BrowserWindow): Engine {
  // Small helper: push an event to the UI unless the window is gone.
  const send = <K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]): void => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  // The engine pushes normalized session events to the UI over 'session:event'.
  const sessions = new SessionManager((envelope) => send('session:event', envelope));

  // One SQLite file per user, under Electron's managed userData directory.
  const store = createStore(join(app.getPath('userData'), 'orchestrator.db'));

  // ---------------------------------------------------------------------------
  // Window geometry.
  //
  // Some Linux window managers — WSLg's rootless compositor is the one that bit us —
  // quietly ignore a maximize request for an UNDECORATED window: `maximize()` returns,
  // nothing moves, `isMaximized()` stays false, and the button looks dead. So when the
  // WM hasn't acted shortly after being asked, we maximize by hand: resize to the work
  // area of the display the window sits on, remembering the old bounds so Restore can
  // put them back. `manualBounds` non-null IS the "we maximized it ourselves" flag.
  //
  // This lives up here, before the handlers, because RESTORING a saved `maximized: true`
  // has to go through exactly the same fallback — otherwise a restore would silently do
  // nothing on WSLg, exactly as a click did before the fallback existed.
  let manualBounds: Rectangle | null = null;
  const isMaximized = (): boolean => mainWindow.isMaximized() || manualBounds !== null;
  const pushMaximized = (): void => send('window:maximizedChanged', isMaximized());
  const requestMaximize = (from: Rectangle): void => {
    mainWindow.maximize();
    // The WM answers asynchronously, so an immediate isMaximized() would read false even
    // where maximizing works — give it a beat before deciding it was ignored.
    setTimeout(() => {
      if (mainWindow.isDestroyed() || mainWindow.isMaximized()) return;
      manualBounds = from;
      mainWindow.setBounds(screen.getDisplayMatching(from).workArea);
      pushMaximized();
    }, 300);
  };
  // A real WM maximize supersedes our stand-in, and unmaximize clears it either way.
  mainWindow.on('maximize', () => {
    manualBounds = null;
    pushMaximized();
  });
  mainWindow.on('unmaximize', () => {
    manualBounds = null;
    pushMaximized();
  });

  // Reopen where the last run closed. `createWindow()` runs before the store exists, so
  // this is the first moment the saved value is readable — but the window is still
  // `show: false` until `ready-to-show`, so the correction is never seen. The saved
  // rectangle is only a suggestion: `sanitizeWindowState` reconciles it against the
  // displays that exist NOW, so an unplugged monitor costs you the position but not
  // the size.
  const [minWidth, minHeight] = mainWindow.getMinimumSize();
  const restored = sanitizeWindowState(
    store.loadWindowState(),
    screen.getAllDisplays().map((d) => d.workArea),
    { minWidth, minHeight },
  );
  if (restored.bounds) mainWindow.setBounds(restored.bounds);
  else if (restored.size) mainWindow.setSize(restored.size.width, restored.size.height);
  if (restored.maximized) requestMaximize(mainWindow.getBounds());

  // Track it from here on. Debounced, because a drag emits `move` per frame; flushed
  // synchronously on close and on dispose, which is where the value that matters — the
  // one the next launch reads — is actually written. `getNormalBounds()` is the
  // un-maximized rectangle, and `manualBounds` is our stand-in for the same thing on a
  // WM that wouldn't maximize, so the pair always records the RESTORED size.
  let windowSaveTimer: NodeJS.Timeout | null = null;
  const persistWindowState = (): void => {
    if (mainWindow.isDestroyed()) return;
    store.saveWindowState({
      bounds: manualBounds ?? mainWindow.getNormalBounds(),
      maximized: isMaximized(),
    });
  };
  const scheduleWindowSave = (): void => {
    if (windowSaveTimer) clearTimeout(windowSaveTimer);
    windowSaveTimer = setTimeout(() => {
      windowSaveTimer = null;
      persistWindowState();
    }, 400);
  };
  // Spelled out rather than looped: BrowserWindow's `on` is a set of per-event
  // overloads, so a union of event names has no single overload to match.
  mainWindow.on('resize', scheduleWindowSave);
  mainWindow.on('move', scheduleWindowSave);
  mainWindow.on('maximize', scheduleWindowSave);
  mainWindow.on('unmaximize', scheduleWindowSave);
  const windowTracker = {
    dispose(): void {
      if (windowSaveTimer) {
        clearTimeout(windowSaveTimer);
        windowSaveTimer = null;
      }
      persistWindowState();
    },
  };
  mainWindow.on('close', () => windowTracker.dispose());
  // ---------------------------------------------------------------------------

  // Team orchestrator: each task can run in its own git worktree (under userData),
  // which the scheduler integrates back into base when the task completes.
  const worktrees = new WorktreeManager(join(app.getPath('userData'), 'worktrees'));

  // The scheduler drives tasks through sessions and reports progress to the Board,
  // and raises Attention-inbox items when a task needs a human (Phase 4).
  const scheduler = new Scheduler(
    store,
    sessions,
    (change) => send('task:changed', change),
    (change) => send('scheduler:changed', change),
    (item) => send('attention:new', item),
    (id) => send('attention:resolved', { id }),
    (state) => send('limit:changed', state),
    worktrees,
    (sample) => send('usage:sample', sample),
  );

  // Approving an agent's plan creates that card's subtasks (Phase 11) — a change to the
  // task LIST, which `task:changed` can't express, so the scheduler gets a way to say so.
  scheduler.setTasksChangedNotifier((projectId) =>
    send('project:tasksChanged', { projectId, tasks: store.getTasks(projectId) }),
  );

  // Phase 6: heal tasks the previous run left mid-flight (running/waiting-input →
  // pending, keeping their session id so a re-run resumes them). Runs before the
  // window paints; the UI re-queries project:list on mount and sees the fix.
  // Phase 17: re-open the inbox FIRST. Since an agent's question now genuinely blocks its
  // run, the reason a task is parked has to come back with it — and `reconcileInterrupted`
  // below would otherwise sweep exactly those tasks and throw the question away.
  scheduler.rehydrateAttention();
  scheduler.reconcileInterruptedTasks();

  // Phase 8: watch every project's plan file so edits — including the agent
  // rewriting the plan mid-run — re-sync into the task list live.
  const watcher = new PlanWatcher(store, (projectId, tasks) =>
    send('project:tasksChanged', { projectId, tasks }),
  );
  watcher.watchAll();

  // The permission broker gives the scheduler a TRUE pre-execution veto: the CLI
  // asks it (via an MCP relay) before running each tool, and the scheduler either
  // auto-approves per policy or parks the task until a human answers. Materialize
  // the relay script now and bring the broker up in the background; task runs are
  // ungated only in the brief window before it binds (or if binding fails).
  const mcpDir = join(app.getPath('userData'), 'mcp');
  const broker = new PermissionBroker((request) => scheduler.decidePermission(request));
  void broker
    .start()
    .then((address) => {
      const serverScriptPath = writePermissionServer(mcpDir);
      scheduler.setPermissionGate({
        brokerUrl: address.url,
        token: address.token,
        serverScriptPath,
        configDir: mcpDir,
      });
    })
    .catch((err) => {
      logMain('Permission broker failed to start; task runs will be ungated', err);
    })
    // Restore any usage-limit gate left in force by a previous run AFTER the broker
    // is wired (so tasks resumed at reset are still gated). Runs on both branches.
    .then(() => scheduler.restoreLimitGate());

  /**
   * Moving a project to another machine retires its per-task run state.
   *
   * A session id names a conversation in the CLI's OWN history on the machine that
   * created it, and a worktree is a directory on that machine's filesystem — neither
   * survives the move. Left in place, the next run would issue `--resume <id>` against
   * a CLI that has never heard of it. Cleanup runs against the OLD project row, so the
   * worktrees are removed from where they actually are, before the new target is stored.
   */
  async function retireRunStateIfTargetChanged(id: string, patch: ProjectPatch): Promise<void> {
    const existing = store.getProject(id);
    if (!existing || !patch.target || sameExecTarget(existing.target, patch.target)) return;
    if (scheduler.hasLiveRuns(id)) {
      throw new Error('Stop this project’s running tasks before changing where it executes.');
    }
    for (const task of store.getTasks(id)) {
      try {
        await worktrees.cleanup(existing, task.id);
      } catch (err) {
        // Best effort: the old machine may already be gone. Losing a stale worktree
        // directory is not worth blocking the change the user asked for.
        logMain(`Could not remove worktree for task ${task.id} while changing target`, err);
      }
      if (task.sessionId) store.updateTask(task.id, { sessionId: null });
    }
  }

  // Auto-update. Constructed here rather than with the poller below because it is inert
  // until `start()` — the constructor only reads the platform and `app.isPackaged` — and
  // the handlers below need something to talk to. Everything that touches the network
  // happens in `start()`, which is called last, with the poller.
  const updater = new Updater((state) => send('update:changed', state));

  handle('app:getInfo', async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
  }));

  /**
   * The machines the user's work actually runs on.
   *
   * The built-in Personal board is excluded: it is a card list, not a codebase, and
   * counting its (default, local) target would resurrect the very warning this fixes
   * for someone whose `claude` lives only inside a distro. With no projects yet, the
   * default for new ones is the only meaningful answer.
   */
  const targetsInUse = (): ExecTarget[] => {
    const targets = store
      .listProjects()
      .filter((project) => !isPersonalBoard(project.id))
      .map((project) => project.target);
    return targets.length > 0 ? targets : [store.getSettings().defaultExecTarget];
  };

  handle('claude:getStatus', () => statusForTargets(targetsInUse()));
  handle('claude:listSessions', (cwd, target) => listClaudeSessions(cwd, hostFor(target)));

  handle('exec:listDistros', () => listWslDistros());
  handle('exec:readiness', (target) => readinessFor(target));
  handle('exec:targetsInUse', async () => targetsInUse());

  handle('session:start', async (request) => sessions.start(request));
  handle('session:stop', async (runId) => sessions.stop(runId));
  handle('session:answer', async (runId, message) => sessions.send(runId, message));

  handle('project:pickDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a project folder',
      properties: ['openDirectory'],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  handle('project:pickFile', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a plan file',
      properties: ['openFile'],
      filters: [{ name: 'Plan / Markdown', extensions: ['md', 'markdown', 'txt'] }],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  handle('project:add', async (input) => {
    const project = store.addProject(input);
    // An agent project has no plan file: nothing to parse, nothing to watch.
    if (project.kind === 'agent') return { project, tasks: [] };
    const result = syncProjectPlan(store, project);
    watcher.watch(project); // pick up future edits to its plan file live
    return result;
  });

  handle('project:list', async () =>
    store
      .listProjects()
      // Hide the built-in Personal board — it's the standalone My Tasks board, not a
      // code project, so it must never appear on the Projects tab. Agent projects are
      // hidden too: they belong to My Tasks (managed in Settings), not to this tab.
      .filter((project) => !isPersonalBoard(project.id) && project.kind !== 'agent')
      .map((project) => {
        const tasks = store.getTasks(project.id);
        // A stored `dependsOn` is the persisted form of a plan `@needs:` marker, so a
        // legacy project whose plan already declared deps is confirmed aligned here too.
        const hasMarkers = tasks.some((t) => t.dependsOn.length > 0);
        return { project: ensureAligned(store, project, hasMarkers), tasks };
      }),
  );

  handle('project:remove', async (id) => {
    watcher.unwatch(id);
    store.removeProject(id);
  });

  handle('project:syncPlan', async (id) => {
    const project = store.getProject(id);
    if (!project) return [];
    return syncProjectPlan(store, project).tasks;
  });

  handle('project:setWriteBack', async (id, enabled) => store.setWriteBack(id, enabled));
  handle('project:setAligned', async (id, aligned) => store.setPlanAligned(id, aligned));
  handle('project:update', async (id, patch) => {
    await retireRunStateIfTargetChanged(id, patch);
    const updated = store.updateProject(id, patch);
    if (updated) watcher.watch(updated); // re-point the watcher if the plan path changed
    return updated ?? null;
  });

  handle('project:validatePlan', async (id) => {
    const project = store.getProject(id);
    if (!project) return { ok: true, issues: [] };
    let markdown = '';
    try {
      markdown = readFileSync(appPlanPath(project), 'utf8');
    } catch {
      markdown = '';
    }
    return validatePlan(parsePlan(markdown));
  });

  handle('project:alignPlan', async (id) => {
    const project = store.getProject(id);
    if (!project) throw new Error(`Cannot align: project ${id} not found`);
    // A one-shot, user-initiated run that edits the user's plan.md. Routed through the
    // scheduler (not sessions.start directly) so it's registered under the project and
    // Stop — scheduler:stop — actually terminates it. Ungated and in acceptEdits so it
    // can write the file; the plan watcher re-syncs on the change.
    const { runId } = scheduler.startAuxiliarySession(project.id, {
      prompt: buildAlignPrompt(project.planPath, project.path),
      cwd: project.path,
      model: project.defaultModel,
      permissionMode: 'acceptEdits',
    });
    return { runId };
  });

  // --- Agent projects -------------------------------------------------------
  // A repo directory a My Tasks card can be delegated to. Stored in the same
  // `projects` table (so worktrees, integration, usage attribution and the limit
  // gate work unchanged) but never queued, watched, or listed on the Projects tab.

  handle('agentProject:list', async () =>
    store.listProjects().filter((project) => project.kind === 'agent'),
  );

  handle('agentProject:add', async (input) => store.addProject({ ...input, kind: 'agent' }));

  handle('agentProject:update', async (id, patch) => {
    const existing = store.getProject(id);
    if (!existing || existing.kind !== 'agent') return null;
    // Guard the plan-only fields: an agent project stays plan-less no matter what.
    const { planPath: _planPath, writeBackPlan: _writeBackPlan, ...safe } = patch;
    await retireRunStateIfTargetChanged(id, safe);
    return store.updateProject(id, safe) ?? null;
  });

  handle('agentProject:remove', async (id) => {
    if (scheduler.hasLiveRuns(id)) {
      throw new Error('Stop the agent working in this project before removing it.');
    }
    store.removeProject(id);
  });

  handle('scheduler:start', async (projectId) => scheduler.start(projectId));
  handle('scheduler:pause', async (projectId) => scheduler.pause(projectId));
  handle('scheduler:stop', async (projectId) => scheduler.stop(projectId));
  handle('scheduler:activeRuns', async () => scheduler.activeRuns());
  handle('scheduler:states', async () => scheduler.schedulerStates());
  handle('task:run', async (taskId) => {
    const started = scheduler.runTask(taskId);
    // `runTask` returns null for every "not now" as well as "not found", so say both:
    // the commonest cause by far is the account-wide usage-limit gate.
    if (!started) {
      throw new Error(
        'Cannot start this task now — it is already running, or a usage limit is holding all work.',
      );
    }
    return started;
  });
  handle('task:integrate', async (taskId) => {
    const refusal = await scheduler.integrateNow(taskId);
    if (refusal) throw new Error(refusal);
  });
  handle('task:history', async (taskId) => store.getTaskHistory(taskId));
  handle('task:cleanupWorktree', async (taskId) => {
    const task = store.getTask(taskId);
    if (task && (task.status === 'running' || task.status === 'waiting-input')) {
      throw new Error('Stop the task before cleaning up its worktree.');
    }
    await scheduler.cleanupTaskWorktree(taskId);
  });

  // --- Agent delegation (a My Tasks card → an agent project) ------------------

  handle('task:assignAgent', async (taskId, input) => {
    const existing = store.getTask(taskId);
    if (!existing) throw new Error('Task not found.');
    if (existing.status === 'running' || existing.status === 'waiting-input') {
      throw new Error('This task already has an agent working on it.');
    }
    const target = store.getProject(input.agentProjectId);
    if (!target || target.kind !== 'agent') {
      throw new Error('Pick an agent project to delegate this task to.');
    }
    // The instructions become a timeline comment BEFORE the run starts, so they are
    // visible to the human and are picked up when the prompt is built — including on
    // an auto-retry, which rebuilds the prompt from the timeline.
    const notes = input.notes?.trim();
    if (notes) store.addComment(existing.projectId, taskId, notes);

    // Validated here rather than at worktree-creation time: a bad ref would otherwise
    // surface as a failed run several seconds later, with the reason buried in git's stderr.
    const branch = input.branch?.trim() || null;
    if (branch) {
      const check = validateBranchName(branch);
      if (!check.ok) throw new Error(`That branch name won't work: ${check.reason}.`);
    }

    const task = store.updateTask(taskId, {
      agentProjectId: target.id,
      // Delegating a card to the Billing repo does also say the card is about Billing —
      // but only when nothing else has said otherwise, so an explicit filing wins.
      ...(existing.projectTagId ? {} : { projectTagId: target.id }),
      agentMode: input.mode ?? null,
      agentModel: input.model ?? null,
      agentBranch: branch,
      // A previous attempt's session is not this assignment's; start a fresh
      // conversation so the agent gets the full single-ticket brief.
      sessionId: null,
      // Assigned-but-not-started is `pending`: queued work nobody has begun, which is
      // exactly what TO DO means. The Start button is the affordance, not a new status —
      // adding one would ripple through MANUAL_STATUSES, columnForStatus, statusForColumn,
      // resolveMove and the JIRA transition map.
      status: 'pending',
    });
    if (!task) throw new Error('Task not found.');

    // Assign WITHOUT starting (Phase 17): the human wants to talk to the agent about the
    // card before it begins changing files. Sending it a message starts it (see
    // `resumeForChat`), as does the Start button.
    if (input.start === false) {
      send('task:changed', { task, runId: null });
      return task;
    }

    const started = scheduler.runTask(taskId);
    if (!started) {
      throw new Error(
        'Could not start the agent — a usage limit may be holding all work. Try again after it resets.',
      );
    }
    send('task:changed', { task, runId: started.runId });
    return task;
  });

  handle('task:stopAgent', async (taskId) => {
    const existing = store.getTask(taskId);
    if (!existing) throw new Error('Task not found.');
    scheduler.stopTask(taskId); // no-op (false) when nothing is running for it
    return store.getTask(taskId) ?? existing;
  });
  handle('task:chat', async (taskId, message) => scheduler.chatWithAgent(taskId, message));
  handle('task:create', async (projectId, input) => {
    const task = store.createTask(projectId, input);
    if (!task) throw new Error('A task needs a title.');
    send('project:tasksChanged', { projectId, tasks: store.getTasks(projectId) });
    return task;
  });
  handle('task:delete', async (taskId) => {
    const task = store.getTask(taskId);
    if (!task) return;
    if (task.status === 'running' || task.status === 'waiting-input') {
      throw new Error('Stop the task before deleting it.');
    }
    // Deleting a card takes its steps with it, so a live step blocks the delete too.
    if (
      store.getSubtasks(taskId).some((s) => s.status === 'running' || s.status === 'waiting-input')
    ) {
      throw new Error('Stop the running step before deleting this task.');
    }
    store.deleteTask(taskId);
    send('project:tasksChanged', {
      projectId: task.projectId,
      tasks: store.getTasks(task.projectId),
    });
  });
  handle('task:subtasks', async (parentTaskId) => store.getSubtasks(parentTaskId));
  handle('task:addSubtask', async (parentTaskId, input) => {
    const parent = store.getTask(parentTaskId);
    if (!parent) throw new Error('Task not found.');
    if (parent.parentTaskId) throw new Error('A step cannot have steps of its own.');
    const task = store.addSubtask(parentTaskId, input);
    if (!task) throw new Error('A step needs a title.');
    send('project:tasksChanged', {
      projectId: parent.projectId,
      tasks: store.getTasks(parent.projectId),
    });
    return task;
  });
  handle('task:updateSubtask', async (taskId, patch) => {
    const existing = store.getTask(taskId);
    if (!existing) throw new Error('Task not found.');
    if (!existing.parentTaskId) throw new Error('That task is not a step.');
    if (existing.status === 'running' || existing.status === 'waiting-input') {
      throw new Error('Stop the step before editing it.');
    }
    const title = patch.title?.trim();
    if (patch.title !== undefined && !title) throw new Error('A step needs a title.');
    const task = store.updateTask(taskId, {
      ...(title ? { title } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description?.trim() || null }
        : {}),
    });
    if (!task) throw new Error('Task not found.');
    send('project:tasksChanged', {
      projectId: task.projectId,
      tasks: store.getTasks(task.projectId),
    });
    return task;
  });
  handle('task:setDescription', async (taskId, description) => {
    const existing = store.getTask(taskId);
    if (!existing) throw new Error('Task not found.');
    // The app's copy only — `jiraSync` will overwrite it from the issue on the next
    // sync, and nothing here writes back to the tracker. The pane says as much.
    const task = store.updateTask(taskId, { externalDescription: description.trim() || null });
    if (!task) throw new Error('Task not found.');
    send('task:changed', { task, runId: null });
    return task;
  });

  handle('task:setProject', async (taskId, projectTagId) => {
    const existing = store.getTask(taskId);
    if (!existing) throw new Error('Task not found.');
    if (projectTagId !== null) {
      const target = store.getProject(projectTagId);
      if (!target || target.kind !== 'agent') throw new Error('Unknown project.');
    }
    // Filing only, and now to its OWN column. This used to write `agentProjectId`, the
    // same field delegation writes, so tagging a card as "a Billing card" gave it the
    // agent glyph and made the pane offer to reassign something nobody had assigned.
    const task = store.updateTask(taskId, { projectTagId });
    if (!task) throw new Error('Task not found.');
    send('task:changed', { task, runId: null });
    return task;
  });

  handle('task:setStatusNote', async (taskId, note) => {
    const existing = store.getTask(taskId);
    if (!existing) throw new Error('Task not found.');
    const text = note.trim();
    // File it first, so the timestamp on the card and the one on the timeline agree.
    const entry = text ? store.addStatusNote(existing.projectId, taskId, text) : null;
    const task = store.updateTask(taskId, {
      statusNote: text || null,
      statusNoteAt: entry?.createdAt ?? null,
    });
    if (!task) throw new Error('Task not found.');
    send('task:changed', { task, runId: null });
    return task;
  });

  handle('task:setPriority', async (taskId, priority) => {
    const existing = store.getTask(taskId);
    if (!existing) throw new Error('Task not found.');
    const name = priority?.trim() || null;
    if (name === (existing.externalPriority ?? null)) return existing;

    // JIRA FIRST, exactly like `task:move`: if the tracker rejects the edit (the field
    // isn't on the issue's screen, the name isn't in this workflow, the token lacks
    // permission) we must not end up showing a priority the ticket doesn't have.
    // Clearing is local-only — JIRA priority is usually a required field, and a PUT of
    // `null` would fail on most workflows for no gain.
    if (existing.externalSource === 'jira' && existing.externalKey && name) {
      await buildJiraClient().setPriority(existing.externalKey, name);
    }

    const task = store.updateTask(taskId, { externalPriority: name });
    if (!task) throw new Error('Task not found.');
    send('task:changed', { task, runId: null });
    return task;
  });

  handle('task:setAgentOptions', async (taskId, options) => {
    const existing = store.getTask(taskId);
    if (!existing) throw new Error('Task not found.');
    // Deliberately allowed mid-run: the live run captured its own model/mode when it
    // started (see `Run`), so this only decides what the NEXT run uses. Reassigning is
    // still what you want if you mean "start over with these settings".
    const task = store.updateTask(taskId, {
      ...(options.model !== undefined ? { agentModel: options.model } : {}),
      ...(options.mode !== undefined ? { agentMode: options.mode } : {}),
    });
    if (!task) throw new Error('Task not found.');
    send('task:changed', { task, runId: null });
    return task;
  });

  handle('task:setStatus', async (taskId, status) => {
    const existing = store.getTask(taskId);
    if (!existing) throw new Error('Task not found.');
    if (!isManualStatus(status)) throw new Error(`"${status}" is not a hand-settable status.`);
    // The scheduler owns a task while it runs; don't let a manual change desync it.
    if (existing.status === 'running' || existing.status === 'waiting-input') {
      throw new Error('Stop the running session before changing status.');
    }
    if (existing.status === status) return existing;
    const task = store.updateTask(taskId, { status });
    if (!task) throw new Error('Task not found.');
    store.recordStatusChange(task.projectId, taskId, existing.status, status);
    send('task:changed', { task, runId: null });
    return task;
  });
  handle('task:activity', async (taskId) => store.getTaskActivity(taskId));
  handle('task:addComment', async (taskId, body) => {
    const task = store.getTask(taskId);
    if (!task) throw new Error('Task not found.');
    const entry = store.addComment(task.projectId, taskId, body);
    if (!entry) throw new Error('A comment needs some text.');
    return entry;
  });
  handle('task:deleteComment', async (commentId) => store.deleteComment(commentId));
  handle('task:attachSession', async (taskId, sessionId) => {
    const existing = store.getTask(taskId);
    if (!existing) return null;
    // Don't rewire a task the scheduler is actively running under a live session.
    if (existing.status === 'running' || existing.status === 'waiting-input') {
      throw new Error('Stop the task before attaching a session.');
    }
    const task = store.updateTask(taskId, { sessionId: sessionId.trim(), status: 'pending' });
    if (task) send('task:changed', { task, runId: null }); // keep the Board in sync
    return task ?? null;
  });

  handle('attention:list', async () => scheduler.listAttention());
  handle('attention:answer', async (itemId, answer) => scheduler.answerAttention(itemId, answer));

  handle('limit:current', async () => scheduler.currentLimit());
  handle('limit:resumeNow', async () => scheduler.resumeLimitNow());

  // Performance dashboard: roll the rolling-5h-window samples into a summary, and
  // serve the time-bucketed series for the live chart. All computed by the app from
  // the CLI's own token counts — no AI agent is involved in the math.
  handle('usage:summary', async (sinceMs) => {
    const now = Date.now();
    // sinceMs is an absolute epoch start; 0 (or anything ≤ 0) means all-time.
    const windowStart = sinceMs > 0 ? sinceMs : 0;
    const samples = store.getUsageSamples(windowStart);
    const pressure = scheduler.getUsagePressure();
    const projectNames = new Map<string, string>();
    const taskTitles = new Map<string, string>();
    for (const project of store.listProjects()) {
      projectNames.set(project.id, project.name);
      for (const task of store.getTasks(project.id)) taskTitles.set(task.id, task.title);
    }
    return rollupWindow(samples, {
      now,
      windowStart,
      // The CLI reports resetsAt in Unix seconds; the UI counts down in ms.
      windowReset: pressure.resetsAt != null ? pressure.resetsAt * 1000 : null,
      projectNames,
      taskTitles,
      limitStatus: pressure.status,
      limitActive: pressure.limitActive,
      windowCost: store.getWindowCost(windowStart),
    });
  });
  handle('usage:series', async (sinceMs, bucketMs) =>
    bucketSeries(store.getUsageSamples(sinceMs), sinceMs, bucketMs, Date.now()),
  );

  handle('settings:get', async () => store.getSettings());
  handle('settings:save', async (settings) => {
    // Normalize the JIRA URL once, on the way in, so every consumer sees the same
    // origin — the client, the epic-field and identity caches (both keyed by baseUrl),
    // and the issue links written onto cards.
    store.saveSettings({
      ...settings,
      jira: {
        ...settings.jira,
        baseUrl: normalizeBaseUrl(settings.jira.baseUrl),
        cloudEmail: settings.jira.cloudEmail.trim(),
      },
    });
    // Pick up a changed poll interval (or enable/disable) without a restart.
    jiraPoller.reschedule();
    gitlabPoller.reschedule();
  });

  // Whether the token is being protected by the weak built-in password rather than an
  // OS keyring. `setUsePlainTextEncryption(true)` in main/index.ts makes storage WORK on
  // a keyring-less Linux box; this is what lets the UI be honest about what it bought.
  // `getSelectedStorageBackend` only exists on Linux, hence the platform guard.
  const usesPlainTextStorage = (): boolean =>
    process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text';

  // Build a JIRA client from current settings + the decrypted token, or throw a
  // user-facing error explaining what's missing. The token never leaves the main
  // process: it's stored encrypted and decrypted here on demand.
  const buildJiraClient = (): JiraClient => {
    const { jira } = store.getSettings();
    if (!jira.baseUrl.trim()) throw new Error('Set the JIRA base URL in Settings first.');
    // Cloud authenticates as email + API token. Without the email we'd send
    // `Basic base64(":token")`, which JIRA rejects as a plain 401 — indistinguishable
    // from a bad token, and the reason this was so hard to diagnose.
    if (jira.deployment === 'cloud' && !jira.cloudEmail.trim()) {
      throw new Error(
        'Atlassian Cloud signs in with your account email plus an API token — ' +
          'add the email in Settings.',
      );
    }
    const cipher = store.loadJiraToken();
    if (!cipher) throw new Error('No JIRA token saved — add one in Settings.');
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS secure storage is unavailable, so the saved token cannot be read.');
    }
    const token = safeStorage.decryptString(Buffer.from(cipher, 'base64'));
    return createJiraClient(jira, token);
  };

  handle('jira:getConfigStatus', async () => {
    const { jira } = store.getSettings();
    return {
      enabled: jira.enabled,
      hasToken: store.loadJiraToken() !== null,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      plainTextStorage: usesPlainTextStorage(),
      deployment: jira.deployment,
      baseUrl: jira.baseUrl,
    };
  });

  handle('jira:setCredentials', async (pat) => {
    if (!pat.trim()) {
      store.clearJiraToken();
      return { ok: true, message: 'Token cleared.' };
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return {
        ok: false,
        message: 'OS secure storage is unavailable, so the token was not saved.',
      };
    }
    store.saveJiraToken(safeStorage.encryptString(pat).toString('base64'));
    return {
      ok: true,
      message: usesPlainTextStorage()
        ? 'Token saved — but this machine has no keyring, so it is only obfuscated on disk.'
        : 'Token saved.',
    };
  });

  handle('jira:clearCredentials', async () => store.clearJiraToken());

  handle('jira:testConnection', async () => {
    try {
      const me = await buildJiraClient().testConnection();
      return { ok: true, displayName: me.displayName, message: `Connected as ${me.displayName}.` };
    } catch (e) {
      // Keep the full error (including `cause`) in the log; show the diagnosis on screen.
      logMain('JIRA test connection failed', e);
      return { ok: false, message: explainJiraFailure(e, store.getSettings().jira) };
    }
  });

  // -------------------------------------------------------------------------
  // GitLab. Mirrors the JIRA block above; the token is encrypted the same way and
  // never leaves this process.
  const buildGitLabClient = (): GitLabClient => {
    const { gitlab } = store.getSettings();
    if (!gitlab.baseUrl.trim()) throw new Error('Set the GitLab URL in Settings first.');
    const cipher = store.loadGitLabToken();
    if (!cipher) throw new Error('No GitLab token saved — add one in Settings.');
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS secure storage is unavailable, so the saved token cannot be read.');
    }
    const token = safeStorage.decryptString(Buffer.from(cipher, 'base64'));
    return new GitLabClient({ baseUrl: gitlab.baseUrl, token });
  };

  handle('gitlab:getConfigStatus', async () => {
    const { gitlab } = store.getSettings();
    return {
      enabled: gitlab.enabled,
      hasToken: store.loadGitLabToken() !== null,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      plainTextStorage: usesPlainTextStorage(),
      // GitLab has one auth mode, but the shared status shape carries a deployment;
      // 'server' is the honest answer for both gitlab.com and a self-hosted instance.
      deployment: 'server' as const,
      baseUrl: gitlab.baseUrl,
    };
  });

  handle('gitlab:setCredentials', async (token) => {
    if (!token.trim()) {
      store.clearGitLabToken();
      return { ok: true, message: 'Token cleared.' };
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, message: 'OS secure storage is unavailable, so the token was not saved.' };
    }
    store.saveGitLabToken(safeStorage.encryptString(token).toString('base64'));
    return {
      ok: true,
      message: usesPlainTextStorage()
        ? 'Token saved — but this machine has no keyring, so it is only obfuscated on disk.'
        : 'Token saved.',
    };
  });

  handle('gitlab:clearCredentials', async () => store.clearGitLabToken());

  handle('gitlab:testConnection', async () => {
    try {
      const me = await buildGitLabClient().getMe();
      return { ok: true, displayName: me.username, message: `Connected as ${me.username}.` };
    } catch (e) {
      logMain('GitLab test connection failed', e);
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  });

  /** The account behind the GitLab token, cached per instance. Fails soft to null. */
  const gitlabIdentity = async (
    baseUrl: string,
    client: GitLabClient,
  ): Promise<GitLabIdentityCache | null> => {
    const cached = store.loadGitLabIdentity();
    if (cached && cached.baseUrl === baseUrl) return cached;
    try {
      const identity = gitlabIdentityFrom(await client.getMe(), baseUrl);
      store.saveGitLabIdentity(identity);
      return identity;
    } catch {
      return null;
    }
  };

  /** The board's keys and the cards behind them, for matching MRs to tasks. */
  const boardKeyIndex = (): { knownKeys: string[]; taskIdByKey: Map<string, string> } => {
    const taskIdByKey = new Map<string, string>();
    for (const task of store.getPersonalTasks()) {
      if (task.externalSource === 'jira' && task.externalKey) {
        taskIdByKey.set(task.externalKey.toUpperCase(), task.id);
      }
    }
    return { knownKeys: [...taskIdByKey.keys()], taskIdByKey };
  };

  /**
   * One GitLab sync: list your open MRs, re-read detail only for the ones that moved,
   * reconcile, push.
   *
   * The N+1 is deliberate and bounded. The global list does not reliably carry
   * `head_pipeline`, approvals or reviewers — the very fields attention depends on — so
   * they need a call per MR; we make those calls only for MRs whose `updated_at` moved
   * since we last looked, and at a concurrency of 4.
   */
  const syncGitLab = async (): Promise<MergeRequest[]> => {
    const { gitlab } = store.getSettings();
    if (!gitlab.enabled) return store.listMergeRequests();
    const client = buildGitLabClient();
    const identity = await gitlabIdentity(gitlab.baseUrl, client);
    const stored = store.listMergeRequests();
    const priorById = new Map(stored.map((mr) => [mr.id, mr]));
    const list = await client.listMyMergeRequests();

    const detailed: FetchedMergeRequest[] = [];
    const queue = [...list];
    const worker = async (): Promise<void> => {
      for (let mr = queue.shift(); mr; mr = queue.shift()) {
        const id = mergeRequestId(mr.project_id, mr.iid);
        const prior = priorById.get(id);
        const updatedAt = Date.parse(mr.updated_at) || 0;
        const stale = needsDetailRefresh(prior, updatedAt);
        detailed.push(await describeMergeRequest(client, mr, { stale, prior }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));

    const { knownKeys, taskIdByKey } = boardKeyIndex();
    const { upserts, deleteIds } = reconcileMergeRequests(stored, detailed, {
      knownKeys,
      taskIdByKey,
      identity,
      now: Date.now(),
    });
    for (const mr of upserts) store.upsertMergeRequest(mr);
    store.deleteMergeRequests(deleteIds);
    const all = store.listMergeRequests();
    send('gitlab:mergeRequestsChanged', all);
    return all;
  };

  handle('gitlab:sync', async () => {
    try {
      return await syncGitLab();
    } catch (e) {
      logMain('GitLab sync failed', e);
      throw new Error(e instanceof Error ? e.message : String(e));
    }
  });

  /** Re-file stored MRs against the board as it is now. Cheap, and no network. */
  function rematchStoredMergeRequests(): void {
    const stored = store.listMergeRequests();
    if (!stored.length) return;
    const changed = rematchMergeRequests(stored, boardKeyIndex());
    if (!changed.length) return;
    for (const mr of changed) store.upsertMergeRequest(mr);
    send('gitlab:mergeRequestsChanged', store.listMergeRequests());
  }

  handle('gitlab:mergeRequests', async () => store.listMergeRequests());

  handle('gitlab:markRead', async (mrId) => {
    store.markMergeRequestRead(mrId, Date.now());
    const all = store.listMergeRequests();
    send('gitlab:mergeRequestsChanged', all);
    return all;
  });

  handle('gitlab:markEventsSeen', async (mrId) => {
    store.markMergeRequestEventsSeen(mrId, Date.now());
    const all = store.listMergeRequests();
    send('gitlab:mergeRequestsChanged', all);
    return all;
  });
  // -------------------------------------------------------------------------

  /**
   * The instance's priority names, fetched once per site per app run.
   *
   * In memory rather than in `app_state` (unlike the epic/sprint field ids): the list
   * is cheap to fetch, and a restart re-reading it is better than a persisted cache
   * going stale after an admin edits the scale. Fails soft to `[]` — the pane then
   * offers the built-in scale, which is a working dropdown rather than an empty one.
   */
  let priorityCache: { baseUrl: string; names: string[] } | null = null;

  handle('jira:priorities', async () => {
    const { jira } = store.getSettings();
    if (!jira.enabled || !jira.baseUrl) return [];
    if (priorityCache?.baseUrl === jira.baseUrl) return priorityCache.names;
    try {
      const names = await buildJiraClient().listPriorities();
      priorityCache = { baseUrl: jira.baseUrl, names };
      return names;
    } catch (e) {
      logMain('JIRA priority list failed', e);
      return [];
    }
  });

  /** The instance's workflow statuses — same cache-per-site, fail-soft rule as priorities. */
  let statusCache: { baseUrl: string; statuses: JiraStatusOption[] } | null = null;

  handle('jira:statuses', async () => {
    const { jira } = store.getSettings();
    if (!jira.enabled) return { statuses: [], error: 'JIRA is switched off.' };
    if (!jira.baseUrl) return { statuses: [], error: 'No JIRA site URL is configured.' };
    if (statusCache?.baseUrl === jira.baseUrl) {
      return { statuses: statusCache.statuses, error: null };
    }
    try {
      const raw = await buildJiraClient().listStatuses();
      // De-duplicated by name: an instance with several workflows repeats "In Progress"
      // once per workflow scheme, and the map is keyed by name, so one entry is all the
      // form can act on. Sorted so the list reads the same on every instance.
      const byName = new Map<string, JiraStatusOption>();
      for (const s of raw) {
        const name = s.name.trim();
        if (name && !byName.has(name.toLowerCase())) {
          byName.set(name.toLowerCase(), { name, category: categoryFromKey(s.categoryKey) });
        }
      }
      const statuses = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
      statusCache = { baseUrl: jira.baseUrl, statuses };
      return { statuses, error: null };
    } catch (e) {
      logMain('JIRA status list failed', e);
      return { statuses: [], error: e instanceof Error ? e.message : String(e) };
    }
  });

  /**
   * What the Add-task dialog can create. Both lists are permission-filtered by JIRA, so
   * an empty one is a real answer — the dialog says so rather than looking broken — and
   * both fail soft, since a dead create path must not take the local Add-task path with
   * it. Cached per site (and per project for types), like priorities and statuses.
   */
  let projectCache: { baseUrl: string; projects: JiraProjectOption[] } | null = null;
  const issueTypeCache = new Map<string, JiraIssueTypeOption[]>();

  handle('jira:projects', async () => {
    const { jira } = store.getSettings();
    if (!jira.enabled || !jira.baseUrl) return [];
    if (projectCache?.baseUrl === jira.baseUrl) return projectCache.projects;
    try {
      const projects = normalizeProjects(await buildJiraClient().listProjects());
      projectCache = { baseUrl: jira.baseUrl, projects };
      return projects;
    } catch (e) {
      logMain('JIRA project list failed', e);
      return [];
    }
  });

  handle('jira:issueTypes', async (projectKey) => {
    const { jira } = store.getSettings();
    if (!jira.enabled || !jira.baseUrl || !projectKey) return [];
    const cacheKey = `${jira.baseUrl}|${projectKey}`;
    const cached = issueTypeCache.get(cacheKey);
    if (cached) return cached;
    try {
      const raw = await buildJiraClient().listIssueTypes(projectKey);
      const types = normalizeIssueTypes(raw, projectKey);
      issueTypeCache.set(cacheKey, types);
      return types;
    } catch (e) {
      logMain('JIRA issue-type list failed', e);
      return [];
    }
  });

  handle('jira:createTask', async (input) => {
    const settings = store.getSettings();
    const { jira } = settings;
    if (!jira.enabled) throw new Error('JIRA is switched off.');
    if (!input.summary.trim()) throw new Error('A JIRA issue needs a summary.');
    const client = buildJiraClient();
    const created = await client.createIssue({ ...input, summary: input.summary.trim() });

    // Read the issue back and run it through the SAME reconciler a sync uses, rather
    // than hand-building a Task. A hand-built one would differ from what the next poll
    // produces — a different status, a missing field — and appear to mutate on its own.
    const epicField = await epicFieldId(jira.baseUrl, client);
    const sprintField = await sprintFieldId(jira.baseUrl, client);
    const extraFields = [epicField, sprintField].filter((f): f is string => f !== null);
    const issue = await client.getIssue(created.key, extraFields);
    const { upserts } = reconcileJiraTasks([], [issue], {
      baseUrl: jira.baseUrl,
      overrides: jira.statusCategoryOverrides,
      learned: jira.learnedStatusColumns,
      epicFieldId: epicField,
      sprintFieldId: sprintField,
      identity: await jiraIdentity(jira.baseUrl, client),
    });
    const task = upserts[0];
    if (!task) throw new Error(`JIRA created ${created.key} but it could not be read back.`);
    store.upsertJiraTask(task);

    // Remember the choice for next time. Behind the UI's back, so it goes out on
    // `settings:changed` — a screen that saves the whole blob would otherwise clobber it.
    if (jira.lastCreateProjectKey !== input.projectKey || jira.lastCreateIssueTypeId !== input.issueTypeId) {
      const next: AppSettings = {
        ...settings,
        jira: {
          ...jira,
          lastCreateProjectKey: input.projectKey,
          lastCreateIssueTypeId: input.issueTypeId,
        },
      };
      store.saveSettings(next);
      send('settings:changed', next);
    }

    send('project:tasksChanged', {
      projectId: PERSONAL_PROJECT_ID,
      tasks: store.getPersonalTasks(),
    });
    return task;
  });

  handle('board:tasks', async () => store.getPersonalTasks());

  /**
   * The instance's "Epic Link" custom field id, discovered once and cached in
   * `app_state`. Re-discovered when the configured base URL changes (the field id is
   * per-site). A null `fieldId` is a cached *negative* result — Cloud team-managed
   * sites have no such field and expose the epic as `parent` instead — so the lookup
   * is not repeated on every sync.
   */
  const epicFieldId = async (baseUrl: string, client: JiraClient): Promise<string | null> => {
    const cached = store.loadJiraEpicField();
    if (cached && cached.baseUrl === baseUrl) return cached.fieldId;
    const fieldId = await discoverEpicFieldId(client);
    store.saveJiraEpicField({ fieldId, baseUrl });
    return fieldId;
  };

  /** The instance's "Sprint" custom field id — same cache-by-site rule as the epic. */
  const sprintFieldId = async (baseUrl: string, client: JiraClient): Promise<string | null> => {
    const cached = store.loadJiraSprintField();
    if (cached && cached.baseUrl === baseUrl) return cached.fieldId;
    const fieldId = await discoverSprintFieldId(client);
    store.saveJiraSprintField({ fieldId, baseUrl });
    return fieldId;
  };

  /**
   * The account behind the configured PAT, fetched once per site and cached in
   * `app_state` (see `jira/identity.ts`). Fails soft to null: not knowing who you are
   * costs a bubble's alignment, while a thrown error would cost the comment thread.
   */
  const jiraIdentity = async (
    baseUrl: string,
    client: JiraClient,
  ): Promise<JiraIdentityCache | null> => {
    const cached = store.loadJiraIdentity();
    if (cached && cached.baseUrl === baseUrl) return cached;
    try {
      const identity = identityFrom(await client.testConnection(), baseUrl);
      store.saveJiraIdentity(identity);
      return identity;
    } catch {
      return null;
    }
  };

  /**
   * Epic key → epic NAME, for the issues that did not carry their parent inline.
   *
   * Cloud team-managed projects return the parent's own fields with the issue, so those
   * cost nothing. The Epic Link custom field carries a bare key, so those epics have to
   * be looked up — but as ONE `key in (...)` search for every distinct epic on the board,
   * not one request per card.
   *
   * Fails soft: the name is decoration (the card falls back to the key), and a board that
   * refused to sync because an epic lookup 400'd would be a far worse trade.
   */
  const fetchEpicNames = async (
    client: JiraClient,
    issues: JiraIssue[],
    epicField: string | null,
  ): Promise<Map<string, string>> => {
    const names = new Map<string, string>();
    const wanted = new Set<string>();
    for (const issue of issues) {
      if (epicNameFromIssue(issue)) continue; // came inline, nothing to look up
      const key = epicKeyFromIssue(issue, epicField);
      if (key) wanted.add(key);
    }
    if (wanted.size === 0) return names;
    try {
      const epics = await client.search(`key in (${[...wanted].join(',')})`, wanted.size, []);
      for (const epic of epics) {
        const summary = epic.fields.summary?.trim();
        if (summary) names.set(epic.key.toUpperCase(), summary);
      }
    } catch {
      // Leave the map empty — every card falls back to its epic key.
    }
    return names;
  };

  // One JIRA sync: fetch issues, reconcile into the store, push the fresh board.
  // Shared by the manual `jira:sync` handler and the background poller below.
  const syncJira = async (): Promise<Task[]> => {
    const { jira } = store.getSettings();
    if (!jira.enabled) return store.getPersonalTasks();
    const client = buildJiraClient();
    // The epic field is requested by its discovered id, so tickets carry the epic key
    // that resolves a card to the agent project owning it.
    const epicField = await epicFieldId(jira.baseUrl, client);
    // The sprint field is fetched whether or not the board is filtered to the current
    // sprint: the name is worth showing either way, and it is what tells you which
    // sprint a card belongs to once several are running at once.
    const sprintField = await sprintFieldId(jira.baseUrl, client);
    // Who the PAT belongs to, so a comment the user wrote in the JIRA web UI does not
    // light their own card orange on the way back in. Cached per site; null is fine.
    const identity = await jiraIdentity(jira.baseUrl, client);
    const jql = jira.currentSprintOnly ? withCurrentSprint(jira.jql) : jira.jql;
    const extraFields = [epicField, sprintField].filter((f): f is string => f !== null);
    const issues = await client.search(jql, 100, extraFields);
    const epicNames = await fetchEpicNames(client, issues, epicField);
    const { upserts, deleteIds } = reconcileJiraTasks(store.getPersonalTasks(), issues, {
      baseUrl: jira.baseUrl,
      overrides: jira.statusCategoryOverrides,
      learned: jira.learnedStatusColumns,
      epicFieldId: epicField,
      epicNames,
      sprintFieldId: sprintField,
      identity,
    });
    for (const t of upserts) store.upsertJiraTask(t);
    for (const id of deleteIds) store.deleteTask(id);
    const tasks = store.getPersonalTasks();
    send('project:tasksChanged', { projectId: PERSONAL_PROJECT_ID, tasks });
    // The board just changed shape, so an MR whose ticket has appeared should attach
    // itself and one whose ticket has left should let go rather than point at a card
    // that no longer exists. No GitLab call — this is re-filing what we already hold.
    rematchStoredMergeRequests();
    return tasks;
  };

  // Rethrow with the diagnosis attached, so the board's error bar explains a bad
  // deployment/credential the same way the Settings "Test connection" button does.
  handle('jira:sync', async () => {
    try {
      return await syncJira();
    } catch (e) {
      logMain('JIRA sync failed', e);
      throw new Error(explainJiraFailure(e, store.getSettings().jira));
    }
  });

  /**
   * Remember that a JIRA status means the column the user just dropped a card into.
   *
   * A drag that transitions a ticket is the strongest possible statement about what a
   * workflow's status means — you looked at the board, picked the column, and JIRA
   * accepted the move. Before this, that knowledge was thrown away: the outgoing
   * transition could be chosen by the name heuristic while the incoming sync read the
   * same status by its category, so the very next sync moved the card back.
   *
   * Only ever *adds* — a name the user mapped in Settings is left alone, since an
   * explicit answer outranks an inferred one. A status already resolving to this
   * column needs no entry either, which keeps the learned map small and the Settings
   * viewer readable.
   */
  const learnStatusColumn = (
    statusName: string,
    category: JiraStatusCategory,
    column: BoardColumn,
  ): void => {
    const name = statusName.trim();
    if (!name) return;
    const settings = store.getSettings();
    const { jira } = settings;
    const current = resolveStatusColumn(
      name,
      category,
      jira.statusCategoryOverrides,
      jira.learnedStatusColumns,
    );
    if (current.reason === 'explicit' || current.column === column) return;
    const next: AppSettings = {
      ...settings,
      jira: {
        ...jira,
        learnedStatusColumns: { ...jira.learnedStatusColumns, [name]: column },
      },
    };
    store.saveSettings(next);
    send('settings:changed', next);
  };

  handle('task:move', async (taskId, toColumn) => {
    const existing = store.getTask(taskId);
    if (!existing) throw new Error('Task not found.');
    if (existing.status === 'running' || existing.status === 'waiting-input') {
      throw new Error('Stop the running session before moving this task.');
    }
    const move = resolveMove(existing, toColumn);
    if (move.noop) return existing;

    const patch: Parameters<Store['updateTask']>[1] = {
      status: move.localStatus,
      preBlockStatus: move.preBlockStatus,
    };

    // Apply the JIRA transition FIRST. If it fails, throw without changing local state
    // so the optimistic card move rolls back and JIRA/local stay consistent.
    if (move.jiraTransition && existing.externalSource === 'jira' && existing.externalKey) {
      const client = buildJiraClient();
      const { jira } = store.getSettings();
      const transitions = await client.getTransitions(existing.externalKey);
      const picked = pickTransition(transitions, move.jiraTransition, jira);
      if (!picked) {
        const target =
          move.jiraTransition === 'toInProgress'
            ? 'In Progress'
            : move.jiraTransition === 'toInReview'
              ? 'In Review'
              : 'Done';
        throw new Error(
          `No JIRA transition to ${target} is available for ${existing.externalKey}. ` +
            `Set an exact transition name in Settings if your workflow uses a custom one.`,
        );
      }
      await client.doTransition(existing.externalKey, picked.id);
      // Reflect the new tracker status locally for display.
      patch.externalStatus = picked.to.name;
      patch.externalStatusCategory = categoryFromKey(picked.to.statusCategory.key);
      learnStatusColumn(picked.to.name, categoryFromKey(picked.to.statusCategory.key), toColumn);
    }

    const task = store.updateTask(taskId, patch);
    if (!task) throw new Error('Task not found.');
    store.recordStatusChange(task.projectId, taskId, existing.status, move.localStatus);
    send('task:changed', { task, runId: null });
    return task;
  });

  // Brief a delegated card's agent with the ticket's comment thread (oldest first).
  // The scheduler has no JIRA client of its own, so it calls back in here on each fresh
  // agent run; anything unlinked or unconfigured yields no comments rather than an error.
  scheduler.setTicketCommentProvider(async (task) => {
    const { jira } = store.getSettings();
    if (!jira.enabled || task.externalSource !== 'jira' || !task.externalKey) return [];
    const comments = await buildJiraClient().getComments(task.externalKey);
    return comments
      .map((c) => ({
        author: c.author?.displayName ?? 'JIRA',
        body: commentBodyToText(c.body),
        createdAt: Date.parse(c.created) || 0,
      }))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ author, body }) => ({ author, body }));
  });

  handle('jira:fetchComments', async (taskId) => {
    const task = store.getTask(taskId);
    if (!task || task.externalSource !== 'jira' || !task.externalKey) return [];
    const client = buildJiraClient();
    const comments = await client.getComments(task.externalKey);
    // Who the PAT belongs to, so the pane can put your own comments on your side.
    // Unknown identity → every comment reads as someone else's, deliberately.
    const identity = await jiraIdentity(store.getSettings().jira.baseUrl, client);
    // Attachment metadata is per-ISSUE, so one extra call serves every comment; each
    // comment then claims the files it names. Fail-soft — a comment without its
    // attachment links is still worth reading.
    const attachments = await client.getAttachments(task.externalKey).catch((e: unknown) => {
      logMain('JIRA attachment list failed', e);
      return [];
    });
    const entries = comments.map((c) => {
      const rich = parseAdf(c.body);
      const body = blocksToText(rich);
      return {
        kind: 'jira-comment' as const,
        id: c.id,
        author: c.author?.displayName ?? 'JIRA',
        body,
        createdAt: Date.parse(c.created) || 0,
        mine: authorIsMe(c.author, identity),
        rich,
        // Matched by filename appearing in the comment: JIRA gives no comment→file
        // link, and citing the name is exactly how our own composer references one.
        attachments: attachments
          .filter((a) => a.filename && body.includes(a.filename))
          .map((a) => ({
            filename: a.filename,
            url: a.url,
            mimeType: a.mimeType,
            size: a.size,
          })),
      };
    });
    // Keep the unread marker honest with freshly-fetched comments — but only OTHER
    // people's. Folding your own back in here would undo `markRead` the instant the
    // pane opened, re-lighting a card over a comment you wrote yourself.
    const latest = entries
      .filter((e) => !e.mine)
      .reduce((m, e) => Math.max(m, e.createdAt), task.latestCommentAt ?? 0);
    if (latest && latest !== task.latestCommentAt) {
      store.updateTask(taskId, { latestCommentAt: latest });
    }
    return entries;
  });

  /**
   * Who this instance calls people, for the @mention picker. Cached per site+query so
   * typing a name doesn't hammer the API, and fail-soft: an empty picker still lets the
   * user type a plain name, which posts as ordinary text.
   */
  const userCache = new Map<string, JiraUserOption[]>();

  handle('jira:searchUsers', async (taskId, query) => {
    const { jira } = store.getSettings();
    if (!jira.enabled || !query.trim()) return [];
    const task = store.getTask(taskId);
    const issueKey = task?.externalSource === 'jira' ? (task.externalKey ?? undefined) : undefined;
    const cacheKey = `${jira.baseUrl}|${issueKey ?? ''}|${query.trim().toLowerCase()}`;
    const cached = userCache.get(cacheKey);
    if (cached) return cached;
    try {
      const users = await buildJiraClient().searchUsers(query, issueKey);
      const options: JiraUserOption[] = users.map((u) => ({
        // Cloud names people by accountId; Server/DC by username. Either is what a
        // mention node needs — they are just never both present.
        id: u.accountId ?? u.name,
        displayName: u.displayName,
        email: u.emailAddress,
        avatarUrl: u.avatarUrl,
      }));
      userCache.set(cacheKey, options);
      return options;
    } catch (e) {
      logMain('JIRA user search failed', e);
      return [];
    }
  });

  handle('jira:pickAttachments', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Attach files to the JIRA issue',
      properties: ['openFile', 'multiSelections'],
    });
    return result.canceled ? [] : result.filePaths;
  });

  handle('jira:addComment', async (taskId, draft) => {
    const task = store.getTask(taskId);
    if (!task || task.externalSource !== 'jira' || !task.externalKey) {
      throw new Error('This task is not linked to a JIRA issue.');
    }
    // Trailing whitespace only. Leading whitespace has to stay: the mention ranges are
    // offsets into this exact string, and trimming the front would move all of them.
    // A mention left dangling past the cut is dropped by `buildAdf`.
    const text = draft.text.replace(/\s+$/, '');
    const paths = draft.attachmentPaths ?? [];
    if (!text && !paths.length) throw new Error('A comment needs some text.');
    const client = buildJiraClient();

    // Upload first, so the comment can cite what actually landed. A failed upload is a
    // failed comment — posting the words without the file the user attached would be a
    // quietly wrong result rather than an error they can act on.
    const uploaded = paths.length
      ? await client.uploadAttachments(
          task.externalKey,
          paths.map((p) => ({ filename: basename(p), data: readFileSync(p) })),
        )
      : [];

    const mentions = (draft.mentions ?? []).map((m) => ({
      start: m.start,
      end: m.end,
      accountId: m.id,
      displayName: m.displayName,
    }));
    const created = await client.addComment(
      task.externalKey,
      text,
      mentions,
      uploaded.map((a) => ({ filename: a.filename, url: a.url ?? undefined })),
    );
    // Bump both markers so our own comment never lights the unread border.
    const at = Date.parse(created.created) || Date.now();
    const updated = store.updateTask(taskId, { latestCommentAt: at, lastReadCommentAt: at });
    if (updated) send('task:changed', { task: updated, runId: null });
  });

  handle('jira:markRead', async (taskId) => {
    const task = store.getTask(taskId);
    if (!task) throw new Error('Task not found.');
    if (task.externalSource !== 'jira') return task;
    const updated = store.updateTask(taskId, {
      lastReadCommentAt: task.latestCommentAt ?? Date.now(),
    });
    if (updated) send('task:changed', { task: updated, runId: null });
    return updated ?? task;
  });

  // Frameless-window controls for the renderer's custom title bar, plus a push so
  // the title bar's maximize/restore icon tracks OS-driven changes (snap, drag).
  // The state behind them (`manualBounds`, `requestMaximize`) is set up near the top,
  // because restoring the saved geometry has to happen before the window is shown.
  handle('window:minimize', async () => mainWindow.minimize());
  handle('window:toggleMaximize', async () => {
    if (isMaximized()) {
      const restoreTo = manualBounds;
      manualBounds = null;
      if (restoreTo) mainWindow.setBounds(restoreTo);
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      pushMaximized();
      return;
    }
    requestMaximize(mainWindow.getBounds());
    // No push here: on the path where the WM does its job, its `maximize` event is what
    // reports the new state, and isMaximized() is still false this instant on Linux.
  });
  handle('window:close', async () => mainWindow.close());
  handle('window:isMaximized', async () => isMaximized());

  // Auto-update. The updater is constructed near the top (it is inert until `start()`);
  // these three are the whole surface the UI gets — the rest arrives on `update:changed`.
  handle('update:get', async () => updater.current());
  handle('update:check', () => updater.checkNow());
  handle('update:install', async () => updater.install());

  // Background poll: keep the Personal board fresh on the user's configured cadence
  // (JIRA setting `pollIntervalMinutes`; 0 = off). Re-armed whenever settings change.
  // Constructed AFTER every handle() call on purpose: anything that can throw while
  // registering would otherwise leave the API half-wired — some channels live, the
  // ones below it missing — which is the same failure mode as a dead engine, only
  // harder to spot.
  const jiraPoller = new JiraPoller(store, syncJira);
  jiraPoller.reschedule();

  // Its own timer on its own setting: a pipeline turns red on a machine's timescale,
  // not a human's, so 2 minutes is the default rather than JIRA's 5.
  const gitlabPoller = new GitLabPoller(store, syncGitLab);
  gitlabPoller.reschedule();

  // Same reasoning: the updater's first feed request is scheduled here, once every
  // channel is live, so a network stall can never delay handler registration.
  updater.start();

  return {
    sessions,
    scheduler,
    store,
    broker,
    watcher,
    jiraPoller,
    gitlabPoller,
    updater,
    windowTracker,
  };
}
