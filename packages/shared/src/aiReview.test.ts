import { describe, expect, it } from 'vitest';
import type { AiFindingSeverity, ValidatedFinding } from './aiReview';
import {
  AI_REVIEW_MAX_CHANGED_LINES,
  AI_REVIEW_MAX_FILES,
  aiReviewPrecheck,
  findingToDraft,
  parseFindings,
  validateFindings,
} from './aiReview';
import type {
  DiffFile,
  DiffFileEntry,
  DiffHunk,
  DiffLine,
  DiffSummary,
  ReviewComment,
} from './review';
import {
  FORGE_API_CAPABILITIES,
  LOCAL_REF_CAPABILITIES,
  WORKTREE_CAPABILITIES,
  markOutdated,
} from './review';

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

function entry(path: string, overrides: Partial<DiffFileEntry> = {}): DiffFileEntry {
  return {
    path,
    status: 'modified',
    additions: 1,
    deletions: 1,
    binary: false,
    image: false,
    bytes: 100,
    ...overrides,
  };
}

/** `src/a.ts`: one hunk covering new lines 10–14, with a `del` row on old line 11. */
const fileA: DiffFile = {
  diffId: 'diff-1',
  path: 'src/a.ts',
  hunks: [
    hunk(
      [
        line({ text: 'ten', oldLine: 10, newLine: 10 }),
        line({ kind: 'del', text: 'old eleven', oldLine: 11 }),
        line({ kind: 'add', text: 'new eleven', newLine: 11 }),
        line({ kind: 'add', text: 'twelve', newLine: 12 }),
        line({ text: 'thirteen', oldLine: 12, newLine: 13 }),
        line({ text: 'fourteen', oldLine: 13, newLine: 14 }),
      ],
      { oldStart: 10, oldLines: 4, newStart: 10, newLines: 5, header: '@@ -10,4 +10,5 @@' },
    ),
  ],
};

const fileNew: DiffFile = {
  diffId: 'diff-1',
  path: 'src/new.ts',
  hunks: [hunk([line({ text: 'renamed one', oldLine: 1, newLine: 1 })])],
};

const fileBig: DiffFile = {
  diffId: 'diff-1',
  path: 'src/big.ts',
  hunks: [],
  tooLarge: { bytes: 999_999 },
};

const summary: DiffSummary = {
  diffId: 'diff-1',
  baseRef: 'main',
  baseSha: 'base123',
  headSha: 'head456',
  includesWorkingTree: false,
  files: [
    entry('src/a.ts'),
    entry('src/new.ts', { oldPath: 'src/old.ts', status: 'renamed' }),
    entry('src/big.ts'),
    entry('img/logo.png', { binary: true, image: true }),
  ],
  truncated: false,
};

const filesByPath: ReadonlyMap<string, DiffFile> = new Map([
  ['src/a.ts', fileA],
  ['src/new.ts', fileNew],
  ['src/big.ts', fileBig],
]);

function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: 'src/a.ts',
    side: 'new',
    startLine: 10,
    endLine: 14,
    severity: 'major',
    title: 'Off by one',
    body: 'The loop stops one short.',
    ...overrides,
  };
}

function output(findings: unknown[], overrides: Record<string, unknown> = {}): unknown {
  return { summary: 'Looks mostly fine.', verdict: 'comment', findings, ...overrides };
}

const fence = (body: string, info = 'json') => ['```' + info, body, '```'].join('\n');

