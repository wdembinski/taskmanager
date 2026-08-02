/**
 * The chain of execution's **engine** — what actually happens when a card's work lands.
 *
 * `@shared/taskChain` answers "is this card allowed to start yet"; this decides what to do
 * about the answer. It is owned by the `Scheduler` the way `WorktreeManager` is: the
 * scheduler calls in whenever the world changes in a way that could release a card — a
 * branch merged, a run finished writing, and, through {@link ChainRunner.reconsider}, any
 * other such moment (the app booted, a usage limit lifted, the arrows changed) — and this
 * module owns everything that follows, so `scheduler.ts` gains calls rather than another
 * feature's logic.
 *
 * Three rules run through all of it, and they are worth stating once:
 *
 *  - **A chain never moves a card between columns.** Releasing a card starts an agent on
 *    it; where the card SITS stays the human's, exactly as it is for every other run (see
 *    `@shared/board`'s `restingStatus`). Nothing here writes `status`.
 *  - **`landedAt` is the durable fact, and the release is the perishable one.** A release
 *    that could not happen — a usage limit, an app that closed — is not lost, because the
 *    landing is on disk and {@link ChainRunner.reconsider} can re-ask the question at any
 *    moment: on boot, and at every other point the world changes in a way that could have
 *    satisfied the last thing a card was waiting for.
 *  - **Never two agents on one card.** Every start goes through the scheduler's own
 *    `runTask`, which already refuses an in-flight task; the checks here are so the card
 *    does not collect a timeline note about a run that was never going to start.
 */
import type { Task } from '@shared/model';
import { blockedBy, outgoingLinks, readyToReleaseGiven, type TaskLink } from '@shared/taskChain';

/** Everything the runner needs from the world, so it can be exercised without one. */
export interface ChainRunnerDeps {
  /** Every link on the board — the arrows, re-read on each call rather than cached. */
  links(): TaskLink[];
  getTask(taskId: string): Task | undefined;
  /** Write `landedAt` and push the changed card at the UI. */
  setLandedAt(taskId: string, at: number): void;
  /** File a note on a card's own timeline (`store.addComment`). */
  addComment(projectId: string, taskId: string, body: string): void;
  /** Start a card's agent run. False when the engine refused it. */
  runTask(taskId: string): boolean;
  /** True while a usage limit holds ALL scheduling. */
  limitActive(): boolean;
  /** True when the engine already has a run reserved for this card. */
  inFlight(taskId: string): boolean;
  /** The branch a card's worktree is on — the start point a `stacked` successor cuts from. */
  branchOf(task: Task): string;
  now(): number;
}

/**
 * Why a release happened, which is the only thing that differs between the two paths
 * into {@link ChainRunner.release}.
 *
 * - `landed` — the predecessor's branch is in base. Every gate is satisfied by that, so
 *   every outgoing link is considered.
 * - `written` — the predecessor stopped WORKING and there is a branch to build on. Only
 *   `stacked` links fire; an `after-merge` one is still waiting for the merge, which is
 *   the entire difference between the two gates.
 */
type ReleaseCause = 'landed' | 'written';

/**
 * Why the chain is being **re-asked** — a moment that could have made a waiting card
 * releasable without any card of its own having just finished.
 *
 * Unlike a {@link ReleaseCause} there is no predecessor to point at: nothing landed and
 * nothing was written. What changed is the world around the chain, and this is the only
 * record of which part of it — which is why each trigger carries its own sentence.
 */
export type ChainTrigger = 'boot' | 'limit-lifted' | 'links-changed' | 'card-changed';

/**
 * What a card's timeline says when a re-ask started it.
 *
 * One sentence per trigger, all the same shape, differing only in the CAUSE — because
 * "started automatically" with no subject is the entry that sends a human through three
 * other cards' logs looking for what did it. There is no "ready to start" variant here as
 * there is in {@link ChainRunner.releaseNote}: a re-ask files its note only once the run
 * is actually under way.
 */
const TRIGGER_NOTE: Record<ChainTrigger, string> = {
  boot:
    'Started on startup: everything this card was chained to wait for had already ' +
    'finished while the app was closed.',
  'limit-lifted':
    'Started when the usage limit lifted: everything this card was chained to wait for ' +
    'had already finished while the limit was holding all work.',
  'links-changed':
    'Started when its chain changed: everything this card is now chained to wait for had ' +
    'already finished.',
  'card-changed':
    'Started when this card came back to To Do: everything it was chained to wait for had ' +
    'already finished.',
};

