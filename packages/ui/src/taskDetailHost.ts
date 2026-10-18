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
 * otherwise redo), plus the id of the task to show.
 */
export type TaskDetailHostProps = Omit<TaskDetailProps, 'task'> & {
  taskId: string | null;
  task?: Task | null;
};

/**
 * The raw lists the host MAY load, each optional — present only once its own read has
 * answered. `attentionItems` is the flat list `buildAttentionIndex` takes, not the index
 * itself, so `assembleTaskDetailProps` builds it the same way every other caller does.
 */
export interface LoadedTaskDetailData {
  tasks?: readonly Task[];
  mergeRequests?: readonly MergeRequest[];
  attachments?: readonly TaskAttachment[];
  chainLinks?: readonly TaskLink[];
  attentionItems?: readonly AttentionItem[];
  liveRunTaskIds?: ReadonlySet<string>;
  mergingTaskIds?: ReadonlySet<string>;
}

/** One of the host's own reads — see {@link neededLoads}. */
export type HostLoad =
  'tasks' | 'mergeRequests' | 'attachments' | 'chainLinks' | 'attention' | 'liveRuns' | 'merging';

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
    provided.parentTask === undefined ||
    provided.chainTasksById === undefined
  ) {
    loads.add('tasks');
  }
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

/** A card's siblings (or its own steps, for an ordinary card), in chain order. */
function subtasksOf(tasksById: ReadonlyMap<string, Task>, task: Task | null): Task[] {
  if (!task) return [];
  const parentId = task.parentTaskId ?? task.id;
  return [...tasksById.values()]
    .filter((t) => t.parentTaskId === parentId)
    .sort((a, b) => a.order - b.order);
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

  const tasksById = providedChainTasksById ?? new Map((loaded.tasks ?? []).map((t) => [t.id, t]));

  const task =
    providedTask !== undefined ? providedTask : taskId ? (tasksById.get(taskId) ?? null) : null;

  const subtasks = providedSubtasks !== undefined ? providedSubtasks : subtasksOf(tasksById, task);

  const parentTask =
    providedParentTask !== undefined
      ? providedParentTask
      : task?.parentTaskId
        ? (tasksById.get(task.parentTaskId) ?? null)
        : null;

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
