/**
 * The two rules in the strip that do not need a browser to be wrong.
 *
 * Rendering and drag-and-drop are not testable here (Node-only Vitest, no jsdom), so what
 * is pinned is the pair of decisions a future edit could break silently: which drags the
 * strip is allowed to answer, and what a size reads as. The first matters most — the board
 * drags cards and draws chain links through the same `dragover`, and a predicate that
 * started saying `true` for those would have the pane eat a card drop.
 */
import { describe, expect, it } from 'vitest';
import { formatSize, isFileDrag } from './AttachmentStrip';

describe('isFileDrag', () => {
  it('accepts a drag that carries files from the OS', () => {
    expect(isFileDrag(['Files'])).toBe(true);
    // Chromium puts both on a drag out of a file manager.
    expect(isFileDrag(['text/uri-list', 'Files'])).toBe(true);
  });

  it("refuses the board's own gestures — a card move and a link being drawn", () => {
    expect(isFileDrag(['text/plain'])).toBe(false);
    expect(isFileDrag(['application/x-chain-link'])).toBe(false);
  });

  it('refuses a drag with no types at all, and one with no dataTransfer', () => {
    expect(isFileDrag([])).toBe(false);
    expect(isFileDrag(undefined)).toBe(false);
  });

  it('is exact, not a substring test — nothing else may pass as files', () => {
    expect(isFileDrag(['files'])).toBe(false);
    expect(isFileDrag(['application/x-Files'])).toBe(false);
  });

  it('reads a DOMStringList, which is what the DOM spec says `types` is', () => {
    const list = {
      length: 1,
      item: (i: number) => (i === 0 ? 'Files' : null),
      contains: (s: string) => s === 'Files',
      [Symbol.iterator]: function* () {
        yield 'Files';
      },
    } as unknown as DOMStringList;
    expect(isFileDrag(list)).toBe(true);
  });
});

describe('formatSize', () => {
  it('shows whole bytes below a kilobyte', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(812)).toBe('812 B');
    expect(formatSize(1023)).toBe('1023 B');
  });

  it('steps up at 1024 and keeps one decimal from there', () => {
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(12_600)).toBe('12.3 KB');
    expect(formatSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatSize(1_500_000)).toBe('1.4 MB');
  });

  it('stops at gigabytes rather than growing a unit nothing here reaches', () => {
    expect(formatSize(1024 ** 3)).toBe('1.0 GB');
    expect(formatSize(1024 ** 4)).toBe('1024.0 GB');
  });

  it('does not print a negative size for a row that lost its stat', () => {
    expect(formatSize(-1)).toBe('0 B');
  });
});
