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
 * Five rules run through all of it, and they are worth stating once:
 *
 *  - **The only column a chain writes is the one it starts a card into.** Where a card SITS
 *    is the human's, exactly as it is for every other run (see `@shared/board`'s
 *    `restingStatus`) — with one exception, and it is the exception that makes the rule
 *    honest: when the APP starts a card by itself it also moves it to IN PROGRESS, because
 *    nobody was here to move it and a card being worked on that still reads TO DO is a lie.
 *    Everything else moves nothing — a decline, a settle, and the human's own **Release
 *    now**, where the person pressing the button already chose the column.
 *  - **`landedAt` is the durable fact, and the release is the perishable one.** A release
 *    that could not happen — a usage limit, an app that closed — is not lost, because the
 *    landing is on disk and {@link ChainRunner.reconsider} can re-ask the question at any
 *    moment: on boot, and at every other point the world changes in a way that could have
 *    satisfied the last thing a card was waiting for.
 *  - **Never two agents on one card.** Every start goes through the scheduler's own
 *    `runTask`, which already refuses an in-flight task; the checks here are so the card
 *    does not collect a timeline note about a run that was never going to start.
 *  - **A session is not work.** A card that has been planned, or merely chatted with, has a
 *    `sessionId` and has done none of what it was chained to do — so nothing here reads
 *    that field to decide a release is moot. The question every path asks instead is
 *    {@link ChainRunner.declineReason}: is a run in flight, has this card's OWN work landed,
 *    is it resting in IN REVIEW or DONE. Anything else is a card still waiting to be run.
 *  - **A release never declines in silence.** Every arrow that could have started a card
 *    and did not says so on that card's timeline, naming the reason — once per arrow, cause
 *    and reason, so a merge request GitLab keeps reporting cannot turn one decline into a
 *    hundred. The one deliberate exception is a card still waiting on another arrow, where
 *    "not yet" is the chain working as drawn and the card's own chip already says whom it
 *    waits for.
 */
import { restingStatus } from '@shared/board';
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
  /**
   * Move a card to IN PROGRESS, as the HUMAN would (`humanStatusPatch`) — the one column
   * write the chain makes, and only for a start nobody was present for.
   *
   * Called immediately after a successful `runTask`, which matters: `runTask` is
   * synchronous only up to the spawn, so the run has not borrowed `status` yet and this
   * writes a plain `in-progress`. The `started` event that follows then parks exactly that
   * as `preRunStatus`, and the card comes back to IN PROGRESS when the run settles — which
   * is the state we were after.
   */
  markInProgress(taskId: string): void;
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

/**
 * The half-sentence every automatic start adds to its note.
 *
 * The move is the one thing the chain does to a card that a human did not ask for, so the
 * card's own timeline is the only place it can be accounted for. Shared by both notes —
 * a release's and a re-ask's — because it is the same act either way.
 */
const MOVED_NOTE =
  ' The card was moved to In Progress: nobody was here to move it, and its work is under way.';

/** The statuses that mean "the human has taken this card off the chain's hands". */
const ABANDONED: ReadonlySet<Task['status']> = new Set(['stopped', 'cancelled']);

/**
 * The statuses that mean a card's own work is **finished with** — exactly the ones that
 * file it under IN REVIEW or DONE (see `columnForStatus`), however it got there.
 *
 * Read through `restingStatus`, never through `status`: while a run holds the field the
 * answer to "is this card's work finished with" is about the column the human left it in,
 * not about the run — and a run is caught by `inFlight` a line earlier anyway.
 *
 * `blocked` is deliberately not here. A blocked card is parked, not done, and it is the
 * case {@link ChainRunner.releaseNote} exists for: the chain leaves it where it is and says
 * on its timeline that it was ready, so moving it back to TO DO starts it.
 */
const SETTLED: ReadonlySet<Task['status']> = new Set([
  'in-review',
  'done',
  'failed',
  'stopped',
  'cancelled',
]);

