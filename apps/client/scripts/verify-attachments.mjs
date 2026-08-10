/**
 * Headless verification for Phase 22's attachments — the half `vitest` cannot reach.
 *
 * The unit tests cover everything pure (`@shared/attachments`, `attachmentPaths`). What
 * they cannot cover is the part that needs a REAL `better-sqlite3`: the new table on a
 * fresh profile and on an old one, the `ON DELETE CASCADE` that takes attachment rows with
 * a card, the bytes on disk that no cascade reaches, and the boot sweep that is the
 * backstop for both. That code only loads inside Electron's ABI, so it runs here rather
 * than in the suite.
 *
 * The app is NEVER launched (RELEASE.md rule 6 — there is no single-instance lock, and a
 * second instance killed a live session on 2026-08-02). This drives the modules directly
 * under `ELECTRON_RUN_AS_NODE`, against scratch databases and scratch directories in the
 * system temp dir. It never opens, reads or writes the real profile.
 *
 * How it works, and why it is not simply a `node` script: `store.ts` and `attachments.ts`
 * are TypeScript with `@shared` aliases, and `attachments.ts` imports `electron`. So each
 * scenario file is bundled with Vite first (aliasing `electron` to a stub, since the two
 * symbols used — `protocol` and `app` — are never called on this path), then run under
 * Electron-as-Node so the addon's ABI matches the binary loading it.
 *
 * The v0.57.0 leg is a real downgrade rather than a hand-cut schema: the tagged tree is
 * extracted with `git archive` and ITS `createStore` writes the old database, which the
 * current one then opens. A schema built by today's code minus one table would prove
 * nothing about the migration.
 *
 *   pnpm exec node scripts/verify-attachments.mjs
 *
 * Exits non-zero on the first failed assertion, naming it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** `@shared` now lives in the packages/shared workspace package, not under this app. */
const sharedSrc = join(repo, '..', '..', 'packages', 'shared', 'src');

/**
 * Everything this script writes lives here, INSIDE the repo rather than in the temp dir,
 * for one reason: the bundles keep `better-sqlite3` external, so they must sit somewhere
 * Node's resolution can still find `node_modules`. Removed on the way out, and on the way
 * in — a crashed previous run must not leak into this one.
 */
const work = join(repo, '.verify-attachments');

/** The version whose database the current schema has to open without losing anything. */
const OLD_TAG = 'v0.57.0';

const electronBin = join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
const electronBinPosix = join(repo, 'node_modules', 'electron', 'dist', 'electron');

