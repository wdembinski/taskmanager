/**
 * Headless proof of the review_drafts/review_viewed/review_queue migration (F15.4) — the
 * one-shot copy of `review_comments` into `review_drafts`, and the explicit deletes that
 * replace the `ON DELETE CASCADE` `review_comments` used to get for free.
 *
 *     node scripts/verify-review-drafts-migration.mjs
 *
 * Cloned from `scripts/verify-archive-migration.mjs` — see its header for why this has to
 * be a script rather than a `store.test.ts`: `better-sqlite3`'s addon is compiled for
 * ELECTRON's ABI, so nothing that calls `createStore` can run under the Node that runs
 * vitest, and this is the only thing that exercises the store's schema and migrations at
 * all. Same way past the ABI split: run the Electron binary as plain Node
 * (`ELECTRON_RUN_AS_NODE=1`), no window, a scratch database in the OS temp directory
 * (memories *the-store-has-no-tests*, *headless-scenario-harness-traps*).
 *
 * ## What it proves
 *
 * 1. A fresh database already has `review_drafts`, `review_viewed` and `review_queue`,
 *    with every column the schema declares and the right primary key.
 * 2. A pre-upgrade database — seeded through the real store (a range comment, a renamed
 *    file's old-side comment carrying `oldPath`, and a third comment stamped sent), then
 *    `review_drafts`/`review_viewed`/`review_queue` DROPped, the migration's own guard
 *    row deleted, and the three comments re-inserted into `review_comments` by hand (the
 *    pre-F15.4 shape — the live store no longer writes there) — gets every comment copied
 *    into `review_drafts` on reopen: `subjectId = 'task:<id>'`, every column (including
 *    `sentAt`/`startSide`/`oldPath`) unchanged, and `listReviewComments` reading the same
 *    comments back. `review_comments` itself is still present and untouched.
 * 3. Deleting a draft and reopening does not bring it back — the guard is a one-shot flag,
 *    not a pin that re-copies every time.
 * 4. `addReviewComment` on an unknown task returns `undefined` (`review_drafts` carries no
 *    foreign key to refuse it for free any more); `updateReviewComment` and
 *    `deleteReviewComment` both refuse an already-sent draft.
 * 5. `deleteTask` removes a card's own drafts/viewed/queue rows — its steps included — and
 *    leaves another card's alone; `removeProject` does the same for every task in the
 *    project, leaving a task outside it alone.
 * 6. `syncTasksFromPlan` keeps a surviving task's drafts and drops a dropped task's.
 * 7. (F15.9) `applyReviewQueue`'s complete-answer-only removal: an INCOMPLETE pass upserts
 *    what it returned and deletes nothing, in or out of its own segment; a COMPLETE pass
 *    upserts what it returned and deletes every other cached row in that EXACT segment
 *    only — a sibling segment (the other provider's half of `requested`, or `mine`) is
 *    never touched, because segment membership is read back out of each row's own
 *    `subject.provider`, not a schema column.
 * 8. (F15.9) `countReviewDrafts`/`countReviewViewed` are grouped reads over every subject:
 *    the former counts only UNSENT drafts, the latter every stored mark regardless of
 *    whether its `blobSha` still matches anything.
 *
 * Prove the checks matter yourself with any of these mutations to
 * `apps/client/src/main/store.ts` — all verified to go red while writing this script,
 * then reverted:
 *
 *   - Comment out the one-shot copy's body (the `if (!selectState.get(REVIEW_DRAFTS_COPY_KEY))`
 *     block's `db.transaction(...)` call): check 2's "every pre-upgrade comment was copied
 *     into review_drafts" goes red, because review_drafts stays empty on reopen.
 *   - Delete the `deleteDraftsForSubject.run(subjectId)` / `deleteViewedForSubject...` /
 *     `deleteQueueForSubject...` trio from `deleteTaskDeep`: check 5's "deleteTask removes
 *     that card's drafts/viewed/queue rows" goes red, because the rows survive the delete.
 *   - In `applyReviewQueue`'s implementation, drop the `if (!opts.complete) return;` guard
 *     so the delete pass always runs: check 7's "incomplete: the row the pass did NOT
 *     return survives untouched" goes red, because an incomplete pass starts deleting rows
 *     it simply didn't mention.
 *   - Remove the `if (segment.provider) { ... continue; }` filter from that same delete
 *     loop: check 7's "the other provider segment is untouched" goes red, because a
 *     `requested:github` pass starts deleting `requested:gitlab`'s rows too.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const scratch = mkdtempSync(join(tmpdir(), 'tm-review-drafts-migration-'));

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
  // `store.ts` imports nothing from Electron (only node:*, better-sqlite3 and @shared/*),
  // which is what lets it be pulled out of the app and run on its own like this.
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

const subjectIdFor = (taskId) => `task:${taskId}`;

function makeCommentInput(taskId, overrides = {}) {
  return {
    taskId,
    diffId: 'diff-1',
    path: 'src/foo.ts',
    side: 'new',
    line: 10,
    body: 'why does this branch exist?',
    excerpt: 'if (x) {',
    ...overrides,
  };
}

/** Every `review_drafts` column that should survive the copy from `review_comments`. */
function draftRowMatchesComment(row, comment) {
  return (
    row.diffId === comment.diffId &&
    row.path === comment.path &&
    (row.oldPath ?? null) === (comment.oldPath ?? null) &&
    row.side === comment.side &&
    row.line === comment.line &&
    (row.startSide ?? null) === (comment.start?.side ?? null) &&
    (row.startLine ?? null) === (comment.start?.line ?? null) &&
    row.body === comment.body &&
    row.excerpt === comment.excerpt &&
    row.createdAt === comment.createdAt &&
    row.updatedAt === comment.updatedAt &&
    row.sentAt === comment.sentAt
  );
}

