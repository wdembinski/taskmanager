import { describe, expect, it } from 'vitest';
import type { BoardColumn, Task, TaskStatus } from '@shared/model';
import type { MergeRequest } from '@shared/mergeRequest';
import {
  COLUMN_META,
  columnForStatus,
  columnForTask,
  groupSubtasks,
  hasLiveSubtask,
  sortCards,
  statusForColumn,
  stepPosition,
  subtaskProgress,
  visibleColumns,
} from './boardColumns';

const task = (status: TaskStatus): Task => ({
  id: 't',
  projectId: 'p',
  phase: '',
  title: 'x',
  status,
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'adhoc',
  isContract: false,
  isScaffold: false,
});

/** A card/step with an explicit id, order, parent and status, for the grouping tests. */
const card = (id: string, overrides: Partial<Task> = {}): Task => ({
  ...task('pending'),
  id,
  title: id,
  ...overrides,
});

describe('columnForStatus', () => {
  const cases: Array<[TaskStatus, BoardColumn]> = [
    ['pending', 'todo'],
    ['in-progress', 'in-progress'],
    ['running', 'in-progress'],
    ['waiting-input', 'in-progress'],
    ['blocked-by-limit', 'in-progress'],
    ['in-review', 'in-review'],
    ['blocked', 'blocked'],
    ['done', 'done'],
    ['failed', 'done'],
    ['stopped', 'done'],
    ['cancelled', 'done'],
  ];

  it.each(cases)('maps %s → %s', (status, column) => {
    expect(columnForStatus(status)).toBe(column);
  });

  it('covers every TaskStatus (no undefined)', () => {
    for (const [status] of cases) {
      expect(columnForStatus(status)).toBeDefined();
    }
    expect(cases).toHaveLength(11);
  });
});

describe('columnForTask', () => {
  it('delegates to the task status', () => {
    expect(columnForTask(task('blocked'))).toBe('blocked');
  });
});

describe('statusForColumn', () => {
  it('round-trips every column to a manual status', () => {
    expect(statusForColumn('todo')).toBe('pending');
    expect(statusForColumn('in-progress')).toBe('in-progress');
    expect(statusForColumn('in-review')).toBe('in-review');
    expect(statusForColumn('blocked')).toBe('blocked');
    expect(statusForColumn('done')).toBe('done');
  });
});

describe('visibleColumns', () => {
  it('hides Done when the toggle is off', () => {
    expect(visibleColumns(false)).toEqual(['todo', 'in-progress', 'in-review', 'blocked']);
  });
  it('shows all five when on', () => {
    expect(visibleColumns(true)).toEqual(['todo', 'in-progress', 'in-review', 'blocked', 'done']);
  });
  it('column order matches COLUMN_META', () => {
    expect(COLUMN_META.map((c) => c.column)).toEqual([
      'todo',
      'in-progress',
      'in-review',
      'blocked',
      'done',
    ]);
  });
});

