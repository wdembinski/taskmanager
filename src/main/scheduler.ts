/**
 * The scheduler (Phase 3) — turns a project's static task list into a running
 * queue.
 *
 * WHAT IT DOES
 * ------------
 * When a project is "started", the scheduler repeatedly picks that project's next
 * `pending` task (in plan order) and runs it as ONE Claude session via the
 * SessionManager, honoring a concurrency limit (default 1 — strictly one task at
 * a time). It drives each task's status from the session's event stream:
 *
 *   start   → (still pending until the session says hello)
 *   started → running   + persist the session id immediately (so it can resume)
 *   result  → done / failed
 *   exited  → failed if it never produced a result and left non-zero
 *
 * As each task settles, the next pending one starts, until the queue drains (the
 * project goes idle) or the user pauses/stops it.
 *
 * PURE CORE
 * ---------
 * The scheduling *decision* (which task runs next) is the pure `selectNextPending`
 * function, unit-tested without a database or a real process. The class around it
 * only wires that decision to the store, the SessionManager, and the two UI
 * events (`task:changed`, `scheduler:changed`).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { Project, Task, TaskStatus } from '@shared/model';
import type { SchedulerState, TaskChange, SchedulerChange, ActiveRun } from '@shared/scheduler';
import type { SessionEvent, StartSessionRequest } from '@shared/session';
import type { AttentionAnswer, AttentionItem, AttentionKind } from '@shared/attention';
import type { LimitState } from '@shared/limit';
import { detectAttention, NEEDS_INPUT_SENTINEL } from './attention';
import type { PermissionGate } from './claudeSession';
import { LimitGate } from './limitGate';
import type { PermissionRequest, PermissionDecisionResult } from './permissionBroker';
import { evaluateToolUse } from './permissionPolicy';
import { tickPlanCheckbox } from './planParser';
import type { SessionManager } from './sessionManager';
import type { Store } from './store';
import type { WorktreeManager, WorktreePrep } from './worktreeManager';

/** Sent to Claude when a permission is denied with no note of its own. */
const DEFAULT_DENY_MESSAGE =
  'The human declined this action. Do not perform it — find a safer approach, or stop and explain.';

/** The nudge sent to a session we resume after a usage limit clears (Phase 5). */
const RESUME_NUDGE =
  'A usage limit interrupted you and it has now reset. Continue the task where you left off.';

/** Minimal shape the selection logic needs — kept tiny so tests don't build full tasks. */
export interface Schedulable {
  id: string;
  status: TaskStatus;
  order: number;
  /** The task's title, so `@needs:` dependencies (referenced by title) can be resolved. */
  title: string;
  /** Titles this task depends on; it isn't eligible until all of them are `done`. */
  dependsOn: string[];
}

/**
 * Pick the next task to run: the lowest-`order` **eligible** task. A task is
 * eligible when it is `pending`, not already in flight, and every one of its
 * `@needs:` dependencies is satisfied. Returns `null` when nothing is runnable.
 * Pure and side-effect free.
 *
 * A dependency (referenced by title) is *satisfied* only when at least one task
 * bears that title and **every** task with that title is `done` — so duplicate
 * titles must all complete, and an unknown/misspelled title is never satisfied
 * (the task waits; the plan validator surfaces the dangling reference).
 *
 * `inFlight` holds ids of tasks the scheduler has already handed to a session but
 * whose `started` event hasn't landed yet — without it, the same task could be
 * picked twice in the brief window before its status flips to `running`.
 */
export function selectNextPending<T extends Schedulable>(
  tasks: readonly T[],
  inFlight: ReadonlySet<string>,
): T | null {
  // Tally completion per title so a dependency is satisfied only when all tasks
  // sharing that title are done.
  const byTitle = new Map<string, { total: number; done: number }>();
  for (const task of tasks) {
    const entry = byTitle.get(task.title) ?? { total: 0, done: 0 };
    entry.total += 1;
    if (task.status === 'done') entry.done += 1;
    byTitle.set(task.title, entry);
  }
  const satisfied = (title: string): boolean => {
    const entry = byTitle.get(title);
    return entry !== undefined && entry.total > 0 && entry.done === entry.total;
  };

  let best: T | null = null;
  for (const task of tasks) {
    if (task.status !== 'pending' || inFlight.has(task.id)) continue;
    if (!task.dependsOn.every(satisfied)) continue;
    if (best === null || task.order < best.order) best = task;
  }
  return best;
}

/**
 * The prompt handed to Claude for one task. Pure, so it reads clearly and is stable.
 *
 * Two shaping options, mutually exclusive:
 *   - `planRelPath` (shared-dir mode): the agent may evolve the plan file on the fly
 *     (Phase 8) — the orchestrator watches that file and re-syncs new milestones/
 *     tasks into the board live.
 *   - `branch` (worktree mode, team orchestrator): the agent works on an isolated git
 *     branch that the orchestrator integrates back into base; it must NOT touch the
 *     plan file (owned by the main tree) and should commit its work on the branch.
 */