const dbPath = join(work, 'orchestrator.db');

// ───────────────────────────── Check 1: fresh DB schema ─────────────────────────────
{
  const fresh = createStore(dbPath);
  fresh.close();

  const draftsInfo = tableInfo(dbPath, 'review_drafts');
  const draftsColumns = draftsInfo.map((c) => c.name);
  for (const col of [
    'id',
    'subjectId',
    'diffId',
    'path',
    'oldPath',
    'side',
    'line',
    'startSide',
    'startLine',
    'body',
    'excerpt',
    'createdAt',
    'updatedAt',
    'sentAt',
  ]) {
    check(`fresh DB: review_drafts has column ${col}`, draftsColumns.includes(col));
  }
  check(
    'fresh DB: review_drafts.id is the primary key',
    draftsInfo.find((c) => c.name === 'id')?.pk === 1,
  );

  const viewedInfo = tableInfo(dbPath, 'review_viewed');
  const viewedColumns = viewedInfo.map((c) => c.name);
  for (const col of ['subjectId', 'path', 'blobSha', 'viewedAt']) {
    check(`fresh DB: review_viewed has column ${col}`, viewedColumns.includes(col));
  }
  check(
    'fresh DB: review_viewed primary key is (subjectId, path)',
    viewedInfo.find((c) => c.name === 'subjectId')?.pk === 1 &&
      viewedInfo.find((c) => c.name === 'path')?.pk === 2,
  );

  const queueInfo = tableInfo(dbPath, 'review_queue');
  const queueColumns = queueInfo.map((c) => c.name);
  for (const col of ['subjectId', 'queue', 'row', 'syncedAt']) {
    check(`fresh DB: review_queue has column ${col}`, queueColumns.includes(col));
  }
  check(
    'fresh DB: review_queue primary key is (subjectId, queue)',
    queueInfo.find((c) => c.name === 'subjectId')?.pk === 1 &&
      queueInfo.find((c) => c.name === 'queue')?.pk === 2,
  );
}

