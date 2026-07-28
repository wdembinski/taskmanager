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
import {
  app,
  dialog,
  ipcMain,
  safeStorage,
  screen,
  type BrowserWindow,
  type Rectangle,
} from 'electron';
import type { IpcApi, IpcEvents, JiraStatusOption } from '@shared/ipc';
import {
  isManualStatus,
  isPersonalBoard,
  PERSONAL_PROJECT_ID,
  type Project,
  type ProjectPatch,
  type ProjectWithTasks,
  type Task,
} from '@shared/model';
import { categoryFromKey } from '@shared/board';
import { sameExecTarget, type ExecTarget } from '@shared/execTarget';
import { normalizeBaseUrl } from '@shared/jiraUrl';
import { createJiraClient } from './jira/jiraConfig';
import { explainJiraFailure } from './jira/jiraDiagnostics';
import { commentBodyToText, type JiraClient } from './jira/jiraClient';
import { reconcileJiraTasks } from './jira/jiraSync';
import { discoverEpicFieldId } from './jira/epicField';
import { discoverSprintFieldId, withCurrentSprint } from './jira/jiraSprint';
import { authorIsMe, identityFrom, type JiraIdentityCache } from './jira/identity';
import { pickTransition, resolveMove } from './jira/jiraMove';
import { listWslDistros, readinessFor, statusForTargets } from './exec';
import { appPlanPath } from './projectPaths';
import { logMain } from './log';
import { parsePlan } from './planParser';
import { planHasAlignmentMarkers, validatePlan } from './planValidate';
import { buildAlignPrompt } from './alignPrompt';
import { PermissionBroker } from './permissionBroker';
import { writePermissionServer } from './permissionServerSource';
import { PlanWatcher } from './planWatcher';
import { JiraPoller } from './jiraPoller';
import { Scheduler } from './scheduler';
import { SessionManager } from './sessionManager';
import { createStore, type Store } from './store';
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

    const task = store.updateTask(taskId, {
      agentProjectId: target.id,
      agentMode: input.mode ?? null,
      agentModel: input.model ?? null,
      // A previous attempt's session is not this assignment's; start a fresh
      // conversation so the agent gets the full single-ticket brief.
      sessionId: null,
      status: 'pending',
    });
    if (!task) throw new Error('Task not found.');

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

  handle('task:setProject', async (taskId, agentProjectId) => {
    const existing = store.getTask(taskId);
    if (!existing) throw new Error('Task not found.');
    if (agentProjectId !== null) {
      const target = store.getProject(agentProjectId);
      if (!target || target.kind !== 'agent') throw new Error('Unknown project.');
    }
    // Only the association. No session reset, no worktree, no run — see `task:setProject`
    // in the contract for why this is not `task:assignAgent`.
    const task = store.updateTask(taskId, { agentProjectId });
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
    // Pick up a changed JIRA poll interval (or enable/disable) without a restart.
    jiraPoller.reschedule();
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
    if (!jira.enabled || !jira.baseUrl) return [];
    if (statusCache?.baseUrl === jira.baseUrl) return statusCache.statuses;
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
      return statuses;
    } catch (e) {
      logMain('JIRA status list failed', e);
      return [];
    }
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
    const jql = jira.currentSprintOnly ? withCurrentSprint(jira.jql) : jira.jql;
    const extraFields = [epicField, sprintField].filter((f): f is string => f !== null);
    const issues = await client.search(jql, 100, extraFields);
    const { upserts, deleteIds } = reconcileJiraTasks(store.getPersonalTasks(), issues, {
      baseUrl: jira.baseUrl,
      overrides: jira.statusCategoryOverrides,
      epicFieldId: epicField,
      sprintFieldId: sprintField,
    });
    for (const t of upserts) store.upsertJiraTask(t);
    for (const id of deleteIds) store.deleteTask(id);
    const tasks = store.getPersonalTasks();
    send('project:tasksChanged', { projectId: PERSONAL_PROJECT_ID, tasks });
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
    const entries = comments.map((c) => ({
      kind: 'jira-comment' as const,
      id: c.id,
      author: c.author?.displayName ?? 'JIRA',
      body: commentBodyToText(c.body),
      createdAt: Date.parse(c.created) || 0,
      mine: authorIsMe(c.author, identity),
    }));
    // Keep the unread marker honest with freshly-fetched comments.
    const latest = entries.reduce((m, e) => Math.max(m, e.createdAt), task.latestCommentAt ?? 0);
    if (latest && latest !== task.latestCommentAt) {
      store.updateTask(taskId, { latestCommentAt: latest });
    }
    return entries;
  });

  handle('jira:addComment', async (taskId, body) => {
    const task = store.getTask(taskId);
    if (!task || task.externalSource !== 'jira' || !task.externalKey) {
      throw new Error('This task is not linked to a JIRA issue.');
    }
    if (!body.trim()) throw new Error('A comment needs some text.');
    const created = await buildJiraClient().addComment(task.externalKey, body.trim());
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
  //
  // Some Linux window managers — WSLg's rootless compositor is the one that bit us —
  // quietly ignore a maximize request for an UNDECORATED window: `maximize()` returns,
  // nothing moves, `isMaximized()` stays false, and the button looks dead. So when the
  // WM hasn't acted shortly after being asked, we maximize by hand: resize to the work
  // area of the display the window sits on, remembering the old bounds so Restore can
  // put them back. `manualBounds` non-null IS the "we maximized it ourselves" flag.
  let manualBounds: Rectangle | null = null;
  const isMaximized = (): boolean => mainWindow.isMaximized() || manualBounds !== null;
  const pushMaximized = (): void => send('window:maximizedChanged', isMaximized());

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
    const before = mainWindow.getBounds();
    mainWindow.maximize();
    // The WM answers asynchronously, so an immediate isMaximized() would read false even
    // where maximizing works — give it a beat before deciding it was ignored.
    setTimeout(() => {
      if (mainWindow.isDestroyed() || mainWindow.isMaximized()) return;
      manualBounds = before;
      mainWindow.setBounds(screen.getDisplayMatching(before).workArea);
      pushMaximized();
    }, 300);
    // No push here: on the path where the WM does its job, its `maximize` event is what
    // reports the new state, and isMaximized() is still false this instant on Linux.
  });
  handle('window:close', async () => mainWindow.close());
  handle('window:isMaximized', async () => isMaximized());
  // A real WM maximize supersedes our stand-in, and unmaximize clears it either way.
  mainWindow.on('maximize', () => {
    manualBounds = null;
    pushMaximized();
  });
  mainWindow.on('unmaximize', () => {
    manualBounds = null;
    pushMaximized();
  });

  // Background poll: keep the Personal board fresh on the user's configured cadence
  // (JIRA setting `pollIntervalMinutes`; 0 = off). Re-armed whenever settings change.
  // Constructed AFTER every handle() call on purpose: anything that can throw while
  // registering would otherwise leave the API half-wired — some channels live, the
  // ones below it missing — which is the same failure mode as a dead engine, only
  // harder to spot.
  const jiraPoller = new JiraPoller(store, syncJira);
  jiraPoller.reschedule();

  return { sessions, scheduler, store, broker, watcher, jiraPoller };
}
