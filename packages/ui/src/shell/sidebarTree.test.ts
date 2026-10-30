import { describe, expect, it } from 'vitest';
import type { SidebarTreeNode } from './sidebarModel';
import {
  flattenVisible,
  focusIndexOf,
  pinnedTreeRows,
  treeKeyReducer,
  type TreeKeyState,
} from './sidebarTree';

function node(overrides: Partial<SidebarTreeNode> & Pick<SidebarTreeNode, 'id'>): SidebarTreeNode {
  return {
    kind: 'ticket',
    label: overrides.id,
    count: 0,
    folded: false,
    children: [],
    ...overrides,
  };
}

/**
 * M1 (expanded)
 *   E1 "Epic one" (expanded)
 *     T1 "Alpha"
 *     T2 "Alligator"
 *   E2 "Epic two" (folded, has children)
 *     T3 "Beta"
 * M2 "Milestone two" (no children, a leaf)
 */
function sampleTree(): SidebarTreeNode[] {
  return [
    node({
      id: 'm1',
      kind: 'milestone',
      label: 'M1',
      children: [
        node({
          id: 'e1',
          kind: 'epic',
          label: 'Epic one',
          children: [
            node({ id: 't1', label: 'Alpha', ticketKey: 'TM-1' }),
            node({ id: 't2', label: 'Alligator', ticketKey: 'TM-2' }),
          ],
        }),
        node({
          id: 'e2',
          kind: 'epic',
          label: 'Epic two',
          children: [node({ id: 't3', label: 'Beta', ticketKey: 'TM-3' })],
        }),
      ],
    }),
    node({ id: 'm2', label: 'Milestone two' }),
  ];
}

describe('flattenVisible', () => {
  it('lists every row depth-first when nothing is folded', () => {
    const rows = flattenVisible(sampleTree(), new Set());
    expect(rows.map((r) => r.id)).toEqual(['m1', 'e1', 't1', 't2', 'e2', 't3', 'm2']);
  });

  it('carries depth, parentId, hasChildren and expanded', () => {
    const rows = flattenVisible(sampleTree(), new Set());
    const e1 = rows.find((r) => r.id === 'e1')!;
    expect(e1.depth).toBe(1);
    expect(e1.parentId).toBe('m1');
    expect(e1.hasChildren).toBe(true);
    expect(e1.expanded).toBe(true);

    const t1 = rows.find((r) => r.id === 't1')!;
    expect(t1.depth).toBe(2);
    expect(t1.parentId).toBe('e1');
    expect(t1.hasChildren).toBe(false);
    expect(t1.expanded).toBe(false);

    const m2 = rows.find((r) => r.id === 'm2')!;
    expect(m2.depth).toBe(0);
    expect(m2.parentId).toBeNull();
  });

  it('hides a folded node’s children, but keeps the folded node’s own row', () => {
    const rows = flattenVisible(sampleTree(), new Set(['e2']));
    expect(rows.map((r) => r.id)).toEqual(['m1', 'e1', 't1', 't2', 'e2', 'm2']);
    expect(rows.find((r) => r.id === 'e2')!.expanded).toBe(false);
  });

  it('hides a whole folded subtree, however deep', () => {
    const rows = flattenVisible(sampleTree(), new Set(['m1']));
    expect(rows.map((r) => r.id)).toEqual(['m1', 'm2']);
  });

  it('carries label and ticketKey for type-ahead to search', () => {
    const rows = flattenVisible(sampleTree(), new Set());
    expect(rows.find((r) => r.id === 't2')!.label).toBe('Alligator');
    expect(rows.find((r) => r.id === 't2')!.ticketKey).toBe('TM-2');
  });
});

const EMPTY_STATE: TreeKeyState = { focusId: null, typeahead: { buffer: '' } };

function focusedAt(id: string): TreeKeyState {
  return { focusId: id, typeahead: { buffer: '' } };
}