function log(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * `protocol` and `app` are imported by the modules under test and called by neither on
 * this path — `registerAttachmentProtocol` is never invoked, and `logMain`'s `app.getPath`
 * already sits inside a `try` that swallows it. Throwing rather than returning a plausible
 * value is deliberate: if a scenario ever does reach Electron, it must fail loudly here
 * instead of quietly verifying a stub.
 */
const ELECTRON_STUB = `
const unavailable = (name) => () => {
  throw new Error(\`Electron's \${name} is not available in headless verification\`);
};
export const app = { getPath: unavailable('app.getPath'), on: unavailable('app.on') };
export const protocol = { handle: unavailable('protocol.handle') };
export const ipcMain = { handle: unavailable('ipcMain.handle') };
export const shell = { openPath: unavailable('shell.openPath') };
export const safeStorage = { isEncryptionAvailable: () => false };
export const BrowserWindow = class {};
export default { app, protocol, ipcMain, shell, safeStorage, BrowserWindow };
`;

/** Bundle one scenario file to a runnable ESM module. `sharedDir` is what `@shared` means. */
async function bundle(entry, outDir, sharedDir) {
  const stub = join(work, 'electron-stub.mjs');
  writeFileSync(stub, ELECTRON_STUB, 'utf8');
  await build({
    configFile: false,
    logLevel: 'error',
    resolve: { alias: { '@shared': sharedDir, electron: stub } },
    build: {
      ssr: entry,
      outDir,
      emptyOutDir: true,
      target: 'node20',
      minify: false,
      // The native addon must stay a real `import` resolved at run time — bundling a
      // `.node` file is exactly the mistake this whole ABI dance exists to avoid.
      rollupOptions: {
        external: ['better-sqlite3'],
        output: { format: 'es', entryFileNames: 'bundle.mjs' },
      },
    },
  });
  return join(outDir, 'bundle.mjs');
}

/** Run a bundle under Electron-as-Node, so `better_sqlite3.node` loads against its own ABI. */
function runUnderElectron(bundlePath) {
  const bin = existsSync(electronBin) ? electronBin : electronBinPosix;
  if (!existsSync(bin)) throw new Error(`No Electron binary at ${bin}`);
  const result = spawnSync(bin, [bundlePath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${bundlePath} exited ${result.status ?? `on ${result.signal}`}`);
  }
}

// ---------------------------------------------------------------------------

async function main() {
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

try {
  // The ABI the whole exercise depends on. Checked first and by itself, because every
  // scenario below fails identically and unhelpfully when this is wrong (v0.25.0's Linux
  // build shipped a Node-22 addon against Electron 33 and every tab just said "Loading").
  const abi = require('./native-abi.mjs');
  const addon = join(
    dirname(require.resolve('better-sqlite3/package.json')),
    abi.ADDON_RELATIVE_PATH,
  );
  const expected = abi.readElectronAbi(require('electron'));
  const actual = abi.readModuleAbi(readFileSync(addon));
  if (expected !== actual) {
    throw new Error(
      `better_sqlite3.node targets ABI ${actual} but Electron is ABI ${expected} — ` +
        `run \`pnpm ensure:abi\` first`,
    );
  }
  log(`ABI ok: addon and Electron both ${actual}`);

  // The old tree, extracted whole. `git archive` rather than a checkout: this worktree is
  // shared by every step of the plan and must not move off its branch.
  const oldRoot = join(work, 'old');
  mkdirSync(oldRoot, { recursive: true });
  const tar = execFileSync('git', ['archive', '--format=tar', OLD_TAG, 'src'], {
    cwd: repo,
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'buffer',
  });
  // Both the archive and the extraction are RELATIVE, run from `oldRoot`: tar reads a
  // leading `C:\` as a remote host ("Cannot connect to C: resolve failed"), so no absolute
  // Windows path can be handed to it.
  writeFileSync(join(oldRoot, 'old.tar'), tar);
  execFileSync('tar', ['-xf', 'old.tar'], { cwd: oldRoot });
  if (!existsSync(join(oldRoot, 'src', 'main', 'store.ts'))) {
    throw new Error(`Could not extract ${OLD_TAG}'s src tree`);
  }
  log(`Extracted ${OLD_TAG} for the migration leg`);

  const scratch = join(work, 'scratch').replace(/\\/g, '/');
  const oldDb = `${scratch}/old-profile/orchestrator.db`;

  // Leg 1 — the OLD code writes a database with the old schema.
  const oldEntry = join(work, 'entry-old.ts');
  writeFileSync(
    oldEntry,
    `
import { mkdirSync } from 'node:fs';
import { createStore } from '${join(oldRoot, 'src/main/store').replace(/\\/g, '/')}';
mkdirSync('${scratch}/old-profile', { recursive: true });
const store = createStore('${oldDb}');
const project = store.addProject({ path: 'C:/repo/legacy', name: 'legacy' });
const task = store.createTask(project.id, { title: 'a card from before attachments' });
if (!task) throw new Error('${OLD_TAG} store refused the task');
store.close();
console.log('  wrote a ${OLD_TAG} database: project ' + project.id + ', task ' + task.id);
`,
    'utf8',
  );
  log(`\nWriting a ${OLD_TAG} database with ${OLD_TAG}'s own code...`);
  runUnderElectron(
    await bundle(oldEntry, join(work, 'out-old'), join(oldRoot, 'src', 'shared')),
  );

  // Leg 2 — the CURRENT code, against a fresh profile and against that old database.
  const newEntry = join(work, 'entry-new.ts');
  writeFileSync(
    newEntry,
    SCENARIOS.replaceAll('__SCRATCH__', scratch)
      .replaceAll('__OLD_DB__', oldDb)
      .replaceAll('__REPO__', repo.replace(/\\/g, '/'))
      .replaceAll('__OLD_TAG__', OLD_TAG),
    'utf8',
  );
  log('\nRunning the scenarios against the current code...');
  runUnderElectron(await bundle(newEntry, join(work, 'out-new'), sharedSrc));

  log('\nAll scenarios passed.');
} finally {
  // `--keep` leaves the bundles and the scratch databases behind, which is the only way
  // to open one afterwards and see what a failing scenario actually wrote.
  if (process.argv.includes('--keep')) log(`\nLeft ${work} in place (--keep).`);
  else rmSync(work, { recursive: true, force: true });
}
}

/**
 * The scenarios themselves, as a template so the paths are baked in rather than passed —
 * a bundle takes no argv worth threading, and every path in it is scratch.
 */
