import { describe, expect, it } from 'vitest';
import type { DiffFile, DiffHunk, DiffLine, DiffSummary, ReviewComment } from './review';
import { excerptFor, formatReviewMessage, markOutdated } from './review';

function line(partial: Partial<DiffLine> & { text: string }): DiffLine {
  return { kind: 'context', ...partial };
}

function hunk(lines: DiffLine[], overrides: Partial<DiffHunk> = {}): DiffHunk {
  return {
    oldStart: 1,
    oldLines: lines.length,
    newStart: 1,
    newLines: lines.length,
    header: '@@ -1 +1 @@',
    lines,
    ...overrides,
  };
}

function file(hunks: DiffHunk[], overrides: Partial<DiffFile> = {}): DiffFile {
  return { diffId: 'diff-1', path: 'src/example.ts', hunks, ...overrides };
}

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'c1',
    taskId: 'task-1',
    diffId: 'diff-1',
    path: 'src/example.ts',
    side: 'new',
    line: 1,
    body: 'note',
    excerpt: '',
    createdAt: 0,
    updatedAt: 0,
    sentAt: null,
    ...overrides,
  };
}

function summary(overrides: Partial<DiffSummary> = {}): DiffSummary {
  return {
    diffId: 'diff-1',
    baseRef: 'main',
    baseSha: 'base123',
    headSha: 'head456',
    includesWorkingTree: false,
    files: [],
    truncated: false,
    ...overrides,
  };
}

describe('markOutdated', () => {
  it('leaves an unchanged anchor outdated: false', () => {
    const f = file([hunk([line({ text: 'const x = 1;', oldLine: 5, newLine: 5 })])]);
    const c = comment({ side: 'new', line: 5, excerpt: 'const x = 1;' });

    const [result] = markOutdated([c], f);

    expect(result.outdated).toBe(false);
  });

  it('marks a moved anchor outdated: lines inserted above push other text onto the same number', () => {
    const f = file([
      hunk([
        line({ text: 'inserted one', newLine: 3 }),
        line({ text: 'inserted two', newLine: 4 }),
        line({ text: 'const y = 2;', oldLine: 3, newLine: 5 }),
      ]),
    ]);
    const c = comment({ side: 'new', line: 5, excerpt: 'const x = 1;' });

    const [result] = markOutdated([c], f);

    expect(result.outdated).toBe(true);
  });

  it('marks a deleted anchor outdated, including when the file has no hunks left', () => {
    const withOtherHunk = file([hunk([line({ text: 'unrelated', oldLine: 1, newLine: 1 })])]);
    const withNoHunks = file([]);
    const c = comment({ side: 'new', line: 5, excerpt: 'const x = 1;' });

    expect(markOutdated([c], withOtherHunk)[0].outdated).toBe(true);
    expect(markOutdated([c], withNoHunks)[0].outdated).toBe(true);
  });

  it('marks an edited anchor outdated: same line number, different text', () => {
    const f = file([hunk([line({ text: 'const x = 2;', oldLine: 5, newLine: 5 })])]);
    const c = comment({ side: 'new', line: 5, excerpt: 'const x = 1;' });

    const [result] = markOutdated([c], f);

    expect(result.outdated).toBe(true);
  });

  it('still matches an old-side anchor on a renamed file', () => {
    const f = file([hunk([line({ text: 'const x = 1;', oldLine: 3, newLine: 3 })])], {
      path: 'new/path.ts',
    });
    const c = comment({
      path: 'new/path.ts',
      oldPath: 'old/path.ts',
      side: 'old',
      line: 3,
      excerpt: 'const x = 1;',
    });

    const [result] = markOutdated([c], f);

    expect(result.outdated).toBe(false);
  });

  it('marks a range outdated when its start row was removed', () => {
    const f = file([hunk([line({ text: 'line four', oldLine: 4, newLine: 4 })])]);
    const c = comment({
      side: 'new',
      line: 4,
      start: { side: 'new', line: 2 },
      excerpt: 'line two\nline three\nline four',
    });

    const [result] = markOutdated([c], f);

    expect(result.outdated).toBe(true);
  });

  it('still matches an excerpt that differs only by CRLF', () => {
    const f = file([
      hunk([
        line({ text: 'line one\r', oldLine: 1, newLine: 1 }),
        line({ text: 'line two\r', oldLine: 2, newLine: 2 }),
      ]),
    ]);
    const c = comment({
      side: 'new',
      line: 2,
      start: { side: 'new', line: 1 },
      excerpt: 'line one\nline two',
    });

    const [result] = markOutdated([c], f);

    expect(result.outdated).toBe(false);
  });

  it('leaves a comment on another path untouched', () => {
    const f = file([hunk([line({ text: 'anything', oldLine: 1, newLine: 1 })])]);
    const c = comment({ path: 'other/file.ts', side: 'new', line: 1, excerpt: 'anything' });

    const [result] = markOutdated([c], f);

    expect(result).toBe(c);
  });

  it('leaves a comment on a tooLarge file untouched', () => {
    const f = file([], { tooLarge: { bytes: 999_999 } });
    const c = comment({ side: 'new', line: 1, excerpt: 'anything' });

    const [result] = markOutdated([c], f);

    expect(result).toBe(c);
  });

  it('flips a previously outdated comment back to false once its anchor matches again', () => {
    const f = file([hunk([line({ text: 'const x = 1;', oldLine: 5, newLine: 5 })])]);
    const c = comment({ side: 'new', line: 5, excerpt: 'const x = 1;', outdated: true });

    const [result] = markOutdated([c], f);

    expect(result.outdated).toBe(false);
  });

  it('does not mutate its input', () => {
    const f = file([hunk([line({ text: 'const x = 2;', oldLine: 5, newLine: 5 })])]);
    const original = Object.freeze(
      comment({ side: 'new', line: 5, excerpt: 'const x = 1;' }),
    ) as ReviewComment;
    const input = Object.freeze([original]) as ReviewComment[];

    const result = markOutdated(input, f);

    expect(result).not.toBe(input);
    expect(result[0]).not.toBe(original);
    expect(original.outdated).toBeUndefined();
  });
});

