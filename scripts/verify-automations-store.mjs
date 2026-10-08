/**
 * Headless proof of the automation store (F1.6) — the tables, the `tasks.originAutomationId`
 * migration, and the whole `automations`/`automation_runs` API.
 *
 *     node scripts/verify-automations-store.mjs
 *
 * ## Why this is a script and not a test
 *
 * It would rather be `store.test.ts`. It cannot be: `better-sqlite3`'s addon is compiled for
 * ELECTRON's ABI, so `require`ing it under the Node that runs vitest dies with
 * `ERR_DLOPEN_FAILED`. That is why nothing in the suite calls `createStore` — the store's
 * schema and every migration in it have no automated coverage at all, and this script is the
 * only thing that exercises one. See `verify-resume-migration.mjs`, which this one is copied
 * from — same esbuild discovery, same Electron-as-Node hand-off, same scratch DB in the OS
 * temp directory. See also the `verify-electron-app` rule: never launch the app to check
 * something.
 *
 * ## What it proves
 *
 * 1. A fresh database already has `automations` and `automation_runs`, and `tasks` already
 *    has `originAutomationId`.
 * 2. A database written before `originAutomationId` existed gains the column on next open,
 *    the pre-upgrade row reads it back as `null` (not backfilled — no automation ran before
 *    the column did, so a guess would credit one for a card it never touched), and a value
 *    written afterwards round-trips.
 * 3. `saveAutomation` inserts and then fully replaces the row with the same id, the promoted
 *    `enabled`/`nextRunAt` columns always match the JSON blob they mirror, and
 *    `deleteAutomation` removes the automation AND every run it ever reserved.
 * 4. `reserveAutomationRun`'s `UNIQUE(automationId, occurrenceKey)` is the idempotency check:
 *    the same pair refuses a second row, a different automation with the same key does not,
 *    and `updateAutomationRun` patches (including clearing/setting `refusal`) round-trip.
 * 5. `pruneAutomationRuns` enforces both caps — 30 days, then newest 200 per automation — and
 *    leaves a different automation's runs untouched.
 *
 * It fails loudly if a migration entry is missing: prove that yourself by deleting the
 * `['originAutomationId', 'TEXT']` line from `store.ts` and re-running — check 1 and check 2
 * both go red because the column never reappears.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const scratch = mkdtempSync(join(tmpdir(), 'tm-automations-store-'));

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

function makeAutomation(id, overrides = {}) {
  const now = Date.now();
  return {
    id,
    revision: 1,
    name: `Automation ${id}`,
    enabled: true,
    ownerClientId: null,
    timeZone: 'UTC',
    trigger: { kind: 'schedule', schedule: { type: 'daily', hour: 9, minute: 0 } },
    action: {
      boardProjectId: 'personal',
      agentProjectId: 'personal',
      titleTemplate: 'Nightly triage — {{date}}',
      briefTemplate: 'Triage the inbox.',
      mode: 'acceptEdits',
      autoCreatePr: null,
      autoIntegrate: null,
    },
    enabledAt: now,
    nextRunAt: now + 1000,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeRun(id, automationId, occurrenceKey, overrides = {}) {
  return {
    id,
    automationId,
    revision: 1,
    occurrenceKey,
    kind: 'scheduled',
    status: 'reserved',
    taskId: null,
    runId: null,
    refusal: null,
    skippedCount: 0,
    note: null,
    at: Date.now(),
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
  check('fresh db has automations', tableNames.includes('automations'));
  check('fresh db has automation_runs', tableNames.includes('automation_runs'));
  const taskColumns = raw.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  check('fresh db has tasks.originAutomationId', taskColumns.includes('originAutomationId'));
  raw.close();
  store.close();
}

// ── Check 2: the originAutomationId migration ────────────────────────────────────────
{
  const migDbPath = join(work, 'migration.db');
  const before = createStore(migDbPath);
  const task = before.createTask('personal', { title: 'A card from before the upgrade' });
  before.close();

  const raw = new Database(migDbPath);
  raw.exec('ALTER TABLE tasks DROP COLUMN originAutomationId');
  const columnsBefore = raw.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  check(
    'the pre-upgrade table really lacks originAutomationId',
    !columnsBefore.includes('originAutomationId'),
  );
  raw.close();

  const after = createStore(migDbPath);
  const check2 = new Database(migDbPath);
  const columnsAfter = check2.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  check2.close();
  check('the ALTER added originAutomationId on open', columnsAfter.includes('originAutomationId'));

  const migrated = after.getTask(task.id);
  check('the pre-upgrade row survived the migration', migrated != null);
  check(
    'and reads originAutomationId: null — not backfilled',
    migrated?.originAutomationId === null,
  );

  after.updateTask(task.id, { originAutomationId: 'automation-1' });
  const patched = after.getTask(task.id);
  check(
    'a value written after the upgrade round-trips',
    patched?.originAutomationId === 'automation-1',
  );
  after.close();
}

// ── Check 3: automation save/get/upsert/delete round-trip ────────────────────────────
{
  const store = createStore(dbPath);
  const raw = new Database(dbPath);

  const a = makeAutomation('automation-a', { enabled: true, nextRunAt: 1000 });
  store.saveAutomation(a);

  const afterSave = store.getAutomations();
  check('getAutomations returns the saved automation', afterSave.length === 1);
  check(
    'the returned automation matches the saved JSON',
    JSON.stringify(afterSave[0]) === JSON.stringify(a),
  );

  const rawRow = raw
    .prepare('SELECT enabled, nextRunAt FROM automations WHERE id = ?')
    .get(a.id);
  check('the promoted enabled column matches the JSON', rawRow.enabled === 1);
  check('the promoted nextRunAt column matches the JSON', rawRow.nextRunAt === 1000);

  const updated = makeAutomation('automation-a', { enabled: false, nextRunAt: null });
  store.saveAutomation(updated);
  const afterUpsert = store.getAutomations();
  check('upsert replaces rather than duplicates', afterUpsert.length === 1);
  check(
    'the upserted automation reads back the new JSON',
    JSON.stringify(afterUpsert[0]) === JSON.stringify(updated),
  );
  const rawRow2 = raw
    .prepare('SELECT enabled, nextRunAt FROM automations WHERE id = ?')
    .get(a.id);
  check('the promoted enabled column followed the upsert', rawRow2.enabled === 0);
  check('the promoted nextRunAt column followed the upsert', rawRow2.nextRunAt === null);

  // A run the delete below must cascade away.
  store.reserveAutomationRun(makeRun('run-delete-me', a.id, 'occ-delete-me'));
  check(
    'the automation has a run before delete',
    store.getAutomationRuns(a.id, 10).length === 1,
  );

  store.deleteAutomation(a.id);
  check('deleteAutomation removes the automation', store.getAutomations().length === 0);
  check(
    'deleteAutomation cascades to its runs',
    store.getAutomationRuns(a.id, 10).length === 0,
  );

  raw.close();
  store.close();
}

// ── Check 4: reserveAutomationRun idempotency and updateAutomationRun patching ────────
{
  const store = createStore(dbPath);

  const first = store.reserveAutomationRun(makeRun('run-1', 'automation-x', 'occ-1'));
  check('the first reservation for a key lands', first === true);

  const second = store.reserveAutomationRun(
    makeRun('run-1-dup', 'automation-x', 'occ-1'),
  );
  check('the same (automationId, occurrenceKey) again is refused', second === false);

  const third = store.reserveAutomationRun(makeRun('run-2', 'automation-y', 'occ-1'));
  check(
    'a different automation with the same occurrenceKey still lands',
    third === true,
  );

  const patched = store.updateAutomationRun('run-1', {
    status: 'parked',
    refusal: 'limit',
    note: 'waiting on the reset',
  });
  check('updateAutomationRun returns the patched receipt', patched != null);
  check('the status patch round-trips', patched?.status === 'parked');
  check('the refusal patch round-trips', patched?.refusal === 'limit');
  check('the note patch round-trips', patched?.note === 'waiting on the reset');
  check('fields left out of the patch are untouched', patched?.taskId === null);

  const cleared = store.updateAutomationRun('run-1', { refusal: null, status: 'started' });
  check('refusal: null clears a previously set refusal', cleared?.refusal === null);
  check('status moved on from the clear', cleared?.status === 'started');

  const missing = store.updateAutomationRun('no-such-run', { status: 'error' });
  check('patching an unknown id returns undefined', missing === undefined);

  store.close();
}

// ── Check 5: pruneAutomationRuns' two caps ────────────────────────────────────────────
{
  const store = createStore(dbPath);
  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  // Automation A: 205 recent runs (all within the age cutoff) plus one 31-day-old run
  // that the age sweep alone should remove, before the cap even sees it.
  for (let i = 0; i < 205; i++) {
    store.reserveAutomationRun(
      makeRun(`run-a-${i}`, 'automation-prune-a', `occ-a-${i}`, { at: now - i }),
    );
  }
  store.reserveAutomationRun(
    makeRun('run-a-aged', 'automation-prune-a', 'occ-a-aged', {
      at: now - THIRTY_DAYS_MS - 24 * 60 * 60 * 1000,
    }),
  );

  // Automation B: a handful of recent runs that neither cap should touch.
  for (let i = 0; i < 3; i++) {
    store.reserveAutomationRun(
      makeRun(`run-b-${i}`, 'automation-prune-b', `occ-b-${i}`, { at: now - i }),
    );
  }

  const removed = store.pruneAutomationRuns(now);
  check('prune removes the aged row plus the five over the cap', removed === 6);

  const keptA = store.getAutomationRuns('automation-prune-a', 1000);
  check('A is capped at 200 runs', keptA.length === 200);
  check(
    'the kept A runs are the newest — the aged one is gone',
    !keptA.some((r) => r.id === 'run-a-aged'),
  );
  check(
    'the kept A runs are the newest — the five oldest recent ones are gone',
    !keptA.some((r) => ['run-a-200', 'run-a-201', 'run-a-202', 'run-a-203', 'run-a-204'].includes(r.id)),
  );
  check(
    'the kept A runs are the newest — the 200 newest recent ones remain',
    Array.from({ length: 200 }, (_, i) => `run-a-${i}`).every((id) =>
      keptA.some((r) => r.id === id),
    ),
  );

  const keptB = store.getAutomationRuns('automation-prune-b', 1000);
  check("B's runs are untouched", keptB.length === 3);

  store.close();
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
