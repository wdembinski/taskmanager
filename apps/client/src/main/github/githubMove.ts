/**
 * Pure resolution of a drag-to-move for a card mirrored from a GitHub issue: what the issue
 * has to be made to say, in labels and in open/closed, so that the next poll agrees with the
 * column the human just dropped the card in.
 *
 * `jira/jiraMove.ts`, one forge over, and split the same way for the same reason: one function
 * decides what the drop MEANS ({@link resolveMove}), and a second decides how to SAY it once
 * the forge has told us what is currently on the issue ({@link planLabelChange}) — the exact
 * shape of `resolveMove` + `pickTransition`, because the second decision cannot be made
 * without an answer from the API and the first must be testable without one.
 *
 * **The local half is not re-decided here.** `resolveMove` below delegates it to
 * `jira/jiraMove`'s resolver, which has never been JIRA-specific in that half — where a card
 * rests, what un-blocking restores, and which drop is a no-op are board rules. Copying those
 * fifteen lines is exactly how two forges' drags come to mean two different things, so they
 * are called rather than copied; only the "which issue write does this need" half is new.
 *
 * **What GitHub can and cannot be told.** An issue is open or closed and it wears labels, and
 * that is the whole vocabulary. TO DO and DONE are the two columns the state itself says, so
 * a drop into either is always expressible: DONE closes the issue and any move out of DONE
 * reopens it. IN PROGRESS and IN REVIEW have no state at all behind them — they are a
 * convention the repository invented, always a label — so a drag into one is only meaningful
 * if some label means it. When none does, the move is REFUSED rather than applied locally:
 * the card would otherwise sit in a column the issue never entered, and the very next sync
 * (`resolveGitHubColumn`, which reads open + no mapped label as TO DO) would drag it back out
 * again. A silent undo two minutes later is worse than an error that names the fix.
 *
 * **BLOCKED is the exception**, and the same one `JiraSettings.blockedTransitionName`
 * documents: no forge is obliged to have a way of saying "this is stuck", and "GitHub cannot
 * express it" is not a reason to refuse a human marking a card stuck. So a BLOCKED drop with
 * no label behind it blocks LOCALLY — nothing is written, `preBlockStatus` remembers the
 * column to restore, and `githubIssueSync.issueToTask` preserves that block across every poll.
 */
import type { BoardColumn, Task, TaskStatus } from '@shared/model';
import { lookupStatusColumn } from '@shared/board';
import { columnFromLabelName, resolveGitHubColumn } from '@shared/statusResolve';
import type { GitHubSettings } from '@shared/settings';
import { resolveMove as resolveLocalMove } from '../jira/jiraMove';

/** The two maps every decision in this file consults, in that order of authority. */
export type LabelSettings = Pick<GitHubSettings, 'labelColumnOverrides' | 'learnedLabelColumns'>;

export interface GitHubMoveResolution {
  /** The task's new local status. */
  localStatus: TaskStatus;
  /**
   * The column to restore on un-block (set only when moving into Blocked), else null.
   *
   * A *candidate*, exactly as in `jiraMove.MoveResolution`: the caller keeps it only when the
   * block stayed local. A block GitHub is holding (a label that says so) is GitHub's to undo.
   */
  preBlockStatus: TaskStatus | null;
  /** The column the ISSUE must be made to say, or null when GitHub must not be touched. */
  target: BoardColumn | null;
  /** True when nothing changes (dropped back into the same column). */
  noop: boolean;
}

/** Decide the effect of dropping `task` into `toColumn`. Pure. */
export function resolveMove(task: Task, toColumn: BoardColumn): GitHubMoveResolution {
  const local = resolveLocalMove(task, toColumn);
  // A card with no issue behind it has nothing to write — an internal card, or a GitHub card
  // whose key we somehow lost. Both move locally and say nothing to any forge.
  const mirrored = task.externalSource === 'github' && !!task.externalKey;
  return {
    localStatus: local.localStatus,
    preBlockStatus: local.preBlockStatus,
    target: !local.noop && mirrored ? toColumn : null,
    noop: local.noop,
  };
}

/**
 * The column a label is DECLARED to mean — by the user's map, or by the one the app taught
 * itself. Null when nobody has said, whatever the name may look like.
 *
 * The name tier is absent on purpose, and this is the one asymmetry in the file: what a
 * declared column is used for is deciding which labels to **delete** off the issue, and a
 * label nobody mapped is somebody else's data. "Awaiting triage" reads as blocked to
 * {@link columnFromLabelName} and may well be a triage rota nobody wants a drag to strip.
 * A guess is good enough to ADD a meaning; it is not good enough to remove a label.
 */
function declaredColumn(label: string, settings: LabelSettings): BoardColumn | null {
  const explicit = lookupStatusColumn(label, settings.labelColumnOverrides);
  if (explicit) return explicit;
  const remembered = lookupStatusColumn(label, settings.learnedLabelColumns);
  // The poisoned-entry refusal, straight out of `resolveStatusColumn` and load-bearing for the
  // same reason: the learned map is written by a drag that "succeeded", so a bug in the picker
  // is remembered as a fact. A map the APP wrote may never speak for a name that says blocked;
  // a map the HUMAN wrote (above) always may.
  if (remembered && columnFromLabelName(label) !== 'blocked') return remembered;
  return null;
}