export function buildTaskPrompt(
  projectName: string,
  task: Task,
  options: { planRelPath?: string; branch?: string } = {},
): string {
  const { planRelPath, branch } = options;
  return [
    `You are working through the plan for the project "${projectName}".`,
    '',
    'Complete the following task:',
    '',
    task.title,
    '',
    task.phase ? `(This task is under: ${task.phase}.)` : '',
    '',
    'Make the necessary changes, then briefly summarize what you did.',
    '',
    // Worktree mode: the agent is isolated on its own branch; the orchestrator
    // integrates it back and owns the plan file, so the agent must not edit it.
    ...(branch
      ? [
          `You are on an isolated git branch "${branch}" — your own worktree. Commit your`,
          `work on this branch when you are done (the orchestrator merges it back into the`,
          `base branch automatically). Do NOT edit the plan file; the orchestrator manages it.`,
          '',
        ]
      : []),
    // Shared-dir mode: the agent may refine the plan itself (Phase 8): edits to the
    // plan file are watched and re-synced into the task board live.
    ...(planRelPath && !branch
      ? [
          `If the work reveals new milestones or tasks, you may add them to the plan file`,
          `"${planRelPath}" — "## Milestone" headings and "- [ ] task" checkbox items. The`,
          `orchestrator picks up plan edits live. Only reshape the plan when it genuinely helps.`,
          '',
        ]
      : []),
    // The explicit question contract (replaces guessing from prose). Detected by
    // `detectAttention`; the sentinel string is defined once in attention.ts.
    `If you need a decision or information from the human before you can continue — a`,
    `genuine clarifying question, or a choice that materially changes the outcome — do`,
    `NOT guess. Write a line that starts with "${NEEDS_INPUT_SENTINEL}" followed by your`,
    `question, then stop and wait. If there are specific choices, list each on its own`,
    `line below as a "- " bullet; the human can then pick one in a single click. Their`,
    `answer will be delivered so you can continue.`,
  ]
    .filter((line, i, all) => !(line === '' && all[i - 1] === '')) // collapse double blanks
    .join('\n');
}

/** A one-line, human-readable description of a tool use, for an inbox prompt. */
function describeToolUse(name: string, input: Record<string, unknown>): string {
  const detail =
    (typeof input['command'] === 'string' && input['command']) ||
    (typeof input['file_path'] === 'string' && input['file_path']) ||
    (typeof input['path'] === 'string' && input['path']) ||
    '';
  return detail ? `${name}: ${detail}` : name;
}

/** Bookkeeping for one task the scheduler currently has a session running for. */
interface Run {
  taskId: string;
  projectId: string;
  runId: string;
  /** Set once we've decided the task's outcome, so a trailing `exited` doesn't re-settle it. */
  settled: boolean;
  /** (Worktree mode) the task's branch, set once the worktree is prepared. */
  branch?: string;
  /** (Worktree mode) the base branch this task integrates back into. */
  base?: string;
  /** (Worktree mode) the worktree directory the session ran in. */
  worktree?: string;
}

/** A parked merge conflict awaiting a human, so `answerAttention` can finish integrating. */
interface PendingIntegration {
  projectId: string;
  taskId: string;
  runId: string;
  branch: string;
  base: string;
  worktree: string;
}

export class Scheduler {
  /** Live runs keyed by runId. Its size (per project) is the concurrency in use. */
  private readonly runs = new Map<string, Run>();
  /** Task ids handed to a session but not yet settled — excluded from re-selection. */
  private readonly inFlight = new Set<string>();
  /** Projects the user has started and not paused/stopped. */
  private readonly activeProjects = new Set<string>();
  /**
   * Last announced run state per project, so a freshly (re)mounted Board can seed
   * its buttons from reality instead of defaulting every project to idle. Kept in
   * lockstep with the `scheduler:changed` events emitted by `setState`.
   */
  private readonly states = new Map<string, SchedulerState>();
  /** Open Attention-inbox items keyed by item id (Phase 4). */
  private readonly attention = new Map<string, AttentionItem>();
  /**
   * Blocked permission decisions keyed by their inbox item id. Each holds the
   * broker's `resolve` — calling it releases (or vetoes) the tool the CLI is
   * waiting on — plus the original tool input to echo back on approval.
   */
  private readonly pendingDecisions = new Map<
    string,
    {
      runId: string;
      input: Record<string, unknown>;
      resolve: (result: PermissionDecisionResult) => void;
    }
  >();
  /**
   * Merge conflicts parked for a human (team orchestrator), keyed by their inbox
   * item id. Holds what `answerAttention` needs to finish (or abandon) integrating
   * the task's branch once the human has resolved the conflict in the worktree.
   */
  private readonly pendingIntegrations = new Map<string, PendingIntegration>();
  /** The permission gate handed to every task run (null until the broker is up). */
  private gate: PermissionGate | null = null;
  /**
   * The account-wide usage-limit gate (Phase 5). When active, ALL scheduling is
   * held; when its timer fires, every parked task resumes by its saved session id.
   */
  private readonly limitGate: LimitGate;
  /** Once disposed (app quitting), ignore late session events so we never touch a closed DB. */
  private disposed = false;

