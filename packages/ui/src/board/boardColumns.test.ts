import { tokens } from '@fluentui/react-components';
import { describe, expect, it } from 'vitest';
import type { BoardColumn, Task, TaskStatus } from '@tm/shared/model';
import type { MergeRequest } from '@tm/shared/mergeRequest';
import type { TaskLink } from '@tm/shared/taskChain';
import { chainComponent } from '@tm/shared/taskChain';
import type { RunState } from '@tm/shared/board';
import { runPhase } from '@tm/shared/board';
import type { VariantGroupState } from '@tm/shared/variants';
import { archiveIndexOf } from '@tm/shared/trackerArchive';
import { STATUS_INDICATOR_VAR } from '../tokens';
import {
  bucketBoardCards,
  COLUMN_META,
  cardBadgeStatus,
  columnForStatus,
  columnForTask,
  focusAnchorId,
  focusCards,
  groupStepsByRound,
  groupSubtasks,
  hiddenColumnsSummary,
  partitionShelved,
  sortCards,
  splitEarlierSteps,
  splitStepPhases,
  statusForColumn,
  stepPosition,
  subtaskProgress,
  variantStripTone,
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

/**
 * The badge the card wears next to its title. Two rules, and the second is the one this
 * suite exists for: a card whose STEP is parked behind the usage-limit gate is an ordinary
 * `in-progress` card sitting in IN PROGRESS, so nothing about the card itself could say so.
 */
describe('cardBadgeStatus', () => {
  /** Nothing running — the answer has to come from the card's own status alone. */
  const idle: RunState = { phase: 'idle', label: '', spinner: false };

  it('badges a running card that is sitting in TO DO', () => {
    // A run borrows `status` and leaves the card where its human put it, so the badge is
    // the card's only way of saying it is working. Unchanged by the move off the card.
    const running = card('c', { status: 'running', preRunStatus: 'pending' });
    expect(columnForTask(running)).toBe('todo');
    expect(cardBadgeStatus(running, idle)).toBe('running');
  });

  it('says nothing when the column already says it', () => {
    expect(cardBadgeStatus(card('c', { status: 'in-progress' }), idle)).toBeNull();
    expect(cardBadgeStatus(card('c', { status: 'pending' }), idle)).toBeNull();
  });

  it('badges a card the limit stopped, from its own status — not the fallback', () => {
    // Symptom 1: `blocked-by-limit` lands in IN PROGRESS, whose canonical status is
    // `in-progress`, so the ordinary rule already answers and the run is never consulted.
    const limited = card('c', { status: 'blocked-by-limit' });
    expect(columnForTask(limited)).toBe('in-progress');
    expect(cardBadgeStatus(limited, idle)).toBe('blocked-by-limit');
  });

  // Symptom 2, and the reason this helper takes the run at all: the parked thing is a
  // STEP, so the parent is a plain `in-progress` card in IN PROGRESS and looked exactly
  // like one merely working.
  it('badges a card whose STEP is held behind the usage-limit gate', () => {
    const parent = card('parent', { status: 'in-progress' });
    const steps = [
      card('s1', { parentTaskId: 'parent', order: 0, status: 'done' }),
      card('s2', { parentTaskId: 'parent', order: 1, status: 'blocked-by-limit' }),
    ];
    const run = runPhase(parent, steps);
    expect(run.phase).toBe('blocked');
    expect(cardBadgeStatus(parent, run)).toBe('blocked-by-limit');
  });

  it('leaves a chain that is merely waiting its turn unbadged', () => {
    // `queued` is not `blocked`: a Limit badge on every card with a pending step would
    // make the badge mean nothing.
    const parent = card('parent', { status: 'in-progress' });
    const steps = [card('s1', { parentTaskId: 'parent', order: 0, status: 'pending' })];
    const run = runPhase(parent, steps);
    expect(run.phase).toBe('queued');
    expect(cardBadgeStatus(parent, run)).toBeNull();
  });
});

describe('variantStripTone', () => {
  it('colours a row a run still owns', () => {
    expect(variantStripTone('running')).toBe(STATUS_INDICATOR_VAR.running);
    expect(variantStripTone('waiting-input')).toBe(STATUS_INDICATOR_VAR['waiting-input']);
    expect(variantStripTone('blocked-by-limit')).toBe(STATUS_INDICATOR_VAR['blocked-by-limit']);
  });

  it('greys out every settled outcome alike, not just done', () => {
    const grey = tokens.colorNeutralForeground4;
    expect(variantStripTone('done')).toBe(grey);
    expect(variantStripTone('failed')).toBe(grey);
    expect(variantStripTone('stopped')).toBe(grey);
    expect(variantStripTone('cancelled')).toBe(grey);
  });

  it('greys out a row that has not started yet', () => {
    expect(variantStripTone('pending')).toBe(tokens.colorNeutralForeground4);
  });
});

describe('visibleColumns', () => {
  it('hides Done when it is in the hidden list', () => {
    expect(visibleColumns(['done'])).toEqual(['todo', 'in-progress', 'in-review', 'blocked']);
  });
  it('shows all five when nothing is hidden', () => {
    expect(visibleColumns([])).toEqual(['todo', 'in-progress', 'in-review', 'blocked', 'done']);
  });
  it('hides every column named, whichever they are', () => {
    expect(visibleColumns(['todo', 'blocked'])).toEqual(['in-progress', 'in-review', 'done']);
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
  it('labels every column in Title case, the same words as STATUS_LABEL', () => {
    expect(COLUMN_META.map((c) => c.label)).toEqual([
      'To Do',
      'In Progress',
      'In Review',
      'Blocked',
      'Done',
    ]);
  });
});

describe('hiddenColumnsSummary', () => {
  it('counts every card the DONE column holds, and the ones nobody marked done apart', () => {
    // All four statuses land in DONE. Only the first is the human saying "finished"; the
    // other three are the ones worth a second look, which is why they are counted apart.
    const cards = groupSubtasks([
      card('finished', { status: 'done' }),
      card('gave-up', { status: 'cancelled' }),
      card('halted', { status: 'stopped' }),
      card('broke', { status: 'failed' }),
    ]);
    expect(hiddenColumnsSummary(cards, ['done'])).toEqual({ total: 4, notMarkedDone: 3 });
  });

  it('ignores the cards that are still on the open columns', () => {
    const cards = groupSubtasks([
      card('todo', { status: 'pending' }),
      card('doing', { status: 'in-progress' }),
      card('review', { status: 'in-review' }),
      card('stuck', { status: 'blocked' }),
      card('finished', { status: 'done' }),
    ]);
    expect(hiddenColumnsSummary(cards, ['done'])).toEqual({ total: 1, notMarkedDone: 0 });
  });

  it('counts a running card by where it RESTS, not by the status its run borrowed', () => {
    // The run has `status`; `preRunStatus` is where the human left it. A card parked over
    // `cancelled` sits in DONE and is just as hidden as one that is not running.
    const cards = groupSubtasks([
      card('running-over-cancelled', { status: 'running', preRunStatus: 'cancelled' }),
      card('running-over-todo', { status: 'running', preRunStatus: 'pending' }),
    ]);
    expect(hiddenColumnsSummary(cards, ['done'])).toEqual({ total: 1, notMarkedDone: 1 });
  });

  it('is silent about a board with nothing behind the hidden columns', () => {
    expect(hiddenColumnsSummary([], ['done'])).toEqual({ total: 0, notMarkedDone: 0 });
    expect(hiddenColumnsSummary(groupSubtasks([card('todo')]), ['done'])).toEqual({
      total: 0,
      notMarkedDone: 0,
    });
  });

  it('counts CARDS, not the steps travelling inside them', () => {
    // A finished step is not a hidden card — it renders inside its parent, which is sitting
    // in IN PROGRESS in plain view.
    const cards = groupSubtasks([
      card('parent', { status: 'in-progress' }),
      card('s1', { parentTaskId: 'parent', order: 0, status: 'done' }),
      card('s2', { parentTaskId: 'parent', order: 1, status: 'failed' }),
    ]);
    expect(hiddenColumnsSummary(cards, ['done'])).toEqual({ total: 0, notMarkedDone: 0 });
  });

  it('counts across every hidden column, not only Done', () => {
    const cards = groupSubtasks([
      card('todo', { status: 'pending' }),
      card('stuck', { status: 'blocked' }),
      card('doing', { status: 'in-progress' }),
    ]);
    expect(hiddenColumnsSummary(cards, ['todo', 'blocked'])).toEqual({
      total: 2,
      notMarkedDone: 0,
    });
  });

  it('scopes notMarkedDone to DONE even when other columns are also hidden', () => {
    const cards = groupSubtasks([
      card('todo', { status: 'pending' }),
      card('broke', { status: 'failed' }),
    ]);
    expect(hiddenColumnsSummary(cards, ['todo', 'done'])).toEqual({ total: 2, notMarkedDone: 1 });
  });
});

describe('focusAnchorId', () => {
  const tasks = [
    card('parent'),
    card('s1', { parentTaskId: 'parent', order: 0 }),
    card('plain'),
    card('orphan', { parentTaskId: 'gone' }),
  ];

  it('anchors a selected STEP to its parent card', () => {
    // The bug this exists for: a step is never chained, so a component built from its own
    // id matched no card and focus emptied the board.
    expect(focusAnchorId(tasks, 's1')).toBe('parent');
  });

  it('anchors an ordinary card to itself', () => {
    expect(focusAnchorId(tasks, 'plain')).toBe('plain');
    expect(focusAnchorId(tasks, 'parent')).toBe('parent');
  });

  it('anchors an orphaned step to itself — the board promotes it to a card', () => {
    expect(focusAnchorId(tasks, 'orphan')).toBe('orphan');
  });

  it('is null for nothing selected, and for an id the board does not have', () => {
    expect(focusAnchorId(tasks, null)).toBeNull();
    expect(focusAnchorId(tasks, 'deleted')).toBeNull();
    expect(focusAnchorId([], 'plain')).toBeNull();
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

  // F10: a leader plus its hidden variant rows collapses to one card — the leader's own.
  it('collapses a leader and its variant rows into one card, the leader’s own', () => {
    const cards = groupSubtasks([
      card('leader'),
      card('a', { variantOf: 'leader', variantLabel: 'A' }),
      card('b', { variantOf: 'leader', variantLabel: 'B' }),
      card('c', { variantOf: 'leader', variantLabel: 'C' }),
    ]);
    expect(cards.map((c) => c.task.id)).toEqual(['leader']);
  });

  // Unlike an orphaned step (promoted above), a variant row whose leader is absent from this
  // board stays hidden: it was never meant to be seen outside the compare view.
  it('never promotes a variant row whose leader is absent', () => {
    const cards = groupSubtasks([card('orphan-variant', { variantOf: 'gone', variantLabel: 'A' })]);
    expect(cards).toEqual([]);
  });

  describe('variants (F10.5 — the board’s own badge and strip)', () => {
    it('gives an ordinary card the empty group, not undefined', () => {
      const [plain] = groupSubtasks([card('solo')]);
      expect(plain.variants).toEqual({ state: 'none', rows: [] });
    });

    it('gives the leader its rows in A, B, C order with the derived state', () => {
      const [leader] = groupSubtasks([
        card('leader', { status: 'in-progress' }),
        card('c', { variantOf: 'leader', variantLabel: 'C', status: 'done' }),
        card('a', { variantOf: 'leader', variantLabel: 'A', status: 'running' }),
        card('b', { variantOf: 'leader', variantLabel: 'B', status: 'pending' }),
      ]);
      expect(leader.variants.state).toBe('running');
      expect(leader.variants.rows.map((r) => r.label)).toEqual(['A', 'B', 'C']);
    });

    it('ignores an archived row, as though it were never started', () => {
      const [leader] = groupSubtasks([
        card('leader'),
        card('a', { variantOf: 'leader', variantLabel: 'A', status: 'done' }),
        card('b', {
          variantOf: 'leader',
          variantLabel: 'B',
          status: 'running',
          archivedAt: 100,
        }),
      ]);
      expect(leader.variants.rows.map((r) => r.label)).toEqual(['A']);
      expect(leader.variants.state).toBe('done');
    });

    it('never reads or writes the leader’s own status', () => {
      // The leader's column is the human's — see `cardBadgeStatus` and the memory
      // *card-state-is-the-humans*. A running variant group must not move the card.
      const [leader] = groupSubtasks([
        card('leader', { status: 'pending' }),
        card('a', { variantOf: 'leader', variantLabel: 'A', status: 'running' }),
      ]);
      expect(leader.variants.state).toBe('running');
      expect(leader.task.status).toBe('pending');
    });
  });
});

describe('focusCards — chain focus mode', () => {
  /**
   * The chain under test, drawn as the board draws it — a fan-out from #1 into #2 and #3,
   * fanning back in on #4 — plus `far`, an unrelated card, and `solo`, a card on nobody's
   * chain. `focusIds` comes from the real `chainComponent` rather than a hand-written set,
   * so this covers the actual pairing the board uses and not a restatement of it.
   */
  const links: TaskLink[] = [
    { id: 'l1', fromTaskId: '1', toTaskId: '2', gate: 'after-merge', createdAt: 0 },
    { id: 'l2', fromTaskId: '1', toTaskId: '3', gate: 'after-merge', createdAt: 0 },
    { id: 'l3', fromTaskId: '2', toTaskId: '4', gate: 'after-merge', createdAt: 0 },
    { id: 'l4', fromTaskId: '3', toTaskId: '4', gate: 'after-merge', createdAt: 0 },
    { id: 'l5', fromTaskId: 'far', toTaskId: 'other', gate: 'after-merge', createdAt: 0 },
  ];
  const board = groupSubtasks([
    card('1'),
    card('2'),
    card('3'),
    card('4'),
    card('far'),
    card('other'),
    card('solo'),
  ]);

  it('passes the whole board through when focus is off', () => {
    // Null is "no filter", not "no cards" — the ordinary case must be a no-op.
    expect(focusCards(board, null).map((c) => c.task.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
      'far',
      'other',
      'solo',
    ]);
  });

  it('keeps the selected card’s whole chain and nothing else', () => {
    const ids = focusCards(board, chainComponent(links, '4')).map((c) => c.task.id);
    expect(ids).toEqual(['1', '2', '3', '4']);
  });

  it('shows the same four cards whichever card of the chain is selected', () => {
    // The component is undirected: focusing the card at the head of the fan-out has to
    // give the same board as focusing the one it all joins back into.
    const fromHead = focusCards(board, chainComponent(links, '1')).map((c) => c.task.id);
    const fromTail = focusCards(board, chainComponent(links, '4')).map((c) => c.task.id);
    expect(fromHead).toEqual(fromTail);
  });

  it('narrows to just the card itself when it is on nobody’s chain', () => {
    expect(focusCards(board, chainComponent(links, 'solo')).map((c) => c.task.id)).toEqual([
      'solo',
    ]);
  });

  it('leaves a card’s steps with it — a chained card keeps its work', () => {
    // Focus filters CARDS. A step is never chained itself, so testing step ids would
    // empty the card of the very work the chain is about.
    const withSteps = groupSubtasks([
      card('1'),
      card('2'),
      card('s1', { parentTaskId: '2', order: 0 }),
      card('s2', { parentTaskId: '2', order: 1 }),
      card('solo'),
    ]);
    const focused = focusCards(withSteps, chainComponent(links, '2'));
    expect(focused.map((c) => c.task.id)).toEqual(['1', '2']);
    expect(focused[1].subtasks.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('keeps the parent’s chain when a STEP is what is selected', () => {
    // The regression, composed exactly as MyTasks composes it: selecting a step (clicking
    // one selects the step, not its card) and turning focus on used to build the component
    // from the step's own id — which no card matches — and every card vanished, the one
    // being read included. The anchor is what fixes it, and it is what is under test here.
    const tasks = [card('1'), card('2'), card('s1', { parentTaskId: '2', order: 0 }), card('solo')];
    const withSteps = groupSubtasks(tasks);
    const anchor = focusAnchorId(tasks, 's1');
    expect(anchor).toBe('2');
    const ids = focusCards(withSteps, chainComponent(links, anchor as string)).map(
      (c) => c.task.id,
    );
    expect(ids).toEqual(['1', '2']);
  });

  it('does not mutate the board it was given', () => {
    const before = board.map((c) => c.task.id);
    focusCards(board, chainComponent(links, '1'));
    expect(board.map((c) => c.task.id)).toEqual(before);
  });
});

describe('partitionShelved', () => {
  const cards = groupSubtasks([card('a'), card('b'), card('c')]);

  it('puts everything on the board when nothing is shelved', () => {
    const { onBoard, shelved } = partitionShelved(cards, new Set());
    expect(onBoard.map((c) => c.task.id)).toEqual(['a', 'b', 'c']);
    expect(shelved).toEqual([]);
  });

  it('moves a shelved card out of the board list and into the shelf, in place', () => {
    const { onBoard, shelved } = partitionShelved(cards, new Set(['b']));
    expect(onBoard.map((c) => c.task.id)).toEqual(['a', 'c']);
    expect(shelved.map((c) => c.task.id)).toEqual(['b']);
  });

  it('ignores a shelved id for a card not on this board', () => {
    // The scope-filter case: `board:tasks` only ever returns the active scope's cards, so
    // a shelved id left over from another scope must not conjure a card that isn't there.
    const { onBoard, shelved } = partitionShelved(cards, new Set(['gone']));
    expect(onBoard.map((c) => c.task.id)).toEqual(['a', 'b', 'c']);
    expect(shelved).toEqual([]);
  });

  it('does not mutate the board it was given', () => {
    const before = cards.map((c) => c.task.id);
    partitionShelved(cards, new Set(['a']));
    expect(cards.map((c) => c.task.id)).toEqual(before);
  });
});

describe('bucketBoardCards', () => {
  it('excludes a shelved card from every column, putting it on the shelf instead', () => {
    const onBoard = card('onBoard', { order: 0 });
    const shelved = card('shelved', { order: 1 });
    const { cardsByColumn, shelvedCards } = bucketBoardCards(
      [onBoard, shelved],
      new Map(),
      null,
      new Set(['shelved']),
      undefined,
    );
    expect(cardsByColumn.get('todo')?.map((c) => c.task.id)).toEqual(['onBoard']);
    expect(shelvedCards.map((c) => c.task.id)).toEqual(['shelved']);
  });

  it('counts a card with steps once, and its steps zero', () => {
    const parent = card('parent', { order: 0 });
    const step = card('step', { parentTaskId: 'parent', order: 0 });
    const { cardsByColumn } = bucketBoardCards(
      [parent, step],
      new Map(),
      null,
      new Set(),
      undefined,
    );
    const todo = cardsByColumn.get('todo') ?? [];
    expect(todo.map((c) => c.task.id)).toEqual(['parent']);
    expect(todo[0].subtasks.map((s) => s.id)).toEqual(['step']);
  });

  it('counts an orphan step — its parent not on this board — as a card of its own', () => {
    const orphan = card('orphan', { parentTaskId: 'nowhere', order: 0 });
    const { cardsByColumn } = bucketBoardCards([orphan], new Map(), null, new Set(), undefined);
    expect(cardsByColumn.get('todo')?.map((c) => c.task.id)).toEqual(['orphan']);
  });

  it('narrows the counts to the focused chain', () => {
    const a = card('a', { order: 0 });
    const b = card('b', { order: 1 });
    const { cardsByColumn } = bucketBoardCards(
      [a, b],
      new Map(),
      new Set(['a']),
      new Set(),
      undefined,
    );
    expect(cardsByColumn.get('todo')?.map((c) => c.task.id)).toEqual(['a']);
  });

  describe('with an archive index (F14.5)', () => {
    const archivedMilestone = card('archived', {
      source: 'ticket',
      milestoneId: 'm1',
      order: 0,
    });
    const liveSibling = card('live', {
      source: 'ticket',
      milestoneId: 'm2',
      order: 1,
    });
    const index = archiveIndexOf(
      [
        { id: 'm1', archivedAt: 1_000 },
        { id: 'm2', archivedAt: null },
      ],
      [],
      [],
    );

    it('hides a ticket whose milestone is archived, from every column', () => {
      const { cardsByColumn, shelvedCards } = bucketBoardCards(
        [archivedMilestone, liveSibling],
        new Map(),
        null,
        new Set(),
        undefined,
        { index },
      );
      for (const cards of cardsByColumn.values()) {
        expect(cards.map((c) => c.task.id)).not.toContain('archived');
      }
      expect(shelvedCards.map((c) => c.task.id)).not.toContain('archived');
    });

    it('keeps the unarchived sibling on the board', () => {
      const { cardsByColumn } = bucketBoardCards(
        [archivedMilestone, liveSibling],
        new Map(),
        null,
        new Set(),
        undefined,
        { index },
      );
      expect(cardsByColumn.get('todo')?.map((c) => c.task.id)).toEqual(['live']);
    });

    it('brings the archived ticket back into its status column with includeArchived', () => {
      const { cardsByColumn } = bucketBoardCards(
        [archivedMilestone, liveSibling],
        new Map(),
        null,
        new Set(),
        undefined,
        { index, includeArchived: true },
      );
      expect(
        cardsByColumn
          .get('todo')
          ?.map((c) => c.task.id)
          .sort(),
      ).toEqual(['archived', 'live']);
    });
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

/** No variant group — the state every ordinary card carries. */
const NO_VARIANTS: VariantGroupState = { state: 'none', rows: [] };

describe('sortCards', () => {
  /** A plain card (no steps) with an id, order and priority. */
  const c = (id: string, order: number, priority: string | null, over: Partial<Task> = {}) => ({
    task: card(id, { order, externalPriority: priority, ...over }),
    subtasks: [] as Task[],
    mergeRequests: [] as MergeRequest[],
    variants: NO_VARIANTS,
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
      variants: NO_VARIANTS,
    };
    expect(ids(sortCards([c('high', 0, 'Highest'), parked]))).toEqual(['parent', 'high']);
  });

  // The ring and the ordering are the same predicate on purpose: a board where the
  // loudest card is not the top one is a board that is lying.
  it('lifts a card whose MERGE REQUEST wants you, above even the top priority', () => {
    const loudMr: MergeRequest = {
      id: 'gl-9-1',
      taskId: 'mr-card',
      openedForTaskId: null,
      detailedMergeStatus: 'mergeable',
      hasConflicts: false,
      provider: 'gitlab',
      repoId: 9,
      projectPath: 'acme/web',
      number: 1,
      title: 'ENG-1',
      displayName: null,
      webUrl: 'https://gitlab/1',
      sourceBranch: 'feature/ENG-1',
      targetBranch: 'main',
      state: 'opened',
      draft: false,
      headSha: null,
      lastActedSha: null,
      lastActedAction: null,
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
      variants: NO_VARIANTS,
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

/**
 * Grouping a card's chain into planning rounds (Phase 18).
 *
 * The rule under test is the one both folds depend on: rounds decide what can be collapsed,
 * but they must never renumber the chain. A card re-planned twice still runs one ordered
 * sequence, and the numbers the human reads have to match the card's own `done/total`
 * counter — which counts every step, whatever round produced it.
 */
describe('groupStepsByRound', () => {
  const step = (id: string, planRound?: number): Task => card(id, { planRound });

  it('leaves a single-round chain as one group', () => {
    const groups = groupStepsByRound([step('s1', 1), step('s2', 1)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].round).toBe(1);
    expect(groups[0].steps.map((s) => s.step.id)).toEqual(['s1', 's2']);
  });

  it('splits a re-planned chain into its rounds, in order', () => {
    const groups = groupStepsByRound([step('s1', 1), step('s2', 1), step('s3', 2), step('s4', 2)]);
    expect(groups.map((g) => g.round)).toEqual([1, 2]);
    expect(groups[1].steps.map((s) => s.step.id)).toEqual(['s3', 's4']);
  });

  // The numbering is the card's, not the round's: round 2's first step is step 3 of 4, and
  // showing it as "1." would contradict the counter on the card.
  it('numbers steps across the WHOLE chain, never restarting per round', () => {
    const groups = groupStepsByRound([step('s1', 1), step('s2', 1), step('s3', 2)]);
    expect(groups.flatMap((g) => g.steps.map((s) => s.index))).toEqual([0, 1, 2]);
    expect(groups[1].steps[0].index).toBe(2);
  });

  // Every step that predates the field came from the card's one and only approved plan.
  it('treats steps with no round as round 1, so an upgraded card still groups', () => {
    const groups = groupStepsByRound([step('s1'), step('s2'), step('s3', 2)]);
    expect(groups.map((g) => g.round)).toEqual([1, 2]);
    expect(groups[0].steps).toHaveLength(2);
  });

  it('is empty for a card with no steps', () => {
    expect(groupStepsByRound([])).toEqual([]);
  });
});

/**
 * Cutting a chain into earlier / current / later phases (Phase 21) — the rule both the
 * board card's fold and the detail pane's phase list are drawn from.
 */
describe('splitStepPhases', () => {
  const step = (id: string, planRound: number | undefined, status: TaskStatus = 'pending'): Task =>
    card(id, { planRound, status });

  it('puts the LAST phase current once every round has finished', () => {
    const { earlier, current, later } = splitStepPhases([
      step('s1', 1, 'done'),
      step('s2', 2, 'done'),
      step('s3', 2, 'done'),
    ]);
    expect(earlier.map((r) => r.round)).toEqual([1]);
    expect(current?.round).toBe(2);
    expect(later).toEqual([]);
  });

  it('picks the FIRST unfinished phase as current and folds everything after it into later', () => {
    const { earlier, current, later } = splitStepPhases([
      step('s1', 1, 'done'),
      step('s2', 2, 'running'),
      step('s3', 2, 'pending'),
      step('s4', 3, 'pending'),
    ]);
    expect(earlier.map((r) => r.round)).toEqual([1]);
    expect(current?.round).toBe(2);
    expect(current?.steps.map((s) => s.step.id)).toEqual(['s2', 's3']);
    expect(later.map((r) => r.round)).toEqual([3]);
  });

  it('has nothing earlier or later for a card with a single phase', () => {
    const { earlier, current, later } = splitStepPhases([step('s1', 1), step('s2', 1)]);
    expect(earlier).toEqual([]);
    expect(later).toEqual([]);
    expect(current?.steps.map((s) => s.step.id)).toEqual(['s1', 's2']);
  });

  // The chain numbers its steps once, across the whole thing, so the split must never
  // renumber them — whichever side of it they land on.
  it('numbers steps across the WHOLE chain on every side of the split', () => {
    const { earlier, current, later } = splitStepPhases([
      step('s1', 1, 'done'),
      step('s2', 2, 'running'),
      step('s3', 3, 'pending'),
    ]);
    expect(earlier.flatMap((r) => r.steps.map((s) => s.index))).toEqual([0]);
    expect(current?.steps.map((s) => s.index)).toEqual([1]);
    expect(later.flatMap((r) => r.steps.map((s) => s.index))).toEqual([2]);
  });

  it('is all empty for a card with no steps', () => {
    expect(splitStepPhases([])).toEqual({ earlier: [], current: null, later: [] });
  });
});

/**
 * The card's automatic partial fold: everything before the current phase is "earlier", the
 * current phase is the bunch you are meant to be watching, and everything after it is
 * "later" — built on {@link splitStepPhases}.
 */
describe('splitEarlierSteps', () => {
  const step = (id: string, planRound: number | undefined, status: TaskStatus = 'pending'): Task =>
    card(id, { planRound, status });

  it('hides nothing on a card that has only been planned once', () => {
    const { earlier, latest, later } = splitEarlierSteps([step('s1', 1), step('s2', 1)]);
    expect(earlier).toEqual([]);
    expect(later).toEqual([]);
    expect(latest.map((s) => s.step.id)).toEqual(['s1', 's2']);
  });

  it('puts every FINISHED round behind the fold and keeps the unfinished one current', () => {
    const { earlier, latest, later } = splitEarlierSteps([
      step('s1', 1, 'done'),
      step('s2', 2, 'done'),
      step('s3', 2, 'done'),
      step('s4', 3, 'pending'),
    ]);
    expect(earlier.map((s) => s.step.id)).toEqual(['s1', 's2', 's3']);
    expect(latest.map((s) => s.step.id)).toEqual(['s4']);
    expect(later).toEqual([]);
  });

  it('flattens every round after the current one into `later`', () => {
    const { earlier, latest, later } = splitEarlierSteps([
      step('s1', 1, 'done'),
      step('s2', 2, 'running'),
      step('s3', 3, 'pending'),
    ]);
    expect(earlier.map((s) => s.step.id)).toEqual(['s1']);
    expect(latest.map((s) => s.step.id)).toEqual(['s2']);
    expect(later.map((s) => s.step.id)).toEqual(['s3']);
  });

  // The card numbers its steps across the whole chain, so an unfolded earlier step still
  // says "1." and the current bunch still starts where the counter says it does.
  it('keeps every step in its place in the whole chain, on every side', () => {
    const { earlier, latest, later } = splitEarlierSteps([
      step('s1', 1, 'done'),
      step('s2', 2, 'running'),
      step('s3', 3, 'pending'),
    ]);
    expect(earlier.map((s) => s.index)).toEqual([0]);
    expect(latest.map((s) => s.index)).toEqual([1]);
    expect(later.map((s) => s.index)).toEqual([2]);
  });

  it('has nothing on any side for a card with no steps', () => {
    expect(splitEarlierSteps([])).toEqual({ earlier: [], latest: [], later: [] });
  });
});
