import { describe, expect, it } from 'vitest';
import { blocksToText, buildAdf, buildWikiBody, parseAdf, type AdfMention } from './adf';

/** Everything under a doc's Nth paragraph, as loose records. */
const para = (doc: unknown, n = 0): Array<Record<string, unknown>> => {
  const content = (doc as { content: Array<Record<string, unknown>> }).content;
  return (content[n].content ?? []) as Array<Record<string, unknown>>;
};

const alice: AdfMention = { start: 0, end: 6, accountId: 'acc-a', displayName: 'Alice' };

describe('buildAdf', () => {
  it('wraps plain text one paragraph per line', () => {
    const doc = buildAdf('first\n\nsecond') as { content: unknown[] };
    expect(doc.content).toHaveLength(3);
    expect(para(doc, 0)).toEqual([{ type: 'text', text: 'first' }]);
    expect(para(doc, 1)).toEqual([]); // the blank line survives as an empty paragraph
    expect(para(doc, 2)).toEqual([{ type: 'text', text: 'second' }]);
  });

  it('splices a mention in as a node, keeping the text either side', () => {
    const doc = buildAdf('@Alice can you look?', [alice]);
    expect(para(doc)).toEqual([
      { type: 'mention', attrs: { id: 'acc-a', text: '@Alice' } },
      { type: 'text', text: ' can you look?' },
    ]);
  });

  it('handles several mentions on one line, and one at the very end', () => {
    const text = '@Alice and @Bob';
    const doc = buildAdf(text, [
      alice,
      { start: 11, end: 15, accountId: 'acc-b', displayName: 'Bob' },
    ]);
    expect(para(doc).map((n) => n.type)).toEqual(['mention', 'text', 'mention']);
  });

  it('places a mention on the right line of a multi-line comment', () => {
    const text = 'ping:\n@Alice';
    const doc = buildAdf(text, [{ ...alice, start: 6, end: 12 }]);
    expect(para(doc, 0)).toEqual([{ type: 'text', text: 'ping:' }]);
    expect(para(doc, 1)[0]).toMatchObject({ type: 'mention' });
  });

  it('emits an unresolved mention as plain text rather than an invalid node', () => {
    const doc = buildAdf('@Nobody hi', [
      { start: 0, end: 7, accountId: null, displayName: 'Nobody' },
    ]);
    expect(para(doc)).toEqual([
      { type: 'text', text: '@Nobody' },
      { type: 'text', text: ' hi' },
    ]);
  });

  it('drops out-of-range and overlapping mentions instead of corrupting the text', () => {
    const doc = buildAdf('@Alice hi', [
      alice,
      { start: 3, end: 9, accountId: 'acc-b', displayName: 'Bob' }, // overlaps Alice
      { start: 50, end: 60, accountId: 'acc-c', displayName: 'Carol' }, // past the end
    ]);
    expect(para(doc).filter((n) => n.type === 'mention')).toHaveLength(1);
    expect(blocksToText(parseAdf(doc))).toBe('@Alice hi');
  });

  it('cites attachments as a trailing paragraph of links', () => {
    const doc = buildAdf('see this', [], [{ filename: 'log.txt', url: 'https://j/at/1' }]);
    const text = blocksToText(parseAdf(doc));
    expect(text).toContain('see this');
    expect(text).toContain('log.txt');
  });
});

describe('buildWikiBody', () => {
  it('names people with [~id] and attachments with !file!', () => {
    const body = buildWikiBody('@Alice look', [alice], [{ filename: 'log.txt' }]);
    expect(body).toBe('[~acc-a] look\n\n!log.txt!');
  });

  it('leaves an unresolved mention as the text the user typed', () => {
    const body = buildWikiBody('@Nobody hi', [
      { start: 0, end: 7, accountId: null, displayName: 'Nobody' },
    ]);
    expect(body).toBe('@Nobody hi');
  });
});

describe('parseAdf', () => {
  const doc = (...content: unknown[]): unknown => ({ type: 'doc', version: 1, content });

  it('keeps a mention’s label — the bug that deleted the name from the sentence', () => {
    const body = doc({
      type: 'paragraph',
      content: [
        { type: 'mention', attrs: { id: 'acc-a', text: '@Alice' } },
        { type: 'text', text: ' can you look' },
      ],
    });
    expect(parseAdf(body)).toEqual([
      {
        kind: 'paragraph',
        spans: [
          { kind: 'mention', text: '@Alice', id: 'acc-a' },
          { kind: 'text', text: ' can you look' },
        ],
      },
    ]);
    expect(blocksToText(parseAdf(body))).toBe('@Alice can you look');
  });

  it('falls back to the id when a mention carries no label', () => {
    const body = doc({
      type: 'paragraph',
      content: [{ type: 'mention', attrs: { id: 'acc-a' } }],
    });
    expect(parseAdf(body)[0]).toMatchObject({
      spans: [{ kind: 'mention', text: '@acc-a', id: 'acc-a' }],
    });
  });

  it('reads links, inline cards and code marks', () => {
    const body = doc(
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'docs',
            marks: [{ type: 'link', attrs: { href: 'https://x/y' } }],
          },
          { type: 'text', text: ' and ' },
          { type: 'text', text: 'npm i', marks: [{ type: 'code' }] },
        ],
      },
      { type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url: 'https://card' } }] },
    );
    expect(parseAdf(body)).toEqual([
      {
        kind: 'paragraph',
        spans: [
          { kind: 'link', text: 'docs', href: 'https://x/y' },
          { kind: 'text', text: ' and ' },
          { kind: 'code', text: 'npm i' },
        ],
      },
      { kind: 'paragraph', spans: [{ kind: 'link', text: 'https://card', href: 'https://card' }] },
    ]);
  });

  it('reads lists, headings, quotes, code blocks and media', () => {
    const body = doc(
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Why' }] },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'q' }] }] },
      { type: 'codeBlock', content: [{ type: 'text', text: 'const a = 1' }] },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
        ],
      },
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { alt: 'shot.png' } }] },
    );
    const blocks = parseAdf(body);
    expect(blocks.map((b) => b.kind)).toEqual([
      'heading',
      'quote',
      'codeBlock',
      'list',
      'media',
    ]);
    expect(blocks[3]).toMatchObject({ ordered: false });
    expect(blocksToText(blocks)).toBe('Why\nq\nconst a = 1\none\ntwo\nshot.png');
  });

  it('merges adjacent plain runs so marked-up text does not render as fragments', () => {
    const body = doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b', marks: [{ type: 'strong' }] },
      ],
    });
    expect(parseAdf(body)[0]).toMatchObject({ spans: [{ kind: 'text', text: 'ab' }] });
  });

  it('reads a v2 plain string as paragraphs', () => {
    expect(parseAdf('one\ntwo')).toEqual([
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'one' }] },
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'two' }] },
    ]);
  });

  it('returns nothing for garbage rather than throwing', () => {
    for (const value of [null, undefined, 42, [], { type: 'doc' }]) {
      expect(parseAdf(value)).toEqual([]);
    }
  });
});

describe('round trip', () => {
  it('build → parse → text returns what was typed', () => {
    const text = 'hello @Alice\nsecond line';
    const mentions = [{ start: 6, end: 12, accountId: 'acc-a', displayName: 'Alice' }];
    expect(blocksToText(parseAdf(buildAdf(text, mentions)))).toBe(text);
  });
});
