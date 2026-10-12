/**
 * Headless verification for F2.4's activity log — the half `vitest` cannot reach.
 *
 * `activity.test.ts` (packages/shared) covers the pure vocabulary and `summarizeOutcomes`
 * against fakes. What it cannot cover is `store.ts`'s own half: the `activity_log` table,
 * its three plain indexes, and the one PARTIAL unique index that makes
 * `appendActivity`'s `INSERT OR IGNORE` an idempotency check rather than a plain insert.
 * `better-sqlite3` only loads inside Electron's own ABI, so none of this can run under the
 * Node that runs `vitest` — see memory `the-store-has-no-tests`.
 *
 * The app is NEVER launched (RELEASE.md rule 6 / memory `verify-electron-app`). This drives
 * `createStore` directly under `ELECTRON_RUN_AS_NODE`, against a scratch database inside the
 * work directory. It never opens, reads or writes the real profile.
 *
 * Modelled on `verify-round.mjs`: the scenario file is bundled with Vite first (`@shared`
 * and `@protocol` aliased to their workspace packages' source — `store.ts` reaches
 * `cloudDelta.ts`, which takes a runtime value from `@protocol/wire` — `electron` aliased
 * to a throwing stub, `better-sqlite3` kept external so its native addon is still a real
 * `require` at run time), then run under Electron-as-Node so the addon's ABI matches the
 * binary loading it.
 *
 *   pnpm exec node scripts/verify-activity-store.mjs
 *
 * Exits non-zero on the first failed assertion, naming it. In particular: removing the
 * partial unique index `idx_activity_log_run_once` from the schema (or widening it off
 * `run-started`/`run-finished`) makes section 3's duplicate-run check fail, because the
 * second `appendActivity` would then actually insert instead of being ignored.
 *
 * Section 8 covers F2.5's backfill (`activityBackfill.ts`) on a SEPARATE scratch database:
 * seeding raw `task_events`/`task_activity` rows the way a database that predates F2.4's
 * live recorders would hold them, then letting `createStore` derive thirty days of
 * `activity_log` history from them exactly once. Narrowing the 30-day window, or dropping
 * the `app_state` guard check, makes its "nothing older than thirty days" or "unchanged on a
 * second boot" assertions fail.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'vite';

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** `@shared` lives in the packages/shared workspace package, not under this app. */
const sharedSrc = join(repo, '..', '..', 'packages', 'shared', 'src');
/** `store.ts` reaches `cloudDelta.ts`, which takes a runtime value from `@protocol/wire`. */
const protocolSrc = join(repo, '..', '..', 'packages', 'protocol', 'src');

/**
 * Everything this script writes lives here, INSIDE the repo rather than in the temp dir,
 * for one reason: the bundle keeps `better-sqlite3` external, so it must sit somewhere
 * Node's resolution can still find `node_modules`. Removed on the way out, and on the way
 * in — a crashed previous run must not leak into this one.
 */
const work = join(repo, '.verify-activity-store');

const electronBin = join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
const electronBinPosix = join(repo, 'node_modules', 'electron', 'dist', 'electron');

