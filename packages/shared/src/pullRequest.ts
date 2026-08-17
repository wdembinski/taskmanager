/**
 * Open-a-PR — "when this card's work is finished, push the branch and open a pull request
 * instead of merging it here".
 *
 * A direct mirror of `release.ts`, and deliberately so: two switches, one answer. The
 * project carries the PREFERENCE (Settings → the project's dialog), a card carries an
 * OVERRIDE (the Details Panel), and `null` on the card means "whatever the project says" —
 * so changing the project's mind changes every card that never disagreed with it.
 *
 * What it decides is an EITHER/OR, which is the one thing worth saying out loud here: a card
 * whose answer is yes has its branch pushed and a PR opened, and it is **not** merged
 * locally. Merging it here and then opening a pull request for work that is already in base
 * would be a PR with nothing in it — so the two are alternatives, not a sequence, and the
 * scheduler reads this before it reaches `autoIntegrateOn`.
 */
import type { Project, Task } from './model';

/**
 * Whether finishing this card's work should push its branch and open a PR/MR.
 *
 * Says nothing about whether the repo HAS a remote, or whether a token for its forge is
 * saved — both are facts only the main process can see, and both are checked at the moment
 * the PR is opened rather than when the switch was flipped.
 */
export function autoCreatePrOn(
  task: Pick<Task, 'autoCreatePr'> | null | undefined,
  project: Pick<Project, 'autoCreatePr'> | null | undefined,
): boolean {
  const override = task?.autoCreatePr;
  if (override === true || override === false) return override;
  return project?.autoCreatePr === true;
}