// ─────────────────── Check 2: the pre-upgrade copy migration ───────────────────────
let task;
let rangeDraft;
let renamedDraft;
let sentDraft;
let sentAt;
{
  const before = createStore(dbPath);
  task = before.createTask('personal', { title: 'Task under review' });
  check('setup: the task was created', task != null);

  rangeDraft = before.addReviewComment(
    makeCommentInput(task.id, {
      line: 15,
      start: { side: 'new', line: 12 },
      body: 'a range comment',
    }),
  );
  renamedDraft = before.addReviewComment(
    makeCommentInput(task.id, {
      path: 'src/renamed.ts',
      oldPath: 'src/original.ts',
      side: 'old',
      line: 3,
      body: 'a comment on the old side of a renamed file',
    }),
  );
  const toSend = before.addReviewComment(makeCommentInput(task.id, { body: 'about to be sent' }));
  check(
    'setup: all three drafts were created',
    rangeDraft != null && renamedDraft != null && toSend != null,
  );

  sentAt = Date.now();
  const stamped = before.markReviewSent(task.id, [toSend.id], sentAt);
  sentDraft = stamped[0];
  check('setup: the third draft was stamped sent', sentDraft?.sentAt === sentAt);
  before.close();

  // Simulate a pre-F15.4 database: drop the three new tables, delete the migration's own
  // guard row, and re-insert the comments into review_comments — the shape the OLD store
  // wrote, which the live store no longer touches at all.
  const raw = new Database(dbPath);
  raw.exec('DROP TABLE review_drafts');
  raw.exec('DROP TABLE review_viewed');
  raw.exec('DROP TABLE review_queue');
  raw.prepare(`DELETE FROM app_state WHERE key = 'migration.reviewDraftsCopy'`).run();

  const insertOld = raw.prepare(
    `INSERT INTO review_comments
       (id, taskId, diffId, path, oldPath, side, line, startSide, startLine, body, excerpt,
        createdAt, updatedAt, sentAt)
     VALUES
       (@id, @taskId, @diffId, @path, @oldPath, @side, @line, @startSide, @startLine, @body,
        @excerpt, @createdAt, @updatedAt, @sentAt)`,
  );
  for (const c of [rangeDraft, renamedDraft, sentDraft]) {
    insertOld.run({
      id: c.id,
      taskId: task.id,
      diffId: c.diffId,
      path: c.path,
      oldPath: c.oldPath ?? null,
      side: c.side,
      line: c.line,
      startSide: c.start?.side ?? null,
      startLine: c.start?.line ?? null,
      body: c.body,
      excerpt: c.excerpt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      sentAt: c.sentAt,
    });
  }
  check(
    'pre-upgrade: review_comments holds the three re-inserted rows',
    raw.prepare('SELECT COUNT(*) n FROM review_comments').get().n === 3,
  );
  check(
    'pre-upgrade: review_drafts really does not exist yet',
    raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_drafts'`)
      .get() === undefined,
  );
  raw.close();

  // Reopen with the real store: review_drafts/viewed/queue come back empty, then the
  // one-shot copy runs because the guard row is gone.
  const after = createStore(dbPath);

  const rawCheck = new Database(dbPath);
  const subjectId = subjectIdFor(task.id);
  const draftRows = rawCheck
    .prepare('SELECT * FROM review_drafts WHERE subjectId = ?')
    .all(subjectId);
  check(
    'reopened: every pre-upgrade comment was copied into review_drafts',
    draftRows.length === 3,
  );
  check(
    'reopened: every copied row carries subjectId = task:<id>',
    draftRows.every((r) => r.subjectId === subjectId),
  );

  const byId = Object.fromEntries(draftRows.map((r) => [r.id, r]));
  check(
    'reopened: the range comment copied with every column unchanged',
    byId[rangeDraft.id] != null && draftRowMatchesComment(byId[rangeDraft.id], rangeDraft),
  );
  check(
    'reopened: the renamed comment copied with oldPath intact',
    byId[renamedDraft.id] != null && draftRowMatchesComment(byId[renamedDraft.id], renamedDraft),
  );
  check(
    'reopened: the sent comment copied with sentAt intact',
    byId[sentDraft.id] != null && draftRowMatchesComment(byId[sentDraft.id], sentDraft),
  );

  const listed = after.listReviewComments(task.id);
  check('reopened: listReviewComments returns all three comments', listed.length === 3);
  check(
    'reopened: listReviewComments includes the range comment with its start',
    listed.some((c) => c.id === rangeDraft.id && c.start?.side === 'new' && c.start?.line === 12),
  );
  check(
    'reopened: listReviewComments includes the renamed comment with oldPath',
    listed.some((c) => c.id === renamedDraft.id && c.oldPath === 'src/original.ts'),
  );
  check(
    'reopened: listReviewComments includes the sent comment with sentAt',
    listed.some((c) => c.id === sentDraft.id && c.sentAt === sentAt),
  );

  check(
    'reopened: review_comments is still present and unchanged',
    rawCheck.prepare('SELECT COUNT(*) n FROM review_comments').get().n === 3,
  );
  rawCheck.close();
  after.close();
}