describe('aiReviewPrecheck', () => {
  const NO_AI = 'add the repo as a project to let the AI review it';
  const MANY_FILES = 'too large to review — more than 150 files changed';

  /** `count` files of `lines` changed lines each (all additions). */
  function sized(count: number, lines: number, over: Partial<DiffSummary> = {}): DiffSummary {
    return {
      ...summary,
      files: Array.from({ length: count }, (_, i) =>
        entry(`f${i}.ts`, { additions: lines, deletions: 0 }),
      ),
      capabilities: WORKTREE_CAPABILITIES,
      ...over,
    };
  }

  it.each<[string, DiffSummary, string | null]>([
    ['a small worktree diff', sized(3, 10), null],
    ['a small local-ref diff', sized(3, 10, { capabilities: LOCAL_REF_CAPABILITIES }), null],
    ['exactly the file cap', sized(AI_REVIEW_MAX_FILES, 1), null],
    ['exactly the line cap', sized(4, AI_REVIEW_MAX_CHANGED_LINES / 4), null],
    ['a forge-api diff', sized(3, 10, { capabilities: FORGE_API_CAPABILITIES }), NO_AI],
    ['a summary with no capabilities', sized(3, 10, { capabilities: undefined }), NO_AI],
    ['one file over the cap', sized(AI_REVIEW_MAX_FILES + 1, 1), MANY_FILES],
    ['a truncated summary', sized(3, 10, { truncated: true }), MANY_FILES],
    [
      'one line over the cap',
      sized(1, AI_REVIEW_MAX_CHANGED_LINES + 1),
      'too large to review — 4,001 changed lines, cap 4,000',
    ],
    [
      'deletions counted with additions',
      { ...sized(0, 0), files: [entry('a.ts', { additions: 2500, deletions: 2500 })] },
      'too large to review — 5,000 changed lines, cap 4,000',
    ],
    // The order: capability before any cap, the file count before the changed lines.
    [
      'a forge-api diff that is also too large',
      sized(200, 100, { capabilities: FORGE_API_CAPABILITIES }),
      NO_AI,
    ],
    ['too many files AND too many lines', sized(200, 100), MANY_FILES],
    ['truncated AND too many lines', sized(2, 5000, { truncated: true }), MANY_FILES],
  ])('%s', (_name, input, expected) => {
    expect(aiReviewPrecheck(input)).toBe(expected);
  });
});

describe('parseFindings', () => {
  it('parses a single fenced json block', () => {
    const text = ['Here is my review.', fence('{"a": 1}')].join('\n');

    expect(parseFindings(text)).toEqual({ ok: true, value: { a: 1 } });
  });

  it.each([
    ['prose with no block', 'I could not find anything wrong.'],
    ['an empty string', ''],
    ['only a bare fence', fence('{"a": 1}', '')],
  ])('refuses %s', (_name, text) => {
    const result = parseFindings(text);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no ```json block/);
  });

  it('takes the LAST json block when there are two', () => {
    const text = [fence('{"which": "first"}'), 'and then', fence('{"which": "last"}')].join('\n');

    expect(parseFindings(text)).toEqual({ ok: true, value: { which: 'last' } });
  });

  it('ignores a bare ``` block after the json block', () => {
    const text = [fence('{"which": "json"}'), fence('{"which": "bare"}', '')].join('\n');

    expect(parseFindings(text)).toEqual({ ok: true, value: { which: 'json' } });
  });

  it('ignores an unclosed trailing fence', () => {
    const text = [fence('{"which": "closed"}'), '```json', '{"which": "open"}'].join('\n');

    expect(parseFindings(text)).toEqual({ ok: true, value: { which: 'closed' } });
  });

  it('accepts an upper-case JSON info string with trailing whitespace', () => {
    expect(parseFindings(fence('[1, 2]', 'JSON  '))).toEqual({ ok: true, value: [1, 2] });
  });

  it('refuses junk in the last block, naming it, even when an earlier block is valid', () => {
    const text = [fence('{"fine": true}'), fence('{not json at all')].join('\n');

    const result = parseFindings(text);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not valid JSON/);
  });
});