/** The statuses that mean "the human has taken this card off the chain's hands". */
const ABANDONED: ReadonlySet<Task['status']> = new Set(['stopped', 'cancelled']);

/** How a card is named in another card's timeline: its ticket key when it has one. */
function name(task: Task): string {
  return task.externalKey ? `${task.externalKey} — ${task.title}` : task.title;
}

export class ChainRunner {
  /**
   * Links whose successor has already been told about this release, so a predecessor that
   * runs twice does not file the same note twice.
   *
   * The invariant, because it reads as accidental otherwise: **this guards notes about
   * non-events.** {@link ChainRunner.release} can file a note when nothing started, and
   * nothing changes in the world when it does, so a second pass would say the same thing
   * again and needs a key to stop it. {@link ChainRunner.reconsider} files its note **only
   * after `runTask()` returned true** — and that call adds the card to `inFlight`
   * synchronously, so the card cannot pass the loop's guards twice. It must therefore
   * neither read nor write `announced`; writing it would silence a note the card has not
   * had yet.
   *
   * In memory only, and deliberately: the note is a courtesy, and a restart re-announcing
   * one release is a far smaller wrong than a persisted flag that gets out of step with
   * the links it is keyed by. The double-START is prevented by `runTask`, not by this.
   */
  private readonly announced = new Set<string>();

  constructor(private readonly deps: ChainRunnerDeps) {}

  /**
   * A card's work **landed** — its branch is in base (a local integrate, or a linked merge
   * request GitLab now reports as merged).
   *
   * Writes {@link Task.landedAt} if it is not already set, which is what satisfies every
   * `after-merge` gate downstream, and then releases whatever that unblocked. Idempotent:
   * a second landing for the same card is a no-op, so a GitLab poll can say "merged" on
   * every pass without the successor being nudged on every pass.
   */
  landed(taskId: string): void {
    const task = this.deps.getTask(taskId);
    if (!task || task.landedAt != null) return;
    this.deps.setLandedAt(taskId, this.deps.now());
    this.release(taskId, 'landed');
  }

  /**
   * A card's run finished writing its work — before any integration, and possibly before
   * any human has looked at it.
   *
   * This is the `stacked` gate's moment, and starting here rather than after the merge IS
   * the gate: the successor's worktree is cut from this card's branch (see
   * {@link ChainRunner.startPointFor}), so it inherits the work without waiting for review.
   * The cost — that the branch underneath may still be rebased — is said plainly on the
   * successor's timeline, because nobody reading the second card would otherwise know that
   * the first one has to merge first.
   */
  workWritten(taskId: string): void {
    this.release(taskId, 'written');
  }

  /**
   * Start a blocked card anyway, on the human's say-so (the detail pane's **Release now**).
   *
   * Some chains only ever wanted the ordering as a reminder — "look at that one first" —
   * and for those, refusing to start is not a safeguard, it is an obstacle. So this skips
   * the gates entirely and says so on the timeline, naming what was still outstanding.
   *
   * Returns a sentence saying why nothing started, or null once a run is under way.
   */
  releaseNow(taskId: string): string | null {
    const task = this.deps.getTask(taskId);
    if (!task) return 'That card no longer exists.';
    if (this.deps.limitActive()) {
      return 'A usage limit is holding all work right now. This card will start when it lifts.';
    }
    if (this.deps.inFlight(taskId)) return 'That card is already running.';
    if (!task.agentProjectId) {
      return 'That card is not assigned to an agent, so there is nothing to start. Assign it first.';
    }
    const waiting = blockedBy(task, this.deps.links(), this.index());
    if (!this.deps.runTask(taskId)) {
      return 'The engine could not start that card — it may already be running, or held by a usage limit.';
    }
    this.deps.addComment(
      task.projectId,
      task.id,
      waiting.length > 0
        ? `Released by hand, without waiting for ${waiting.map(name).join(', ')}. ` +
            `The chain still records the ordering — this run simply went ahead of it.`
        : 'Started by hand from its chain.',
    );
    return null;
  }