describe('treeKeyReducer — vertical movement', () => {
  it('ArrowDown from nothing focused lands on the first row', () => {
    const rows = flattenVisible(sampleTree(), new Set());
    const result = treeKeyReducer(EMPTY_STATE, 'ArrowDown', rows);
    expect(result.focusId).toBe('m1');
  });

  it('ArrowDown moves to the next visible row, skipping a folded subtree', () => {
    const rows = flattenVisible(sampleTree(), new Set(['e1']));
    const result = treeKeyReducer(focusedAt('e1'), 'ArrowDown', rows);
    expect(result.focusId).toBe('e2');
  });

  it('ArrowDown stops at the last row', () => {
    const rows = flattenVisible(sampleTree(), new Set());
    const result = treeKeyReducer(focusedAt('m2'), 'ArrowDown', rows);
    expect(result.focusId).toBe('m2');
  });

  it('ArrowUp moves to the previous visible row, skipping a folded subtree', () => {
    const rows = flattenVisible(sampleTree(), new Set(['e1']));
    const result = treeKeyReducer(focusedAt('e2'), 'ArrowUp', rows);
    expect(result.focusId).toBe('e1');
  });

  it('ArrowUp stops at the first row', () => {
    const rows = flattenVisible(sampleTree(), new Set());
    const result = treeKeyReducer(focusedAt('m1'), 'ArrowUp', rows);
    expect(result.focusId).toBe('m1');
  });
});

describe('treeKeyReducer — ArrowRight', () => {
  it('expands a collapsed branch in place, without moving focus', () => {
    const rows = flattenVisible(sampleTree(), new Set(['e2']));
    const result = treeKeyReducer(focusedAt('e2'), 'ArrowRight', rows);
    expect(result.focusId).toBe('e2');
    expect(result.toggle).toEqual({ id: 'e2', open: true });
  });

  it('moves onto the first child of an already-expanded branch', () => {
    const rows = flattenVisible(sampleTree(), new Set());
    const result = treeKeyReducer(focusedAt('e1'), 'ArrowRight', rows);
    expect(result.focusId).toBe('t1');
    expect(result.toggle).toBeUndefined();
  });

  it('is a no-op on a leaf', () => {
    const rows = flattenVisible(sampleTree(), new Set());
    const result = treeKeyReducer(focusedAt('t1'), 'ArrowRight', rows);
    expect(result.focusId).toBe('t1');
    expect(result.toggle).toBeUndefined();
  });
});

describe('treeKeyReducer — ArrowLeft', () => {
  it('collapses an expanded branch in place, without moving focus', () => {
    const rows = flattenVisible(sampleTree(), new Set());
    const result = treeKeyReducer(focusedAt('e1'), 'ArrowLeft', rows);
    expect(result.focusId).toBe('e1');
    expect(result.toggle).toEqual({ id: 'e1', open: false });
  });

  it('hops up to the parent from a leaf', () => {
    const rows = flattenVisible(sampleTree(), new Set());
    const result = treeKeyReducer(focusedAt('t1'), 'ArrowLeft', rows);
    expect(result.focusId).toBe('e1');
    expect(result.toggle).toBeUndefined();
  });

  it('hops up to the parent from an already-collapsed branch', () => {
    const rows = flattenVisible(sampleTree(), new Set(['e2']));
    const result = treeKeyReducer(focusedAt('e2'), 'ArrowLeft', rows);
    expect(result.focusId).toBe('m1');
  });

  it('is a no-op at the root with no parent', () => {
    const rows = flattenVisible(sampleTree(), new Set());
    const result = treeKeyReducer(focusedAt('m2'), 'ArrowLeft', rows);
    expect(result.focusId).toBe('m2');
  });
});

describe('treeKeyReducer — Home/End', () => {
  it('Home jumps to the first visible row', () => {
    const rows = flattenVisible(sampleTree(), new Set());
    const result = treeKeyReducer(focusedAt('t3'), 'Home', rows);
    expect(result.focusId).toBe('m1');
  });

  it('End jumps to the last visible row', () => {
    const rows = flattenVisible(sampleTree(), new Set());
    const result = treeKeyReducer(focusedAt('m1'), 'End', rows);
    expect(result.focusId).toBe('m2');
  });
});

describe('treeKeyReducer — activation', () => {
  it('Enter activates the focused row without moving it', () => {
    const rows = flattenVisible(sampleTree(), new Set());
    const result = treeKeyReducer(focusedAt('t1'), 'Enter', rows);
    expect(result.activate).toBe('t1');
    expect(result.focusId).toBe('t1');
  });

  it('Space activates the focused row the same way Enter does', () => {
    const rows = flattenVisible(sampleTree(), new Set());
    const result = treeKeyReducer(focusedAt('t1'), ' ', rows);
    expect(result.activate).toBe('t1');
  });

  it('activates nothing when nothing is focused', () => {
    const rows = flattenVisible(sampleTree(), new Set());
    const result = treeKeyReducer(EMPTY_STATE, 'Enter', rows);
    expect(result.activate).toBeUndefined();
  });
});

