import { describe, expect, it } from 'vitest';
import {
  attachmentIdFromUrl,
  attachmentName,
  attachmentUrl,
  attachmentsInScope,
  insertAttachmentRef,
  parseAttachmentRefs,
  referencedAttachments,
} from './attachments';

/** Just enough of a `TaskAttachment` for the name-only helpers. */
const at = (name: string): { name: string } => ({ name });

describe('attachmentName', () => {
  it('keeps a name that is already legal', () => {
    expect(attachmentName('shot.png', [])).toBe('shot.png');
  });

  it('strips directories, so a picked path never becomes one', () => {
    expect(attachmentName('C:\\Users\\me\\Pictures\\shot.png', [])).toBe('shot.png');
    expect(attachmentName('/home/me/pictures/shot.png', [])).toBe('shot.png');
  });

  it('refuses to let a traversal survive as a name', () => {
    expect(attachmentName('../../etc/passwd', [])).toBe('passwd');
    expect(attachmentName('..', [])).toBe('file');
  });

  it('turns whitespace into hyphens and drops what neither a token nor NTFS allows', () => {
    expect(attachmentName('Screenshot 2026-08-03 at 11.04 (1).png', [])).toBe(
      'Screenshot-2026-08-03-at-11.04-1.png',
    );
    expect(attachmentName('a  b   c.txt', [])).toBe('a-b-c.txt');
    expect(attachmentName('why? (really!).md', [])).toBe('why-really.md');
  });

  it('normalizes, so the same filename yields the same name however the OS spells it', () => {
    const composed = 'r\u00e9sum\u00e9.pdf';
    const decomposed = 're\u0301sume\u0301.pdf';
    expect(composed).not.toBe(decomposed);
    expect(attachmentName(decomposed, [])).toBe(attachmentName(composed, []));
  });

  it('falls back rather than yielding an empty name', () => {
    expect(attachmentName('   ', [])).toBe('file');
    expect(attachmentName('🙂🙂', [])).toBe('file');
    expect(attachmentName('...', [])).toBe('file');
  });

  it('never ends on a dot, which Windows accepts and then cannot open', () => {
    expect(attachmentName('report.', [])).toBe('report');
  });

  it('keeps a leading dot: a dotfile has no extension', () => {
    expect(attachmentName('.gitignore', [])).toBe('.gitignore');
  });

  it('prefixes a Windows device name, with or without an extension', () => {
    expect(attachmentName('con.txt', [])).toBe('_con.txt');
    expect(attachmentName('NUL', [])).toBe('_NUL');
    expect(attachmentName('com1.log', [])).toBe('_com1.log');
    expect(attachmentName('lpt9', [])).toBe('_lpt9');
    // Not a device name — only the exact reserved words are.
    expect(attachmentName('console.log', [])).toBe('console.log');
  });

  it('dedupes BEFORE the extension, so the file still opens in the right program', () => {
    expect(attachmentName('shot.png', ['shot.png'])).toBe('shot-2.png');
    expect(attachmentName('shot.png', ['shot.png', 'shot-2.png'])).toBe('shot-3.png');
  });

  it('dedupes case-insensitively, because the name is also a Windows filename', () => {
    expect(attachmentName('Shot.PNG', ['shot.png'])).toBe('Shot-2.PNG');
    expect(attachmentName('shot.png', ['SHOT.PNG'])).toBe('shot-2.png');
  });

  it('caps the length by eating into the stem, never the extension', () => {
    const long = attachmentName(`${'a'.repeat(80)}.png`, []);
    expect(long).toHaveLength(64);
    expect(long.endsWith('.png')).toBe(true);
  });

  it('keeps the dedupe suffix inside the cap too', () => {
    const first = attachmentName(`${'a'.repeat(80)}.png`, []);
    const second = attachmentName(`${'a'.repeat(80)}.png`, [first]);
    expect(second).toHaveLength(64);
    expect(second.endsWith('-2.png')).toBe(true);
    expect(second).not.toBe(first);
  });

  it('cuts an absurd extension rather than looping forever', () => {
    expect(attachmentName(`x.${'y'.repeat(80)}`, [])).toHaveLength(64);
  });
});

describe('parseAttachmentRefs', () => {
  const known = ['shot.png', 'log.txt'];

  it('finds a ref and says where it sits', () => {
    expect(parseAttachmentRefs('see @shot.png here', known)).toEqual([
      { name: 'shot.png', start: 4, end: 13 },
    ]);
  });

  it('is not fooled by an email address', () => {
    expect(parseAttachmentRefs('mail bob@example.com now', ['example.com'])).toEqual([]);
  });

  it('does not read @needs: as a ref', () => {
    expect(parseAttachmentRefs('@needs: build the thing (shot.png)', known)).toEqual([]);
  });

  it('peels a sentence-ending period', () => {
    expect(parseAttachmentRefs('look at @shot.png.', known)).toEqual([
      { name: 'shot.png', start: 8, end: 17 },
    ]);
  });

  it('lets the longest known match win', () => {
    const both = ['a.png', 'a.png.bak'];
    expect(parseAttachmentRefs('@a.png.bak', both)).toEqual([
      { name: 'a.png.bak', start: 0, end: 10 },
    ]);
    expect(parseAttachmentRefs('@a.png.bak.', both)).toEqual([
      { name: 'a.png.bak', start: 0, end: 10 },
    ]);
    // Only the shorter one exists, so the longer token names nothing at all.
    expect(parseAttachmentRefs('@a.png.bak', ['a.png'])).toEqual([]);
  });

  it('treats an unknown token as prose', () => {
    expect(parseAttachmentRefs('ping @everyone about @shot.png', known)).toEqual([
      { name: 'shot.png', start: 21, end: 30 },
    ]);
    expect(parseAttachmentRefs('a bare @ and @-', known)).toEqual([]);
  });

  it('gives each occurrence its own offsets when a name appears twice', () => {
    expect(parseAttachmentRefs('@shot.png and @shot.png', known)).toEqual([
      { name: 'shot.png', start: 0, end: 9 },
      { name: 'shot.png', start: 14, end: 23 },
    ]);
  });

  it('resolves case-insensitively but reports the canonical spelling', () => {
    expect(parseAttachmentRefs('@shot.PNG', ['Shot.png'])).toEqual([
      { name: 'Shot.png', start: 0, end: 9 },
    ]);
  });

  it('needs the @ to start a word', () => {
    expect(parseAttachmentRefs('see@shot.png', known)).toEqual([]);
    expect(parseAttachmentRefs('x-@shot.png', known)).toEqual([]);
    expect(parseAttachmentRefs('(@shot.png)', known)).toEqual([
      { name: 'shot.png', start: 1, end: 10 },
    ]);
  });
});