describe('validateFindings', () => {
  it('passes a valid output through as inline findings quoting the hunk text', () => {
    const result = validateFindings(
      output([finding(), finding({ startLine: 12, endLine: 12, severity: 'nit' })]),
      summary,
      filesByPath,
    );

    expect(result).toMatchObject({
      ok: true,
      summary: 'Looks mostly fine.',
      verdict: 'comment',
      dropped: 0,
      cut: 0,
      errors: [],
    });
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toMatchObject({
      path: 'src/a.ts',
      fileLevel: false,
      excerpt: 'ten\nold eleven\nnew eleven\ntwelve\nthirteen\nfourteen',
    });
    expect(result.findings[1]).toMatchObject({ fileLevel: false, excerpt: 'twelve' });
  });

  it('drops a finding on an unknown path and counts it', () => {
    const result = validateFindings(
      output([finding(), finding({ path: 'src/nowhere.ts' })]),
      summary,
      filesByPath,
    );

    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.dropped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/finding 1.*unknown path/);
  });

  it('resolves a rename by its old path, carrying oldPath', () => {
    const result = validateFindings(
      output([finding({ path: 'src/old.ts', startLine: 1, endLine: 1 })]),
      summary,
      filesByPath,
    );

    expect(result.findings[0]).toMatchObject({
      path: 'src/new.ts',
      oldPath: 'src/old.ts',
      fileLevel: false,
      excerpt: 'renamed one',
    });
  });

  it('strips a leading ./ or / from a path', () => {
    const result = validateFindings(
      output([finding({ path: './src/a.ts' }), finding({ path: '/src/a.ts' })]),
      summary,
      filesByPath,
    );

    expect(result.findings.map((f) => f.path)).toEqual(['src/a.ts', 'src/a.ts']);
  });

  it.each([
    ['a range outside the hunks', finding({ startLine: 40, endLine: 42 })],
    ['a too-large file', finding({ path: 'src/big.ts', startLine: 1, endLine: 3 })],
    ['a binary file', finding({ path: 'img/logo.png', startLine: 1, endLine: 1 })],
  ])('makes %s file-level', (_name, input) => {
    const result = validateFindings(output([input]), summary, filesByPath);

    expect(result.dropped).toBe(0);
    expect(result.findings[0]).toMatchObject({ fileLevel: true, excerpt: '' });
  });

  it.each([
    ['an inverted range', { startLine: 14, endLine: 10 }],
    ['a bad severity', { severity: 'critical' }],
    ['a missing title', { title: undefined }],
    ['an empty body', { body: '' }],
    ['a non-integer line', { startLine: 10.5 }],
    ['a zero line', { startLine: 0 }],
    ['a bad side', { side: 'both' }],
    ['a non-string category', { category: 3 }],
  ])('drops a finding with %s and stays ok', (_name, overrides) => {
    const result = validateFindings(output([finding(overrides), finding()]), summary, filesByPath);

    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.dropped).toBe(1);
    expect(result.errors[0]).toMatch(/^finding 0/);
  });

  it('drops a finding that is not an object', () => {
    const result = validateFindings(output(['nope', null, finding()]), summary, filesByPath);

    expect(result.ok).toBe(true);
    expect(result.dropped).toBe(2);
  });

  it('treats a null category or suggestion as absent', () => {
    const result = validateFindings(
      output([finding({ category: null, suggestion: null })]),
      summary,
      filesByPath,
    );

    expect(result.findings[0]).not.toHaveProperty('category');
    expect(result.findings[0]).not.toHaveProperty('suggestion');
  });

  it.each([
    ['findings not an array', output([], { findings: {} })],
    ['a bad verdict', output([], { verdict: 'lgtm' })],
    ['an empty summary', output([], { summary: '' })],
    ['null', null],
    ['a string', 'all good'],
    ['an array', [finding()]],
  ])('refuses an envelope with %s', (_name, input) => {
    const result = validateFindings(input, summary, filesByPath);

    expect(result.ok).toBe(false);
    expect(result.summary).toBeNull();
    expect(result.verdict).toBeNull();
    expect(result.findings).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('keeps the 50 most severe of 60, stable within a rank, and reports the cut', () => {
    const severities: AiFindingSeverity[] = ['nit', 'minor', 'major', 'blocker'];
    const many = Array.from({ length: 60 }, (_, i) =>
      finding({ severity: severities[i % 4], title: `t${i}` }),
    );

    const result = validateFindings(output(many), summary, filesByPath);

    expect(result.findings).toHaveLength(50);
    expect(result.cut).toBe(10);
    expect(result.dropped).toBe(0);
    const count = (s: AiFindingSeverity) => result.findings.filter((f) => f.severity === s).length;
    expect(count('blocker')).toBe(15);
    expect(count('major')).toBe(15);
    expect(count('minor')).toBe(15);
    expect(count('nit')).toBe(5);
    expect(result.findings.slice(0, 3).map((f) => f.title)).toEqual(['t3', 't7', 't11']);
    expect(result.findings.filter((f) => f.severity === 'nit').map((f) => f.title)).toEqual([
      't0',
      't4',
      't8',
      't12',
      't16',
    ]);
  });

  it('never throws: a filesByPath whose getter throws comes back ok: false', () => {
    const exploding = {
      get: () => {
        throw new Error('boom');
      },
    } as unknown as ReadonlyMap<string, DiffFile>;

    const result = validateFindings(output([finding()]), summary, exploding);

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/boom/);
  });
});

