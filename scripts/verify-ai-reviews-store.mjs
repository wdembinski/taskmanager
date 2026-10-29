/**
 * Headless proof of F16.6's store half — the `ai_reviews` table, the seven AI columns on
 * `review_drafts` and the ALTER that brings an older database up to them, the store methods
 * F16.8's runner will call, the boot sweep, and the subject-wide delete.
 *
 *     node scripts/verify-ai-reviews-store.mjs
 *
 * Cloned from `scripts/verify-review-drafts-migration.mjs` — see its header for why this has
 * to be a script rather than a `store.test.ts`: `better-sqlite3`'s addon is compiled for
 * ELECTRON's ABI, so nothing that calls `createStore` can run under the Node that runs
 * vitest. Same way past the ABI split: run the Electron binary as plain Node
 * (`ELECTRON_RUN_AS_NODE=1`), no window, a scratch database in the OS temp directory
 * (memories *the-store-has-no-tests*, *headless-scenario-harness-traps*).
 *
 * ## What it proves
 *
 * 1. A fresh database already has `ai_reviews` with every column (and `id` as its primary
 *    key), and `review_drafts` has `origin`, `aiReviewId`, `severity`, `suggestion`,
 *    `acceptedAt`, `dismissedAt` and `fileLevel`.
 * 2. A pre-upgrade database — a human draft seeded through the real store, then the
 *    `aiReviewId` index dropped, each of the seven columns DROPped from `review_drafts` and
 *    `ai_reviews` DROPped whole — gets the columns and the table back on reopen, and the
 *    human draft reads back exactly as it was written: no AI key at all, so still human.
 * 3. `createAiReview` / `getAiReview` / `listAiReviews` (newest first) / `updateAiReview`
 *    round-trip every field, tokens included; an explicit `undefined` in a patch leaves a
 *    field alone; a `resultText` over `AI_REVIEW_RESULT_MAX_BYTES` is stored capped, and one
 *    under it verbatim.
 * 4. `addAiDrafts` inserts AI drafts that `listReviewComments` returns with every AI field —
 *    and with none of the optional ones a draft did not carry.
 * 5. A `running` review is `failed` with "the app closed during the review" (and a
 *    `finishedAt`) after reopen; a `done` and a `queued` review are untouched.
 * 6. `deleteTask` removes that task subject's `ai_reviews` rows and leaves another's.
 *
 * Prove the checks matter yourself with either of these mutations to
 * `apps/client/src/main/store.ts` — both verified to go red while writing this script, then
 * reverted:
 *
 *   - Comment out the boot sweep (the `UPDATE ai_reviews SET status = 'failed' ...` right
 *     after the board_reviews one): check 5's "the running review is failed after reopen"
 *     and its error/finishedAt checks go red, because the row reopens still `running`.
 *   - Skip the ALTER block's loop (`for (const [name, type] of added) { ... }`): check 2's
 *     "reopening a pre-upgrade database succeeds" goes red (`no such column: aiReviewId`,
 *     from the index made right after it), as do its "review_drafts has column ... again"
 *     and defaults checks, and the script stops there — every later check would reopen the
 *     same database. With the index line skipped too, the reopen still throws, one step
 *     later: `insertReviewComment` is prepared naming `origin`, a column the old table lacks.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const scratch = mkdtempSync(join(tmpdir(), 'tm-ai-reviews-store-'));

/**
 * esbuild ships as a per-platform binary under a versioned `.pnpm` directory, so it is found
 * by pattern rather than by path: a dependency bump renames the directory, and hard-coding
 * one version would rot this script at the next `pnpm up`.
 */
function findEsbuild() {
  const pnpm = join(root, 'node_modules', '.pnpm');
  const target = `${process.platform}-${process.arch}`;
  const dir = readdirSync(pnpm).find((d) => d.startsWith(`@esbuild+${target}@`));
  if (!dir) throw new Error(`no esbuild binary for ${target} under ${pnpm}`);
  const exe = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
  return join(pnpm, dir, 'node_modules', '@esbuild', target, exe);
}

