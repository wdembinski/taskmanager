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
import type { Project, Task, TaskStatus } from '@shared/model';
import type { SchedulerState, TaskChange, SchedulerChange, ActiveRun } from '@shared/scheduler';
import type { SessionEvent, StartSessionRequest } from '@shared/session';
import type { AttentionAnswer, AttentionItem, AttentionKind } from '@shared/attention';
import { detectAttention, NEEDS_INPUT_SENTINEL } from './attention';
import type { PermissionGate } from './claudeSession';
import type { PermissionRequest, PermissionDecisionResult } from './permissionBroker';
import { evaluateToolUse } from './permissionPolicy';
import { tickPlanCheckbox } from './planParser';
import type { SessionManager } from './sessionManager';
import type { Store } from './store';

/** Sent to Claude when a permission is denied with no note of its own. */
const DEFAULT_DENY_MESSAGE =
  'The human declined this action. Do not perform it — find a safer approach, or stop and explain.';

/** Minimal shape the selection logic needs — kept tiny so tests don't build full tasks. */
export interface Schedulable {
  id: string;
  status: TaskStatus;
  order: number;
}

/**
 * Pick the next task to run: the lowest-`order` `pending` task that isn't already
 * in flight. Returns `null` when nothing is runnable. Pure and side-effect free.
 *
 * `inFlight` holds ids of tasks the scheduler has already handed to a session but
 * whose `started` event hasn't landed yet — without it, the same task could be
 * picked twice in the brief window before its status flips to `running`.
 */
export function selectNextPending<T extends Schedulable>(
  tasks: readonly T[],
  inFlight: ReadonlySet<string>,
): T | null {
  let best: T | null = null;
  for (const task of tasks) {
    if (task.status !== 'pending' || inFlight.has(task.id)) continue;
    if (best === null || task.order < best.order) best = task;
  }
  return best;
}

/** The prompt handed to Claude for one task. Pure, so it reads clearly and is stable. */
export function buildTaskPrompt(projectName: string, task: Task): string {
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
}

export class Scheduler {
  /** Live runs keyed by runId. Its size (per project) is the concurrency in use. */
  private readonly runs = new Map<string, Run>();
  /** Task ids handed to a session but not yet settled — excluded from re-selection. */
  private readonly inFlight = new Set<string>();
  /** Projects the user has started and not paused/stopped. */
  private readonly activeProjects = new Set<string>();
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
  /** The permission gate handed to every task run (null until the broker is up). */
  private gate: PermissionGate | null = null;
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
    /** Max tasks a single project runs at once. Default 1 = strictly sequential. */
    private readonly concurrency = 1,
  ) {}

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
    this.setState(projectId, 'idle');
  }

  /** Run a single task ad-hoc, regardless of whether its project's queue is active. */
  runTask(taskId: string): { runId: string } | null {
    if (this.disposed) return null;
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

  /** Snapshot of everything waiting on a human, oldest first (seed the inbox on load). */
  listAttention(): AttentionItem[] {
    return [...this.attention.values()].sort((a, b) => a.createdAt - b.createdAt);
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
    // Release any tools the CLI is still blocked on so their relays don't hang.
    for (const pending of this.pendingDecisions.values()) {
      pending.resolve({ behavior: 'deny', message: 'orchestrator is shutting down' });
    }
    this.pendingDecisions.clear();
    this.activeProjects.clear();
    this.runs.clear();
    this.inFlight.clear();
    this.attention.clear();
  }

  // ---- internals ----------------------------------------------------------

  /** Fill this project's free concurrency slots with its next pending tasks. */
  private pump(projectId: string): void {
    if (this.disposed || !this.activeProjects.has(projectId)) return;
    while (this.runningCount(projectId) < this.concurrency) {
      const next = selectNextPending(this.store.getTasks(projectId), this.inFlight);
      if (!next) break;
      const project = this.store.getProject(projectId);
      if (!project) break;
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

  private startTask(project: Project, task: Task): string {
    const request: StartSessionRequest = {
      prompt: buildTaskPrompt(project.name, task),
      cwd: project.path,
      model: project.defaultModel,
      permissionMode: project.defaultPermissionMode,
    };
    // `runId` is assigned synchronously by start(); the callback only fires on
    // later async events, so it is always defined by the time it is read.
    let runId = '';
    const started = this.sessions.start(request, {
      onEvent: (event) => this.onRunEvent(runId, event),
      // Gate every task run through the broker so risky tools are vetoed
      // pre-execution (ungated only if the broker never came up).
      permission: this.gate ?? undefined,
    });
    runId = started.runId;
    this.runs.set(runId, { taskId: task.id, projectId: project.id, runId, settled: false });
    this.inFlight.add(task.id);
    return runId;
  }

  private onRunEvent(runId: string, event: SessionEvent): void {
    if (this.disposed) return;
    const run = this.runs.get(runId);
    if (!run) return;

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
      if (item.runId === runId) this.resolveAttention(item.id);
    }
  }

  /** Apply a terminal status to a task and, on success, optionally tick the plan. */
  private settle(run: Run, status: 'done' | 'failed'): void {
    this.updateTask(run.taskId, { status }, null);
    if (status === 'done') this.maybeWriteBackPlan(run.taskId);
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
    this.emitScheduler({ projectId, state });
  }
}
