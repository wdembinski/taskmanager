/**
 * The review workspace's queues and one PR's diff (F15.14) — what the `150-review-workspace.mjs`
 * rows answer `review:queues`, `review:subjectSummary`, `review:subjectFile` and `review:viewed`
 * with. See `uiShotsFixture.mjs`'s own header doc for how `CHANNELS` here is merged with every
 * other file under this directory.
 *
 * Titles, authors and the file tree follow the v9-6 mockup: two rows requested from me (GitLab
 * `!412` "Retry uploads on a dropped link" by Marta with 3 drafts, which the workspace opens
 * first, and GitHub `#88`), one of my own and two agent cards with `taskId`s. `!412`'s diff is
 * read from a local clone (`source: 'local-ref'`), seven files at +184 −32 with two already
 * viewed, and its hunks are real TypeScript — the mockup's `upload()` retry loop — so
 * highlight.js has something to colour. The `+N −M` counts are the mockup's; the hunks are an
 * excerpt of each file's patch, not a line-for-line match to them.
 *
 * Only an empty `review:queues` joins the shared `CHANNELS`: only the review rows
 * (`150-review-workspace.mjs`, `155-review-entry.mjs`) answer with it, through their own
 * `channelOverrides` — the same arrangement as `95-board-review.mjs`.
 */
import { now } from '../shotsFixtureHelpers.mjs';

const GITLAB_REPO_ID = 7;
const GITHUB_REPO_ID = 55;

/** `subjectId()`'s own `gl-<repoId>-<n>` form for `!412`. */
export const PR_SUBJECT_ID = `gl-${GITLAB_REPO_ID}-412`;

const PR_DIFF_ID = 'd412c0ffee';
const HEAD_SHA = '7c1e9a4b2d6f80135e7a9c4b1d2f6e8a0b3c5d7e';
const BASE_SHA = 'a03f6b2c9e1d4875b6a2c0e9f1d3b5a7c9e2f4a6';

const item = (fields) => ({
  headSha: null,
  draft: false,
  updatedAt: now - 2 * 60 * 60_000,
  projectId: null,
  taskId: null,
  draftCount: 0,
  viewedCount: 0,
  fileCount: null,
  ...fields,
});

const pr = (provider, repoId, repoPath, number) => ({
  kind: 'pr',
  provider,
  repoId,
  repoPath,
  number,
});

const task = (taskId) => ({ kind: 'task', taskId });

/** `review:queues`'s answer: 2 requested, 1 mine, 2 agent cards. */
export const REVIEW_QUEUES = {
  items: [
    item({
      subjectId: PR_SUBJECT_ID,
      queue: 'requested',
      subject: pr('gitlab', GITLAB_REPO_ID, 'vipper/fleet-app', 412),
      title: 'Retry uploads on a dropped link',
      author: 'Marta',
      repoPath: 'vipper/fleet-app',
      ref: '!412',
      headRef: 'marta/retry-uploads',
      additions: 184,
      deletions: 32,
      pipeline: 'success',
      headSha: HEAD_SHA,
      updatedAt: now - 40 * 60_000,
      draftCount: 3,
      viewedCount: 2,
      fileCount: 7,
    }),
    item({
      subjectId: `gh-${GITHUB_REPO_ID}-88`,
      queue: 'requested',
      subject: pr('github', GITHUB_REPO_ID, 'vipper/fleet-console', 88),
      title: 'Paginate the device list',
      author: 'Jonas',
      repoPath: 'vipper/fleet-console',
      ref: '#88',
      pipeline: 'running',
      headSha: '1b4d7e0a3c6f92851d4e7a0b3c6d9f2e5a8b1c4d',
      fileCount: 4,
    }),
    item({
      subjectId: `gl-${GITLAB_REPO_ID}-409`,
      queue: 'mine',
      subject: pr('gitlab', GITLAB_REPO_ID, 'vipper/fleet-app', 409),
      title: 'Telemetry for parking mode',
      author: 'You',
      repoPath: 'vipper/fleet-app',
      ref: '!409',
      headRef: 'telemetry-parking-mode',
      pipeline: 'success',
      headSha: '5e8a1d4c7f0b23966e9b2c5d8f1a4e7b0c3d6f9a',
      fileCount: 5,
    }),
    item({
      subjectId: 'task:71',
      queue: 'agent',
      subject: task('71'),
      title: 'TM-71 Milestone archiving',
      author: 'Claude',
      repoPath: 'vipper/task-manager',
      ref: '',
      headSha: '9d2c5f8b1e4a70327f0c3e6b9d2a5f8c1e4b7a0d',
      taskId: '71',
      fileCount: 6,
    }),
    item({
      subjectId: 'task:87',
      queue: 'agent',
      subject: task('87'),
      title: 'TM-87 Send comments back',
      author: 'Claude',
      repoPath: 'vipper/task-manager',
      ref: '',
      headSha: '3f6a9c2e5b8d14706a3d6f9c2b5e8a1d4f7c0b3e',
      taskId: '87',
      draftCount: 1,
      fileCount: 3,
    }),
  ],
  asOf: { requested: now - 5 * 60_000, mine: now - 5 * 60_000, agent: now - 60_000 },
  partial: [],
};