// ── Phase 1: plain Node — bundle the sources, then hand over to Electron ──────────────
if (!process.versions.electron) {
  const esbuild = findEsbuild();
  spawnSync(
    esbuild,
    [
      join(root, 'apps/client/src/main/store.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--alias:@shared=${join(root, 'packages', 'shared', 'src')}`,
      `--alias:@protocol=${join(root, 'packages', 'protocol', 'src')}`,
      '--external:better-sqlite3',
      `--outfile=${join(scratch, 'store.cjs')}`,
      '--log-level=error',
    ],
    { stdio: 'inherit' },
  );

  const electron = join(
    clientModules,
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  );
  if (!existsSync(electron)) throw new Error(`electron not installed at ${electron}`);

  const run = spawnSync(electron, [fileURLToPath(import.meta.url), scratch], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      // The bundle lives in temp, outside any node_modules tree, so the external
      // `require('better-sqlite3')` inside it needs somewhere to resolve from.
      NODE_PATH: clientModules,
    },
  });
  process.exit(run.status ?? 1);
}

// ── Phase 2: under Electron-as-Node — the actual checks ──────────────────────────────
const require = createRequire(import.meta.url);
const work = process.argv[2];
const { createStore } = require(join(work, 'store.cjs'));
const Database = require('better-sqlite3');

/** `AI_REVIEW_RESULT_MAX_BYTES` in `@shared/aiReview` — repeated, since this file is not bundled. */
const RESULT_MAX_BYTES = 200_000;

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

function tableInfo(dbPath, table) {
  const raw = new Database(dbPath);
  try {
    return raw.prepare(`PRAGMA table_info(${table})`).all();
  } finally {
    raw.close();
  }
}

function rawGet(dbPath, sql, ...params) {
  const raw = new Database(dbPath);
  try {
    return raw.prepare(sql).get(...params);
  } finally {
    raw.close();
  }
}

const subjectIdFor = (taskId) => `task:${taskId}`;

const AI_DRAFT_COLUMNS = [
  'origin',
  'aiReviewId',
  'severity',
  'suggestion',
  'acceptedAt',
  'dismissedAt',
  'fileLevel',
];

function makeReviewInput(subjectId, overrides = {}) {
  return {
    id: `review-${Math.random().toString(36).slice(2)}`,
    subjectId,
    diffId: 'diff-1',
    headSha: 'abc123',
    status: 'queued',
    parkReason: null,
    model: 'claude-sonnet-5-5',
    startedAt: null,
    finishedAt: null,
    costUsd: null,
    tokens: null,
    summary: null,
    verdict: null,
    error: null,
    requestedBy: 'human',
    ...overrides,
  };
}

const dbPath = join(work, 'orchestrator.db');

// ───────────────────────────── Check 1: fresh DB schema ─────────────────────────────
{
  const fresh = createStore(dbPath);
  fresh.close();

  const reviewsInfo = tableInfo(dbPath, 'ai_reviews');
  const reviewsColumns = reviewsInfo.map((c) => c.name);
  for (const col of [
    'id',
    'subjectId',
    'diffId',
    'headSha',
    'status',
    'parkReason',
    'model',
    'startedAt',
    'finishedAt',
    'costUsd',
    'tokens',
    'summary',
    'verdict',
    'findingCount',
    'droppedCount',
    'error',
    'requestedBy',
    'resultText',
    'createdAt',
  ]) {
    check(`fresh DB: ai_reviews has column ${col}`, reviewsColumns.includes(col));
  }
  check(
    'fresh DB: ai_reviews.id is the primary key',
    reviewsInfo.find((c) => c.name === 'id')?.pk === 1,
  );

  const draftsColumns = tableInfo(dbPath, 'review_drafts').map((c) => c.name);
  for (const col of AI_DRAFT_COLUMNS) {
    check(`fresh DB: review_drafts has column ${col}`, draftsColumns.includes(col));
  }
  check(
    'fresh DB: the review_drafts aiReviewId index exists',
    rawGet(
      dbPath,
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_review_drafts_ai_review'`,
    ) !== undefined,
  );
}

