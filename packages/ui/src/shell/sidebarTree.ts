/**
 * The sidebar tree's own keyboard model — pure, so the arrow/Home/End/type-ahead behaviour
 * (F13.11) can be proven without a DOM. Two pieces: {@link flattenVisible} turns
 * `sidebarModel.ts`'s `SidebarTreeNode` tree (which always carries every child, fold or no
 * fold — see that module's own header) into the flat, fold-aware row list a `role="tree"`
 * roving-tabindex actually walks; {@link treeKeyReducer} turns one keystroke plus that row list
 * into the next focus and, where the key asks for one, a fold toggle or an activation.
 */
import type { SidebarTreeNode } from './sidebarModel';

/** One row of the FOLD-AWARE flat list — a folded node's own row is still here, but its
 *  children are not, which is the whole of what distinguishes this from the tree itself. */
export interface SidebarVisibleRow {
  id: string;
  depth: number;
  parentId: string | null;
  hasChildren: boolean;
  /** Always `false` for a leaf — there is nothing to expand. */
  expanded: boolean;
  label: string;
  ticketKey?: string;
}

function visit(
  nodes: readonly SidebarTreeNode[],
  depth: number,
  parentId: string | null,
  folds: ReadonlySet<string>,
  out: SidebarVisibleRow[],
): void {
  for (const node of nodes) {
    const hasChildren = node.children.length > 0;
    const expanded = hasChildren && !folds.has(node.id);
    out.push({
      id: node.id,
      depth,
      parentId,
      hasChildren,
      expanded,
      label: node.label,
      ticketKey: node.ticketKey,
    });
    if (expanded) visit(node.children, depth + 1, node.id, folds, out);
  }
}

/** `tree` depth-first, a folded node's children left out — the model itself never hides
 *  them (see `sidebarModel.ts`'s own `SidebarTreeNode` doc), so this is the one place that
 *  decides what is actually visible. */
export function flattenVisible(
  tree: readonly SidebarTreeNode[],
  folds: ReadonlySet<string>,
): SidebarVisibleRow[] {
  const out: SidebarVisibleRow[] = [];
  visit(tree, 0, null, folds, out);
  return out;
}

export interface TreeTypeahead {
  buffer: string;
}

export interface TreeKeyState {
  focusId: string | null;
  typeahead: TreeTypeahead;
}

export interface TreeKeyResult {
  focusId: string | null;
  typeahead: TreeTypeahead;
  /** Present when the key asks a node's fold to change — the caller owns applying it. */
  toggle?: { id: string; open: boolean };
  /** Present when Enter/Space asks the focused row to open. */
  activate?: string;
}

/** `buffer`'s next match in `rows`, starting just AFTER whichever row is focused and wrapping
 *  all the way around — so repeating the same letter cycles through every match, and a buffer
 *  that only the current row still satisfies lands back on it. `null` when nothing matches. */
function typeaheadMatch(
  rows: readonly SidebarVisibleRow[],
  buffer: string,
  focusId: string | null,
): string | null {
  const lower = buffer.toLowerCase();
  const n = rows.length;
  if (n === 0 || lower === '') return null;
  const matches = (row: SidebarVisibleRow): boolean =>
    row.label.toLowerCase().startsWith(lower) ||
    (row.ticketKey?.toLowerCase().startsWith(lower) ?? false);
  const startIndex = Math.max(
    0,
    rows.findIndex((row) => row.id === focusId),
  );
  for (let offset = 1; offset <= n; offset++) {
    const row = rows[(startIndex + offset) % n];
    if (matches(row)) return row.id;
  }
  return null;
}

/** A key that types a literal character — `' '` (Space) is excluded, since it activates
 *  rather than searches, same as Enter. */
function isPrintable(key: string): boolean {
  return key.length === 1 && key !== ' ';
}

/**
 * One keystroke's effect on the tree: the next focus, and — only when the key asks for one —
 * a fold `toggle` or an `activate`. `rows` is this render's {@link flattenVisible} output, so
 * every index lookup here is against exactly what is on screen.
 *
 * ArrowDown/Up move through `rows` as given — already fold-aware, so a folded subtree is
 * simply not in the list to move into. ArrowRight on a collapsed branch expands it in place;
 * on an expanded one, moves onto its first child (the very next row, once expanded); on a
 * leaf, does nothing. ArrowLeft on an expanded branch collapses it in place; otherwise moves
 * up onto the parent, if any. Home/End jump to the first/last row. Enter/Space activate the
 * focused row. Any other single character extends the type-ahead buffer and jumps to its next
 * match; every other key leaves the buffer untouched, and every key ABOVE resets it — the
 * caller's own idle timer is what clears it after a pause, not a key here.
 */
export function treeKeyReducer(
  state: TreeKeyState,
  key: string,
  rows: readonly SidebarVisibleRow[],
): TreeKeyResult {
  const empty: TreeTypeahead = { buffer: '' };
  const index = rows.findIndex((row) => row.id === state.focusId);

  switch (key) {
    case 'ArrowDown': {
      if (rows.length === 0) return { focusId: state.focusId, typeahead: empty };
      const next = index === -1 ? 0 : Math.min(index + 1, rows.length - 1);
      return { focusId: rows[next].id, typeahead: empty };
    }
    case 'ArrowUp': {
      if (rows.length === 0) return { focusId: state.focusId, typeahead: empty };
      const prev = index === -1 ? 0 : Math.max(index - 1, 0);
      return { focusId: rows[prev].id, typeahead: empty };
    }
    case 'ArrowRight': {
      if (index === -1) return { focusId: state.focusId, typeahead: empty };
      const row = rows[index];
      if (!row.hasChildren) return { focusId: row.id, typeahead: empty };
      if (!row.expanded) {
        return { focusId: row.id, toggle: { id: row.id, open: true }, typeahead: empty };
      }
      const child = rows[index + 1];
      if (child && child.parentId === row.id) return { focusId: child.id, typeahead: empty };
      return { focusId: row.id, typeahead: empty };
    }
    case 'ArrowLeft': {
      if (index === -1) return { focusId: state.focusId, typeahead: empty };
      const row = rows[index];
      if (row.hasChildren && row.expanded) {
        return { focusId: row.id, toggle: { id: row.id, open: false }, typeahead: empty };
      }
      if (row.parentId) return { focusId: row.parentId, typeahead: empty };
      return { focusId: row.id, typeahead: empty };
    }
    case 'Home':
      return { focusId: rows.length > 0 ? rows[0].id : state.focusId, typeahead: empty };
    case 'End':
      return {
        focusId: rows.length > 0 ? rows[rows.length - 1].id : state.focusId,
        typeahead: empty,
      };
    case 'Enter':
    case ' ':
      return {
        focusId: state.focusId,
        typeahead: empty,
        activate: state.focusId ?? undefined,
      };
    default: {
      if (!isPrintable(key)) return { focusId: state.focusId, typeahead: state.typeahead };
      // Repeating the SAME letter ("b", "b", "b", …) is the classic listbox cycle: it does
      // not narrow the query to "bbb", it replays the single-letter search from wherever the
      // last one landed, so each press steps to the next row sharing that one letter.
      const prevBuffer = state.typeahead.buffer;
      const isRepeat =
        prevBuffer.length > 0 &&
        [...prevBuffer].every((char) => char.toLowerCase() === key.toLowerCase());
      const buffer = isRepeat ? prevBuffer : prevBuffer + key;
      const matchId = typeaheadMatch(rows, buffer, state.focusId);
      return { focusId: matchId ?? state.focusId, typeahead: { buffer } };
    }
  }
}
