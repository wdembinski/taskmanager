/**
 * Headless proof of the `autoVisualSignOff` / `autoVisualSignOffMaxRounds` migration on
 * `projects` — the per-project switch that lets an AI reviewer give a UI card's visual
 * sign-off, and the cap on how many fix steps it may add (`@shared/aiVisualReview`).
 *
 *     node scripts/verify-auto-visual-sign-off-migration.mjs
 *
 * ## Why this is a script and not a test
 *
 * Same reason as `scripts/verify-auto-done-on-land-migration.mjs`, which this is cloned from:
 * `better-sqlite3`'s addon is compiled for ELECTRON's ABI, so nothing under vitest can call
 * `createStore`. This runs the Electron binary as plain Node (`ELECTRON_RUN_AS_NODE=1`)
 * against a scratch database in the OS temp directory — no window, no user profile. See the
 * `verify-electron-app` rule: never launch the app to check something.
 *
 * ## What it proves
 *
 * That a database written by a version WITHOUT the columns gains them on next open with the
 * documented defaults `0` and `2` rather than NULL, that a pre-existing project reads
 * `autoVisualSignOff: false, autoVisualSignOffMaxRounds: 2`, that opening the database a
 * second time does not add the columns again, and that `updateProject` persists a chosen
 * value — including `0` — and clamps one out of range.
 *
 * It fails loudly if a migration entry is removed: the store cannot even open, because its
 * INSERT names a column the table lacks. Prove that yourself by commenting out either
 * `autoVisualSignOff*` ALTER line in `store.ts` and re-running — it exits 1.
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
const scratch = mkdtempSync(join(tmpdir(), 'tm-auto-visual-sign-off-migration-'));

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
const COLUMNS = ['autoVisualSignOff', 'autoVisualSignOffMaxRounds'];

/** How many of the two columns under test `projects` holds — both, once migrated. */
const columnCount = (db) =>
  db
    .prepare('PRAGMA table_info(projects)')
    .all()
    .filter((c) => COLUMNS.includes(c.name)).length;

// A database as an older version left it: today's schema, minus the columns under test.
const before = createStore(dbPath);
const project = before.addProject({ path: 'C:/repos/pre-migration' });
check('a new project starts with the switch off', project.autoVisualSignOff === false);
check('and the default 2 rounds', project.autoVisualSignOffMaxRounds === 2);
before.close();

const raw = new Database(dbPath);
for (const column of COLUMNS) raw.exec(`ALTER TABLE projects DROP COLUMN ${column}`);
check('the pre-upgrade table really lacks both columns', columnCount(raw) === 0);
check(
  'and still holds the old project row',
  raw.prepare('SELECT COUNT(*) n FROM projects WHERE id = ?').get(project.id).n === 1,
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
const countAfter = columnCount(peek);
const stored = peek
  .prepare('SELECT autoVisualSignOff, autoVisualSignOffMaxRounds FROM projects WHERE id = ?')
  .get(project.id);
peek.close();
check('the ALTERs added both columns on open', countAfter === 2);
check('the old row backfilled the switch to 0, not NULL', stored?.autoVisualSignOff === 0);
check('and the round cap to 2, not NULL', stored?.autoVisualSignOffMaxRounds === 2);
const migrated = after.getProject(project.id);
check(
  'and reads back as autoVisualSignOff: false, autoVisualSignOffMaxRounds: 2',
  migrated?.autoVisualSignOff === false && migrated?.autoVisualSignOffMaxRounds === 2,
);
after.close();

// A second open of an already-migrated database must not try to add the columns again.
let again;
try {
  again = createStore(dbPath);
  check('a second open raises no error', true);
} catch (err) {
  console.log(`FAIL  a second open raised: ${err.message}`);
  process.exit(1);
}
const recount = new Database(dbPath);
check('and the table still holds exactly the two columns', columnCount(recount) === 2);
recount.close();

// …and the fields are live, not merely present.
check(
  'updateProject turns the switch on',
  again.updateProject(project.id, { autoVisualSignOff: true })?.autoVisualSignOff === true,
);
check('which survives a fresh read', again.getProject(project.id)?.autoVisualSignOff === true);
check(
  'updateProject persists 5 rounds',
  again.updateProject(project.id, { autoVisualSignOffMaxRounds: 5 })?.autoVisualSignOffMaxRounds ===
    5,
);
check(
  'which survives a fresh read',
  again.getProject(project.id)?.autoVisualSignOffMaxRounds === 5,
);
check(
  '0 is a real value (review once, never fix), not the default',
  again.updateProject(project.id, { autoVisualSignOffMaxRounds: 0 })?.autoVisualSignOffMaxRounds ===
    0,
);
check(
  'an out-of-range cap clamps to 10',
  again.updateProject(project.id, { autoVisualSignOffMaxRounds: 99 })
    ?.autoVisualSignOffMaxRounds === 10,
);
check(
  'updateProject turns the switch back off',
  again.updateProject(project.id, { autoVisualSignOff: false })?.autoVisualSignOff === false,
);

again.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