/**
 * Why a successor the chain reached was not started — the whole vocabulary of a decline,
 * and the tail of the note that reports one.
 *
 * The first three mean **this card's own work is already done or under way**, so there was
 * never anything for the release to start. The last three mean the card is still waiting to
 * run and something else is in the way — which is the case a human can act on, and the one
 * whose note ends "start it whenever you like".
 */
type Decline =
  /** A run is already reserved for it. Never two agents on one card. */
  | 'in-flight'
  /** Its own branch is in base: whatever this arrow was for, it happened. */
  | 'landed'
  /** Resting in IN REVIEW or DONE — see {@link SETTLED}. */
  | 'settled'
  /** Nobody has said who would do the work. */
  | 'no-agent'
  /** Parked somewhere the chain does not start cards from (Blocked, most of all). */
  | 'resting'
  /** The engine itself refused the start — a limit, or a run that beat us to it. */
  | 'refused';

/** How a card is named in another card's timeline: its ticket key when it has one. */
function name(task: Task): string {
  return task.externalKey ? `${task.externalKey} — ${task.title}` : task.title;
}

export class ChainRunner {
  /**
   * What each arrow has already said, so a predecessor that lands on every poll does not
   * file the same note on every poll. Two shapes of key, and the difference between them is
   * a rule rather than a detail:
   *
   *  - `<link>:<cause>` — **this arrow started that card.** Written only after `runTask`
   *    returned true, and it is what makes the whole iteration a no-op next time round:
   *    there is nothing left to start and nothing left to say.
   *  - `<link>:<cause>:<reason>` — **this arrow declined that card, for this reason.** The
   *    note is about a non-event and nothing in the world changed when it was filed, so a
   *    second pass would say exactly the same thing and needs a key to stop it. Keyed by
   *    REASON as well, so a card that was Blocked and is now merely un-assigned is told
   *    about the new obstacle rather than silently skipped.
   *
   * The rule that follows, and the bug it exists to stop: a decline **must not** write the
   * start key. A card declined while it was Blocked has to be startable by the next landing
   * once the human moves it back — the decline was a sentence, not a decision.
   *
   * {@link ChainRunner.reconsider} files its note **only after `runTask()` returned true**
   * — and that call adds the card to `inFlight` synchronously, so the card cannot pass the
   * loop's guards twice. It must therefore neither read nor write this set; writing it
   * would silence a note the card has not had yet.
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
   * `after-merge` gate downstream, and then releases whatever that unblocked.
   *
   * **The WRITE is what must be idempotent, not the release.** A GitLab poll repeats
   * "merged" on every pass for as long as the MR is retained, and the landing is a fact
   * that only ever gets stamped once — but the successor's side of the arrow can change
   * between two of those passes, and that is precisely the moment this used to miss: a card
   * that was Blocked when the branch merged, moved back to TO DO an hour later, and never
   * heard about the landing again because the second poll returned before it asked. So the
   * release is re-asked on every pass, and nothing is started twice: `announced` holds the
   * start key for an arrow that already fired, `inFlight` holds the card that is running,
   * and {@link ChainRunner.declineReason} holds the one whose work is done.
   */
  landed(taskId: string): void {
    const task = this.deps.getTask(taskId);
    if (!task) return;
    if (task.landedAt == null) this.deps.setLandedAt(taskId, this.deps.now());
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
   * The one thing it does NOT do is move the card, and that is the difference between this
   * and every automatic start: a card the app starts is moved to IN PROGRESS because nobody
   * was there to do it, and here somebody is — looking at the board, having chosen where
   * this card sits. Moving it out from under them would be the tool arguing.
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
   * persisted and because this starts only cards whose own work has not been done and is
   * not under way — see {@link ChainRunner.declineReason}. The question "is this card's
   * predecessor done" has the same answer now as it had a second ago, so re-asking cannot
   * re-release something that is already running.
   *
   * The guards are deliberately the same ones {@link ChainRunner.release} applies to a
   * successor — the same call, not merely the same idea. That is not caution, it is
   * agreement: a looser rule here would mean one card is started by a re-ask and refused by
   * a landing depending only on which of the two happened first. It is also why a card that
   * has only been PLANNED is started here: a plan is not the work the chain was drawn to
   * order, and a `sessionId` is no longer read as though it were.
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
      // `declineReason` is every guard `release` applies rolled into one — its own work
      // done or under way, no agent, parked out of the chain's reach.
      if (!task || this.declineReason(task)) continue;
      if (!readyToReleaseGiven(task, links, byId, null)) continue;
      if (!this.deps.runTask(task.id)) continue;
      // Only now, and only here: the APP started this card, so the APP moves it. Order
      // matters — see `ChainRunnerDeps.markInProgress`.
      this.deps.markInProgress(task.id);
      this.deps.addComment(task.projectId, task.id, TRIGGER_NOTE[trigger] + MOVED_NOTE);
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
   * so the merge is not what they are waiting for. And a successor whose own work is done or
   * under way is not waiting either — that is {@link ChainRunner.declineReason}, exactly the
   * guard `release` applies before it starts one, so the two cannot disagree about who is
   * held. A card that has merely been planned is held, and says so, for the same reason the
   * release would start it.
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
      if (!to || this.workUnderWay(to)) continue;
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
      // The card is gone. Nothing to start, and no timeline left to say so on.
      if (!to) continue;
      // Keyed by CAUSE as well as by link, so a `stacked` card that could not start when
      // the work was written is still told — and still started — when it later lands.
      const said = `${link.id}:${cause}`;
      // This arrow has already started that card for this cause. Everything below has been
      // said and done once; saying it again on every poll of a merged MR is the noise the
      // whole `announced` set exists to stop.
      if (this.announced.has(said)) continue;
      // Still waiting on another arrow into it. The only decline that stays silent, and on
      // purpose: "not yet" is the chain working exactly as it was drawn, the card's chip
      // already names whom it waits for, and the arrow that satisfies it last will speak.
      if (!readyToReleaseGiven(to, links, byId, fromTaskId)) continue;
      const why = this.declineReason(to);
      if (why) {
        this.noteDecline(from, to, link, cause, said, why);
        continue;
      }
      // A refusal from the engine is a decline like any other — it is the case where the
      // card looked perfectly startable, so a silent `continue` here is the one a human
      // would spend an evening on.
      if (!this.deps.runTask(to.id)) {
        this.noteDecline(from, to, link, cause, said, 'refused');
        continue;
      }
      this.announced.add(said);
      // The start was automatic, so the move comes with it — see `reconsider` for the twin.
      this.deps.markInProgress(to.id);
      this.deps.addComment(to.projectId, to.id, this.releaseNote(from, to, link, cause, null));
    }
  }

  /**
   * Say on a successor's timeline that this arrow could have started it and did not, and
   * why — once per arrow, cause and reason.
   *
   * Deliberately NOT the `<link>:<cause>` key a start writes: a decline decides nothing, so
   * the next landing must be free to reconsider the same card. See `announced`.
   */
  private noteDecline(
    from: Task,
    to: Task,
    link: TaskLink,
    cause: ReleaseCause,
    said: string,
    why: Decline,
  ): void {
    const key = `${said}:${why}`;
    if (this.announced.has(key)) return;
    this.announced.add(key);
    this.deps.addComment(to.projectId, to.id, this.releaseNote(from, to, link, cause, why));
  }

  /**
   * What the successor's timeline says about being released — `why` null once a run is
   * under way, and otherwise the reason there is not one.
   *
   * It names the card that released it, because "started automatically" with no subject is
   * the kind of entry that makes a human go looking through three other cards' logs. The
   * `stacked` wording carries the warning that comes with the loose gate: this branch is
   * not cut from base, so merging it merges the other card's work too.
   *
   * The head splits three ways rather than two, and the split is the point of the sentence:
   * **Ready to start** is an invitation — the card is still waiting to be run and a human
   * can have it running in one click — while **Not started** reports a card that has moved
   * past this arrow and wants nothing from anybody.
   *
   * A start also reports the COLUMN move it came with ({@link MOVED_NOTE}), because that is
   * the one change to the card nobody asked for and the timeline is where it is answered
   * for. A decline never does: nothing moved.
   */
  private releaseNote(
    from: Task,
    to: Task,
    link: TaskLink,
    cause: ReleaseCause,
    why: Decline | null,
  ): string {
    const head =
      why === null
        ? 'Started automatically'
        : why === 'no-agent' || why === 'resting'
          ? 'Ready to start'
          : 'Not started';
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
    return `${head}: ${because}${stacked}${this.tail(to, why)}`;
  }

  /** The half of {@link ChainRunner.releaseNote} that names the reason. */
  private tail(to: Task, why: Decline | null): string {
    switch (why) {
      case null:
        return MOVED_NOTE;
      case 'no-agent':
        return ' Nothing was started: this card has no agent assigned. Assign one to run it.';
      case 'resting':
        return (
          ` Nothing was started: the card is ${restingStatus(to)}, and the chain starts a ` +
          `card from To Do or In Progress only — it never takes one off a run, or off a ` +
          `column you deliberately put it in. Start it whenever you like.`
        );
      case 'in-flight':
        return ' Nothing was started: this card already has a run under way.';
      case 'landed':
        return " Nothing was started: this card's own work has already landed.";
      case 'settled':
        return (
          ` Nothing was started: this card is resting in ${restingStatus(to)} — its own work ` +
          `is finished with.`
        );
      case 'refused':
        return (
          ' Nothing was started: the engine refused the run, so something else has it — most ' +
          'likely a run that started a moment earlier, or a usage limit.'
        );
    }
  }

  /**
   * Whether this card's **own work** is already done or under way — the one answer that
   * makes a release moot, whichever path asked.
   *
   * Not `sessionId`, which is what this used to read and what made the chain stall: a card
   * that was planned, or that somebody chatted with about the ticket, has a session and has
   * done nothing it was chained to do. What actually settles the question is whether a run
   * is reserved, whether this card's branch is in base, and whether the human has filed it
   * under IN REVIEW or DONE. Returns the reason, so the caller can say it out loud.
   *
   * The `inFlight` clause is the one that must never be relaxed: it, and the same check
   * inside `Scheduler.runTask`, are what keep two agents off one card.
   */
  private workUnderWay(task: Task): Decline | null {
    if (this.deps.inFlight(task.id)) return 'in-flight';
    if (task.landedAt != null) return 'landed';
    if (SETTLED.has(restingStatus(task))) return 'settled';
    return null;
  }

  /**
   * Why a release may not start this card, or null when it may — every guard the two
   * release paths share, in one place so they cannot drift apart.
   */
  private declineReason(task: Task): Decline | null {
    const working = this.workUnderWay(task);
    if (working) return working;
    if (!task.agentProjectId) return 'no-agent';
    if (!this.startable(task)) return 'resting';
    return null;
  }

  /**
   * Whether the card is resting somewhere a release may start it from.
   *
   * TO DO and IN PROGRESS: the two columns that mean the work is still ahead of the card.
   * `pending` is the queue's own "waiting to run"; `in-progress` is a card somebody has
   * begun — by hand, or with a run that has since finished — and is exactly where a chained
   * card that has been planned, or chatted with, tends to sit. Neither says the work is
   * done, and refusing to start from either was how a chain came to stall on a card whose
   * only crime was that somebody had talked to it.
   *
   * BLOCKED, IN REVIEW and DONE are left alone, because the human put the card there
   * deliberately. For those the chain says its piece on the timeline and moves nothing — the
   * automatic move to IN PROGRESS belongs to a card the chain STARTED, and one it declined
   * was never started.
   *
   * Reads `restingStatus`, never `status`: while a run holds that field the question is
   * about the column the card was left in, and a live run is refused a line earlier anyway.
   */
  private startable(task: Task): boolean {
    const resting = restingStatus(task);
    return (
      Boolean(task.agentProjectId) &&
      (resting === 'pending' || resting === 'in-progress') &&
      !this.deps.inFlight(task.id)
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