  /**
   * **Ask the chain again**: start every chained card that has become releasable since
   * anybody last asked, whatever it was that made it so.
   *
   * Safe to run at any moment, and safe to run repeatedly, precisely because `landedAt` is
   * persisted and because this starts only cards that have **never** run (no `sessionId`,
   * still `pending`, not in flight) — the one state that can only mean "the release never
   * happened". The question "is this card's predecessor done" has the same answer now as it
   * had a second ago, so re-asking cannot re-release something that already ran.
   *
   * The guards are deliberately the same ones {@link ChainRunner.release} applies to a
   * successor (`to.sessionId || inFlight`). That is not caution, it is agreement: a looser
   * rule here would mean one card is started by a re-ask and refused by a landing depending
   * only on which of the two happened first.
   *
   * Idempotency rests on the reservation rather than on any bookkeeping here.
   * `Scheduler.startTask` adds the card to `inFlight` synchronously, before its first
   * await, and `runTask` refuses a card already in flight — and every start this class makes
   * goes through `deps.runTask`. So a note implies a start, and a start implies the card
   * cannot reach the note a second time. See `announced` for why this path must stay out of
   * it.
   */
  reconsider(trigger: ChainTrigger): void {
    if (this.deps.limitActive()) return;
    const links = this.deps.links();
    if (links.length === 0) return;
    const byId = this.index(links);
    for (const id of new Set(links.map((l) => l.toTaskId))) {
      const task = byId.get(id);
      if (!task || task.sessionId) continue;
      if (!this.startable(task)) continue;
      if (!readyToReleaseGiven(task, links, byId, null)) continue;
      if (!this.deps.runTask(task.id)) continue;
      this.deps.addComment(task.projectId, task.id, TRIGGER_NOTE[trigger]);
    }
  }

  /**
   * The cards whose only outstanding condition is that **this** card's branch merges —
   * named, because the one caller is writing a sentence to a human.
   *
   * The mirror of {@link ChainRunner.release}, asked one moment earlier: a run has finished
   * on a branch nobody has merged, and the note that says so is the last thing anyone reads
   * before deciding whether pressing Merge is urgent. Without this it says only that the
   * branch is unmerged; the fact that three other cards cannot start until it is lives
   * nowhere a human would look.
   *
   * `landedAt` still null is the whole question — once it is set every `after-merge` gate
   * here is satisfied and this card is holding nothing. `stacked` successors are excluded
   * for the same reason: their gate was the work being WRITTEN, which has already happened,
   * so the merge is not what they are waiting for. And a successor that has a `sessionId`
   * or is in flight is not waiting either — those are exactly the guards `release` applies
   * before it starts one, so the two cannot disagree about who is held.
   *
   * Says nothing about the successors' OTHER arrows: a card in a diamond is listed here
   * even when a second predecessor is also outstanding. It is still true that it cannot
   * start until this merges, which is what the sentence claims.
   */
  heldByMerge(taskId: string): string[] {
    const from = this.deps.getTask(taskId);
    if (!from || from.landedAt != null) return [];
    const held: string[] = [];
    for (const link of outgoingLinks(this.deps.links(), taskId)) {
      if (link.gate !== 'after-merge') continue;
      const to = this.deps.getTask(link.toTaskId);
      if (!to || to.sessionId || this.deps.inFlight(to.id)) continue;
      held.push(name(to));
    }
    return held;
  }

  /**
   * The branch a card's worktree should be **cut from**, or undefined for the usual case.
   *
   * Only a `stacked` link answers anything here: its whole promise is that the successor
   * starts with the predecessor's commits already in its tree. The merge TARGET is not
   * affected — `WorktreeManager.prepare` still returns the project's base branch as `base`,
   * so integration goes exactly where it always did.
   *
   * A step never answers: it runs in its parent's worktree on the parent's branch, and the
   * parent is the card the link is about. With two stacked predecessors the first one wins,
   * because a branch has exactly one start point; the note on the card names the one used.
   */
  startPointFor(task: Task): string | undefined {
    if (task.parentTaskId) return undefined;
    const links = this.deps.links();
    for (const link of links) {
      if (link.toTaskId !== task.id || link.gate !== 'stacked') continue;
      const from = this.deps.getTask(link.fromTaskId);
      // A different repo has no branch this card could possibly sit on top of.
      if (!from || from.agentProjectId !== task.agentProjectId) continue;
      return this.deps.branchOf(from);
    }
    return undefined;
  }

  // ---- internals -----------------------------------------------------------

