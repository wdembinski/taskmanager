/**
 * Headless proof of the F1.12 outbox triggers (`store.ts`'s `trg_automations_after_*` and
 * `trg_automation_runs_after_*`): a real SQLite write through the real `Store` API queues the
 * `cloud_outbox` row `cloudDelta.ts`/`cloudPoller.ts` later read back with `getCloudDelta`,
 * for every automation write and for a run insert/update — but NOT for a run delete, since
 * `pruneAutomationRuns`/`deleteAutomation`'s cascade are bulk, local-only cleanups the cloud
 * mirror reconciles on its own (retention sweep server-side, `deletedAutomationIds` for the
 * cascade's owning automation).
 *
 *     node scripts/verify-automation-outbox.mjs
 *
 * ## Why this is a script and not a test
 *
 * Same reason as `verify-automations-store.mjs`, which this one is copied from: `createStore`
 * loads `better-sqlite3`'s native addon, compiled for Electron's ABI, so nothing that calls it
 * can run under the Node that runs vitest. The pure trigger-shape assumption already has fast
 * coverage in `cloudDelta.test.ts`/`cloudOutboxBackfill.test.ts`; this is the one proof that
 * the real triggers behind them fire the way those suites assume.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const scratch = mkdtempSync(join(tmpdir(), 'tm-automation-outbox-'));

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

  bundle(join(root, 'apps/client/src/main/store.ts'), join(scratch, 'store.cjs'), 'better-sqlite3');

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
      NODE_PATH: clientModules,
    },
  });
  process.exit(run.status ?? 1);
}

// ── Phase 2: under Electron-as-Node — the actual checks ──────────────────────────────
const require = createRequire(import.meta.url);
const work = process.argv[2];
const { createStore } = require(join(work, 'store.cjs'));

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
const store = createStore(dbPath);

// The backfill sweep that runs on every fresh open (there is nothing to backfill in a
// brand-new database) already queued/cleared itself; drain it so the checks below start
// from a clean outbox.
store.pruneCloudOutbox(Number.MAX_SAFE_INTEGER);
const rowsFor = (entity, entityId) =>
  store.getCloudDelta(0, 1000).filter((r) => r.entity === entity && r.entityId === entityId);

// ── Automation insert ─────────────────────────────────────────────────────────────────
const a = makeAutomation('automation-a');
store.saveAutomation(a);
check(
  'saveAutomation (insert) queues one automation/insert row',
  rowsFor('automation', a.id).length === 1 && rowsFor('automation', a.id)[0].op === 'insert',
);

// ── Automation update ──────────────────────────────────────────────────────────────────
store.saveAutomation(makeAutomation('automation-a', { enabled: false }));
check(
  'saveAutomation (upsert over an existing row) queues an automation/update row too',
  rowsFor('automation', a.id).some((r) => r.op === 'update'),
);

// ── Run insert ─────────────────────────────────────────────────────────────────────────
const run = makeRun('run-1', a.id, 'occ-1');
store.reserveAutomationRun(run);
check(
  'reserveAutomationRun queues one automationRun/insert row',
  rowsFor('automationRun', run.id).length === 1 &&
    rowsFor('automationRun', run.id)[0].op === 'insert',
);

// ── Run update ─────────────────────────────────────────────────────────────────────────
store.updateAutomationRun(run.id, { status: 'started' });
check(
  'updateAutomationRun queues an automationRun/update row',
  rowsFor('automationRun', run.id).some((r) => r.op === 'update'),
);

// ── Run delete: pruneAutomationRuns is a bulk local sweep — no per-row outbox trigger ──
const beforePruneSeq = store.getCloudDelta(0, 1000).length;
const removed = store.pruneAutomationRuns(Date.now() + 365 * 24 * 60 * 60 * 1000); // force the age cap
check('the aged run was actually deleted', removed >= 1);
check(
  'pruneAutomationRuns queues NO outbox row for the deleted run',
  rowsFor('automationRun', run.id).filter((r) => r.op === 'delete').length === 0,
);
check(
  'and queues nothing at all — the outbox is unchanged by the prune',
  store.getCloudDelta(0, 1000).length === beforePruneSeq,
);

// ── Automation delete: the automation itself DOES get an outbox row, its cascaded runs
// do not (same no-delete-trigger shape as the direct prune above).
const a2 = makeAutomation('automation-b');
store.saveAutomation(a2);
const run2 = makeRun('run-2', a2.id, 'occ-2');
store.reserveAutomationRun(run2);
store.pruneCloudOutbox(store.getCloudDelta(0, 1000).at(-1).seq); // clear the insert noise above

store.deleteAutomation(a2.id);
check(
  'deleteAutomation queues one automation/delete row',
  rowsFor('automation', a2.id).filter((r) => r.op === 'delete').length === 1,
);
check(
  "deleteAutomation's cascaded run delete queues NO automationRun row",
  rowsFor('automationRun', run2.id).filter((r) => r.op === 'delete').length === 0,
);

store.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