/** The first label a map assigns to `column`, preferring one already on the issue. */
function labelFor(
  map: Record<string, BoardColumn> | undefined,
  column: BoardColumn,
  present: readonly string[],
  refuseBlockedNames: boolean,
): string | null {
  const usable = (label: string): boolean =>
    !refuseBlockedNames || columnFromLabelName(label) !== 'blocked';
  // Already there ⇒ nothing to POST, and no second label saying what one already says.
  const already = present.find((l) => usable(l) && lookupStatusColumn(l, map) === column);
  if (already) return already;
  for (const [name, mapped] of Object.entries(map ?? {})) {
    if (mapped === column && name.trim() && usable(name)) return name.trim();
  }
  return null;
}

/** Which label will speak for `target` after the move, or null when none can. */
function pickColumnLabel(
  present: readonly string[],
  target: BoardColumn,
  settings: LabelSettings,
): string | null {
  return (
    labelFor(settings.labelColumnOverrides, target, present, false) ??
    labelFor(settings.learnedLabelColumns, target, present, true) ??
    present.find((l) => columnFromLabelName(l) === target) ??
    null
  );
}

/** Case-insensitive label equality — the same matching every map in this app uses. */
function sameLabel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The writes one move needs, in the order the caller must make them. */
export interface LabelChange {
  /** The state to PATCH the issue to, or null when it already says the right thing. */
  state: 'open' | 'closed' | null;
  /** The label to POST onto the issue, or null when none is needed. */
  addLabel: string | null;
  /** The labels to DELETE — the ones a map declares for some OTHER column. */
  removeLabels: string[];
  /**
   * The label that speaks for the target column afterwards, or null when the state alone does
   * (TO DO and DONE). What {@link shouldLearnLabel} is asked about.
   */
  columnLabel: string | null;
  /** The issue's labels once these writes land — what the next poll will resolve. */
  labelsAfter: string[];
  /** The issue's state once these writes land. */
  stateAfter: 'open' | 'closed';
}

/**
 * How to say `target` on an issue that currently has `labels` and is in `state`, or **null
 * when GitHub cannot be made to say it** — see this file's header for which columns those are
 * and why a null is refused rather than applied locally.
 *
 * The label that will speak for the target is chosen in tiers, exactly like `pickTransition`:
 * the user's map, then the map the app taught itself, then a label already on the issue whose
 * NAME reads as that column. Within the first two, a mapped label already on the issue is
 * preferred over one that would have to be added — a second label saying what one already says
 * is noise on somebody's issue.
 */
export function planLabelChange(
  labels: readonly string[],
  state: string,
  target: BoardColumn,
  settings: LabelSettings,
): LabelChange | null {
  const present = labels.map((l) => l.trim()).filter((l) => l.length > 0);
  // Anything that is not literally `open` is closed — `resolveGitHubColumn`'s own reading, so
  // that a state neither of us has heard of does not produce a needless PATCH here and a
  // different answer there.
  const current: 'open' | 'closed' = state === 'open' ? 'open' : 'closed';
  const stateAfter: 'open' | 'closed' = target === 'done' ? 'closed' : 'open';

  // TO DO and DONE are said by the state itself; a label for them would be noise the resolver
  // never even consults (closed beats every label, and open with nothing mapped is TO DO).
  const needsLabel = target !== 'todo' && target !== 'done';
  const columnLabel = needsLabel ? pickColumnLabel(present, target, settings) : null;
  if (needsLabel && !columnLabel) return null;

  const removeLabels = present.filter((l) => {
    if (columnLabel && sameLabel(l, columnLabel)) return false;
    const declared = declaredColumn(l, settings);
    return declared !== null && declared !== target;
  });
  const addLabel =
    columnLabel && !present.some((l) => sameLabel(l, columnLabel)) ? columnLabel : null;
  const kept = present.filter((l) => !removeLabels.some((r) => sameLabel(r, l)));
  return {
    state: current === stateAfter ? null : stateAfter,
    addLabel,
    removeLabels,
    columnLabel,
    labelsAfter: addLabel ? [...kept, addLabel] : kept,
    stateAfter,
  };
}

/**
 * Whether a drag has taught us something worth writing into `learnedLabelColumns`.
 *
 * `jiraMove.shouldLearnStatus`, gated on the same four conditions and for the same reasons: a
 * blank name says nothing; a label the user mapped in Settings outranks anything we could
 * infer; a label that already resolves to this column needs no entry; and a name that reads as
 * BLOCKED is never learned, because the map is shown to the user as a list of facts the app
 * believes and "blocked means IN REVIEW" is not a fact — it is the app repeating its own
 * mistake back at the person who has to correct it. They can still say so explicitly, and
 * `labelColumnOverrides` still wins.
 *
 * In practice this fires for exactly one tier: a label matched by NAME. The other two came out
 * of a map, so by construction they already resolve where the drag was going.
 */
export function shouldLearnLabel(
  label: string,
  column: BoardColumn,
  settings: LabelSettings,
): boolean {
  const name = label.trim();
  if (!name) return false;
  if (columnFromLabelName(name) === 'blocked') return false;
  // Asked of an OPEN issue, because that is the only state in which a label decides anything.
  const current = resolveGitHubColumn(
    [name],
    'open',
    settings.labelColumnOverrides,
    settings.learnedLabelColumns,
  );
  return current.reason !== 'explicit' && current.column !== column;
}