  /**
   * Release whatever `fromTaskId` finishing has unblocked.
   *
   * The predecessor is passed to `readyToReleaseGiven` as satisfied rather than re-read:
   * we have just watched it finish, and the board's copy of it is a few lines behind (see
   * that function). Every other arrow into a successor is judged normally.
   */
  private release(fromTaskId: string, cause: ReleaseCause): void {
    // A usage limit holds a release exactly as it holds `advanceSubtasks`: nothing starts
    // account-wide until it lifts. Nothing is lost — `landedAt` is already written, so the
    // re-ask the scheduler makes when the limit lifts picks up whatever this pass could not.
    if (this.deps.limitActive()) return;
    const from = this.deps.getTask(fromTaskId);
    // A card the human stopped or cancelled releases nothing. Whatever state its branch is
    // in, the person who stopped it did not mean "carry on with the next one".
    if (!from || ABANDONED.has(from.status)) return;
    const links = this.deps.links();
    const outgoing = outgoingLinks(links, fromTaskId).filter(
      (l) => cause === 'landed' || l.gate === 'stacked',
    );
    if (outgoing.length === 0) return;
    const byId = this.index(links);

    for (const link of outgoing) {
      const to = byId.get(link.toTaskId);
      if (!to) continue;
      // Already running, or has run at all: whatever this arrow was holding back, it is not
      // holding it back now. Said here rather than left to `startable` so the card does not
      // collect a note about a release it has visibly moved past.
      if (to.sessionId || this.deps.inFlight(to.id)) continue;
      // Keyed by CAUSE as well as by link, so a `stacked` card that could not start when
      // the work was written is still told — and still started — when it later lands.
      const said = `${link.id}:${cause}`;
      if (this.announced.has(said)) continue;
      if (!readyToReleaseGiven(to, links, byId, fromTaskId)) continue;
      this.announced.add(said);
      const started = this.startable(to) && this.deps.runTask(to.id);
      this.deps.addComment(to.projectId, to.id, this.releaseNote(from, to, link, cause, started));
    }
  }

  /**
   * What the successor's timeline says about being released.
   *
   * It names the card that released it, because "started automatically" with no subject is
   * the kind of entry that makes a human go looking through three other cards' logs. The
   * `stacked` wording carries the warning that comes with the loose gate: this branch is
   * not cut from base, so merging it merges the other card's work too.
   */
  private releaseNote(
    from: Task,
    to: Task,
    link: TaskLink,
    cause: ReleaseCause,
    started: boolean,
  ): string {
    const head = started ? 'Started automatically' : 'Ready to start';
    const because =
      cause === 'landed'
        ? `${name(from)} has landed, and this card was chained to run after it.`
        : `${name(from)} finished writing its work, and this card is stacked on its branch.`;
    const stacked =
      link.gate === 'stacked'
        ? ` This card's branch is cut from "${this.deps.branchOf(from)}", so it already ` +
          `contains that card's commits — merge ${name(from)} first, or merging this one ` +
          `carries its work along with it.`
        : '';
    const tail = started
      ? ''
      : to.agentProjectId
        ? ` Nothing was started: the card is ${to.status}, and the chain never takes a card ` +
          `off a run or a column you put it in. Start it whenever you like.`
        : ' Nothing was started: this card has no agent assigned. Assign one to run it.';
    return `${head}: ${because}${stacked}${tail}`;
  }

  /**
   * Whether a release may start this card by itself.
   *
   * `pending` and nothing else. It is the queue's own "waiting to run" state and the only
   * one that cannot mean the card is busy with something: a card that is running has an
   * agent, one that is `in-progress` has a human or a finished run behind it, and one in
   * Done or Blocked was put there deliberately. For all of those the chain says its piece
   * on the timeline and leaves the card alone — which is the same restraint as the rule
   * that a chain never moves a card between columns.
   */
  private startable(task: Task): boolean {
    return (
      Boolean(task.agentProjectId) && task.status === 'pending' && !this.deps.inFlight(task.id)
    );
  }

  /** The cards at either end of the links, by id — everything a readiness check can ask for. */
  private index(links: readonly TaskLink[] = this.deps.links()): Map<string, Task> {
    const byId = new Map<string, Task>();
    for (const link of links) {
      for (const id of [link.fromTaskId, link.toTaskId]) {
        if (byId.has(id)) continue;
        const task = this.deps.getTask(id);
        if (task) byId.set(id, task);
      }
    }
    return byId;
  }
}
