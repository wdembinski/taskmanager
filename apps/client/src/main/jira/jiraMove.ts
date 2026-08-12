/**
 * Pure resolution of a drag-to-move on the board (Phase C): given a task and the
 * column it was dropped into, decide the new local status, whether to remember a
 * pre-block column, and whether the linked JIRA issue must be transitioned.
 *
 * The rules encode the product decisions:
 *   - EVERY column move transitions the linked issue, BLOCKED and TO DO included: the board
 *     is a view of the ticket, so a column that disagrees with the tracker is a board that
 *     lies. (Moving a card back to TO DO used to be local-only, on a "we don't reopen
 *     tickets" rule that made dragging a card leftwards silently meaningless.)
 *   - BLOCKED was the last column exempt from that, on the rule that no tracker status
 *     stands behind it. Workflows say otherwise — they have a Blocked status, the board now
 *     READS it (`isBlockedishStatus`), and a column that a sync can put a card into but a
 *     drag cannot must mean two different things depending on which side moved it. So a
 *     drop into BLOCKED transitions too, and `preBlockStatus` is still recorded: whether it
 *     is worth REMEMBERING depends on whether the transition happened, which only the caller
 *     that attempts it knows. See `ipc.ts`.
 *   - BLOCKED is also the one target a workflow is allowed not to have. A workflow with no
 *     blocked status cannot express the concept, and the card must still block locally —
 *     again the caller's decision, not this resolver's.
 *   - Internal (non-JIRA) tasks never transition anything.
 */
import type { BoardColumn, JiraStatusCategory, Task, TaskStatus } from '@shared/model';
import { categoryFromKey, columnForTask, restingStatus, statusForColumn } from '@shared/board';
import {
  STATUS_REASONS,
  isBlockedishStatus,
  resolveStatusColumn,
  type StatusReason,
} from '@shared/statusResolve';
import type { JiraTransition } from './jiraClient';
import type { JiraSettings } from '@shared/settings';

export type JiraTransitionTarget =
  'toTodo' | 'toInProgress' | 'toInReview' | 'toDone' | 'toBlocked';

export interface MoveResolution {
  /** The task's new local status. */
  localStatus: TaskStatus;
  /**
   * The column to restore on un-block (set only when moving into Blocked), else null.
   *
   * A *candidate*: the caller keeps it only when the block stayed local. A block the
   * tracker took is the tracker's to undo, and remembering a column for it would have the
   * app restore one status while the next sync asserts another.
   */
  preBlockStatus: TaskStatus | null;
  /** The JIRA transition to apply, or null when JIRA must not be touched. */
  jiraTransition: JiraTransitionTarget | null;
  /** True when nothing changes (dropped back into the same column). */
  noop: boolean;
}

/** Decide the effect of dropping `task` into `toColumn`. Pure. */
export function resolveMove(task: Task, toColumn: BoardColumn): MoveResolution {
  const from = columnForTask(task);
  // JIRA in particular, not "any external tracker": what this decides is whether a JIRA
  // TRANSITION is applied, and a GitHub issue has no workflow to transition. A GitHub card
  // takes the same `localStatus` from the same rules below and simply carries no transition
  // — its own write-back is a different act on a different API and belongs in its own
  // resolver, not in a branch of this one.
  const isJira = task.externalSource === 'jira';

  if (toColumn === from) {
    return {
      localStatus: restingStatus(task),
      preBlockStatus: task.preBlockStatus ?? null,
      jiraTransition: null,
      noop: true,
    };
  }

  // Into Blocked: block the ticket too, and offer where it came from as the column to
  // restore. Where it came FROM is where the card rests — a card whose agent is mid-run is
  // not "coming from" the run, and un-blocking must not restore it to a run state.
  if (toColumn === 'blocked') {
    return {
      localStatus: 'blocked',
      preBlockStatus: restingStatus(task),
      jiraTransition: isJira ? 'toBlocked' : null,
      noop: false,
    };
  }

  // Out of Blocked, or a plain column move.
  const localStatus = statusForColumn(toColumn);
  let jiraTransition: JiraTransitionTarget | null = null;
  if (isJira) {
    if (toColumn === 'todo') jiraTransition = 'toTodo';
    else if (toColumn === 'in-progress') jiraTransition = 'toInProgress';
    else if (toColumn === 'in-review') jiraTransition = 'toInReview';
    else if (toColumn === 'done') jiraTransition = 'toDone';
  }
  return { localStatus, preBlockStatus: null, jiraTransition, noop: false };
}

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
