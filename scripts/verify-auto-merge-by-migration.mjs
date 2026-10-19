/**
 * Headless proof of the `autoMergeBy` migration on `projects` — who merges a green PR when
 * merge-on-green fires: the forge's own auto-merge (`'forge'`) or Task Manager itself (`'app'`).
 *
 *     node scripts/verify-auto-merge-by-migration.mjs
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
 * That a database written by a version WITHOUT the column gains it on next open with the
 * documented default `'forge'` rather than NULL, that a pre-existing project reads
 * `autoMergeBy: 'forge'`, that opening the database a second time does not add the column
 * again, that `updateProject` round-trips `'app'` and back, and that a garbage value written
 * straight into the row reads back as `'forge'` (the cast-on-read).
 *
 * It fails loudly if the migration entry is removed: the store cannot even open, because its
 * INSERT names a column the table lacks. Prove that yourself by deleting the `autoMergeBy`
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
const scratch = mkdtempSync(join(tmpdir(), 'tm-auto-merge-by-migration-'));

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

/** The `projects` columns named `autoMergeBy` — exactly one once migrated. */
const columnCount = (db) =>
  db
    .prepare('PRAGMA table_info(projects)')
    .all()
    .filter((c) => c.name === 'autoMergeBy').length;

// A database as an older version left it: today's schema, minus the column under test.
const before = createStore(dbPath);
const project = before.addProject({ path: 'C:/repos/pre-migration' });
check('a new project starts merged by the forge', project.autoMergeBy === 'forge');
before.close();

const raw = new Database(dbPath);
raw.exec('ALTER TABLE projects DROP COLUMN autoMergeBy');
check('the pre-upgrade table really lacks the column', columnCount(raw) === 0);
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
const stored = peek.prepare('SELECT autoMergeBy FROM projects WHERE id = ?').get(project.id);
peek.close();
check('the ALTER added the column on open', countAfter === 1);
check(
  "the old row backfilled to 'forge' in the column itself, not NULL",
  stored?.autoMergeBy === 'forge',
);
check(
  "and reads back as autoMergeBy: 'forge'",
  after.getProject(project.id)?.autoMergeBy === 'forge',
);
after.close();

// A second open of an already-migrated database must not try to add the column again.
let again;
try {
  again = createStore(dbPath);
  check('a second open raises no error', true);
} catch (err) {
  console.log(`FAIL  a second open raised: ${err.message}`);
  process.exit(1);
}
const recount = new Database(dbPath);
check('and the table still holds exactly one autoMergeBy column', columnCount(recount) === 1);
recount.close();

// …and the field is live, not merely present.
check(
  "updateProject switches it to 'app'",
  again.updateProject(project.id, { autoMergeBy: 'app' })?.autoMergeBy === 'app',
);
check('which survives a fresh read', again.getProject(project.id)?.autoMergeBy === 'app');
check(
  "updateProject switches it back to 'forge'",
  again.updateProject(project.id, { autoMergeBy: 'forge' })?.autoMergeBy === 'forge',
);
check('which survives a fresh read too', again.getProject(project.id)?.autoMergeBy === 'forge');
again.close();

// A value this build does not recognize — an older/corrupt row, or a future app's — keeps
// asking the forge rather than handing an unchecked string to the merge path.
const corrupt = new Database(dbPath);
corrupt.prepare('UPDATE projects SET autoMergeBy = ? WHERE id = ?').run('bogus', project.id);
corrupt.close();
const last = createStore(dbPath);
check(
  "a garbage stored value reads back as 'forge'",
  last.getProject(project.id)?.autoMergeBy === 'forge',
);
last.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
