import { beforeAll, describe, expect, it } from 'vitest';
import type { DiffHunk, DiffLine, WordSegment } from '@tm/shared/review';
import {
  MAX_FILE_LINES,
  MAX_LINE_CHARS,
  highlightFile,
  highlightHunk,
  languageForPath,
  loadLanguage,
  mergeSegments,
  toLines,
} from './highlight';

const line = (kind: DiffLine['kind'], text: string): DiffLine => ({ kind, text });

describe('loadLanguage + highlightHunk', () => {
  beforeAll(async () => {
    await loadLanguage('javascript');
  });

  it('colours a multi-line comment entirely as comment, on both the old and new side', () => {
    const hunk: DiffHunk = {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      header: '@@ -1,3 +1,3 @@',
      lines: [
        line('del', '/* a'),
        line('del', ' * b'),
        line('del', ' */'),
        line('add', '/* a'),
        line('add', ' * b'),
        line('add', ' */'),
      ],
    };

    const result = highlightHunk('javascript', hunk);

    for (const i of [0, 1, 2]) {
      const segs = result.old.get(i);
      expect(segs).toBeDefined();
      expect(segs!.length).toBeGreaterThan(0);
      expect(segs!.every((s) => s.scope === 'comment')).toBe(true);
    }
    for (const i of [3, 4, 5]) {
      const segs = result.new.get(i);
      expect(segs).toBeDefined();
      expect(segs!.length).toBeGreaterThan(0);
      expect(segs!.every((s) => s.scope === 'comment')).toBe(true);
    }
  });
});

describe('highlightFile cut-offs', () => {
  beforeAll(async () => {
    await loadLanguage('javascript');
  });

  it('keeps an over-long line plain while its neighbours still highlight', () => {
    const longLine = 'x'.repeat(MAX_LINE_CHARS + 1);
    const text = ['const a = 1;', longLine, 'const b = 2;'].join('\n');

    const result = highlightFile('javascript', text);

    expect(result).toHaveLength(3);
    expect(result[0].some((s) => s.scope === 'keyword')).toBe(true);
    expect(result[1]).toEqual([{ text: longLine, scope: null }]);
    expect(result[2].some((s) => s.scope === 'keyword')).toBe(true);
  });

  it('keeps a whole file plain once it is over the line-count cap', () => {
    const lineText = 'const a = 1;';
    const text = Array.from({ length: MAX_FILE_LINES + 1 }, () => lineText).join('\n');

    const result = highlightFile('javascript', text);

    expect(result).toHaveLength(MAX_FILE_LINES + 1);
    expect(result[0]).toEqual([{ text: lineText, scope: null }]);
    expect(result[result.length - 1]).toEqual([{ text: lineText, scope: null }]);
  });
});

describe('toLines', () => {
  it('decodes the five escaped entities outside of any span', () => {
    const lines = toLines('a &lt;b&gt; &amp; &quot;c&#x27;d&quot;');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual([{ text: `a <b> & "c'd"`, scope: null }]);
  });

  it('resolves a nested span back to its own scope and restores the outer scope after it closes', () => {
    const html = '<span class="hljs-tag">&lt;<span class="hljs-name">div</span>&gt;</span>';
    const lines = toLines(html);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual([
      { text: '<', scope: null },
      { text: 'div', scope: 'title' },
      { text: '>', scope: null },
    ]);
  });

  it('maps a tiered scope class (title.function) to its base bucket', () => {
    const html =
      '<span class="hljs-keyword">const</span> <span class="hljs-title function_">foo</span> = <span class="hljs-number">42</span>;';
    const lines = toLines(html);
    expect(lines[0]).toEqual([
      { text: 'const', scope: 'keyword' },
      { text: ' ', scope: null },
      { text: 'foo', scope: 'title' },
      { text: ' = ', scope: null },
      { text: '42', scope: 'number' },
      { text: ';', scope: null },
    ]);
  });

  it('splits on newlines while carrying the open scope across lines', () => {
    const html = '<span class="hljs-comment">/* a\n * b\n */</span>';
    const lines = toLines(html);
    expect(lines).toEqual([
      [{ text: '/* a', scope: 'comment' }],
      [{ text: ' * b', scope: 'comment' }],
      [{ text: ' */', scope: 'comment' }],
    ]);
  });
});

describe('mergeSegments', () => {
  it('splits a syntax segment at a word-diff boundary that falls in the middle of it', () => {
    const syntax = [
      { text: 'foo', scope: 'title' as const },
      { text: 'Bar', scope: null },
    ];
    const words: WordSegment[] = [
      { kind: 'same', text: 'fo' },
      { kind: 'del', text: 'oB' },
      { kind: 'same', text: 'ar' },
    ];

    expect(mergeSegments(syntax, words)).toEqual([
      { text: 'fo', scope: 'title', word: 'same' },
      { text: 'o', scope: 'title', word: 'del' },
      { text: 'B', scope: null, word: 'del' },
      { text: 'ar', scope: null, word: 'same' },
    ]);
  });
});

describe('languageForPath', () => {
  it('resolves an extension', () => {
    expect(languageForPath('src/App.tsx')).toBe('typescript');
  });

  it('resolves a bare filename', () => {
    expect(languageForPath('Dockerfile')).toBe('dockerfile');
    expect(languageForPath('infra/Dockerfile')).toBe('dockerfile');
  });

  it('returns null for an unknown extension', () => {
    expect(languageForPath('README.xyzzy')).toBeNull();
  });
});
