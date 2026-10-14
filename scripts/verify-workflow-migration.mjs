/**
 * Headless proof of the workflows table and the three stepSpec/workflowId/gateAttempts
 * columns on tasks (F8.4, @shared/workflow) -- the storage a workflow step is
 * instantiated from and the gate attempt counter it carries.
 *
 *     node scripts/verify-workflow-migration.mjs
 *
 * ## Why this is a script and not a test
 *
 * It would rather be store.test.ts. It cannot be: better-sqlite3's addon is compiled for
 * ELECTRON's ABI, so requiring it under the Node that runs vitest dies with
 * ERR_DLOPEN_FAILED. That is why nothing in the suite calls createStore -- the store's
 * schema and every migration in it have no automated coverage at all, and this script is
 * the only thing that exercises one. Cloned from verify-skills-migration.mjs.
 *
 * The way past the ABI split is the same one RELEASE.md's smoke test uses: run the
 * Electron binary as plain Node (ELECTRON_RUN_AS_NODE=1). No window is opened, and nothing
 * here touches the user's profile -- the database is a scratch file in the OS temp
 * directory. See the verify-electron-app rule: never launch the app to check something.
 *
 * ## What it proves
 *
 * On a fresh database: the workflows table and the three tasks columns (stepSpec,
 * workflowId, gateAttempts) all exist; saveWorkflow round-trips a valid doc through
 * getWorkflows/getWorkflow, a re-save with a new name updates the row but keeps the
 * original createdAt; an invalid doc (no steps) is refused reason: 'invalid' with a
 * non-empty issues list; addSubtask given a stepSpec/workflowId reads both back
 * unchanged; a plain card (never a step) reads stepSpec: null, workflowId: null,
 * gateAttempts: 0; setTaskGateAttempts round-trips and answers undefined for an unknown
 * task id; a plain updateTask({ title }) leaves stepSpec/workflowId/gateAttempts alone;
 * deleteWorkflow removes the workflow row while leaving a step's own stepSpec/workflowId
 * in place, exactly as documented on Task.workflowId; and a stepSpec column written with
 * raw unparseable JSON reads back null rather than throwing.
 *
 * On a database written by a version WITHOUT any of this: that the column trio and the
 * table all come back on next open, that the pre-upgrade row survives, that it reads
 * stepSpec: null, workflowId: null, gateAttempts: 0 -- not backfilled -- and that
 * setTaskGateAttempts and saveWorkflow both work immediately afterwards.
 *
 * It fails loudly if a migration entry is removed: the store cannot even open, because
 * its INSERT names a column the table lacks. Prove that yourself by deleting the
 * ['stepSpec', 'TEXT'], ['workflowId', 'TEXT'] or ['gateAttempts', 'INTEGER NOT NULL
 * DEFAULT 0'] line from store.ts, one at a time, and re-running.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const scratch = mkdtempSync(join(tmpdir(), 'tm-workflow-migration-'));

/**
 * esbuild ships as a per-platform binary under a versioned .pnpm directory, so it is found
 * by pattern rather than by path: a dependency bump renames the directory, and hard-coding
 * one version would rot this script at the next pnpm up.
 */
function findEsbuild() {
  const pnpm = join(root, 'node_modules', '.pnpm');
  const target = `${process.platform}-${process.arch}`;
  const dir = readdirSync(pnpm).find((d) => d.startsWith(`@esbuild+${target}@`));
  if (!dir) throw new Error(`no esbuild binary for ${target} under ${pnpm}`);
  const exe = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
  return join(pnpm, dir, 'node_modules', '@esbuild', target, exe);
}

// -- Phase 1: plain Node -- bundle the sources, then hand over to Electron ----------------
if (!process.versions.electron) {
  const esbuild = findEsbuild();
  // store.ts imports nothing from Electron (only node:*, better-sqlite3 and @shared/*),
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

  bundle(join(root, 'apps/client/src/main/store.ts'), join(scratch, 'store.cjs'), 'better-sqlite3');

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
      // require('better-sqlite3') inside it needs somewhere to resolve from.
      NODE_PATH: clientModules,
    },
  });
  process.exit(run.status ?? 1);
}

// -- Phase 2: under Electron-as-Node -- the actual checks ----------------------------------
const require = createRequire(import.meta.url);
const work = process.argv[2];
const { createStore } = require(join(work, 'store.cjs'));
const Database = require('better-sqlite3');

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