const entry = (path, status, additions, deletions, newBlobSha) => ({
  path,
  status,
  additions,
  deletions,
  binary: false,
  image: false,
  bytes: (additions + 40) * 32,
  newBlobSha,
});

/** `!412`'s seven files, in the mockup's tree order. */
const FILES = [
  entry('src/upload/retry.ts', 'modified', 42, 9, 'b1a7e3c90d2f'),
  entry('src/upload/send.ts', 'modified', 6, 5, 'c2b8f4d01e3a'),
  entry('src/upload/backoff.ts', 'added', 38, 0, 'd3c905e12f4b'),
  entry('src/upload/index.ts', 'modified', 0, 4, 'e4da16f2305c'),
  entry('src/net/link.ts', 'modified', 12, 9, 'f5eb27034160'),
  entry('test/retry.test.ts', 'added', 80, 0, '06fc3814527d'),
  entry('test/send.test.ts', 'modified', 6, 5, '170d4925638e'),
];

/** `review:subjectSummary(PR_SUBJECT_ID)`'s answer. */
export const PR_SUMMARY = {
  status: 'ok',
  summary: {
    diffId: PR_DIFF_ID,
    baseRef: 'development',
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    includesWorkingTree: false,
    files: FILES,
    truncated: false,
    subjectId: PR_SUBJECT_ID,
    source: 'local-ref',
    // `LOCAL_REF_CAPABILITIES` (`@tm/shared/review`), spelled out — a fixture is plain `.mjs`.
    capabilities: { expandContext: true, aiReview: true, sendToAgent: false, publish: true },
  },
};

/**
 * One hunk from a list of `' '`/`'+'`/`'-'`-prefixed lines, numbering both sides from
 * `oldStart`/`newStart` and counting each side the way `parsePatch` would.
 */
function hunk(oldStart, newStart, lines, section = '') {
  let oldLine = oldStart;
  let newLine = newStart;
  const out = lines.map((raw) => {
    const mark = raw[0];
    const text = raw.slice(1);
    if (mark === '+') return { kind: 'add', text, newLine: newLine++ };
    if (mark === '-') return { kind: 'del', text, oldLine: oldLine++ };
    return { kind: 'context', text, oldLine: oldLine++, newLine: newLine++ };
  });
  const oldLines = oldLine - oldStart;
  const newLines = newLine - newStart;
  const header = `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@${section ? ` ${section}` : ''}`;
  return { oldStart, oldLines, newStart, newLines, header, lines: out };
}

