/**
 * Building the board's key index — the pure loop behind `ipc.ts#boardKeyIndex`, pulled out so
 * it can be exercised without the `registerIpc` closure around it (see `the-store-has-no-tests`
 * for why nothing in that closure has a test file today).
 *
 * Takes whatever slice of tasks the caller considers "the board" and indexes their keys, so a
 * merge request's issue references can be matched to a card. No behavior beyond the loop
 * itself: callers decide which tasks to pass in (and thus whether archived rows are excluded).
 */
import type { Task } from '@shared/model';
import { taskBranch } from '../worktreeManager';

export function buildBoardIndex(tasks: readonly Task[]): {
  knownKeys: string[];
  taskIdByKey: Map<string, string>;
  knownTaskIds: Set<string>;
  taskIdByBranch: Map<string, string>;
} {
  const taskIdByKey = new Map<string, string>();
  const knownTaskIds = new Set<string>();
  const taskIdByBranch = new Map<string, string>();
  /** Branches two top-level cards both claim — matched to neither. */
  const ambiguous = new Set<string>();
  for (const task of tasks) {
    knownTaskIds.add(task.id);
    // Any tracker's key, not JIRA's alone: a GitHub pull request names its issue as
    // `owner/repo#123`, which is the same kind of fact about the same kind of card. The
    // upper-casing is what makes the lookup case-insensitive on both spellings.
    if (task.externalSource && task.externalKey) {
      taskIdByKey.set(task.externalKey.toUpperCase(), task.id);
    }
    // A NATIVE ticket's key (`TM-12`) counts too, and leaving it out was a hole rather
    // than a decision: it is the key this app writes into the `Ticket ID:` trailer of every
    // pull request it opens (`prBody`) and into the branch name, the key a human types into
    // a branch name, and the one the card itself prints — but nothing here indexed it, so
    // no merge request naming it could ever be matched to it. A card with a native ticket
    // behind it looked, to every reconciler, exactly like a card with no key at all.
    const ticketKey = task.ticketKey?.trim();
    // Never over a tracker's own: `externalKey` is the mirrored issue's real name, and if
    // some board somehow spells both the same, the mirrored card is the one whose key the
    // forge's text is quoting.
    if (ticketKey && !taskIdByKey.has(ticketKey.toUpperCase())) {
      taskIdByKey.set(ticketKey.toUpperCase(), task.id);
    }

    /**
     * The branch the card's work is on — a FACT about whose PR it is, where a key in the text
     * is only a guess. A PR the agent opened with `gh pr create` names no key and was never
     * opened by our button, so this is the only thing that can file it.
     *
     * Top-level cards only: a step shares its parent's worktree and therefore its branch
     * (`Scheduler.branchFor`), and the parent is the card that lands. Exact and case-sensitive,
     * as git is. The legacy `orch/<taskId>` stands in for a card with no chosen name, the same
     * fallback the worktree uses. Two cards claiming one branch is a branch that says nothing,
     * so it is dropped rather than handed to whichever the loop met first.
     */
    if (task.parentTaskId || task.archivedAt != null) continue;
    const branch = task.agentBranch?.trim() || taskBranch(task.id);
    if (ambiguous.has(branch)) continue;
    const claimed = taskIdByBranch.get(branch);
    if (claimed !== undefined && claimed !== task.id) {
      taskIdByBranch.delete(branch);
      ambiguous.add(branch);
      continue;
    }
    taskIdByBranch.set(branch, task.id);
  }
  return { knownKeys: [...taskIdByKey.keys()], taskIdByKey, knownTaskIds, taskIdByBranch };
}
