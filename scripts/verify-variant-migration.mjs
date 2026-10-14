/**
 * Headless proof of the three `variantOf`/`variantLabel`/`pickedVariantId` columns (F10.1) —
 * the migration that lets a card hold N hidden variant rows under it.
 *
 *     node scripts/verify-variant-migration.mjs
 *
 * ## Why this is a script and not a test
 *
 * It would rather be `store.test.ts`. It cannot be: `better-sqlite3`'s addon is compiled for
 * ELECTRON's ABI, so `require`ing it under the Node that runs vitest dies with
 * `ERR_DLOPEN_FAILED`. That is why nothing in the suite calls `createStore` — the store's
 * schema and every migration in it have no automated coverage at all, and this script is the
 * only thing that exercises one. See `scripts/verify-pinned-import-migration.mjs`, which this
 * is cloned from.
 *
 * The way past the ABI split is the same one RELEASE.md §5's smoke test uses: run the
 * Electron binary as plain Node (`ELECTRON_RUN_AS_NODE=1`). No window is opened, and nothing
 * here touches the user's profile — the database is a scratch file in the OS temp directory.
 * See the `verify-electron-app` rule: never launch the app to check something.
 *
 * ## What it proves
 *
 * That a database written by a version WITHOUT the three columns gains them back on next
 * open, that a card written before they existed reads `null` for all three — "not a variant,
 * no pick" — and that a variant row inserted after the upgrade round-trips its `variantOf` /
 * `variantLabel`, and that `updateTask` round-trips a leader's `pickedVariantId`.
 *
 * It fails loudly if any one of the three migration entries is removed: the store cannot even
 * open, because its INSERT names a column the table lacks. Prove that yourself by deleting the
 * `['variantOf', 'TEXT']` (or either of its two neighbours) line from `store.ts` and
 * re-running — then restore it.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const scratch = mkdtempSync(join(tmpdir(), 'tm-variant-migration-'));

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

// A database as a pre-F10 version left it: today's schema, minus the three columns under
// test. The one row in it is an ordinary ad-hoc card — exactly what every row on every
// upgrading install looks like, since variants did not exist to write anything else.
const before = createStore(dbPath);
const oldCard = before.createTask('personal', { title: 'A pre-F10 card' });
before.close();

const raw = new Database(dbPath);
raw.exec('ALTER TABLE tasks DROP COLUMN variantOf');
raw.exec('ALTER TABLE tasks DROP COLUMN variantLabel');
raw.exec('ALTER TABLE tasks DROP COLUMN pickedVariantId');
const columnsBefore = raw.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
check(
  'the pre-upgrade table really lacks all three variant columns',
  !columnsBefore.includes('variantOf') &&
    !columnsBefore.includes('variantLabel') &&
    !columnsBefore.includes('pickedVariantId'),
);
check(
  'and still holds the old (pre-F10) card',
  raw.prepare('SELECT COUNT(*) n FROM tasks WHERE id = ?').get(oldCard.id).n === 1,
);
raw.close();

// Re-open with the real store: the migration is what has to run here.
const after = createStore(dbPath);
const check2 = new Database(dbPath);
const columnsAfter = check2.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
check2.close();
check(
  'the ALTERs added all three columns back on open',
  columnsAfter.includes('variantOf') &&
    columnsAfter.includes('variantLabel') &&
    columnsAfter.includes('pickedVariantId'),
);

const migratedOldCard = after.getTask(oldCard.id);
check('the pre-upgrade row survived the migration', migratedOldCard != null);
// The claim the plan makes: a card from before variants existed reads as "not a variant, no
// pick" on all three — not a backfilled guess.
check(
  'and reads null for variantOf/variantLabel/pickedVariantId — not a variant, no pick',
  migratedOldCard?.variantOf === null &&
    migratedOldCard?.variantLabel === null &&
    migratedOldCard?.pickedVariantId === null,
);

// A fresh leader plus a variant row created after the upgrade. `createTask` has no notion of
// variants (that is F10.2's planner) — a direct write stands in for what the engine will do,
// so this is proving the COLUMN round-trips, not the planner.
const leader = after.createTask('personal', { title: 'Leader card' });
const variantRow = after.createTask('personal', { title: 'Variant A' });
const directWrite = new Database(dbPath);
directWrite
  .prepare(`UPDATE tasks SET variantOf = ?, variantLabel = ? WHERE id = ?`)
  .run(leader.id, 'A', variantRow.id);
directWrite.close();

const readBackVariant = after.getTask(variantRow.id);
check(
  'a new variant row round-trips variantOf/variantLabel',
  readBackVariant?.variantOf === leader.id && readBackVariant?.variantLabel === 'A',
);

// The leader's own field: `updateTask` is the only writer, and only `pickedVariantId` is
// patchable through it (variantOf/variantLabel stay unpatchable, like parentTaskId).
const pickedLeader = after.updateTask(leader.id, { pickedVariantId: variantRow.id });
check(
  "updateTask round-trips the leader's pickedVariantId",
  pickedLeader?.pickedVariantId === variantRow.id,
);
after.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