// ─────────────────── Check 2: the pre-upgrade ALTER migration ───────────────────────
let task;
{
  const before = createStore(dbPath);
  task = before.createTask('personal', { title: 'Task under review' });
  check('setup: the task was created', task != null);
  const human = before.addReviewComment({
    taskId: task.id,
    diffId: 'diff-1',
    path: 'src/foo.ts',
    side: 'new',
    line: 15,
    start: { side: 'new', line: 12 },
    body: 'a human range comment',
    excerpt: 'if (x) {',
  });
  check('setup: the human draft was created', human != null);
  const humanBefore = before.listReviewComments(task.id).find((c) => c.id === human.id);
  before.close();

  // Simulate a pre-F16 database: the aiReviewId index first (SQLite refuses to drop an
  // indexed column), then each AI column, then ai_reviews itself.
  const raw = new Database(dbPath);
  raw.exec('DROP INDEX IF EXISTS idx_review_drafts_ai_review');
  for (const col of AI_DRAFT_COLUMNS) raw.exec(`ALTER TABLE review_drafts DROP COLUMN ${col}`);
  raw.exec('DROP TABLE ai_reviews');
  const strippedColumns = raw
    .prepare('PRAGMA table_info(review_drafts)')
    .all()
    .map((c) => c.name);
  check(
    'pre-upgrade: review_drafts really has none of the AI columns',
    AI_DRAFT_COLUMNS.every((col) => !strippedColumns.includes(col)),
  );
  check(
    'pre-upgrade: ai_reviews really does not exist',
    raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_reviews'`)
      .get() === undefined,
  );
  raw.close();

  let after;
  try {
    after = createStore(dbPath);
    check('reopened: reopening a pre-upgrade database succeeds', true);
  } catch (err) {
    check(`reopened: reopening a pre-upgrade database succeeds (threw: ${err.message})`, false);
  }

  const draftsColumns = tableInfo(dbPath, 'review_drafts').map((c) => c.name);
  for (const col of AI_DRAFT_COLUMNS) {
    check(`reopened: review_drafts has column ${col} again`, draftsColumns.includes(col));
  }
  check(
    'reopened: ai_reviews exists again',
    rawGet(
      dbPath,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_reviews'`,
    ) !== undefined,
  );
  check(
    'reopened: the review_drafts aiReviewId index exists again',
    rawGet(
      dbPath,
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_review_drafts_ai_review'`,
    ) !== undefined,
  );
  const row = rawGet(dbPath, 'SELECT * FROM review_drafts WHERE id = ?', human.id);
  check(
    "reopened: the human draft's row took the 'human' and 0 defaults",
    row?.origin === 'human' && row?.fileLevel === 0 && row?.aiReviewId === null,
  );

  if (!after) {
    // Every later check opens the same database, so it would only throw the same error.
    console.log(`\n${failures} FAILED (stopped: the database cannot be reopened)`);
    process.exit(1);
  }
  const humanAfter = after.listReviewComments(task.id).find((c) => c.id === human.id);
  check(
    'reopened: the human draft reads back exactly as it was written',
    humanAfter != null && isDeepStrictEqual(humanAfter, humanBefore),
  );
  check(
    'reopened: the human draft carries no AI key, so it still reads as human',
    humanAfter != null && AI_DRAFT_COLUMNS.every((k) => !(k in humanAfter)),
  );
  after.close();
}

// ──────────── Check 3: createAiReview / getAiReview / listAiReviews / update ─────────
{
  const store = createStore(dbPath);
  const subj = subjectIdFor(task.id);

  const first = store.createAiReview(makeReviewInput(subj, { id: 'review-first' }));
  check(
    'createAiReview defaults findingCount and droppedCount to 0',
    first.findingCount === 0 && first.droppedCount === 0,
  );
  check(
    'getAiReview reads the created review back field for field',
    isDeepStrictEqual(store.getAiReview('review-first'), first),
  );
  check(
    'getAiReview on an unknown id is undefined',
    store.getAiReview('no-such-review') === undefined,
  );

  // createdAt is Date.now() at insert; wait a tick so the second review is strictly newer.
  const t0 = Date.now();
  while (Date.now() === t0) {
    /* spin */
  }
  const second = store.createAiReview(
    makeReviewInput(subj, { id: 'review-second', requestedBy: 'automation' }),
  );
  store.createAiReview(makeReviewInput('task:someone-else', { id: 'review-elsewhere' }));
  const listed = store.listAiReviews(subj);
  check(
    'listAiReviews returns only that subject, newest first',
    listed.length === 2 && listed[0].id === 'review-second' && listed[1].id === 'review-first',
  );
  check('listAiReviews keeps requestedBy', listed[0].requestedBy === 'automation');

  const tokens = {
    inputTokens: 1200,
    outputTokens: 340,
    cacheCreationTokens: 56,
    cacheReadTokens: 78_000,
  };
  const startedAt = Date.now() - 5000;
  const finishedAt = Date.now();
  const updated = store.updateAiReview('review-first', {
    status: 'done',
    startedAt,
    finishedAt,
    costUsd: 0.4321,
    tokens,
    summary: 'Two real problems and a nit.',
    verdict: 'request-changes',
    findingCount: 3,
    droppedCount: 1,
    resultText: 'short reply',
  });
  const expected = {
    ...first,
    status: 'done',
    startedAt,
    finishedAt,
    costUsd: 0.4321,
    tokens,
    summary: 'Two real problems and a nit.',
    verdict: 'request-changes',
    findingCount: 3,
    droppedCount: 1,
  };
  check('updateAiReview returns the merged review', isDeepStrictEqual(updated, expected));
  check(
    'updateAiReview round-trips every field, tokens included',
    isDeepStrictEqual(store.getAiReview('review-first'), expected),
  );
  check(
    'a resultText under the cap is stored verbatim',
    store.getAiReviewResultText('review-first') === 'short reply',
  );
  check(
    'updateAiReview on an unknown id is undefined',
    store.updateAiReview('no-such-review', { status: 'done' }) === undefined,
  );

  store.updateAiReview('review-first', { summary: undefined, error: 'kept-alone check' });
  const afterUndefined = store.getAiReview('review-first');
  check(
    'an explicit undefined in a patch leaves that field alone',
    afterUndefined.summary === 'Two real problems and a nit.' &&
      afterUndefined.error === 'kept-alone check',
  );
  check(
    'a patch without resultText leaves the stored resultText alone',
    store.getAiReviewResultText('review-first') === 'short reply',
  );

  // 'é' is two UTF-8 bytes, so a cap landing mid-character must back off to a whole one.
  const huge = 'x'.repeat(RESULT_MAX_BYTES - 1) + 'é'.repeat(10);
  store.updateAiReview('review-first', { resultText: huge });
  const stored = store.getAiReviewResultText('review-first');
  const storedBytes = Buffer.byteLength(stored ?? '', 'utf8');
  check(
    `a resultText over the cap is stored capped (${storedBytes} ≤ ${RESULT_MAX_BYTES} bytes)`,
    stored != null && storedBytes <= RESULT_MAX_BYTES && storedBytes > RESULT_MAX_BYTES - 4,
  );
  check(
    'the capped resultText is a prefix of the original, never a split code point',
    stored != null && huge.startsWith(stored) && !stored.includes('�'),
  );
  check(
    'getAiReviewResultText on a review that never had one is null',
    store.getAiReviewResultText('review-second') === null,
  );

  check(
    'createAiReview did not touch the other subject',
    store.listAiReviews('task:someone-else').length === 1 && second.subjectId === subj,
  );
  store.close();
}

