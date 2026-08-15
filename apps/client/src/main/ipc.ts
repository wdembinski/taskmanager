/**
 * Registers the main-process handlers for every INVOKE channel in the IPC
 * contract (src/shared/ipc.ts). Think of this as the app's "backend routes".
 *
 * `ipcMain.handle(channel, fn)` says: "when the UI calls `channel`, run `fn` and
 * send whatever it returns back as the reply." The small `handle()` helper below
 * makes each registration type-safe against the shared `IpcApi` interface, so a
 * handler whose return type doesn't match the contract won't compile.
 *
 * **There is no test harness for this file, and that is the design.** Standing up a
 * `BrowserWindow`, a store and a fake `ipcMain` would test the wiring, and the bugs are
 * never in the wiring. A decision that needs testing gets MOVED OUT instead, into a pure
 * module with its own `.test.ts` — `resolveMove`, `pickTransition` and `shouldLearnStatus`
 * in `jira/jiraMove.ts`, `needsBlockOwner` in `blockOwnerMigration.ts`, the status resolver
 * in `@tm/shared`. `shouldLearnStatus` is the worked example: it lived inline here, where
 * it could not be tested at all, until the drag-into-Blocked bug turned out to be inside
 * it. What is meant to be left in a handler is a call, a `send` and a patch; a handler
 * growing a rule it alone knows is the signal to extract, not to build the harness.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import {
  app,
  dialog,
  ipcMain,
  safeStorage,
  screen,
  shell,
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
  isPlanProject,
  isRepoProject,
  PERSONAL_PROJECT_ID,
  type BoardColumn,
  type JiraStatusCategory,
  type Project,
  type ProjectPatch,
  type ProjectWithTasks,
  type Task,
  type TaskStatus,
} from '@shared/model';
import {
  ARCHIVE_RETENTION_DAYS,
  categoryFromKey,
  columnForStatus,
  JIRA_BOARD_LIMIT,
  restingStatus,
} from '@shared/board';
import { assignmentStatusPatch, humanStatusPatch } from './cardStatusGuard';
import { isBlockedishStatus, resolveGitHubColumn } from '@shared/statusResolve';
import type { AppSettings } from '@shared/settings';
import { sameExecTarget, type ExecTarget } from '@shared/execTarget';
import { normalizeBaseUrl } from '@shared/jiraUrl';
import { sanitizeToken, tokenHadNoise } from '@shared/secretToken';
import { createJiraClient } from './jira/jiraConfig';
import { explainJiraFailure } from './jira/jiraDiagnostics';
import { probeJiraAuth } from './jira/jiraAuthProbe';
import { commentBodyToText, JiraError, type JiraClient, type JiraIssue } from './jira/jiraClient';
import { blocksToText, parseAdf } from './jira/adf';
import { normalizeIssueTypes, normalizeProjects } from './jira/createMeta';
import {
  issueToBoardTask,
  reconcileJiraTasks,
  removalCandidateKeys,
  retainedKeys,
} from './jira/jiraSync';
import { confirmStillMatching, recheckByKey } from './jira/jiraConfirm';
import { chunkKeys, keysInJql } from './jira/jiraJql';
import { discoverEpicFieldId, epicKeyFromIssue, epicNameFromIssue } from './jira/epicField';
import { discoverSprintFieldId, withCurrentSprint } from './jira/jiraSprint';
import { authorIsMe, identityFrom, type JiraIdentityCache } from './jira/identity';
import {
  COLUMN_LABEL,
  pickTransition,
  resolveMove,
  shouldLearnStatus,
  TARGET_LABEL,
  type JiraTransitionTarget,
  type MoveResolution,
} from './jira/jiraMove';
import { iamSignInConfig } from './iamConfig';
import { signIn as runIamSignIn } from './iamSignIn';
import { refreshTokens } from '@shared/iamPkce';
import type { ClientInfo, CommandEnvelope } from '@protocol/wire';
import { PROTOCOL_VERSION } from '@protocol/wire';
import { applyCloudCommand, type CloudCommandOutcome } from './cloudCommands';
import { CommandQueue } from './commandQueue';
import { relayRegistry } from './ipcRegistry';
import { CloudAttachmentUploader, fetchUploadBytes } from './cloudAttachmentUploader';
import { CloudEventForwarder } from './cloudEventForwarder';
import { CloudPoller } from './cloudPoller';
import { testCloudConnection } from './cloudTestConnection';
import { FocusTracker } from './focusTracker';
import { GitLabClient } from './gitlab/gitlabClient';
import {
  GitHubClient,
  GitHubError,
  type GitHubIssueComment,
  type GitHubSearchIssueItem,
} from './github/githubClient';
import { githubAuthorIsMe, githubIdentityFrom, type GitHubIdentityCache } from './github/identity';
import { buildCommentBody } from './github/githubComment';
import {
  categoryForColumn,
  issuesToRecheck,
  parseIssueKey,
  reconcileGitHubIssues,
  type IssueRef,
} from './github/githubIssueSync';
import {
  planLabelChange,
  resolveMove as resolveGitHubMove,
  shouldLearnLabel,
} from './github/githubMove';
import { gitlabIdentityFrom, type GitLabIdentityCache } from './gitlab/identity';
import { describeMergeRequest } from './gitlab/describeMergeRequest';
import {
  describePullRequest,
  listedFromDetail,
  repoRefFromApiUrl,
} from './github/describePullRequest';
import {
  landedTaskIds,
  mergeRequestId,
  needsDetailRefresh,
  reconcileMergeRequests,
  rematchMergeRequests,
  type FetchedMergeRequest,
} from './gitlab/gitlabSync';
import { reconcilePullRequests, rematchPullRequests } from './github/githubPrSync';
import { mrIsSettled, type ForgeProvider, type MergeRequest } from '@shared/mergeRequest';
import { canLink, isLinkGate, type LinkResult, type TaskLink } from '@shared/taskChain';
import type { TaskAttachment } from '@shared/attachments';
import {
  addAttachments,
  deleteAttachmentFile,
  deleteTaskAttachments,
  registerAttachmentProtocol,
  sweepOrphanAttachments,
} from './attachments';
import { attachmentFile } from './attachmentPaths';
import { collectUploads } from './uploadedAttachments';
import type { ServiceSyncState, SyncServiceId, SyncState } from '@shared/sync';
import { hostFor, listWslDistros, readinessFor, statusForTargets } from './exec';
import { gitPreflight } from './git';
import { emptyGitGraph } from '@shared/gitGraph';
import { cardBranchesFor, readGitGraph } from './gitGraph';
import { listClaudeSessions } from './claudeSessions';
import { sanitizeWindowState } from './windowState';
import { createWindowStateFlusher, type WindowStateFlusher } from './windowFlush';
import { appPlanPath, appProjectFile } from './projectPaths';
import { RELEASE_DOC } from '@shared/release';
import { openPullRequest, type CreatePrDeps } from './forge/createPr';
import { RUN_REFUSAL_MESSAGE } from '@shared/scheduler';
import { logMain } from './log';
import { parsePlan } from './planParser';
import { planHasAlignmentMarkers, validatePlan } from './planValidate';
import { buildContractScaffold, CONTRACT_DOC, insertContractTasks } from './planAlign';
import { buildAlignPrompt } from './alignPrompt';
import { PermissionBroker } from './permissionBroker';
import { writePermissionServer } from './permissionServerSource';
import { openInteractiveSignIn, watchForSignIn } from './signIn';
import { PlanWatcher } from './planWatcher';
import { SyncPoller } from './syncPoller';
import { ClaudeUsagePoller, readClaudeUsage } from './claudeUsage';
import { validateBranchName } from '@shared/branchName';
import { LIMIT_PROBE_TIMEOUT_MS, Scheduler } from './scheduler';
import { SessionManager } from './sessionManager';
import { createStore, type Store } from './store';
import { Updater } from './updater';
import { bucketSeries, rollupQuotas, rollupWindow } from './usageRollup';
import { WorktreeManager } from './worktreeManager';

/**
 * Type-safe wrapper around ipcMain.handle. `K` is constrained to a real channel
 * name, and the handler's return type must match that channel's contract.
 *
 * It also records the handler in `relayRegistry`, which is how a browser tab reaches this
 * same code: a relayed `ipc-invoke` looks the channel up there and runs THIS function, not a
 * cloud-flavoured copy of it. See `ipcRegistry.ts`. Registering unconditionally rather than
 * only for relayable channels is deliberate — the registry does the classifying, and a
 * `handle()` call that also had to remember to opt in would be the thing everyone forgets.
 */
