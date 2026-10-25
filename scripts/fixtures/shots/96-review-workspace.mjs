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
 * Nothing here joins the shared `CHANNELS`: the screen is reached only through `main.tsx`'s
 * `?harness=review-workspace` route, by those two rows and their own `channelOverrides` —
 * the same arrangement as `95-board-review.mjs`.
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
      ref: 'marta/retry-uploads',
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
      ref: 'jonas/device-pages',
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
      ref: 'telemetry-parking-mode',
      headSha: '5e8a1d4c7f0b23966e9b2c5d8f1a4e7b0c3d6f9a',
      fileCount: 5,
    }),
    item({
      subjectId: 'task:71',
      queue: 'agent',
      subject: task('71'),
      title: 'TM-71 Linear identifiers',
      author: 'Claude',
      repoPath: 'vipper/task-manager',
      ref: 'tm-71-linear-identifiers',
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
      ref: 'tm-87-send-comments-back',
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

/** Empty on purpose — see the header doc. */
export const CHANNELS = {};
