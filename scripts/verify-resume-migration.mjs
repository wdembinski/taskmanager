/**
 * Headless proof of the `stoppedAt` migration — the ALTER behind the **Resume** button.
 *
 *     node scripts/verify-resume-migration.mjs
 *
 * ## Why this is a script and not a test
 *
 * It would rather be `store.test.ts`. It cannot be: `better-sqlite3`'s addon is compiled for
 * ELECTRON's ABI, so `require`ing it under the Node that runs vitest dies with
 * `ERR_DLOPEN_FAILED`. That is why nothing in the suite calls `createStore` — the store's
 * schema and every migration in it have no automated coverage at all, and this script is the
 * only thing that exercises one.
 *
 * The way past the ABI split is the same one RELEASE.md §5's smoke test uses: run the
 * Electron binary as plain Node (`ELECTRON_RUN_AS_NODE=1`). No window is opened, and nothing
 * here touches the user's profile — the database is a scratch file in the OS temp directory.
 * See the `verify-electron-app` rule: never launch the app to check something.
 *
 * ## What it proves
 *
 * That a database written by a version WITHOUT `stoppedAt` gains the column on next open,
 * that the rows already in it read `stoppedAt: null` rather than a backfilled guess — so an
 * upgraded install offers Resume on nothing — and that a stop written afterwards round-trips
 * and does offer it.
 *
 * It fails loudly if the migration entry is removed: the store cannot even open, because its
 * INSERT names a column the table lacks. Prove that yourself by deleting the
 * `['stoppedAt', 'INTEGER']` line from `store.ts` and re-running.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const scratch = mkdtempSync(join(tmpdir(), 'tm-resume-migration-'));

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
  bundle(join(root, 'packages/shared/src/board.ts'), join(scratch, 'board.cjs'));

  const electron = join(clientModules, 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (!existsSync(electron)) throw new Error(`electron not installed at ${electron}`);

  const run = spawnSync(electron, [fileURLToPath(import.meta.url), scratch], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      // The bundles live in temp, outside any node_modules tree, so the external
      // `require('better-sqlite3')` inside them needs somewhere to resolve from.
      NODE_PATH: clientModules,
    },
  });
  process.exit(run.status ?? 1);
}

// ── Phase 2: under Electron-as-Node — the actual checks ──────────────────────────────
const require = createRequire(import.meta.url);
const work = process.argv[2];
const { createStore } = require(join(work, 'store.cjs'));
const { canResumeWork } = require(join(work, 'board.cjs'));
const Database = require('better-sqlite3');

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

const dbPath = join(work, 'orchestrator.db');

// A database as an older version left it: today's schema, minus the column under test.
const before = createStore(dbPath);
const task = before.createTask('personal', { title: 'A card from before the upgrade' });
before.close();

const raw = new Database(dbPath);
raw.exec('ALTER TABLE tasks DROP COLUMN stoppedAt');
const columnsBefore = raw
  .prepare('PRAGMA table_info(tasks)')
  .all()
  .map((c) => c.name);
check('the pre-upgrade table really lacks stoppedAt', !columnsBefore.includes('stoppedAt'));
check('and still holds the old row', raw.prepare('SELECT COUNT(*) n FROM tasks').get().n === 1);
raw.close();

// Re-open with the real store: the migration is what has to run here.
const after = createStore(dbPath);
const check2 = new Database(dbPath);
const columnsAfter = check2
  .prepare('PRAGMA table_info(tasks)')
  .all()
  .map((c) => c.name);
check2.close();
check('the ALTER added stoppedAt on open', columnsAfter.includes('stoppedAt'));

const migrated = after.getTask(task.id);
check('the pre-upgrade row survived the migration', migrated != null);
// The claim the plan makes about this upgrade, and the reason there is no backfill: a guess
// here would offer Resume on cards nobody ever stopped.
check('and reads stoppedAt: null — not backfilled', migrated?.stoppedAt === null);
check('so canResumeWork says no on it', canResumeWork(migrated) === false);

// …and the column is live, not merely present.
after.updateTask(task.id, { stoppedAt: Date.now(), status: 'stopped' });
const stopped = after.getTask(task.id);
check('a stop written after the upgrade round-trips', typeof stopped.stoppedAt === 'number');
check('and now Resume is offered', canResumeWork(stopped) === true);
after.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
