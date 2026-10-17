/**
 * `linkMode`'s own rules: the cycle order, and what each mode means for a selection — the
 * part most likely to be wrong, since Off/All are trivial but Focus has to agree on exactly
 * which links are "direct" and which cards that leaves dimmed.
 */
import { describe, expect, it } from 'vitest';
import type { TaskLink } from '@tm/shared/taskChain';
import { LINK_MODES, linkView, nextLinkMode, type LinkMode } from './linkMode';

function link(id: string, fromTaskId: string, toTaskId: string): TaskLink {
  return { id, fromTaskId, toTaskId, gate: 'after-merge', createdAt: 0 };
}

describe('LINK_MODES / nextLinkMode', () => {
  it('cycles off -> focus -> all -> off', () => {
    expect(nextLinkMode('off')).toBe('focus');
    expect(nextLinkMode('focus')).toBe('all');
    expect(nextLinkMode('all')).toBe('off');
  });

  it('lists the modes in the order the switch cycles and reads them', () => {
    expect(LINK_MODES).toEqual(['off', 'focus', 'all']);
  });
});

describe('linkView', () => {
  // A -> B -> C, plus a D -> E chain the selection never touches.
  const links: TaskLink[] = [
    link('ab', 'a', 'b'),
    link('bc', 'b', 'c'),
    link('de', 'd', 'e'),
  ];

  it('draws nothing at all in Off, whatever the selection', () => {
    expect(linkView(links, 'off', 'b')).toEqual({
      drawn: false,
      litIds: new Set(),
      fadedLinkIds: new Set(),
      dimmedTaskIds: new Set(),
    });
  });

  it('draws everything at rest in All, with nothing faded or dimmed', () => {
    expect(linkView(links, 'all', 'b')).toEqual({
      drawn: true,
      litIds: new Set(),
      fadedLinkIds: new Set(),
      dimmedTaskIds: new Set(),
    });
  });

  it('is the same as All in Focus with no selection — nothing to focus on yet', () => {
    expect(linkView(links, 'focus', null)).toEqual({
      drawn: true,
      litIds: new Set(),
      fadedLinkIds: new Set(),
      dimmedTaskIds: new Set(),
    });
    expect(linkView(links, 'focus', undefined)).toEqual({
      drawn: true,
      litIds: new Set(),
      fadedLinkIds: new Set(),
      dimmedTaskIds: new Set(),
    });
  });

  it('lights only the direct links of the selected card in Focus', () => {
    const view = linkView(links, 'focus', 'b');
    expect(view.drawn).toBe(true);
    // b's own two links (to a and to c) are lit; d->e never touches b.
    expect(view.litIds).toEqual(new Set(['ab', 'bc']));
    expect(view.fadedLinkIds).toEqual(new Set(['de']));
  });

  it('dims cards that are neither the selection nor a direct neighbour', () => {
    const view = linkView(links, 'focus', 'b');
    // a and c are b's direct neighbours — not dimmed. d and e never touch b — dimmed.
    expect(view.dimmedTaskIds).toEqual(new Set(['d', 'e']));
  });

  it('never dims the selected card or its own neighbours', () => {
    const view = linkView(links, 'focus', 'b');
    expect(view.dimmedTaskIds.has('b')).toBe(false);
    expect(view.dimmedTaskIds.has('a')).toBe(false);
    expect(view.dimmedTaskIds.has('c')).toBe(false);
  });

  it('treats a leaf selection the same way — one lit link, the rest faded and dimmed', () => {
    const view = linkView(links, 'focus', 'a');
    expect(view.litIds).toEqual(new Set(['ab']));
    expect(view.fadedLinkIds).toEqual(new Set(['bc', 'de']));
    // c is reachable from a through b, but it is not a DIRECT neighbour of a — dimmed.
    expect(view.dimmedTaskIds).toEqual(new Set(['c', 'd', 'e']));
  });

  it('a selection touching no link at all fades and dims every link, but names no dimmed card twice', () => {
    const view = linkView(links, 'focus', 'z');
    expect(view.litIds).toEqual(new Set());
    expect(view.fadedLinkIds).toEqual(new Set(['ab', 'bc', 'de']));
    expect(view.dimmedTaskIds).toEqual(new Set(['a', 'b', 'c', 'd', 'e']));
  });

  it('is pure — the same inputs always answer the same way', () => {
    const first = linkView(links, 'focus', 'b');
    const second = linkView(links, 'focus', 'b');
    expect(first).toEqual(second);
  });

  // Exhaustiveness guard: every mode this union admits is one `linkView` actually handles,
  // so a fourth mode added later fails type-checking here before it fails silently at runtime.
  it('handles every mode in LINK_MODES', () => {
    for (const mode of LINK_MODES satisfies readonly LinkMode[]) {
      expect(() => linkView(links, mode, null)).not.toThrow();
    }
  });
});