// ──────────────── Check 3: deleting a draft and reopening does not resurrect it ──────
{
  const store = createStore(dbPath);
  store.deleteReviewComment(rangeDraft.id);
  store.close();

  const reopened = createStore(dbPath);
  const listed = reopened.listReviewComments(task.id);
  check(
    'reopened: the deleted draft does not come back',
    !listed.some((c) => c.id === rangeDraft.id),
  );
  check('reopened: the other two drafts are still there', listed.length === 2);
  reopened.close();
}

// ─────────── Check 4: addReviewComment/updateReviewComment/deleteReviewComment guards ──
{
  const store = createStore(dbPath);
  check(
    'addReviewComment on an unknown task returns undefined',
    store.addReviewComment(makeCommentInput('no-such-task')) === undefined,
  );
  check(
    'updateReviewComment refuses an already-sent draft',
    store.updateReviewComment(sentDraft.id, { body: 'trying to rewrite history' }) === undefined,
  );
  check(
    'deleteReviewComment refuses an already-sent draft',
    store.deleteReviewComment(sentDraft.id) === false,
  );
  check(
    'the sent draft is unaffected by either refusal',
    store.listReviewComments(task.id).find((c) => c.id === sentDraft.id)?.body ===
      'about to be sent',
  );
  store.close();
}

// ──── Check 5: deleteTask/removeProject clear a subject's drafts/viewed/queue rows ───
{
  const store = createStore(dbPath);
  const cardA = store.createTask('personal', { title: 'Card A, about to be deleted' });
  const stepA = store.addSubtask(cardA.id, { title: 'A step of card A' });
  const cardB = store.createTask('personal', { title: 'Card B, survives' });
  check(
    'setup: card A, its step and card B were created',
    cardA != null && stepA != null && cardB != null,
  );

  store.addReviewComment(makeCommentInput(cardA.id, { body: 'on card A' }));
  store.addReviewComment(makeCommentInput(stepA.id, { body: "on card A's step" }));
  store.addReviewComment(makeCommentInput(cardB.id, { body: 'on card B' }));

  const subjA = subjectIdFor(cardA.id);
  const subjStepA = subjectIdFor(stepA.id);
  const subjB = subjectIdFor(cardB.id);

  const seed = new Database(dbPath);
  const seedViewed = seed.prepare(
    `INSERT INTO review_viewed (subjectId, path, blobSha, viewedAt) VALUES (?, ?, ?, ?)`,
  );
  const seedQueue = seed.prepare(
    `INSERT INTO review_queue (subjectId, queue, row, syncedAt) VALUES (?, ?, ?, ?)`,
  );
  const now = Date.now();
  for (const subj of [subjA, subjStepA, subjB]) {
    seedViewed.run(subj, 'src/viewed.ts', 'blob-sha', now);
    seedQueue.run(subj, 'mine', '{}', now);
  }
  seed.close();

  store.deleteTask(cardA.id);

  const rawAfter = new Database(dbPath);
  const remaining = (table, subj) =>
    rawAfter.prepare(`SELECT COUNT(*) n FROM ${table} WHERE subjectId = ?`).get(subj).n;
  check("deleteTask removes card A's own drafts", remaining('review_drafts', subjA) === 0);
  check("deleteTask removes card A's own viewed rows", remaining('review_viewed', subjA) === 0);
  check("deleteTask removes card A's own queue rows", remaining('review_queue', subjA) === 0);
  check("deleteTask removes card A's step's drafts", remaining('review_drafts', subjStepA) === 0);
  check(
    "deleteTask removes card A's step's viewed rows",
    remaining('review_viewed', subjStepA) === 0,
  );
  check(
    "deleteTask removes card A's step's queue rows",
    remaining('review_queue', subjStepA) === 0,
  );
  check("deleteTask leaves card B's drafts alone", remaining('review_drafts', subjB) === 1);
  check("deleteTask leaves card B's viewed rows alone", remaining('review_viewed', subjB) === 1);
  check("deleteTask leaves card B's queue rows alone", remaining('review_queue', subjB) === 1);
  rawAfter.close();

  // removeProject: every task in the project loses its subject rows; a task outside it
  // (card B, still in 'personal') is left alone.
  const project = store.addProject({ name: 'A project to remove' });
  const taskInProject1 = store.createTask(project.id, { title: 'Task 1 in the project' });
  const taskInProject2 = store.createTask(project.id, { title: 'Task 2 in the project' });
  check('setup: both project tasks were created', taskInProject1 != null && taskInProject2 != null);
  store.addReviewComment(makeCommentInput(taskInProject1.id, { body: 'p1' }));
  store.addReviewComment(makeCommentInput(taskInProject2.id, { body: 'p2' }));

  store.removeProject(project.id);

  const rawAfterProject = new Database(dbPath);
  const remainingAfterProject = (subj) =>
    rawAfterProject.prepare(`SELECT COUNT(*) n FROM review_drafts WHERE subjectId = ?`).get(subj).n;
  check(
    "removeProject removes every one of the project's tasks' drafts",
    remainingAfterProject(subjectIdFor(taskInProject1.id)) === 0 &&
      remainingAfterProject(subjectIdFor(taskInProject2.id)) === 0,
  );
  check(
    "removeProject leaves card B's drafts (outside the project) alone",
    remainingAfterProject(subjB) === 1,
  );
  rawAfterProject.close();

  store.close();
}