const newWorkflow = (overrides) => ({
  version: 1,
  id: randomUUID(),
  name: 'Review workflow',
  steps: [{ id: 'write', kind: 'agent', title: 'Write the patch', brief: 'Implement the fix.' }],
  ...overrides,
});

const newStepSpec = () => ({
  id: 'write',
  kind: 'agent',
  title: 'Write the patch',
  brief: 'Implement the fix.',
});

// ───────────────────────────── Fresh DB ─────────────────────────────
const dbPath = join(work, 'orchestrator.db');
const store = createStore(dbPath);

const freshColumns = new Database(dbPath);
const taskColumns = freshColumns
  .prepare('PRAGMA table_info(tasks)')
  .all()
  .map((c) => c.name);
const tables = freshColumns
  .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
  .all()
  .map((t) => t.name);
freshColumns.close();
check('fresh DB: the workflows table exists', tables.includes('workflows'));
check('fresh DB: tasks has a stepSpec column', taskColumns.includes('stepSpec'));
check('fresh DB: tasks has a workflowId column', taskColumns.includes('workflowId'));
check('fresh DB: tasks has a gateAttempts column', taskColumns.includes('gateAttempts'));

// saveWorkflow round-trips; getWorkflows lists it; re-save with a new name updates it and
// keeps createdAt.
const workflow = newWorkflow();
const saved = store.saveWorkflow(workflow);
check(
  'saveWorkflow round-trips a valid doc',
  saved.ok === true && saved.workflow.id === workflow.id && saved.workflow.name === workflow.name,
);

const listed = store.getWorkflows();
check(
  'getWorkflows lists the saved workflow',
  listed.some((w) => w.id === workflow.id),
);

const resaved = store.saveWorkflow({ ...workflow, name: 'Review workflow, renamed' });
check(
  're-saving updates the name',
  resaved.ok === true && resaved.workflow.name === 'Review workflow, renamed',
);
check(
  'and keeps the original createdAt',
  resaved.ok === true && saved.ok === true && resaved.createdAt === saved.createdAt,
);

// An invalid doc (no steps) is refused rather than written.
const invalid = store.saveWorkflow({ version: 1, id: randomUUID(), name: 'Empty', steps: [] });
check(
  'an invalid doc is refused invalid with issues',
  invalid.ok === false && invalid.reason === 'invalid' && invalid.issues.length > 0,
);

// addSubtask with a stepSpec/workflowId reads them back.
const parentCard = store.createTask('personal', { title: 'Parent card for workflow steps' });
const stepSpec = newStepSpec();
const step = store.addSubtask(parentCard.id, {
  title: 'Write the patch',
  stepSpec,
  workflowId: workflow.id,
});
check('addSubtask stores stepSpec', JSON.stringify(step?.stepSpec) === JSON.stringify(stepSpec));
check('addSubtask stores workflowId', step?.workflowId === workflow.id);

// A plain card (never a step) reads stepSpec: null, workflowId: null, gateAttempts: 0.
const plainCardCreated = store.createTask('personal', { title: 'A plain card' });
const plainCard = store.getTask(plainCardCreated.id);
check(
  'a plain card reads stepSpec: null, workflowId: null, gateAttempts: 0',
  plainCard?.stepSpec === null && plainCard?.workflowId === null && plainCard?.gateAttempts === 0,
);

// setTaskGateAttempts: the one writer of gateAttempts.
const withAttempts = store.setTaskGateAttempts(step.id, 3);
check('setTaskGateAttempts round-trips', withAttempts?.gateAttempts === 3);
check(
  'setTaskGateAttempts on an unknown task id is undefined',
  store.setTaskGateAttempts('no-such-task', 1) === undefined,
);

// A plain updateTask does not clear the step's spec, workflow or attempt count.
const titleUpdated = store.updateTask(step.id, { title: 'Renamed, still a workflow step' });
check(
  'updateTask({ title }) leaves stepSpec alone',
  JSON.stringify(titleUpdated?.stepSpec) === JSON.stringify(stepSpec),
);
check('and leaves workflowId alone', titleUpdated?.workflowId === workflow.id);
check('and leaves gateAttempts alone', titleUpdated?.gateAttempts === 3);

