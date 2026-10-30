/**
 * `sameCardRow` (F29.3): a card redraws for a change to itself or its steps, and for nothing
 * else on the board.
 */
import { describe, expect, it } from 'vitest';
import type { TaskSummary } from '@tm/shared/taskSummary';
import type { BoardCard } from './boardColumns';
import { sameCardRow, sameShallow, type BoardCardRowProps } from './cardMemo';

function summary(id: string, fields: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id,
    title: `Task ${id}`,
    type: 'feature',
    status: 'pending',
    projectId: 'p1',
    source: 'internal',
    createdAt: 0,
    updatedAt: 0,
    ...fields,
  } as TaskSummary;
}

const noop = (): void => {};

function card(task: TaskSummary, subtasks: TaskSummary[] = []): BoardCard {
  return { task, subtasks, mergeRequests: [], variants: { state: 'none', rows: [] } };
}

function row(c: BoardCard, fields: Partial<BoardCardRowProps> = {}): BoardCardRowProps {
  return {
    card: c,
    selected: false,
    dragging: false,
    draggable: true,
    onSelect: noop,
    onDragStart: noop,
    onDragEnd: noop,
    ...fields,
  };
}

describe('sameCardRow', () => {
  const step = summary('s1', { parentTaskId: 'a' });
  const a = summary('a');
  const base = card(a, [step]);

  it('is equal when an unrelated id joins liveRunTaskIds', () => {
    const prev = row(base, { liveRunTaskIds: new Set(['x']) });
    const next = row(base, { liveRunTaskIds: new Set(['x', 'y']) });
    expect(sameCardRow(prev, next)).toBe(true);
  });

  it('is unequal when this card joins liveRunTaskIds', () => {
    const prev = row(base, { liveRunTaskIds: new Set() });
    const next = row(base, { liveRunTaskIds: new Set(['a']) });
    expect(sameCardRow(prev, next)).toBe(false);
  });

  it("is unequal when one of this card's steps joins liveRunTaskIds", () => {
    const prev = row(base, { liveRunTaskIds: new Set() });
    const next = row(base, { liveRunTaskIds: new Set(['s1']) });
    expect(sameCardRow(prev, next)).toBe(false);
  });

  it('treats an absent set and one without this card the same', () => {
    expect(sameCardRow(row(base), row(base, { attentionTaskIds: new Set(['z']) }))).toBe(true);
  });

  it('compares the maps by this card and its steps only', () => {
    const prev = row(base, { runStartedAt: new Map([['x', 1]]) });
    expect(sameCardRow(prev, row(base, { runStartedAt: new Map([['x', 2]]) }))).toBe(true);
    expect(sameCardRow(prev, row(base, { runStartedAt: new Map([['s1', 2]]) }))).toBe(false);
  });

  it("reads dimming and the link gesture's answer for this card only", () => {
    expect(sameCardRow(row(base), row(base, { dimmedTaskIds: new Set(['s1']) }))).toBe(true);
    expect(sameCardRow(row(base), row(base, { dimmedTaskIds: new Set(['a']) }))).toBe(false);
    expect(sameCardRow(row(base), row(base, { linkStates: new Map([['a', 'valid']]) }))).toBe(
      false,
    );
  });

  it('is unequal when the summary changes', () => {
    const changed = card(summary('a', { title: 'Renamed' }), [step]);
    expect(sameCardRow(row(base), row(changed))).toBe(false);
  });

  it('is equal for a rebuilt card holding identical subtasks', () => {
    // `bucketBoardCards` builds a new card and a new array on every pass; F29.2 keeps the
    // summaries themselves the same objects.
    const rebuilt = card(a, [step]);
    expect(rebuilt.subtasks).not.toBe(base.subtasks);
    expect(sameCardRow(row(base), row(rebuilt))).toBe(true);
  });

  it('is unequal when a step summary changes', () => {
    const rebuilt = card(a, [summary('s1', { parentTaskId: 'a', status: 'running' })]);
    expect(sameCardRow(row(base), row(rebuilt))).toBe(false);
  });

  it('compares chain state and link chips by content', () => {
    const chain = () => ({
      waitingOn: [step],
      mergeHeld: [],
      waitReasons: ['waits for s1'],
      ready: false,
      blocked: null,
      queued: false,
    });
    const chips = () => ({ needs: [{ key: 'TM-1', tone: 'waiting' as const }], unblocks: [] });
    expect(
      sameCardRow(
        row(base, { chain: chain(), linkChips: chips() }),
        row(base, { chain: chain(), linkChips: chips() }),
      ),
    ).toBe(true);
    expect(
      sameCardRow(row(base, { chain: chain() }), row(base, { chain: { ...chain(), ready: true } })),
    ).toBe(false);
  });

  it('compares everything else shallowly', () => {
    expect(sameCardRow(row(base), row(base, { selected: true }))).toBe(false);
    expect(sameCardRow(row(base), row(base, { onSelect: () => {} }))).toBe(false);
    expect(sameCardRow(row(base, { agentName: 'x' }), row(base, { agentName: 'x' }))).toBe(true);
  });
});

describe('sameShallow', () => {
  it('stops at its depth', () => {
    expect(sameShallow({ a: [1] }, { a: [1] }, 2)).toBe(true);
    expect(sameShallow({ a: [1] }, { a: [1] }, 1)).toBe(false);
  });

  it('tells a missing key from one set to undefined', () => {
    expect(sameShallow({ a: undefined }, { b: undefined }, 2)).toBe(false);
  });
});