const SCENARIOS = String.raw`
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createStore } from '__REPO__/src/main/store';
import {
  addAttachments,
  deleteTaskAttachments,
  sweepOrphanAttachments,
} from '__REPO__/src/main/attachments';
import { attachmentDir, attachmentFile, attachmentsRoot } from '__REPO__/src/main/attachmentPaths';

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log('  PASS  ' + label);
  } else {
    failures += 1;
    console.log('  FAIL  ' + label + (detail === undefined ? '' : ' — ' + detail));
  }
}
function section(name) {
  console.log('\n' + name);
}

const scratch = '__SCRATCH__';
rmSync(scratch + '/fresh', { recursive: true, force: true });
rmSync(scratch + '/sources', { recursive: true, force: true });
mkdirSync(scratch + '/fresh', { recursive: true });
mkdirSync(scratch + '/sources', { recursive: true });

/** A real file on disk for the copy path to copy. */
function source(name, bytes) {
  const path = join(scratch + '/sources', name);
  writeFileSync(path, bytes);
  return path;
}
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const plan = (titles) =>
  titles.map((t) => ({ phase: 'P', title: t, done: false, needs: [], isContract: false, isScaffold: false }));

// ---------------------------------------------------------------------------
section('1. A fresh database gets the table');

const freshDb = scratch + '/fresh/orchestrator.db';
const store = createStore(freshDb);

const raw = new Database(freshDb);
raw.pragma('foreign_keys = ON');
const ddl = raw
  .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_attachments'")
  .get();
check('task_attachments exists', Boolean(ddl));

const columns = raw.prepare('PRAGMA table_info(task_attachments)').all().map((c) => c.name);
check(
  'its seven columns are TaskAttachment, in order',
  columns.join(',') === 'id,taskId,name,fileName,mimeType,size,createdAt',
  columns.join(','),
);
// The id column reads as nullable, and that is SQLite rather than the schema: only an
// INTEGER PRIMARY KEY is implicitly NOT NULL, and every other table here (task_links,
// tasks) declares its TEXT primary key the same way. So ask about the rest.
const info = raw.prepare('PRAGMA table_info(task_attachments)').all();
const nullable = info.filter((c) => c.notnull === 0 && c.pk === 0).map((c) => c.name);
check(
  'mimeType is the only nullable non-key column',
  nullable.join(',') === 'mimeType',
  nullable.join(','),
);

const fk = raw.prepare('PRAGMA foreign_key_list(task_attachments)').all();
check(
  'taskId is a real foreign key onto tasks, ON DELETE CASCADE',
  fk.length === 1 && fk[0].table === 'tasks' && fk[0].from === 'taskId' && fk[0].on_delete === 'CASCADE',
  JSON.stringify(fk),
);
check('name is COLLATE NOCASE', /name\s+TEXT\s+NOT NULL\s+COLLATE NOCASE/i.test(ddl.sql));

// Two unique indexes exist, and only one of them is ours: SQLite auto-indexes the TEXT
// primary key as well. Compare per index rather than across them.
const indexes = raw
  .prepare('PRAGMA index_list(task_attachments)')
  .all()
  .filter((i) => i.unique === 1)
  .map((i) => ({
    name: i.name,
    cols: raw
      .prepare('PRAGMA index_info(' + JSON.stringify(i.name) + ')')
      .all()
      .map((c) => c.name)
      .join(','),
  }));
check(
  'UNIQUE (taskId, name) is one index, leftmost taskId — so no separate taskId index is needed',
  indexes.some((i) => i.cols === 'taskId,name'),
  JSON.stringify(indexes),
);
check(
  'and the only other unique index is the primary key',
  indexes.filter((i) => i.cols !== 'taskId,name').every((i) => i.cols === 'id'),
  JSON.stringify(indexes),
);
check('the connection enforces foreign keys', raw.pragma('foreign_keys', { simple: true }) === 1);

// ---------------------------------------------------------------------------
section('2. A __OLD_TAG__ database gets it too, keeping what it had');

const oldRawBefore = new Database('__OLD_DB__', { readonly: true });
const hadTable = oldRawBefore
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_attachments'")
  .get();
const oldTaskCount = oldRawBefore.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
// By name, not by count: the store mints a built-in Personal project on every open, so
// "one project" was never the right question to ask.
const oldProject = oldRawBefore.prepare("SELECT id FROM projects WHERE name = 'legacy'").get();
oldRawBefore.close();
check('the __OLD_TAG__ database genuinely lacks the table', !hadTable);
check('it has the project and task we put in it', oldTaskCount === 1 && Boolean(oldProject));

const migrated = createStore('__OLD_DB__');
const oldRawAfter = new Database('__OLD_DB__', { readonly: true });
check(
  'opening it with the current code creates task_attachments',
  Boolean(
    oldRawAfter
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_attachments'")
      .get(),
  ),
);
check(
  'the project and task survived the open',
  oldRawAfter.prepare('SELECT COUNT(*) AS n FROM tasks').get().n === 1 &&
    Boolean(oldRawAfter.prepare("SELECT id FROM projects WHERE name = 'legacy'").get()),
);
const migratedProject = migrated.listProjects().find((p) => p.name === 'legacy');
const migratedTask = migrated.getTasks(migratedProject.id)[0];
check('the old card reads back through the current store', Boolean(migratedTask));
const onOld = migrated.addAttachment({
  taskId: migratedTask.id,
  name: 'after-upgrade.png',
  fileName: 'after upgrade.png',
  mimeType: 'image/png',
  size: 3,
});
check('and the migrated table takes a row', Boolean(onOld));
oldRawAfter.close();
migrated.close();

// ---------------------------------------------------------------------------
section('3. Deleting the task row cascades the attachment rows');

const project = store.addProject({ path: 'C:/repo/demo', name: 'demo' });
const card = store.createTask(project.id, { title: 'a card' });
const step = store.addSubtask(card.id, { title: 'a step' });
store.addAttachment({ taskId: card.id, name: 'a.png', fileName: 'a.png', mimeType: 'image/png', size: 1 });
store.addAttachment({ taskId: step.id, name: 'b.png', fileName: 'b.png', mimeType: 'image/png', size: 1 });
check('two rows are there to lose', store.listAttachments().length === 2);

check(
  'UNIQUE (taskId, name) refuses a repeat, case-insensitively',
  store.addAttachment({ taskId: card.id, name: 'A.PNG', fileName: 'A.PNG', mimeType: 'image/png', size: 1 }) ===
    undefined,
);
check(
  'the same name under a DIFFERENT task is fine',
  Boolean(store.addAttachment({ taskId: step.id, name: 'a.png', fileName: 'a.png', mimeType: 'image/png', size: 1 })),
);
check(
  'the foreign key refuses an unknown task',
  store.addAttachment({ taskId: 'no-such-task', name: 'c.png', fileName: 'c.png', mimeType: null, size: 1 }) ===
    undefined,
);

raw.prepare('DELETE FROM tasks WHERE id = ?').run(step.id);
check(
  "DELETE FROM tasks takes that step's rows with it",
  store.attachmentsForTask(step.id).length === 0 && store.listAttachments().length === 1,
);

// A project delete is the path task:delete never sees — the reason the sweep exists.
const doomed = store.addProject({ path: 'C:/repo/doomed', name: 'doomed' });
const doomedTask = store.createTask(doomed.id, { title: 'doomed' });
store.addAttachment({ taskId: doomedTask.id, name: 'd.png', fileName: 'd.png', mimeType: 'image/png', size: 1 });
check('a doomed project has an attachment', store.attachmentsForTask(doomedTask.id).length === 1);
store.removeProject(doomed.id);
check(
  'deleting the PROJECT cascades through its tasks to their attachments',
  store.attachmentsForTask(doomedTask.id).length === 0,
);

// ---------------------------------------------------------------------------
section('4. Deleting a card removes the files, not just the rows');

const root = scratch + '/fresh';
const withFiles = store.createTask(project.id, { title: 'a card with files' });
const itsStep = store.addSubtask(withFiles.id, { title: 'a step with files' });
const cardAdd = await addAttachments(store, root, withFiles.id, [
  source('shot.png', PNG),
  source('shot.png', PNG),
]);
const stepAdd = await addAttachments(store, root, itsStep.id, [source('brief.txt', 'hello')]);
check('both files landed on the card', cardAdd.added.length === 2 && cardAdd.failed.length === 0);
check(
  'the second was deduped to shot-2.png, keeping the extension',
  cardAdd.added.map((a) => a.name).join(',') === 'shot.png,shot-2.png',
  cardAdd.added.map((a) => a.name).join(','),
);
check(
  'fileName keeps what the human picked, mimeType came off the suffix',
  cardAdd.added[0].fileName === 'shot.png' && cardAdd.added[0].mimeType === 'image/png',
);
check(
  'the bytes are under <root>/attachments/<taskId>/<name>',
  existsSync(attachmentFile(root, withFiles.id, 'shot.png')) &&
    existsSync(attachmentFile(root, withFiles.id, 'shot-2.png')) &&
    existsSync(attachmentFile(root, itsStep.id, 'brief.txt')),
);
check(
  'and they are a copy, byte for byte',
  Buffer.compare(readFileSync(attachmentFile(root, withFiles.id, 'shot.png')), PNG) === 0,
);
check('size is the real size on disk', cardAdd.added[0].size === PNG.length);

const steps = store.getSubtasks(withFiles.id);
store.deleteTask(withFiles.id);
await deleteTaskAttachments(root, [withFiles.id, ...steps.map((s) => s.id)]);
check(
  'the rows went with the card, including the step\u2019s',
  store.attachmentsForTask(withFiles.id).length === 0 && store.attachmentsForTask(itsStep.id).length === 0,
);
check(
  'and so did both directories',
  !existsSync(attachmentDir(root, withFiles.id)) && !existsSync(attachmentDir(root, itsStep.id)),
);

// ---------------------------------------------------------------------------
section('5. The boot sweep removes what nothing points at');

const live = store.createTask(project.id, { title: 'a live card' });
await addAttachments(store, root, live.id, [source('keep.png', PNG)]);

// Two orphans, one of each kind the sweep exists for: a task whose rows cascaded away
// (a deleted project), and a crash between the copy and the insert.
const ghostDir = attachmentDir(root, 'a-task-that-cascaded-away');
mkdirSync(ghostDir, { recursive: true });
writeFileSync(join(ghostDir, 'gone.png'), PNG);
const crashedDir = attachmentDir(root, 'a-copy-that-never-got-its-row');
mkdirSync(crashedDir, { recursive: true });
writeFileSync(join(crashedDir, 'half.png'), PNG);

const swept = await sweepOrphanAttachments(store, root);
check('the sweep reports the two it removed', swept === 2, String(swept));
check('both orphan directories are gone', !existsSync(ghostDir) && !existsSync(crashedDir));
check(
  'the live one was left alone, bytes and row',
  existsSync(attachmentFile(root, live.id, 'keep.png')) && store.attachmentsForTask(live.id).length === 1,
);
check('a second sweep finds nothing left', (await sweepOrphanAttachments(store, root)) === 0);

const emptyRoot = scratch + '/never-attached-anything';
check(
  'a profile that never attached anything sweeps to 0, quietly',
  (await sweepOrphanAttachments(store, emptyRoot)) === 0 && !existsSync(attachmentsRoot(emptyRoot)),
);

// ---------------------------------------------------------------------------
section('6. Re-syncing a plan keeps the attachments');

const planned = store.addProject({ path: 'C:/repo/planned', name: 'planned' });
store.syncTasksFromPlan(planned.id, plan(['keep me', 'drop me']));
const [keepTask, dropTask] = store.getTasks(planned.id);
const keepAdd = await addAttachments(store, root, keepTask.id, [source('mockup.png', PNG)]);
const dropAdd = await addAttachments(store, root, dropTask.id, [source('scratch.png', PNG)]);
check('both planned tasks carry a file', keepAdd.added.length === 1 && dropAdd.added.length === 1);

store.syncTasksFromPlan(planned.id, plan(['keep me', 'drop me']));
const keptRows = store.attachmentsForTask(keepTask.id);
check('re-syncing the SAME plan keeps the row', keptRows.length === 1);
check(
  'and keeps its id, so an open preview URL stays valid',
  keptRows[0] && keptRows[0].id === keepAdd.added[0].id,
);
check(
  'createdAt, name and size came back untouched',
  keptRows[0] &&
    keptRows[0].createdAt === keepAdd.added[0].createdAt &&
    keptRows[0].name === 'mockup.png' &&
    keptRows[0].size === PNG.length,
);
check('the bytes were never touched at all', existsSync(attachmentFile(root, keepTask.id, 'mockup.png')));

store.syncTasksFromPlan(planned.id, plan(['keep me']));
check(
  'a task the plan DROPPED loses its rows — a genuine cascade',
  store.attachmentsForTask(dropTask.id).length === 0,
);
check('while the kept one still has its own', store.attachmentsForTask(keepTask.id).length === 1);
check(
  'and the dropped task\u2019s bytes are now an orphan the sweep will take',
  existsSync(attachmentDir(root, dropTask.id)) && (await sweepOrphanAttachments(store, root)) === 1,
);

raw.close();
store.close();

console.log('');
if (failures > 0) {
  console.error(failures + ' check(s) failed.');
  process.exit(1);
}
`;

await main();
