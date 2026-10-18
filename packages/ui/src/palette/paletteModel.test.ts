/**
 * `paletteModel.ts`'s pure logic: `paletteScore`'s all-tokens-required, order-independent,
 * boundary-beats-mid-word scoring (now including a command's `prefix` among its keywords);
 * `rankCommands`'s group-then-score-then-locality ordering, grouped `actions, cards, navigate,
 * projects` per the v10 mockup; and `paletteReduce`'s open/close/query/move/select/refine/failed
 * transitions, including the closed-state no-op rule, `move`'s wraparound, `select`'s
 * secondary/index/no-double-select rules, `refine`'s active-row-to-query no-op-when-empty rule
 * and `failed`'s error state. Acceptance cases named in the design: `"fix bug"` hides "fix
 * login" but matches "fix the bug" in either token order; `"log"` ranks "Open log" (a boundary
 * hit) over "Catalog" (mid-word); and a numeric query ranks a title containing it above a row
 * whose id merely contains it. Also covers the pure helpers the component holds no logic of its
 * own for: `groupRows`, `paletteKeyEvent` (including its `Tab` → `refine` mapping, and why
 * Shift/Ctrl/⌘+Tab map to `null` instead) and `runSelected`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  collectCommands,
  groupRows,
  initialPaletteState,
  paletteKeyEvent,
  paletteReduce,
  paletteScore,
  PALETTE_GROUP_LABELS,
  PALETTE_GROUP_ORDER,
  rankCommands,
  runSelected,
  type PaletteCommand,
  type PaletteContext,
  type PaletteSource,
  type PaletteState,
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
    const ctx: PaletteContext = { currentProjectId: 'p1', subjectLabel: null };

    expect(rankCommands(commands, '', ctx).map((c) => c.id)).toEqual([
      'act1',
      'cardA',
      'cardB',
      'cardC',
      'nav1',
      'proj1',
    ]);
    expect(PALETTE_GROUP_ORDER).toEqual(['actions', 'cards', 'navigate', 'projects']);
  });

  it('matches a query against prefix the same way it does subtitle', () => {
    const commands = [command({ id: 'a', title: 'Fix the thing', prefix: 'PROJ-767' })];
    const ctx: PaletteContext = { currentProjectId: null, subjectLabel: null };

    expect(rankCommands(commands, 'PROJ-767', ctx).map((c) => c.id)).toEqual(['a']);
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

describe('paletteReduce: refine', () => {
  const commands = [
    command({ id: 'a', title: 'Alpha task' }),
    command({ id: 'b', title: 'Beta task' }),
  ];
  const ctx: PaletteContext = { currentProjectId: null };

  it('sets the query to the active row title and re-ranks', () => {
    const opened = paletteReduce(initialPaletteState, { type: 'open', commands, ctx });
    const moved = paletteReduce(opened, { type: 'move', delta: 1 });
    expect(moved.rows[moved.activeIndex]?.id).toBe('b');

    const refined = paletteReduce(moved, { type: 'refine' });
    expect(refined.query).toBe('Beta task');
    expect(refined.rows.map((c) => c.id)).toEqual(['b']);
    expect(refined.activeIndex).toBe(0);
    expect(refined.selected).toBeNull();
  });

  it('is a no-op when there are no rows', () => {
    const opened = paletteReduce(initialPaletteState, { type: 'open', commands: [], ctx });
    expect(paletteReduce(opened, { type: 'refine' })).toBe(opened);
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

describe('paletteReduce: select with secondary', () => {
  const ctx: PaletteContext = { currentProjectId: null };

  it('sets secondary: true when the active row has a secondary action', () => {
    const commands = [command({ id: 'a', secondary: { title: 'Open in new tab', run: noop } })];
    const opened = paletteReduce(initialPaletteState, { type: 'open', commands, ctx });

    const selected = paletteReduce(opened, { type: 'select', secondary: true });
    expect(selected.selected?.id).toBe('a');
    expect(selected.secondary).toBe(true);
  });

  it('is a no-op when the active row has no secondary action', () => {
    const commands = [command({ id: 'a' })];
    const opened = paletteReduce(initialPaletteState, { type: 'open', commands, ctx });

    const selected = paletteReduce(opened, { type: 'select', secondary: true });
    expect(selected).toBe(opened);
  });
});

describe('paletteReduce: select with index', () => {
  const commands = [command({ id: 'a' }), command({ id: 'b' }), command({ id: 'c' })];
  const ctx: PaletteContext = { currentProjectId: null };

  it('picks the row at index and moves activeIndex to it', () => {
    const opened = paletteReduce(initialPaletteState, { type: 'open', commands, ctx });

    const selected = paletteReduce(opened, { type: 'select', index: 2 });
    expect(selected.activeIndex).toBe(2);
    expect(selected.selected?.id).toBe('c');
  });

  it('is a no-op for an out-of-range index', () => {
    const opened = paletteReduce(initialPaletteState, { type: 'open', commands, ctx });

    expect(paletteReduce(opened, { type: 'select', index: 99 })).toBe(opened);
    expect(paletteReduce(opened, { type: 'select', index: -1 })).toBe(opened);
  });

  it('ignores a second select once selected is already set', () => {
    const opened = paletteReduce(initialPaletteState, { type: 'open', commands, ctx });
    const selected = paletteReduce(opened, { type: 'select', index: 0 });

    const reselected = paletteReduce(selected, { type: 'select', index: 2 });
    expect(reselected).toBe(selected);
    expect(reselected.selected?.id).toBe('a');
  });
});

describe('paletteReduce: failed', () => {
  const commands = [command({ id: 'a' }), command({ id: 'b' })];
  const ctx: PaletteContext = { currentProjectId: null };

  it('sets error, clears selected and keeps open', () => {
    const opened = paletteReduce(initialPaletteState, { type: 'open', commands, ctx });
    const selected = paletteReduce(opened, { type: 'select', index: 0 });

    const failed = paletteReduce(selected, { type: 'failed', message: 'boom' });
    expect(failed.error).toBe('boom');
    expect(failed.selected).toBeNull();
    expect(failed.open).toBe(true);
  });

  it('is a no-op while closed', () => {
    expect(paletteReduce(initialPaletteState, { type: 'failed', message: 'boom' })).toBe(
      initialPaletteState,
    );
  });
});

describe('paletteReduce: error lifecycle around query, move, open and close', () => {
  const commands = [command({ id: 'a' }), command({ id: 'b' })];
  const ctx: PaletteContext = { currentProjectId: null };

  it('query clears error', () => {
    const opened = paletteReduce(initialPaletteState, { type: 'open', commands, ctx });
    const selected = paletteReduce(opened, { type: 'select', index: 0 });
    const failed = paletteReduce(selected, { type: 'failed', message: 'boom' });

    const queried = paletteReduce(failed, { type: 'query', query: 'a' });
    expect(queried.error).toBeNull();
  });

  it('move keeps error', () => {
    const opened = paletteReduce(initialPaletteState, { type: 'open', commands, ctx });
    const selected = paletteReduce(opened, { type: 'select', index: 0 });
    const failed = paletteReduce(selected, { type: 'failed', message: 'boom' });

    const moved = paletteReduce(failed, { type: 'move', delta: 1 });
    expect(moved.error).toBe('boom');
  });

  it('close from an error state resets', () => {
    const opened = paletteReduce(initialPaletteState, { type: 'open', commands, ctx });
    const selected = paletteReduce(opened, { type: 'select', index: 0 });
    const failed = paletteReduce(selected, { type: 'failed', message: 'boom' });

    expect(paletteReduce(failed, { type: 'close' })).toEqual(initialPaletteState);
  });

  it('open resets error', () => {
    const opened = paletteReduce(initialPaletteState, { type: 'open', commands, ctx });
    const selected = paletteReduce(opened, { type: 'select', index: 0 });
    const failed = paletteReduce(selected, { type: 'failed', message: 'boom' });

    const reopened = paletteReduce(failed, { type: 'open', commands, ctx });
    expect(reopened.error).toBeNull();
  });
});

describe('paletteKeyEvent', () => {
  const base = { key: '', ctrlKey: false, metaKey: false };

  it('maps ArrowDown to move +1', () => {
    expect(paletteKeyEvent({ ...base, key: 'ArrowDown' })).toEqual({ type: 'move', delta: 1 });
  });

  it('maps ArrowUp to move -1', () => {
    expect(paletteKeyEvent({ ...base, key: 'ArrowUp' })).toEqual({ type: 'move', delta: -1 });
  });

  it('maps Enter to select', () => {
    expect(paletteKeyEvent({ ...base, key: 'Enter' })).toEqual({ type: 'select' });
  });

  it('maps Ctrl+Enter to select with secondary: true', () => {
    expect(paletteKeyEvent({ ...base, key: 'Enter', ctrlKey: true })).toEqual({
      type: 'select',
      secondary: true,
    });
  });

  it('maps Meta+Enter to select with secondary: true', () => {
    expect(paletteKeyEvent({ ...base, key: 'Enter', metaKey: true })).toEqual({
      type: 'select',
      secondary: true,
    });
  });

  it('maps Escape to close', () => {
    expect(paletteKeyEvent({ ...base, key: 'Escape' })).toEqual({ type: 'close' });
  });

  it('maps a plain Tab to refine', () => {
    expect(paletteKeyEvent({ ...base, key: 'Tab' })).toEqual({ type: 'refine' });
  });

  it('returns null for Shift+Tab', () => {
    expect(paletteKeyEvent({ ...base, key: 'Tab', shiftKey: true })).toBeNull();
  });

  it('returns null for Ctrl+Tab', () => {
    expect(paletteKeyEvent({ ...base, key: 'Tab', ctrlKey: true })).toBeNull();
  });

  it('returns null for Meta+Tab', () => {
    expect(paletteKeyEvent({ ...base, key: 'Tab', metaKey: true })).toBeNull();
  });

  it('returns null while composing', () => {
    expect(paletteKeyEvent({ ...base, key: 'Enter', isComposing: true })).toBeNull();
  });

  it('returns null for an unrelated key', () => {
    expect(paletteKeyEvent({ ...base, key: 'a' })).toBeNull();
  });
});

describe('groupRows', () => {
  it('preserves the flat indices and the group order', () => {
    const rows = [
      command({ id: 'nav1', group: 'navigate' }),
      command({ id: 'act1', group: 'actions' }),
      command({ id: 'cardA', group: 'cards' }),
      command({ id: 'cardB', group: 'cards' }),
    ];

    const grouped = groupRows(rows);

    expect(grouped.map((g) => g.group)).toEqual(['actions', 'cards', 'navigate']);
    expect(grouped.map((g) => g.label)).toEqual([
      PALETTE_GROUP_LABELS.actions,
      PALETTE_GROUP_LABELS.cards,
      PALETTE_GROUP_LABELS.navigate,
    ]);

    const cardsGroup = grouped.find((g) => g.group === 'cards');
    expect(cardsGroup?.items).toEqual([
      { command: rows[2], index: 2 },
      { command: rows[3], index: 3 },
    ]);

    const navigateGroup = grouped.find((g) => g.group === 'navigate');
    expect(navigateGroup?.items).toEqual([{ command: rows[0], index: 0 }]);
  });

  it('skips empty groups', () => {
    const rows = [command({ id: 'a', group: 'actions' })];
    expect(groupRows(rows).map((g) => g.group)).toEqual(['actions']);
  });
});

describe('runSelected', () => {
  const ctx: PaletteContext = { currentProjectId: null };

  it('returns null when nothing is selected', () => {
    expect(runSelected(initialPaletteState)).toBeNull();
  });

  it('returns the primary run when secondary is false', () => {
    const primaryRun = vi.fn();
    const commands = [command({ id: 'a', run: primaryRun })];
    const opened = paletteReduce(initialPaletteState, { type: 'open', commands, ctx });
    const selected = paletteReduce(opened, { type: 'select', index: 0 });

    expect(runSelected(selected)).toBe(primaryRun);
  });

  it('returns the secondary run when secondary is true', () => {
    const primaryRun = vi.fn();
    const secondaryRun = vi.fn();
    const commands = [
      command({ id: 'a', run: primaryRun, secondary: { title: 'Secondary', run: secondaryRun } }),
    ];
    const opened = paletteReduce(initialPaletteState, { type: 'open', commands, ctx });
    const selected = paletteReduce(opened, { type: 'select', index: 0, secondary: true });

    expect(runSelected(selected)).toBe(secondaryRun);
  });

  it('returns null when secondary is true but selected has no secondary action', () => {
    const state: PaletteState = {
      ...initialPaletteState,
      open: true,
      selected: command({ id: 'a' }),
      secondary: true,
    };

    expect(runSelected(state)).toBeNull();
  });
});