describe('treeKeyReducer — type-ahead', () => {
  it('jumps to the first row whose label starts with the typed letter', () => {
    const rows = flattenVisible(sampleTree(), new Set());
    const result = treeKeyReducer(EMPTY_STATE, 'b', rows);
    expect(result.focusId).toBe('t3'); // "Beta"
    expect(result.typeahead.buffer).toBe('b');
  });

  it('matches on ticketKey when no label starts with the buffer', () => {
    const rows = flattenVisible(sampleTree(), new Set());
    // No label starts with "tm", but every ticket's ticketKey ("TM-1"/"TM-2"/"TM-3") does.
    const afterT = treeKeyReducer(EMPTY_STATE, 't', rows);
    const result = treeKeyReducer(
      { focusId: afterT.focusId, typeahead: afterT.typeahead },
      'm',
      rows,
    );
    expect(result.typeahead.buffer).toBe('tm');
    // "tm" still matches t1's own ticketKey, but the search starts just AFTER the current
    // focus (same rule the plain narrowing test above relies on), so it lands on t2 first.
    expect(result.focusId).toBe('t2');
  });

  it('cycles through repeated matches on the same letter, wrapping around', () => {
    const rows = flattenVisible(sampleTree(), new Set());
    // Both "Alpha" (t1) and "Alligator" (t2) start with "a".
    const first = treeKeyReducer(EMPTY_STATE, 'a', rows);
    expect(first.focusId).toBe('t1');
    const second = treeKeyReducer({ focusId: 't1', typeahead: { buffer: 'a' } }, 'a', rows);
    expect(second.focusId).toBe('t2');
    const third = treeKeyReducer({ focusId: 't2', typeahead: { buffer: 'a' } }, 'a', rows);
    expect(third.focusId).toBe('t1');
  });

  it('extends the buffer across keystrokes to narrow the match', () => {
    const rows = flattenVisible(sampleTree(), new Set());
    const afterA = treeKeyReducer(EMPTY_STATE, 'a', rows);
    expect(afterA.focusId).toBe('t1'); // "Alpha"
    const afterAl = treeKeyReducer(
      { focusId: afterA.focusId, typeahead: afterA.typeahead },
      'l',
      rows,
    );
    expect(afterAl.typeahead.buffer).toBe('al');
    expect(afterAl.focusId).toBe('t2'); // "Alligator" — "al" no longer matches "Alpha" first in cycle order from t1
  });

  it('leaves focus unchanged when nothing matches', () => {
    const rows = flattenVisible(sampleTree(), new Set());
    const result = treeKeyReducer(focusedAt('t1'), 'z', rows);
    expect(result.focusId).toBe('t1');
    expect(result.typeahead.buffer).toBe('z');
  });

  it('a non-printable key resets the buffer without touching focus', () => {
    const rows = flattenVisible(sampleTree(), new Set());
    const result = treeKeyReducer({ focusId: 't1', typeahead: { buffer: 'a' } }, 'ArrowDown', rows);
    expect(result.typeahead.buffer).toBe('');
  });
});

describe('focusIndexOf', () => {
  const rows = flattenVisible(sampleTree(), new Set(['e2']));

  it("finds a visible row's index", () => {
    expect(focusIndexOf(rows, 't2')).toBe(3);
  });

  it('is -1 for no id, and for a row a fold hides', () => {
    expect(focusIndexOf(rows, null)).toBe(-1);
    expect(focusIndexOf(rows, 't3')).toBe(-1);
  });
});

describe('pinnedTreeRows', () => {
  const rows = flattenVisible(sampleTree(), new Set(['e2']));

  it('pins the focused and the selected row, ascending', () => {
    expect(pinnedTreeRows(rows, 'm2', 't1')).toEqual([2, 5]);
  });

  it('pins a row that is both focused and selected once', () => {
    expect(pinnedTreeRows(rows, 't1', 't1')).toEqual([2]);
  });

  it('pins nothing for absent or hidden rows', () => {
    expect(pinnedTreeRows(rows, null, null)).toEqual([]);
    expect(pinnedTreeRows(rows, 't3', 'gone')).toEqual([]);
  });
});
