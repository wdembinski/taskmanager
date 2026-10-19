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
 *  - **Any start of a To Do card moves it to In Progress; nothing else moves a card.** A
 *    card being worked on that still reads TO DO is a lie. The chain's automatic start does
 *    it through `markInProgress`; a human **Start**, **Run this step** and **Release now** do
 *    it through `moveHandStartedCard` (`handStartMove.ts`, wired in `ipc.ts`). Where a card
 *    resting anywhere else SITS stays the human's, exactly as it is for every other run (see
 *    `@shared/board`'s `restingStatus`): a start never moves it, and a decline or a settle
 *    moves nothing. The one narrow exception: a project with "Move to Done when its PR
 *    lands" moves a landed card to DONE from the forge sync (`landedDoneMove.ts`). The chain
 *    never reads that move — successors start on `landedAt`, not on status.
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
 *
 * And one limit on all of it: a project's **ready lanes** (`@shared/readyLanes`). Both start
 * paths ask that one function which of a project's releasable cards fit, so the engine starts
 * exactly the cards the board marks ready and queues the ones it marks queued. Only the
 * human's **Release now** goes past it, as it goes past every other gate.
 *
 * And one more, from the same plan: a card whose **files** overlap an active card's in its
 * project (`@shared/fileOverlap`, the plan's `fileHeld`) waits for that card, and says so.
 * Release now goes past that too.
 */
import { restingStatus } from '@shared/board';
import type { Task } from '@shared/model';
import { fileHolds, holdAgainst, MAX_SHOWN_FILES, type FileHold } from '@shared/fileOverlap';
import { compareLaneOrder, readyLanesByProject, type LanePlan } from '@shared/readyLanes';
import {
  blockedBy,
  chainDecline,
  chainWorkUnderWay,
  outgoingLinks,
  readyToReleaseGiven,
  type ChainDecline,
  type TaskLink,
} from '@shared/taskChain';

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
  /** Every card filed under a project, steps included — what a lane count is taken over. */
  projectTasks(projectId: string): Task[];
  /** The project's ready-lane cap (`Project.readyLanes`). `0` = unlimited. */
  laneCap(projectId: string): number;
  /** The cards with an open PR/MR — a card in review with one still holds its lane. */
  openPrTaskIds(): ReadonlySet<string>;
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
export type ChainTrigger =
  'boot' | 'limit-lifted' | 'links-changed' | 'card-changed' | 'decision-cleared' | 'lane-freed';

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
  'decision-cleared':
    'Started when its open decision was cleared: everything it was chained to wait for had ' +
    'already finished.',
  'lane-freed':
    'Started when a ready lane freed up, or the files it waited for: everything it was ' +
    'chained to wait for had already finished, and it was next in line.',
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

/** How a card waiting for another card's files is told it will not wait forever. */
const FREED_NOTE = 'It starts by itself once that card lands or its run ends.';

/** The statuses that mean "the human has taken this card off the chain's hands". */
const ABANDONED: ReadonlySet<Task['status']> = new Set(['stopped', 'cancelled']);

/**
 * Why a successor the chain reached was not started — the whole vocabulary of a decline,
 * and the tail of the note that reports one.
 *
 * Five of the six are {@link ChainDecline}, which lives in `@shared/taskChain` **because
 * the board asks the same question**: a card whose arrows are all satisfied and which the
 * engine would nonetheless refuse has to say so on the board, or a solid arrow leads to a
 * card that merely looks idle. This one adds the sixth, which only the engine can know.
 */
type Decline =
  | ChainDecline
  /** The engine itself refused the start — a limit, or a run that beat us to it. */
  | 'refused'
  /** Its turn came, but every ready lane of its project is taken — see `@shared/readyLanes`. */
  | 'lane-limit'
  /** Its turn came, but an active card of its project touches the same files — `@shared/fileOverlap`. */
  | 'file-overlap';

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

  /**
   * The cards already told they are **queued** behind the lane limit, each with the start
   * keys (`<link>:<cause>`) of the arrows that queued it — empty for a re-ask.
   *
   * Keyed by CARD rather than by arrow, unlike `announced`: the queue is the project's, not
   * any arrow's, so a card waiting for a lane is told once however many passes find it still
   * waiting. Cleared when the card starts, so a card queued again later is told again. The
   * arrow keys go into `announced` at that start, because the arrow did, in effect, start the
   * card — without them the next poll of the same merged MR would report the card's own run
   * as a decline.
   */
  private readonly queued = new Map<string, string[]>();

  /**
   * The cards already told they **wait for another card's files**, with the card they wait
   * for and the start keys of the arrows that held them — the twin of `queued`, drained the
   * same way when the card starts. A re-ask that finds it held by the same card says
   * nothing; held by a different one, it is told again.
   */
  private readonly held = new Map<string, { by: string; keys: string[] }>();

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
   * It files only its own note and moves no column itself. The `chain:releaseNow` ipc
   * handler applies the hand-start move afterwards (`moveHandStartedCard`), which moves a
   * card resting in TO DO to IN PROGRESS — and only that: a Blocked card stays Blocked.
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
    const links = this.deps.links();
    const waiting = blockedBy(task, links, this.index(links));
    // Asked before the start, which takes a lane of its own. The cap is ignored here exactly
    // as the gates are — the human chose — but a card that was queued says it jumped the queue.
    // A file hold is bypassed the same way: the human pressed the button knowing what runs.
    const wasQueued = this.lanePlan(task.projectId, links).queued.has(task.id);
    if (!this.deps.runTask(taskId)) {
      return 'The engine could not start that card — it may already be running, or held by a usage limit.';
    }
    this.queued.delete(task.id);
    this.held.delete(task.id);
    const jumped = wasQueued
      ? ` It also went past the project's ready-lane limit: ${this.lanesTaken(task)}`
      : '';
    this.deps.addComment(
      task.projectId,
      task.id,
      (waiting.length > 0
        ? `Released by hand, without waiting for ${waiting.map(name).join(', ')}. ` +
          `The chain still records the ordering — this run simply went ahead of it.`
        : 'Started by hand from its chain.') + jumped,
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
    const candidates = new Map<string, Task[]>();
    for (const id of new Set(links.map((l) => l.toTaskId))) {
      const task = byId.get(id);
      // `declineReason` is every guard `release` applies rolled into one — its own work
      // done or under way, no agent, parked out of the chain's reach.
      if (!task || this.declineReason(task)) continue;
      if (!readyToReleaseGiven(task, links, byId, null)) continue;
      const group = candidates.get(task.projectId);
      if (group) group.push(task);
      else candidates.set(task.projectId, [task]);
    }
    // Lanes are per project and taken in the board's order — priority, then ticket number —
    // so the cards that start are exactly the ones the board marks ready.
    for (const group of candidates.values()) {
      for (const task of group.sort(compareLaneOrder)) {
        // Re-asked per card: each start takes a lane and holds its files, and a refused one
        // leaves both free. A held card is asked first — it takes no lane while it waits.
        const hold = this.fileHold(task, links);
        if (hold) {
          this.noteHeld(task, hold, null);
          continue;
        }
        const lane = this.lane(task, links);
        if (!lane.fits) {
          this.noteQueued(task, lane.plan);
          continue;
        }
        if (!this.deps.runTask(task.id)) continue;
        this.startedFromQueue(task.id);
        // Only now, and only here: the APP started this card, so the APP moves it. Order
        // matters — see `ChainRunnerDeps.markInProgress`.
        this.deps.markInProgress(task.id);
        this.deps.addComment(task.projectId, task.id, TRIGGER_NOTE[trigger] + MOVED_NOTE);
      }
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
      // Its turn has come, but an active card may be touching the same files — every merge
      // conflict of 2026-10-18 was two cards editing the same files at once. Asked per start,
      // so the first of two overlapping successors runs and the second waits for it.
      const hold = this.fileHold(to, links);
      if (hold) {
        this.noteDecline(from, to, link, cause, said, 'file-overlap', hold);
        this.noteHeld(to, hold, said);
        continue;
      }
      // Its turn has come, but the project's lanes may all be taken. Asked per start, so two
      // releases in one loop cannot both take the last lane.
      if (!this.lane(to, links).fits) {
        this.noteDecline(from, to, link, cause, said, 'lane-limit');
        const keys = this.queued.get(to.id) ?? [];
        if (!keys.includes(said)) keys.push(said);
        this.queued.set(to.id, keys);
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
      this.startedFromQueue(to.id);
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
    hold?: FileHold,
  ): void {
    const key = `${said}:${why}`;
    if (this.announced.has(key)) return;
    this.announced.add(key);
    this.deps.addComment(to.projectId, to.id, this.releaseNote(from, to, link, cause, why, hold));
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
    hold?: FileHold,
  ): string {
    const head =
      why === null
        ? 'Started automatically'
        : why === 'needs-decision'
          ? 'Waiting on a decision'
          : why === 'lane-limit' || why === 'file-overlap'
            ? 'Queued'
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
    return `${head}: ${because}${stacked}${this.tail(to, why, hold)}`;
  }

  /** The half of {@link ChainRunner.releaseNote} that names the reason. */
  private tail(to: Task, why: Decline | null, hold?: FileHold): string {
    switch (why) {
      case null:
        return MOVED_NOTE;
      case 'needs-decision':
        return (
          ` Nothing was started: its turn came, but it is waiting on a decision: ` +
          `${to.decisionQuestion} Answer it on the card or in the Inbox, then start it.`
        );
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
      case 'lane-limit':
        return ` Nothing was started yet: ${this.lanesTaken(to)} It starts by itself when one frees up.`;
      case 'file-overlap':
        return ` Nothing was started yet. ${this.waitsFor(hold)}. ${FREED_NOTE}`;
    }
  }

  /** "Waits for TM-x — same files: a, b" — the card it waits for, and up to three of the files. */
  private waitsFor(hold: FileHold | undefined): string {
    if (!hold) return 'Waits for another card — same files';
    const by = this.deps.getTask(hold.byTaskId);
    const who = by?.externalKey ?? (by ? `"${by.title}"` : 'another card');
    const shown = hold.files.slice(0, MAX_SHOWN_FILES).join(', ');
    const more = hold.files.length - MAX_SHOWN_FILES;
    return `Waits for ${who} — same files: ${shown}${more > 0 ? ` and ${more} more` : ''}`;
  }

  /**
   * Remember that a card waits for another card's files, and tell it — once per card it
   * waits for. `said` is the start key of the arrow that held it, or null for a re-ask; a
   * release files its own note through `noteDecline`, so only a re-ask writes one here.
   */
  private noteHeld(task: Task, hold: FileHold, said: string | null): void {
    const prior = this.held.get(task.id);
    const keys = [...(prior?.keys ?? [])];
    if (said && !keys.includes(said)) keys.push(said);
    this.held.set(task.id, { by: hold.byTaskId, keys });
    if (said || prior?.by === hold.byTaskId) return;
    this.deps.addComment(
      task.projectId,
      task.id,
      `${this.waitsFor(hold)}. Everything this card was chained to wait for has finished, ` +
        `but two cards editing the same files at once is how merge conflicts start. ${FREED_NOTE}`,
    );
  }

  /** The half-sentence every queued card's note shares: how many lanes, all of them taken. */
  private lanesTaken(to: Task): string {
    const cap = this.deps.laneCap(to.projectId);
    return `all ${cap} of this project's ready lane${cap === 1 ? ' is' : 's are'} taken.`;
  }

  /**
   * Tell a card a re-ask found that it is queued — once, until it starts. A card a landing
   * already queued has been told, by that landing's own note.
   */
  private noteQueued(task: Task, plan: LanePlan): void {
    if (this.queued.has(task.id) || plan.cap === 0) return;
    this.queued.set(task.id, []);
    this.deps.addComment(
      task.projectId,
      task.id,
      `Queued (lane limit): everything this card was chained to wait for has finished, but ` +
        `${this.lanesTaken(task)} It starts by itself when one frees up.`,
    );
  }

  /**
   * A card left the queue by starting: the arrows that queued or held it count as having
   * started it.
   */
  private startedFromQueue(taskId: string): void {
    for (const key of this.queued.get(taskId) ?? []) this.announced.add(key);
    for (const key of this.held.get(taskId)?.keys ?? []) this.announced.add(key);
    this.queued.delete(taskId);
    this.held.delete(taskId);
  }

  /**
   * One project's lanes as they stand this instant — `running` is the engine's own
   * `inFlight`, read live, so a start a moment ago already holds its lane.
   *
   * The cards are the project's own plus every card at either end of an arrow, so a
   * predecessor filed under another project still reads as satisfied; only this project's
   * plan is read back.
   */
  private lanePlan(projectId: string, links: readonly TaskLink[]): LanePlan {
    const { all, running, openPrs } = this.board(projectId, links);
    const plans = readyLanesByProject(all, links, running, (id) => this.deps.laneCap(id), openPrs);
    return (
      plans.get(projectId) ?? {
        ready: new Set(),
        queued: new Set(),
        fileHeld: new Map(),
        occupied: 0,
        cap: 0,
      }
    );
  }

  /** The cards a lane plan is drawn over (see {@link ChainRunner.lanePlan}), as they stand now. */
  private board(
    projectId: string,
    links: readonly TaskLink[],
  ): { all: Task[]; running: Set<string>; openPrs: ReadonlySet<string> } {
    const cards = new Map(this.deps.projectTasks(projectId).map((t) => [t.id, t]));
    for (const [id, t] of this.index(links)) if (!cards.has(id)) cards.set(id, t);
    const all = [...cards.values()];
    const running = new Set(all.filter((t) => this.deps.inFlight(t.id)).map((t) => t.id));
    return { all, running, openPrs: this.deps.openPrTaskIds() };
  }

  /**
   * Why this card must wait for another card's files right now, or null when it need not.
   *
   * The plan's `fileHeld` is the board's answer, and the one to agree with. But a release
   * asks before the board's copy of the predecessor has caught up (see `lane` below), so the
   * card may not be a candidate in the plan yet — then it is held by hand, against the active
   * cards and the ready candidates ahead of it in lane order, as the plan would a moment later.
   *
   * The hold lifts by itself: an active card stops being one when its run exits or its PR
   * merges, and both re-ask the chain (`reconsiderChains('lane-freed')`).
   */
  private fileHold(task: Task, links: readonly TaskLink[]): FileHold | null {
    if (task.parentTaskId || !task.plannedFiles?.length) return null;
    const plan = this.lanePlan(task.projectId, links);
    const planned = plan.fileHeld.get(task.id);
    if (planned) return planned;
    if (plan.ready.has(task.id) || plan.queued.has(task.id)) return null;
    const { all, running, openPrs } = this.board(task.projectId, links);
    const active = fileHolds(all, running, openPrs).get(task.id);
    if (active) return active;
    const ahead = [...plan.ready]
      .map((id) => this.deps.getTask(id))
      .filter((t): t is Task => t !== undefined && compareLaneOrder(t, task) < 0);
    return holdAgainst(task, ahead);
  }

  /**
   * Whether this card fits in a free lane of its project right now.
   *
   * Ranked against the plan's candidates PLUS this card, rather than looked up in
   * `plan.ready`: a release asks at the instant it watched the predecessor finish, before the
   * board's copy of it has caught up (see `readyToReleaseGiven`), so the plan may not count
   * this card as a candidate yet. Ranking it in by hand is the answer the plan gives a moment
   * later.
   */
  private lane(task: Task, links: readonly TaskLink[]): { fits: boolean; plan: LanePlan } {
    const plan = this.lanePlan(task.projectId, links);
    if (plan.cap === 0) return { fits: true, plan };
    const pool = new Map<string, Task>([[task.id, task]]);
    for (const id of [...plan.ready, ...plan.queued]) {
      const t = this.deps.getTask(id);
      if (t) pool.set(id, t);
    }
    const rank = [...pool.values()].sort(compareLaneOrder).findIndex((t) => t.id === task.id);
    return { fits: rank < Math.max(0, plan.cap - plan.occupied), plan };
  }

  /**
   * Whether this card's **own work** is already done or under way — the one answer that
   * makes a release moot, whichever path asked. See `chainWorkUnderWay`, which is where the
   * reasoning lives now that the board asks it too.
   *
   * The `inFlight` argument is the one that must never be relaxed: it, and the same check
   * inside `Scheduler.runTask`, are what keep two agents off one card.
   */
  private workUnderWay(task: Task): Decline | null {
    return chainWorkUnderWay(task, this.deps.inFlight(task.id));
  }

  /**
   * Why a release may not start this card, or null when it may — every guard the two
   * release paths share, in one place so they cannot drift apart.
   *
   * That "one place" is `@shared/taskChain` rather than this file: the board draws a chip
   * from the very same answer, and while it computed its own the two disagreed about a card
   * resting in IN PROGRESS and about one with no agent — which is to say, about exactly the
   * card a human then reports as "chained but never started".
   */
  private declineReason(task: Task): Decline | null {
    return chainDecline(task, this.deps.inFlight(task.id));
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