describe('referencedAttachments', () => {
  const all = [at('a.png'), at('b.png'), at('c.png')];

  it('returns only what the text cites', () => {
    expect(referencedAttachments('only @b.png matters', all)).toEqual([at('b.png')]);
  });

  it('returns them in the list order, once each', () => {
    expect(referencedAttachments('@c.png then @a.png then @c.png again', all)).toEqual([
      at('a.png'),
      at('c.png'),
    ]);
  });

  it('is empty for a brief that names nothing', () => {
    expect(referencedAttachments('no files here @nope.png', all)).toEqual([]);
  });
});

describe('attachmentsInScope', () => {
  it("adds the parent's files to a step's own", () => {
    const own = [at('step.png')];
    const parent = [at('mockup.png')];
    expect(attachmentsInScope(own, parent)).toEqual([at('step.png'), at('mockup.png')]);
  });

  it("lets the step's own file shadow the parent's of the same name", () => {
    const own = [at('mockup.png')];
    const parent = [at('MOCKUP.PNG'), at('other.png')];
    const scope = attachmentsInScope(own, parent);
    expect(scope).toEqual([at('mockup.png'), at('other.png')]);
    expect(scope[0]).toBe(own[0]);
  });
});

describe('insertAttachmentRef', () => {
  it('inserts into an empty field with a trailing space to type after', () => {
    expect(insertAttachmentRef('', 0, 'a.png')).toEqual({ text: '@a.png ', caret: 7 });
  });

  it('adds the space that would otherwise glue the ref onto the previous word', () => {
    expect(insertAttachmentRef('see', 3, 'a.png')).toEqual({ text: 'see @a.png ', caret: 11 });
  });

  it('adds no space where there already is one', () => {
    expect(insertAttachmentRef('see ', 4, 'a.png')).toEqual({ text: 'see @a.png ', caret: 11 });
  });

  it('inserts mid-text and leaves the caret after the ref', () => {
    expect(insertAttachmentRef('a b', 1, 'x.png')).toEqual({ text: 'a @x.png b', caret: 8 });
  });

  it('clamps a caret outside the text', () => {
    expect(insertAttachmentRef('ab', 99, 'x.png')).toEqual({ text: 'ab @x.png ', caret: 10 });
    expect(insertAttachmentRef('ab', -5, 'x.png')).toEqual({ text: '@x.png ab', caret: 7 });
  });

  it('produces something the parser reads back', () => {
    const { text } = insertAttachmentRef('see', 3, 'a.png');
    expect(parseAttachmentRefs(text, ['a.png']).map((r) => r.name)).toEqual(['a.png']);
  });
});

describe('attachmentUrl', () => {
  it('carries nothing but the id', () => {
    expect(attachmentUrl('abc-123')).toBe('vipper-attachment://a/abc-123');
  });

  it('escapes an id that would otherwise change the path', () => {
    expect(attachmentUrl('a/../b')).toBe('vipper-attachment://a/a%2F..%2Fb');
  });
});

describe('attachmentIdFromUrl', () => {
  it('reads back what attachmentUrl wrote', () => {
    for (const id of ['abc-123', 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6', 'a/../b', 'a b', '%']) {
      expect(attachmentIdFromUrl(attachmentUrl(id))).toBe(id);
    }
  });

  it('refuses a URL that is not ours', () => {
    expect(attachmentIdFromUrl('file:///C:/Windows/win.ini')).toBeNull();
    expect(attachmentIdFromUrl('https://a/abc')).toBeNull();
    expect(attachmentIdFromUrl('not a url at all')).toBeNull();
  });

  it('refuses anything but the single id segment', () => {
    expect(attachmentIdFromUrl('vipper-attachment://a/')).toBeNull();
    expect(attachmentIdFromUrl('vipper-attachment://a/one/two')).toBeNull();
  });

  it('refuses escaping that does not decode', () => {
    expect(attachmentIdFromUrl('vipper-attachment://a/%E0%A4%A')).toBeNull();
  });

  it('ignores the host, which Chromium is free to canonicalise', () => {
    // The id is in the PATH for exactly this reason: a standard scheme's authority is not
    // ours to control, so nothing may be read out of it.
    expect(attachmentIdFromUrl('vipper-attachment://anything/abc-123')).toBe('abc-123');
  });
});
