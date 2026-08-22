/**
 * Choosing and applying the JIRA transition a resolved move needs — the JIRA-specific half
 * of a drag-to-move on the board (Phase C).
 *
 * The move resolution itself — given a task and the column it was dropped into, the new
 * local status, whether to remember a pre-block column, and whether a JIRA transition is
 * needed at all — moved to `@shared/moveResolve` (Phase 25 — cloud web independence): it
 * does no JIRA I/O of its own, so `apps/server`'s own write endpoints can resolve a move
 * exactly the same way the desktop's drag handler does. Re-exported here rather than
 * repointing every call site in this app at the new module.
 */
import type { BoardColumn, JiraStatusCategory } from '@shared/model';
import { categoryFromKey } from '@shared/board';
import {
  STATUS_REASONS,
  isBlockedishStatus,
  resolveStatusColumn,
  type StatusReason,
} from '@shared/statusResolve';
import { resolveMove, type JiraTransitionTarget, type MoveResolution } from '@shared/moveResolve';
import type { JiraTransition } from './jiraClient';
import type { JiraSettings } from '@shared/settings';

export { resolveMove, type JiraTransitionTarget, type MoveResolution };

/** The settings `pickTransition` consults — one name override per target, plus both maps. */
export type TransitionSettings = Pick<
  JiraSettings,
  | 'todoTransitionName'
  | 'inProgressTransitionName'
  | 'inReviewTransitionName'
  | 'doneTransitionName'
  | 'blockedTransitionName'
  | 'statusCategoryOverrides'
  | 'learnedStatusColumns'
>;

const NAME_OVERRIDE: Record<JiraTransitionTarget, keyof TransitionSettings> = {
  toTodo: 'todoTransitionName',
  toInProgress: 'inProgressTransitionName',
  toInReview: 'inReviewTransitionName',
  toDone: 'doneTransitionName',
  toBlocked: 'blockedTransitionName',
};

/** The board column each transition target is trying to reach. */
const TARGET_COLUMN: Record<JiraTransitionTarget, BoardColumn> = {
  toTodo: 'todo',
  toInProgress: 'in-progress',
  toInReview: 'in-review',
  toDone: 'done',
  toBlocked: 'blocked',
};

/** What each target is called when a failure has to be explained to a human. */
export const TARGET_LABEL: Record<JiraTransitionTarget, string> = {
  toTodo: 'To Do',
  toInProgress: 'In Progress',
  toInReview: 'In Review',
  toDone: 'Done',
  toBlocked: 'Blocked',
};

/** How each board column reads inside a sentence written for a human. */
export const COLUMN_LABEL: Record<BoardColumn, string> = {
  todo: 'TO DO',
  'in-progress': 'IN PROGRESS',
  'in-review': 'IN REVIEW',
  blocked: 'BLOCKED',
  done: 'DONE',
};

/** The transition a move will apply, plus everything the caller needs to explain it. */
export interface TransitionChoice {
  /** The transition to POST. */
  transition: JiraTransition;
  /** Which tier chose it — or `'name'` for the user's exact-transition-name override. */
  via: 'name' | StatusReason;
  /** The column this transition's DESTINATION status resolves to. */
  destinationColumn: BoardColumn;
  /**
   * True when that destination is not the column the drag was aiming at. Only the name
   * override can produce this: every other path picks BY the destination's column.
   */
  mismatch: boolean;
}

