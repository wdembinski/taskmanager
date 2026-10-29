/**
 * The pure half of `TaskDetailHost` (`./TaskDetailHostView.tsx`) — what it loads and how it
 * builds `TaskDetail`'s props from whatever the caller already holds plus whatever it had
 * to fetch. No React here, same split `chainStates.ts` and `attentionIndex.ts` already use,
 * so the caller-wins contract below is unit-tested on its own.
 *
 * See `docs/plan/feature-roadmap/F12-one-task-panel.md`'s F12.7 entry for the design this
 * implements.
 */
import type { Task } from '@tm/shared/model';
import type { TaskBundle, TaskSummary } from '@tm/shared/taskSummary';
import type { MergeRequest } from '@tm/shared/mergeRequest';
import type { TaskAttachment } from '@tm/shared/attachments';
import type { TaskLink } from '@tm/shared/taskChain';
import type { AttentionItem } from '@tm/shared/attention';
import { buildAttentionIndex } from './attentionIndex';
import { chainStates } from './board/chainStates';
import type { TaskDetailProps } from './TaskDetail';

/**
 * Every prop `TaskDetailHost` takes: whatever `TaskDetail` takes, minus `task` (optional
 * here — a caller that already holds the row passes it and skips a lookup the host would
 * otherwise redo), plus the id of the task to show. Pass-through props such as `layout`
 * (the full-screen issue page) reach `TaskDetail` untouched via `assembleTaskDetailProps`'
 * `rest`.
 */
export type TaskDetailHostProps = Omit<TaskDetailProps, 'task'> & {
  taskId: string | null;
  task?: Task | null;
};

/**
 * The open card in full (F29.2): the card, its parent when it is a step, and the steps the
 * pane lists — its own, or for a step its siblings (its parent's). Built from `task:get`
 * answers by {@link openTaskOf}; a list holds summaries only, so this is the one place the
 * heavy text comes from.
 */
export interface OpenTask {
  task: Task;
  parent: Task | null;
  subtasks: Task[];
}

/**
 * The open card from its own `task:get` answer and, for a step, its parent's — whose steps
 * are the step's siblings, the list the pane counts "Step 2 of 5" in.
 */
export function openTaskOf(own: TaskBundle, parentBundle: TaskBundle | null): OpenTask {
  return {
    task: own.task,
    parent: own.parent,
    subtasks: own.task.parentTaskId ? (parentBundle?.steps ?? []) : own.steps,
  };
}

/**
 * Whether a change touches the open card, so its `task:get` must be re-read: the card
 * itself, its parent, one of the steps it lists, or a new step under the card (or under
 * its parent, for a step). Anything else on the board leaves the open card as it is.
 */
export function touchesOpenTask(
  open: OpenTask | undefined,
  taskId: string,
  changed: readonly Pick<TaskSummary, 'id' | 'parentTaskId'>[],
  removed: readonly string[] = [],
): boolean {
  const ids = new Set([taskId]);
  if (open) {
    if (open.parent) ids.add(open.parent.id);
    if (open.task.parentTaskId) ids.add(open.task.parentTaskId);
    for (const step of open.subtasks) ids.add(step.id);
  }
  const familyRoot = open?.task.parentTaskId ?? taskId;
  return (
    changed.some((t) => ids.has(t.id) || t.parentTaskId === familyRoot) ||
    removed.some((id) => ids.has(id))
  );
}

/**
 * The raw lists the host MAY load, each optional — present only once its own read has
 * answered. `attentionItems` is the flat list `buildAttentionIndex` takes, not the index
 * itself, so `assembleTaskDetailProps` builds it the same way every other caller does.
 */
export interface LoadedTaskDetailData {
  /** The open card through `task:get` — used only while it is the card `taskId` names. */
  openTask?: OpenTask;
  /** Every board's card summaries — the chain index's rows, never the open card's own. */
  summaries?: readonly TaskSummary[];
  mergeRequests?: readonly MergeRequest[];
  attachments?: readonly TaskAttachment[];
  chainLinks?: readonly TaskLink[];
  attentionItems?: readonly AttentionItem[];
  liveRunTaskIds?: ReadonlySet<string>;
  mergingTaskIds?: ReadonlySet<string>;
}

/** One of the host's own reads — see {@link neededLoads}. */
export type HostLoad =
  | 'task'
  | 'chainTasks'
  | 'mergeRequests'
  | 'attachments'
  | 'chainLinks'
  | 'attention'
  | 'liveRuns'
  | 'merging';

/**
 * Which reads the host still has to make, given what the caller already supplied.
 *
 * Decided from whether the props each read feeds are `undefined` — never from whether they
 * are empty, since an empty array or an empty `Set` is a legitimate caller answer ("no merge
 * requests", "nothing live") that must not be refetched.
 */
export function neededLoads(provided: TaskDetailHostProps): ReadonlySet<HostLoad> {
  const loads = new Set<HostLoad>();
  if (
    provided.task === undefined ||
    provided.subtasks === undefined ||
    provided.parentTask === undefined
  ) {
    loads.add('task');
  }
  if (provided.chainTasksById === undefined) loads.add('chainTasks');
  if (provided.mergeRequests === undefined) loads.add('mergeRequests');
  if (
    provided.attachments === undefined ||
    provided.parentAttachments === undefined ||
    provided.subtaskAttachments === undefined
  ) {
    loads.add('attachments');
  }
  if (provided.chainLinks === undefined) loads.add('chainLinks');
  if (provided.attention === undefined) loads.add('attention');
  if (provided.liveRunTaskIds === undefined) loads.add('liveRuns');
  if (provided.mergingTaskIds === undefined) loads.add('merging');
  return loads;
}