const HUNKS = {
  'src/upload/retry.ts': [
    hunk(1, 1, [
      ' /**',
      '- * Uploads one file. A dropped link fails the upload.',
      '+ * Uploads one file, retrying a dropped link up to MAX_TRIES times with',
      '+ * exponential backoff between attempts.',
      ' */',
      '+export const MAX_TRIES = 5;',
      '+',
    ]),
    hunk(12, 14, [
      " import { send } from './send'",
      "+import { backoff } from './backoff'",
      "+import { isDroppedLink } from '../net/link'",
      ' ',
      ' export async function upload(f: File) {',
      '-  return send(f);',
      '+  let last: unknown;',
      '+  for (let i = 0; i < MAX_TRIES; i++) {',
      '+    try {',
      '+      return await send(f);',
      '+    } catch (e) {',
      '+      if (!isDroppedLink(e)) throw e;',
      '+      last = e;',
      '+      await backoff(i);',
      '+    }',
      '+  }',
      '+  // every attempt failed',
      '+  throw last;',
      ' }',
    ]),
    hunk(
      30,
      47,
      [
        ' export function cancelUpload(id: string): void {',
        '-  pending.delete(id);',
        '-  emit("cancelled", id);',
        '+  const job = pending.get(id);',
        '+  if (job === undefined) return;',
        '+  job.controller.abort();',
        '+  pending.delete(id);',
        "+  emit('cancelled', id);",
        ' }',
      ],
      'export function cancelUpload',
    ),
  ],
  'src/upload/send.ts': [
    hunk(
      8,
      8,
      [
        ' export async function send(f: File, signal?: AbortSignal): Promise<UploadResult> {',
        '-  const res = await fetch(UPLOAD_URL, { method: "POST", body: f });',
        "+  const res = await fetch(UPLOAD_URL, { method: 'POST', body: f, signal });",
        '   if (!res.ok) {',
        '-    throw new Error("upload failed");',
        '+    throw new UploadError(res.status, await res.text());',
        '   }',
        '   return (await res.json()) as UploadResult;',
        ' }',
      ],
      'export async function send',
    ),
  ],
  'src/upload/backoff.ts': [
    hunk(0, 1, [
      '+/** The longest wait between two attempts, in milliseconds. */',
      '+export const MAX_DELAY_MS = 30_000;',
      '+',
      '+/** Waits 2^attempt × 250 ms, plus up to 20% jitter, capped at MAX_DELAY_MS. */',
      '+export function backoff(attempt: number): Promise<void> {',
      '+  const base = Math.min(MAX_DELAY_MS, 250 * 2 ** attempt);',
      '+  const jitter = base * 0.2 * Math.random();',
      '+  return new Promise((resolve) => setTimeout(resolve, base + jitter));',
      '+}',
    ]),
  ],
  'src/upload/index.ts': [
    hunk(1, 1, [
      " export { upload, cancelUpload } from './retry';",
      "-export { uploadOnce } from './legacy';",
      "-export type { LegacyOptions } from './legacy';",
      " export type { UploadResult } from './send';",
    ]),
  ],
  'src/net/link.ts': [
    hunk(
      4,
      4,
      [
        " const DROPPED = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE']);",
        ' ',
        '-export function isDropped(e: any): boolean {',
        '-  return e && DROPPED.has(e.code);',
        '+/** Whether `e` is a link that dropped mid-request, as opposed to a refusal. */',
        '+export function isDroppedLink(e: unknown): boolean {',
        "+  if (typeof e !== 'object' || e === null) return false;",
        '+  const code = (e as { code?: unknown }).code;',
        "+  return typeof code === 'string' && DROPPED.has(code);",
        ' }',
      ],
      'const DROPPED',
    ),
  ],
  'test/retry.test.ts': [
    hunk(0, 1, [
      "+import { describe, expect, it, vi } from 'vitest';",
      "+import { MAX_TRIES, upload } from '../src/upload/retry';",
      "+import { send } from '../src/upload/send';",
      '+',
      "+vi.mock('../src/upload/send');",
      "+vi.mock('../src/upload/backoff', () => ({ backoff: () => Promise.resolve() }));",
      '+',
      "+const dropped = Object.assign(new Error('reset'), { code: 'ECONNRESET' });",
      '+',
      "+describe('upload', () => {",
      "+  it('retries a dropped link until send succeeds', async () => {",
      '+    vi.mocked(send).mockRejectedValueOnce(dropped).mockResolvedValueOnce({ id: 1 });',
      "+    await expect(upload(new File([], 'a'))).resolves.toEqual({ id: 1 });",
      '+  });',
      '+',
      "+  it('rethrows after MAX_TRIES attempts', async () => {",
      '+    vi.mocked(send).mockRejectedValue(dropped);',
      "+    await expect(upload(new File([], 'a'))).rejects.toBe(dropped);",
      '+    expect(send).toHaveBeenCalledTimes(MAX_TRIES);',
      '+  });',
      '+});',
    ]),
  ],
  'test/send.test.ts': [
    hunk(
      14,
      14,
      [
        "   it('throws on a failed response', async () => {",
        '     fetchMock.mockResolvedValueOnce(new Response(null, { status: 502 }));',
        "-    await expect(send(file)).rejects.toThrow('upload failed');",
        '+    await expect(send(file)).rejects.toMatchObject({ status: 502 });',
        '   });',
      ],
      "describe('send'",
    ),
  ],
};

