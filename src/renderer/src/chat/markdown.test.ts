import { describe, expect, it } from 'vitest';
import { looksDrawn, parseInline, parseMarkdown } from './markdown';

describe('looksDrawn', () => {
  it('recognises box-drawing characters anywhere in the block', () => {
    expect(looksDrawn(['┌────┐', '│ hi │'])).toBe(true);
    expect(looksDrawn(['a → b'])).toBe(false); // an arrow is not box drawing
  });

  it('needs two grid lines, so a sentence containing a pipe stays prose', () => {
    expect(looksDrawn(['run foo | grep bar'])).toBe(false);
    expect(looksDrawn(['| a | b |', '| 1 | 2 |'])).toBe(true);
    expect(looksDrawn(['+----+', '| ok |'])).toBe(true);
  });
});

describe('parseMarkdown', () => {
  it('takes fenced code verbatim, with its language', () => {
    const blocks = parseMarkdown('before\n\n```ts\nconst x = 1;\n# not a heading\n```\nafter');
    expect(blocks).toEqual([
      { kind: 'para', text: 'before' },
      { kind: 'code', lang: 'ts', code: 'const x = 1;\n# not a heading' },
      { kind: 'para', text: 'after' },
    ]);
  });

  it('runs an unterminated fence to the end instead of losing the rest', () => {
    // Exactly what a truncated stream looks like mid-answer.
    const blocks = parseMarkdown('```\nhalf a file');
    expect(blocks).toEqual([{ kind: 'code', lang: null, code: 'half a file' }]);
  });

  it('reads a pipe table into cells', () => {
    const blocks = parseMarkdown('| Name | Size |\n| --- | ---: |\n| a | 1 |\n| b | 2 |');
    expect(blocks).toEqual([
      {
        kind: 'table',
        header: ['Name', 'Size'],
        rows: [
          ['a', '1'],
          ['b', '2'],
        ],
      },
    ]);
  });

  it('tolerates a table written without its outer pipes', () => {
    const blocks = parseMarkdown('a | b\n--- | ---\n1 | 2');
    expect(blocks).toEqual([{ kind: 'table', header: ['a', 'b'], rows: [['1', '2']] }]);
  });

  // The rule row is the whole test for a table. Without it this is a sentence.
  it('does not turn prose containing a pipe into a table', () => {
    expect(parseMarkdown('run foo | grep bar')).toEqual([
      { kind: 'para', text: 'run foo | grep bar' },
    ]);
  });

  // The bug: a diagram kept its spaces but was set in a proportional face, so every column
  // landed further out than the last. `pre` is the only way it survives.
  it('keeps a box drawing as pre, exactly as written', () => {
    const art = '┌──────┐\n│ node │\n└──┬───┘\n   │';
    expect(parseMarkdown(art)).toEqual([{ kind: 'pre', text: art }]);
  });

  it('keeps an ASCII table as pre rather than mangling it into a paragraph', () => {
    const art = '+------+-----+\n| name | n   |\n+------+-----+\n| a    | 1   |';
    expect(parseMarkdown(art)).toEqual([{ kind: 'pre', text: art }]);
  });

  it('reads an indented block as pre, with the indent removed', () => {
    const blocks = parseMarkdown('look:\n\n    a   b\n    c   d\n\nafter');
    expect(blocks).toEqual([
      { kind: 'para', text: 'look:' },
      { kind: 'pre', text: 'a   b\nc   d' },
      { kind: 'para', text: 'after' },
    ]);
  });

  it('does not mistake a wrapped sentence or a list continuation for an indented block', () => {
    // The indented line arrives mid-paragraph, so it belongs to the paragraph.
    expect(parseMarkdown('a sentence\n    that wrapped')).toEqual([
      { kind: 'para', text: 'a sentence\n    that wrapped' },
    ]);
  });

  it('reads headings, both list kinds, and quotes', () => {
    const blocks = parseMarkdown('## Plan\n- one\n- two\n\n1. first\n2. second\n\n> careful');
    expect(blocks).toEqual([
      { kind: 'heading', level: 2, text: 'Plan' },
      { kind: 'list', ordered: false, items: ['one', 'two'] },
      { kind: 'list', ordered: true, items: ['first', 'second'] },
      { kind: 'quote', text: 'careful' },
    ]);
  });

  it('keeps a paragraph’s own line breaks and drops blank runs', () => {
    expect(parseMarkdown('a\nb\n\n\nc')).toEqual([
      { kind: 'para', text: 'a\nb' },
      { kind: 'para', text: 'c' },
    ]);
  });

  it('is empty for empty input', () => {
    expect(parseMarkdown('   \n\n')).toEqual([]);
  });
});

describe('parseInline', () => {
  it('splits code, strong, em and links', () => {
    expect(parseInline('run `pnpm test` then **stop**')).toEqual([
      { kind: 'text', text: 'run ' },
      { kind: 'code', text: 'pnpm test' },
      { kind: 'text', text: ' then ' },
      { kind: 'strong', text: 'stop' },
    ]);
    expect(parseInline('see [the docs](https://x.dev/a)')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'the docs', href: 'https://x.dev/a' },
    ]);
    expect(parseInline('_soft_')).toEqual([{ kind: 'em', text: 'soft' }]);
  });

  it('leaves a non-http link as plain text', () => {
    // A rendered link is clickable; `javascript:` in agent output must not become one.
    const parts = parseInline('[click](javascript:alert(1))');
    expect(parts).toEqual([{ kind: 'text', text: '[click](javascript:alert(1))' }]);
  });

  it('does not treat code content as markup', () => {
    expect(parseInline('`a * b * c`')).toEqual([{ kind: 'code', text: 'a * b * c' }]);
  });

  it('returns one text run when there is no markup', () => {
    expect(parseInline('plain words')).toEqual([{ kind: 'text', text: 'plain words' }]);
  });
});
