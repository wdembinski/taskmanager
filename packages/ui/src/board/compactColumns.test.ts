import { describe, expect, it } from 'vitest';
import type { BoardColumn, Task } from '@tm/shared/model';
import { parseCompactRoute, type CompactRoute } from '../layout/compactRoute';
import type { BoardCard } from './boardColumns';
import { activeCompactColumn, columnSwitcherItems } from './compactColumns';

function cards(n: number): BoardCard[] {
  return Array.from({ length: n }, (_, i) => ({
    task: { id: `t${i}` } as Task,
    subtasks: [],
    mergeRequests: [],
    variants: { state: 'none', rows: [] },
  }));
}

describe('columnSwitcherItems', () => {
  it('counts match the number of cards in each column', () => {
    const cardsByColumn = new Map<BoardColumn, BoardCard[]>([
      ['todo', cards(3)],
      ['in-progress', cards(1)],
    ]);
    const items = columnSwitcherItems(cardsByColumn, []);
    expect(items.find((i) => i.column === 'todo')?.count).toBe(3);
    expect(items.find((i) => i.column === 'in-progress')?.count).toBe(1);
    expect(items.find((i) => i.column === 'done')?.count).toBe(0);
  });

  it('omits hidden columns', () => {
    const items = columnSwitcherItems(new Map(), ['blocked', 'done']);
    expect(items.map((i) => i.column)).toEqual(['todo', 'in-progress', 'in-review']);
  });
});

describe('activeCompactColumn', () => {
  const visible: BoardColumn[] = ['todo', 'in-progress', 'in-review', 'blocked', 'done'];

  it("uses the board route's own column, resolved through parseCompactRoute", () => {
    const route = parseCompactRoute('#/board/in-review');
    expect(route).toEqual({ kind: 'board', column: 'in-review' });
    expect(activeCompactColumn(route as CompactRoute, visible)).toBe('in-review');
  });

  it("falls back to the first visible column when the route's column is hidden", () => {
    const route: CompactRoute = { kind: 'board', column: 'blocked' };
    expect(activeCompactColumn(route, ['todo', 'in-progress'])).toBe('todo');
  });

  it("uses the card's own column for a card route", () => {
    const route: CompactRoute = { kind: 'card', id: 'c1', section: 'chat' };
    expect(activeCompactColumn(route, visible, 'in-review')).toBe('in-review');
  });

  it('returns null when every column is hidden', () => {
    const route: CompactRoute = { kind: 'board', column: 'todo' };
    expect(activeCompactColumn(route, [])).toBeNull();
  });
});
