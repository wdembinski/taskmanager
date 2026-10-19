/**
 * Headless proof of the `plannedFiles` migration on `tasks` — the file set a card is expected
 * to touch (`Task.plannedFiles`, `@shared/fileOverlap`), written at plan approval and widened
 * on landing.
 *
 *     node scripts/verify-planned-files-migration.mjs
 *
 * ## Why this is a script and not a test
 *
 * Same reason as `scripts/verify-ready-lanes-migration.mjs`, which this is cloned from:
 * `better-sqlite3`'s addon is compiled for ELECTRON's ABI, so nothing under vitest can call
 * `createStore`. This runs the Electron binary as plain Node (`ELECTRON_RUN_AS_NODE=1`)
 * against a scratch database in the OS temp directory — no window, no user profile. See the
 * `verify-electron-app` rule: never launch the app to check something.
 *
 * ## What it proves
 *
 * That a database written by a version WITHOUT the column boots, gains it on next open, and
 * that a pre-existing card reads `plannedFiles: null` — "no known files", which is the truth
 * for every old row. Then that `setTaskPlannedFiles` normalises, de-duplicates, round-trips,
 * and stores an empty set as NULL.
 *
 * It fails loudly if the migration entry is removed: the store cannot even open, because its
 * INSERT names a column the table lacks. Prove that yourself by deleting the `plannedFiles`
 * ALTER line from `store.ts` and re-running — it exits 1.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// A fresh worktree's install may lack the Electron binary (its download is a postinstall);
// point this at a full checkout's `apps/client/node_modules` instead. Only the binary and the
// Electron-ABI `better-sqlite3` come from there — the store under test is bundled from HERE.
const clientModules = process.env.TM_CLIENT_MODULES || join(root, 'apps', 'client', 'node_modules');
const scratch = mkdtempSync(join(tmpdir(), 'tm-planned-files-migration-'));

/** esbuild's per-platform binary, found by pattern — see the auto-approve script. */
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
  const built = spawnSync(
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
  if (built.status !== 0) process.exit(1);

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
  process.exit(run.status === 0 ? 0 : 1);
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

// A database as an older version left it: today's schema, minus the column under test.
const before = createStore(dbPath);
const project = before.addProject({ path: 'C:/repos/pre-migration' });
const card = before.createTask(project.id, { title: 'A card from before the column' });
check('a new card starts with no known files', before.getTask(card.id)?.plannedFiles === null);
before.close();

const raw = new Database(dbPath);
raw.exec('ALTER TABLE tasks DROP COLUMN plannedFiles');
const columnsBefore = raw
  .prepare('PRAGMA table_info(tasks)')
  .all()
  .map((c) => c.name);
check('the pre-upgrade table really lacks the column', !columnsBefore.includes('plannedFiles'));
check(
  'and still holds the old card row',
  raw.prepare('SELECT COUNT(*) n FROM tasks WHERE id = ?').get(card.id).n === 1,
);
raw.close();

// Re-open with the real store: the migration is what has to run here.
let after;
try {
  after = createStore(dbPath);
} catch (err) {
  console.log(`FAIL  the store could not open the pre-upgrade database: ${err.message}`);
  process.exit(1);
}
const peek = new Database(dbPath);
const columnsAfter = peek
  .prepare('PRAGMA table_info(tasks)')
  .all()
  .map((c) => c.name);
const stored = peek.prepare('SELECT plannedFiles FROM tasks WHERE id = ?').get(card.id);
peek.close();
check('the ALTER added the column on open', columnsAfter.includes('plannedFiles'));
check('the old row is NULL in the column itself', stored?.plannedFiles === null);
check('and reads back as plannedFiles === null', after.getTask(card.id)?.plannedFiles === null);

// …and the field is live, not merely present.
const written = after.setTaskPlannedFiles(card.id, [
  'Apps\\Client\\Store.ts',
  './apps/client/store.ts',
  'apps/client/src/main/*.ts',
]);
check(
  'setTaskPlannedFiles normalises and de-duplicates',
  JSON.stringify(written?.plannedFiles) ===
    JSON.stringify(['apps/client/store.ts', 'apps/client/src/main/*.ts']),
);
check(
  'which survives a fresh read',
  JSON.stringify(after.getTask(card.id)?.plannedFiles) ===
    JSON.stringify(['apps/client/store.ts', 'apps/client/src/main/*.ts']),
);
check(
  'an empty set is stored as "no known files"',
  after.setTaskPlannedFiles(card.id, [])?.plannedFiles === null,
);
check('an unknown id is undefined', after.setTaskPlannedFiles('nope', ['a.ts']) === undefined);

after.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