// deleteWorkflow removes the workflow row but never touches a step's own stepSpec/workflowId.
const deletedWorkflow = store.deleteWorkflow(workflow.id);
check('deleteWorkflow returns true for a row it removed', deletedWorkflow === true);
check('getWorkflow now answers undefined', store.getWorkflow(workflow.id) === undefined);
const stepAfterDelete = store.getTask(step.id);
check(
  "the step still carries the now-deleted workflow's id and its own stepSpec",
  JSON.stringify(stepAfterDelete?.stepSpec) === JSON.stringify(stepSpec) &&
    stepAfterDelete?.workflowId === workflow.id,
);

// A corrupt stepSpec written raw reads back null rather than throwing.
const corruptCard = store.createTask('personal', { title: 'A card to carry a corrupt stepSpec' });
const corruptWriter = new Database(dbPath);
corruptWriter
  .prepare('UPDATE tasks SET stepSpec = ? WHERE id = ?')
  .run('not { valid json', corruptCard.id);
corruptWriter.close();
const corruptRead = store.getTask(corruptCard.id);
check('a corrupt stepSpec reads back null without throwing', corruptRead?.stepSpec === null);

store.close();

// ───────────────────────────── Upgraded DB (drop-column recipe) ─────────────────────────────
const upgradeDbPath = join(work, 'upgrade.db');
const before = createStore(upgradeDbPath);
const oldCard = before.createTask('personal', { title: 'A card from before the workflow upgrade' });
before.close();

const raw = new Database(upgradeDbPath);
raw.exec('ALTER TABLE tasks DROP COLUMN stepSpec');
raw.exec('ALTER TABLE tasks DROP COLUMN workflowId');
raw.exec('ALTER TABLE tasks DROP COLUMN gateAttempts');
raw.exec('DROP TABLE workflows');
const columnsBefore = raw
  .prepare('PRAGMA table_info(tasks)')
  .all()
  .map((c) => c.name);
const tablesBefore = raw
  .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
  .all()
  .map((t) => t.name);
check(
  'upgraded DB: the pre-upgrade table really lacks the three new columns',
  !columnsBefore.includes('stepSpec') &&
    !columnsBefore.includes('workflowId') &&
    !columnsBefore.includes('gateAttempts'),
);
check(
  'upgraded DB: the pre-upgrade database really lacks the workflows table',
  !tablesBefore.includes('workflows'),
);
check(
  'and still holds the old row',
  raw.prepare('SELECT COUNT(*) n FROM tasks WHERE id = ?').get(oldCard.id).n === 1,
);
raw.close();

// Re-open with the real store: all four migration entries have to run here.
const after = createStore(upgradeDbPath);
const checkDb = new Database(upgradeDbPath);
const columnsAfter = checkDb
  .prepare('PRAGMA table_info(tasks)')
  .all()
  .map((c) => c.name);
const tablesAfter = checkDb
  .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
  .all()
  .map((t) => t.name);
checkDb.close();
check(
  'upgraded DB: the ALTERs added the three columns back on open',
  columnsAfter.includes('stepSpec') &&
    columnsAfter.includes('workflowId') &&
    columnsAfter.includes('gateAttempts'),
);
check(
  'upgraded DB: the CREATE TABLE added workflows back on open',
  tablesAfter.includes('workflows'),
);

const migratedCard = after.getTask(oldCard.id);
check('upgraded DB: the pre-upgrade row survived the migration', migratedCard != null);
// The same claim the skills and pinned-import migrations make: a guess here would attach a
// workflow step to a card that never had the columns to carry one.
check(
  'and reads stepSpec: null, workflowId: null, gateAttempts: 0 — not backfilled',
  migratedCard?.stepSpec === null &&
    migratedCard?.workflowId === null &&
    migratedCard?.gateAttempts === 0,
);

// …and the column trio and the table are live, not merely present.
const migratedWithAttempts = after.setTaskGateAttempts(oldCard.id, 2);
check(
  'setTaskGateAttempts works on the upgraded database',
  migratedWithAttempts?.gateAttempts === 2,
);

const upgradeWorkflow = after.saveWorkflow(
  newWorkflow({ id: randomUUID(), name: 'Post-upgrade workflow' }),
);
check('saveWorkflow works on the upgraded database', upgradeWorkflow.ok === true);
after.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
