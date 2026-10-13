/**
 * Headless proof of the `pinnedImport` migration — the column `issues:import` (F5.6) uses to
 * keep a hand-imported card off the left-query archival sweep.
 *
 *     node scripts/verify-pinned-import-migration.mjs
 *
 * ## Why this is a script and not a test
 *
 * It would rather be `store.test.ts`. It cannot be: `better-sqlite3`'s addon is compiled for
 * ELECTRON's ABI, so `require`ing it under the Node that runs vitest dies with
 * `ERR_DLOPEN_FAILED`. That is why nothing in the suite calls `createStore` — the store's
 * schema and every migration in it have no automated coverage at all, and this script is the
 * only thing that exercises one. See `scripts/verify-resume-migration.mjs`, which this is
 * cloned from.
 *
 * The way past the ABI split is the same one RELEASE.md §5's smoke test uses: run the
 * Electron binary as plain Node (`ELECTRON_RUN_AS_NODE=1`). No window is opened, and nothing
 * here touches the user's profile — the database is a scratch file in the OS temp directory.
 * See the `verify-electron-app` rule: never launch the app to check something.
 *
 * ## What it proves
 *
 * That a database written by a version WITHOUT `pinnedImport` gains the column on next open,
 * that a card the sync had already mirrored in reads `pinnedImport: null` — not pinned — that
 * `pinImport` round-trips it to `true`, and that a JIRA re-sync of that same card afterwards
 * (`upsertJiraTask`) leaves it `true` — the whole point of keeping the column out of that
 * UPDATE's SET list.
 *
 * It fails loudly if the migration entry is removed: the store cannot even open, because its
 * INSERT names a column the table lacks. Prove that yourself by deleting the
 * `['pinnedImport', 'INTEGER']` line from `store.ts` and re-running.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const scratch = mkdtempSync(join(tmpdir(), 'tm-pinned-import-migration-'));

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

  const electron = join(clientModules, 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
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

const dbPath = join(work, 'orchestrator.db');

// A database as an older version left it: today's schema, minus the column under test. The
// one row in it is a MIRRORED card — exactly what a sync, not `issues:import`, would have left
// behind — via the same `upsertJiraTask` insert branch a real sync uses.
const before = createStore(dbPath);
const template = before.createTask('personal', { title: 'placeholder' });
const mirrored = before.upsertJiraTask({
  ...template,
  id: 'mirrored-task-1',
  source: 'jira',
  title: 'A card the sync brought in',
  externalSource: 'jira',
  externalKey: 'ABC-1',
});
before.close();

const raw = new Database(dbPath);
raw.exec('ALTER TABLE tasks DROP COLUMN pinnedImport');
const columnsBefore = raw.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
check('the pre-upgrade table really lacks pinnedImport', !columnsBefore.includes('pinnedImport'));
check(
  'and still holds the old (mirrored) row',
  raw.prepare('SELECT COUNT(*) n FROM tasks WHERE id = ?').get(mirrored.id).n === 1,
);
raw.close();

// Re-open with the real store: the migration is what has to run here.
const after = createStore(dbPath);
const check2 = new Database(dbPath);
const columnsAfter = check2.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
check2.close();
check('the ALTER added pinnedImport on open', columnsAfter.includes('pinnedImport'));

const migrated = after.getTask(mirrored.id);
check('the pre-upgrade row survived the migration', migrated != null);
// The claim the plan makes: a card the SYNC brought in — every pre-existing row, since
// `issues:import` didn't exist yet — reads as "not pinned", not a backfilled guess.
check('and reads pinnedImport: null — the sync brought it in', migrated?.pinnedImport === null);

// …and the column is live, not merely present.
const pinned = after.pinImport(mirrored.id);
check('pinImport round-trips to true', pinned?.pinnedImport === true);

// The whole point of keeping the column out of upsertJiraTask's UPDATE: a sync refresh must
// never clear a pin it never set in the first place.
const resynced = after.upsertJiraTask({
  ...pinned,
  title: 'The same card, refreshed by another sync pass',
});
check('an upsertJiraTask refresh leaves the pin alone', resynced.pinnedImport === true);
check('and did refresh the tracker field it owns', resynced.title === 'The same card, refreshed by another sync pass');
after.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