// ───────────── Check 4: addAiDrafts → listReviewComments with every AI field ─────────
{
  const store = createStore(dbPath);
  const subj = subjectIdFor(task.id);
  const at = Date.now();
  const inline = {
    subjectId: subj,
    diffId: 'diff-1',
    path: 'src/renamed.ts',
    oldPath: 'src/original.ts',
    side: 'new',
    line: 20,
    start: { side: 'new', line: 18 },
    body: '**Off by one** · correctness\n\nThe loop stops one short.',
    excerpt: 'for (let i = 0; i < n - 1; i++) {',
    origin: 'ai',
    aiReviewId: 'review-first',
    severity: 'major',
    suggestion: 'for (let i = 0; i < n; i++) {',
    acceptedAt: null,
    dismissedAt: null,
    fileLevel: false,
  };
  const fileLevel = {
    subjectId: subj,
    diffId: 'diff-1',
    path: 'src/foo.ts',
    side: 'old',
    line: 400,
    body: 'Line 400 (old side, outside the diff): **Dead code**\n\nNothing calls this.',
    excerpt: '',
    origin: 'ai',
    aiReviewId: 'review-first',
    severity: 'nit',
    suggestion: null,
    acceptedAt: null,
    dismissedAt: null,
    fileLevel: true,
  };
  const added = store.addAiDrafts([inline, fileLevel], at);
  check('addAiDrafts returns one comment per draft', added.length === 2);

  const listed = store.listReviewComments(task.id);
  const a = listed.find((c) => c.id === added[0]?.id);
  const b = listed.find((c) => c.id === added[1]?.id);
  check('listReviewComments returns both AI drafts', a != null && b != null);
  check(
    'the inline AI draft reads back with every AI field',
    a?.origin === 'ai' &&
      a?.aiReviewId === 'review-first' &&
      a?.severity === 'major' &&
      a?.suggestion === inline.suggestion &&
      a?.fileLevel === undefined &&
      !('acceptedAt' in (a ?? {})) &&
      !('dismissedAt' in (a ?? {})),
  );
  check(
    'the inline AI draft keeps its anchor, oldPath, body and excerpt',
    a?.taskId === task.id &&
      a?.path === 'src/renamed.ts' &&
      a?.oldPath === 'src/original.ts' &&
      a?.side === 'new' &&
      a?.line === 20 &&
      a?.start?.side === 'new' &&
      a?.start?.line === 18 &&
      a?.body === inline.body &&
      a?.excerpt === inline.excerpt &&
      a?.createdAt === at &&
      a?.updatedAt === at &&
      a?.sentAt === null,
  );
  check(
    'the file-level AI draft reads back file-level, with no suggestion or start',
    b?.origin === 'ai' &&
      b?.aiReviewId === 'review-first' &&
      b?.severity === 'nit' &&
      b?.fileLevel === true &&
      !('suggestion' in (b ?? {})) &&
      !('start' in (b ?? {})) &&
      b?.side === 'old' &&
      b?.line === 400,
  );
  check(
    'what addAiDrafts returned matches what listReviewComments reads',
    isDeepStrictEqual(added[0], a) && isDeepStrictEqual(added[1], b),
  );
  check('addAiDrafts of nothing inserts nothing', store.addAiDrafts([], at).length === 0);

  // updateReviewComment round-trips the decision stamps: set, leave alone, clear.
  const id = added[0]?.id;
  const reread = () => store.listReviewComments(task.id).find((c) => c.id === id);
  const accepted = store.updateReviewComment(id, { acceptedAt: 111, dismissedAt: null });
  check(
    'updateReviewComment stores acceptedAt and returns it',
    accepted?.acceptedAt === 111 && reread()?.acceptedAt === 111 && !('dismissedAt' in reread()),
  );
  store.updateReviewComment(id, { body: 'reworded' });
  check(
    'a patch without the stamps leaves acceptedAt alone',
    reread()?.acceptedAt === 111 && reread()?.body === 'reworded',
  );
  store.updateReviewComment(id, { acceptedAt: null, dismissedAt: 222 });
  check(
    'updateReviewComment clears acceptedAt and stores dismissedAt',
    !('acceptedAt' in reread()) && reread()?.dismissedAt === 222,
  );
  check(
    'the stamps reached the columns themselves',
    isDeepStrictEqual(
      { ...rawGet(dbPath, 'SELECT acceptedAt, dismissedAt FROM review_drafts WHERE id = ?', id) },
      { acceptedAt: null, dismissedAt: 222 },
    ),
  );
  store.close();
}