/** `review:subjectFile(PR_SUBJECT_ID, diffId, path)`'s answers, keyed on `path`. */
export const PR_FILES = Object.fromEntries(
  Object.entries(HUNKS).map(([path, hunks]) => [
    path,
    { status: 'ok', file: { diffId: PR_DIFF_ID, path, hunks } },
  ]),
);

/** `review:viewed(PR_SUBJECT_ID)`'s answer: two of the seven files, both still current. */
export const PR_VIEWED = ['src/upload/backoff.ts', 'src/net/link.ts'].map((path) => ({
  subjectId: PR_SUBJECT_ID,
  path,
  blobSha: FILES.find((f) => f.path === path).newBlobSha,
  viewedAt: now - 20 * 60_000,
}));

/** The agent card `TM-87 Send comments back`'s `subjectId` (`taskSubjectId('87')`). */
export const TASK87_SUBJECT_ID = 'task:87';

/**
 * `review:subjectSummary(TASK87_SUBJECT_ID)`'s answer: `!412`'s diff read from the card's own
 * worktree, so the card subject has comments, an AI reviewer and *Send to agent*. Reusing the
 * PR's `diffId` lets `PR_FILES` answer this subject's `review:subjectFile` unchanged.
 */
export const TASK87_SUMMARY = {
  status: 'ok',
  summary: {
    ...PR_SUMMARY.summary,
    subjectId: TASK87_SUBJECT_ID,
    source: 'worktree',
    // `WORKTREE_CAPABILITIES` (`@tm/shared/review`), spelled out.
    capabilities: { expandContext: true, aiReview: true, sendToAgent: true, publish: false },
  },
};

/** The new-side text of `src/upload/retry.ts` line `line`, from the loaded hunks. */
function retryLine(line) {
  for (const h of HUNKS['src/upload/retry.ts']) {
    const found = h.lines.find((l) => l.kind !== 'del' && l.newLine === line);
    if (found) return found.text;
  }
  throw new Error(`src/upload/retry.ts has no new-side line ${line} in its hunks`);
}

const draft = (fields) => ({
  taskId: '87',
  diffId: PR_DIFF_ID,
  path: 'src/upload/retry.ts',
  side: 'new',
  excerpt: retryLine(fields.line),
  createdAt: now - 30 * 60_000,
  updatedAt: now - 30 * 60_000,
  sentAt: null,
  ...fields,
});

const aiDraft = (fields) =>
  draft({
    origin: 'ai',
    aiReviewId: 'air-87-1',
    suggestion: null,
    acceptedAt: null,
    dismissedAt: null,
    createdAt: now - 12 * 60_000,
    updatedAt: now - 12 * 60_000,
    ...fields,
  });

/**
 * `review:list('87')`'s answer: the v9-6 thread on line 18 — Jonas's question, then the AI's
 * blocker with a suggestion — plus one unaccepted AI draft per other severity, one dismissed AI
 * draft (behind "show dismissed (1)") and nothing accepted, so the header's draft count is 1.
 */
