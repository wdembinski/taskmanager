/**
 * Moving a card's FILING — `projectTagId`, the colour stripe — along with a reassignment,
 * when the filing looks like it was never a human's choice to begin with.
 *
 * Delegating a card writes `agentProjectId` and, if the card was unfiled, back-fills
 * `projectTagId` from it too (`ipc.ts`'s `task:assignAgent`, and before the split,
 * `splitProjectTag` did the identical back-fill for every pre-existing row). That back-fill
 * is a courtesy, not a fact the human asserted — and the very next reassignment used to
 * leave it stranded on the OLD repo, so a card reassigned from Alpha to Beta kept Alpha's
 * colour until someone noticed and fixed it by hand in the Project dropdown.
 *
 * The fix needs no new column. A back-fill wrote exactly `agentProjectId`, so a filing that
 * still equals the delegation it came from is one this code almost certainly wrote itself;
 * one that differs must be a human's, because nothing else ever moves `projectTagId` away
 * from its own `agentProjectId`. So: follow the assignment when the filing still matches the
 * OLD delegation (or there is no filing at all), and leave it alone the moment it doesn't.
 *
 * Wrong in exactly one case, and it is the cheap mistake to make: a card a human filed under
 * Alpha *and* delegated to Alpha is re-filed when reassigned to Beta. There is no column
 * naming who wrote the tag, so that case is unresolvable from the data — the notch follows
 * the agent the human just picked, and one click in the Project dropdown puts it back
 * permanently (a filing that then differs from `agentProjectId` is never touched again).
 */
import { isFilingProject } from '@shared/model';
import type { Project, Task } from '@shared/model';

/** The subset of a task the filing decision reads. */
type FilingState = Pick<Task, 'projectTagId' | 'agentProjectId'>;

/** The patch a reassignment may make to a card's filing. */
export type FilingPatch = Partial<Pick<Task, 'projectTagId'>>;

/**
 * Whether a card's filing is one this code could have written itself — absent, or still
 * equal to the delegation it was back-filled from — as opposed to one a human set.
 */
export function filingFollowsAssignment(task: FilingState): boolean {
  return !task.projectTagId || task.projectTagId === (task.agentProjectId ?? null);
}

/**
 * The filing patch a reassignment to `target` should make, given the task as it is now
 * (`before` the reassignment writes `agentProjectId: target.id`).
 *
 * Empty unless the filing follows the OLD assignment (see {@link filingFollowsAssignment})
 * AND `target` is one the Project dropdown could actually offer — `isFilingProject`, not
 * `hasRepo`: the handler only checks `hasRepo`, so a relayed call can name a plan-driven
 * repo the dropdown never offers, and this must not file a card under one.
 */
export function assignmentFilingPatch(task: FilingState, target: Project): FilingPatch {
  if (!filingFollowsAssignment(task) || !isFilingProject(target)) return {};
  return { projectTagId: target.id };
}