  constructor(
    private readonly store: Store,
    private readonly sessions: SessionManager,
    private readonly emitTask: (change: TaskChange) => void,
    private readonly emitScheduler: (change: SchedulerChange) => void,
    /** Push a new inbox item to the UI. */
    private readonly emitAttention: (item: AttentionItem) => void,
    /** Tell the UI an inbox item was answered/cleared. */
    private readonly emitAttentionResolved: (id: string) => void,
    /** Push the usage-limit gate's state (or null when it clears) to the UI. */
    private readonly emitLimit: (state: LimitState | null) => void,
    /**
     * Gives each task its own git worktree/branch and integrates it back into base
     * (team orchestrator). Optional: when omitted (e.g. unit tests) every task runs
     * in the shared project directory, exactly as before this feature.
     */
    private readonly worktrees?: WorktreeManager,
  ) {
    this.limitGate = new LimitGate({
      now: () => Date.now(),
      // Jitter is bounded by the user's setting (Phase 6), read fresh each time.
      jitter: () => Math.floor(Math.random() * Math.max(0, this.store.getSettings().limitJitterMs)),
      setTimer: (ms, cb) => setTimeout(cb, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      onResumeDue: (state) => this.resumeParked(state),
      onChanged: (state) => this.onLimitChanged(state),
    });
  }

  /**
   * Wire the permission gate (once the broker is listening). After this, every
   * task run is spawned with the pre-execution veto in place.
   */
  setPermissionGate(gate: PermissionGate): void {
    this.gate = gate;
  }

  /** Start (or resume) a project's queue. */
  start(projectId: string): void {
    if (this.disposed) return;
    // Resume anything a previous Stop halted: re-queue this project's `stopped`
    // tasks to `pending` so the pump picks them up again. They keep their saved
    // `sessionId`, so `startTask` RESUMES the conversation rather than restarting.
    for (const task of this.store.getTasks(projectId)) {
      if (task.status === 'stopped') this.updateTask(task.id, { status: 'pending' }, null);
    }
    this.activeProjects.add(projectId);
    this.setState(projectId, 'running');
    this.pump(projectId);
  }

  /** Stop starting new tasks, but let any in-flight task run to completion. */
  pause(projectId: string): void {
    if (!this.activeProjects.delete(projectId)) return;
    this.setState(projectId, 'paused');
  }

  /** Stop the queue and terminate this project's running sessions. */
  stop(projectId: string): void {
    this.activeProjects.delete(projectId);
    for (const run of [...this.runs.values()]) {
      if (run.projectId !== projectId) continue;
      run.settled = true; // we're deciding the outcome here, not the exit code
      this.clearRunAttention(run.runId); // drop any parked inbox items for this run
      this.sessions.stop(run.runId); // triggers `exited`, which cleans up bookkeeping
      this.updateTask(run.taskId, { status: 'stopped' }, null);
    }
    // Clear any merge conflicts parked for this project (team orchestrator): their
    // run already ended, so they aren't in `runs` above. Drop the inbox item and
    // mark the task stopped, keeping the branch/worktree for later.
    for (const [itemId, pending] of [...this.pendingIntegrations.entries()]) {
      if (pending.projectId !== projectId) continue;
      this.pendingIntegrations.delete(itemId);
      this.resolveAttention(itemId);
      this.updateTask(pending.taskId, { status: 'stopped' }, null);
    }
    // If a usage limit has parked this project's tasks (Phase 5), stopping cancels
    // them too, so they are NOT resumed when the gate reopens.
    if (this.limitGate.active) {
      const parked = this.store.getTasks(projectId).filter((t) => t.status === 'blocked-by-limit');
      for (const task of parked) this.updateTask(task.id, { status: 'stopped' }, null);
      this.limitGate.unpark(parked.map((t) => t.id));
    }
    this.setState(projectId, 'idle');
  }

  /** Run a single task ad-hoc, regardless of whether its project's queue is active. */
  runTask(taskId: string): { runId: string } | null {
    if (this.disposed) return null;
    // A usage limit holds everything account-wide — don't start ad-hoc work either.
    if (this.limitGate.active) return null;
    const task = this.store.getTask(taskId);
    if (!task) return null;
    const project = this.store.getProject(task.projectId);
    if (!project) return null;
    return { runId: this.startTask(project, task) };
  }

  /** Snapshot of executing tasks, so the Board can attach live transcripts on load. */
  activeRuns(): ActiveRun[] {
    return [...this.runs.values()].map((r) => ({ taskId: r.taskId, runId: r.runId }));
  }

  /** Snapshot of each project's current run state (seed the Board's buttons on mount). */
  schedulerStates(): SchedulerChange[] {
    return [...this.states.entries()].map(([projectId, state]) => ({ projectId, state }));
  }

  /** Snapshot of everything waiting on a human, oldest first (seed the inbox on load). */
  listAttention(): AttentionItem[] {
    return [...this.attention.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** The active usage-limit gate, or null — seeds the countdown banner on load. */
  currentLimit(): LimitState | null {
    return this.limitGate.state;
  }

  /**
   * Re-arm a usage-limit gate that was in force when the app last closed (Phase 5).
   * Called once at startup after the permission broker is up (so resumed runs are
   * still gated). If the reset already passed while the app was down, parked tasks
   * resume right away.
   */
  restoreLimitGate(): void {
    if (this.disposed) return;
    const saved = this.store.loadLimitGate();
    if (saved) this.limitGate.restore(saved);
  }

  /**
   * On startup (Phase 6), heal tasks the DB left mid-flight: a `running` or
   * `waiting-input` task's process died when the app closed, so there is nothing
   * to re-attach to. Re-queue each to `pending` — its saved `sessionId` is kept,
   * so when it runs again `startTask` RESUMES the conversation rather than losing
   * context. `blocked-by-limit` tasks are left for the limit gate to resume.
   */
  reconcileInterruptedTasks(): void {
    if (this.disposed) return;
    for (const project of this.store.listProjects()) {
      for (const task of this.store.getTasks(project.id)) {
        if (task.status === 'running' || task.status === 'waiting-input') {
          this.updateTask(task.id, { status: 'pending' }, null);
        }
      }
    }
  }

  /**
   * Decide one tool use the broker forwarded (a tool the CLI is BLOCKED on).
   * Safe → allow immediately; risky → raise an inbox item and return a promise
   * that stays unresolved until a human answers, holding the tool the whole time.
   * Called by the PermissionBroker; the pre-execution veto lives here.
   */
  decidePermission(request: PermissionRequest): Promise<PermissionDecisionResult> {
    if (this.disposed) {
      return Promise.resolve({ behavior: 'deny', message: 'orchestrator is shutting down' });
    }
    const run = this.runs.get(request.runId);
    if (!run) {
      // Can't correlate the tool to a task — fail safe rather than allow blindly.
      return Promise.resolve({ behavior: 'deny', message: 'unknown session' });
    }

    // Full auto (bypassPermissions): the human opted out of the risk policy for
    // this project — auto-approve every tool so nothing lands in the Attention
    // inbox. Genuine questions Claude asks (detectAttention) still surface.
    const project = this.store.getProject(run.projectId);
    if (project?.defaultPermissionMode === 'bypassPermissions') {
      return Promise.resolve({ behavior: 'allow', updatedInput: request.input });
    }

    const decision = evaluateToolUse(request.toolName, request.input);
    if (decision.action === 'allow') {
      return Promise.resolve({ behavior: 'allow', updatedInput: request.input });
    }

    // Risky: park the task and hold the tool until the human answers.
    const item = this.raiseAttention(run, {
      kind: 'permission',
      prompt: describeToolUse(request.toolName, request.input),
      toolName: request.toolName,
      reason: decision.reason,
    });
    return new Promise<PermissionDecisionResult>((resolve) => {
      this.pendingDecisions.set(item.id, { runId: request.runId, input: request.input, resolve });
    });
  }

  /**
   * Answer one inbox item. A `permission` item releases or vetoes the blocked
   * tool via its held broker promise; a `question` item pushes the reply into the
   * live session. Either way the item clears and the task returns to `running`.
   * No-op if the item is unknown (already answered, or its run ended).
   */
  answerAttention(itemId: string, answer: AttentionAnswer): void {
    if (this.disposed) return;
    const item = this.attention.get(itemId);
    if (!item) return;

    if (item.kind === 'merge-conflict') {
      const pending = this.pendingIntegrations.get(itemId);
      if (!pending) return; // already handled
      this.pendingIntegrations.delete(itemId);
      this.resolveAttention(itemId);
      if (answer.decision === 'deny') {
        // Abandon: fail the task but keep the branch/worktree so work isn't lost.
        this.noteRun(
          pending.projectId,
          pending.taskId,
          pending.runId,
          `Integration abandoned by the human; branch "${pending.branch}" and its worktree were kept.`,
        );
        this.updateTask(pending.taskId, { status: 'failed' }, null);
      } else {
        // Resolved: continue the rebase and fast-forward base.
        void this.finishConflict(pending);
      }
      return;
    }

    if (item.kind === 'permission') {
      const pending = this.pendingDecisions.get(itemId);
      if (!pending) return; // its run already ended — nothing to release
      this.pendingDecisions.delete(itemId);
      const note = 'note' in answer ? answer.note?.trim() : undefined;
      if (answer.decision === 'approve') {
        pending.resolve({ behavior: 'allow', updatedInput: pending.input });
        // A note on approve is extra guidance queued for Claude's next turn.
        if (note) this.sessions.send(item.runId, note);
      } else {
        pending.resolve({ behavior: 'deny', message: note || DEFAULT_DENY_MESSAGE });
      }
    } else {
      // A question: deliver the human's reply into the open input stream.
      const text =
        answer.decision === 'reply' ? answer.text : ('note' in answer && answer.note) || '';
      this.sessions.send(item.runId, text);
    }

    this.resolveAttention(itemId);
    // If nothing else is parked on this run, it is live again.
    if (!this.hasPendingAttention(item.runId)) {
      this.updateTask(item.taskId, { status: 'running' }, item.runId);
    }
  }

  /** Stop scheduling and ignore further events. Called on app quit BEFORE the DB closes. */
  dispose(): void {
    this.disposed = true;
    // Tear down the limit timer WITHOUT resuming, and leave its persisted state
    // intact so the gate is restored (and the resume still happens) on next launch.
    this.limitGate.dispose();
    // Release any tools the CLI is still blocked on so their relays don't hang.
    for (const pending of this.pendingDecisions.values()) {
      pending.resolve({ behavior: 'deny', message: 'orchestrator is shutting down' });
    }
    this.pendingDecisions.clear();
    this.pendingIntegrations.clear();
    this.activeProjects.clear();
    this.runs.clear();
    this.inFlight.clear();
    this.attention.clear();
  }

  // ---- internals ----------------------------------------------------------

  /** Fill this project's free concurrency slots with its next pending tasks. */
  private pump(projectId: string): void {
    if (this.disposed || !this.activeProjects.has(projectId)) return;
    // A usage limit is account-wide: hold ALL scheduling until it resets (Phase 5).
    if (this.limitGate.active) return;
    const project = this.store.getProject(projectId);
    if (!project) return;
    // Concurrency is a live, PER-PROJECT setting: read it fresh so edits take effect.
    const concurrency = Math.max(1, project.concurrency);
    while (this.runningCount(projectId) < concurrency) {
      const next = selectNextPending(this.store.getTasks(projectId), this.inFlight);
      if (!next) break;
      this.startTask(project, next);
    }
    // If the queue has fully drained (nothing running, nothing left to start), the
    // project is done for now — go idle so the UI stops showing it as running.
    if (
      this.activeProjects.has(projectId) &&
      this.runningCount(projectId) === 0 &&
      selectNextPending(this.store.getTasks(projectId), this.inFlight) === null
    ) {
      this.activeProjects.delete(projectId);
      this.setState(projectId, 'idle');
    }
  }

  /**
   * Start a session for one task. If the task already has a `sessionId` — because
   * a usage limit parked it (Phase 5) or it was interrupted by an app restart
   * (Phase 6) — the CLI RESUMES that exact conversation with a continue-nudge, so
   * no context is lost. A never-run task starts fresh from its full task prompt.
   *
   * The run slot is **reserved synchronously** (its runId is generated and added to
   * `runs`/`inFlight` before returning) so `pump` counts it immediately and never
   * over-fills the project's concurrency. In worktree mode the actual session start
   * is deferred until the git worktree is prepared; the shared-dir path (and unit
   * tests without a WorktreeManager) starts the session synchronously as before.
   */
  private startTask(project: Project, task: Task): string {
    const runId = randomUUID();
    const run: Run = { taskId: task.id, projectId: project.id, runId, settled: false };
    this.runs.set(runId, run);
    this.inFlight.add(task.id);
    if (this.worktrees) {
      // Async: prepare (or reuse) the task's worktree, then start the session in it.
      void this.prepareAndLaunch(project, task, run);
    } else {
      // No worktree manager (unit tests / degenerate setups): run in the shared dir.
      this.launch(project, task, run, { mode: 'shared', cwd: project.path });
    }
    return runId;
  }

  /**
   * Ask the worktree manager where this task should run, then start its session
   * there — unless the run was stopped or usage-limited during preparation, in which
   * case the reservation is released without ever spawning a process.
   */
  private async prepareAndLaunch(project: Project, task: Task, run: Run): Promise<void> {
    let prep: WorktreePrep;
    try {
      prep = await this.worktrees!.prepare(project, task);
    } catch {
      // Preparation blew up (odd git state) — fall back to the shared dir so the task
      // still runs rather than being lost.
      prep = { mode: 'shared', cwd: project.path };
    }
    if (this.disposed) return;
    // Stopped / parked by a usage limit while we were preparing: don't start it, and
    // free the reserved slot so the queue isn't stuck (the imminent `exited` that
    // normally cleans up never fires — the session never started).
    if (run.settled || !this.runs.has(run.runId)) {
      this.runs.delete(run.runId);
      this.inFlight.delete(run.taskId);
      this.pump(run.projectId);
      return;
    }
    this.launch(project, task, run, prep);
  }

  /** Spawn the session for a reserved run in the prepared working directory. */
  private launch(project: Project, task: Task, run: Run, prep: WorktreePrep): void {
    const resumeSessionId = task.sessionId ?? undefined;
    if (prep.mode === 'worktree') {
      run.branch = prep.branch;
      run.base = prep.base;
      run.worktree = prep.cwd;
    }
    // The plan file's path relative to the project dir, so a shared-dir agent can
    // edit it. Worktree agents get the isolated (no-plan-edit) prompt instead.
    const planRel = relative(project.path, project.planPath) || project.planPath;
    const prompt = resumeSessionId
      ? RESUME_NUDGE
      : buildTaskPrompt(
          project.name,
          task,
          prep.mode === 'worktree' ? { branch: prep.branch } : { planRelPath: planRel },
        );
    const request: StartSessionRequest = {
      prompt,
      cwd: prep.cwd,
      model: project.defaultModel,
      permissionMode: project.defaultPermissionMode,
    };
    this.sessions.start(request, {
      runId: run.runId, // use the reserved id so events and bookkeeping line up
      onEvent: (event) => this.onRunEvent(run.runId, event),
      // Gate every task run through the broker so risky tools are vetoed
      // pre-execution (ungated only if the broker never came up).
      permission: this.gate ?? undefined,
      resumeSessionId,
    });
  }

  private onRunEvent(runId: string, event: SessionEvent): void {
    if (this.disposed) return;
    const run = this.runs.get(runId);
    if (!run) return;

    // Phase 6: persist every event to the task's history so its transcript is
    // viewable after the run ends or the app restarts.
    this.store.appendTaskEvent(run.projectId, run.taskId, runId, event);

    // Phase 4: did Claude ask the human a question (via the sentinel)? If so,
    // park the task in the Attention inbox until someone answers. (Permissions
    // are handled separately, pre-execution, in decidePermission.)
    const question = detectAttention(event);
    if (question) {
      this.raiseAttention(run, {
        kind: 'question',
        prompt: question.prompt,
        options: question.options,
        toolName: null,
        reason: null,
      });
    }

    switch (event.kind) {
      case 'started':
        // Persist the session id the instant it arrives, per docs/03, so the task
        // can be resumed after a limit reset or an app restart.
        this.updateTask(run.taskId, { status: 'running', sessionId: event.sessionId }, runId);
        break;

      case 'rate-limit':
        // A usage limit hit (Phase 5). `allowed` just means "still under the cap" —
        // only a non-allowed status engages the account-wide gate.
        if (event.status !== 'allowed') this.engageLimit(event);
        break;

      case 'result':
        // The turn ended. If the task is parked awaiting a human, stay alive and
        // keep the input stream open for their answer — do NOT settle or stop.
        if (this.hasPendingAttention(runId)) break;
        run.settled = true;
        this.settle(run, event.success ? 'done' : 'failed');
        // stdin is held open in Phase 4, so the process won't exit by itself —
        // end it explicitly now that the task is done.
        this.sessions.stop(runId);
        break;

      case 'exited':
        // A run that exited without ever producing a result ended abnormally.
        if (!run.settled) {
          run.settled = true;
          this.settle(run, event.code === 0 ? 'done' : 'failed');
        }
        this.clearRunAttention(runId); // a dead run can't be answered — drop its items
        this.runs.delete(runId);
        this.inFlight.delete(run.taskId);
        this.pump(run.projectId); // a slot freed up — advance the queue
        break;

      default:
        break;
    }
  }

  /**
   * A usage limit hit — engage the account-wide gate (Phase 5). Every currently
   * running task is parked (`blocked-by-limit`) and its process ended; the saved
   * session id lets us resume it when the gate's timer fires at reset time.
   */
  private engageLimit(event: Extract<SessionEvent, { kind: 'rate-limit' }>): void {
    // Account-wide: park EVERY in-flight run, not only the one that hit the wall.
    const active = [...this.runs.values()];
    this.limitGate.engage(
      { status: event.status, rateLimitType: event.rateLimitType, resetsAt: event.resetsAt },
      active.map((r) => r.taskId),
    );
    for (const run of active) {
      run.settled = true; // its imminent exit is expected — don't settle it as failed
      this.clearRunAttention(run.runId); // a parked run can't be answered mid-limit
      this.updateTask(run.taskId, { status: 'blocked-by-limit' }, null);
      // End the process now; we'll spawn a fresh `--resume` for it at reset time.
      this.sessions.stop(run.runId);
    }
  }

  /**
   * The gate's timer fired: the limit has reset. Resume each parked task by its
   * saved session id, skipping any the user has since stopped or removed.
   */
  private resumeParked(state: LimitState): void {
    if (this.disposed) return;
    for (const taskId of state.parkedTaskIds) {
      const task = this.store.getTask(taskId);
      // Only resume tasks still parked by the limit (not since stopped/deleted),
      // and only if we captured a session id to resume from.
      if (!task || task.status !== 'blocked-by-limit' || !task.sessionId) continue;
      const project = this.store.getProject(task.projectId);
      if (!project) continue;
      this.startTask(project, task); // resumes by task.sessionId
    }
    // Slots may have freed without a parked task — nudge every active queue.
    for (const projectId of this.activeProjects) this.pump(projectId);
  }

  /** Persist the gate (so a limit survives a restart) and mirror it to the UI. */
  private onLimitChanged(state: LimitState | null): void {
    this.store.saveLimitGate(state);
    this.emitLimit(state);
  }

  /** Raise one Attention-inbox item for a run, park its task, and return the item. */
  private raiseAttention(
    run: Run,
    detail: {
      kind: AttentionKind;
      prompt: string;
      options?: string[];
      toolName: string | null;
      reason: string | null;
    },
  ): AttentionItem {
    const task = this.store.getTask(run.taskId);
    const item: AttentionItem = {
      id: randomUUID(),
      runId: run.runId,
      taskId: run.taskId,
      projectId: run.projectId,
      taskTitle: task?.title ?? '(unknown task)',
      kind: detail.kind,
      prompt: detail.prompt,
      options: detail.options ?? [],
      toolName: detail.toolName,
      reason: detail.reason,
      createdAt: Date.now(),
    };
    this.attention.set(item.id, item);
    this.updateTask(run.taskId, { status: 'waiting-input' }, run.runId);
    this.emitAttention(item);
    return item;
  }

  /** True if any inbox item is still open for this run. */
  private hasPendingAttention(runId: string): boolean {
    for (const item of this.attention.values()) if (item.runId === runId) return true;
    return false;
  }

  /** Remove one item and notify the UI. */
  private resolveAttention(itemId: string): void {
    if (this.attention.delete(itemId)) this.emitAttentionResolved(itemId);
  }

  /**
   * Drop (and notify) every open item for a run — used when the run ends. Any
   * permission decision still held open is released as a DENY so the broker's HTTP
   * call returns instead of hanging (the process is dying anyway).
   */
  private clearRunAttention(runId: string): void {
    for (const [itemId, pending] of [...this.pendingDecisions.entries()]) {
      if (pending.runId !== runId) continue;
      pending.resolve({ behavior: 'deny', message: 'session ended before approval' });
      this.pendingDecisions.delete(itemId);
    }
    for (const item of [...this.attention.values()]) {
      if (item.runId === runId) {
        this.pendingIntegrations.delete(item.id); // drop any parked conflict for this run
        this.resolveAttention(item.id);
      }
    }
  }

  /**
   * Apply a terminal status to a task and, on success, optionally tick the plan.
   *
   * A worktree run that finished successfully is NOT marked done here — its branch
   * must first integrate back into base (rebase → ff-merge). We kick that off async
   * and let its outcome set the final status (done / parked on conflict / failed).
   * A failed worktree run keeps its worktree and branch for inspection.
   */
  private settle(run: Run, status: 'done' | 'failed'): void {
    if (status === 'done' && run.branch && run.base && run.worktree && this.worktrees) {
      // Capture the integration inputs now — the imminent `exited` event deletes this
      // run from `runs`, and integration is async.
      const project = this.store.getProject(run.projectId);
      if (project) {
        void this.integrateWorktree(project, {
          taskId: run.taskId,
          runId: run.runId,
          branch: run.branch,
          base: run.base,
          worktree: run.worktree,
        });
        return;
      }
    }
    this.updateTask(run.taskId, { status }, null);
    if (status === 'done') this.maybeWriteBackPlan(run.taskId);
  }

  /**
   * Integrate a finished worktree task's branch back into base, then apply the
   * outcome: merged → done (+ plan write-back); conflict → park for a human;
   * dirty-base / error → failed (keeping the worktree so nothing is lost).
   */
  private async integrateWorktree(
    project: Project,
    ctx: { taskId: string; runId: string; branch: string; base: string; worktree: string },
  ): Promise<void> {
    const task = this.store.getTask(ctx.taskId);
    const message = `orchestrator: ${task?.title ?? ctx.taskId}`;
    const result = await this.worktrees!.integrate(
      project,
      ctx.branch,
      ctx.base,
      ctx.worktree,
      message,
    );
    if (this.disposed) return;
    switch (result.status) {
      case 'merged':
        this.noteRun(
          project.id,
          ctx.taskId,
          ctx.runId,
          `Merged branch "${ctx.branch}" into ${ctx.base}.`,
        );
        this.updateTask(ctx.taskId, { status: 'done' }, null);
        this.maybeWriteBackPlan(ctx.taskId);
        break;
      case 'conflict':
        this.raiseMergeConflict(project, ctx);
        break;
      case 'dirty-base':
        this.failIntegration(
          project.id,
          ctx,
          `Base branch "${result.base}" has uncommitted changes, so branch "${ctx.branch}" ` +
            `was not merged. Commit or stash your work in ${project.path}, then re-run this task.`,
        );
        break;
      case 'error':
        this.failIntegration(
          project.id,
          ctx,
          `Could not integrate branch "${ctx.branch}": ${result.message} (the worktree at ` +
            `${ctx.worktree} was kept for inspection).`,
        );
        break;
    }
  }

  /** Park a task whose branch hit a merge conflict, so a human can resolve it. */
  private raiseMergeConflict(
    project: Project,
    ctx: { taskId: string; runId: string; branch: string; base: string; worktree: string },
  ): void {
    const task = this.store.getTask(ctx.taskId);
    const item: AttentionItem = {
      id: randomUUID(),
      runId: ctx.runId,
      taskId: ctx.taskId,
      projectId: project.id,
      taskTitle: task?.title ?? '(unknown task)',
      kind: 'merge-conflict',
      prompt:
        `Integrating branch "${ctx.branch}" into ${ctx.base} hit a merge conflict. Resolve the ` +
        `conflicts in the worktree below (edit the files, then \`git add\` them), then choose ` +
        `Resolved to finish the merge — or Abandon to leave the branch for later.`,
      options: [],
      toolName: null,
      reason: null,
      worktreePath: ctx.worktree,
      branch: ctx.branch,
      createdAt: Date.now(),
    };
    this.attention.set(item.id, item);
    this.pendingIntegrations.set(item.id, {
      projectId: project.id,
      taskId: ctx.taskId,
      runId: ctx.runId,
      branch: ctx.branch,
      base: ctx.base,
      worktree: ctx.worktree,
    });
    this.updateTask(ctx.taskId, { status: 'waiting-input' }, ctx.runId);
    this.emitAttention(item);
  }

  /** Mark an integration attempt failed, surfacing the reason in the task transcript. */
  private failIntegration(
    projectId: string,
    ctx: { taskId: string; runId: string },
    reason: string,
  ): void {
    this.noteRun(projectId, ctx.taskId, ctx.runId, reason);
    this.updateTask(ctx.taskId, { status: 'failed' }, null);
  }

  /** Append a synthetic assistant note to a task's transcript (integration outcomes). */
  private noteRun(projectId: string, taskId: string, runId: string, text: string): void {
    this.store.appendTaskEvent(projectId, taskId, runId, { kind: 'assistant', text });
  }

  /**
   * Finish integrating after a human resolved a rebase conflict in the worktree:
   * continue the rebase + fast-forward. Still conflicted → re-park; otherwise apply
   * the same outcomes as the initial attempt.
   */
  private async finishConflict(pending: PendingIntegration): Promise<void> {
    const project = this.store.getProject(pending.projectId);
    if (!project) return;
    const ctx = {
      taskId: pending.taskId,
      runId: pending.runId,
      branch: pending.branch,
      base: pending.base,
      worktree: pending.worktree,
    };
    const result = await this.worktrees!.finishAfterConflict(
      project,
      pending.branch,
      pending.base,
      pending.worktree,
    );
    if (this.disposed) return;
    switch (result.status) {
      case 'merged':
        this.noteRun(
          project.id,
          ctx.taskId,
          ctx.runId,
          `Merged branch "${ctx.branch}" into ${ctx.base}.`,
        );
        this.updateTask(ctx.taskId, { status: 'done' }, null);
        this.maybeWriteBackPlan(ctx.taskId);
        break;
      case 'conflict':
        // Still unresolved — park again so the human can keep working on it.
        this.raiseMergeConflict(project, ctx);
        break;
      case 'dirty-base':
        this.failIntegration(
          project.id,
          ctx,
          `Base branch "${result.base}" has uncommitted changes, so branch "${ctx.branch}" ` +
            `was not merged. Commit or stash your work in ${project.path}, then re-run this task.`,
        );
        break;
      case 'error':
        this.failIntegration(
          project.id,
          ctx,
          `Could not integrate branch "${ctx.branch}": ${result.message} (the worktree at ` +
            `${ctx.worktree} was kept for inspection).`,
        );
        break;
    }
  }

  private maybeWriteBackPlan(taskId: string): void {
    const task = this.store.getTask(taskId);
    if (!task) return;
    const project = this.store.getProject(task.projectId);
    if (!project || !project.writeBackPlan) return;

    try {
      const markdown = readFileSync(project.planPath, 'utf8');
      const updated = tickPlanCheckbox(markdown, task.phase, task.title);
      if (updated !== null) writeFileSync(project.planPath, updated);
    } catch {
      // A missing/unwritable plan file is non-fatal — the task still counts as done.
    }
  }

  private updateTask(
    taskId: string,
    patch: Partial<Pick<Task, 'status' | 'sessionId'>>,
    runId: string | null,
  ): void {
    const task = this.store.updateTask(taskId, patch);
    if (task) this.emitTask({ task, runId });
  }

  private runningCount(projectId: string): number {
    let n = 0;
    for (const run of this.runs.values()) if (run.projectId === projectId) n++;
    return n;
  }

  private setState(projectId: string, state: SchedulerState): void {
    this.states.set(projectId, state);
    this.emitScheduler({ projectId, state });
  }
}
