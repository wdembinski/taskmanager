import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task, type TaskStatus } from './model';
import { RUN_REFUSAL_MESSAGE } from './scheduler';
import type { SessionEvent } from './session';
import {
  PICK_VARIANT_FIRST,
  VARIANT_HINTS,
  VARIANT_PICK_REFUSAL_MESSAGE,
  VARIANT_REFUSAL_MESSAGE,
  VARIANT_SUMMARY_MAX_CHARS,
  canStartVariants,
  diffStatOf,
  pickNote,
  planVariantPick,
  planVariants,
  sortVariantRows,
  variantCost,
  variantGroupState,
  variantSummaryLine,
  variantWorkOwner,
  type VariantFields,
  type VariantLabel,
} from './variants';

const task = (over: Partial<Task> & VariantFields & { id: string }): Task & VariantFields => ({
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

const leader = task({
  id: 'L',
  title: 'Fix the parser',
  description: 'It drops the last line.',
  agentProjectId: 'repo',
  agentMode: 'acceptEdits',
  agentModel: 'sonnet',
});

const row = (id: string, label: 'A' | 'B' | 'C', status: TaskStatus, over: Partial<Task> = {}) =>
  task({ id, variantOf: 'L', variantLabel: label, status, ...over });

describe('canStartVariants', () => {
  it('accepts a delegated board card at rest', () => {
    expect(canStartVariants(leader)).toEqual({ ok: true });
  });

  it('refuses a step', () => {
    expect(canStartVariants(task({ id: 's', parentTaskId: 'L', agentProjectId: 'repo' }))).toEqual({
      refused: 'is-step',
    });
  });

  it.each<TaskStatus>(['running', 'waiting-input', 'blocked-by-limit'])(
    'refuses a %s leader as already-running',
    (status) => {
      expect(canStartVariants({ ...leader, status })).toEqual({ refused: 'already-running' });
    },
  );

  it('refuses a missing or archived card', () => {
    expect(canStartVariants(undefined)).toEqual({ refused: 'unknown-task' });
    expect(canStartVariants({ ...leader, archivedAt: 1 })).toEqual({ refused: 'unknown-task' });
  });

  it('refuses a plan-project task and a row that is itself a variant', () => {
    expect(canStartVariants({ ...leader, projectId: 'plan-1', source: 'plan' })).toEqual({
      refused: 'not-a-card',
    });
    expect(canStartVariants(row('A1', 'A', 'pending', { agentProjectId: 'repo' }))).toEqual({
      refused: 'not-a-card',
    });
  });

  it('needs an agent project from the card or the dialog', () => {
    const bare = { ...leader, agentProjectId: null };
    expect(canStartVariants(bare)).toEqual({ refused: 'no-project' });
    expect(canStartVariants(bare, { agentProjectId: 'repo' })).toEqual({ ok: true });
  });

  it('shares the run refusals’ sentences', () => {
    expect(VARIANT_REFUSAL_MESSAGE['already-running']).toBe(RUN_REFUSAL_MESSAGE['already-running']);
  });
});

describe('planVariants', () => {
  it('×2 yields A and B with exactly one hint', () => {
    const drafts = planVariants(leader, 2, { agentProjectId: 'repo' });
    expect(drafts.map((d) => d.variantLabel)).toEqual(['A', 'B']);
    expect(drafts.filter((d) => d.hint !== null)).toHaveLength(1);
    expect(drafts[0]!.description).toBe('It drops the last line.');
    expect(drafts[1]!.description).toBe(`It drops the last line.\n\n${VARIANT_HINTS.B}`);
  });

  it('×3 yields A, B, C with distinct hints for B and C', () => {
    const drafts = planVariants(leader, 3, { agentProjectId: 'repo' });
    expect(drafts.map((d) => d.variantLabel)).toEqual(['A', 'B', 'C']);
    expect(drafts[1]!.hint).not.toBe(drafts[2]!.hint);
    expect(drafts.every((d) => d.variantOf === 'L' && d.title === 'Fix the parser')).toBe(true);
  });

  it('copies attachments and agent settings, the dialog winning over the card', () => {
    const drafts = planVariants(
      leader,
      2,
      { agentProjectId: 'other', model: 'opus', notes: 'be careful' },
      [{ name: 'log.txt' }, { name: 'shot.png' }],
    );
    for (const d of drafts) {
      expect(d).toMatchObject({
        agentProjectId: 'other',
        agentMode: 'acceptEdits',
        agentModel: 'opus',
        agentPlanningModel: null,
        notes: 'be careful',
        attachmentNames: ['log.txt', 'shot.png'],
      });
    }
  });

  it('gives a card with no description the hint alone', () => {
    const drafts = planVariants({ ...leader, description: null }, 2, { agentProjectId: 'repo' });
    expect(drafts[0]!.description).toBeNull();
    expect(drafts[1]!.description).toBe(VARIANT_HINTS.B);
  });

  it('rejects a count outside 2–3', () => {
    expect(() => planVariants(leader, 4 as never, { agentProjectId: 'repo' })).toThrow();
  });
});

describe('variantGroupState', () => {
  const state = (...statuses: TaskStatus[]) =>
    variantGroupState(
      leader,
      statuses.map((s, i) => row(`r${i}`, (['A', 'B', 'C'] as const)[i]!, s)),
    ).state;

  it('is none without rows', () => {
    expect(state()).toBe('none');
  });

  it.each<[TaskStatus[], string]>([
    [['running', 'pending'], 'running'],
    [['running', 'done', 'failed'], 'running'],
    [['blocked-by-limit', 'done'], 'running'],
    [['running', 'waiting-input'], 'waiting'],
    [['done', 'waiting-input', 'failed'], 'waiting'],
    [['pending', 'done'], 'queued'],
    [['done', 'done'], 'done'],
    [['done', 'failed', 'failed'], 'done'],
    [['failed', 'failed'], 'failed'],
    [['failed', 'stopped'], 'failed'],
    [['stopped', 'cancelled'], 'stopped'],
  ])('%j → %s', (statuses, expected) => {
    expect(state(...statuses)).toBe(expected);
  });

  it('ignores other groups and discarded rows, and orders rows by label', () => {
    const got = variantGroupState(leader, [
      row('b', 'B', 'done'),
      task({ id: 'x', variantOf: 'other', variantLabel: 'A', status: 'running' }),
      row('c', 'C', 'running', { archivedAt: 5 }),
      row('a', 'A', 'failed'),
      task({ id: 'plain', status: 'running' }),
    ]);
    expect(got).toEqual({
      state: 'done',
      rows: [
        { id: 'a', label: 'A', status: 'failed' },
        { id: 'b', label: 'B', status: 'done' },
      ],
    });
  });

  it('never reads or reports the leader’s status', () => {
    const rows = [row('a', 'A', 'running'), row('b', 'B', 'done')];
    const statuses: TaskStatus[] = ['pending', 'in-review', 'done', 'blocked', 'running'];
    const results = statuses.map((status) => {
      const l: Task = { ...leader, status };
      return variantGroupState(l, rows);
    });
    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0]!.rows.some((r) => r.id === 'L')).toBe(false);
    expect(Object.keys(results[0]!)).toEqual(['state', 'rows']);
  });
});

