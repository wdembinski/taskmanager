/**
 * Headless proof of the `projects.repoSkills` migration and `setProjectRepoSkills` (F7.11,
 * step 3) — the project mirror's carrier for a repo's `.claude/skills` summaries.
 *
 *     node scripts/verify-repo-skills-migration.mjs
 *
 * Cloned from `scripts/verify-skills-migration.mjs` — see its header for why this has to be
 * a script rather than a `store.test.ts`: `better-sqlite3`'s addon is compiled for
 * ELECTRON's ABI, so nothing that calls `createStore` can run under vitest, and this is the
 * only thing that exercises the store's schema and migrations at all. Same way past the ABI
 * split: run the Electron binary as plain Node (`ELECTRON_RUN_AS_NODE=1`), no window, a
 * scratch database in the OS temp directory.
 *
 * ## What it proves
 *
 * On a fresh database: the `projects` table has a `repoSkills` column; a brand-new project
 * reads `repoSkills: []`, not `undefined`; `setProjectRepoSkills` round-trips a list through
 * `getProject`; re-saving the IDENTICAL list adds no `cloud_outbox` row for that project
 * (the whole point of comparing before the write), while saving a DIFFERENT list adds at
 * least one; clearing back to `[]` round-trips too; and an unknown project id answers
 * `undefined` without throwing.
 *
 * On a database written by a version WITHOUT the column: that it comes back on next open,
 * that the pre-upgrade project row survives, that it reads `repoSkills: []` — not a
 * backfilled guess, since nothing could have scanned a repo before the column existed — and
 * that `setProjectRepoSkills` works immediately afterwards.
 *
 * It fails loudly if the migration entry is removed: the store cannot even open, because
 * `setProjectRepoSkillsStmt`'s UPDATE names a column the table lacks. Prove that yourself by
 * deleting the `repoSkills` ALTER block from `store.ts` and re-running.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const scratch = mkdtempSync(join(tmpdir(), 'tm-repo-skills-migration-'));

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
  spawnSync(
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

/** `cloud_outbox` rows logged against one project id — a delta across a write is the only
 *  robust signal, since unrelated project/task activity earlier in the run (or the insert's
 *  own echo — see `store.ts`'s trigger header) already seeded the table with rows of its own. */
function outboxCountFor(dbPath, projectId) {
  const raw = new Database(dbPath);
  try {
    return raw
      .prepare(`SELECT COUNT(*) n FROM cloud_outbox WHERE entity = 'project' AND entityId = ?`)
      .get(projectId).n;
  } finally {
    raw.close();
  }
}

const sampleSkills = (projectId) => [
  {
    projectId,
    name: 'tdd',
    description: 'Write the failing test first',
    path: '.claude/skills/tdd/SKILL.md',
  },
];

// ───────────────────────────── Fresh DB ─────────────────────────────
const dbPath = join(work, 'orchestrator.db');
const store = createStore(dbPath);

const freshColumns = new Database(dbPath);
const projectColumns = freshColumns.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
freshColumns.close();
check('fresh DB: projects has a repoSkills column', projectColumns.includes('repoSkills'));

const project = store.addProject({ path: 'C:/does-not-matter', name: 'Repo skills test' });
check(
  'fresh DB: a brand-new project reads repoSkills: [], not undefined',
  JSON.stringify(project.repoSkills) === '[]',
);

const sample = sampleSkills(project.id);

const beforeChange = outboxCountFor(dbPath, project.id);
const changed = store.setProjectRepoSkills(project.id, sample);
check(
  'setProjectRepoSkills round-trips the list it was given',
  JSON.stringify(changed?.repoSkills) === JSON.stringify(sample),
);
const afterChange = outboxCountFor(dbPath, project.id);
check('a changed list adds at least one cloud_outbox row', afterChange > beforeChange);

const beforeUnchanged = outboxCountFor(dbPath, project.id);
const unchanged = store.setProjectRepoSkills(project.id, sampleSkills(project.id));
check(
  're-saving the identical list still round-trips it',
  JSON.stringify(unchanged?.repoSkills) === JSON.stringify(sample),
);
const afterUnchanged = outboxCountFor(dbPath, project.id);
check(
  'an unchanged list adds no cloud_outbox row',
  afterUnchanged === beforeUnchanged,
);

const cleared = store.setProjectRepoSkills(project.id, []);
check('clearing back to [] round-trips too', JSON.stringify(cleared?.repoSkills) === '[]');

check(
  'setProjectRepoSkills on an unknown project id is undefined',
  store.setProjectRepoSkills('no-such-project', []) === undefined,
);

store.close();

// ───────────────────────────── Upgraded DB (drop-column recipe) ─────────────────────────────
const upgradeDbPath = join(work, 'upgrade.db');
const before = createStore(upgradeDbPath);
const oldProject = before.addProject({ path: 'C:/pre-upgrade', name: 'Pre-upgrade project' });
before.close();

const raw = new Database(upgradeDbPath);
raw.exec('ALTER TABLE projects DROP COLUMN repoSkills');
const columnsBefore = raw.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
check('upgraded DB: the pre-upgrade table really lacks repoSkills', !columnsBefore.includes('repoSkills'));
check(
  'and still holds the old project row',
  raw.prepare('SELECT COUNT(*) n FROM projects WHERE id = ?').get(oldProject.id).n === 1,
);
raw.close();

// Re-open with the real store: the migration entry has to run here.
const after = createStore(upgradeDbPath);
const checkDb = new Database(upgradeDbPath);
const columnsAfter = checkDb.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
checkDb.close();
check('upgraded DB: the ALTER added repoSkills back on open', columnsAfter.includes('repoSkills'));

const migratedProject = after.getProject(oldProject.id);
check('upgraded DB: the pre-upgrade row survived the migration', migratedProject != null);
// The same claim the skills migration makes for `skillRefs`: a guess here would attach a
// repo skill summary this desktop never actually scanned for.
check(
  'and reads repoSkills: [] — not backfilled with a guess',
  JSON.stringify(migratedProject?.repoSkills) === '[]',
);

const migratedUpdate = after.setProjectRepoSkills(oldProject.id, sampleSkills(oldProject.id));
check(
  'setProjectRepoSkills round-trips on the upgraded database',
  JSON.stringify(migratedUpdate?.repoSkills) === JSON.stringify(sampleSkills(oldProject.id)),
);
after.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
