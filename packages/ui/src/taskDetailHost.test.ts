import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@tm/shared/model';
import type { MergeRequest } from '@tm/shared/mergeRequest';
import type { TaskAttachment } from '@tm/shared/attachments';
import type { TaskLink } from '@tm/shared/taskChain';
import type { AttentionItem } from '@tm/shared/attention';
import { buildAttentionIndex } from './attentionIndex';
import {
  assembleTaskDetailProps,
  neededLoads,
  type HostLoad,
  type LoadedTaskDetailData,
  type TaskDetailHostProps,
} from './taskDetailHost';

const task = (over: Partial<Task> & { id: string }): Task => ({
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: over.id,
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'adhoc',
  isContract: false,
  isScaffold: false,
  ...over,
});

const mr = (over: Partial<MergeRequest> & { id: string }): MergeRequest => ({
  taskId: null,
  openedForTaskId: null,
  provider: 'gitlab',
  repoId: 9,
  projectPath: 'acme/web',
  number: 1,
  title: 'fix the thing',
  displayName: null,
  webUrl: 'https://gitlab.com/acme/web/-/merge_requests/1',
  sourceBranch: 'feature/x',
  targetBranch: 'main',
  state: 'opened',
  draft: false,
  headSha: null,
  lastActedSha: null,
  lastActedAction: null,
  pipelineStatus: 'success',
  pipelineStages: [],
  pipelineUrl: null,
  approvalsRequired: null,
  approvalsGiven: 0,
  changesRequested: false,
  detailedMergeStatus: 'mergeable',
  hasConflicts: false,
  issueKeys: [],
  latestNoteAt: null,
  lastReadAt: null,
  lastEventAt: null,
  lastEventSeenAt: null,
  updatedAt: 100,
  syncedAt: 100,
  ...over,
});

const attachment = (id: string, taskId: string, name = `${id}.png`): TaskAttachment => ({
  id,
  taskId,
  name,
  fileName: name,
  mimeType: null,
  size: 3,
  createdAt: 0,
});

/** `a → b`: b runs after a, once a's branch has landed. */
const link = (from: string, to: string): TaskLink => ({
  id: `${from}->${to}`,
  fromTaskId: from,
  toTaskId: to,
  gate: 'after-merge',
  createdAt: 0,
});

let nextItemId = 0;
const attentionItem = (taskId: string): AttentionItem => {
  nextItemId += 1;
  return {
    id: `item-${nextItemId}`,
    runId: 'run-1',
    taskId,
    projectId: PERSONAL_PROJECT_ID,
    taskTitle: 'A task',
    kind: 'question',
    prompt: 'prompt',
    options: [],
    toolName: null,
    reason: null,
    createdAt: 0,
  };
};

const EMPTY_LOADED: LoadedTaskDetailData = {};

/** The exact prop set `MyTasks.tsx` passes to the host (`MyTasks.tsx:1553`). */
function myTasksProps(): TaskDetailHostProps {
  return {
    taskId: 'card-1',
    task: task({ id: 'card-1' }),
    agentProjects: [],
    boards: [],
    subtasks: [],
    parentTask: null,
    mergeRequests: [],
    people: [],
    milestones: [],
    labels: [],
    ticketLinks: [],
    afterMergePipeline: true,
    mrRebaseButton: true,
    mrMergeButton: true,
    quietAgentProgress: true,
    attachments: [],
    parentAttachments: [],
    subtaskAttachments: [],
    statusKeywords: [],
    priorityDisplay: 'color',
    attention: buildAttentionIndex([]),
    liveRunTaskIds: new Set(),
    mergingTaskIds: new Set(),
    chainWaitingOn: undefined,
    chainMergeHeld: undefined,
    chainLinks: [],
    chainTasksById: new Map(),
    onUnlinkChain: () => {},
    onOpenTask: () => {},
    onStatusChanged: () => {},
    onStatusSet: () => {},
    onSubtasksChanged: () => {},
    dictation: undefined,
  };
}

/** The exact prop set the web board's `taskDetailProps` + `task` passes (`BoardScreen.tsx:1036`). */
function webBoardProps(): TaskDetailHostProps {
  return {
    taskId: 'card-1',
    task: task({ id: 'card-1' }),
    agentProjects: [],
    boards: [],
    subtasks: [],
    parentTask: null,
    mergeRequests: [],
    afterMergePipeline: true,
    mrRebaseButton: true,
    mrMergeButton: true,
    quietAgentProgress: true,
    attachments: [],
    parentAttachments: [],
    subtaskAttachments: [],
    statusKeywords: [],
    priorityDisplay: 'color',
    attention: buildAttentionIndex([]),
    liveRunTaskIds: new Set(),
    mergingTaskIds: new Set(),
    chainWaitingOn: undefined,
    chainMergeHeld: undefined,
    chainLinks: [],
    chainTasksById: new Map(),
    people: [],
    milestones: [],
    labels: [],
    ticketLinks: [],
    onUnlinkChain: () => {},
  };
}

