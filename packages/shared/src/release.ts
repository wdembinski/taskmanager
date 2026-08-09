/**
 * Auto-release — "when this card's branch merges, cut the release too".
 *
 * The instructions are the REPO's, not the app's: a project that knows how to release
 * itself says so in a `RELEASE.md` at its root, and the agent follows that file. The
 * orchestrator only decides *when* to ask, never *how* — which is why there is no
 * release recipe anywhere in this codebase, only the name of the file to look for.
 *
 * Two switches, one answer. The project carries the PREFERENCE (Settings → the project's
 * dialog), a card carries an OVERRIDE (the Details Panel), and `null` on the card means
 * "whatever the project says" — so changing the project's mind changes every card that
 * never disagreed with it. That is the whole reason the card's field is nullable rather
 * than copied from the project at assignment time: a copy taken then would freeze a
 * preference the human is still forming.
 */
import type { Project, Task } from './model';

/**
 * The file a project puts its release instructions in, at the repo root.
 *
 * A constant rather than a setting: the point of the feature is that a repo can be
 * *recognized* as releasable without anyone configuring the app first, and a
 * per-project filename would be one more thing to fill in before anything works.
 */
export const RELEASE_DOC = 'RELEASE.md';

/**
 * Whether a merge of this card should be followed by a release run.
 *
 * Says nothing about whether the project HAS a `RELEASE.md` — that is a fact about the
 * disk, which only the main process can see (and which is checked at the moment of the
 * merge, not when the switch was flipped).
 */
export function autoReleaseOn(
  task: Pick<Task, 'autoRelease'> | null | undefined,
  project: Pick<Project, 'autoRelease'> | null | undefined,
): boolean {
  const override = task?.autoRelease;
  if (override === true || override === false) return override;
  return project?.autoRelease === true;
}