/** Index rows by the task they hang off — the shape both panes want. */
export function byTask<T extends { taskId: string }>(rows: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.taskId);
    if (list) list.push(row);
    else map.set(row.taskId, [row]);
  }
  return map;
}

/** The merge requests a card owns, keyed the way every board keys them. */
export function mergeRequestsByTask(rows: readonly MergeRequest[]): Map<string, MergeRequest[]> {
  const map = new Map<string, MergeRequest[]>();
  for (const mr of rows) {
    if (!mr.taskId) continue;
    const list = map.get(mr.taskId);
    if (list) list.push(mr);
    else map.set(mr.taskId, [mr]);
  }
  return map;
}

/**
 * Build `TaskDetail`'s props for `taskId`, from whatever the caller already supplied plus
 * whatever the host loaded for it.
 *
 * The caller's own value wins whenever it is not `undefined`, and only then does this
 * derive the field from `loaded`. Derived fields are computed from the MERGED inputs — the
 * caller's own `chainTasksById`/`chainLinks`/`liveRunTaskIds` when given, the loaded ones
 * otherwise — so a derived value can never disagree with one the caller already supplied.
 */
export function assembleTaskDetailProps(
  taskId: string | null,
  provided: TaskDetailHostProps,
  loaded: LoadedTaskDetailData,
): TaskDetailProps {
  const {
    taskId: _taskId,
    task: providedTask,
    subtasks: providedSubtasks,
    parentTask: providedParentTask,
    mergeRequests: providedMergeRequests,
    attachments: providedAttachments,
    parentAttachments: providedParentAttachments,
    subtaskAttachments: providedSubtaskAttachments,
    chainLinks: providedChainLinks,
    chainTasksById: providedChainTasksById,
    attention: providedAttention,
    liveRunTaskIds: providedLiveRunTaskIds,
    mergingTaskIds: providedMergingTaskIds,
    chainWaitingOn: providedChainWaitingOn,
    chainMergeHeld: providedChainMergeHeld,
    ...rest
  } = provided;

  const tasksById: ReadonlyMap<string, TaskSummary> =
    providedChainTasksById ?? new Map((loaded.summaries ?? []).map((t) => [t.id, t]));

  // A `task:get` answer for a card that is no longer the one shown is never drawn.
  const open = taskId && loaded.openTask?.task.id === taskId ? loaded.openTask : undefined;

  const task = providedTask !== undefined ? providedTask : (open?.task ?? null);

  const subtasks = providedSubtasks !== undefined ? providedSubtasks : (open?.subtasks ?? []);

  const parentTask = providedParentTask !== undefined ? providedParentTask : (open?.parent ?? null);

  const mergeRequests =
    providedMergeRequests !== undefined
      ? providedMergeRequests
      : taskId
        ? (mergeRequestsByTask(loaded.mergeRequests ?? []).get(taskId) ?? [])
        : [];

  const attachmentsByTask = byTask(loaded.attachments ?? []);

  const attachments =
    providedAttachments !== undefined
      ? providedAttachments
      : taskId
        ? (attachmentsByTask.get(taskId) ?? [])
        : [];

  const parentAttachments =
    providedParentAttachments !== undefined
      ? providedParentAttachments
      : parentTask
        ? (attachmentsByTask.get(parentTask.id) ?? [])
        : [];

  const subtaskAttachments =
    providedSubtaskAttachments !== undefined
      ? providedSubtaskAttachments
      : subtasks.flatMap((s) => attachmentsByTask.get(s.id) ?? []);

  const chainLinks =
    providedChainLinks !== undefined ? providedChainLinks : (loaded.chainLinks ?? []);

  const chainTasksById = providedChainTasksById !== undefined ? providedChainTasksById : tasksById;

  const attention =
    providedAttention !== undefined
      ? providedAttention
      : buildAttentionIndex(loaded.attentionItems ?? []);

  const liveRunTaskIds =
    providedLiveRunTaskIds !== undefined
      ? providedLiveRunTaskIds
      : (loaded.liveRunTaskIds ?? new Set());

  const mergingTaskIds =
    providedMergingTaskIds !== undefined
      ? providedMergingTaskIds
      : (loaded.mergingTaskIds ?? new Set());

  const ownChainState = taskId
    ? chainStates(chainLinks, chainTasksById, liveRunTaskIds).get(taskId)
    : undefined;

  const chainWaitingOn =
    providedChainWaitingOn !== undefined ? providedChainWaitingOn : ownChainState?.waitingOn;

  const chainMergeHeld =
    providedChainMergeHeld !== undefined ? providedChainMergeHeld : ownChainState?.mergeHeld;

  return {
    ...rest,
    task,
    subtasks,
    parentTask,
    mergeRequests,
    attachments,
    parentAttachments,
    subtaskAttachments,
    chainLinks,
    chainTasksById,
    attention,
    liveRunTaskIds,
    mergingTaskIds,
    chainWaitingOn,
    chainMergeHeld,
  };
}