describe('variantSummaryLine', () => {
  it('returns an empty string for empty text or text with no non-empty line', () => {
    expect(variantSummaryLine('')).toBe('');
    expect(variantSummaryLine('\n\n   \n\t\n')).toBe('');
  });

  it('skips leading blank lines to find the first non-empty one', () => {
    expect(variantSummaryLine('\n\n  \nFixed the parser.\nMore detail.')).toBe('Fixed the parser.');
  });

  it('tolerates CRLF line endings', () => {
    expect(variantSummaryLine('\r\n\r\nFixed the parser.\r\nMore detail.')).toBe(
      'Fixed the parser.',
    );
  });

  it.each([
    ['# Fixed the parser', 'Fixed the parser'],
    ['## Fixed the parser', 'Fixed the parser'],
    ['- Fixed the parser', 'Fixed the parser'],
    ['* Fixed the parser', 'Fixed the parser'],
    ['+ Fixed the parser', 'Fixed the parser'],
    ['1. Fixed the parser', 'Fixed the parser'],
    ['2) Fixed the parser', 'Fixed the parser'],
  ])('strips a leading markdown marker: %j → %j', (input, expected) => {
    expect(variantSummaryLine(input)).toBe(expected);
  });

  it('collapses internal whitespace', () => {
    expect(variantSummaryLine('Fixed   the\tparser   today.')).toBe('Fixed the parser today.');
  });

  it('caps over-long text at VARIANT_SUMMARY_MAX_CHARS with a trailing ellipsis', () => {
    const long = 'x'.repeat(VARIANT_SUMMARY_MAX_CHARS + 50);
    const got = variantSummaryLine(long);
    expect(got).toBe(`${'x'.repeat(VARIANT_SUMMARY_MAX_CHARS)}…`);
    expect(got.length).toBe(VARIANT_SUMMARY_MAX_CHARS + 1);
  });

  it('leaves text at or under the cap untouched', () => {
    const atCap = 'x'.repeat(VARIANT_SUMMARY_MAX_CHARS);
    expect(variantSummaryLine(atCap)).toBe(atCap);
  });
});