function log(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * Nothing under test calls Electron on this path — `store.ts` itself never touches it — but
 * every symbol throws rather than returning a plausible value, so a scenario that DOES reach
 * one fails loudly here instead of quietly verifying a stub.
 */
const ELECTRON_STUB = `
const unavailable = (name) => () => {
  throw new Error(\`Electron's \${name} is not available in headless verification\`);
};
export const app = { getPath: unavailable('app.getPath'), on: unavailable('app.on') };
export const protocol = { handle: unavailable('protocol.handle') };
export const ipcMain = { handle: unavailable('ipcMain.handle') };
export const shell = { openPath: unavailable('shell.openPath') };
export const safeStorage = { isEncryptionAvailable: () => false };
export const BrowserWindow = class {};
export default { app, protocol, ipcMain, shell, safeStorage, BrowserWindow };
`;

/** Bundle the scenario file to a runnable ESM module. */
async function bundle(entry, outDir) {
  const stub = join(work, 'electron-stub.mjs');
  writeFileSync(stub, ELECTRON_STUB, 'utf8');
  await build({
    configFile: false,
    logLevel: 'error',
    resolve: { alias: { '@shared': sharedSrc, '@protocol': protocolSrc, electron: stub } },
    build: {
      ssr: entry,
      outDir,
      emptyOutDir: true,
      target: 'node20',
      minify: false,
      // The native addon must stay a real `import` resolved at run time — bundling a
      // `.node` file is exactly the mistake this whole ABI dance exists to avoid.
      rollupOptions: {
        external: ['better-sqlite3'],
        output: { format: 'es', entryFileNames: 'bundle.mjs' },
      },
    },
  });
  return join(outDir, 'bundle.mjs');
}

/** Run a bundle under Electron-as-Node, so `better_sqlite3.node` loads against its own ABI. */
function runUnderElectron(bundlePath) {
  const bin = existsSync(electronBin) ? electronBin : electronBinPosix;
  if (!existsSync(bin)) throw new Error(`No Electron binary at ${bin}`);
  const result = spawnSync(bin, [bundlePath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${bundlePath} exited ${result.status ?? `on ${result.signal}`}`);
  }
}

// ---------------------------------------------------------------------------

async function main() {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  try {
    // The ABI the whole exercise depends on. Checked first and by itself — every scenario
    // below fails identically and unhelpfully when this is wrong.
    const abi = require('./native-abi.mjs');
    const addon = join(
      dirname(require.resolve('better-sqlite3/package.json')),
      abi.ADDON_RELATIVE_PATH,
    );
    const expected = abi.readElectronAbi(require('electron'));
    const actual = abi.readModuleAbi(readFileSync(addon));
    if (expected !== actual) {
      throw new Error(
        `better_sqlite3.node targets ABI ${actual} but Electron is ABI ${expected} — ` +
          `run \`pnpm ensure:abi\` first`,
      );
    }
    log(`ABI ok: addon and Electron both ${actual}`);

    const scratch = join(work, 'scratch').replace(/\\/g, '/');
    const entry = join(work, 'entry.ts');
    writeFileSync(
      entry,
      SCENARIOS.replaceAll('__SCRATCH__', scratch).replaceAll('__REPO__', repo.replace(/\\/g, '/')),
      'utf8',
    );
    log('\nRunning the scenarios against the current code...');
    runUnderElectron(await bundle(entry, join(work, 'out')));

    log('\nAll scenarios passed.');
  } finally {
    // `--keep` leaves the bundle and the scratch database behind, which is the only way to
    // open one afterwards and see what a failing scenario actually wrote.
    if (process.argv.includes('--keep')) log(`\nLeft ${work} in place (--keep).`);
    else rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The scenarios themselves, as a template so the paths are baked in rather than passed — a
 * bundle takes no argv worth threading, and every path in it is scratch or this repo.
 */
const SCENARIOS = String.raw`
import { mkdirSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createStore } from '__REPO__/src/main/store';
import { decodeCursor } from '@shared/activity';
import { ACTIVITY_BACKFILL_DAYS, ACTIVITY_BACKFILL_KEY } from '__REPO__/src/main/activityBackfill';

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log('  PASS  ' + label);
  } else {
    failures += 1;
    console.log('  FAIL  ' + label + (detail === undefined ? '' : ' — ' + detail));
  }
}
function section(name) {
  console.log('\n' + name);
}

const scratch = '__SCRATCH__';
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

const dbPath = scratch + '/orchestrator.db';
const store = createStore(dbPath);
// A second, raw connection onto the SAME file — for reading back exactly what landed in the
// column (store.appendActivity returns the literal it was given, not a re-read row) and for
// planting a row store.ts itself could never write (an unrecognized kind), the way a newer
// build's writer would.
const raw = new Database(dbPath);

function columnsOf(table) {
  return raw.prepare('PRAGMA table_info(' + table + ')').all().map((c) => c.name);
}
function fksOf(table) {
  return raw.prepare('PRAGMA foreign_key_list(' + table + ')').all();
}
function indexListOf(table) {
  return raw.prepare('PRAGMA index_list(' + table + ')').all();
}
function ddlOf(name) {
  return raw.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name)?.sql ?? '';
}
function rawRow(runId, kind) {
  return raw
    .prepare('SELECT * FROM activity_log WHERE runId = ? AND kind = ?')
    .get(runId, kind);
}

// ---------------------------------------------------------------------------
section('1. activity_log schema: columns, indexes, and no foreign keys');

check(
  'the table exists',
  Boolean(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='activity_log'").get()),
);
check(
  'its ten columns, in order',
  columnsOf('activity_log').join(',') ===
    'id,at,projectId,taskId,runId,kind,outcome,origin,title,costUsd,detail',
  columnsOf('activity_log').join(','),
);
check('it carries no foreign key — a record of what happened outlives the row it names', fksOf('activity_log').length === 0);

const indexNames = indexListOf('activity_log').map((i) => i.name);
check(
  'idx_activity_log_time exists, non-unique',
  indexListOf('activity_log').some((i) => i.name === 'idx_activity_log_time' && i.unique === 0),
);
check(
  'idx_activity_log_project exists, non-unique',
  indexListOf('activity_log').some((i) => i.name === 'idx_activity_log_project' && i.unique === 0),
);
check(
  'idx_activity_log_kind exists, non-unique',
  indexListOf('activity_log').some((i) => i.name === 'idx_activity_log_kind' && i.unique === 0),
);
const runOnce = indexListOf('activity_log').find((i) => i.name === 'idx_activity_log_run_once');
check(
  'idx_activity_log_run_once exists and is UNIQUE',
  Boolean(runOnce) && runOnce.unique === 1,
  JSON.stringify(runOnce),
);
check(
  "idx_activity_log_run_once is genuinely PARTIAL — scoped to run-started/run-finished",
  /WHERE/i.test(ddlOf('idx_activity_log_run_once')) &&
    /run-started/.test(ddlOf('idx_activity_log_run_once')) &&
    /run-finished/.test(ddlOf('idx_activity_log_run_once')),
  ddlOf('idx_activity_log_run_once'),
);
check('all four indexes are present', indexNames.length >= 4, JSON.stringify(indexNames));

// ---------------------------------------------------------------------------
section('2. appendActivity: id assignment, null-preserving costUsd, detail round-trip');

const started = store.appendActivity({
  at: 1000,
  projectId: 'proj-1',
  taskId: 'task-1',
  runId: 'run-basic',
  kind: 'run-started',
  outcome: null,
  origin: 'human',
  title: 'A card starting',
  costUsd: null,
  detail: null,
});
check('the insert was accepted', Boolean(started));
check('it got a positive integer id', Number.isInteger(started.id) && started.id > 0, String(started.id));
const startedRaw = rawRow('run-basic', 'run-started');
check(
  'the row landed with the id SQLite actually assigned',
  Boolean(startedRaw) && startedRaw.id === started.id,
);
check(
  "a null costUsd is stored as NULL, never coerced to 0 — unknown is not free",
  startedRaw.costUsd === null,
  String(startedRaw.costUsd),
);

const detailGiven = { branch: 'feat/x', backfilled: true };
const withDetail = store.appendActivity({
  at: 1001,
  projectId: 'proj-1',
  taskId: 'task-1',
  runId: 'run-detail',
  kind: 'merge-landed',
  outcome: null,
  origin: 'chain',
  title: 'A card merging',
  costUsd: 1.23,
  detail: detailGiven,
});
check('the detailed insert was accepted', Boolean(withDetail));
const detailRaw = rawRow('run-detail', 'merge-landed');
check(
  'detail is JSON-encoded on the way in, and decodes back to the same object',
  JSON.stringify(JSON.parse(detailRaw.detail)) === JSON.stringify(detailGiven),
  detailRaw.detail,
);
check('costUsd is stored exactly as given', detailRaw.costUsd === 1.23, String(detailRaw.costUsd));

const noDetail = store.appendActivity({
  at: 1002,
  projectId: null,
  taskId: null,
  runId: 'run-no-detail',
  kind: 'status-moved',
  outcome: null,
  origin: 'resume',
  title: 'No detail at all',
  costUsd: 0,
  detail: null,
});
check('an insert with no detail is accepted', Boolean(noDetail));
check(
  'detail NULL stays NULL (never the string "null")',
  rawRow('run-no-detail', 'status-moved').detail === null,
);
check(
  "a genuine 0 cost is stored as 0, distinct from NULL (unknown)",
  rawRow('run-no-detail', 'status-moved').costUsd === 0,
);

// ---------------------------------------------------------------------------
section('3. run-started/run-finished idempotency rides on the partial unique index');

const dup1 = store.appendActivity({
  at: 2000,
  projectId: 'proj-1',
  taskId: 'task-1',
  runId: 'run-dup',
  kind: 'run-started',
  outcome: null,
  origin: 'chain',
  title: 'First start',
  costUsd: null,
  detail: null,
});
const dup2 = store.appendActivity({
  at: 2001,
  projectId: 'proj-1',
  taskId: 'task-1',
  runId: 'run-dup',
  kind: 'run-started',
  outcome: null,
  origin: 'chain',
  title: 'A resurrected start event',
  costUsd: null,
  detail: null,
});
check('the first run-started for run-dup is accepted', Boolean(dup1));
check(
  'a SECOND run-started for the same runId is ignored, not inserted — ' +
    'this is the check a removed or narrowed partial index breaks',
  dup2 === null,
  JSON.stringify(dup2),
);
const dupStartedCount = raw
  .prepare("SELECT COUNT(*) AS n FROM activity_log WHERE runId = ? AND kind = 'run-started'")
  .get('run-dup').n;
check('exactly one row was actually written for it', dupStartedCount === 1, String(dupStartedCount));

const finish1 = store.appendActivity({
  at: 2002,
  projectId: 'proj-1',
  taskId: 'task-1',
  runId: 'run-dup',
  kind: 'run-finished',
  outcome: 'done',
  origin: 'chain',
  title: 'First finish',
  costUsd: 0.5,
  detail: null,
});
const finish2 = store.appendActivity({
  at: 2003,
  projectId: 'proj-1',
  taskId: 'task-1',
  runId: 'run-dup',
  kind: 'run-finished',
  outcome: 'failed',
  origin: 'chain',
  title: 'A resurrected finish event',
  costUsd: 0.6,
  detail: null,
});
check(
  "run-finished has its OWN slot in the index — the first one for run-dup is accepted " +
    'even though run-started already used that runId',
  Boolean(finish1),
);
check('a second run-finished for the same runId is ignored too', finish2 === null, JSON.stringify(finish2));
const dupTotalCount = raw.prepare('SELECT COUNT(*) AS n FROM activity_log WHERE runId = ?').get('run-dup').n;
check(
  'run-dup ends up with exactly two rows total — one start, one finish, nothing doubled',
  dupTotalCount === 2,
  String(dupTotalCount),
);

const park1 = store.appendActivity({
  at: 2100,
  projectId: 'proj-1',
  taskId: 'task-1',
  runId: 'run-park',
  kind: 'parked',
  outcome: null,
  origin: 'chain',
  title: 'Parked once',
  costUsd: null,
  detail: null,
});
const park2 = store.appendActivity({
  at: 2101,
  projectId: 'proj-1',
  taskId: 'task-1',
  runId: 'run-park',
  kind: 'parked',
  outcome: null,
  origin: 'chain',
  title: 'Parked again on the same run',
  costUsd: null,
  detail: null,
});
check(
  "kinds outside run-started/run-finished are NOT guarded by the partial index — " +
    'the same runId can be parked more than once',
  Boolean(park1) && Boolean(park2),
  JSON.stringify([park1, park2]),
);

// ---------------------------------------------------------------------------
section('4. listActivity: ordering, keyset paging, and the unrecognized-kind skip');

// Three rows, newest first by construction: A (known), B (an unrecognized kind, planted
// straight into the table — no build of this store could ever produce it), C (known).
const rowA = store.appendActivity({
  at: 3_000_002,
  projectId: 'proj-paging',
  taskId: 'task-paging',
  runId: 'run-a',
  kind: 'merge-landed',
  outcome: null,
  origin: 'chain',
  title: 'Row A, the newest',
  costUsd: null,
  detail: null,
});
raw
  .prepare(
    'INSERT INTO activity_log (at, projectId, taskId, runId, kind, outcome, origin, title, costUsd, detail)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  .run(3_000_001, 'proj-paging', 'task-paging', 'run-b', 'kind-from-a-future-build', null, null, 'Row B, unrecognized', null, null);
const rowBId = raw
  .prepare("SELECT id FROM activity_log WHERE runId = 'run-b'")
  .get().id;
const rowC = store.appendActivity({
  at: 3_000_000,
  projectId: 'proj-paging',
  taskId: 'task-paging',
  runId: 'run-c',
  kind: 'merge-landed',
  outcome: null,
  origin: 'chain',
  title: 'Row C, the oldest',
  costUsd: null,
  detail: null,
});

const page1 = store.listActivity({ sinceMs: 3_000_000, limit: 1 });
check('page 1 holds only row A', page1.rows.length === 1 && page1.rows[0].id === rowA.id, JSON.stringify(page1));
check('page 1 says there is more', page1.nextCursor !== null);
const cursor1 = decodeCursor(page1.nextCursor);
check(
  "page 1's cursor is row A's own (at, id) — a page resumes after its LAST fetched row",
  Boolean(cursor1) && cursor1.at === 3_000_002 && cursor1.id === rowA.id,
  JSON.stringify(cursor1),
);

const page2 = store.listActivity({ sinceMs: 3_000_000, limit: 1, cursor: page1.nextCursor });
check(
  "page 2 comes back EMPTY — the only row at that keyset position is B, and an " +
    'unrecognized kind is silently skipped rather than surfaced',
  page2.rows.length === 0,
  JSON.stringify(page2),
);
check('page 2 still says there is more, past B', page2.nextCursor !== null);
const cursor2 = decodeCursor(page2.nextCursor);
check(
  "page 2's cursor sits on B itself, not on A again — the next page must resume AFTER " +
    'B, never re-fetch it',
  Boolean(cursor2) && cursor2.at === 3_000_001 && cursor2.id === rowBId,
  JSON.stringify(cursor2),
);

const page3 = store.listActivity({ sinceMs: 3_000_000, limit: 1, cursor: page2.nextCursor });
check('page 3 finally holds row C', page3.rows.length === 1 && page3.rows[0].id === rowC.id, JSON.stringify(page3));
check('and says there is nothing more', page3.nextCursor === null);

let badCursorThrew = false;
try {
  store.listActivity({ sinceMs: 0, limit: 10, cursor: 'not-a-real-cursor' });
} catch {
  badCursorThrew = true;
}
check('an undecodable cursor throws rather than silently resetting to page 1', badCursorThrew);

// ---------------------------------------------------------------------------
section('5. listActivity: filters and the sinceMs/untilMs window');

const filterProjectA = 'proj-filter-a';
const filterProjectB = 'proj-filter-b';
const rX = store.appendActivity({
  at: 4_000_003,
  projectId: filterProjectA,
  taskId: 't',
  runId: 'run-x',
  kind: 'merge-landed',
  outcome: null,
  origin: 'human',
  title: 'X',
  costUsd: null,
  detail: null,
});
const rY = store.appendActivity({
  at: 4_000_002,
  projectId: filterProjectB,
  taskId: 't',
  runId: 'run-y',
  kind: 'run-finished',
  outcome: 'done',
  origin: 'chain',
  title: 'Y',
  costUsd: null,
  detail: null,
});
const rZ = store.appendActivity({
  at: 4_000_001,
  projectId: filterProjectA,
  taskId: 't',
  runId: 'run-z',
  kind: 'run-finished',
  outcome: 'failed',
  origin: 'trigger:automation-1',
  title: 'Z',
  costUsd: null,
  detail: null,
});
const rW = store.appendActivity({
  at: 4_000_000,
  projectId: filterProjectA,
  taskId: 't',
  runId: 'run-w',
  kind: 'status-moved',
  outcome: null,
  origin: 'resume',
  title: 'W',
  costUsd: null,
  detail: null,
});

const byProject = store.listActivity({ sinceMs: 4_000_000, limit: 10, projectIds: [filterProjectA] });
check(
  'projectIds filters down to that project, newest first',
  byProject.rows.map((r) => r.id).join(',') === [rX.id, rZ.id, rW.id].join(','),
  JSON.stringify(byProject.rows.map((r) => r.title)),
);

const byKind = store.listActivity({ sinceMs: 4_000_000, limit: 10, kinds: ['run-finished'] });
check(
  'kinds filters to run-finished rows only',
  byKind.rows.map((r) => r.id).join(',') === [rY.id, rZ.id].join(','),
  JSON.stringify(byKind.rows.map((r) => r.title)),
);

const byOutcome = store.listActivity({ sinceMs: 4_000_000, limit: 10, outcomes: ['failed'] });
check(
  'outcomes filters to the failed row',
  byOutcome.rows.length === 1 && byOutcome.rows[0].id === rZ.id,
  JSON.stringify(byOutcome.rows.map((r) => r.title)),
);

const byOrigin = store.listActivity({ sinceMs: 4_000_000, limit: 10, origins: ['trigger:automation-1'] });
check(
  'a trigger: origin filters exactly as given, not just by its fixed prefix',
  byOrigin.rows.length === 1 && byOrigin.rows[0].id === rZ.id,
  JSON.stringify(byOrigin.rows.map((r) => r.title)),
);

const windowed = store.listActivity({ sinceMs: 4_000_000, untilMs: 4_000_002, limit: 10 });
check(
  'sinceMs is inclusive and untilMs is exclusive — Y (at the untilMs boundary) drops out, ' +
    'W (at the sinceMs boundary) stays in',
  windowed.rows.map((r) => r.id).join(',') === [rZ.id, rW.id].join(','),
  JSON.stringify(windowed.rows.map((r) => r.title)),
);

// ---------------------------------------------------------------------------
section('6. countOutcomes: bucketing, byProject, and the sinceMs floor');

const outcomeProjectA = 'proj-outcomes-a';
const outcomeProjectB = 'proj-outcomes-b';
store.appendActivity({
  at: 5_000_000,
  projectId: outcomeProjectA,
  taskId: 't',
  runId: 'run-done',
  kind: 'run-finished',
  outcome: 'done',
  origin: 'chain',
  title: 'done',
  costUsd: null,
  detail: null,
});
store.appendActivity({
  at: 5_000_001,
  projectId: outcomeProjectA,
  taskId: 't',
  runId: 'run-failed',
  kind: 'run-finished',
  outcome: 'failed',
  origin: 'chain',
  title: 'failed',
  costUsd: null,
  detail: null,
});
store.appendActivity({
  at: 5_000_002,
  projectId: outcomeProjectA,
  taskId: 't',
  runId: 'run-empty',
  kind: 'run-finished',
  outcome: 'empty',
  origin: 'chain',
  title: 'empty',
  costUsd: null,
  detail: null,
});
store.appendActivity({
  at: 5_000_003,
  projectId: outcomeProjectB,
  taskId: 't',
  runId: 'run-stopped',
  kind: 'run-finished',
  outcome: 'stopped',
  origin: 'human',
  title: 'stopped',
  costUsd: null,
  detail: null,
});
store.appendActivity({
  at: 5_000_004,
  projectId: outcomeProjectB,
  taskId: 't',
  runId: 'run-needs-input',
  kind: 'run-finished',
  outcome: 'needs-input',
  origin: 'chain',
  title: 'needs-input',
  costUsd: null,
  detail: null,
});
store.appendActivity({
  at: 5_000_005,
  projectId: null,
  taskId: null,
  runId: 'run-no-project',
  kind: 'run-finished',
  outcome: 'done',
  origin: 'chain',
  title: 'done, no project',
  costUsd: null,
  detail: null,
});
// A park, in the same window — proves only run-finished rows ever move these counts.
store.appendActivity({
  at: 5_000_006,
  projectId: outcomeProjectA,
  taskId: 't',
  runId: 'run-irrelevant',
  kind: 'parked',
  outcome: null,
  origin: 'chain',
  title: 'parked, not a finish',
  costUsd: null,
  detail: null,
});
// Below the floor — must not count once sinceMs is raised past it.
store.appendActivity({
  at: 4_999_999,
  projectId: outcomeProjectA,
  taskId: 't',
  runId: 'run-too-early',
  kind: 'run-finished',
  outcome: 'done',
  origin: 'chain',
  title: 'too early',
  costUsd: null,
  detail: null,
});

const outcomes = store.countOutcomes(5_000_000);
check(
  "'empty' folds into 'failed', and the park never moves anything",
  outcomes.total.done === 2 &&
    outcomes.total.failed === 2 &&
    outcomes.total.stopped === 1 &&
    outcomes.total.needsInput === 1,
  JSON.stringify(outcomes.total),
);
check(
  'the no-project row counts in total but has nowhere to go in byProject',
  outcomes.total.done === 2 &&
    outcomes.byProject[outcomeProjectA].done === 1 &&
    outcomes.byProject[outcomeProjectB].done === 0,
  JSON.stringify(outcomes.byProject),
);
check(
  'byProject splits the rest correctly too',
  outcomes.byProject[outcomeProjectA].failed === 2 &&
    outcomes.byProject[outcomeProjectB].stopped === 1 &&
    outcomes.byProject[outcomeProjectB].needsInput === 1,
  JSON.stringify(outcomes.byProject),
);
check(
  'sinceMs is a floor — the row one millisecond below it is excluded',
  store.countOutcomes(5_000_000).total.done === 2 && store.countOutcomes(4_999_999).total.done === 3,
);

// ---------------------------------------------------------------------------
section('7. pruneActivity: the retention sweep deletes by age and reports how much');

const threshold = 6_000_000;
// Written BEFORE the counts below, so "a mix of old and new" is checked against a database
// that genuinely has both — every row from sections 1-6 predates the threshold, and
// this is the one row that must survive it.
const freshKept = store.appendActivity({
  at: 7_000_000,
  projectId: 'proj-kept',
  taskId: 't',
  runId: 'run-kept',
  kind: 'run-finished',
  outcome: 'done',
  origin: 'chain',
  title: 'kept, written after the threshold',
  costUsd: null,
  detail: null,
});

const totalBefore = raw.prepare('SELECT COUNT(*) AS n FROM activity_log').get().n;
const expectedDeleted = raw
  .prepare('SELECT COUNT(*) AS n FROM activity_log WHERE at < ?')
  .get(threshold).n;
check(
  'there is a real mix of old and (about to be) new rows to prune against',
  expectedDeleted > 0 && expectedDeleted < totalBefore,
  expectedDeleted + ' of ' + totalBefore,
);

const deletedCount = store.pruneActivity(threshold);
check(
  'pruneActivity reports exactly how many rows it removed',
  deletedCount === expectedDeleted,
  deletedCount + ' vs expected ' + expectedDeleted,
);
const remaining = raw.prepare('SELECT COUNT(*) AS n FROM activity_log').get().n;
check(
  'the surviving row count matches what was left standing',
  remaining === totalBefore - expectedDeleted,
  remaining + ' vs ' + (totalBefore - expectedDeleted),
);
check('nothing below the threshold survives', raw.prepare('SELECT COUNT(*) AS n FROM activity_log WHERE at < ?').get(threshold).n === 0);
check(
  'the row written after the threshold is untouched',
  Boolean(raw.prepare('SELECT 1 FROM activity_log WHERE id = ?').get(freshKept.id)),
);

// ---------------------------------------------------------------------------
section('8. getDailyUsageInputs (F2.9): the token-free cost row is not dropped');

// A plain token row — no cost attached yet (costUsd lands later, on the end-of-run
// reconciliation row, per appendTokenUsage's own docstring).
store.appendTokenUsage({
  source: 'task',
  projectId: 'proj-usage',
  taskId: 'task-usage',
  runId: 'run-usage',
  inputTokens: 100,
  outputTokens: 50,
  cacheCreationTokens: 0,
  cacheReadTokens: 10,
  totalTokens: 160,
  costUsd: null,
  createdAt: 8_000_000,
});
// A token-free cost row: all four token fields are zero, which is exactly the shape
// getUsageSamples's 'totalTokens > 0' filter would drop — getDailyUsageInputs must not.
store.appendTokenUsage({
  source: 'task',
  projectId: 'proj-usage',
  taskId: 'task-usage',
  runId: 'run-usage',
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  costUsd: 0.42,
  createdAt: 8_000_001,
});

const dailyInputs = store.getDailyUsageInputs(8_000_000);
check(
  'both rows come back, including the zero-token cost row',
  dailyInputs.length === 2,
  JSON.stringify(dailyInputs),
);
const tokenRow = dailyInputs.find((r) => r.createdAt === 8_000_000);
const costRow = dailyInputs.find((r) => r.createdAt === 8_000_001);
check(
  'the token row carries its token counts and a null cost (unknown, not free)',
  Boolean(tokenRow) &&
    tokenRow.inputTokens === 100 &&
    tokenRow.outputTokens === 50 &&
    tokenRow.cacheReadTokens === 10 &&
    tokenRow.costUsd === null,
  JSON.stringify(tokenRow),
);
check(
  'the token-free row carries zero tokens and its priced costUsd',
  Boolean(costRow) &&
    costRow.inputTokens === 0 &&
    costRow.outputTokens === 0 &&
    costRow.cacheReadTokens === 0 &&
    costRow.costUsd === 0.42,
  JSON.stringify(costRow),
);

const pastTokenRow = store.getDailyUsageInputs(8_000_001);
check(
  'sinceMs is a floor here too — raising it past the token row drops only that one',
  pastTokenRow.length === 1 && pastTokenRow[0].createdAt === 8_000_001,
  JSON.stringify(pastTokenRow),
);

raw.close();
store.close();

// ---------------------------------------------------------------------------
section('8. activityBackfill: thirty days of history, derived once, guarded forever');

// A SEPARATE scratch database — this backfill reads task_events/task_activity, which the
// sections above have already filled with rows this backfill was never meant to see.
const bfScratch = '__SCRATCH__-backfill';
rmSync(bfScratch, { recursive: true, force: true });
mkdirSync(bfScratch, { recursive: true });
const bfDbPath = bfScratch + '/orchestrator.db';

// First boot: an empty database. Nothing to derive, but this is also what stamps the guard
// key — it must be cleared below to simulate a database that predates the backfill.
createStore(bfDbPath).close();

const bf = new Database(bfDbPath);
bf.prepare('DELETE FROM app_state WHERE key = ?').run(ACTIVITY_BACKFILL_KEY);

const day = 24 * 60 * 60 * 1000;
const now = Date.now();

function insertEvent(taskId, runId, event, createdAt) {
  bf.prepare(
    'INSERT INTO task_events (projectId, taskId, runId, event, createdAt) VALUES (?, ?, ?, ?, ?)',
  ).run('proj-bf', taskId, runId, JSON.stringify(event), createdAt);
}
function insertMove(taskId, fromStatus, toStatus, createdAt) {
  bf.prepare(
    'INSERT INTO task_activity (projectId, taskId, kind, fromStatus, toStatus, createdAt)' +
      ' VALUES (?, ?, ?, ?, ?, ?)',
  ).run('proj-bf', taskId, 'status', fromStatus, toStatus, createdAt);
}

bf.prepare(
  'INSERT INTO projects (id, name, path, planPath, defaultModel, defaultPermissionMode, createdAt)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?)',
).run('proj-bf', 'Backfill Co', '/tmp/proj-bf', '/tmp/proj-bf/PLAN.md', 'sonnet', 'default', now);
// 'task-kept' survives; 'task-deleted' never gets a row — the deleted-card case.
bf.prepare(
  'INSERT INTO tasks (id, projectId, phase, title, status, "order") VALUES (?, ?, ?, ?, ?, ?)',
).run('task-kept', 'proj-bf', 'build', 'Kept card', 'doing', 0);

// run-ok: started + a successful result. Within the window, card survives.
insertEvent('task-kept', 'run-ok', { kind: 'started' }, now - 5 * day);
insertEvent('task-kept', 'run-ok', { kind: 'result', success: true, costUsd: 2.5 }, now - 5 * day + 1000);

// run-resurrected: started + TWO results — the second (later id) must be the one that wins,
// per memory settled-run-resurrection-trap. Card is the deleted one, so title reads back ''.
insertEvent('task-deleted', 'run-resurrected', { kind: 'started' }, now - 4 * day);
insertEvent(
  'task-deleted',
  'run-resurrected',
  { kind: 'result', success: true, costUsd: 0.1 },
  now - 4 * day + 1000,
);
insertEvent(
  'task-deleted',
  'run-resurrected',
  { kind: 'result', success: false, costUsd: 0.2 },
  now - 4 * day + 2000,
);

// run-failed: a lone result, no started counterpart, costUsd genuinely unknown (NULL, not 0).
insertEvent('task-kept', 'run-failed', { kind: 'result', success: false, costUsd: null }, now - 3 * day);

// An ordinary column move, and a comment on the same card — the comment must be ignored.
insertMove('task-kept', 'todo', 'doing', now - 2 * day);
bf.prepare(
  'INSERT INTO task_activity (projectId, taskId, kind, body, createdAt) VALUES (?, ?, ?, ?, ?)',
).run('proj-bf', 'task-kept', 'comment', 'a comment', now - 2 * day + 500);

// A started event and a status move, both 31 days old — past the retention window, neither
// must produce a row.
insertEvent('task-kept', 'run-too-old', { kind: 'started' }, now - 31 * day);
insertMove('task-kept', 's-old', 'e-old', now - 31 * day);

// A LIVE (non-backfilled) row, as if F2.6/F2.8's recorder had already logged this move
// itself — this is the untilMs ceiling the rest of the window is measured against.
const liveAt = now - 1 * day;
bf.prepare(
  'INSERT INTO activity_log (at, projectId, taskId, runId, kind, outcome, origin, title, costUsd, detail)' +
    ' VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, NULL, ?)',
).run(liveAt, 'proj-bf', 'task-kept', 'status-moved', 'human', 'Kept card', JSON.stringify({ from: 'b', to: 'c' }));
// Older than the live row: still fair game for the backfill to derive.
insertMove('task-kept', 'x1', 'y1', liveAt - 12 * 60 * 60 * 1000);
// Newer than the live row: the live recorder already covers this — must NOT be derived.
insertMove('task-kept', 'x2', 'y2', liveAt + 12 * 60 * 60 * 1000);

// The second boot: this is the run that actually derives the history above.
const bfStore = createStore(bfDbPath);

function bfRow(runId, kind) {
  return bf.prepare('SELECT * FROM activity_log WHERE runId = ? AND kind = ?').get(runId, kind);
}
function moveRow(fromStatus, toStatus) {
  return bf
    .prepare(
      "SELECT * FROM activity_log WHERE kind = 'status-moved'" +
        " AND json_extract(detail, '$.from') = ? AND json_extract(detail, '$.to') = ?",
    )
    .get(fromStatus, toStatus);
}

const okStarted = bfRow('run-ok', 'run-started');
check(
  'run-started for an ordinary run: at, title, outcome/costUsd NULL, backfilled',
  Boolean(okStarted) &&
    okStarted.at === now - 5 * day &&
    okStarted.title === 'Kept card' &&
    okStarted.outcome === null &&
    okStarted.costUsd === null &&
    JSON.parse(okStarted.detail).backfilled === true,
  JSON.stringify(okStarted),
);
const okFinished = bfRow('run-ok', 'run-finished');
check(
  "run-finished for the same run: outcome 'done', its costUsd, origin NULL",
  Boolean(okFinished) &&
    okFinished.outcome === 'done' &&
    okFinished.costUsd === 2.5 &&
    okFinished.origin === null,
  JSON.stringify(okFinished),
);

const deletedStarted = bfRow('run-resurrected', 'run-started');
check(
  "a run whose card is gone still gets a row, title '' rather than missing",
  Boolean(deletedStarted) && deletedStarted.title === '',
  JSON.stringify(deletedStarted),
);
const resurrectedFinished = bfRow('run-resurrected', 'run-finished');
check(
  'run-finished for a twice-settled run takes the LATER result, not the first',
  Boolean(resurrectedFinished) &&
    resurrectedFinished.outcome === 'failed' &&
    resurrectedFinished.costUsd === 0.2,
  JSON.stringify(resurrectedFinished),
);

const failedFinished = bfRow('run-failed', 'run-finished');
check(
  'a failed result with no started counterpart still gets a run-finished row, costUsd stays NULL',
  Boolean(failedFinished) && failedFinished.outcome === 'failed' && failedFinished.costUsd === null,
  JSON.stringify(failedFinished),
);
check('that run never got a run-started row — none was seeded', !bfRow('run-failed', 'run-started'));

const ordinaryMove = moveRow('todo', 'doing');
check(
  'status-moved: origin human, runId NULL, detail carries from/to',
  Boolean(ordinaryMove) &&
    ordinaryMove.origin === 'human' &&
    ordinaryMove.runId === null &&
    ordinaryMove.title === 'Kept card',
  JSON.stringify(ordinaryMove),
);
check(
  'the comment on the same card produced no activity_log row of its own',
  bf.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE kind = 'comment'").get().n === 0,
);
check(
  'no kind outside the three this backfill derives was ever written',
  bf.prepare(
    "SELECT COUNT(*) AS n FROM activity_log WHERE kind NOT IN ('run-started','run-finished','status-moved')",
  ).get().n === 0,
);

check('the 31-day-old started event produced no row', !bfRow('run-too-old', 'run-started'));
check('the 31-day-old status move produced no row', !moveRow('s-old', 'e-old'));
check(
  'nothing derived is older than the thirty-day floor',
  bf.prepare('SELECT MIN(at) AS at FROM activity_log WHERE at < ?').get(now - ACTIVITY_BACKFILL_DAYS * day).at ===
    null,
);

check('a move OLDER than the live row still lands', Boolean(moveRow('x1', 'y1')));
check(
  "a move NEWER than the live row does not — the live recorder already covers it",
  !moveRow('x2', 'y2'),
);

const guardRow = bf.prepare('SELECT value FROM app_state WHERE key = ?').get(ACTIVITY_BACKFILL_KEY);
check('the guard key is set', Boolean(guardRow));
const guardCounts = guardRow ? JSON.parse(guardRow.value) : null;
check(
  'and holds the counts this pass actually derived',
  Boolean(guardCounts) &&
    guardCounts.runsStarted === 2 &&
    guardCounts.runsFinished === 3 &&
    guardCounts.moves === 2,
  JSON.stringify(guardCounts),
);

const countAfterFirstPass = bf.prepare('SELECT COUNT(*) AS n FROM activity_log').get().n;
check(
  'total rows: 2 started + 3 finished + 2 moves derived, plus the 1 live row seeded directly',
  countAfterFirstPass === 8,
  String(countAfterFirstPass),
);
bfStore.close();

// Second boot: the guard is already set, so this must change nothing.
const bfStore2 = createStore(bfDbPath);
const countAfterSecondBoot = bf.prepare('SELECT COUNT(*) AS n FROM activity_log').get().n;
check(
  'activity_log row count is unchanged after a second boot',
  countAfterSecondBoot === countAfterFirstPass,
  countAfterFirstPass + ' then ' + countAfterSecondBoot,
);

bf.close();
bfStore2.close();

console.log('');
if (failures > 0) {
  console.error(failures + ' check(s) failed.');
  process.exit(1);
}
`;

await main();
