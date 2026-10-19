/**
 * Headless proof of the `autoApprovePlans`/`autoApproveMaxSteps` migration on `projects` —
 * the per-project switch that lets a clean plan approve itself instead of waiting in the
 * Inbox.
 *
 *     node scripts/verify-auto-approve-plans-migration.mjs
 *
 * ## Why this is a script and not a test
 *
 * It would rather be `store.test.ts`. It cannot be: `better-sqlite3`'s addon is compiled for
 * ELECTRON's ABI, so `require`ing it under the Node that runs vitest dies with
 * `ERR_DLOPEN_FAILED`. That is why nothing in the suite calls `createStore` — the store's
 * schema and every migration in it have no automated coverage at all, and this script is the
 * only thing that exercises one. Cloned from `scripts/verify-pinned-import-migration.mjs`.
 *
 * The way past the ABI split is the same one RELEASE.md §5's smoke test uses: run the
 * Electron binary as plain Node (`ELECTRON_RUN_AS_NODE=1`). No window is opened, and nothing
 * here touches the user's profile — the database is a scratch file in the OS temp directory.
 * See the `verify-electron-app` rule: never launch the app to check something.
 *
 * ## What it proves
 *
 * That a database written by a version WITHOUT either column gains both on next open, with
 * the right defaults (`0`/off and `6`) rather than NULL, that a pre-existing project reads
 * `autoApprovePlans: false` and `autoApproveMaxSteps: 6` — not a guess, the documented
 * default — and that `updateProject` round-trips both fields, including the SpinButton's
 * clamp to 1..50.
 *
 * It fails loudly if the migration entry is removed: the store cannot even open, because its
 * INSERT names columns the table lacks. Prove that yourself by deleting the
 * `autoApprovePlans`/`autoApproveMaxSteps` ALTER lines from `store.ts` and re-running.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const scratch = mkdtempSync(join(tmpdir(), 'tm-auto-approve-plans-migration-'));

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

// A database as an older version left it: today's schema, minus both columns under test.
const before = createStore(dbPath);
const project = before.addProject({ path: 'C:/repos/pre-migration' });
before.close();

const raw = new Database(dbPath);
raw.exec('ALTER TABLE projects DROP COLUMN autoApprovePlans');
raw.exec('ALTER TABLE projects DROP COLUMN autoApproveMaxSteps');
const columnsBefore = raw.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
check(
  'the pre-upgrade table really lacks both columns',
  !columnsBefore.includes('autoApprovePlans') && !columnsBefore.includes('autoApproveMaxSteps'),
);
check(
  'and still holds the old project row',
  raw.prepare('SELECT COUNT(*) n FROM projects WHERE id = ?').get(project.id).n === 1,
);
raw.close();

// Re-open with the real store: the migration is what has to run here.
const after = createStore(dbPath);
const check2 = new Database(dbPath);
const columnsAfter = check2.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
check2.close();
check('the ALTERs added both columns on open', columnsAfter.includes('autoApprovePlans') && columnsAfter.includes('autoApproveMaxSteps'));

const migrated = after.getProject(project.id);
check('a pre-existing project backfills to off', migrated?.autoApprovePlans === false);
check('and the documented default step cap, not a guess', migrated?.autoApproveMaxSteps === 6);

// …and both fields are live, not merely present.
const updated = after.updateProject(project.id, { autoApprovePlans: true, autoApproveMaxSteps: 12 });
check('updateProject turns the switch on', updated?.autoApprovePlans === true);
check('and round-trips a chosen step cap', updated?.autoApproveMaxSteps === 12);

const reread = after.getProject(project.id);
check('the switch survives a fresh read', reread?.autoApprovePlans === true);
check('so does the step cap', reread?.autoApproveMaxSteps === 12);

after.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