describe('variantCost', () => {
  const resultEvent = (costUsd: number | null): SessionEvent => ({
    kind: 'result',
    success: true,
    resultText: '',
    costUsd,
    durationMs: null,
    stopReason: null,
    terminalReason: null,
    usage: null,
  });

  it('sums costUsd across result events, ignoring nulls', () => {
    expect(variantCost([resultEvent(0.5), resultEvent(null), resultEvent(1.25)])).toBe(1.75);
  });

  it('returns null when every result is null', () => {
    expect(variantCost([resultEvent(null), resultEvent(null)])).toBeNull();
  });

  it('returns null for history with no result events', () => {
    expect(variantCost([{ kind: 'stderr', text: 'oops' }])).toBeNull();
    expect(variantCost([])).toBeNull();
  });

  it('ignores non-result events mixed in', () => {
    expect(variantCost([{ kind: 'stderr', text: 'oops' }, resultEvent(2)])).toBe(2);
  });
});

describe('diffStatOf', () => {
  it('sums additions and deletions and counts files', () => {
    expect(
      diffStatOf([
        { additions: 3, deletions: 1 },
        { additions: 0, deletions: 5 },
      ]),
    ).toEqual({ files: 2, added: 3, removed: 6 });
  });

  it('counts a binary entry as a file with no lines', () => {
    expect(diffStatOf([{ additions: 0, deletions: 0 }])).toEqual({
      files: 1,
      added: 0,
      removed: 0,
    });
  });

  it('is {0, 0, 0} for no entries', () => {
    expect(diffStatOf([])).toEqual({ files: 0, added: 0, removed: 0 });
  });
});

describe('sortVariantRows', () => {
  it('orders by label A, B, C with unlabelled rows last', () => {
    const rows: { label: VariantLabel | null; id: string }[] = [
      { label: 'C', id: '3' },
      { label: null, id: 'u' },
      { label: 'A', id: '1' },
      { label: 'B', id: '2' },
    ];
    expect(sortVariantRows(rows).map((r) => r.id)).toEqual(['1', '2', '3', 'u']);
  });

  it('does not mutate the input array', () => {
    const rows: { label: VariantLabel | null }[] = [{ label: 'B' }, { label: 'A' }];
    const copy = [...rows];
    sortVariantRows(rows);
    expect(rows).toEqual(copy);
  });
});