describe('neededLoads', () => {
  it('is empty for the exact prop set MyTasks passes — nothing is fetched twice', () => {
    expect(neededLoads(myTasksProps())).toEqual(new Set());
  });

  it('is empty for the exact prop set the web board passes — nothing is fetched twice', () => {
    expect(neededLoads(webBoardProps())).toEqual(new Set());
  });

  const cases: Array<[keyof TaskDetailHostProps, HostLoad]> = [
    ['task', 'tasks'],
    ['subtasks', 'tasks'],
    ['parentTask', 'tasks'],
    ['chainTasksById', 'tasks'],
    ['mergeRequests', 'mergeRequests'],
    ['attachments', 'attachments'],
    ['parentAttachments', 'attachments'],
    ['subtaskAttachments', 'attachments'],
    ['chainLinks', 'chainLinks'],
    ['attention', 'attention'],
    ['liveRunTaskIds', 'liveRuns'],
    ['mergingTaskIds', 'merging'],
  ];

  it.each(cases)('returns the specific read for a missing %s prop', (field, load) => {
    const props = { ...myTasksProps(), [field]: undefined };
    expect(neededLoads(props)).toEqual(new Set([load]));
  });
});

describe('assembleTaskDetailProps', () => {
  it('always lets a caller-supplied value win, even an empty/falsy one, over a loaded answer', () => {
    const providedTask = task({ id: 'card-1', title: 'provided title' });
    const provided: TaskDetailHostProps = {
      taskId: 'card-1',
      task: providedTask,
      subtasks: [],
      parentTask: null,
      mergeRequests: [],
      attachments: [],
      parentAttachments: [],
      subtaskAttachments: [],
      chainLinks: [],
      chainTasksById: new Map(),
      attention: buildAttentionIndex([]),
      liveRunTaskIds: new Set(),
      mergingTaskIds: new Set(),
      chainWaitingOn: [],
      chainMergeHeld: [],
    };

    // A fully different, non-empty answer for every one of the fields above — if any of
    // this leaked through, the assertions below would fail on something other than what
    // `provided` actually said.
    const loaded: LoadedTaskDetailData = {
      tasks: [
        task({ id: 'card-1', title: 'loaded title' }),
        task({ id: 'sibling', parentTaskId: 'card-1' }),
        task({ id: 'parent-x' }),
      ],
      mergeRequests: [mr({ id: 'mr-1', taskId: 'card-1' })],
      attachments: [attachment('a1', 'card-1')],
      chainLinks: [link('pred', 'card-1')],
      attentionItems: [attentionItem('card-1')],
      liveRunTaskIds: new Set(['card-1']),
      mergingTaskIds: new Set(['card-1']),
    };

    const result = assembleTaskDetailProps('card-1', provided, loaded);

    expect(result.task).toBe(providedTask);
    expect(result.subtasks).toBe(provided.subtasks);
    expect(result.parentTask).toBeNull();
    expect(result.mergeRequests).toBe(provided.mergeRequests);
    expect(result.attachments).toBe(provided.attachments);
    expect(result.parentAttachments).toBe(provided.parentAttachments);
    expect(result.subtaskAttachments).toBe(provided.subtaskAttachments);
    expect(result.chainLinks).toBe(provided.chainLinks);
    expect(result.chainTasksById).toBe(provided.chainTasksById);
    expect(result.attention).toBe(provided.attention);
    expect(result.liveRunTaskIds).toBe(provided.liveRunTaskIds);
    expect(result.mergingTaskIds).toBe(provided.mergingTaskIds);
    expect(result.chainWaitingOn).toBe(provided.chainWaitingOn);
    expect(result.chainMergeHeld).toBe(provided.chainMergeHeld);
  });

  it("passes the full-screen layout through untouched, and leaves it unset when it isn't given", () => {
    const loaded: LoadedTaskDetailData = { tasks: [task({ id: 'card-1' })] };

    expect(
      assembleTaskDetailProps('card-1', { taskId: 'card-1', layout: 'full' }, loaded).layout,
    ).toBe('full');
    expect(assembleTaskDetailProps('card-1', { taskId: 'card-1' }, loaded).layout).toBeUndefined();
  });

  it('lets an explicit null task win over a loaded row for the same id', () => {
    const provided: TaskDetailHostProps = { taskId: 'card-1', task: null };
    const loaded: LoadedTaskDetailData = { tasks: [task({ id: 'card-1' })] };

    expect(assembleTaskDetailProps('card-1', provided, loaded).task).toBeNull();
  });

  it('derives subtasks, parent, MR/attachment slices, the chain index and waiting-on from nothing but loaded data', () => {
    const parent = task({ id: 'parent', agentProjectId: 'repo' });
    const step1 = task({ id: 'step-1', parentTaskId: 'parent', order: 0 });
    const step2 = task({ id: 'step-2', parentTaskId: 'parent', order: 1, agentProjectId: 'repo' });
    const step3 = task({ id: 'step-3', parentTaskId: 'parent', order: 2 });
    // In review: its work is written but not yet merged — the same fixture
    // `chainStates.test.ts` uses to prove both `waitingOn` and `mergeHeld` at once.
    const pred = task({ id: 'pred', status: 'in-review', agentProjectId: 'repo' });

    const loaded: LoadedTaskDetailData = {
      tasks: [parent, step1, step2, step3, pred],
      mergeRequests: [mr({ id: 'mr-1', taskId: 'step-2' }), mr({ id: 'mr-2', taskId: 'other' })],
      attachments: [
        attachment('a1', 'step-2'),
        attachment('a2', 'parent'),
        attachment('a3', 'other'),
      ],
      chainLinks: [link('pred', 'step-2')],
    };

    const provided: TaskDetailHostProps = { taskId: 'step-2' };
    const result = assembleTaskDetailProps('step-2', provided, loaded);

    expect(result.task?.id).toBe('step-2');
    expect(result.subtasks?.map((t) => t.id)).toEqual(['step-1', 'step-2', 'step-3']);
    expect(result.parentTask?.id).toBe('parent');
    expect(result.mergeRequests?.map((m) => m.id)).toEqual(['mr-1']);
    expect(result.attachments?.map((a) => a.id)).toEqual(['a1']);
    expect(result.parentAttachments?.map((a) => a.id)).toEqual(['a2']);
    // Flat over every sibling (`step-1`, `step-2`, `step-3`) — only `step-2` owns one.
    expect(result.subtaskAttachments?.map((a) => a.id)).toEqual(['a1']);
    expect(result.chainTasksById?.get('pred')).toBe(pred);
    expect(result.chainTasksById?.size).toBe(5);
    expect(result.chainWaitingOn?.map((t) => t.id)).toEqual(['pred']);
    expect(result.chainMergeHeld?.map((t) => t.id)).toEqual(['pred']);
  });

  it("derives subtaskAttachments as the flat union of every one of the CARD's own steps' files", () => {
    const card = task({ id: 'card-1' });
    const step1 = task({ id: 'step-1', parentTaskId: 'card-1', order: 0 });
    const step2 = task({ id: 'step-2', parentTaskId: 'card-1', order: 1 });

    const loaded: LoadedTaskDetailData = {
      tasks: [card, step1, step2],
      attachments: [
        attachment('a1', 'step-1'),
        attachment('a2', 'step-2'),
        attachment('a3', 'card-1'),
        attachment('a4', 'unrelated'),
      ],
    };

    const result = assembleTaskDetailProps('card-1', { taskId: 'card-1' }, loaded);

    expect(result.attachments?.map((a) => a.id)).toEqual(['a3']);
    expect(result.subtaskAttachments?.map((a) => a.id)).toEqual(['a1', 'a2']);
  });

  it('derives empty slices and null answers for a task with nothing loaded and nothing supplied', () => {
    const result = assembleTaskDetailProps('missing', { taskId: 'missing' }, EMPTY_LOADED);

    expect(result.task).toBeNull();
    expect(result.subtasks).toEqual([]);
    expect(result.parentTask).toBeNull();
    expect(result.mergeRequests).toEqual([]);
    expect(result.attachments).toEqual([]);
    expect(result.parentAttachments).toEqual([]);
    expect(result.subtaskAttachments).toEqual([]);
    expect(result.chainLinks).toEqual([]);
    expect(result.chainTasksById?.size).toBe(0);
    expect(result.attention?.count).toBe(0);
    expect(result.liveRunTaskIds).toEqual(new Set());
    expect(result.mergingTaskIds).toEqual(new Set());
    expect(result.chainWaitingOn).toBeUndefined();
    expect(result.chainMergeHeld).toBeUndefined();
  });
});