describe('excerptFor', () => {
  it('returns null when the anchor does not resolve', () => {
    const f = file([hunk([line({ text: 'only line', oldLine: 1, newLine: 1 })])]);

    expect(excerptFor(f, { side: 'new', line: 5 })).toBeNull();
  });

  it('returns null when the range crosses sides in the wrong order', () => {
    const f = file([
      hunk([
        line({ kind: 'add', text: 'added', newLine: 2 }),
        line({ kind: 'del', text: 'removed', oldLine: 2 }),
      ]),
    ]);

    // start (new:2, index 0) comes before end (old:2, index 1) in display order — resolves.
    expect(excerptFor(f, { side: 'old', line: 2, start: { side: 'new', line: 2 } })).toBe(
      'added\nremoved',
    );
    // reversed: start (old:2, index 1) comes after end (new:2, index 0) — does not resolve.
    expect(excerptFor(f, { side: 'new', line: 2, start: { side: 'old', line: 2 } })).toBeNull();
  });
});

describe('formatReviewMessage', () => {
  it('formats a single comment', () => {
    const result = formatReviewMessage(
      [
        comment({
          path: 'src/app.ts',
          side: 'new',
          line: 12,
          excerpt: 'const x = 1;',
          body: 'Should this be a constant?',
        }),
      ],
      summary(),
    );

    expect(result).toMatchInlineSnapshot(`
      "Code review of head456 (diff diff-1, against main) — 1 comment.

      1. \`src/app.ts:12\`

      \`\`\`
      const x = 1;
      \`\`\`

      Should this be a constant?"
    `);
  });

  it('formats a new-side range', () => {
    const result = formatReviewMessage(
      [
        comment({
          path: 'src/app.ts',
          side: 'new',
          line: 14,
          start: { side: 'new', line: 12 },
          excerpt: 'const x = 1;\nconst y = 2;\nconst z = 3;',
          body: 'All three can be inlined.',
        }),
      ],
      summary(),
    );

    expect(result).toMatchInlineSnapshot(`
      "Code review of head456 (diff diff-1, against main) — 1 comment.

      1. \`src/app.ts:12-14\`

      \`\`\`
      const x = 1;
      const y = 2;
      const z = 3;
      \`\`\`

      All three can be inlined."
    `);
  });

  it('formats an old-side comment on a renamed file, showing oldPath and the rename', () => {
    const result = formatReviewMessage(
      [
        comment({
          path: 'src/new-name.ts',
          oldPath: 'src/old-name.ts',
          side: 'old',
          line: 8,
          excerpt: 'export function helper() {}',
          body: 'This name was clearer.',
        }),
      ],
      summary(),
    );

    expect(result).toMatchInlineSnapshot(`
      "Code review of head456 (diff diff-1, against main) — 1 comment.

      1. \`src/old-name.ts:8 (old), renamed to src/new-name.ts\`

      \`\`\`
      export function helper() {}
      \`\`\`

      This name was clearer."
    `);
  });

  it('formats a cross-side range', () => {
    const result = formatReviewMessage(
      [
        comment({
          path: 'src/app.ts',
          side: 'new',
          line: 10,
          start: { side: 'old', line: 8 },
          excerpt: 'old line\nnew line',
          body: 'This replaced the old logic.',
        }),
      ],
      summary(),
    );

    expect(result).toMatchInlineSnapshot(`
      "Code review of head456 (diff diff-1, against main) — 1 comment.

      1. \`src/app.ts:8 (old)-10 (new)\`

      \`\`\`
      old line
      new line
      \`\`\`

      This replaced the old logic."
    `);
  });

  it('formats an outdated comment', () => {
    const result = formatReviewMessage(
      [
        comment({
          path: 'src/app.ts',
          side: 'new',
          line: 12,
          excerpt: 'const x = 1;',
          body: 'Should this be a constant?',
          outdated: true,
        }),
      ],
      summary(),
    );

    expect(result).toMatchInlineSnapshot(`
      "Code review of head456 (diff diff-1, against main) — 1 comment.

      1. \`src/app.ts:12 — outdated: the code changed since; the excerpt shows what it was\`

      \`\`\`
      const x = 1;
      \`\`\`

      Should this be a constant?"
    `);
  });

  it('sorts several comments across files and includes an overall note', () => {
    const result = formatReviewMessage(
      [
        comment({
          id: 'c-b-20',
          path: 'src/b.ts',
          side: 'new',
          line: 20,
          excerpt: 'line twenty',
          body: 'Second file, second comment.',
        }),
        comment({
          id: 'c-a-5',
          path: 'src/a.ts',
          side: 'new',
          line: 5,
          excerpt: 'line five',
          body: 'First file, first comment.',
        }),
        comment({
          id: 'c-b-3',
          path: 'src/b.ts',
          side: 'new',
          line: 3,
          excerpt: 'line three',
          body: 'Second file, first comment.',
        }),
      ],
      summary(),
      'Overall this looks good, a couple of small notes.',
    );

    expect(result).toMatchInlineSnapshot(`
      "Code review of head456 (diff diff-1, against main) — 3 comments.

      Overall this looks good, a couple of small notes.

      1. \`src/a.ts:5\`

      \`\`\`
      line five
      \`\`\`

      First file, first comment.

      2. \`src/b.ts:3\`

      \`\`\`
      line three
      \`\`\`

      Second file, first comment.

      3. \`src/b.ts:20\`

      \`\`\`
      line twenty
      \`\`\`

      Second file, second comment."
    `);
  });

  it('widens the fence when the excerpt itself contains backticks', () => {
    const result = formatReviewMessage(
      [
        comment({
          path: 'src/app.ts',
          side: 'new',
          line: 12,
          excerpt: 'const s = `template ``literal```;',
          body: 'Mind the nested backticks.',
        }),
      ],
      summary(),
    );

    expect(result).toMatchInlineSnapshot(`
      "Code review of head456 (diff diff-1, against main) — 1 comment.

      1. \`src/app.ts:12\`

      \`\`\`\`
      const s = \`template \`\`literal\`\`\`;
      \`\`\`\`

      Mind the nested backticks."
    `);
  });

  it('omits the fence block entirely for an empty excerpt', () => {
    const result = formatReviewMessage(
      [
        comment({
          path: 'src/app.ts',
          side: 'new',
          line: 12,
          excerpt: '',
          body: 'This line is gone now.',
        }),
      ],
      summary(),
    );

    expect(result).toMatchInlineSnapshot(`
      "Code review of head456 (diff diff-1, against main) — 1 comment.

      1. \`src/app.ts:12\`

      This line is gone now."
    `);
  });

  it('omits a whitespace-only overall note', () => {
    const result = formatReviewMessage(
      [
        comment({
          path: 'src/app.ts',
          side: 'new',
          line: 12,
          excerpt: 'const x = 1;',
          body: 'A comment.',
        }),
      ],
      summary(),
      '   \n  ',
    );

    expect(result).toMatchInlineSnapshot(`
      "Code review of head456 (diff diff-1, against main) — 1 comment.

      1. \`src/app.ts:12\`

      \`\`\`
      const x = 1;
      \`\`\`

      A comment."
    `);
  });

  it('returns an empty string for no comments and no note', () => {
    expect(formatReviewMessage([], summary())).toBe('');
    expect(formatReviewMessage([], summary(), '   ')).toBe('');
  });
});