export const TASK87_DRAFTS = [
  draft({ id: 'c-87-human', line: 18, body: 'Should backoff cap at 30s?' }),
  aiDraft({
    id: 'c-87-ai-blocker',
    line: 18,
    severity: 'blocker',
    body: 'After the last try the error is swallowed and upload() resolves undefined. Rethrow after the loop.',
    suggestion: 'export async function upload(f: File): Promise<UploadResult> {',
  }),
  aiDraft({
    id: 'c-87-ai-major',
    line: 26,
    severity: 'major',
    body: 'Backoff also runs after the final attempt, so a failed upload waits the longest delay before it rethrows.',
    suggestion: '      if (i < MAX_TRIES - 1) await backoff(i);',
  }),
  aiDraft({
    id: 'c-87-ai-minor',
    line: 24,
    severity: 'minor',
    body: 'A non-link error is rethrown without the attempt number; worth adding it for the logs.',
  }),
  aiDraft({
    id: 'c-87-ai-nit',
    line: 19,
    severity: 'nit',
    body: '`last` reads better as `lastError`.',
    suggestion: '  let lastError: unknown;',
  }),
  aiDraft({
    id: 'c-87-ai-dismissed',
    line: 25,
    severity: 'minor',
    body: 'Keep the first error rather than the last; it is usually the telling one.',
    dismissedAt: now - 5 * 60_000,
  }),
];

/**
 * The AI review `air-87-1` of `TM-87 Send comments back` (F16.13) — the review the
 * `TASK87_DRAFTS` AI drafts came from — as `aiReview:get` answers it while it is queued. The
 * variants below are the four states the workspace header and file list draw.
 */
export const TASK87_AI_REVIEW = {
  id: 'air-87-1',
  subjectId: TASK87_SUBJECT_ID,
  diffId: PR_DIFF_ID,
  headSha: HEAD_SHA,
  status: 'queued',
  parkReason: null,
  model: 'claude-sonnet-5',
  startedAt: null,
  finishedAt: null,
  costUsd: null,
  tokens: null,
  summary: null,
  verdict: null,
  findingCount: 0,
  droppedCount: 0,
  error: null,
  requestedBy: 'human',
  reviewDoc: 'REVIEW.md',
};

/**
 * `model:catalog`'s answer for the review's model, so `useModelLabels` names it "Sonnet 5" the
 * way the CLI's probe does in the real app — unanswered, the card would read the raw id.
 */
export const TASK87_AI_MODEL_CATALOG = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5', known: true, family: 'sonnet', kind: 'version' },
];

/** Under way for 72s with one turn's cost reported: the cyan "AI reviewing…" chip. */
export const TASK87_AI_RUNNING = {
  ...TASK87_AI_REVIEW,
  status: 'running',
  startedAt: now - 72_000,
  costUsd: 0.42,
};

/** Stopped by the usage-limit gate, in the scheduler's own wording: a neutral chip. */
export const TASK87_AI_PARKED = {
  ...TASK87_AI_REVIEW,
  status: 'parked-limit',
  parkReason: 'usage limit reached — resumes at 14:05:00',
  startedAt: now - 6 * 60_000,
  costUsd: 0.42,
};

/** Failed after its repair turn: *Ask AI again* in the header and the failure card. */
export const TASK87_AI_FAILED = {
  ...TASK87_AI_REVIEW,
  status: 'failed',
  startedAt: now - 9 * 60_000,
  finishedAt: now - 7 * 60_000,
  costUsd: 0.61,
  error: 'the reply had no valid findings block twice',
};

/** Settled with a verdict: "AI: 5 findings" in the header and the summary card. */
export const TASK87_AI_DONE = {
  ...TASK87_AI_REVIEW,
  status: 'done',
  startedAt: now - 14 * 60_000,
  finishedAt: now - 12 * 60_000,
  costUsd: 1.84,
  tokens: {
    inputTokens: 18_400,
    outputTokens: 3_150,
    cacheCreationTokens: 9_200,
    cacheReadTokens: 41_000,
  },
  verdict: 'request-changes',
  summary:
    'The retry loop swallows the last error, so a failed upload resolves undefined. Backoff also runs after the final attempt. Fix the rethrow before merging; the rest are small.',
  findingCount: 5,
  droppedCount: 1,
};

/**
 * Only an EMPTY `review:queues` — see the header doc. The shell's Reviews row reads it at boot
 * (`useRequestedReviewCount`) on every screen, and an unanswered channel crashed every row.
 */
export const CHANNELS = {
  'review:queues': {
    items: [],
    asOf: { requested: null, mine: null, agent: null },
    partial: [],
  },
};
