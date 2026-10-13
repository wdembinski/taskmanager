import { describe, expect, it } from 'vitest';
import type { LinkGate, TaskLink } from '@tm/shared/taskChain';
import { chainPosition } from './chainPosition';

function link(fromTaskId: string, toTaskId: string, gate: LinkGate = 'after-merge'): TaskLink {
  return { id: `${fromTaskId}->${toTaskId}`, fromTaskId, toTaskId, gate, createdAt: 0 };
}

describe('chainPosition', () => {
  it('gives null for a card with no links at all', () => {
    expect(chainPosition([], 'solo')).toBeNull();
  });

  it('gives null for a card not touched by any of the given links', () => {
    expect(chainPosition([link('a', 'b')], 'c')).toBeNull();
  });

  it('numbers a linear chain of 3 in order', () => {
    const links = [link('a', 'b'), link('b', 'c')];
    expect(chainPosition(links, 'a')).toEqual({ n: 1, m: 3 });
    expect(chainPosition(links, 'b')).toEqual({ n: 2, m: 3 });
    expect(chainPosition(links, 'c')).toEqual({ n: 3, m: 3 });
  });

  it("gives a fork's siblings the same step number, and numbers the join after both", () => {
    // a -> b -> d
    // a -> c -> d
    const links = [link('a', 'b'), link('a', 'c'), link('b', 'd'), link('c', 'd')];
    expect(chainPosition(links, 'a')).toEqual({ n: 1, m: 3 });
    expect(chainPosition(links, 'b')).toEqual({ n: 2, m: 3 });
    expect(chainPosition(links, 'c')).toEqual({ n: 2, m: 3 });
    expect(chainPosition(links, 'd')).toEqual({ n: 3, m: 3 });
  });

  it('does not hang on a cycle', () => {
    const links = [link('a', 'b'), link('b', 'a')];
    const result = chainPosition(links, 'a');
    expect(result).not.toBeNull();
    expect(Number.isFinite(result?.n)).toBe(true);
    expect(Number.isFinite(result?.m)).toBe(true);
  });
});