/**
 * Choose which JIRA transition to apply for a target, in order of how much we know:
 *
 *   1. an exact transition name the user configured for this target;
 *   2. otherwise the first transition whose DESTINATION STATUS resolves to this
 *      target's column — tried tier by tier, so an explicitly-mapped status is taken
 *      before a learned one, a learned one before the name heuristic, and the plain
 *      category last.
 *
 * The destination is resolved with the very same `resolveStatusColumn` the sync uses
 * (`shared/statusResolve.ts`), which is the point: a transition is only picked for IN
 * REVIEW if the sync would also read that status as IN REVIEW, so a drag can no longer
 * move a ticket somewhere the next sync disagrees with. It also subsumes the old
 * hand-written guard against IN PROGRESS grabbing a review status — "Code Review"
 * resolves to `in-review`, so it can never equal `in-progress`.
 *
 * Tier-by-tier rather than first-match-wins over the transition list, because a
 * workflow's transitions come back in the order the workflow declares them: a bare
 * scan would take a category-guess that happened to be listed first over the status
 * the user explicitly mapped.
 *
 * WITHIN a tier the same reasoning applies one level down, which is the bug this
 * function was rewritten for. Every match in a tier is *equally* justified by the
 * rules, so taking `matches[0]` hands the decision to the workflow's declaration
 * order — and that is precisely how a workflow listing "Block" before "Start
 * Progress" sent an IN PROGRESS drag to Blocked. So: collect the matches, and prefer
 * the one whose destination is literally named after the column. A status called
 * "In Progress" is the least surprising answer an IN PROGRESS drag can be given;
 * only when nothing is named that does declaration order get to break the tie.
 *
 * Returns null when nothing fits — the caller turns that into a readable error rather
 * than moving the card silently. `toBlocked` is the one target where the caller does NOT:
 * a workflow with no blocked status cannot be made to have one, and the card blocks
 * locally instead of the drag being refused.
 */
export function pickTransition(
  transitions: JiraTransition[],
  target: JiraTransitionTarget,
  settings: TransitionSettings,
): TransitionChoice | null {
  const wantColumn = TARGET_COLUMN[target];
  const resolve = (t: JiraTransition) =>
    resolveStatusColumn(
      t.to.name,
      categoryFromKey(t.to.statusCategory.key),
      settings.statusCategoryOverrides,
      settings.learnedStatusColumns,
    );

  const override = settings[NAME_OVERRIDE[target]];
  if (typeof override === 'string' && override) {
    const byName = transitions.find((t) => t.name.toLowerCase() === override.toLowerCase());
    if (byName) {
      // Reported, never refused. The name box is the escape hatch for a workflow whose
      // statuses we cannot read, so a destination that disagrees with the target column
      // may well be exactly what the user meant — but it is also how a typo goes
      // unnoticed for months, so the caller is told and says so out loud.
      const destinationColumn = resolve(byName).column;
      return {
        transition: byName,
        via: 'name',
        destinationColumn,
        mismatch: destinationColumn !== wantColumn,
      };
    }
  }

  const wantName = TARGET_LABEL[target].trim().toLowerCase();
  for (const tier of STATUS_REASONS) {
    const matches = transitions.filter((t) => {
      const resolved = resolve(t);
      return resolved.reason === tier && resolved.column === wantColumn;
    });
    if (!matches.length) continue;
    const named = matches.find((t) => t.to.name.trim().toLowerCase() === wantName);
    return {
      transition: named ?? matches[0],
      via: tier,
      destinationColumn: wantColumn,
      mismatch: false,
    };
  }
  return null;
}

/**
 * Whether a drag has taught us something worth writing into the learned status map.
 *
 * Lives here, next to the picker, rather than inline in the IPC handler that used to
 * hold it: it is a pure decision about JIRA statuses, and inline in `ipc.ts` it could
 * not be tested at all.
 *
 * Three of the four conditions came straight from there — a blank name says nothing, a
 * status the user mapped in Settings outranks anything we could infer, and a status that
 * already resolves to this column needs no entry (which is why the reported bug never
 * poisoned the map for people whose "Blocked" already read as blocked).
 *
 * The fourth is new. A blocked-ish destination is the one the picker can most easily
 * reach by accident, and the map is not a private cache — `StatusMapViewer` shows it to
 * the user as a list of facts the app has learned. "Blocked means IN REVIEW" is not a
 * fact; it is the app repeating its own mistake back at the person who has to correct it.
 * They can still say so explicitly, and `statusCategoryOverrides` still wins.
 */
export function shouldLearnStatus(
  statusName: string,
  category: JiraStatusCategory,
  column: BoardColumn,
  settings: TransitionSettings,
): boolean {
  const name = statusName.trim();
  if (!name) return false;
  if (isBlockedishStatus(name, category)) return false;
  const current = resolveStatusColumn(
    name,
    category,
    settings.statusCategoryOverrides,
    settings.learnedStatusColumns,
  );
  return current.reason !== 'explicit' && current.column !== column;
}
