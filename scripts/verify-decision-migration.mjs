/**
 * Headless proof of the `decisionQuestion` / `decisionAskedAt` migration — the columns behind
 * a card's **needs decision** flag.
 *
 *     node scripts/verify-decision-migration.mjs
 *
 * ## Why this is a script and not a test
 *
 * Same reason as `verify-resume-migration.mjs`: `better-sqlite3`'s addon is compiled for
 * ELECTRON's ABI, so nothing under vitest can call `createStore`. This bundles `store.ts`
 * with esbuild and re-runs itself under the Electron binary as plain Node
 * (`ELECTRON_RUN_AS_NODE=1`) against a scratch database in the OS temp directory. No window
 * is opened and the user's profile is never touched — see the `verify-electron-app` rule.
 *
 * ## What it proves
 *
 * - A database written by a version WITHOUT the two columns — even one holding a card that
 *   was flagged before they were dropped — gains both on next open, and the row reads
 *   `null` for each: no backfill, so an upgrade opens no decision on anything.
 * - The columns are live: a flag written through `updateTask` round-trips, and so does
 *   clearing it.
 * - A card INSERTED already carrying a question keeps it (both `insertTask` lists).
 * - A tracker sync of that card leaves the flag alone — the sync's UPDATE must never clear it.
 * - One `updateTask` still logs exactly one `cloud_outbox` row, as the archive script checks.
 *
 * It fails loudly if a migration entry is removed: the store cannot even open the upgraded
 * database, because its statements name a column the table lacks. Prove that yourself by
 * deleting the `['decisionQuestion', 'TEXT']` line from `store.ts` and re-running.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');

/** See `verify-resume-migration.mjs`: esbuild's per-platform binary, found by pattern. */
function findEsbuild() {
  const pnpm = join(root, 'node_modules', '.pnpm');
  const target = `${process.platform}-${process.arch}`;
  const dir = readdirSync(pnpm).find((d) => d.startsWith(`@esbuild+${target}@`));
  if (!dir) throw new Error(`no esbuild binary for ${target} under ${pnpm}`);
  const exe = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
  return join(pnpm, dir, 'node_modules', '@esbuild', target, exe);
}

// ── Phase 1: plain Node — bundle the store, then hand over to Electron ────────────────
if (!process.versions.electron) {
  const scratch = mkdtempSync(join(tmpdir(), 'tm-decision-migration-'));
  const built = spawnSync(
    findEsbuild(),
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
  if (built.status !== 0) process.exit(built.status ?? 1);

  const electron = join(
    clientModules,
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  );
  if (!existsSync(electron)) throw new Error(`electron not installed at ${electron}`);

  const run = spawnSync(electron, [fileURLToPath(import.meta.url), scratch], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: clientModules },
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

const dbPath = join(work, 'orchestrator.db');
const COLUMNS = ['decisionQuestion', 'decisionAskedAt'];
const tableColumns = () => {
  const raw = new Database(dbPath);
  try {
    return raw
      .prepare('PRAGMA table_info(tasks)')
      .all()
      .map((c) => c.name);
  } finally {
    raw.close();
  }
};
const outboxCountFor = (taskId) => {
  const raw = new Database(dbPath);
  try {
    return raw
      .prepare(`SELECT COUNT(*) n FROM cloud_outbox WHERE entity = 'task' AND entityId = ?`)
      .get(taskId).n;
  } finally {
    raw.close();
  }
};

// A database as an older version left it — with a card flagged in it first, so the drop
// really throws a value away rather than an empty column.
const before = createStore(dbPath);
const task = before.createTask('personal', { title: 'A card from before the upgrade' });
before.updateTask(task.id, {
  decisionQuestion: 'Pay for the bigger plan?',
  decisionAskedAt: Date.now(),
});
check(
  'seed: the flag is written before the downgrade',
  before.getTask(task.id)?.decisionQuestion === 'Pay for the bigger plan?',
);
before.close();

const raw = new Database(dbPath);
for (const c of COLUMNS) raw.exec(`ALTER TABLE tasks DROP COLUMN ${c}`);
check(
  'the pre-upgrade row is still there',
  raw.prepare('SELECT COUNT(*) n FROM tasks').get().n === 1,
);
raw.close();
const columnsBefore = tableColumns();
for (const c of COLUMNS)
  check(`the pre-upgrade table really lacks ${c}`, !columnsBefore.includes(c));

// Re-open with the real store: the migration is what has to run here.
const after = createStore(dbPath);
const columnsAfter = tableColumns();
for (const c of COLUMNS) check(`the ALTER added ${c} on open`, columnsAfter.includes(c));

const migrated = after.getTask(task.id);
check('the pre-upgrade row survived the migration', migrated != null);
// No backfill: NULL is exactly true — nothing could flag a card before the columns existed.
check('and reads decisionQuestion: null', migrated?.decisionQuestion === null);
check('and reads decisionAskedAt: null', migrated?.decisionAskedAt === null);

// …and the columns are live, not merely present.
const askedAt = Date.now();
const outboxBefore = outboxCountFor(task.id);
after.updateTask(task.id, { decisionQuestion: 'Which account pays?', decisionAskedAt: askedAt });
check(
  'one updateTask adds exactly one cloud_outbox row',
  outboxCountFor(task.id) - outboxBefore === 1,
);
const flagged = after.getTask(task.id);
check(
  'a question written through updateTask round-trips',
  flagged?.decisionQuestion === 'Which account pays?',
);
check('and so does when it was asked', flagged?.decisionAskedAt === askedAt);

after.updateTask(task.id, { decisionQuestion: null, decisionAskedAt: null });
const cleared = after.getTask(task.id);
check(
  'clearing the flag writes null back',
  cleared?.decisionQuestion === null && cleared?.decisionAskedAt === null,
);

// A card INSERTED already carrying a question — both `insertTask` lists, or it is dropped.
const fresh = {
  ...cleared,
  id: 'decision-insert-probe',
  title: 'Inserted already flagged',
  source: 'jira',
  externalSource: 'jira',
  externalKey: 'PROBE-1',
  decisionQuestion: 'Use the staging token?',
  decisionAskedAt: askedAt,
};
after.upsertJiraTask(fresh);
const inserted = after.getTask(fresh.id);
check(
  'a fresh insertTask persists the question',
  inserted?.decisionQuestion === 'Use the staging token?',
);
check('and when it was asked', inserted?.decisionAskedAt === askedAt);

// A tracker re-sync rebuilds the card from the issue, which knows nothing of the flag.
after.upsertJiraTask({
  ...fresh,
  title: 'Re-synced from the tracker',
  decisionQuestion: null,
  decisionAskedAt: null,
});
const resynced = after.getTask(fresh.id);
check(
  'the tracker sync really ran (title refreshed)',
  resynced?.title === 'Re-synced from the tracker',
);
check('and left the open decision alone', resynced?.decisionQuestion === 'Use the staging token?');
after.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
