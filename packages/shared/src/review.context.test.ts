import { describe, expect, it } from 'vitest';
import { DIFF_CONTEXT_MAX_LINES, sliceContext } from './review';

function params(over: Partial<Parameters<typeof sliceContext>[1]> = {}) {
  return { diffId: 'diff-1', path: 'src/a.ts', side: 'new' as const, from: 1, to: 1, ...over };
}

describe('sliceContext', () => {
  it('reads the start of the file', () => {
    const text = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const context = sliceContext(text, params({ from: 1, to: 3 }));
    expect(context).toMatchObject({ start: 1, text: ['a', 'b', 'c'], truncated: false });
  });

  it('reads the end of the file, clipping a range that reaches past it', () => {
    const text = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const context = sliceContext(text, params({ from: 4, to: 50 }));
    expect(context).toMatchObject({ start: 4, text: ['d', 'e'], truncated: true });
  });

  it(`caps a request over ${DIFF_CONTEXT_MAX_LINES} lines`, () => {
    const text = Array.from({ length: 3000 }, (_v, i) => `l${i}`).join('\n');
    const context = sliceContext(text, params({ from: 1, to: 3000 }));
    expect(context.text).toHaveLength(DIFF_CONTEXT_MAX_LINES);
    expect(context.truncated).toBe(true);
    expect(context.text[0]).toBe('l0');
    expect(context.text[context.text.length - 1]).toBe(`l${DIFF_CONTEXT_MAX_LINES - 1}`);
  });

  it('strips a trailing \\r per line for a CRLF file', () => {
    const text = ['a', 'b', 'c'].join('\r\n');
    const context = sliceContext(text, params({ from: 1, to: 3 }));
    expect(context.text).toEqual(['a', 'b', 'c']);
  });

  it('does not count the empty element after a trailing newline as a line', () => {
    const text = `a\nb\nc\n`;
    const context = sliceContext(text, params({ from: 1, to: 3 }));
    expect(context.text).toEqual(['a', 'b', 'c']);
    expect(context.truncated).toBe(false);
  });

  it('keeps a real trailing blank line, dropping only the newline-artifact element', () => {
    const text = `a\nb\n\n`; // a, b, then one blank line, then the trailing newline
    const context = sliceContext(text, params({ from: 1, to: 3 }));
    expect(context.text).toEqual(['a', 'b', '']);
  });

  it('clamps a from past the total line count down to the last line', () => {
    const text = ['a', 'b'].join('\n');
    const context = sliceContext(text, params({ from: 5, to: 10 }));
    expect(context).toMatchObject({ start: 2, text: ['b'], truncated: true });
  });

  it('clamps an out-of-range from on an empty file to an empty read', () => {
    const context = sliceContext('', params({ from: 5, to: 10 }));
    expect(context).toMatchObject({ start: 1, text: [] });
  });
});