// ─────────── Check 6: syncTasksFromPlan keeps a survivor's drafts, drops the rest ────
{
  const store = createStore(dbPath);
  // 'personal' is the one project a fresh store already has — syncTasksFromPlan needs an
  // existing project row, same as `verify-review-comments-store.mjs`'s equivalent check.
  const projectId = 'personal';

  const planned = store.syncTasksFromPlan(projectId, [
    {
      phase: '',
      title: 'Keep me (drafts)',
      done: false,
      needs: [],
      isContract: false,
      isScaffold: false,
    },
    {
      phase: '',
      title: 'Drop me (drafts)',
      done: false,
      needs: [],
      isContract: false,
      isScaffold: false,
    },
  ]);
  const keepTask = planned.find((t) => t.title === 'Keep me (drafts)');
  const dropTask = planned.find((t) => t.title === 'Drop me (drafts)');
  check('setup: both plan tasks were created', keepTask != null && dropTask != null);

  store.addReviewComment(makeCommentInput(keepTask.id, { body: 'on the surviving task' }));
  store.addReviewComment(makeCommentInput(dropTask.id, { body: 'on the dropped task' }));

  store.syncTasksFromPlan(projectId, [
    {
      phase: '',
      title: 'Keep me (drafts)',
      done: false,
      needs: [],
      isContract: false,
      isScaffold: false,
    },
  ]);

  const afterKeep = store.listReviewComments(keepTask.id);
  check('a surviving task keeps its drafts after the re-sync', afterKeep.length === 1);
  check('the surviving draft is the same one', afterKeep[0]?.body === 'on the surviving task');

  const afterDrop = store.listReviewComments(dropTask.id);
  check("a dropped task's drafts do not survive the re-sync", afterDrop.length === 0);

  store.close();
}