describe('findingToDraft', () => {
  const review = { id: 'air-1', subjectId: 'subject-1', diffId: 'diff-1' };

  function validated(overrides: Partial<ValidatedFinding> = {}): ValidatedFinding {
    return {
      path: 'src/a.ts',
      side: 'new',
      startLine: 10,
      endLine: 14,
      severity: 'major',
      title: 'Off by one',
      body: 'The loop stops one short.',
      fileLevel: false,
      excerpt: 'ten',
      ...overrides,
    };
  }

  it('maps an inline range onto line = endLine with a start', () => {
    const draft = findingToDraft(validated({ category: 'correctness' }), review);

    expect(draft).toEqual({
      subjectId: 'subject-1',
      diffId: 'diff-1',
      path: 'src/a.ts',
      side: 'new',
      line: 14,
      start: { side: 'new', line: 10 },
      body: '**Off by one** · correctness\n\nThe loop stops one short.',
      excerpt: 'ten',
      origin: 'ai',
      aiReviewId: 'air-1',
      severity: 'major',
      suggestion: null,
      acceptedAt: null,
      dismissedAt: null,
      fileLevel: false,
    });
  });

  it('maps a single line with no start', () => {
    const draft = findingToDraft(validated({ startLine: 12, endLine: 12 }), review);

    expect(draft.line).toBe(12);
    expect(draft).not.toHaveProperty('start');
    expect(draft.body).toBe('**Off by one**\n\nThe loop stops one short.');
  });

  it('anchors a file-level range to its start line and names the range in the body', () => {
    const draft = findingToDraft(
      validated({ startLine: 40, endLine: 42, fileLevel: true, excerpt: '' }),
      review,
    );

    expect(draft).toMatchObject({ line: 40, excerpt: '', fileLevel: true });
    expect(draft).not.toHaveProperty('start');
    expect(draft.body).toBe(
      'Lines 40–42 (new side, outside the diff): **Off by one**\n\nThe loop stops one short.',
    );
  });

  it('names a file-level single line as Line', () => {
    const draft = findingToDraft(
      validated({ side: 'old', startLine: 7, endLine: 7, fileLevel: true, excerpt: '' }),
      review,
    );

    expect(draft.body).toMatch(/^Line 7 \(old side, outside the diff\): /);
  });

  it('keeps a suggestion verbatim and carries a rename', () => {
    const suggestion = '  for (let i = 0; i <= n; i++) {\n';
    const draft = findingToDraft(validated({ suggestion, oldPath: 'src/old.ts' }), review);

    expect(draft.suggestion).toBe(suggestion);
    expect(draft.oldPath).toBe('src/old.ts');
  });
});

describe('markOutdated with a file-level comment', () => {
  it('comes back outdated: false although its anchor never resolves', () => {
    const comment: ReviewComment = {
      id: 'c1',
      taskId: 'task-1',
      diffId: 'diff-1',
      path: 'src/a.ts',
      side: 'new',
      line: 40,
      body: 'outside',
      excerpt: '',
      createdAt: 0,
      updatedAt: 0,
      sentAt: null,
      fileLevel: true,
    };

    const [result] = markOutdated([comment], fileA);

    expect(result.outdated).toBe(false);
  });
});
