import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from './markdown';

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