describe('planVariantPick', () => {
  const pickLeader = task({ id: 'L' });
  const rowA = row('A1', 'A', 'done');
  const rowB = row('B1', 'B', 'running');
  const rowC = row('C1', 'C', 'pending');
  const rows = [rowA, rowB, rowC];

  it('picks the named row, losing the rest', () => {
    expect(planVariantPick(pickLeader, rows, 'B1')).toEqual({ winner: rowB, losers: [rowA, rowC] });
  });

  it('is a no-op re-picking the current winner, even once it has dropped out of rows', () => {
    const picked = { ...pickLeader, pickedVariantId: 'B1' };
    expect(planVariantPick(picked, rows, 'B1')).toEqual({ noop: true });
    expect(planVariantPick(picked, [], 'B1')).toEqual({ noop: true });
  });

  it('refuses a missing or archived leader as unknown-task', () => {
    expect(planVariantPick(undefined, rows, 'B1')).toEqual({ refused: 'unknown-task' });
    expect(planVariantPick({ ...pickLeader, archivedAt: 1 }, rows, 'B1')).toEqual({
      refused: 'unknown-task',
    });
  });

  it('refuses an id that is not a live row of this leader', () => {
    expect(planVariantPick(pickLeader, rows, 'nope')).toEqual({ refused: 'not-a-variant' });
    expect(
      planVariantPick(pickLeader, [task({ id: 'other', variantOf: 'other-leader' })], 'other'),
    ).toEqual({ refused: 'not-a-variant' });
  });

  it('refuses a different id once already picked, before a merge, as already-picked', () => {
    const picked = { ...pickLeader, pickedVariantId: 'B1' };
    expect(planVariantPick(picked, rows, 'C1')).toEqual({ refused: 'already-picked' });
  });

  it('refuses a different id once already picked AND merged, as already-merged', () => {
    const picked = { ...pickLeader, pickedVariantId: 'B1', landedAt: 123 };
    expect(planVariantPick(picked, rows, 'C1')).toEqual({ refused: 'already-merged' });
  });

  it('gives each refusal its own sentence, reusing unknown-task’s from the run refusals', () => {
    expect(VARIANT_PICK_REFUSAL_MESSAGE['unknown-task']).toBe(RUN_REFUSAL_MESSAGE['unknown-task']);
    const texts = Object.values(VARIANT_PICK_REFUSAL_MESSAGE);
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe('pickNote', () => {
  it('names the winner and the discarded labels for a ×3 pick', () => {
    expect(pickNote({ variantLabel: 'B' }, 3)).toBe('Picked B of 3 — discarded A, C.');
  });

  it('names the winner and the one discarded label for a ×2 pick', () => {
    expect(pickNote({ variantLabel: 'A' }, 2)).toBe('Picked A of 2 — discarded B.');
  });
});

describe('variantWorkOwner', () => {
  const card = task({ id: 'C' });
  const leaderWithRows = task({ id: 'L' });
  const liveRows = [
    { id: 'A1', variantOf: 'L' },
    { id: 'B1', variantOf: 'L' },
  ];
  const noGetTask = () => undefined;

  it('resolves an ordinary card to itself', () => {
    expect(variantWorkOwner(card, [], noGetTask)).toEqual({ ownerId: 'C' });
  });

  it('resolves a variant row itself to itself, never to its leader', () => {
    const variantRow = task({ id: 'A1', variantOf: 'L' });
    expect(variantWorkOwner(variantRow, liveRows, noGetTask)).toEqual({ ownerId: 'A1' });
  });

  it('resolves a leader with no pick and live rows to the "pick a variant" refusal', () => {
    expect(variantWorkOwner(leaderWithRows, liveRows, noGetTask)).toEqual({
      refused: PICK_VARIANT_FIRST,
    });
  });

  it('resolves a leader with no pick and no live rows left to itself', () => {
    expect(variantWorkOwner(leaderWithRows, [], noGetTask)).toEqual({ ownerId: 'L' });
  });

  it('resolves a picked leader to the picked row, merged or not', () => {
    const picked = { ...leaderWithRows, pickedVariantId: 'B1' };
    expect(variantWorkOwner(picked, liveRows, noGetTask)).toEqual({ ownerId: 'B1' });
  });

  it('resolves a step through its parent card', () => {
    const step = task({ id: 'S', parentTaskId: 'C' });
    const getTask = (id: string) => (id === 'C' ? card : undefined);
    expect(variantWorkOwner(step, [], getTask)).toEqual({ ownerId: 'C' });
  });

  it('resolves a step through a picked leader parent', () => {
    const picked = { ...leaderWithRows, pickedVariantId: 'B1' };
    const step = task({ id: 'S', parentTaskId: 'L' });
    const getTask = (id: string) => (id === 'L' ? picked : undefined);
    expect(variantWorkOwner(step, liveRows, getTask)).toEqual({ ownerId: 'B1' });
  });

  it('resolves a step through an unpicked leader parent to the same refusal', () => {
    const step = task({ id: 'S', parentTaskId: 'L' });
    const getTask = (id: string) => (id === 'L' ? leaderWithRows : undefined);
    expect(variantWorkOwner(step, liveRows, getTask)).toEqual({ refused: PICK_VARIANT_FIRST });
  });

  it('falls back to the step itself if its parent cannot be found', () => {
    const step = task({ id: 'S', parentTaskId: 'gone' });
    expect(variantWorkOwner(step, [], noGetTask)).toEqual({ ownerId: 'S' });
  });
});
