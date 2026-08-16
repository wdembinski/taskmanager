/**
 * Shared scheduler vocabulary (Phase 3).
 *
 * The scheduler turns a project's static task list into a running queue: it picks
 * the next `pending` task, runs it as one Claude session, and moves it through
 * `running` → `done`/`failed`. These types describe the two things the engine
 * pushes to the UI so the Board can update live without polling:
 *
 *   - `task:changed`      — a single task's status/sessionId changed (and, while a
 *                           task is executing, the live `runId` to attach a
 *                           transcript to).
 *   - `scheduler:changed` — a project's queue moved between running/paused/idle,
 *                           so the Run/Pause/Stop buttons reflect reality.
 *
 * They live in `shared` because both the engine and the UI depend on them.
 */
import type { Task } from './model';

/**
 * Whether a project's queue is actively working (`running`), temporarily halted
 * but keeping any in-flight task alive (`paused`), or not scheduling at all
 * (`idle` — nothing running and nothing queued, or fully stopped).
 */
export type SchedulerState = 'idle' | 'running' | 'paused';

/** Pushed when a project's scheduler state changes, so the Board updates buttons. */
export interface SchedulerChange {
  projectId: string;
  state: SchedulerState;
}

/**
 * Pushed whenever a task's persisted state changes. `runId` is the live run id
 * while the task is executing (so the UI can wire the Phase 1 transcript to it),
 * and `null` once the task has settled or is not currently running.
 */
export interface TaskChange {
  task: Task;
  runId: string | null;
}

/** Maps a currently-running task id to its live run id (seed for the Board on load). */
export interface ActiveRun {
  taskId: string;
  runId: string;
}

/**
 * Why pressing **Start** could not start anything.
 *
 * `Scheduler.runTask` used to answer every one of these with the same `null`, and
 * `task:run` turned that `null` into one sentence naming two causes — *"it is already
 * running, or a usage limit is holding all work"*. Both halves were wrong for the case
 * that actually reaches a human most often: an expired sign-in raises the **auth** gate
 * (`@shared/auth`), not the usage-limit one, so the app told people to wait out a limit
 * that did not exist while the fix — sign in again — went unmentioned. A card with no
 * repository behind it got the same sentence, and so did a card that had been deleted.
 *
 * So the refusal is now a value, in the spirit of `ChatRefusal`: the engine says which
 * wall it hit and one place turns that into words. Getting this wrong is expensive in a
 * specific way — the human's next action is chosen entirely from this sentence.
 */
export type RunRefusal =
  /** The card is gone (deleted or archived since the pane was drawn). */
  | 'unknown-task'
  /** A run is already reserved or live for it — a second would put two agents in one worktree. */
  | 'already-running'
  /** Nothing resolves a directory to run in: the card is not delegated to an agent project. */
  | 'no-project'
  /** A usage limit holds all work account-wide. The card is parked and resumes at the reset. */
  | 'limit'
  /** The `claude` CLI cannot authenticate. The card is parked and resumes when a human signs in. */
  | 'signed-out'
  /** The engine is shutting down; nothing new starts. */
  | 'shutting-down';

/**
 * The refusals that HOLD the work rather than dropping it.
 *
 * The other four end the attempt: the card is gone, already busy, has nowhere to run, or
 * the app is closing — press Start again when you have fixed it, or never. These two do
 * not. A Start stopped by a gate is parked *in* that gate (`parkForLimit` /
 * `parkForSignIn`), and the gate's resume is what eventually runs it, so "refused" here
 * means *accepted and queued behind an account-wide wall* — the opposite of a rejection.
 *
 * Worth a name of its own because that difference is invisible at the call site: both
 * arrive as `{ refused }` on a {@link RunOutcome}, and treating a park like a rejection is
 * how a caller ends up asking a human to press a button the engine will press for them.
 */
export type ParkedRefusal = Extract<RunRefusal, 'limit' | 'signed-out'>;

/** Whether this refusal parked the work (it starts by itself) or dropped it. */
export function isParkedRefusal(refusal: RunRefusal): refusal is ParkedRefusal {
  return refusal === 'limit' || refusal === 'signed-out';
}

/**
 * Whether the card's own `status` records the park — the two gates differ here, and the
 * difference decides who is allowed to *return* a park instead of throwing one.
 *
 * `parkForLimit` writes `blocked-by-limit` onto the task, so a limit park is a fact the
 * card carries: anything that reads the task back sees the hold, and a handler may report
 * it by returning an ordinary outcome. `parkForSignIn` deliberately writes no status —
 * an auth-parked task stays plain `pending`, which is already the engine's word for "this
 * will run again" and is what `resumeAfterSignIn` matches on. So a sign-out park leaves
 * nothing on the card to see; the only trace is the gate's own set and a note on the
 * timeline, and a caller that quietly returned it would look, to every later reader, exactly
 * like a card nobody ever started.
 *
 * Hence: `true` may be returned, `false` must still be raised loudly enough for the human
 * to be told to sign in.
 */
export const CARD_RECORDS_PARK: Record<ParkedRefusal, boolean> = {
  limit: true,
  'signed-out': false,
};

/**
 * What an ad-hoc start did: a live run, or the reason no run started now.
 *
 * `{ refused }` is not uniformly a rejection. Four of the six say the work did not happen
 * and will not until something changes; the two {@link isParkedRefusal} names say it is
 * held and starts by itself. A caller that reads every `refused` as failure will report a
 * parked card as a dead end.
 */
export type RunOutcome = { runId: string } | { refused: RunRefusal };

/**
 * One sentence per refusal — what is wrong, and what happens next.
 *
 * Not all six are bad news, and the wording follows {@link isParkedRefusal} rather than the
 * shape of the value: the four dropped refusals name the fix and the button to press again,
 * while the two parked ones are a receipt — the card is already waiting, and the sentence
 * says so and explicitly tells the human there is nothing else to press.
 *
 * Both gate messages promise a self-start because the engine makes that promise good: a
 * Start refused by a gate parks the card *in* that gate, which is the only thing that
 * remembers work across the pause. Saying "press Start again later" instead would be
 * asking someone to remember, per card, what the app already knows.
 */
export const RUN_REFUSAL_MESSAGE: Record<RunRefusal, string> = {
  'unknown-task': 'This card no longer exists — it may have been deleted or archived.',
  'already-running':
    'An agent is already working on this card. Stop it first if you want to start again.',
  'no-project':
    'This card has no repository to run in — assign it to an agent project before starting it.',
  limit:
    'A usage limit is holding all agent work. This card is now waiting behind it and starts ' +
    'by itself when the limit resets — there is nothing else to press.',
  'signed-out':
    'Claude is signed out, so nothing can run. Sign in from the banner at the top of the ' +
    'window; this card is waiting behind it and starts by itself once you do.',
  'shutting-down': 'The app is shutting down, so nothing new can be started.',
};
