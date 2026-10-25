/**
 * The pure half of `IssueRow`: which optional parts a row draws, decided once so the
 * component itself only draws them. The same split `assigneeParts.ts` already keeps
 * beside `AssigneeDisplay`.
 *
 * Deliberately knows nothing about WHICH task's subtasks, merge requests or live-run ids
 * these are — `IssueRowContext` carries exactly the slices `runPhase` and the `mr` rule
 * below need, already scoped to this row's task by the caller. No store, no IPC channel,
 * no other task's data.
 */
import type { Person, Task } from '@tm/shared/model';
import { columnForTask, runPhase, type RunState } from '@tm/shared/board';
import { mrRef, type MergeRequest } from '@tm/shared/mergeRequest';
import type { BoardColumn } from '@tm/shared/model';
import { assigneeDisplayParts, type AssigneeDisplayParts } from '../projects/assigneeParts';

export interface IssueRowContext {
  /** Epoch ms "now" — injected rather than read from `Date.now()` so due-date flagging
   *  (and "Today" vs. a plain date) is testable. */
  now: number;
  /** This task's own steps (Phase 11), already scoped to it by the caller. See `runPhase`. */
  subtasks?: Task[];
  /** `scheduler:activeRuns`, already scoped. See `runPhase`. */
  liveRunTaskIds?: ReadonlySet<string>;
  /** `scheduler:integrating`, already scoped. See `runPhase`. */
  mergingTaskIds?: ReadonlySet<string>;
  /** This task's own merge requests, already scoped — `issueRowParts` does not re-run the
   *  key/branch matching a forge reconciler does. */
  mergeRequests?: MergeRequest[];
  /** The ticket's resolved human assignee, or undefined for none. */
  assignee?: Pick<Person, 'name' | 'initials' | 'color'>;
  /** The delegated agent's name, already decided meaningful by the caller (see
   *  `delegatedAgentName`) — this module does not re-derive that. */
  agentName?: string;
}

export interface IssueRowParts {
  /** `ticketKey` for a native ticket, `externalKey` for a mirrored issue, else `''`. */
  key: string;
  column: BoardColumn;
  title: string;
  /** The run pill — present only while something is actually moving (`runPhase().spinner`). */
  run?: { label: string };
  /** The MR/PR reference — the first open one, else the first merged one. */
  mr?: { ref: string; url: string };
  due?: { label: string; flagged: boolean };
  avatar?: AssigneeDisplayParts;
}

/**
 * `run`'s label, computed rather than read off `runPhase`'s own `label` string: that
 * string is prose for a different reader ("Running step 2 of 5", "Paused — usage limit
 * (step 3 of 5)"), not the row's "Step 2 of 4". Pulls `n`/`m` out of it instead of
 * re-walking `subtasks` with a second copy of `runPhase`'s own (private) TERMINAL predicate.
 *
 * Exported for `cardParts.ts` (the board card's own pure parts) to reuse rather than copy —
 * the board's run row wants exactly this short form, not `runPhase`'s own prose.
 */
export function runLabel(phase: RunState): string {
  if (phase.phase === 'merging') return 'Merging';
  const stepMatch = /step (\d+) of (\d+)/i.exec(phase.label);
  if (stepMatch) return `Step ${stepMatch[1]} of ${stepMatch[2]}`;
  return phase.phase === 'starting' ? 'Starting' : 'Running';
}

/** The row's one MR/PR, trusting `mergeRequests` as already scoped to this task: the
 *  first `opened` one, else the first `merged` one. `closed`/`locked` are never chosen.
 *
 *  Exported for `cardParts.ts` to reuse — the board card picks its one MR/PR the same way. */
export function pickMergeRequest(
  mergeRequests: MergeRequest[] | undefined,
): MergeRequest | undefined {
  if (!mergeRequests?.length) return undefined;
  return (
    mergeRequests.find((mr) => mr.state === 'opened') ??
    mergeRequests.find((mr) => mr.state === 'merged')
  );
}

function floorToLocalMidnight(epochMs: number): number {
  const d = new Date(epochMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Flagged when the due day's local-midnight floor is on or before today's, except on a
 * `done` ticket — finished work is never overdue, however old its `dueAt`. Labelled
 * `'Today'` exactly when the two floors are equal, otherwise a short calendar date —
 * including on a flagged, past day (an overdue ticket reads e.g. "Oct 10", not "Today").
 *
 * Exported for `cardParts.ts` to reuse — the board card's footer due date is the same rule.
 */
export function dueParts(
  task: Pick<Task, 'dueAt' | 'status' | 'preRunStatus'>,
  now: number,
): { label: string; flagged: boolean } | undefined {
  if (task.dueAt == null) return undefined;
  const dueDay = floorToLocalMidnight(task.dueAt);
  const today = floorToLocalMidnight(now);
  const flagged = columnForTask(task) !== 'done' && dueDay <= today;
  const label =
    dueDay === today
      ? 'Today'
      : new Date(task.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return { label, flagged };
}

/** The longest key the default 52px key column holds without overflowing. */
export const KEY_COLUMN_FIT = 6;

/**
 * The key column's width for a list showing `keys`: today's `52px` while every key fits it,
 * else wide enough for the longest one (`ch` is exact — the key is monospace) so a key like
 * `FX-sb-7-a` never wraps and every row's title still starts in one column. A list sets it
 * as `--tm-key-width`; `IssueRow` falls back to 52px where nothing sets it.
 */
export function keyColumnWidth(keys: readonly string[]): string {
  const longest = keys.reduce((n, key) => Math.max(n, key.length), 0);
  return longest <= KEY_COLUMN_FIT ? '52px' : `calc(${longest}ch + 4px)`;
}

/** A list's tickets and merge requests, indexed once so each row reads its own slice. */
export interface IssueRowIndex {
  /** parent id → its steps (`parentTaskId`), in list order. */
  subtasksByParent: ReadonlyMap<string, Task[]>;
  /** task id → its merge requests. An MR with no `taskId` is an orphan and dropped. */
  mergeRequestsByTask: ReadonlyMap<string, MergeRequest[]>;
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string | null | undefined) {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}

/**
 * The board's own scoping (`MyTasks.tsx`'s subtasks filter and `mrsByTask`), built once per
 * list rather than per row, so a list can hand `IssueRowContext` the same `subtasks` and
 * `mergeRequests` a card gets.
 */
export function indexIssueRows(
  tickets: readonly Task[],
  mergeRequests: readonly MergeRequest[],
): IssueRowIndex {
  return {
    subtasksByParent: groupBy(tickets, (t) => t.parentTaskId),
    mergeRequestsByTask: groupBy(mergeRequests, (mr) => mr.taskId),
  };
}

/**
 * Which optional parts this row draws. Priority and `issueType` never produce a part —
 * neither is read here at all.
 */
export function issueRowParts(task: Task, ctx: IssueRowContext): IssueRowParts {
  const phase = runPhase(task, ctx.subtasks ?? [], ctx.liveRunTaskIds, ctx.mergingTaskIds);
  const mr = pickMergeRequest(ctx.mergeRequests);
  return {
    key: task.ticketKey ?? task.externalKey ?? '',
    column: columnForTask(task),
    title: task.title,
    run: phase.spinner ? { label: runLabel(phase) } : undefined,
    mr: mr ? { ref: mrRef(mr), url: mr.webUrl } : undefined,
    due: dueParts(task, ctx.now),
    avatar: assigneeDisplayParts(ctx.assignee, ctx.agentName) ?? undefined,
  };
}
