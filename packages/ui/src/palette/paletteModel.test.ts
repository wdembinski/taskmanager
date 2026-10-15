/**
 * `paletteModel.ts`'s pure logic: `paletteScore`'s all-tokens-required, order-independent,
 * boundary-beats-mid-word scoring; `rankCommands`'s group-then-score-then-locality ordering;
 * and `paletteReduce`'s open/close/query/move/select transitions, including the closed-state
 * no-op rule and `move`'s wraparound. Acceptance cases named in the design: `"fix bug"` hides
 * "fix login" but matches "fix the bug" in either token order; `"log"` ranks "Open log" (a
 * boundary hit) over "Catalog" (mid-word); and a numeric query ranks a title containing it
 * above a row whose id merely contains it.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  collectCommands,
  initialPaletteState,
  paletteReduce,
  paletteScore,
  PALETTE_GROUP_ORDER,
  rankCommands,
  type PaletteCommand,
  type PaletteContext,
  type PaletteSource,
} from './paletteModel';

const noop = (): void => {};

const command = (over: Partial<PaletteCommand> & { id: string }): PaletteCommand => ({
  group: 'actions',
  title: over.id,
  run: noop,
  ...over,
});

describe('paletteScore', () => {
  it('requires every token to match, hiding a command missing one', () => {
    expect(paletteScore('Fix login', 'fix bug')).toBe(0);
  });

  it('matches when every token is present', () => {
    expect(paletteScore('Fix the bug', 'fix bug')).toBeGreaterThan(0);
  });

  it('matches regardless of token order', () => {
    expect(paletteScore('Fix the bug', 'fix bug')).toBe(paletteScore('Fix the bug', 'bug fix'));
  });

  it('matches everything with a blank or whitespace-only query', () => {
    expect(paletteScore('Anything at all', '')).toBe(1);
    expect(paletteScore('Anything at all', '   ')).toBe(1);
  });
});

describe('rankCommands', () => {
  it('hides a command missing a token, keeps one matching all of them', () => {
    const commands = [
      command({ id: 'login', title: 'Fix login' }),
      command({ id: 'bug', title: 'Fix the bug' }),
    ];
    const ctx: PaletteContext = { currentProjectId: null };

    expect(rankCommands(commands, 'fix bug', ctx).map((c) => c.id)).toEqual(['bug']);
  });

  it('matches tokens in any order', () => {
    const commands = [command({ id: 'bug', title: 'Fix the bug' })];
    const ctx: PaletteContext = { currentProjectId: null };

    expect(rankCommands(commands, 'bug fix', ctx).map((c) => c.id)).toEqual(['bug']);
  });

  it('shows every command, unfiltered, for a blank query', () => {
    const commands = [command({ id: 'a' }), command({ id: 'b' }), command({ id: 'c' })];
    const ctx: PaletteContext = { currentProjectId: null };

    expect(rankCommands(commands, '', ctx)).toHaveLength(3);
  });

  it('ranks a word-boundary hit above a mid-word hit', () => {
    const commands = [
      command({ id: 'catalog', title: 'Catalog' }),
      command({ id: 'open-log', title: 'Open log' }),
    ];
    const ctx: PaletteContext = { currentProjectId: null };

    expect(rankCommands(commands, 'log', ctx).map((c) => c.id)).toEqual(['open-log', 'catalog']);
  });

  it('ranks a title match above an id-only match for a numeric query', () => {
    const commands = [
      command({ id: 'row-767', title: 'Something else' }),
      command({ id: 'card-767', title: '767: fix' }),
    ];
    const ctx: PaletteContext = { currentProjectId: null };

    expect(rankCommands(commands, '767', ctx).map((c) => c.id)).toEqual(['card-767', 'row-767']);
  });

  it('for a blank query, groups by PALETTE_GROUP_ORDER, puts the current project first within a group, and otherwise keeps source order', () => {
    const commands = [
      command({ id: 'nav1', group: 'navigate' }),
      command({ id: 'cardB', group: 'cards', projectId: 'p2' }),
      command({ id: 'cardC', group: 'cards', projectId: null }),
      command({ id: 'cardA', group: 'cards', projectId: 'p1' }),
      command({ id: 'proj1', group: 'projects' }),
      command({ id: 'act1', group: 'actions' }),
    ];
    const ctx: PaletteContext = { currentProjectId: 'p1' };

    expect(rankCommands(commands, '', ctx).map((c) => c.id)).toEqual([
      'nav1',
      'cardA',
      'cardB',
      'cardC',
      'proj1',
      'act1',
    ]);
    expect(PALETTE_GROUP_ORDER).toEqual(['navigate', 'cards', 'projects', 'actions']);
  });
});

describe('paletteReduce: move', () => {
  const commands = [command({ id: 'a' }), command({ id: 'b' }), command({ id: 'c' })];
  const ctx: PaletteContext = { currentProjectId: null };

  it('wraps backwards from the first row to the last', () => {
    const opened = paletteReduce(initialPaletteState, { type: 'open', commands, ctx });
    expect(opened.activeIndex).toBe(0);

    const moved = paletteReduce(opened, { type: 'move', delta: -1 });
    expect(moved.activeIndex).toBe(2);
  });

  it('wraps forwards from the last row to the first', () => {
    const opened = paletteReduce(initialPaletteState, { type: 'open', commands, ctx });
    const atLast = paletteReduce(opened, { type: 'move', delta: -1 });
    expect(atLast.activeIndex).toBe(2);

    const wrapped = paletteReduce(atLast, { type: 'move', delta: 1 });
    expect(wrapped.activeIndex).toBe(0);
  });

  it('is a no-op when there are no rows', () => {
    const opened = paletteReduce(initialPaletteState, { type: 'open', commands: [], ctx });
    expect(opened.rows).toEqual([]);

    expect(paletteReduce(opened, { type: 'move', delta: 1 })).toBe(opened);
  });
});

describe('paletteReduce: select', () => {
  const commands = [command({ id: 'a' }), command({ id: 'b' }), command({ id: 'c' })];
  const ctx: PaletteContext = { currentProjectId: null };

  it('returns the identical state for an empty list', () => {
    const opened = paletteReduce(initialPaletteState, { type: 'open', commands: [], ctx });
    expect(paletteReduce(opened, { type: 'select' })).toBe(opened);
  });

  it('sets selected to the active row', () => {
    const opened = paletteReduce(initialPaletteState, { type: 'open', commands, ctx });
    const moved = paletteReduce(opened, { type: 'move', delta: 1 });

    const selected = paletteReduce(moved, { type: 'select' });
    expect(selected.selected).toBe(selected.rows[1]);
    expect(selected.selected?.id).toBe('b');
  });
});

describe('paletteReduce: query', () => {
  it('resets activeIndex and selected', () => {
    const commands = [command({ id: 'a' }), command({ id: 'b' }), command({ id: 'c' })];
    const ctx: PaletteContext = { currentProjectId: null };

    const opened = paletteReduce(initialPaletteState, { type: 'open', commands, ctx });
    const moved = paletteReduce(opened, { type: 'move', delta: 1 });
    const selected = paletteReduce(moved, { type: 'select' });
    expect(selected.activeIndex).toBe(1);
    expect(selected.selected).not.toBeNull();

    const queried = paletteReduce(selected, { type: 'query', query: 'b' });
    expect(queried.activeIndex).toBe(0);
    expect(queried.selected).toBeNull();
  });
});

describe('paletteReduce: closed state', () => {
  it('ignores query, move, select and close while closed', () => {
    expect(paletteReduce(initialPaletteState, { type: 'query', query: 'x' })).toBe(
      initialPaletteState,
    );
    expect(paletteReduce(initialPaletteState, { type: 'move', delta: 1 })).toBe(
      initialPaletteState,
    );
    expect(paletteReduce(initialPaletteState, { type: 'select' })).toBe(initialPaletteState);
    expect(paletteReduce(initialPaletteState, { type: 'close' })).toBe(initialPaletteState);
  });
});

describe('collectCommands', () => {
  it('passes ctx to every source and concatenates their commands in source order', () => {
    const ctx: PaletteContext = { currentProjectId: 'p1' };
    const source1: PaletteSource = vi.fn((c) => [command({ id: `s1-${c.currentProjectId}` })]);
    const source2: PaletteSource = vi.fn((c) => [command({ id: `s2-${c.currentProjectId}` })]);

    const result = collectCommands([source1, source2], ctx);

    expect(source1).toHaveBeenCalledWith(ctx);
    expect(source2).toHaveBeenCalledWith(ctx);
    expect(result.map((c) => c.id)).toEqual(['s1-p1', 's2-p1']);
  });
});
