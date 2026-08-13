/**
 * parkedRun — how to rebuild a run a gate stopped.
 *
 * A gate (usage limit or sign-in) parks TASKS, and a task is all either gate remembers.
 * That is enough for ordinary work — a resume is a fresh `startTask` on the card, which is
 * exactly what was running — but it is not enough for the two runs that are not about the
 * card's work at all:
 *
 *  - a **release** run (`releaseSeed`), which runs in the project directory to publish work
 *    that has already merged. Resumed as ordinary work it re-opens the card's own session in
 *    a worktree and starts *implementing* something instead of releasing it; and
 *  - a **chat** reply (`chatPrompt`), whose entire reason to exist is the sentence the human
 *    typed. Resumed without it the agent is nudged awake with nothing to answer.
 *
 * Everything else a run carries is derivable from the task on the way back: `reviewSeed`
 * comes from `task.chainLandedAt` inside `startTask`, and an ordinary work run is what a
 * bare `startTask` already produces. So a recipe is written only for the two kinds above,
 * and its absence means "ordinary work" — which is precisely today's behaviour, so a lost
 * or stale recipe degrades to the status quo rather than to a wrong kind of run.
 *
 * Kept as its own side table (persisted under its own `app_state` key) rather than as a
 * field on `LimitState`/`AuthState`: a five-hour gate very often outlives a restart, so the
 * recipes must be persisted — but both gate shapes cross the IPC boundary into the banner,
 * and neither of them wants a copy of what a human typed into a chat box.
 */
import type { PermissionMode } from '@shared/session';

/** What `startTask` has to be told again to rebuild a parked run. Mirrors its `opts`. */
export interface ParkedRun {
  /** The task whose parked run this describes — one run per task, so one recipe per task. */
  taskId: string;
  /** (Phase 12) The human's chat message, when the parked run existed only to carry it. */
  chatPrompt?: string;
  /** The parked run was releasing merged work (see `@shared/release`), not doing the card's. */
  releaseSeed?: boolean;
  /**
   * The mode the parked run was actually started with — a per-TURN choice, not the card's.
   * A release above all: `releaseMode` deliberately declines to inherit a card's `plan`,
   * and re-deriving it from the card on the way back would hand the release a mode that
   * structurally cannot follow a line of RELEASE.md.
   */
  permissionMode?: PermissionMode;
}