// ──────── Check 7: review_queue — applyReviewQueue's complete-answer-only removal ────
{
  const store = createStore(dbPath);

  const queueItem = (subjectId, queue, provider, overrides = {}) => ({
    subjectId,
    queue,
    subject:
      provider === 'task'
        ? { kind: 'task', taskId: subjectId.slice('task:'.length) }
        : { kind: 'pr', provider, repoId: 1, repoPath: 'acme/repo', number: 1 },
    title: 'A title',
    author: '',
    repoPath: 'acme/repo',
    ref: '#1',
    headSha: null,
    draft: false,
    updatedAt: Date.now(),
    projectId: null,
    taskId: null,
    draftCount: 0,
    viewedCount: 0,
    fileCount: null,
    ...overrides,
  });

  // Seed two requested:github rows, one requested:gitlab row and one mine row, all at the
  // same old syncedAt.
  store.applyReviewQueue(
    { queue: 'requested', provider: 'github' },
    [queueItem('gh-1-1', 'requested', 'github'), queueItem('gh-1-2', 'requested', 'github')],
    1000,
    { complete: true },
  );
  store.applyReviewQueue(
    { queue: 'requested', provider: 'gitlab' },
    [queueItem('gl-1-1', 'requested', 'gitlab')],
    1000,
    { complete: true },
  );
  store.applyReviewQueue(
    { queue: 'mine' },
    [queueItem('gh-2-1', 'mine', 'github')],
    1000,
    { complete: true },
  );
  check('queue seed: every row landed', store.listReviewQueue().length === 4);

  // An INCOMPLETE requested:github pass that returns only ONE of its two rows must not
  // delete the other, and must not touch requested:gitlab or mine at all.
  store.applyReviewQueue(
    { queue: 'requested', provider: 'github' },
    [queueItem('gh-1-1', 'requested', 'github', { title: 'refreshed' })],
    2000,
    { complete: false },
  );
  let rows = store.listReviewQueue();
  const bySubject = (id) => rows.find((r) => r.item.subjectId === id);
  check(
    'incomplete: the row the pass returned was refreshed',
    bySubject('gh-1-1')?.syncedAt === 2000 && bySubject('gh-1-1')?.item.title === 'refreshed',
  );
  check(
    'incomplete: the row the pass did NOT return survives, untouched',
    bySubject('gh-1-2')?.syncedAt === 1000,
  );
  check('incomplete: the other provider segment is untouched', bySubject('gl-1-1')?.syncedAt === 1000);
  check('incomplete: the mine segment is untouched', bySubject('gh-2-1')?.syncedAt === 1000);
  check('incomplete: nothing at all was deleted', rows.length === 4);

  // A COMPLETE requested:github pass that returns only gh-1-1 must delete gh-1-2 — and
  // still leave requested:gitlab and mine alone.
  store.applyReviewQueue(
    { queue: 'requested', provider: 'github' },
    [queueItem('gh-1-1', 'requested', 'github', { title: 'final' })],
    3000,
    { complete: true },
  );
  rows = store.listReviewQueue();
  const bySubject2 = (id) => rows.find((r) => r.item.subjectId === id);
  check('complete: the row the pass did not return was deleted', bySubject2('gh-1-2') === undefined);
  check(
    'complete: the row the pass DID return survives, refreshed',
    bySubject2('gh-1-1')?.syncedAt === 3000 && bySubject2('gh-1-1')?.item.title === 'final',
  );
  check('complete: requested:gitlab is still untouched', bySubject2('gl-1-1')?.syncedAt === 1000);
  check('complete: mine is still untouched', bySubject2('gh-2-1')?.syncedAt === 1000);
  check('complete: exactly one row was removed', rows.length === 3);

  store.close();
}

// ──────── Check 8: countReviewDrafts / countReviewViewed are grouped reads ───────────
{
  const store = createStore(dbPath);
  const countsTask = store.createTask('personal', { title: 'A task for counts' });
  const subj = subjectIdFor(countsTask.id);
  const unsent = store.addReviewComment(makeCommentInput(countsTask.id, { body: 'one' }));
  store.addReviewComment(makeCommentInput(countsTask.id, { body: 'two' }));
  store.markReviewSent(countsTask.id, [unsent.id], Date.now());
  check(
    'setup: one draft on the task is now sent, one is still a draft',
    store.listReviewComments(countsTask.id).filter((c) => c.sentAt === null).length === 1,
  );

  const drafts = store.countReviewDrafts();
  check('countReviewDrafts counts only the unsent draft, not the sent one', drafts.get(subj) === 1);

  const raw = new Database(dbPath);
  const insertViewed = raw.prepare(
    `INSERT INTO review_viewed (subjectId, path, blobSha, viewedAt) VALUES (?, ?, ?, ?)`,
  );
  insertViewed.run(subj, 'a.ts', 'sha-a', Date.now());
  insertViewed.run(subj, 'b.ts', 'sha-b', Date.now());
  raw.close();

  const viewed = store.countReviewViewed();
  check('countReviewViewed counts every stored mark for the subject', viewed.get(subj) === 2);
  check(
    'countReviewDrafts/countReviewViewed answer nothing for an unknown subject',
    store.countReviewDrafts().get('task:no-such-task') === undefined &&
      store.countReviewViewed().get('task:no-such-task') === undefined,
  );

  store.close();
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
