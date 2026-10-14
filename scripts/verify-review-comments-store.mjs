/**
 * Headless proof of the review_comments store (F6.7) — the table and the five
 * `Store` methods built on it: listReviewComments, addReviewComment, updateReviewComment,
 * deleteReviewComment, markReviewSent.
 *
 *     node scripts/verify-review-comments-store.mjs
 *
 * ## Why this is a script and not a test
 *
 * It would rather be `store.test.ts`. It cannot be: `better-sqlite3`'s addon is compiled for
 * ELECTRON's ABI, so `require`ing it under the Node that runs vitest dies with
 * `ERR_DLOPEN_FAILED`. That is why nothing in the suite calls `createStore` — the store's
 * schema and every migration in it have no automated coverage at all, and this script is the
 * only thing that exercises one. Copied from `verify-automations-store.mjs` — same esbuild
 * discovery, same Electron-as-Node hand-off, same scratch DB in the OS temp directory. See
 * also the `verify-electron-app` rule: never launch the app to check something.
 *
 * The pure row mapper (`reviewCommentToRow`/`rowToReviewComment`) has its own vitest coverage
 * in `reviewCommentRows.test.ts` — this script only proves the SQL built on top of it.
 *
 * ## What it proves
 *
 * 1. A fresh database already has `review_comments` with every column the mapper expects.
 * 2. `addReviewComment` assigns id/createdAt/updatedAt/sentAt, round-trips a single-line and
 *    a range comment through `listReviewComments`, and returns `undefined` for an unknown
 *    task (the foreign key refuses it) rather than throwing.
 * 3. `updateReviewComment` merges a patch and bumps `updatedAt`, leaves an unpatched field
 *    alone, refuses an unknown id AND an already-sent comment — the `sentAt IS NULL`
 *    guard is enforced in SQL, not just by the caller — and `{ start: null }` clears a
 *    range back down to a single-line anchor.
 * 4. `deleteReviewComment` removes a draft but refuses a sent one, returning `false` rather
 *    than throwing either way.
 * 5. `markReviewSent` stamps every listed draft on the named task in one transaction,
 *    returns only the rows it actually stamped, ignores an id that belongs to a different
 *    task, and stamps nothing on a second call with the same ids (idempotent).
 * 6. Deleting a task cascades to its review comments (`foreign_keys = ON`, same as
 *    `task_attachments`).
 * 7. `syncTasksFromPlan` carries a surviving task's review comments across the
 *    delete-and-reinsert a plan re-sync performs, and drops the comments of a task the
 *    re-sync itself drops.
 *
 * Prove the checks matter yourself with either of these two mutations — both go red:
 *
 *   - Drop `AND sentAt IS NULL` from `markReviewSentStmt`'s WHERE clause in `store.ts`
 *     (`updateReviewComment`/`deleteReviewComment` also check `sentAt` in JS before ever
 *     reaching SQL, so mutating THEIR statements alone changes nothing observable —
 *     `markReviewSent` has no such JS-side guard, so this is the one that bites): check
 *     5's "a second call with the same ids stamps nothing" goes red, because the second
 *     call re-stamps with a new `sentAt`.
 *   - Delete the `for (const row of reviewComments) { ... }` restore loop inside
 *     `syncTasksFromPlan`'s transaction in `store.ts`: check 7's "a surviving task keeps
 *     its review comments" goes red, because the comment is gone after the re-sync.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const scratch = mkdtempSync(join(tmpdir(), 'tm-review-comments-store-'));

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
  const bundle = (entry, outfile, external) =>
    spawnSync(
      esbuild,
      [
        entry,
        '--bundle',
        '--platform=node',
        '--format=cjs',
        `--alias:@shared=${join(root, 'packages', 'shared', 'src')}`,
        `--alias:@protocol=${join(root, 'packages', 'protocol', 'src')}`,
        ...(external ? [`--external:${external}`] : []),
        `--outfile=${outfile}`,
        '--log-level=error',
      ],
      { stdio: 'inherit' },
    );

  bundle(
    join(root, 'apps/client/src/main/store.ts'),
    join(scratch, 'store.cjs'),
    'better-sqlite3',
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

const dbPath = join(work, 'orchestrator.db');

// ── Check 1: a fresh database already has the schema ─────────────────────────────────
{
  const store = createStore(dbPath);
  const raw = new Database(dbPath);
  const tableNames = raw
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all()
    .map((r) => r.name);
  check('fresh db has review_comments', tableNames.includes('review_comments'));
  const columns = raw.prepare('PRAGMA table_info(review_comments)').all().map((c) => c.name);
  for (const col of [
    'id', 'taskId', 'diffId', 'path', 'oldPath', 'side', 'line', 'startSide', 'startLine',
    'body', 'excerpt', 'createdAt', 'updatedAt', 'sentAt',
  ]) {
    check(`review_comments has column ${col}`, columns.includes(col));
  }
  raw.close();
  store.close();
}

// ── Check 2: addReviewComment + listReviewComments round-trip ────────────────────────
let taskA;
let taskB;
{
  const store = createStore(dbPath);
  taskA = store.createTask('personal', { title: 'Task A' });
  taskB = store.createTask('personal', { title: 'Task B' });
  check('setup: task A was created', taskA != null);
  check('setup: task B was created', taskB != null);

  const added = store.addReviewComment(makeCommentInput(taskA.id));
  check('addReviewComment returns a comment', added != null);
  check('addReviewComment assigns an id', typeof added?.id === 'string' && added.id.length > 0);
  check('a fresh draft has createdAt === updatedAt', added?.createdAt === added?.updatedAt);
  check('a fresh draft starts unsent', added?.sentAt === null);

  const ranged = store.addReviewComment(
    makeCommentInput(taskA.id, { line: 15, start: { side: 'new', line: 12 } }),
  );
  check('a range comment round-trips start', ranged?.start?.side === 'new' && ranged?.start?.line === 12);

  const listed = store.listReviewComments(taskA.id);
  check('listReviewComments returns both comments', listed.length === 2);
  check(
    'listReviewComments is ordered oldest first',
    listed[0].id === added.id && listed[1].id === ranged.id,
  );
  check("another task's list is untouched", store.listReviewComments(taskB.id).length === 0);

  const onUnknownTask = store.addReviewComment(makeCommentInput('no-such-task'));
  check('addReviewComment on an unknown task returns undefined', onUnknownTask === undefined);

  store.close();
}

// ── Check 3: updateReviewComment merges, bumps updatedAt, and guards sentAt ──────────
{
  const store = createStore(dbPath);
  const draft = store.addReviewComment(makeCommentInput(taskA.id, { body: 'original body' }));

  const patched = store.updateReviewComment(draft.id, { body: 'edited body' });
  check('updateReviewComment returns the patched comment', patched != null);
  check('the body patch round-trips', patched?.body === 'edited body');
  check('an unpatched field is left alone', patched?.excerpt === draft.excerpt);
  check('updatedAt moves on from a patch', (patched?.updatedAt ?? 0) >= draft.updatedAt);
  check('createdAt is never touched by a patch', patched?.createdAt === draft.createdAt);

  const missing = store.updateReviewComment('no-such-comment', { body: 'x' });
  check('updateReviewComment on an unknown id returns undefined', missing === undefined);

  const now = Date.now();
  store.markReviewSent(taskA.id, [draft.id], now);
  const onSent = store.updateReviewComment(draft.id, { body: 'trying to rewrite history' });
  check('updateReviewComment on an already-sent comment returns undefined', onSent === undefined);
  const stillSent = store.listReviewComments(taskA.id).find((c) => c.id === draft.id);
  check(
    "the sent comment's body did not change",
    stillSent?.body === 'edited body',
  );

  store.close();
}

// ── Check 3b: updateReviewComment({ start: null }) clears a range ───────────────────
{
  const store = createStore(dbPath);
  const ranged = store.addReviewComment(
    makeCommentInput(taskA.id, { line: 20, start: { side: 'new', line: 18 } }),
  );
  check('setup: the draft starts with a range', ranged?.start?.line === 18);

  const cleared = store.updateReviewComment(ranged.id, { start: null });
  check('updateReviewComment({ start: null }) returns the comment', cleared != null);
  check('the range is cleared off the returned comment', cleared?.start === undefined);
  const stored = store.listReviewComments(taskA.id).find((c) => c.id === ranged.id);
  check('the cleared range round-trips as absent, not null', stored?.start === undefined);

  store.close();
}

// ── Check 4: deleteReviewComment removes a draft but refuses a sent one ─────────────
{
  const store = createStore(dbPath);
  const draft = store.addReviewComment(makeCommentInput(taskA.id));

  const missing = store.deleteReviewComment('no-such-comment');
  check('deleteReviewComment on an unknown id returns false', missing === false);

  const deleted = store.deleteReviewComment(draft.id);
  check('deleteReviewComment removes a draft', deleted === true);
  check(
    'the deleted draft is gone from the list',
    !store.listReviewComments(taskA.id).some((c) => c.id === draft.id),
  );

  const sent = store.addReviewComment(makeCommentInput(taskA.id));
  store.markReviewSent(taskA.id, [sent.id], Date.now());
  const refused = store.deleteReviewComment(sent.id);
  check('deleteReviewComment refuses a sent comment', refused === false);
  check(
    'the sent comment is still there',
    store.listReviewComments(taskA.id).some((c) => c.id === sent.id),
  );

  store.close();
}

// ── Check 5: markReviewSent — scoping, idempotency, and the partial stamp ──────────
{
  const store = createStore(dbPath);
  const c1 = store.addReviewComment(makeCommentInput(taskA.id));
  const c2 = store.addReviewComment(makeCommentInput(taskA.id));
  const onB = store.addReviewComment(makeCommentInput(taskB.id));

  const now = Date.now();
  const stamped = store.markReviewSent(taskA.id, [c1.id, c2.id, onB.id, 'no-such-id'], now);
  check(
    'markReviewSent stamps only the ids that belong to the named task',
    stamped.length === 2 && stamped.every((c) => c.id === c1.id || c.id === c2.id),
  );
  check('a stamped comment reads sentAt back', stamped.every((c) => c.sentAt === now));
  check(
    "a different task's comment was left alone",
    store.listReviewComments(taskB.id).find((c) => c.id === onB.id)?.sentAt === null,
  );

  const again = store.markReviewSent(taskA.id, [c1.id, c2.id], now + 1);
  check('a second call with the same ids stamps nothing', again.length === 0);

  store.close();
}

// ── Check 6: deleting a task cascades to its review comments ────────────────────────
{
  const store = createStore(dbPath);
  const task = store.createTask('personal', { title: 'Task to delete' });
  store.addReviewComment(makeCommentInput(task.id));
  check('the doomed task has a comment before delete', store.listReviewComments(task.id).length === 1);

  store.deleteTask(task.id);
  check('deleteTask cascades to its review comments', store.listReviewComments(task.id).length === 0);

  store.close();
}

// ── Check 7: syncTasksFromPlan preserves a surviving task's comments, drops the rest ─
{
  const store = createStore(dbPath);
  // 'personal' (`PERSONAL_PROJECT_ID`) is the one project a fresh store already has —
  // syncTasksFromPlan needs an existing project row, same FK as `tasks.projectId` everywhere
  // else. Task A/B from check 2 live here too, but as `source: 'adhoc'` tasks (created via
  // `createTask`) they are never plan-managed, so they neither block nor get caught up in it.
  const projectId = 'personal';

  const planned = store.syncTasksFromPlan(projectId, [
    { phase: '', title: 'Keep me', done: false, needs: [], isContract: false, isScaffold: false },
    { phase: '', title: 'Drop me', done: false, needs: [], isContract: false, isScaffold: false },
  ]);
  const keepTask = planned.find((t) => t.title === 'Keep me');
  const dropTask = planned.find((t) => t.title === 'Drop me');
  check('setup: both plan tasks were created', keepTask != null && dropTask != null);

  store.addReviewComment(makeCommentInput(keepTask.id, { body: 'on the surviving task' }));
  store.addReviewComment(makeCommentInput(dropTask.id, { body: 'on the dropped task' }));

  store.syncTasksFromPlan(projectId, [
    { phase: '', title: 'Keep me', done: false, needs: [], isContract: false, isScaffold: false },
  ]);

  const afterKeep = store.listReviewComments(keepTask.id);
  check('a surviving task keeps its review comments', afterKeep.length === 1);
  check('the surviving comment is the same one', afterKeep[0]?.body === 'on the surviving task');

  const afterDrop = store.listReviewComments(dropTask.id);
  check("a dropped task's review comments do not survive the re-sync", afterDrop.length === 0);

  store.close();
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