function handle<K extends keyof IpcApi>(
  channel: K,
  handler: (...args: Parameters<IpcApi[K]>) => ReturnType<IpcApi[K]>,
): void {
  ipcMain.handle(channel, (_event, ...args) => handler(...(args as Parameters<IpcApi[K]>)));
  relayRegistry.register(channel, handler as (...args: never[]) => unknown);
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

/**
 * How long an archived card is kept before the boot sweep destroys it for good.
 *
 * Not a setting, and not `JiraSettings.doneRetentionDays` either — that one decides how long a
 * FINISHED card stays visible in the Done column, which is a matter of taste. This is the point
 * at which the app stops holding a row nobody has looked at in half a year, and the only tuning
 * anybody wants on it is "longer".
 *
 * The number itself lives in `@shared/board` because Settings states it to the human, and a
 * bound stated in one place and enforced in another drifts.
 */
const ARCHIVE_RETENTION_MS = ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** What registerIpcHandlers hands back so the app can shut resources down cleanly. */
export interface Engine {
  sessions: SessionManager;
  scheduler: Scheduler;
  store: Store;
  broker: PermissionBroker;
  watcher: PlanWatcher;
  /** The one background timer that refreshes every integration. */
  syncPoller: SyncPoller;
  /** The cloud mirror's own timer — seconds-scale, server-directed, and separate from
   * `syncPoller` on purpose; see `cloudPoller.ts`'s own header. */
  cloudPoller: CloudPoller;
  /** The push half of the same mirror: every `IpcEvents` push, batched to `POST /v1/events`.
   * Holds a timer and a queue, so it is disposed on quit like every other one. */
  cloudEvents: CloudEventForwarder;
  /** Pushes attachment BYTES to the cloud so a browser can preview them — its own pass,
   *  holding a timer between files, so it is disposed on quit like every other one. */
  cloudAttachments: CloudAttachmentUploader;
  /** The `BrowserWindow` focus/idle signal `cloudPoller` polls on — its listeners outlive
   * the window's own close handlers, so it is disposed alongside every other timer. */
  focusTracker: FocusTracker;
  /** Keeps the CLI's own `/usage` reading fresh for the two quota bars. */
  claudeUsagePoller: ClaudeUsagePoller;
  updater: Updater;
  /** Flushes the window geometry — must be disposed BEFORE the store closes. */
  windowTracker: WindowStateFlusher;
}

/**
 * Wire up all invoke handlers and the engine. Called once during app startup
 * with the main window (needed so the engine can push events to the UI). Returns
 * the engine so the caller can stop sessions and close the DB on quit.
 */
export function registerIpcHandlers(mainWindow: BrowserWindow): Engine {
  // The cloud's copy of everything `send` pushes. Constructed INERT here, at the top of the
  // function, because `send` is defined on the next line and everything it needs to actually
  // send — the store, the access token — is declared hundreds of lines below;
  // `cloudEvents.configure(...)` supplies those beside `cloudPoller`. Until then it queues
  // nothing, and it queues nothing afterwards either unless a browser is watching.
  const cloudEvents = new CloudEventForwarder();

  // The cloud's copy of an attachment's BYTES, and inert for the same reason: the attachment
  // handlers below call `scan()` on it, and everything it needs to actually push — the store,
  // the access token — is declared far below them. `configure(...)` supplies those beside
  // `cloudPoller`, and until then every `scan()` is a no-op.
  const cloudAttachments = new CloudAttachmentUploader();

  // Small helper: push an event to the UI unless the window is gone.
  //
  // This is the single choke point for the whole `IpcEvents` surface — `webContents.send`
  // appears exactly once in this file, and `SessionManager` is constructed with a callback
  // that goes through here — so mirroring the engine to the browser is this one line rather
  // than a per-channel fan-out that the next new channel would forget to join.
  //
  // Outside the `isDestroyed` guard on purpose: a closed desktop window says nothing about
  // whether somebody has the web app open.
  const send = <K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]): void => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
    cloudEvents.publish(channel, payload);
  };

  // The engine pushes normalized session events to the UI over 'session:event'.
  const sessions = new SessionManager((envelope) => send('session:event', envelope));

  // One SQLite file per user, under Electron's managed userData directory. The same
  // directory holds the attachment bytes (`attachments/<taskId>/<name>`), which is why the
  // root is hoisted into a name rather than joined inline as it was.
  const userData = app.getPath('userData');
  const store = createStore(join(userData, 'orchestrator.db'));

  // Attachment rows cascade away with a deleted task; their FILES cannot — no cascade
  // reaches outside the database. Deleting a PROJECT is the path that proves one handler
  // is not enough: it takes its tasks with it (store.ts:446) without `task:delete` ever
  // running, and so does a crash between the copy and the insert. One pass at boot removes
  // every attachment directory no row names, which covers both, plus whatever later path
  // forgets. Not awaited — nothing that follows depends on it, and a slow disk must not
  // hold the window up.
  void sweepOrphanAttachments(store, userData).catch((e) =>
    logMain('Sweeping orphaned attachments failed', e),
  );

  // A card taken off the board keeps its row forever unless something eventually lets go, and
  // "forever" is the wrong answer for a board that removes cards every sync. So one pass at
  // boot, beside the attachment sweep above: anything archived longer ago than
  // ARCHIVE_RETENTION_MS is destroyed exactly as `task:delete` would destroy it.
  //
  // Half a year, and generous on purpose. This is the one place the app throws away work
  // nobody asked it to throw away, so the number has to be long past the point where somebody
  // might still say "wait, where did that go" — and an archived card costs a row, not a
  // column. Logged rather than silent for the same reason.
  {
    const removed = store.pruneArchivedBefore(Date.now() - ARCHIVE_RETENTION_MS);
    if (removed > 0)
      logMain(`Pruned ${removed} card(s) archived over ${ARCHIVE_RETENTION_DAYS} days ago`);
  }

  // Serve `vipper-attachment://a/<id>` — how the window shows an image it is never told
  // the path of. Here rather than in `index.ts` beside the scheme's privileges, because
  // `protocol.handle` needs both a ready app and the store, and here it also inherits the
  // guarantee it needs: `registerIpcHandlers` runs exactly ONCE. (`app.on('activate')` at
  // `index.ts:175` only calls `createWindow`.) Registering a scheme twice throws.
  registerAttachmentProtocol(store, userData);

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

  // The cloud mirror's one local presence signal (Phase 25) — is a human looking at this
  // window right now. Wired here, beside the maximize/unmaximize pair above, for the same
  // reason they are: both are raw `BrowserWindow` events this module is already listening
  // to. `cloudPoller` (constructed near `syncPoller`, below) is the only consumer.
  const focusTracker = new FocusTracker(mainWindow);

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
  // The debounce, the disposed flag and the "is a write safe right now" guard all live in
  // `windowFlush.ts` — see its header for why the last two are not optional on quit.
  const windowTracker = createWindowStateFlusher({
    read: () => ({
      bounds: manualBounds ?? mainWindow.getNormalBounds(),
      maximized: isMaximized(),
    }),
    write: (state) => store.saveWindowState(state),
    canWrite: () => !mainWindow.isDestroyed() && store.isOpen(),
  });
  // Spelled out rather than looped: BrowserWindow's `on` is a set of per-event
  // overloads, so a union of event names has no single overload to match.
  mainWindow.on('resize', windowTracker.schedule);
  mainWindow.on('move', windowTracker.schedule);
  mainWindow.on('maximize', windowTracker.schedule);
  mainWindow.on('unmaximize', windowTracker.schedule);
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

  // A merge changes nothing about the task while it runs, so it needs a channel of its own
  // to say it is happening at all — otherwise pressing Merge looks like pressing nothing.
  scheduler.setIntegratingNotifier((taskIds) => send('task:integrating', taskIds));

  // The sign-in gate drives both the banner and the status bar's dot, so it goes out on
  // its own channel rather than being folded into `claude:getStatus` — that one answers
  // "is there a credentials file", which stayed true for the whole outage this exists for.
  scheduler.setAuthNotifier((state) => send('auth:changed', state));

  // The corroborating witness for a usage limit the CLI only stated in prose: `/usage` is a
  // LOCAL meta-command (no tokens, no turns — see `claudeUsage.ts`), so the scheduler can
  // afford to ask before it parks the whole board. Asked fresh rather than read off
  // `claudeUsagePoller`, whose cached reading can be ten minutes old — the question here is
  // "is the account out of budget right now", and ten minutes is the whole of the answer.
  scheduler.setUsageProbe(() => readClaudeUsage(undefined, LIMIT_PROBE_TIMEOUT_MS));

  // Phase 22: where the attached bytes live, so a prompt can hand the agent real paths.
  // `app.getPath` is Electron's, and the scheduler is unit-tested without it — so the root
  // is injected here, exactly as the store's own path is.
  scheduler.setAttachmentRoot(userData);

  // Phase 6: heal tasks the previous run left mid-flight (running/waiting-input →
  // pending, keeping their session id so a re-run resumes them). Runs before the
  // window paints; the UI re-queries project:list on mount and sees the fix.
  // Phase 17: re-open the inbox FIRST. Since an agent's question now genuinely blocks its
  // run, the reason a task is parked has to come back with it — and `reconcileInterrupted`
  // below would otherwise sweep exactly those tasks and throw the question away.
  scheduler.rehydrateAttention();
  scheduler.reconcileInterruptedTasks();
  // Then let the chain of execution catch up: a card whose predecessor landed while the app
  // was closed has been waiting since, and nothing else would ever ask again. After the
  // reconcile above, so the two sweeps cannot both decide what to do with one card — this
  // one starts only cards that have never run at all.
  scheduler.reconsiderChains('boot');

  // Phase 8: watch every project's plan file so edits — including the agent
  // rewriting the plan mid-run — re-sync into the task list live.
  const watcher = new PlanWatcher(store, (projectId, tasks) =>
    send('project:tasksChanged', { projectId, tasks }),
  );
  watcher.watchAll();

  // A successful `claude` login rewrites the credentials file, which is the one signal
  // that the gate can lift WITHOUT the human coming back to tell us — so the common path
  // is: banner appears, they press Sign in, they log in, work resumes on its own. Guarded
  // on the gate being up so an unrelated credential refresh never nudges the scheduler.
  const stopSignInWatch = watchForSignIn(() => {
    if (scheduler.currentAuth()) scheduler.signedIn();
  });
  mainWindow.on('close', () => stopSignInWatch());

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
    // Restore any gate left in force by a previous run AFTER the broker is wired (so
    // tasks resumed at reset are still gated). Runs on both branches. The sign-in gate
    // goes first: it starts nothing, and a limit restoring into a dead credential should
    // find the other gate already up rather than walk its parked set into it.
    .then(() => {
      // The recipes first: restoring a limit whose reset has already passed resumes its
      // parked set on the spot, and a resume with an empty table rebuilds a release run —
      // or a chat reply — as ordinary work on the card (see `parkedRun.ts`).
      scheduler.restoreParkedRuns();
      scheduler.restoreAuthGate();
      scheduler.restoreLimitGate();
    });

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
      // `isRepoProject`, not "not the Personal board": a ticket project has no directory
      // either, so its target is only whatever the default was the day it was created, and
      // counting it would resurrect the very warning this filter exists to suppress.
      .filter(isRepoProject)
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

  // Asked while the add/edit form is open, on a path that may not be a project yet — so it
  // takes the raw path + target instead of an id. Never throws: a preflight that blew up must
  // degrade to "unknown" (advisory) rather than break the form the human is filling in.
  handle('project:gitPreflight', async (path, target) => {
    if (!path.trim()) return { state: 'unknown' as const };
    try {
      return await gitPreflight(path, hostFor(target));
    } catch (e) {
      return { state: 'unknown' as const, detail: e instanceof Error ? e.message : String(e) };
    }
  });

  /**
   * The project repo's commit graph. Reads from every board, not just this project's tasks:
   * a card delegated to an agent project lives on the Personal board, and its branch is one
   * of the ones worth naming in the drawing.
   */
  handle('git:graph', async (projectId, limit) => {
    const project = store.getProject(projectId);
    if (!project) return emptyGitGraph('That project is no longer in the app.');
    const tasks = store.listProjects().flatMap((p) => store.getTasks(p.id));
    return readGitGraph(project, cardBranchesFor(tasks, projectId), limit);
  });

  handle('project:add', async (input) => {
    const project = store.addProject(input);
    // Only a plan project has a plan file: for an agent or a ticket project there is
    // nothing to parse and nothing to watch. Asked as `isPlanProject` rather than as
    // `kind === 'agent'`, so a fourth kind cannot inherit the plan-parsing path by default.
    if (!isPlanProject(project)) return { project, tasks: [] };
    const result = syncProjectPlan(store, project);
    watcher.watch(project); // pick up future edits to its plan file live
    return result;
  });

  handle('project:list', async () =>
    store
      .listProjects()
      // Only plan projects belong on the Projects tab. The built-in Personal board is the
      // standalone My Tasks board rather than a code project; agent projects belong to My
      // Tasks (managed in Settings); a ticket project has its own surface. Stated as the
      // kind we WANT — the old `!personal && kind !== 'agent'` would have listed every new
      // kind on this tab by default.
      .filter(isPlanProject)
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

    const planPath = appPlanPath(project);
    let markdown = '';
    try {
      markdown = readFileSync(planPath, 'utf8');
    } catch {
      markdown = '';
    }

    // Whether there is any dependency judgement left is decided on the plan AS THE HUMAN
    // WROTE IT — before our own edit below, which would otherwise count as an alignment
    // marker and talk us out of the one thing the agent is actually for. Same predicate as
    // the validator's "no dependencies declared" advisory, so Align answers the nudge that
    // asked for it, and nothing else.
    const written = parsePlan(markdown);
    const needsJudgement = written.length >= 2 && !planHasAlignmentMarkers(written);

    // The mechanical half, in code: the `@contract` task is a literal line, and the phases
    // that want one are the ones `planValidate` already names. Deterministic, instant, free
    // — and the plan watcher re-syncs on the write, same as any hand edit.
    const { markdown: aligned, phases } = insertContractTasks(markdown);
    if (phases.length > 0) {
      writeFileSync(planPath, aligned, 'utf8');
      const contractPath = appProjectFile(project, CONTRACT_DOC);
      // Never overwrite a contract someone already wrote — this is a scaffold, and the
      // contract tasks flesh it out in place from here on.
      if (!existsSync(contractPath)) {
        writeFileSync(contractPath, buildContractScaffold(phases), 'utf8');
      }
    }

    // Nothing to judge: the whole run was the mechanical half, and it is already done.
    if (!needsJudgement) return { runId: null, contractPhases: phases };

    // A one-shot, user-initiated run that edits the user's plan.md. Routed through the
    // scheduler (not sessions.start directly) so it's registered under the project and
    // Stop — scheduler:stop — actually terminates it. Ungated and in acceptEdits so it
    // can write the file; the plan watcher re-syncs on the change.
    //
    // Rewriting the plan IS planning, so it takes the planning model — falling back to
    // the execution one, which is what NULL means there. No card is involved, so there is
    // no per-card override to out-rank it and no `resolveRunModel` call to make.
    const { runId } = scheduler.startAuxiliarySession(project.id, {
      prompt: buildAlignPrompt(project.planPath, project.path),
      cwd: project.path,
      model: project.planningModel ?? project.defaultModel,
      permissionMode: 'acceptEdits',
    });
    return { runId, contractPhases: phases };
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
  handle('scheduler:integrating', async () => scheduler.integratingTaskIds());
  handle('task:run', async (taskId) => {
    const outcome = scheduler.startTaskNow(taskId);
    // The engine names the wall it hit; one map turns that into the sentence the human
    // reads. This used to guess — "already running, or a usage limit" — for all six
    // reasons at once, which meant a signed-out account was reported as a usage limit and
    // the one action that would fix it (sign in) went unsaid.
    if ('refused' in outcome) throw new Error(RUN_REFUSAL_MESSAGE[outcome.refused]);
    return outcome;
  });
  handle('task:integrate', async (taskId) => {
    const refusal = await scheduler.integrateNow(taskId);
    if (refusal) throw new Error(refusal);
  });
  handle('project:hasReleaseDoc', async (projectId) => {
    const project = store.getProject(projectId);
    // `appProjectFile`, not `join`: a WSL project's path is a Linux one, and this process
    // opens the same file under `\\wsl.localhost\<distro>\…`.
    return Boolean(project?.path) && existsSync(appProjectFile(project!, RELEASE_DOC));
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
      // ...and no column change. Delegating a card says who does the work, not where the
      // work belongs: a ticket resting in IN REVIEW that you hand to an agent is still in
      // review. This used to write `pending` unconditionally, on the reasoning that
      // assigned-but-not-started IS what TO DO means — true of a card already in TO DO,
      // and a card-moving bug everywhere else. Only a card resting nowhere gets a status
      // now; see `assignmentStatusPatch`.
      ...assignmentStatusPatch(existing),
    });
    if (!task) throw new Error('Task not found.');

    // Assign WITHOUT starting (Phase 17): the human wants to talk to the agent about the
    // card before it begins changing files. Sending it a message starts it (see
    // `resumeForChat`), as does the Start button.
    //
    // Deliberately NOT a moment the chain is re-asked at (Phase 21). Every other route
    // that can make a card releasable gained a re-ask; this one is left out because
    // assigning a card either starts it already — the branch below calls `runTask` — or is
    // `start: false`, which is the human staging the card on purpose. Re-asking here would
    // start the run they had just declined to start.
    if (input.start === false) {
      send('task:changed', { task, runId: null });
      return task;
    }

    const outcome = scheduler.startTaskNow(taskId);
    if ('refused' in outcome) {
      // The assignment itself stuck — the card IS delegated now, and if a gate refused the
      // start it is parked behind that gate and will begin by itself. Say so before
      // throwing, or the board would keep drawing an undelegated card and the human would
      // assign it a second time.
      send('task:changed', { task, runId: null });
      throw new Error(RUN_REFUSAL_MESSAGE[outcome.refused]);
    }
    send('task:changed', { task, runId: outcome.runId });
    return task;
  });

  handle('task:stopAgent', async (taskId) => {
    const existing = store.getTask(taskId);
    if (!existing) throw new Error('Task not found.');
    scheduler.stopTask(taskId); // no-op (false) when nothing is running for it
    return store.getTask(taskId) ?? existing;
  });

  handle('task:resumeAgent', async (taskId) => {
    const existing = store.getTask(taskId);
    if (!existing) throw new Error('Task not found.');
    const outcome = scheduler.resumeTask(taskId);
    // Re-read either way: a resume re-queues stopped steps and clears `stoppedAt` BEFORE it
    // tries to start, so even a refused one has changed the card — and a gate that refuses
    // has parked it to start by itself. Announcing that before throwing is what keeps the
    // board from drawing a card as still stopped while the engine is holding it. Same shape
    // as `task:assignAgent` above, and the same refusal vocabulary as `task:run`.
    const task = store.getTask(taskId) ?? existing;
    send('task:changed', { task, runId: 'runId' in outcome ? outcome.runId : null });
    if ('refused' in outcome) throw new Error(RUN_REFUSAL_MESSAGE[outcome.refused]);
    return task;
  });
  handle('task:chat', async (taskId, message) => scheduler.chatWithAgent(taskId, message));
  handle('task:replan', async (taskId, note) => scheduler.replanCard(taskId, note));
  handle('task:create', async (projectId, input) => {
    // The same check `task:setProject` makes, for the same reason: filing is only ever
    // under an agent project, and a card created with a dangling tag would wear a colour
    // stripe nothing on the board could explain.
    if (input.projectTagId) {
      const target = store.getProject(input.projectTagId);
      if (!target || target.kind !== 'agent') throw new Error('Unknown project.');
    }
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
    // Read once and kept: the same ids name the attachment directories to remove below,
    // and after `deleteTask` there is nothing left to ask.
    const steps = store.getSubtasks(taskId);
    if (steps.some((s) => s.status === 'running' || s.status === 'waiting-input')) {
      throw new Error('Stop the running step before deleting this task.');
    }
    store.deleteTask(taskId);
    send('project:tasksChanged', {
      projectId: task.projectId,
      tasks: store.getTasks(task.projectId),
    });
    // The card's chain links cascaded away with it, so the board has to be told — an
    // arrow left drawn to a card that is gone is the exact failure the cascade prevents
    // in the database and this prevents on screen.
    pushChainLinks();
    // Its attachment rows went the same way, and the same argument applies to the chips.
    pushAttachments();
    // The BYTES did not: no cascade reaches outside the database. After `deleteTask` has
    // returned, never inside its transaction — a throw in there would roll the row
    // deletion back and leave a card half-deleted, which is worse than either half alone.
    // `deleteTaskAttachments` never throws for that reason; what it cannot unlink, the
    // next boot's sweep will.
    await deleteTaskAttachments(userData, [taskId, ...steps.map((s) => s.id)]);
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
    //
    // **JIRA in particular, not "any external tracker".** This is a WRITE-BACK, and GitHub
    // has no priority to write to: an issue's nearest equivalent is a label somebody's
    // repository invented. So a GitHub card falls through to the local update below and
    // keeps the priority the human set — which is also why `githubIssueSync.issueToTask`
    // carries `externalPriority` forward instead of nulling it every sync.
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
      // Read at merge time, not at run time, so flipping it while the agent works still
      // decides what happens when that work lands.
      ...(options.autoRelease !== undefined ? { autoRelease: options.autoRelease } : {}),
      // Read when the work SETTLES, like the two below, so turning it on mid-run still
      // decides what happens to the branch the agent is writing right now.
      ...(options.autoCreatePr !== undefined ? { autoCreatePr: options.autoCreatePr } : {}),
      // Read the moment the run FINISHES, likewise, so changing your mind while the agent
      // works still decides what happens to the branch it is writing.
      ...(options.autoIntegrate !== undefined ? { autoIntegrate: options.autoIntegrate } : {}),
    });
    if (!task) throw new Error('Task not found.');
    send('task:changed', { task, runId: null });
    return task;
  });

  handle('task:setStatus', async (taskId, status) => {
    const existing = store.getTask(taskId);
    if (!existing) throw new Error('Task not found.');
    if (!isManualStatus(status)) throw new Error(`"${status}" is not a hand-settable status.`);
    // A live run is NOT a refusal — see `humanStatusPatch`. The run borrowed `status`, so
    // the human's choice is parked in `preRunStatus` and the card moves without the run
    // noticing. This used to throw "stop the session first", which made a delegated card
    // unmovable for as long as its agent worked.
    const from = restingStatus(existing);
    if (from === status) return existing;

    // The dropdown is the detail pane's drag-and-drop: same resolution, same forge write,
    // same pre-block memory. Two controls that set the same states and only one of which
    // reached the tracker was a coin toss over whether the ticket moved.
    //
    // The chosen status is written verbatim rather than `move.localStatus`, which is the
    // column's REPRESENTATIVE status: Done and Cancelled share the DONE column, and a
    // cancelled card that came back reading "Done" would have lost the distinction the
    // user reached for the dropdown to make.
    const move = resolveMove(existing, columnForStatus(status));
    const outcome = await writeMoveToForge(existing, move, columnForStatus(status));
    const patch: Parameters<Store['updateTask']>[1] = {
      ...humanStatusPatch(existing, status),
      preBlockStatus: preBlockMarker(move, outcome),
      ...(outcome?.patch ?? {}),
    };

    const task = store.updateTask(taskId, patch);
    if (!task) throw new Error('Task not found.');
    store.recordStatusChange(task.projectId, taskId, from, status);
    send('task:changed', { task, runId: null });
    // Closing the card answers everything it was asking. See `task:move` for the reasoning.
    if (restingStatus(task) === 'done') scheduler.dismissAttentionForCard(taskId);
    // Back in To Do re-asks the chain (Phase 21). `pending` is the ONE status a release may
    // start a card from, so arriving at it can be the last thing a card was waiting for —
    // and it is a change to the CARD, which no landing or arrow will ever mention again.
    // Typically the card was blocked when its predecessor landed, so it holds a "Ready to
    // start … start it whenever you like" note; putting it back in To Do is the human
    // answering that note. The guards stay `reconsider`'s own: only a chained, assigned card
    // that has never run starts here. The dropdown does it because it is the detail pane's
    // drag-and-drop — the same reasoning as the JIRA transition above.
    if (status === 'pending') scheduler.reconsiderChains('card-changed');
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
    // Rewiring the session must not move the card either — the same unguarded write, and
    // the same answer, as `task:assignAgent` above.
    const task = store.updateTask(taskId, {
      sessionId: sessionId.trim(),
      ...assignmentStatusPatch(existing),
    });
    if (task) send('task:changed', { task, runId: null }); // keep the Board in sync
    return task ?? null;
  });

  handle('attention:list', async () => scheduler.listAttention());
  handle('attention:answer', async (itemId, answer) => scheduler.answerAttention(itemId, answer));

  /**
   * Hush a card that is shouting but is NOT done — you have read the comment, you know the
   * pipeline is red, and you are getting to it.
   *
   * Every driver of the ring is silenced in one call, because "stop telling me about this"
   * is one decision: the inbox items on the card and its steps, the ticket's unread marker,
   * and each merge request filed under either. Silencing them one control at a time was the
   * only way to do this, and it meant knowing which of the five was ringing.
   *
   * Both markers on an MR, not just `lastReadAt`: `mrNeedsAttention` also fires on an
   * unseen EVENT (a failed pipeline, changes requested, ready-to-merge), so marking only
   * the notes read would leave a card that was shouting about a pipeline shouting about it.
   */
  handle('task:dismissAttention', async (taskId) => {
    const existing = store.getTask(taskId);
    if (!existing) throw new Error('Task not found.');

    scheduler.dismissAttentionForCard(taskId);

    const stepIds = new Set([taskId, ...store.getSubtasks(taskId).map((s) => s.id)]);
    const now = Date.now();
    let touchedMrs = false;
    for (const mr of store.listMergeRequests()) {
      if (!mr.taskId || !stepIds.has(mr.taskId)) continue;
      store.markMergeRequestRead(mr.id, now);
      store.markMergeRequestEventsSeen(mr.id, now);
      touchedMrs = true;
    }
    if (touchedMrs) send('mergeRequests:changed', store.listMergeRequests());

    // The same rule as `jira:markRead`: the newest comment we know of becomes the one you
    // have read. `now` only as a fallback, so a card with no comment at all is still quiet.
    //
    // ANY external tracker, not JIRA alone: `latestCommentAt`/`lastReadCommentAt` are the
    // board's own two fields, written by whichever sync fetched the thread, and "I have seen
    // this card's comments" is the same statement whoever hosts them.
    const task =
      existing.externalSource != null
        ? (store.updateTask(taskId, { lastReadCommentAt: existing.latestCommentAt ?? now }) ??
          existing)
        : existing;
    send('task:changed', { task, runId: null });
    return task;
  });

  handle('limit:current', async () => scheduler.currentLimit());
  handle('limit:resumeNow', async () => scheduler.resumeLimitNow());
  handle('auth:current', async () => scheduler.currentAuth());
  handle('auth:signedIn', async () => scheduler.signedIn());
  handle('auth:signIn', async () => openInteractiveSignIn());

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

  // The two metered windows, as percentages of the budgets in Settings. Deliberately
  // separate from `usage:summary`: those totals follow the range selector, while these
  // two windows are fixed — a session is 5 hours and a week is 7 days no matter what
  // the dashboard is showing, and the status bar reads them with no dashboard at all.
  handle('usage:quotas', async () => {
    const settings = store.getSettings();
    const pressure = scheduler.getUsagePressure();
    // The CLI reports resetsAt in Unix SECONDS, and one event carries only one window's
    // reset — `limitType` says which, so a weekly reset never anchors the session bar.
    const resetMs = pressure.resetsAt != null ? pressure.resetsAt * 1000 : null;
    return rollupQuotas({
      now: Date.now(),
      sessionLimit: settings.sessionTokenBudget,
      weeklyLimit: settings.weeklyTokenBudget,
      sessionReset: pressure.limitType === 'rolling' ? resetMs : null,
      weeklyReset: pressure.limitType === 'weekly' ? resetMs : null,
      tokensIn: (from, to) => store.getWindowTokens(from, to),
      claudeUsage: claudeUsagePoller.current(),
    });
  });

  handle('settings:get', async () => store.getSettings());
  handle('settings:save', async (settings) => {
    // Normalize the JIRA URL once, on the way in, so every consumer sees the same
    // origin — the client, the epic-field and identity caches (both keyed by baseUrl),
    // and the issue links written onto cards.
    const stored = store.getSettings().jira;
    const baseUrl = normalizeBaseUrl(settings.jira.baseUrl);
    // The discovered API gateway belongs to ONE site and ONE deployment mode, and it is
    // never typed — the probe writes it (see `JiraSettings.apiBaseUrl`). Two rules follow.
    // Point the settings at a different site, or flip the dropdown, and it is stale, so it
    // goes. Otherwise it survives a form the renderer read BEFORE the probe found it —
    // which is every save that follows a Test connection, and losing it there would undo
    // the fix on the next click.
    const gatewayStillApplies =
      baseUrl === normalizeBaseUrl(stored.baseUrl) &&
      settings.jira.deployment === stored.deployment;
    store.saveSettings({
      ...settings,
      jira: {
        ...settings.jira,
        baseUrl,
        cloudEmail: settings.jira.cloudEmail.trim(),
        apiBaseUrl: gatewayStillApplies
          ? settings.jira.apiBaseUrl?.trim() || stored.apiBaseUrl || ''
          : '',
      },
      cloud: { ...settings.cloud, baseUrl: normalizeBaseUrl(settings.cloud.baseUrl) },
    });
    // Pick up a changed poll interval (or enable/disable) without a restart.
    syncPoller.reschedule();
    // Same reason, on the cloud mirror's own clock — an edit to `cloud.enabled`/`baseUrl`
    // takes effect at once rather than waiting for whatever tick was already in flight.
    cloudPoller.reschedule();
    // The countdown is drawn from the interval, so a changed one has to reach the bar or
    // the ring would keep draining at the old rate until the next sync landed.
    pushSyncState();
  });

  // Whether the token is being protected by the weak built-in password rather than an
  // OS keyring. `setUsePlainTextEncryption(true)` in main/index.ts makes storage WORK on
  // a keyring-less Linux box; this is what lets the UI be honest about what it bought.
  // `getSelectedStorageBackend` only exists on Linux, hence the platform guard.
  const usesPlainTextStorage = (): boolean =>
    process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text';

  /**
   * Read a stored secret back out. Split from the client builders because the failure it
   * has to name is the same for both, and it is one nobody guesses: `decryptString`
   * throws whenever the ciphertext was written by a different OS user, a different
   * machine, or (on Linux) a different `safeStorage` backend — a settings folder restored
   * from a backup, say. The raw message is "Error while decrypting the ciphertext
   * provided to safeStorage.decryptString", which reads like a bug in the app rather than
   * a token that has to be pasted again.
   */
  const decryptSecret = (cipher: string, label: string): string => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS secure storage is unavailable, so the saved token cannot be read.');
    }
    try {
      return safeStorage.decryptString(Buffer.from(cipher, 'base64'));
    } catch {
      throw new Error(
        `The stored ${label} token could not be decrypted on this machine — it was encrypted ` +
          `by a different OS user, machine, or keyring. Paste the token again in Settings.`,
      );
    }
  };

  /**
   * Current JIRA settings + the decrypted token, or a user-facing error saying what is
   * missing. The token never leaves the main process: it is stored encrypted and
   * decrypted here on demand. Returned rather than swallowed into a client so the
   * Test-connection probe can retry the SAME token against another configuration.
   */
  const jiraCredentials = (): { jira: AppSettings['jira']; token: string } => {
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
    return { jira, token: decryptSecret(cipher, 'JIRA') };
  };

  const buildJiraClient = (): JiraClient => {
    const { jira, token } = jiraCredentials();
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
    // Stored clean, so a paste that arrived with a newline on it never becomes a 401 that
    // reads as "your token was rejected". Said out loud rather than fixed silently: the
    // same copy will produce the same stray character next time. See `@shared/secretToken`.
    const noise = tokenHadNoise(pat);
    store.saveJiraToken(safeStorage.encryptString(sanitizeToken(pat)).toString('base64'));
    return {
      ok: true,
      message: usesPlainTextStorage()
        ? 'Token saved — but this machine has no keyring, so it is only obfuscated on disk.'
        : noise
          ? 'Token saved — whitespace came with the paste and was stripped.'
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
      const { jira } = store.getSettings();
      // A 401 is the one failure where the error text and the truth routinely disagree —
      // it says "credential refused" and everyone reads "bad token". This is the moment to
      // stop guessing and go and find out: the user asked for a test and is waiting, so a
      // couple more requests are cheap. Only a probe that came back 200 is acted on.
      if (e instanceof JiraError && e.status === 401) {
        const probe = await (async () => {
          try {
            return await probeJiraAuth(jira, jiraCredentials().token);
          } catch (probeErr) {
            logMain('JIRA auth probe failed', probeErr);
            return null;
          }
        })();
        if (probe?.outcome === 'connected') {
          store.saveSettings({ ...store.getSettings(), jira: { ...jira, ...probe.patch } });
          return { ok: true, displayName: probe.displayName, message: probe.message };
        }
        if (probe) return { ok: false, message: probe.message };
      }
      return { ok: false, message: explainJiraFailure(e, jira) };
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
    return new GitLabClient({ baseUrl: gitlab.baseUrl, token: decryptSecret(cipher, 'GitLab') });
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
      return {
        ok: false,
        message: 'OS secure storage is unavailable, so the token was not saved.',
      };
    }
    // Same paste hygiene as the JIRA token above.
    const noise = tokenHadNoise(token);
    store.saveGitLabToken(safeStorage.encryptString(sanitizeToken(token)).toString('base64'));
    return {
      ok: true,
      message: usesPlainTextStorage()
        ? 'Token saved — but this machine has no keyring, so it is only obfuscated on disk.'
        : noise
          ? 'Token saved — whitespace came with the paste and was stripped.'
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

  // -------------------------------------------------------------------------
  // GitHub. The GitLab block again, one forge over: same encryption path, same paste
  // hygiene, same refusal to store anything when the OS secure store is unavailable.
  const buildGitHubClient = (): GitHubClient => {
    const { github } = store.getSettings();
    if (!github.baseUrl.trim()) throw new Error('Set the GitHub API URL in Settings first.');
    const cipher = store.loadGitHubToken();
    if (!cipher) throw new Error('No GitHub token saved — add one in Settings.');
    return new GitHubClient({ baseUrl: github.baseUrl, token: decryptSecret(cipher, 'GitHub') });
  };

  handle('github:getConfigStatus', async () => {
    const { github } = store.getSettings();
    return {
      enabled: github.enabled,
      hasToken: store.loadGitHubToken() !== null,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      plainTextStorage: usesPlainTextStorage(),
      // GitHub has one auth mode; 'server' is the honest answer for github.com and for
      // GitHub Enterprise Server alike. See the note on the GitLab handler above.
      deployment: 'server' as const,
      baseUrl: github.baseUrl,
    };
  });

  handle('github:setCredentials', async (token) => {
    if (!token.trim()) {
      store.clearGitHubToken();
      return { ok: true, message: 'Token cleared.' };
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return {
        ok: false,
        message: 'OS secure storage is unavailable, so the token was not saved.',
      };
    }
    // Same paste hygiene as the JIRA and GitLab tokens above.
    const noise = tokenHadNoise(token);
    store.saveGitHubToken(safeStorage.encryptString(sanitizeToken(token)).toString('base64'));
    return {
      ok: true,
      message: usesPlainTextStorage()
        ? 'Token saved — but this machine has no keyring, so it is only obfuscated on disk.'
        : noise
          ? 'Token saved — whitespace came with the paste and was stripped.'
          : 'Token saved.',
    };
  });

  handle('github:clearCredentials', async () => store.clearGitHubToken());

  handle('github:testConnection', async () => {
    try {
      const me = await buildGitHubClient().getMe();
      // The test is also the cheapest possible moment to learn WHO you are: the answer is
      // already in hand, and caching it here is what stops your own comment lighting your
      // own card orange later, without a request of its own. Keyed by base URL, so pointing
      // the app at another instance re-discovers rather than mis-attributing.
      store.saveGitHubIdentity(githubIdentityFrom(me, store.getSettings().github.baseUrl));
      return { ok: true, displayName: me.login, message: `Connected as ${me.login}.` };
    } catch (e) {
      logMain('GitHub test connection failed', e);
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  });

  // -------------------------------------------------------------------------
  // Opening a pull request for a card (`forge/createPr.ts`).
  //
  // The token reader is the only thing this file adds: `decryptSecret` lives in this closure
  // because it is the one place `safeStorage` is reachable, and a **null** rather than a
  // throw is what "no token saved" means — `openPullRequest` turns that into a sentence
  // naming the forge, which is more use than a decryption error.
  const forgeToken = (provider: ForgeProvider): string | null => {
    const cipher = provider === 'github' ? store.loadGitHubToken() : store.loadGitLabToken();
    if (!cipher) return null;
    return decryptSecret(cipher, provider === 'github' ? 'GitHub' : 'GitLab');
  };

  const createPrDeps = (): CreatePrDeps => ({
    getTask: (id) => store.getTask(id),
    getProject: (id) => store.getProject(id),
    getSettings: () => store.getSettings(),
    listMergeRequests: () => store.listMergeRequests(),
    upsertMergeRequest: (mr) => {
      store.upsertMergeRequest(mr);
      // Pushed straight out, for the reason the row is written here at all: the card's
      // merge-request section must show the PR on the next paint rather than after the
      // next poll, and nothing else would tell the renderer it exists.
      send('mergeRequests:changed', store.listMergeRequests());
    },
    inspect: (project, ownerTaskId, branchName) =>
      worktrees.inspect(project, ownerTaskId, branchName),
    tokenFor: forgeToken,
    note: (projectId, taskId, body) => {
      store.addComment(projectId, taskId, body);
      send('project:tasksChanged', { projectId, tasks: store.getTasks(projectId) });
    },
    now: () => Date.now(),
  });

  handle('task:createPullRequest', async (taskId) => openPullRequest(createPrDeps(), taskId));

  // The scheduler opens the same PR, through the same function, when a card finishes with
  // "Open a PR when finished" on — so it is handed the deps rather than growing its own way
  // in. Set here because only this closure can read a secret out of `safeStorage`.
  scheduler.setPullRequestOpener((taskId) => openPullRequest(createPrDeps(), taskId));

  // -------------------------------------------------------------------------
  // vipper.iam cloud sign-in (Phase 25's "Guard the cloud API with vipper.iam"). The refresh
  // token is the one credential of the three (JIRA/GitLab/IAM) this app itself is a party to
  // minting, but it still goes through the exact same encrypt-and-store path as the other two.
  handle('iam:getConfigStatus', async () => ({
    signedIn: store.loadIamRefreshToken() !== null,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  }));

  handle('iam:signIn', async () => {
    if (!safeStorage.isEncryptionAvailable()) {
      return {
        ok: false,
        message: 'OS secure storage is unavailable, so the sign-in was not saved.',
      };
    }
    try {
      const tokens = await runIamSignIn(iamSignInConfig(), (url) => shell.openExternal(url));
      if (!tokens.refresh_token) {
        return { ok: false, message: 'vipper.iam did not return a refresh token.' };
      }
      store.saveIamRefreshToken(
        safeStorage.encryptString(sanitizeToken(tokens.refresh_token)).toString('base64'),
      );
      return { ok: true, message: 'Signed in.' };
    } catch (e) {
      logMain('IAM sign-in failed', e);
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  });

  handle('iam:signOut', async () => {
    cloudAccessToken = null;
    store.clearIamRefreshToken();
  });

  /**
   * The cloud mirror's own access token — minted from the stored refresh token, cached in
   * memory until it's close to expiry rather than reminted on every poll (the active tier
   * is 2.5s; a mint-per-tick would cost `apps/server` a vipper.iam round trip every request
   * for nothing a cache doesn't already answer). vipper.iam rotates the refresh token on
   * every use, so a successful mint re-encrypts and re-saves it, exactly as `iam:signIn`
   * does with the first one. Returns null — never throws — whenever there is nothing to
   * mint from: `cloudPoller` treats that exactly like any other failed tick (counted,
   * backed off, retried next time), not a special case.
   */
  let cloudAccessToken: { value: string; expiresAt: number } | null = null;
  const getCloudAccessToken = async (): Promise<string | null> => {
    if (cloudAccessToken && cloudAccessToken.expiresAt > Date.now() + 5_000) {
      return cloudAccessToken.value;
    }
    const cipher = store.loadIamRefreshToken();
    if (!cipher || !safeStorage.isEncryptionAvailable()) return null;
    try {
      const refreshToken = decryptSecret(cipher, 'vipper.iam');
      // `redirectUri` is part of `IamPkceConfig`'s shape but only read for the
      // authorization-code grant `signIn()` uses — the refresh-token grant never sends it,
      // so an empty placeholder is fine here.
      const tokens = await refreshTokens({ ...iamSignInConfig(), redirectUri: '' }, refreshToken);
      if (tokens.refresh_token) {
        store.saveIamRefreshToken(
          safeStorage.encryptString(sanitizeToken(tokens.refresh_token)).toString('base64'),
        );
      }
      cloudAccessToken = {
        value: tokens.access_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
      };
      return cloudAccessToken.value;
    } catch (e) {
      logMain('vipper.iam access token refresh failed', e);
      return null;
    }
  };

  // Defined here rather than beside the other handlers because it needs
  // `getCloudAccessToken`, which is declared just above.
  handle('cloud:testConnection', async () => {
    const result = await testCloudConnection({
      settings: store.getSettings().cloud,
      getAccessToken: getCloudAccessToken,
    });
    if (!result.ok) logMain('Cloud test connection failed', result.message);
    return result;
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

  /**
   * The board's keys and the cards behind them, for matching MRs to tasks.
   *
   * The archived-excluding read, deliberately: an MR is matched to a card so the card can show
   * it, and a card that is off the board has nowhere to show anything. Including archived rows
   * here would have a removed card silently claim a live merge request, which then appears
   * nowhere at all — worse than the orphan an unmatched MR already handles.
   */
  const boardKeyIndex = (): { knownKeys: string[]; taskIdByKey: Map<string, string> } => {
    const taskIdByKey = new Map<string, string>();
    for (const task of store.getPersonalTasks()) {
      // Any tracker's key, not JIRA's alone: a GitHub pull request names its issue as
      // `owner/repo#123`, which is the same kind of fact about the same kind of card. The
      // upper-casing is what makes the lookup case-insensitive on both spellings.
      if (task.externalSource && task.externalKey) {
        taskIdByKey.set(task.externalKey.toUpperCase(), task.id);
      }
    }
    return { knownKeys: [...taskIdByKey.keys()], taskIdByKey };
  };

  // -------------------------------------------------------------------------
  // Sync freshness — what the status bar's countdown rings are drawn from.
  //
  // Held in memory, not the DB, and that is the right call: "when did we last talk to
  // JIRA" is a fact about THIS app run. Persisting it would have a freshly launched app
  // claim a mirror was two minutes old when it had not fetched anything at all.
  //
  // One record per service, updated by `trackSync`, which every sync path goes through —
  // the manual button and the background poller share one body each, so there is no way
  // to sync without the bar noticing.
  // -------------------------------------------------------------------------
  const syncClock: Record<
    SyncServiceId,
    { lastSyncAt: number | null; syncing: boolean; error: string | null }
  > = {
    jira: { lastSyncAt: null, syncing: false, error: null },
    gitlab: { lastSyncAt: null, syncing: false, error: null },
    github: { lastSyncAt: null, syncing: false, error: null },
    cloud: { lastSyncAt: null, syncing: false, error: null },
  };

  const syncState = (): SyncState => {
    const settings = store.getSettings();
    const services: ServiceSyncState[] = [
      { id: 'jira', label: 'JIRA', enabled: settings.jira.enabled, ...syncClock.jira },
      { id: 'gitlab', label: 'GitLab', enabled: settings.gitlab.enabled, ...syncClock.gitlab },
      { id: 'github', label: 'GitHub', enabled: settings.github.enabled, ...syncClock.github },
      { id: 'cloud', label: 'Cloud', enabled: settings.cloud.enabled, ...syncClock.cloud },
    ];
    // The NEWEST of the services' clocks, so a sweep in which one tracker failed still
    // counts as having happened for the ones that did not — the ring would otherwise sit
    // pinned at empty because of a single broken integration.
    const stamps = services
      .filter((s) => s.enabled)
      .map((s) => s.lastSyncAt)
      .filter((t): t is number => t !== null);
    return {
      intervalMs: Math.max(0, Math.round(settings.syncIntervalMinutes ?? 0)) * 60_000,
      lastSyncAt: stamps.length ? Math.max(...stamps) : null,
      syncing: Object.values(syncClock).some((c) => c.syncing),
      services,
    };
  };

  const pushSyncState = (): void => send('sync:changed', syncState());

  /**
   * Run one sync with the status bar watching: mark it in flight, push, run it, record the
   * outcome, push again.
   *
   * `lastSyncAt` moves only on SUCCESS — the ring is "how fresh is this mirror", and a
   * failed attempt refreshed nothing. The error is kept beside it so a service that has
   * quietly stopped working says so in its tooltip rather than only in the log.
   */
  const trackSync = async <T>(id: SyncServiceId, run: () => Promise<T>): Promise<T> => {
    syncClock[id].syncing = true;
    pushSyncState();
    try {
      const result = await run();
      syncClock[id] = { lastSyncAt: Date.now(), syncing: false, error: null };
      return result;
    } catch (e) {
      syncClock[id] = {
        ...syncClock[id],
        syncing: false,
        error: e instanceof Error ? e.message : String(e),
      };
      throw e;
    } finally {
      pushSyncState();
    }
  };

  handle('sync:state', async () => syncState());

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
    // This forge's rows only. One table holds both, and everything below — the "dropped out
    // of the list, so read it back" pass, and the reconciler's delete of anything the fetch
    // did not return — reads an absence as an ending. A GitHub pull request is absent from
    // every GitLab fetch there will ever be.
    const stored = store.listMergeRequests().filter((mr) => mr.provider === 'gitlab');
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

    /**
     * Read back the open MRs that dropped out of the list, so their ENDING is a fact.
     *
     * `listMyMergeRequests` asks for `state=opened`, so an MR that landed simply stops
     * being returned. Deleting on that absence is what wiped a merged MR off its card the
     * moment it merged; asking GitLab what actually happened costs one call per MR, once,
     * because the answer is terminal and the guard below never asks again.
     *
     * `stale: false` keeps the pipeline, approvals and notes we already hold — none of them
     * can move now, and re-reading four endpoints to learn nothing would be waste.
     */
    const listedIds = new Set(list.map((mr) => mergeRequestId(mr.project_id, mr.iid)));
    for (const prior of stored) {
      if (listedIds.has(prior.id) || mrIsSettled(prior)) continue;
      const fetched = await client.getMergeRequest(prior.repoId, prior.number).catch(() => null);
      // Unreadable or gone: leave it out, and the reconciler deletes it as it always did.
      if (fetched)
        detailed.push(await describeMergeRequest(client, fetched, { stale: false, prior }));
    }

    const { knownKeys, taskIdByKey } = boardKeyIndex();
    const { upserts, deleteIds } = reconcileMergeRequests(stored, detailed, {
      knownKeys,
      taskIdByKey,
      identity,
      now: Date.now(),
    });
    for (const mr of upserts) store.upsertMergeRequest(mr);
    store.deleteMergeRequests(deleteIds);
    // A merged MR is this app's only way of learning that a reviewed branch actually landed
    // — nobody here ran the merge. It is what a chain's `after-merge` gate waits for, so it
    // is handed to the engine before the board is told anything (see `Task.landedAt`).
    for (const taskId of landedTaskIds(upserts)) scheduler.noteWorkLanded(taskId);
    const all = store.listMergeRequests();
    send('mergeRequests:changed', all);
    return all;
  };

  handle('gitlab:sync', async () => {
    try {
      return await trackSync('gitlab', syncGitLab);
    } catch (e) {
      logMain('GitLab sync failed', e);
      throw new Error(e instanceof Error ? e.message : String(e));
    }
  });

  /**
   * One GitHub sync: list your open PRs, re-read detail only for the ones that moved,
   * reconcile, push. `syncGitLab` above, one forge over, and every decision it makes for a
   * stated reason is made here for the same one.
   *
   * The N+1 is deliberate and bounded, and *worse* than GitLab's: the search endpoint is the
   * only thing that answers "across every repository" in one call, and it is the thinnest
   * payload GitHub has — no branches, no head SHA, no `mergeable_state`, not even the
   * repository id. Everything attention depends on needs the detail endpoints, so those are
   * spent only on PRs `needsDetailRefresh` calls stale, at a concurrency of 4.
   */
  const syncGitHubPullRequests = async (): Promise<MergeRequest[]> => {
    const { github } = store.getSettings();
    if (!github.enabled) return store.listMergeRequests();
    const client = buildGitHubClient();
    // Who you are on this instance — cached per site, so this is a call once, not once a
    // sync. It is what stops your own review comments marking your own PR unread.
    const identity = await githubIdentity(github.baseUrl, client);
    // This forge's rows only — see the same line in `syncGitLab`.
    const stored = store.listMergeRequests().filter((mr) => mr.provider === 'github');
    const list = await client.listMyPullRequests();

    /**
     * How a listed PR and a stored one are recognised as the same thing: `owner/repo#number`.
     *
     * Not the row id, and that is not an oversight: the id is `gh-{repoId}-{number}` and
     * GitHub's numeric repository id is **only on the detail response**, so a search row
     * cannot spell its own id. The repo path is the one identity a listing always carries.
     */
    const prRef = (projectPath: string, number: number): string =>
      `${projectPath.toLowerCase()}#${number}`;
    const listedRef = (item: GitHubSearchIssueItem): string => {
      const { owner, repo } = repoRefFromApiUrl(item.repository_url);
      return prRef(`${owner}/${repo}`, item.number);
    };
    const priorByRef = new Map(stored.map((mr) => [prRef(mr.projectPath, mr.number), mr]));

    const detailed: FetchedMergeRequest[] = [];
    const queue = [...list];
    const worker = async (): Promise<void> => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const prior = priorByRef.get(listedRef(item));
        const updatedAt = Date.parse(item.updated_at) || 0;
        const stale = needsDetailRefresh(prior, updatedAt);
        detailed.push(await describePullRequest(client, item, { stale, prior }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));

    /**
     * Read back the open PRs that dropped out of the list, so their ENDING is a fact.
     *
     * The search asks for `is:open`, so a PR that landed simply stops being returned — and
     * GitHub reports a landed one as `closed` with `merged_at` set, which is the difference
     * between "this shipped" and "this was thrown away". Deleting on absence would lose both
     * at once; asking costs one call per PR, once, because the answer is terminal and the
     * guard below never asks again.
     *
     * `stale: false` keeps the checks and approvals we already hold — none of them can move
     * now, and re-reading four endpoints to learn nothing would be waste.
     */
    const listedRefs = new Set(list.map(listedRef));
    for (const prior of stored) {
      if (listedRefs.has(prRef(prior.projectPath, prior.number)) || mrIsSettled(prior)) continue;
      const [owner, repo] = prior.projectPath.split('/');
      if (!owner || !repo) continue;
      const detail = await client.getPullRequest(owner, repo, prior.number).catch(() => null);
      // Unreadable or gone: leave it out, and the reconciler deletes it as it always did.
      if (detail) {
        detailed.push(
          await describePullRequest(client, listedFromDetail(detail, owner, repo), {
            stale: false,
            prior,
          }),
        );
      }
    }

    const { knownKeys, taskIdByKey } = boardKeyIndex();
    const { upserts, deleteIds } = reconcilePullRequests(stored, detailed, {
      knownKeys,
      taskIdByKey,
      identity,
      now: Date.now(),
    });
    for (const mr of upserts) store.upsertMergeRequest(mr);
    store.deleteMergeRequests(deleteIds);
    // The same hand-off GitLab's sync makes, and the reason `after-merge` chain gates work on
    // a GitHub repository at all: nobody here ran the merge, so a merged PR is this app's
    // only way of learning that a reviewed branch landed (see `Task.landedAt`).
    for (const taskId of landedTaskIds(upserts)) scheduler.noteWorkLanded(taskId);
    const all = store.listMergeRequests();
    send('mergeRequests:changed', all);
    return all;
  };

  /**
   * ONE GitHub sync, both halves: the issues that make cards, then the pull requests that
   * land on them.
   *
   * The order is load-bearing and is the same one `syncJira` establishes. Issues first, so
   * the board a pull request is matched against is the board as it is *now* — a PR whose
   * issue appeared in this very sync attaches on this pass rather than on the next one. Then
   * `rematchStoredMergeRequests`, exactly as it follows a JIRA sync: the board just changed
   * shape, so a stored MR whose ticket has left should let go rather than point at a card
   * that is no longer there. No network in that last step; it re-files what we already hold.
   *
   * Both halves are separately switchable (`syncIssues`, `syncPullRequests`) because plenty
   * of people track work in JIRA and merge it on GitHub, and plenty track everything in
   * GitHub Issues. Neither switch drags the other along.
   *
   * The issue half never takes the PR half down with it: a failing issue query — a syntax
   * error in something the user typed — would otherwise mean no pull request appears on any
   * card until it is fixed. It is logged and surfaced on the board's notice bar instead.
   */
  const syncGitHub = async (): Promise<MergeRequest[]> => {
    const { github } = store.getSettings();
    if (github.enabled && github.syncIssues) {
      try {
        await syncGitHubIssues();
      } catch (e) {
        logMain('GitHub issue sync failed', e);
        send('board:notice', {
          intent: 'error',
          text: `GitHub issues could not be synced: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
    const mrs =
      github.enabled && github.syncPullRequests
        ? await syncGitHubPullRequests()
        : store.listMergeRequests();
    rematchStoredMergeRequests();
    return mrs;
  };

  handle('github:sync', async () => {
    try {
      return await trackSync('github', syncGitHub);
    } catch (e) {
      logMain('GitHub sync failed', e);
      throw new Error(e instanceof Error ? e.message : String(e));
    }
  });

  /**
   * Re-file stored MRs against the board as it is now. Cheap, and no network.
   *
   * Split by forge, because "which card is this for" is the one question the two answer
   * differently: a GitHub pull request can name its issue with a closing reference, which
   * `rematchMergeRequests` has never heard of. Running GitLab's rule over a GitHub row would
   * have a re-match file a PR under a different card from the one its own sync just chose.
   */
  function rematchStoredMergeRequests(): void {
    const stored = store.listMergeRequests();
    if (!stored.length) return;
    const index = boardKeyIndex();
    const changed = [
      ...rematchMergeRequests(
        stored.filter((mr) => mr.provider === 'gitlab'),
        index,
      ),
      ...rematchPullRequests(
        stored.filter((mr) => mr.provider === 'github'),
        index,
      ),
    ];
    if (!changed.length) return;
    for (const mr of changed) store.upsertMergeRequest(mr);
    send('mergeRequests:changed', store.listMergeRequests());
  }

  handle('mr:mergeRequests', async () => store.listMergeRequests());

  handle('mr:setMergeRequestName', async (mrId, name) => {
    store.setMergeRequestName(mrId, name);
    const all = store.listMergeRequests();
    send('mergeRequests:changed', all);
    return all;
  });

  handle('mr:markRead', async (mrId) => {
    store.markMergeRequestRead(mrId, Date.now());
    const all = store.listMergeRequests();
    send('mergeRequests:changed', all);
    return all;
  });

  handle('mr:markEventsSeen', async (mrId) => {
    store.markMergeRequestEventsSeen(mrId, Date.now());
    const all = store.listMergeRequests();
    send('mergeRequests:changed', all);
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

    // The card the ticket is being linked ONTO, when the dialog wrote one locally first.
    // Checked before the issue is created, so a stale id is a refusal rather than an
    // orphaned ticket. A step is refused too: a step is one unit of a card's plan, and
    // nothing in JIRA corresponds to it.
    const adopt = input.adoptTaskId ? store.getTask(input.adoptTaskId) : undefined;
    if (input.adoptTaskId) {
      if (!adopt) throw new Error('Task not found.');
      if (adopt.parentTaskId) throw new Error('A step cannot have a ticket of its own.');
      if (adopt.externalKey) {
        throw new Error(`That task is already linked to ${adopt.externalKey}.`);
      }
    }

    const client = buildJiraClient();
    const created = await client.createIssue({
      projectKey: input.projectKey,
      issueTypeId: input.issueTypeId,
      summary: input.summary.trim(),
      description: input.description,
    });

    // Read the issue back and build the card with the SAME `issueToTask` a sync uses,
    // rather than hand-building a Task. A hand-built one would differ from what the next
    // poll produces — a different status, a missing field — and appear to mutate on its own.
    const epicField = await epicFieldId(jira.baseUrl, client);
    const sprintField = await sprintFieldId(jira.baseUrl, client);
    const extraFields = [epicField, sprintField].filter((f): f is string => f !== null);
    const issue = await client.getIssue(created.key, extraFields);
    const card = issueToBoardTask(issue, adopt, {
      baseUrl: jira.baseUrl,
      overrides: jira.statusCategoryOverrides,
      learned: jira.learnedStatusColumns,
      epicFieldId: epicField,
      sprintFieldId: sprintField,
      identity: await jiraIdentity(jira.baseUrl, client),
    });
    // The stored row, not the computed one: adopting keeps everything JIRA knows nothing
    // about (the filing, the type, an assignment), and only the round trip has those.
    const task = store.upsertJiraTask(card);
    if (!task) throw new Error(`JIRA created ${created.key} but it could not be read back.`);

    // Remember the choice for next time. Behind the UI's back, so it goes out on
    // `settings:changed` — a screen that saves the whole blob would otherwise clobber it.
    if (
      jira.lastCreateProjectKey !== input.projectKey ||
      jira.lastCreateIssueTypeId !== input.issueTypeId
    ) {
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

  // What the board asks for when it draws itself — so, by definition, the cards on it.
  handle('board:tasks', async () => store.getPersonalTasks());

  // And the cards that are NOT on it — the same rows, the other side of `archivedAt`.
  handle('board:archived', async () => store.getArchivedTasks());

  handle('task:restore', async (taskId) => {
    const task = store.getTask(taskId);
    if (!task) throw new Error('That card is no longer there.');
    // A card that was never removed has nothing to restore, and saying so is the point: a
    // Restore that quietly did nothing looks exactly like one that worked.
    if (task.archivedAt == null) throw new Error('That card is already on the board.');
    store.unarchiveTask(taskId);
    const tasks = store.getPersonalTasks();
    send('project:tasksChanged', { projectId: PERSONAL_PROJECT_ID, tasks });
    // The rows never went anywhere — a link and an attachment both survive their card being
    // archived, exactly as they survive nothing at all. But the RENDERER's copies were
    // filtered against a board this card was not on: the chain overlay drops an arrow whose
    // endpoint it cannot find, and the pane's chips are sliced by task id. So both lists are
    // pushed again, for the same reason `task:delete` pushes them — the card's own state did
    // not change, its place on the board did, and nothing else would say so.
    pushChainLinks();
    pushAttachments();
    return tasks;
  });

  // --- The chain of execution ------------------------------------------------
  /** Push the whole link list at the board. Returns it, so handlers can also reply with it. */
  function pushChainLinks(): TaskLink[] {
    const links = store.listTaskLinks();
    send('chain:changed', links);
    return links;
  }

  handle('chain:links', async () => store.listTaskLinks());

  handle('chain:link', async (fromTaskId, toTaskId, gate): Promise<LinkResult> => {
    // The renderer checks this too, while the drag is still in the air — but its copy of
    // the board can be a poll behind, and a cycle that slips through is a chain that can
    // never start. So the answer that counts is computed here, against the real rows.
    const links = store.listTaskLinks();
    const refusal = canLink(links, store.getTask(fromTaskId), store.getTask(toTaskId));
    if (refusal) return { status: 'refused', reason: refusal };
    const created = store.addTaskLink(fromTaskId, toTaskId, gate ?? 'after-merge');
    // `canLink` already passed, so this is a race with another writer rather than a
    // refusal we can explain: report it as the duplicate the unique index caught.
    if (!created) return { status: 'refused', reason: 'duplicate' };
    const updated = pushChainLinks();
    // A new arrow can arrive already satisfied — drawn FROM a card that landed hours ago,
    // which is the ordinary way a chain gets built after the fact. Nothing about either
    // card changes here, so without this the successor waits for the next restart. After
    // the push, so the board has the arrow before a `task:changed` arrives for the card it
    // explains.
    scheduler.reconsiderChains('links-changed');
    return { status: 'ok', links: updated };
  });

  handle('chain:unlink', async (linkId) => {
    store.deleteTaskLink(linkId);
    // ONE OF SEVERAL arrows erased is the case this releases: the card was waiting on two
    // predecessors, one of them turned out not to matter, and the other landed long ago —
    // so erasing the arrow is the last thing that had to happen, and it is the only event
    // there is. Which is why the chain is re-asked here (Phase 21). The rule that bounds
    // it, and the first decision this phase took: the re-ask considers
    // only cards that STILL have an incoming arrow. Erasing a card's last arrow starts
    // nothing — a card with no arrows is not the chain's business any more, and a cleanup
    // gesture that spawns an agent is the wrong kind of automatic. That bound needs no code
    // here: `reconsider` walks the cards the REMAINING links point at.
    const updated = pushChainLinks();
    scheduler.reconsiderChains('links-changed');
    return updated;
  });

  handle('chain:setGate', async (linkId, gate) => {
    if (!isLinkGate(gate)) throw new Error(`Unknown chain gate: ${String(gate)}`);
    store.setTaskLinkGate(linkId, gate);
    const updated = pushChainLinks();
    // `after-merge` loosened to `stacked` is the case this releases: the predecessor wrote
    // its work hours ago and simply has not merged, so the gate changing is the whole of
    // what the successor was waiting for, and nothing else on the board will ever mention
    // it again. Tightening the other way starts nothing — the re-ask only starts a card
    // every arrow into it now allows.
    scheduler.reconsiderChains('links-changed');
    return updated;
  });

  // The refusal comes back as a sentence rather than as a rejected promise: "a usage limit
  // is holding everything" is something to tell the human, not an error — the same reasoning
  // as `LinkResult`.
  handle('chain:releaseNow', async (taskId) => scheduler.releaseChainNow(taskId));
  // ---------------------------------------------------------------------------

  // --- Attachments -----------------------------------------------------------
  /**
   * Push the whole attachment list at the UI. Returns it, so handlers can reply with it.
   *
   * The whole list rather than one task's, exactly as `pushChainLinks` does and for the
   * reason `attachment:changed` gives: a card's chips and a step's chips are two views of
   * one list, and the pane that changed it is not the only screen showing it.
   */
  function pushAttachments(): TaskAttachment[] {
    const attachments = store.listAttachments();
    send('attachment:changed', attachments);
    return attachments;
  }

  handle('attachment:list', async () => store.listAttachments());

  handle('attachment:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
    });
    return result.canceled ? [] : result.filePaths;
  });

  handle('attachment:add', async (taskId, paths) => {
    // The foreign key would refuse an unknown task anyway, but silently — and by then the
    // bytes are already copied into a directory nothing will ever name.
    if (!store.getTask(taskId)) throw new Error('Task not found.');
    const { failed } = await addAttachments(store, userData, taskId, paths);
    // Push what landed BEFORE complaining about what did not. Some of a multi-file pick
    // can succeed, and those chips are not the human's to reconcile against an error
    // message: they see four files appear and one sentence about the fifth.
    const all = pushAttachments();
    // Whatever landed is a candidate for the cloud's preview cache. Fire-and-forget, and
    // after the push above, so a thumbnail is never what a human waits for.
    cloudAttachments.scan();
    if (failed.length > 0) {
      const detail = failed.map((f) => `${basename(f.path)} (${f.reason})`).join(', ');
      throw new Error(`Could not attach ${detail}.`);
    }
    return all;
  });

  /**
   * The same thing for a browser: fetch each parked upload, write it into a temp directory of
   * its own, and hand the paths to the very same `addAttachments`.
   *
   * The bytes are fetched HERE rather than sent over the relay — see `attachment:addUploaded`
   * on `IpcApi` — so nothing this handler writes came from the command payload except a file
   * NAME, which `attachmentName` sanitizes on the way into `userData`
   * (`uploadedAttachments.ts` has the argument in full).
   *
   * The failure shape is `attachment:add`'s, deliberately: what landed is pushed first, then
   * one sentence names what did not, so a gesture of five files where one ticket had expired
   * attaches four rather than none. The temp copies go in a `finally` — they are copies of
   * copies, and the OS's temp sweep is not a schedule to rely on for a 25 MB file.
   */
  handle('attachment:addUploaded', async (taskId, uploads) => {
    if (!store.getTask(taskId)) throw new Error('Task not found.');
    const collected = await collectUploads(uploads, (upload) =>
      fetchUploadBytes(upload, {
        getSettings: () => store.getSettings().cloud,
        getAccessToken: getCloudAccessToken,
      }),
    );
    try {
      const { failed } = await addAttachments(store, userData, taskId, collected.paths);
      const all = pushAttachments();
      cloudAttachments.scan();
      const problems = [
        ...collected.failed.map((f) => `${f.path} (${f.reason})`),
        ...failed.map((f) => `${basename(f.path)} (${f.reason})`),
      ];
      if (problems.length > 0) throw new Error(`Could not attach ${problems.join(', ')}.`);
      return all;
    } finally {
      await collected.cleanup();
    }
  });

  handle('attachment:remove', async (id) => {
    // The row first, the bytes second — the order `task:delete` uses, and for the same
    // reason. A file removed under a row that survived is a chip pointing at nothing; a
    // row removed above a file that survived is bytes the boot sweep collects.
    const removed = store.deleteAttachment(id);
    if (removed) await deleteAttachmentFile(userData, removed);
    return pushAttachments();
  });

  handle('attachment:open', async (id) => {
    const attachment = store.getAttachment(id);
    // By id, so the only path that reaches the filesystem is one main built out of a row
    // that exists. Nothing the renderer typed gets here.
    if (!attachment) throw new Error('That attachment is no longer there.');
    // `shell.openPath` hands back the OS's complaint, or '' when it opened — which is why
    // the channel resolves to a string-or-null rather than rejecting. NOT `openExternal`
    // (index.ts:110): that one is for URLs, and would push a local path at the browser.
    const failure = await shell.openPath(
      attachmentFile(userData, attachment.taskId, attachment.name),
    );
    return failure || null;
  });
  // ---------------------------------------------------------------------------

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
   *
   * Batched and validated like every other `key in (...)` here (see `jiraJql.ts`): a board
   * spanning three hundred epics would otherwise build one query long enough to find the
   * instance's URL limit, and one deleted epic would cost every name in it.
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
    for (const batch of chunkKeys([...wanted])) {
      const jql = keysInJql(batch);
      if (!jql) continue; // nothing in this batch is shaped like an issue key
      try {
        const epics = await client.search(jql, batch.length, []);
        for (const epic of epics) {
          const summary = epic.fields.summary?.trim();
          if (summary) names.set(epic.key.toUpperCase(), summary);
        }
      } catch {
        // Each batch stands alone: the cards in this one fall back to their epic key,
        // and the rest of the board still gets its names.
      }
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
    // The EFFECTIVE query: the user's filter with `openSprints()` already folded in. Every
    // question below is asked against this one, and it is the string the confirm pass has to
    // use too — confirming against the raw JQL would keep every card the sprint filter hides.
    const jql = jira.currentSprintOnly ? withCurrentSprint(jira.jql) : jira.jql;
    const extraFields = [epicField, sprintField].filter((f): f is string => f !== null);
    // Whether the question itself changed since last time — a sprint rolling over counts,
    // which is why this compares the effective JQL rather than the setting. Null means we
    // have never recorded one, and that is read as *unchanged*: the board was kept tight
    // against the query by every version before this one, so there is no backlog of stale
    // cards for the removal guard to trip over on the first sync after an upgrade.
    const lastQuery = store.loadJiraLastQuery();
    const queryChanged = lastQuery !== null && lastQuery !== jql;
    // The whole query, paged to the end — see `searchAll`. `truncated` is the one fact that
    // separates a short answer from a small board, and everything below turns on it.
    //
    // **The first sync on this version is the noisy one, and that is expected.** What ran here
    // before asked for one page of 100 and treated it as the whole query, so on any board
    // whose query matches more than that, every issue past the hundredth was never fetched —
    // and the reconciler, seeing no issue for those cards, deleted them. They arrive in this
    // one answer and the board can visibly grow, by hundreds, in a single poll.
    //
    // The direction is the reassuring part: the first sync ADDS. The old cap could only ever
    // hide a ticket the query still matched, never invent one it didn't, so nothing coming
    // back here is spurious. Departures still leave — that is the point of the confirm pass
    // below — but each is confirmed by key, archived rather than deleted, logged by key, and
    // listed under **Removed cards**. If the number is large enough to be alarming it is
    // `guardRemovals` that decides, not this comment: past a quarter of the board in one sync
    // nothing is removed at all and the human is told instead. It settles from the second sync
    // on, and Phase 5's Removed-cards list is what makes the first one inspectable rather than
    // merely survivable — which is why the two shipped together.
    const { issues, truncated } = await client.searchAll(jql, {
      limit: JIRA_BOARD_LIMIT,
      extraFields,
    });
    if (truncated) {
      logMain(
        `JIRA sync: the search returned ${issues.length} issues without reaching the end of ` +
          `the query (limit ${JIRA_BOARD_LIMIT}) — nothing will be removed from the board ` +
          `this sync. Query: ${jql}`,
      );
    }
    // The ONE read that includes archived cards (see `Store.getPersonalTasksForSync`). The
    // reconciler is deciding what each of JIRA's issues corresponds to, and a card that was
    // taken off the board still corresponds to its ticket — invisible to it, the sync would
    // mirror that ticket back in as a brand-new card and lose everything the old row carried.
    const personalForSync = store.getPersonalTasksForSync();

    /** One place to log a batch nobody got an answer out of, so both passes read the same. */
    const batchLog = (pass: string) => ({
      onBatchFailed: (batchKeys: readonly string[], e: unknown) =>
        logMain(`JIRA sync: ${pass} batch failed for ${batchKeys.join(', ')} — kept`, e),
      onBatchTruncated: (batchKeys: readonly string[]) =>
        logMain(`JIRA sync: ${pass} batch came back truncated for ${batchKeys.join(', ')} — kept`),
    });

    // Re-read the cards the board is keeping PAST the query, by key. A finished card is
    // retained rather than removed (see `jiraSync.ts`), and this is what stops it freezing
    // there: the query that dropped it will very likely never mention it again, so asking
    // by key is the only way it can follow its ticket back into IN PROGRESS.
    const { checked: recheckedKeys, issues: rechecked } = await recheckByKey(
      client,
      retainedKeys(personalForSync, issues),
      { extraFields, ...batchLog('re-read') },
    );

    // Confirm, by key, that the cards the search left out really have left the query.
    //
    // "Isn't this expensive?" — no: on a healthy board it is ZERO extra requests. Only cards
    // the search failed to return are candidates, and when the search returned everything
    // there are none. It costs one request per fifty candidates, and a board producing
    // candidates every sync is a board that was quietly losing cards before this existed.
    //
    // Skipped entirely when the fetch was truncated: the reconciler removes nothing on a
    // short answer anyway, so the question would be paid for and thrown away.
    //
    // The case where that "zero extra requests" stops being true, stated so nobody discovers it
    // as a mystery: a query that is **permanently wrong** — someone saves a JQL that matches
    // nothing, or narrows a filter and leaves it there. Every card on the board is then a
    // candidate on every poll, the guard refuses the removal (it is far past a quarter of the
    // board), the warning bar comes back, and the confirm pass is paid for again — one request
    // per fifty cards, at the sync interval, by default every two minutes. Nothing is lost and
    // nothing is removed; it is steady noise plus request volume until the query is fixed.
    //
    // Deliberately not mitigated here. The obvious mitigation is real and written down rather
    // than built: after a refusal, skip the confirm pass on the next sync unless the query
    // changed. It is cheap, and it is also a way to make the app slower to notice a board that
    // has genuinely turned over — the refusal is a *guess* that something is wrong, and paying
    // a request per fifty cards to keep re-checking that guess is the right trade until someone
    // is actually being hurt by it. If it ever bites, that is the fix; `queryChanged` above is
    // already the signal it would key on.
    const candidates = removalCandidateKeys(personalForSync, issues);
    const confirmed =
      candidates.length > 0 && !truncated
        ? await confirmStillMatching(client, jql, candidates, {
            extraFields,
            ...batchLog('confirm'),
          })
        : null;

    const epicNames = await fetchEpicNames(client, [...issues, ...rechecked], epicField);
    const now = Date.now();
    // Recorded before the reconcile rather than after: the applies below cannot throw a
    // network error, so this is the last point at which "the query we just ran" is true.
    store.saveJiraLastQuery(jql);
    const { upserts, removals, restoreIds, refused, warning } = reconcileJiraTasks(
      personalForSync,
      issues,
      {
        baseUrl: jira.baseUrl,
        overrides: jira.statusCategoryOverrides,
        learned: jira.learnedStatusColumns,
        epicFieldId: epicField,
        epicNames,
        sprintFieldId: sprintField,
        identity,
        rechecked,
        recheckedKeys,
        queryChecked: confirmed?.checked ?? null,
        queryMatches: confirmed?.matching ?? null,
        truncated,
        queryChanged,
        now,
        retentionMs: Math.max(0, jira.doneRetentionDays) * 24 * 60 * 60 * 1000,
      },
    );
    // Restore first: a ticket that has come back into the query lands on its own card again,
    // rather than beside the archived one it used to be.
    for (const id of restoreIds) store.unarchiveTask(id);
    for (const t of upserts) store.upsertJiraTask(t);
    // ARCHIVED, not deleted. A card leaving the board is not the human deleting it — the row
    // keeps its timeline, its files and its links, and "Removed cards" can put it back. Each
    // one names the ticket and the reason, because a card that vanished with nothing in the
    // log is exactly the bug this whole change exists to end.
    for (const r of removals) {
      // The reason goes onto the ROW as well as into the log: the log answers "what happened
      // last Tuesday", the row answers "why is this card not on my board", and only one of
      // those questions gets asked by someone looking at the Removed-cards list.
      store.archiveTask(r.taskId, now, r.reason);
      logMain(`JIRA sync: archived ${r.key} — ${r.reason} (${r.title})`);
    }
    for (const r of refused) {
      logMain(`JIRA sync: REFUSED to remove ${r.key} (${r.title}) — ${warning ?? 'guarded'}`);
    }
    // The paging-artifact count, every guard trip and every truncation are all in here.
    if (warning) {
      logMain(`JIRA sync: ${warning}`);
      // Its own bar, not the error bar: nothing failed, and a warning that reads as an
      // error teaches people to dismiss both.
      send('board:notice', { text: warning, intent: 'warning' });
    }
    const tasks = store.getPersonalTasks();
    send('project:tasksChanged', { projectId: PERSONAL_PROJECT_ID, tasks });
    // The board just changed shape, so an MR whose ticket has appeared should attach
    // itself and one whose ticket has left should let go rather than point at a card
    // that no longer exists. No GitLab call — this is re-filing what we already hold.
    rematchStoredMergeRequests();
    return tasks;
  };

  /**
   * The account behind the configured GitHub token, fetched once per site and cached in
   * `app_state`. `jiraIdentity` above, one tracker over, and fail-soft for the same reason:
   * not knowing who you are costs a comment's attribution, while throwing would cost the
   * whole sync.
   */
  const githubIdentity = async (
    baseUrl: string,
    client: GitHubClient,
  ): Promise<GitHubIdentityCache | null> => {
    const cached = store.loadGitHubIdentity();
    if (cached && cached.baseUrl === baseUrl) return cached;
    try {
      const identity = githubIdentityFrom(await client.getMe(), baseUrl);
      store.saveGitHubIdentity(identity);
      return identity;
    } catch {
      return null;
    }
  };

  /**
   * When we last read an issue's comments, by `owner/repo#123` → the issue's `updated_at` at
   * that moment. In memory, not the DB.
   *
   * This is what keeps the comment fetch bounded by the BOARD rather than by the repository:
   * comments are a call per issue, and only issues that have been touched since we last
   * looked can have gained one (GitHub bumps an issue's `updated_at` when a comment is
   * posted). Without it, every commentless card would cost a request on every poll forever.
   *
   * In memory rather than `app_state`, like the JIRA priority cache and the sync clock: the
   * cost of losing it is one extra pass over the board on the first sync after a restart,
   * and a persisted cache is one more thing that can be wrong across an upgrade.
   */
  const githubCommentsReadAt = new Map<string, number>();

  /**
   * One GitHub issue sync: run the user's query, re-read by number whatever it left out,
   * reconcile, apply.
   *
   * `syncJira` above, and every decision it makes for a stated reason is made here for the
   * same one — including the order the results are applied in: **unarchive, then upsert, then
   * archive.** Restore first so an issue that has come back into the query lands on its own
   * card again rather than beside the archived one it used to be.
   *
   * What is deliberately absent is JIRA's *confirm* pass. It exists there because a JQL
   * cannot be asked about one issue cheaply, so "this stopped matching" and "that page was
   * short" are indistinguishable without a second query. Here they are not: GitHub says so
   * itself (`incomplete_results`, plus our own page cap — see `searchIssues`), and one call
   * re-reads an issue by number. One pass answers both questions.
   */
  const syncGitHubIssues = async (): Promise<Task[]> => {
    const { github } = store.getSettings();
    if (!github.enabled || !github.syncIssues) return store.getPersonalTasks();
    const client = buildGitHubClient();
    const identity = await githubIdentity(github.baseUrl, client);

    const query = github.issueQuery.trim();
    if (!query) {
      throw new Error('Set the GitHub issue query in Settings, or turn issue syncing off.');
    }
    // Whether the question itself changed since last time — an edited query. Null is read as
    // *unchanged*, so the first sync after an upgrade does not have the guard stand down on a
    // board it has never seen.
    const lastQuery = store.loadGitHubLastQuery();
    const queryChanged = lastQuery !== null && lastQuery !== query;

    const { items, truncated } = await client.searchIssues(query);
    if (truncated) {
      logMain(
        `GitHub sync: the issue search returned ${items.length} issues without reaching the ` +
          `end of the query — nothing will be removed from the board this sync. Query: ${query}`,
      );
    }

    // The ONE read that includes archived cards: a card taken off the board still corresponds
    // to its issue, and a reconciler blind to it would mirror that issue back in as a brand
    // new card, losing everything the old row carried. See `getPersonalTasksForSync`.
    const personalForSync = store.getPersonalTasksForSync();

    /**
     * Re-read, by number, every card the search left out. Bounded by the board (at most one
     * call per card on it), and on a healthy board it is ZERO calls — the search returned
     * everything, so there is nothing to ask about.
     *
     * `checked` is the per-issue counterpart of the whole-pass `rechecked: null`: a call that
     * errored (a transient 502, a repository that just went private) must not read as "GitHub
     * does not have this issue". Only the keys that actually answered go in.
     */
    const toRecheck = issuesToRecheck(personalForSync, items);
    const rechecked = new Map<string, GitHubSearchIssueItem>();
    const recheckedKeys = new Set<string>();
    const recheckQueue: IssueRef[] = [...toRecheck];
    const recheckWorker = async (): Promise<void> => {
      for (let ref = recheckQueue.shift(); ref; ref = recheckQueue.shift()) {
        try {
          const issue = await client.getIssue(ref.owner, ref.repo, ref.number);
          rechecked.set(ref.key, issue);
          recheckedKeys.add(ref.key);
        } catch (e) {
          // A 404 is an ANSWER — GitHub does not have it — and anything else is a question
          // that failed. Only the first lets the card leave the board.
          if (e instanceof GitHubError && e.status === 404) {
            recheckedKeys.add(ref.key);
          } else {
            logMain(`GitHub sync: re-read of ${ref.key} failed — kept`, e);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, recheckQueue.length) }, recheckWorker));

    /**
     * The comments, for the issues that could have gained one — see `githubCommentsReadAt`.
     *
     * A key ABSENT from this map means "not asked this time", which keeps whatever the card
     * already knew; present-and-empty means "asked, and there are none". A failed fetch is
     * left absent, so a rate limit cannot blank a card's unread marker.
     */
    const comments = new Map<string, GitHubIssueComment[]>();
    const commentQueue = [...items, ...rechecked.values()].filter((issue) => {
      const { owner, repo } = repoRefFromApiUrl(issue.repository_url);
      const key = `${owner}/${repo}#${issue.number}`;
      const updatedAt = Date.parse(issue.updated_at) || 0;
      return updatedAt > (githubCommentsReadAt.get(key) ?? 0);
    });
    const commentWorker = async (): Promise<void> => {
      for (let issue = commentQueue.shift(); issue; issue = commentQueue.shift()) {
        const { owner, repo } = repoRefFromApiUrl(issue.repository_url);
        const key = `${owner}/${repo}#${issue.number}`;
        try {
          comments.set(key, await client.listIssueComments(owner, repo, issue.number));
          githubCommentsReadAt.set(key, Date.parse(issue.updated_at) || 0);
        } catch (e) {
          logMain(`GitHub sync: comments for ${key} could not be read — kept as they were`, e);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, commentQueue.length) }, commentWorker));

    const now = Date.now();
    // Recorded before the reconcile rather than after: nothing below can throw a network
    // error, so this is the last point at which "the query we just ran" is true.
    store.saveGitHubLastQuery(query);
    const { upserts, removals, restoreIds, refused, warning } = reconcileGitHubIssues(
      personalForSync,
      items,
      {
        overrides: github.labelColumnOverrides,
        learned: github.learnedLabelColumns,
        identity,
        comments,
        rechecked,
        recheckedKeys,
        truncated,
        queryChanged,
        now,
        retentionMs: Math.max(0, github.doneRetentionDays) * 24 * 60 * 60 * 1000,
      },
    );
    for (const id of restoreIds) store.unarchiveTask(id);
    for (const t of upserts) store.upsertJiraTask(t);
    // ARCHIVED, not deleted — see the same loop in `syncJira`. The row keeps its timeline,
    // its files and its links, and "Removed cards" can put it back.
    for (const r of removals) {
      store.archiveTask(r.taskId, now, r.reason);
      logMain(`GitHub sync: archived ${r.key} — ${r.reason} (${r.title})`);
    }
    for (const r of refused) {
      logMain(`GitHub sync: REFUSED to remove ${r.key} (${r.title}) — ${warning ?? 'guarded'}`);
    }
    if (warning) {
      logMain(`GitHub sync: ${warning}`);
      // Its own bar, not the error bar: nothing failed, and a warning that reads as an error
      // teaches people to dismiss both.
      send('board:notice', { text: warning, intent: 'warning' });
    }
    const tasks = store.getPersonalTasks();
    send('project:tasksChanged', { projectId: PERSONAL_PROJECT_ID, tasks });
    return tasks;
  };

  /**
   * `syncJira`, with the diagnosis attached to whatever it throws — so the board's error
   * bar explains a bad deployment/credential the same way the Settings "Test connection"
   * button does.
   *
   * INSIDE `trackSync`, deliberately. The status bar keeps the message of the error that
   * reached it, and the background poller reaches it by a different route from the button;
   * diagnosing outside meant a background 401 left "JIRA 401 Unauthorized" in the tooltip
   * with none of the advice, which is precisely the failure a user then reports as "my
   * token is valid and it still says 401".
   */
  const syncJiraDiagnosed = async (): Promise<Task[]> => {
    try {
      return await syncJira();
    } catch (e) {
      logMain('JIRA sync failed', e);
      throw new Error(explainJiraFailure(e, store.getSettings().jira));
    }
  };

  handle('jira:sync', async () => trackSync('jira', syncJiraDiagnosed));

  /**
   * Remember that a JIRA status means the column the user just dropped a card into.
   *
   * A drag that transitions a ticket is the strongest possible statement about what a
   * workflow's status means — you looked at the board, picked the column, and JIRA
   * accepted the move. Before this, that knowledge was thrown away: the outgoing
   * transition could be chosen by the name heuristic while the incoming sync read the
   * same status by its category, so the very next sync moved the card back.
   *
   * Only ever *adds*, and only when `shouldLearnStatus` says the drag actually taught us
   * something — that decision lives in `jira/jiraMove.ts`, where it can be tested. All
   * that is left here is the trim, the guard and the write.
   */
  const learnStatusColumn = (
    statusName: string,
    category: JiraStatusCategory,
    column: BoardColumn,
  ): void => {
    const name = statusName.trim();
    const settings = store.getSettings();
    const { jira } = settings;
    if (!shouldLearnStatus(name, category, column, jira)) return;
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

  /**
   * Remember that a GitHub LABEL means the column the user just dropped a card into.
   *
   * `learnStatusColumn` above, one forge over, and the reason is identical: without it the
   * move and the poll read the same thing differently and the next sync undoes the drag. The
   * decision itself is `shouldLearnLabel`'s, in `github/githubMove.ts` where it is testable;
   * all that is left here is the trim, the guard and the write.
   */
  const learnLabelColumn = (label: string, column: BoardColumn): void => {
    const name = label.trim();
    const settings = store.getSettings();
    const { github } = settings;
    if (!shouldLearnLabel(name, column, github)) return;
    const next: AppSettings = {
      ...settings,
      github: {
        ...github,
        learnedLabelColumns: { ...github.learnedLabelColumns, [name]: column },
      },
    };
    store.saveSettings(next);
    send('settings:changed', next);
  };

  /** What a transition attempt did: whether the tracker moved, and what to patch locally. */
  interface TransitionOutcome {
    /** True only when a transition was actually POSTed and accepted. */
    applied: boolean;
    /** The tracker fields to write onto the card. Empty when nothing was applied. */
    patch: Parameters<Store['updateTask']>[1];
  }

  /**
   * What to store in `preBlockStatus` — which is now a marker of WHO owns the block, not
   * just a remembered column.
   *
   * A block that stayed local (an internal card, or a workflow with no blocked status) is
   * the app's own: nothing else will ever move that card out again, so it must remember the
   * column to restore. A block the tracker took is the tracker's: the ticket really is
   * Blocked, the sync reads it as BLOCKED, and un-blocking happens by the issue leaving that
   * status — a remembered column here would only compete with what the next sync says.
   *
   * Null therefore means "the tracker is holding this card blocked", which is exactly the
   * fact the sync side needs, and it is stored rather than re-derived because a workflow's
   * transitions can change between the drop and the sync.
   */
  const preBlockMarker = (
    move: Pick<MoveResolution, 'preBlockStatus'>,
    outcome: TransitionOutcome | null,
  ): TaskStatus | null => (outcome?.applied ? null : move.preBlockStatus);

  /**
   * Transition the linked issue and hand back the tracker fields to patch locally.
   *
   * Called BEFORE any local write, and it throws rather than returning a failure: if the
   * tracker rejects the move (no such transition in this workflow, the token lacks the
   * permission) the card must not budge either, or the board would be showing a column
   * the ticket has never been in. The optimistic move in the UI rolls back on the throw.
   *
   * `toBlocked` is the single exception, and the only reason this returns an outcome rather
   * than a bare patch. For every other target a null pick means the drag is impossible —
   * there is no In Progress to move to, so pretending otherwise would be the lie above. But
   * BLOCKED is a column the board has always had and plenty of workflows have no status
   * for; "your workflow cannot say blocked" is not a reason to refuse a human marking a
   * card stuck. So a missing blocked transition is soft: nothing is POSTed, `applied` is
   * false, and the card blocks locally exactly as it did before this column reached JIRA.
   * A real failure of the POST still throws, for `toBlocked` as for everything else.
   */
  const transitionIssue = async (
    task: Task,
    target: JiraTransitionTarget,
    toColumn: BoardColumn,
  ): Promise<TransitionOutcome> => {
    // JIRA in particular, and this is the other WRITE-BACK: a transition is a POST to a JIRA
    // workflow, which a GitHub issue does not have. Writing a card's move back to GitHub is a
    // different act on a different API (open/close, and a label) and lives in its own path —
    // a GitHub card reaching here would silently do nothing, which is the correct outcome
    // until that path exists and the wrong one to leave unstated.
    if (task.externalSource !== 'jira' || !task.externalKey) return { applied: false, patch: {} };
    const client = buildJiraClient();
    const { jira } = store.getSettings();
    const transitions = await client.getTransitions(task.externalKey);
    const choice = pickTransition(transitions, target, jira);
    if (!choice && target === 'toBlocked') return { applied: false, patch: {} };
    if (!choice) {
      // Name the blocked-ish step when the workflow has one. It is the transition this
      // picker used to take by accident, so a user looking at a "Block" button in JIRA
      // and an error here would otherwise conclude we simply cannot see it — rather than
      // that we saw it, read it as BLOCKED, and refused to press it on their behalf.
      const blocking = transitions.filter((t) =>
        isBlockedishStatus(t.to.name, categoryFromKey(t.to.statusCategory.key)),
      );
      const aside = blocking.length
        ? ` The closest this workflow offers is ${blocking
            .map((t) => `"${t.name}" (→ ${t.to.name})`)
            .join(', ')}, which reads as BLOCKED, not ${TARGET_LABEL[target]}.`
        : '';
      throw new Error(
        `No JIRA transition to ${TARGET_LABEL[target]} is available for ${task.externalKey}.${aside} ` +
          `Set an exact transition name in Settings if your workflow uses a custom one.`,
      );
    }
    const picked = choice.transition;
    await client.doTransition(task.externalKey, picked.id);
    const category = categoryFromKey(picked.to.statusCategory.key);
    // The exact-name override took a transition that lands somewhere else. It was still
    // applied — the box exists for workflows we cannot read — but this bar is the only
    // surface that can tell someone their configured name is doing something they did
    // not intend, which is exactly how a typo in it survives for months.
    if (choice.mismatch) {
      send('board:notice', {
        intent: 'warning',
        text:
          `${task.externalKey}: the transition named "${picked.name}" in Settings lands on ` +
          `"${picked.to.name}", which this board reads as ${COLUMN_LABEL[choice.destinationColumn]}, ` +
          `not ${COLUMN_LABEL[toColumn]}. The move was applied as configured.`,
      });
    }
    learnStatusColumn(picked.to.name, category, toColumn);
    // Reflect the new tracker status locally for display.
    return {
      applied: true,
      patch: { externalStatus: picked.to.name, externalStatusCategory: category },
    };
  };

  /**
   * Write a card's move back to GitHub — `transitionIssue`, one forge over, and under the same
   * contract: called BEFORE any local write, and it **throws** rather than returning a failure.
   * If GitHub rejects the write (the token cannot write to that repository, the issue was
   * transferred, the API is down) the card must not budge either, or the board would be showing
   * a column the issue has never been in. `task:move` rejects and the optimistic move in the UI
   * rolls back.
   *
   * The order of the writes is state → add → remove, and it is the order of consequence: the
   * open/closed state is the coarse fact, the added label is what makes IN PROGRESS and IN
   * REVIEW mean anything at all, and a stale label left behind is the only one of the three a
   * later poll can survive. A partial failure still throws.
   *
   * `applied` is not "the calls returned 2xx" — it is **"will the next poll agree?"**, asked of
   * `resolveGitHubColumn`, the very resolver the sync uses, against the labels and state this
   * move leaves behind. That is what makes BLOCKED come out right without a special case: a
   * blocked drop backed by a mapped label is GitHub's block (`applied`, so no `preBlockStatus`
   * is remembered and removing the label in the browser unblocks it), and one backed by nothing
   * mapped is ours (not applied, so the column to restore is remembered and every poll
   * preserves it).
   */
  const moveGitHubIssue = async (task: Task, target: BoardColumn): Promise<TransitionOutcome> => {
    const { github } = store.getSettings();
    // Not "the forge refused" — the integration is switched off, so there is nothing to
    // disagree with and nothing to write. The card moves locally, as it did before GitHub
    // could be asked at all.
    if (!github.enabled) return { applied: false, patch: {} };
    const ref = task.externalKey ? parseIssueKey(task.externalKey) : null;
    if (!ref) return { applied: false, patch: {} };
    const client = buildGitHubClient();

    // Re-read the issue first, for its CURRENT labels. The card only remembers the one label
    // that decided its column, and this needs the whole set: which of them speak for a column
    // the card is leaving, and whether the one that would say the new column is already there.
    // One call per drag, and it is also what makes a drag onto a deleted issue fail loudly.
    const issue = await client.getIssue(ref.owner, ref.repo, ref.number);
    const labels = (issue.labels ?? [])
      .map((l) => (l?.name ?? '').trim())
      .filter((name) => name.length > 0);
    const change = planLabelChange(labels, issue.state, target, github);
    // BLOCKED is the one target GitHub is allowed not to be able to say — see `githubMove.ts`
    // and `JiraSettings.blockedTransitionName`. The card blocks locally instead.
    if (!change && target === 'blocked') return { applied: false, patch: {} };
    if (!change) {
      throw new Error(
        `No GitHub label means ${COLUMN_LABEL[target]}, and a GitHub issue has no state that ` +
          `does — an issue is only open or closed. Map a label to ${COLUMN_LABEL[target]} in ` +
          `Settings, then move ${task.externalKey} again.`,
      );
    }

    if (change.state) {
      await client.setIssueState(ref.owner, ref.repo, ref.number, change.state);
    }
    if (change.addLabel) {
      await client.addLabels(ref.owner, ref.repo, ref.number, [change.addLabel]);
    }
    for (const label of change.removeLabels) {
      try {
        await client.removeLabel(ref.owner, ref.repo, ref.number, label);
      } catch (e) {
        // The label is not on the issue any more — somebody removed it in the browser, or two
        // drags raced. That is the state we were asking for, so it is not a failure.
        if (e instanceof GitHubError && e.status === 404) continue;
        throw e;
      }
    }

    // Only now, with GitHub having accepted it: a drag is the strongest statement there is
    // about what a label means, and this is what stops the next poll disagreeing with it.
    if (change.columnLabel) learnLabelColumn(change.columnLabel, target);
    const after = resolveGitHubColumn(
      change.labelsAfter,
      change.stateAfter,
      github.labelColumnOverrides,
      // Re-read, because the learn above may just have written into it.
      store.getSettings().github.learnedLabelColumns,
    );
    return {
      applied: after.column === target,
      patch: {
        // What the board is calling the issue's status, by exactly the rule `issueToTask` uses:
        // the label that decided the column, or the issue's own state when nothing else spoke.
        externalStatus: after.label ?? change.stateAfter,
        externalStatusCategory: categoryForColumn(after.column),
      },
    };
  };

  /**
   * The forge write one drop needs, whichever forge the card came from, or null when it came
   * from neither. One place, so the two controls that move a card — the board's drag and the
   * detail pane's dropdown — cannot drift into supporting different trackers.
   *
   * Each resolver answers only its own half: the local half (`resolveMove`) is shared and is
   * already in hand by the time this is called, and the GitHub resolver's `target` is the one
   * fact it adds — which column the ISSUE has to be made to say, or null for a card GitHub has
   * never heard of.
   */
  const writeMoveToForge = async (
    task: Task,
    move: MoveResolution,
    toColumn: BoardColumn,
  ): Promise<TransitionOutcome | null> => {
    if (move.jiraTransition) return transitionIssue(task, move.jiraTransition, toColumn);
    const target = resolveGitHubMove(task, toColumn).target;
    return target ? moveGitHubIssue(task, target) : null;
  };

  handle('task:move', async (taskId, toColumn) => {
    const existing = store.getTask(taskId);
    if (!existing) throw new Error('Task not found.');
    // Draggable mid-run, on purpose: `resolveMove` reads where the card RESTS and
    // `humanStatusPatch` writes to the field the run is not using, so the column follows
    // the drop and the session carries on. (See `cardStatusGuard.ts`.)
    const move = resolveMove(existing, toColumn);
    if (move.noop) return existing;

    const outcome = await writeMoveToForge(existing, move, toColumn);
    const patch: Parameters<Store['updateTask']>[1] = {
      ...humanStatusPatch(existing, move.localStatus),
      preBlockStatus: preBlockMarker(move, outcome),
      ...(outcome?.patch ?? {}),
    };

    const task = store.updateTask(taskId, patch);
    if (!task) throw new Error('Task not found.');
    store.recordStatusChange(task.projectId, taskId, restingStatus(existing), move.localStatus);
    send('task:changed', { task, runId: null });
    // Dropped into DONE: the human is finished with this card, so nothing it was asking is
    // still a live question. The ring goes quiet by itself (`chainNeedsAttention` overrides
    // a closed card), but the INBOX is a list of its own — an item left behind outlives the
    // ring, cannot be acted on any more, and keeps counting in the nav rail's badge.
    if (restingStatus(task) === 'done') scheduler.dismissAttentionForCard(taskId);
    // Dragged back to TO DO re-asks the chain (Phase 21) — the path a drag actually takes,
    // and the one that matters: a card released while it sat in Blocked was told "Ready to
    // start … start it whenever you like", and dropping it in To Do is how a human says so.
    // `move.localStatus` rather than the column, because the column's representative status
    // is the thing `reconsider` gates on. See `task:setStatus` for the rest of the reasoning.
    if (move.localStatus === 'pending') scheduler.reconsiderChains('card-changed');
    return task;
  });

  // Brief a delegated card's agent with the ticket's comment thread (oldest first).
  // The scheduler has no tracker client of its own, so it calls back in here on each fresh
  // agent run; anything unlinked or unconfigured yields no comments rather than an error.
  //
  // Either tracker, fetched live rather than read from the board: a comment thread is not
  // stored anywhere the scheduler could reach, and the point of the brief is that the agent
  // starts a run knowing what has been said since the last one.
  scheduler.setTicketCommentProvider(async (task) => {
    const settings = store.getSettings();
    if (task.externalKey && task.externalSource === 'jira' && settings.jira.enabled) {
      const comments = await buildJiraClient().getComments(task.externalKey);
      return comments
        .map((c) => ({
          author: c.author?.displayName ?? 'JIRA',
          body: commentBodyToText(c.body),
          createdAt: Date.parse(c.created) || 0,
        }))
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(({ author, body }) => ({ author, body }));
    }
    if (task.externalKey && task.externalSource === 'github' && settings.github.enabled) {
      const ref = parseIssueKey(task.externalKey);
      if (!ref) return [];
      // Already oldest-first from the API, and sorted anyway for the same reason the JIRA
      // branch sorts: the brief's own wording promises the order.
      const comments = await buildGitHubClient().listIssueComments(ref.owner, ref.repo, ref.number);
      return comments
        .map((c) => ({
          author: c.user?.login ?? 'GitHub',
          body: (c.body ?? '').trim(),
          createdAt: Date.parse(c.created_at) || 0,
        }))
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(({ author, body }) => ({ author, body }));
    }
    return [];
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

  /**
   * Clear a card's unread border. Any external tracker: this touches nothing but our own two
   * markers, and "opening a card clears its unread border" is the same statement for a GitHub
   * issue as for a JIRA ticket.
   *
   * One implementation behind two channel names. `jira:markRead` keeps its name because the
   * renderer's contract already has it and what it does never was tracker-specific;
   * `github:markRead` exists so a GitHub pane need not call the other tracker's channel. A
   * second *implementation* is what would eventually let them disagree.
   */
  const markCommentsRead = async (taskId: string): Promise<Task> => {
    const task = store.getTask(taskId);
    if (!task) throw new Error('Task not found.');
    if (task.externalSource == null) return task;
    const updated = store.updateTask(taskId, {
      lastReadCommentAt: task.latestCommentAt ?? Date.now(),
    });
    if (updated) send('task:changed', { task: updated, runId: null });
    return updated ?? task;
  };

  handle('jira:markRead', (taskId) => markCommentsRead(taskId));
  handle('github:markRead', (taskId) => markCommentsRead(taskId));

  /**
   * The issue behind a GitHub card, or null when this card is not one.
   *
   * Every handler below starts here, and all three want the same three things — the card is
   * GitHub's, its key parses, and there is a client to ask with — so the check is written once.
   */
  const githubIssueForTask = (taskId: string): IssueRef | null => {
    const task = store.getTask(taskId);
    if (!task || task.externalSource !== 'github' || !task.externalKey) return null;
    return parseIssueKey(task.externalKey);
  };

  handle('github:fetchComments', async (taskId) => {
    const ref = githubIssueForTask(taskId);
    if (!ref) return [];
    const task = store.getTask(taskId);
    const client = buildGitHubClient();
    // Who the token belongs to, so your own comments sit on your side of the pane. Unknown
    // identity → every comment reads as someone else's, deliberately (see `identity.ts`).
    const identity = await githubIdentity(store.getSettings().github.baseUrl, client);
    const comments = await client.listIssueComments(ref.owner, ref.repo, ref.number);
    // No attachment pass, unlike the JIRA handler: GitHub has no per-issue file list to match
    // a comment against — an uploaded file is a link inside the Markdown, already in `body`.
    const entries = comments.map((c) => ({
      kind: 'github-comment' as const,
      id: String(c.id),
      author: c.user?.login ?? 'GitHub',
      body: (c.body ?? '').replace(/\s+$/, ''),
      createdAt: Date.parse(c.created_at) || 0,
      mine: githubAuthorIsMe(c.user, identity),
    }));
    // Keep the unread marker honest with freshly-fetched comments — OTHER people's only, for
    // the reason `jira:fetchComments` gives: folding your own back in would undo `markRead`
    // the instant the pane opened.
    const latest = entries
      .filter((e) => !e.mine)
      .reduce((m, e) => Math.max(m, e.createdAt), task?.latestCommentAt ?? 0);
    if (latest && latest !== task?.latestCommentAt) {
      store.updateTask(taskId, { latestCommentAt: latest });
    }
    return entries;
  });

  /**
   * A repository's mentionable people, keyed by site + `owner/repo`.
   *
   * The WHOLE list per repository rather than a list per query, because GitHub has no search
   * parameter on this endpoint: one call answers every keystroke that follows, and the
   * filtering is done here. Same fail-soft rule as the JIRA picker — an empty list still lets
   * the user type a plain name, which posts as ordinary text.
   */
  const githubUserCache = new Map<string, JiraUserOption[]>();

  handle('github:searchUsers', async (taskId, query) => {
    const { github } = store.getSettings();
    const needle = query.trim().toLowerCase();
    if (!github.enabled || !needle) return [];
    const ref = githubIssueForTask(taskId);
    if (!ref) return [];
    const cacheKey = `${github.baseUrl}|${ref.owner}/${ref.repo}`;
    let people = githubUserCache.get(cacheKey);
    if (!people) {
      try {
        const users = await buildGitHubClient().listAssignableUsers(ref.owner, ref.repo);
        // The LOGIN in both fields, and that is the point: what the picker writes into the
        // text is `@login`, which is already the mention GitHub resolves. A display name here
        // would put a label in the comment that links to nobody.
        people = users
          .filter((u) => (u.login ?? '').trim().length > 0)
          .map((u) => ({
            id: u.login,
            displayName: u.login,
            email: null,
            avatarUrl: u.avatar_url ?? null,
          }));
        githubUserCache.set(cacheKey, people);
      } catch (e) {
        logMain('GitHub collaborator list failed', e);
        return [];
      }
    }
    return people.filter((p) => p.displayName.toLowerCase().includes(needle)).slice(0, 20);
  });

  handle('github:addComment', async (taskId, draft) => {
    const ref = githubIssueForTask(taskId);
    if (!ref) throw new Error('This task is not linked to a GitHub issue.');
    // Trailing whitespace only — the mention ranges are offsets into this exact string, so
    // trimming the front would move every one of them. A mention left dangling past the cut is
    // dropped by `buildCommentBody`.
    const text = draft.text.replace(/\s+$/, '');
    if (draft.attachmentPaths?.length) {
      // Refused, not ignored. GitHub has no REST route for attaching a file to an issue (the
      // browser uploads through a private endpoint), and posting the words while quietly
      // dropping the file is the failure the human would find out about last.
      throw new Error(
        'GitHub has no API for attaching files to an issue — attach it in the browser, or ' +
          'link to it from the comment.',
      );
    }
    if (!text) throw new Error('A comment needs some text.');
    const client = buildGitHubClient();
    const created = await client.addIssueComment(
      ref.owner,
      ref.repo,
      ref.number,
      buildCommentBody(
        text,
        (draft.mentions ?? []).map((m) => ({ start: m.start, end: m.end, login: m.id })),
      ),
    );
    // Bump both markers so our own comment never lights the unread border.
    const at = Date.parse(created?.created_at ?? '') || Date.now();
    const updated = store.updateTask(taskId, { latestCommentAt: at, lastReadCommentAt: at });
    if (updated) send('task:changed', { task: updated, runId: null });
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
  // (`syncIntervalMinutes`; 0 = off). Re-armed whenever settings change.
  // Constructed AFTER every handle() call on purpose: anything that can throw while
  // registering would otherwise leave the API half-wired — some channels live, the
  // ones below it missing — which is the same failure mode as a dead engine, only
  // harder to spot.
  //
  // Every service goes through `trackSync`, so a background tick moves the status bar's ring
  // exactly as the button does — the bar's whole job is answering "how fresh is this", and a
  // poll it could not see would leave the ring counting down past a sync that had happened.
  const syncPoller = new SyncPoller(store, [
    {
      id: 'jira',
      isEnabled: (s) => s.getSettings().jira.enabled,
      run: () => trackSync('jira', syncJiraDiagnosed),
    },
    {
      id: 'gitlab',
      isEnabled: (s) => s.getSettings().gitlab.enabled,
      run: () => trackSync('gitlab', syncGitLab),
    },
    {
      id: 'github',
      isEnabled: (s) => s.getSettings().github.enabled,
      // `syncGitHub`, not the PR half alone: the background poll is what keeps the board's
      // GitHub cards current, and a poller wired to only one of the two halves is exactly how
      // an integration comes to work when you press the button and not otherwise.
      run: () => trackSync('github', syncGitHub),
    },
  ]);
  syncPoller.reschedule();

  // Relayed commands drain here, serially, in the order the server delivered them.
  //
  // The event fan-out this used to do per outcome is gone, and its absence is the point:
  // every relayed command now runs a REAL handler (`ipc-invoke` → `ipcRegistry`), and those
  // handlers already push `task:changed` / `project:tasksChanged` themselves — plus the
  // chain, attachment and merge-request pushes a hand-rolled fan-out never knew about. Left
  // in, every relayed invoke would have pushed twice, which for a whole-list event like
  // `chain:changed` means the board re-renders from two identical payloads for every click
  // somebody makes in a browser.
  //
  // The three v1 edit kinds are the exception — they write through `Store` directly and have
  // no handler behind them — so they, and only they, still get their events pushed here.
  const cloudCommandQueue = new CommandQueue<CommandEnvelope, CloudCommandOutcome>({
    run: (command) => applyCloudCommand(store, command),
    onResult: (command, outcome) => {
      if (!outcome.ok) {
        logMain(`cloud: command ${outcome.id} rejected — ${outcome.reason}`);
        return;
      }
      if (command.kind === 'ipc-invoke') return; // the handler announced itself already
      if (outcome.projectId) {
        send('project:tasksChanged', {
          projectId: outcome.projectId,
          tasks: store.getTasks(outcome.projectId),
        });
      }
      if (!outcome.taskId) return;
      const task = store.getTask(outcome.taskId);
      if (!task) return;
      send('task:changed', { task, runId: null });
      // Same two follow-ups `task:setStatus` makes for a human's own move — see its own
      // comments in this file for why each one exists.
      if (restingStatus(task) === 'done') scheduler.dismissAttentionForCard(task.id);
      if (task.status === 'pending') scheduler.reconsiderChains('card-changed');
    },
    // `applyCloudCommand` is contracted not to throw, so this is a bug rather than a command
    // that failed — logged loudly, and the drain carries on with the ones behind it.
    onError: (command, error) => logMain(`cloud: command ${command.id} threw`, error),
  });

  // The forwarder built inert at the top of this function can finally send: the settings, the
  // token and the client id it needs all exist by here. Nothing else changes — `send` has been
  // handing it every event since the first line of the engine ran, and it has been dropping
  // them, because no browser had been reported watching.
  cloudEvents.configure({
    getSettings: () => store.getSettings().cloud,
    getAccessToken: getCloudAccessToken,
    // The SAME id `SyncRequest.clientId` carries, so the server can tell a pushed event and a
    // mirrored row came from one desktop — which is what step 7 needs to name it in the web.
    getClientId: () => store.loadCloudClientId(),
  });

  // The bytes half of the same mirror. Configured here for the same reason — it needs the
  // store and the token getter — and then asked once, which is the boot backfill: everything
  // attached before this build (or while the cloud was off, or during an outage) is exactly
  // what has no `cloudBlobAt`, and one pass at a file a second is what walks it. A desktop
  // with the cloud switched off does none of this and makes no requests.
  cloudAttachments.configure({
    getSettings: () => store.getSettings().cloud,
    getAccessToken: getCloudAccessToken,
    listAttachments: () => store.listAttachments(),
    readBytes: (attachment) =>
      readFile(attachmentFile(userData, attachment.taskId, attachment.name)),
    markUploaded: (id, at) => store.markAttachmentUploaded(id, at),
    // How a browser finds out its thumbnail is ready: `attachment:changed` is forwarded, so
    // the row it already listens to comes back carrying `cloudBlobAt`.
    onUploaded: () => pushAttachments(),
  });
  cloudAttachments.scan();

  // The cloud mirror's own poller — same `trackSync` wrapping as JIRA/GitLab above, so the
  // status bar's ring reacts to it identically, but its own seconds-scale, self-scheduling
  // timer rather than a slot on `syncPoller`'s shared one. See `cloudPoller.ts`'s header for
  // why the two must not share a clock.
  const cloudPoller = new CloudPoller({
    store,
    focus: focusTracker,
    getSettings: () => store.getSettings().cloud,
    getAccessToken: getCloudAccessToken,
    // What a browser names this desktop by, once it has more than one to choose between —
    // see `ClientInfo` on `@protocol/wire`. Built here because this is the only side of
    // `cloudPoller.ts` that is allowed to touch Electron; read fresh per tick because
    // nothing forces it to be constant and pinning it would only be a way to go stale.
    getClientInfo: (): ClientInfo => ({
      name: hostname(),
      platform: process.platform,
      appVersion: app.getVersion(),
      protocolVersion: PROTOCOL_VERSION,
    }),
    // Hand the batch to the serial drain and return. Applying is `cloudCommands.ts`'s job,
    // ordering and one-at-a-time is `commandQueue.ts`'s, and acking is free: each command
    // records itself in the ledger, which the next tick's `SyncRequest.ackedCommandIds` and
    // `SyncRequest.results` both read straight off.
    onCommands: (commands) => cloudCommandQueue.enqueue(commands),
    // The only route that can tell the forwarder whether anyone is watching — see
    // `CloudPollerDeps.onEventListeners`. Zero here is what stops a desktop posting a running
    // agent's transcript into the cloud for nobody.
    onEventListeners: (count) => cloudEvents.setListeners(count),
    runTracked: (run) => trackSync('cloud', run),
  });
  cloudPoller.reschedule();

  // The two quota bars' one real signal: `/usage` read straight from the CLI, on its
  // own clock (see `claudeUsage.ts` for why this never costs a token or a turn).
  const claudeUsagePoller = new ClaudeUsagePoller();
  claudeUsagePoller.start();

  // Same reasoning: the updater's first feed request is scheduled here, once every
  // channel is live, so a network stall can never delay handler registration.
  updater.start();

  return {
    sessions,
    scheduler,
    store,
    broker,
    watcher,
    syncPoller,
    cloudPoller,
    cloudEvents,
    cloudAttachments,
    focusTracker,
    claudeUsagePoller,
    updater,
    windowTracker,
  };
}