// ─────────────── Check 5: the boot sweep fails only a running review ────────────────
{
  const store = createStore(dbPath);
  const subj = subjectIdFor(task.id);
  store.createAiReview(
    makeReviewInput(subj, { id: 'review-running', status: 'running', startedAt: Date.now() }),
  );
  const done = store.createAiReview(
    makeReviewInput(subj, { id: 'review-done', status: 'done', finishedAt: 1234 }),
  );
  const queued = store.createAiReview(makeReviewInput(subj, { id: 'review-queued' }));
  store.close();

  const beforeReopen = Date.now();
  const reopened = createStore(dbPath);
  const running = reopened.getAiReview('review-running');
  check('the running review is failed after reopen', running?.status === 'failed');
  check(
    'its error says the app closed during the review',
    running?.error === 'the app closed during the review',
  );
  check(
    'its finishedAt is stamped at the reopen',
    typeof running?.finishedAt === 'number' && running.finishedAt >= beforeReopen,
  );
  check(
    'the done review is untouched',
    isDeepStrictEqual(reopened.getAiReview('review-done'), done),
  );
  check(
    'the queued review is untouched',
    isDeepStrictEqual(reopened.getAiReview('review-queued'), queued),
  );
  reopened.close();
}

// ─────────── Check 6: deleteTask removes its subject's ai_reviews, not another's ─────
{
  const store = createStore(dbPath);
  const doomed = store.createTask('personal', { title: 'Card about to be deleted' });
  const survivor = store.createTask('personal', { title: 'Card that survives' });
  check('setup: both cards were created', doomed != null && survivor != null);
  store.createAiReview(makeReviewInput(subjectIdFor(doomed.id), { id: 'review-doomed-1' }));
  store.createAiReview(makeReviewInput(subjectIdFor(doomed.id), { id: 'review-doomed-2' }));
  store.createAiReview(makeReviewInput(subjectIdFor(survivor.id), { id: 'review-survivor' }));

  store.deleteTask(doomed.id);

  const count = (subj) =>
    rawGet(dbPath, 'SELECT COUNT(*) n FROM ai_reviews WHERE subjectId = ?', subj).n;
  check("deleteTask removes the card's own ai_reviews rows", count(subjectIdFor(doomed.id)) === 0);
  check(
    "deleteTask leaves another card's ai_reviews rows alone",
    count(subjectIdFor(survivor.id)) === 1,
  );
  store.close();
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