describe('groupSubtasks', () => {
  it('leaves an ordinary board untouched, each card with no steps', () => {
    const cards = groupSubtasks([card('a'), card('b')]);
    expect(cards.map((c) => c.task.id)).toEqual(['a', 'b']);
    expect(cards.every((c) => c.subtasks.length === 0)).toBe(true);
  });

  it('attaches steps to their parent and drops them from the top level', () => {
    const cards = groupSubtasks([
      card('parent'),
      card('s2', { parentTaskId: 'parent', order: 1 }),
      card('other'),
      card('s1', { parentTaskId: 'parent', order: 0 }),
    ]);
    expect(cards.map((c) => c.task.id)).toEqual(['parent', 'other']);
    expect(cards[0].subtasks.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(cards[1].subtasks).toEqual([]);
  });

  it('keeps a step with its parent whatever its own status', () => {
    const cards = groupSubtasks([
      card('parent', { status: 'in-progress' }),
      card('s1', { parentTaskId: 'parent', order: 0, status: 'done' }),
      card('s2', { parentTaskId: 'parent', order: 1, status: 'failed' }),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].subtasks.map((s) => s.status)).toEqual(['done', 'failed']);
  });

  it('preserves the input order of the top-level cards', () => {
    const cards = groupSubtasks([card('b'), card('a'), card('c')]);
    expect(cards.map((c) => c.task.id)).toEqual(['b', 'a', 'c']);
  });

  it('promotes an orphaned step rather than hiding it', () => {
    // The parent is on another board (or was deleted): the step still needs to be
    // reachable, so it renders as a card of its own.
    const cards = groupSubtasks([card('orphan', { parentTaskId: 'gone' })]);
    expect(cards.map((c) => c.task.id)).toEqual(['orphan']);
  });

  it('handles an empty board', () => {
    expect(groupSubtasks([])).toEqual([]);
  });
});

describe('subtaskProgress', () => {
  it('counts only steps that actually landed', () => {
    const steps = [
      card('s1', { status: 'done' }),
      card('s2', { status: 'failed' }),
      card('s3', { status: 'running' }),
      card('s4', { status: 'pending' }),
    ];
    expect(subtaskProgress(steps)).toEqual({ done: 1, total: 4 });
  });

  it('is 0/0 for a card with no steps', () => {
    expect(subtaskProgress([])).toEqual({ done: 0, total: 0 });
  });
});

describe('hasLiveSubtask', () => {
  it('is true while a step runs or waits on the human', () => {
    expect(
      hasLiveSubtask([card('s1', { status: 'done' }), card('s2', { status: 'running' })]),
    ).toBe(true);
    expect(hasLiveSubtask([card('s1', { status: 'waiting-input' })])).toBe(true);
  });

  it('is false for a finished, failed or not-yet-started chain', () => {
    expect(hasLiveSubtask([])).toBe(false);
    expect(
      hasLiveSubtask([card('s1', { status: 'done' }), card('s2', { status: 'pending' })]),
    ).toBe(false);
    expect(hasLiveSubtask([card('s1', { status: 'failed' })])).toBe(false);
  });
});

describe('stepPosition', () => {
  const steps = [card('s1'), card('s2'), card('s3')];

  it('numbers a step from 1 among its siblings', () => {
    expect(stepPosition(steps, 's1')).toBe(1);
    expect(stepPosition(steps, 's3')).toBe(3);
  });

  it('is null for a task that is not one of the steps', () => {
    expect(stepPosition(steps, 'parent')).toBeNull();
    expect(stepPosition([], 's1')).toBeNull();
  });
});

describe('sortCards', () => {
  /** A plain card (no steps) with an id, order and priority. */
  const c = (id: string, order: number, priority: string | null, over: Partial<Task> = {}) => ({
    task: card(id, { order, externalPriority: priority, ...over }),
    subtasks: [] as Task[],
    mergeRequests: [] as MergeRequest[],
  });

  const ids = (cards: ReturnType<typeof sortCards>): string[] => cards.map((x) => x.task.id);

  it('puts the most urgent first', () => {
    const sorted = sortCards([
      c('low', 0, 'Low'),
      c('highest', 1, 'Highest'),
      c('med', 2, 'Medium'),
    ]);
    expect(ids(sorted)).toEqual(['highest', 'med', 'low']);
  });

  it('sinks an unprioritised card below every prioritised one', () => {
    expect(ids(sortCards([c('none', 0, null), c('lowest', 1, 'Lowest')]))).toEqual([
      'lowest',
      'none',
    ]);
  });

  // The whole point of the rule: a card waiting on you costs time NOW.
  it('lifts a card that wants you above the top-priority card', () => {
    const waiting = c('waiting', 9, 'Lowest', { status: 'waiting-input' });
    const sorted = sortCards([c('highest', 0, 'Highest'), waiting]);
    expect(ids(sorted)).toEqual(['waiting', 'highest']);
  });

  it('orders several attention cards among themselves by priority', () => {
    const a = c('askLow', 0, 'Low', { status: 'waiting-input' });
    const b = c('askHigh', 1, 'Highest', { status: 'waiting-input' });
    expect(ids(sortCards([a, b, c('quiet', 2, 'Highest')]))).toEqual([
      'askHigh',
      'askLow',
      'quiet',
    ]);
  });

  it('treats an unread JIRA comment as wanting you', () => {
    const unread = c('unread', 9, null, {
      externalSource: 'jira',
      latestCommentAt: 200,
      lastReadCommentAt: 100,
    });
    expect(ids(sortCards([c('high', 0, 'High'), unread]))).toEqual(['unread', 'high']);
  });

  it('lifts a card whose STEP has parked the chain', () => {
    const parked = {
      task: card('parent', { order: 9, externalPriority: 'Lowest' }),
      subtasks: [card('s1', { parentTaskId: 'parent', status: 'failed' })],
      mergeRequests: [] as MergeRequest[],
    };
    expect(ids(sortCards([c('high', 0, 'Highest'), parked]))).toEqual(['parent', 'high']);
  });

  // The ring and the ordering are the same predicate on purpose: a board where the
  // loudest card is not the top one is a board that is lying.
  it('lifts a card whose MERGE REQUEST wants you, above even the top priority', () => {
    const loudMr: MergeRequest = {
      id: 'gl-9-1',
      taskId: 'mr-card',
      provider: 'gitlab',
      gitlabProjectId: 9,
      projectPath: 'acme/web',
      iid: 1,
      title: 'ENG-1',
      displayName: null,
      webUrl: 'https://gitlab/1',
      sourceBranch: 'feature/ENG-1',
      targetBranch: 'main',
      state: 'opened',
      draft: false,
      pipelineStatus: 'failed',
      pipelineStages: [],
      pipelineUrl: null,
      approvalsRequired: 1,
      approvalsGiven: 0,
      changesRequested: false,
      issueKeys: ['ENG-1'],
      latestNoteAt: null,
      lastReadAt: null,
      lastEventAt: 200,
      lastEventSeenAt: null,
      updatedAt: 100,
      syncedAt: 100,
    };
    const withMr = {
      task: card('mr-card', { order: 9, externalPriority: 'Lowest' }),
      subtasks: [] as Task[],
      mergeRequests: [loudMr],
    };
    expect(ids(sortCards([c('high', 0, 'Highest'), withMr]))).toEqual(['mr-card', 'high']);

    // Acknowledge the pipeline and the card falls back to its priority position.
    const quiet = {
      ...withMr,
      mergeRequests: [{ ...loudMr, lastEventSeenAt: 200 }],
    };
    expect(ids(sortCards([c('high', 0, 'Highest'), quiet]))).toEqual(['high', 'mr-card']);
  });

  it('falls back to `order` so equal cards never shuffle', () => {
    expect(ids(sortCards([c('b', 2, 'High'), c('a', 1, 'High')]))).toEqual(['a', 'b']);
  });

  it('does not mutate its input', () => {
    const input = [c('b', 2, 'Low'), c('a', 1, 'Highest')];
    sortCards(input);
    expect(ids(input)).toEqual(['b', 'a']);
  });
});
