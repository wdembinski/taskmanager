/**
 * Headless proof of F28's role migrations: the lead's model and each role's effort — five
 * columns on `projects` and six on `tasks`, every one nullable TEXT where NULL means "the
 * next rung" (`resolveRoleModel` / `resolveRoleEffort`).
 *
 *     node scripts/verify-role-effort-migration.mjs
 *
 * ## Why this is a script and not a test
 *
 * Cloned from `scripts/verify-review-model-migration.mjs`: `better-sqlite3`'s addon is
 * compiled for ELECTRON's ABI, so nothing under vitest can call `createStore`. This runs the
 * Electron binary as plain Node (`ELECTRON_RUN_AS_NODE=1`) against a scratch database in the
 * OS temp directory — no window, no user profile. Never launch the app to check something.
 *
 * ## What it proves
 *
 * - A database written by a version WITHOUT the eleven columns gains them on next open, and
 *   the pre-existing project and card read every role field back as `null`.
 * - `updateProject` and the task patch (`updateTask`) persist a chosen value and clear it
 *   again with `null` — a real value, not an "unset" that leaves the old one in place.
 * - An effort this build does not know, written straight into a column, reads back `null`.
 *
 * It fails loudly if any one ALTER line is removed: the store cannot even open, because its
 * INSERT names a column the table lacks. Prove that yourself by deleting one of the F28
 * ALTER lines from `store.ts` and re-running — it exits 1.
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
const scratch = mkdtempSync(join(tmpdir(), 'tm-role-effort-migration-'));

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

const PROJECT_COLUMNS = [
  'leadModel',
  'leadEffort',
  'planningEffort',
  'workerEffort',
  'reviewEffort',
];
const TASK_COLUMNS = [
  'agentLeadModel',
  'agentReviewModel',
  'agentLeadEffort',
  'agentPlanningEffort',
  'agentEffort',
  'agentReviewEffort',
];
const allNull = (obj, keys) => keys.every((k) => obj?.[k] === null);
const allEqual = (obj, values) => Object.entries(values).every(([k, v]) => obj?.[k] === v);
const nulls = (keys) => Object.fromEntries(keys.map((k) => [k, null]));
const columnsOf = (db, table) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);

const dbPath = join(work, 'orchestrator.db');

// A database as an older version left it: today's schema, minus the columns under test.
const before = createStore(dbPath);
const project = before.addProject({ path: 'C:/repos/pre-migration' });
const card = before.createTask(project.id, { title: 'A card from before F28' });
check('a new project starts with every role field null', allNull(project, PROJECT_COLUMNS));
check(
  'a new card starts with every role field null',
  allNull(before.getTask(card.id), TASK_COLUMNS),
);
before.close();

const raw = new Database(dbPath);
for (const column of PROJECT_COLUMNS) raw.exec(`ALTER TABLE projects DROP COLUMN ${column}`);
for (const column of TASK_COLUMNS) raw.exec(`ALTER TABLE tasks DROP COLUMN ${column}`);
const projectColsBefore = columnsOf(raw, 'projects');
const taskColsBefore = columnsOf(raw, 'tasks');
check(
  'the pre-upgrade tables really lack the columns',
  PROJECT_COLUMNS.every((c) => !projectColsBefore.includes(c)) &&
    TASK_COLUMNS.every((c) => !taskColsBefore.includes(c)),
);
check(
  'and still hold the old project and card',
  raw.prepare('SELECT COUNT(*) n FROM projects WHERE id = ?').get(project.id).n === 1 &&
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
const projectColsAfter = columnsOf(peek, 'projects');
const taskColsAfter = columnsOf(peek, 'tasks');
const storedProject = peek
  .prepare(`SELECT ${PROJECT_COLUMNS.join(', ')} FROM projects WHERE id = ?`)
  .get(project.id);
const storedTask = peek
  .prepare(`SELECT ${TASK_COLUMNS.join(', ')} FROM tasks WHERE id = ?`)
  .get(card.id);
peek.close();
for (const column of PROJECT_COLUMNS) {
  check(`the ALTER added projects.${column} on open`, projectColsAfter.includes(column));
}
for (const column of TASK_COLUMNS) {
  check(`the ALTER added tasks.${column} on open`, taskColsAfter.includes(column));
}
check('the old project holds NULL in every new column', allNull(storedProject, PROJECT_COLUMNS));
check('the old card holds NULL in every new column', allNull(storedTask, TASK_COLUMNS));
check(
  'and the project reads every role field back as null',
  allNull(after.getProject(project.id), PROJECT_COLUMNS),
);
check(
  'and the card reads every role field back as null',
  allNull(after.getTask(card.id), TASK_COLUMNS),
);

// …and the fields are live, not merely present.
const projectValues = {
  leadModel: 'opus',
  leadEffort: 'max',
  planningEffort: 'xhigh',
  workerEffort: 'medium',
  reviewEffort: 'low',
};
check(
  'updateProject round-trips every project role field',
  allEqual(after.updateProject(project.id, projectValues), projectValues),
);
check('which survives a fresh read', allEqual(after.getProject(project.id), projectValues));
check(
  'null clears every project field back to "the next rung"',
  allNull(after.updateProject(project.id, nulls(PROJECT_COLUMNS)), PROJECT_COLUMNS),
);
check(
  'and the clear survives a fresh read',
  allNull(after.getProject(project.id), PROJECT_COLUMNS),
);

const taskValues = {
  agentLeadModel: 'opus',
  agentReviewModel: 'sonnet',
  agentLeadEffort: 'max',
  agentPlanningEffort: 'xhigh',
  agentEffort: 'medium',
  agentReviewEffort: 'low',
};
check(
  'the task patch round-trips every card role field',
  allEqual(after.updateTask(card.id, taskValues), taskValues),
);
check('which survives a fresh read', allEqual(after.getTask(card.id), taskValues));
check(
  'null clears every card field back to "the next rung"',
  allNull(after.updateTask(card.id, nulls(TASK_COLUMNS)), TASK_COLUMNS),
);
check('and the clear survives a fresh read', allNull(after.getTask(card.id), TASK_COLUMNS));
after.close();

// An effort this build does not know — a hand-edited row, a newer version's value — reads
// back null rather than reaching `--effort` unvalidated.
const poke = new Database(dbPath);
poke
  .prepare(`UPDATE projects SET workerEffort = 'ultra', leadModel = 'opus' WHERE id = ?`)
  .run(project.id);
poke.prepare(`UPDATE tasks SET agentEffort = 'ultra' WHERE id = ?`).run(card.id);
poke.close();
const reopened = createStore(dbPath);
check(
  'an unknown project effort reads back null',
  reopened.getProject(project.id)?.workerEffort === null,
);
check('while its neighbour keeps its value', reopened.getProject(project.id)?.leadModel === 'opus');
check('an unknown card effort reads back null', reopened.getTask(card.id)?.agentEffort === null);
reopened.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
