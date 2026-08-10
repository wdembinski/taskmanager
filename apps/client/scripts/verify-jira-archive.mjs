/**
 * Headless verification for `tasks.archivedAt` — the column that lets a card leave the BOARD
 * without leaving the database — and `tasks.archivedReason` beside it, which records WHICH
 * question's answer sent it, since that is the one thing the Removed-cards list cannot work
 * out from the row.
 *
 * There is nothing here `vitest` could take over. Every claim being made is a claim about a
 * real SQLite file: that the column appears on a fresh profile AND on one written by v0.68.1,
 * that opening the same database twice does not try to add it again, and — the one that
 * matters — that archiving a card leaves its `task_links`, `task_attachments`, `task_activity`
 * and `task_events` exactly where they were, while `deleteTask` on an identical card takes all
 * four with it. That difference IS the feature; asserting it against a mock would assert
 * nothing. And `better-sqlite3` is built for Electron's ABI, not the Node that runs the suite.
 *
 * Section 8 closes the loop the other seven leave open. They call `archiveTask` and
 * `unarchiveTask` by hand, which proves the store keeps its promises but says nothing about
 * whether the SYNC ever keeps them — so the last section drives the round trip through the
 * REAL `reconcileJiraTasks`: a JIRA card carrying a step, a timeline, a file and an arrow,
 * taken off the board by a decision the reconciler made, absent from `board:tasks`, then
 * returned by the query and put back under the same id with all of it still attached. The
 * decision half of that is unit-tested end to end in `src/main/jira/jiraSync.integration.test.ts`
 * (300 issues over a mocked, paged `fetch`); what only a real database can show is that the row
 * survives it, and that exactly ONE card exists for the ticket afterwards rather than the old
 * one plus a fresh copy.
 *
 * The app is NEVER launched (RELEASE.md rule 6 — there is no single-instance lock, and a
 * second instance killed a live session on 2026-08-02). This drives `store.ts` directly under
 * `ELECTRON_RUN_AS_NODE`, against scratch databases under `.verify-jira-archive/`. It never
 * opens, reads or writes the real profile.
 *
 * How it works, and why it is not simply a `node` script: `store.ts` is TypeScript with
 * `@shared` aliases and an `electron` import in its dependency graph. So each scenario file is
 * bundled with Vite first (aliasing `electron` to a stub, whose every symbol throws — a
 * scenario that somehow reached Electron must fail loudly rather than quietly verify a stub),
 * then run under Electron-as-Node so the addon's ABI matches the binary loading it.
 *
 * The v0.68.1 leg is a real downgrade rather than a hand-cut schema: the tagged tree is
 * extracted with `git archive` and ITS `createStore` writes the old database, which the current
 * one then opens. A schema built by today's code minus one column would prove nothing about
 * the migration.
 *
 *   pnpm exec node scripts/verify-jira-archive.mjs
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
 * Everything this script writes lives here, INSIDE the repo rather than in the temp dir, for
 * one reason: the bundles keep `better-sqlite3` external, so they must sit somewhere Node's
 * resolution can still find `node_modules`. Removed on the way out, and on the way in — a
 * crashed previous run must not leak into this one.
 */
const work = join(repo, '.verify-jira-archive');

/** The version whose database the current schema has to open without losing anything. */
const OLD_TAG = 'v0.68.1';

const electronBin = join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
const electronBinPosix = join(repo, 'node_modules', 'electron', 'dist', 'electron');

function log(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * Nothing on this path calls into Electron: `store.ts` needs none of it, and `logMain`'s
 * `app.getPath` already sits inside a `try` that swallows the throw. Throwing rather than
 * returning a plausible value is deliberate — a scenario that ever does reach Electron must
 * fail loudly here instead of quietly verifying a stub.
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
      // The native addon must stay a real `import` resolved at run time — bundling a `.node`
      // file is exactly the mistake this whole ABI dance exists to avoid.
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
const card = store.createTask('personal', { title: 'a card from before archiving' });
if (!card) throw new Error('${OLD_TAG} store refused the card');
store.addComment('personal', card.id, 'written before the column existed');
store.close();
console.log('  wrote a ${OLD_TAG} database: project ' + project.id + ', card ' + card.id);
`,
      'utf8',
    );
    log(`\nWriting a ${OLD_TAG} database with ${OLD_TAG}'s own code...`);
    runUnderElectron(await bundle(oldEntry, join(work, 'out-old'), join(oldRoot, 'src', 'shared')));

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
    // `--keep` leaves the bundles and the scratch databases behind, which is the only way to
    // open one afterwards and see what a failing scenario actually wrote.
    if (process.argv.includes('--keep')) log(`\nLeft ${work} in place (--keep).`);
    else rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The scenarios themselves, as a template so the paths are baked in rather than passed — a
 * bundle takes no argv worth threading, and every path in it is scratch.
 *
 * No backticks and no `${` below: `String.raw` still interpolates, so a template literal in
 * here would be evaluated by THIS file rather than by the scenario. Plain quotes and `+`.
 */
const SCENARIOS = String.raw`
import { mkdirSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createStore } from '__REPO__/src/main/store';
// The real reconciler, for section 8 — the round trip has to be driven by the thing that
// really decides, or it would only prove that this script can call archiveTask.
import { issueToBoardTask, reconcileJiraTasks } from '__REPO__/src/main/jira/jiraSync';

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

const PERSONAL = 'personal';
const DAY = 24 * 60 * 60 * 1000;

const scratch = '__SCRATCH__';
rmSync(scratch + '/fresh', { recursive: true, force: true });
mkdirSync(scratch + '/fresh', { recursive: true });

const plan = (titles) =>
  titles.map((t) => ({ phase: 'P', title: t, done: false, needs: [], isContract: false, isScaffold: false }));

// ---------------------------------------------------------------------------
section('1. A fresh database gets the column');

const freshDb = scratch + '/fresh/orchestrator.db';
const store = createStore(freshDb);
const raw = new Database(freshDb);
raw.pragma('foreign_keys = ON');

const info = raw.prepare('PRAGMA table_info(tasks)').all();
const archived = info.filter((c) => c.name === 'archivedAt');
check('tasks has exactly one archivedAt column', archived.length === 1, String(archived.length));
check('it is an INTEGER (epoch ms, like retainedSince beside it)', archived[0] && archived[0].type === 'INTEGER', archived[0] && archived[0].type);
// Nullable with no default is the whole migration story: NULL means "on the board", so every
// row that predates the column is already correct without being touched.
check(
  'nullable, with no default — NULL is a real value meaning "on the board"',
  archived[0] && archived[0].notnull === 0 && archived[0].dflt_value === null,
  archived[0] && JSON.stringify({ notnull: archived[0].notnull, dflt: archived[0].dflt_value }),
);

// Its companion, added with the Removed-cards list: WHICH question's answer took the card off.
// TEXT and nullable for the same migration reason — a row archived by the version that had only
// the timestamp records no reason, and the list says exactly that rather than guessing one.
const reasonCol = info.filter((c) => c.name === 'archivedReason');
check('tasks has exactly one archivedReason column', reasonCol.length === 1, String(reasonCol.length));
check('it is TEXT, holding the reason union verbatim', reasonCol[0] && reasonCol[0].type === 'TEXT', reasonCol[0] && reasonCol[0].type);
check(
  'nullable, with no default — NULL is "nobody recorded why"',
  reasonCol[0] && reasonCol[0].notnull === 0 && reasonCol[0].dflt_value === null,
  reasonCol[0] && JSON.stringify({ notnull: reasonCol[0].notnull, dflt: reasonCol[0].dflt_value }),
);

const brandNew = store.createTask(PERSONAL, { title: 'a brand new card' });
// Read back rather than trusting what createTask handed over: like retainedSince and landedAt
// beside it, that literal simply omits the field, and the column is what the board is drawn
// from. undefined and null both mean "on the board" — but only one of them is in SQLite.
check('a card created today is stored with archivedAt NULL', store.getTask(brandNew.id).archivedAt === null, JSON.stringify(store.getTask(brandNew.id).archivedAt));
check('and the value createTask returns is not an archived one either', brandNew.archivedAt == null, JSON.stringify(brandNew.archivedAt));
check('so it is on the board', store.getPersonalTasks().some((t) => t.id === brandNew.id));

// ---------------------------------------------------------------------------
section('2. A __OLD_TAG__ database gets it too, keeping what it had');

const oldBefore = new Database('__OLD_DB__', { readonly: true });
const hadColumn = oldBefore
  .prepare('PRAGMA table_info(tasks)')
  .all()
  .some((c) => c.name === 'archivedAt');
const oldCards = oldBefore.prepare('SELECT id, title FROM tasks').all();
const oldComments = oldBefore.prepare('SELECT COUNT(*) AS n FROM task_activity').get().n;
oldBefore.close();
check('the __OLD_TAG__ database genuinely lacks the column', !hadColumn);
check('it has the card and the comment we put in it', oldCards.length === 1 && oldComments === 1);

const migrated = createStore('__OLD_DB__');
const oldAfter = new Database('__OLD_DB__', { readonly: true });
check(
  'opening it with the current code adds archivedAt',
  oldAfter.prepare('PRAGMA table_info(tasks)').all().filter((c) => c.name === 'archivedAt').length === 1,
);
check(
  'and archivedReason beside it',
  oldAfter.prepare('PRAGMA table_info(tasks)').all().filter((c) => c.name === 'archivedReason').length === 1,
);
check(
  'the card and its comment survived the open',
  oldAfter.prepare('SELECT COUNT(*) AS n FROM tasks').get().n === 1 &&
    oldAfter.prepare('SELECT COUNT(*) AS n FROM task_activity').get().n === 1,
);
const migratedCard = migrated.getPersonalTasks()[0];
check('the old card reads back through the current store', Boolean(migratedCard) && migratedCard.id === oldCards[0].id);
check('with archivedAt null — an upgrade hides nothing', migratedCard && migratedCard.archivedAt === null);
check('so it is still on the board', migrated.getPersonalTasks().length === 1);
oldAfter.close();

// ---------------------------------------------------------------------------
section('3. Opening it again is a no-op');

// A second ALTER would throw "duplicate column name: archivedAt" and take the whole app's
// startup with it, so this is the assertion that the PRAGMA guard is really guarding.
migrated.archiveTask(migratedCard.id, 1000);
migrated.close();

let reopened = null;
let reopenError = null;
try {
  reopened = createStore('__OLD_DB__');
} catch (e) {
  reopenError = e;
}
check('re-opening the migrated database does not throw', reopenError === null, reopenError && String(reopenError.message));
const reopenedRaw = new Database('__OLD_DB__', { readonly: true });
check(
  'and still has exactly one archivedAt column',
  reopenedRaw.prepare('PRAGMA table_info(tasks)').all().filter((c) => c.name === 'archivedAt').length === 1,
);
// The stamp has to survive a restart or nothing archived would stay archived past a relaunch.
check(
  'a card archived before the close is still archived after it',
  reopened.getArchivedTasks().length === 1 && reopened.getArchivedTasks()[0].archivedAt === 1000,
  JSON.stringify(reopened.getArchivedTasks().map((t) => t.archivedAt)),
);
check('and still off the board', reopened.getPersonalTasks().length === 0);
check(
  'while the sync read can still see it',
  reopened.getPersonalTasksForSync().length === 1,
);
reopenedRaw.close();
reopened.close();

// ---------------------------------------------------------------------------
section('4. Archiving hides a card; deleting destroys one — side by side');

/** Everything a card can carry that JIRA has never heard of, hung off one id. */
function furnish(store, card) {
  const step = store.addSubtask(card.id, { title: card.title + ' — a step' });
  store.addAttachment({ taskId: card.id, name: 'a.png', fileName: 'a.png', mimeType: 'image/png', size: 1 });
  store.addAttachment({ taskId: step.id, name: 'b.png', fileName: 'b.png', mimeType: 'image/png', size: 1 });
  store.addComment(PERSONAL, card.id, 'what I worked out about this one');
  store.addStatusNote(PERSONAL, card.id, 'waiting on infra');
  store.recordStatusChange(PERSONAL, card.id, 'pending', 'in-progress');
  store.appendTaskEvent(PERSONAL, card.id, 'run-1', { kind: 'assistant', text: 'here is what I did' });
  store.appendTaskEvent(PERSONAL, step.id, 'run-2', { kind: 'assistant', text: 'and here is the step' });
  return step;
}

/** The four things that must survive an archive and must NOT survive a delete. */
function census(id) {
  return {
    task: raw.prepare('SELECT COUNT(*) AS n FROM tasks WHERE id = ?').get(id).n,
    steps: raw.prepare('SELECT COUNT(*) AS n FROM tasks WHERE parentTaskId = ?').get(id).n,
    links: raw
      .prepare('SELECT COUNT(*) AS n FROM task_links WHERE fromTaskId = ? OR toTaskId = ?')
      .get(id, id).n,
    attachments: raw.prepare('SELECT COUNT(*) AS n FROM task_attachments WHERE taskId = ?').get(id).n,
    activity: raw.prepare('SELECT COUNT(*) AS n FROM task_activity WHERE taskId = ?').get(id).n,
    events: raw.prepare('SELECT COUNT(*) AS n FROM task_events WHERE taskId = ?').get(id).n,
  };
}

const keeper = store.createTask(PERSONAL, { title: 'the card that is archived' });
const doomed = store.createTask(PERSONAL, { title: 'the card that is deleted' });
const neighbour = store.createTask(PERSONAL, { title: 'the card at the other end of the arrows' });
const keeperStep = furnish(store, keeper);
const doomedStep = furnish(store, doomed);
store.addTaskLink(keeper.id, neighbour.id, 'after-merge');
store.addTaskLink(doomed.id, neighbour.id, 'after-merge');

const keeperBefore = census(keeper.id);
const doomedBefore = census(doomed.id);
check(
  'both cards start out carrying exactly the same things',
  JSON.stringify(keeperBefore) === JSON.stringify(doomedBefore),
  JSON.stringify(keeperBefore) + ' vs ' + JSON.stringify(doomedBefore),
);
check(
  'and that is a step, a link, an attachment, three timeline entries and an event',
  JSON.stringify(keeperBefore) ===
    JSON.stringify({ task: 1, steps: 1, links: 1, attachments: 1, activity: 3, events: 1 }),
  JSON.stringify(keeperBefore),
);

const AT = 5_000_000;
const archivedCard = store.archiveTask(keeper.id, AT, 'gone-from-jira');
check('archiveTask hands back the card it archived', Boolean(archivedCard) && archivedCard.id === keeper.id);
check('stamped with the time it was given', archivedCard && archivedCard.archivedAt === AT, archivedCard && String(archivedCard.archivedAt));
// The one thing the Removed-cards list cannot work out for itself: a card dropped because its
// ticket is gone and one dropped because a retention clock expired are the same row otherwise.
check('and with the reason it was given', archivedCard && archivedCard.archivedReason === 'gone-from-jira', archivedCard && String(archivedCard.archivedReason));
check(
  'which reads back off the archived list, not just off the return value',
  store.getArchivedTasks().find((t) => t.id === keeper.id)?.archivedReason === 'gone-from-jira',
);
check(
  'archiving without one records no reason rather than inventing a default',
  (() => {
    const nameless = store.createTask(PERSONAL, { title: 'archived by a caller that said nothing' });
    const done = store.archiveTask(nameless.id, AT);
    const ok = done && done.archivedReason === null;
    store.deleteTask(nameless.id);
    return ok;
  })(),
);

const board = store.getPersonalTasks().map((t) => t.id);
check('the card is off the board', !board.includes(keeper.id));
check(
  'and so is its step — a step is only ever drawn under its parent',
  !board.includes(keeperStep.id),
);
check('the other cards are untouched', board.includes(doomed.id) && board.includes(neighbour.id));
check(
  'getPersonalTasksForSync still sees it, so the sync cannot mirror the ticket back in as a new card',
  store.getPersonalTasksForSync().some((t) => t.id === keeper.id),
);
const archivedList = store.getArchivedTasks().map((t) => t.id);
check('getArchivedTasks lists it', archivedList.includes(keeper.id));
check('with its step, so a restore has something to restore', archivedList.includes(keeperStep.id));
check('and nothing that is still on the board', !archivedList.includes(neighbour.id));

const keeperAfter = census(keeper.id);
check(
  'NOTHING it carried was destroyed — the row, the step, the link, the file, the timeline, the transcript',
  JSON.stringify(keeperAfter) === JSON.stringify(keeperBefore),
  JSON.stringify(keeperAfter),
);
check('getTask still returns it — archiving is not deletion', Boolean(store.getTask(keeper.id)));
check(
  'its timeline reads back whole',
  store.getTaskActivity(keeper.id).some((e) => e.kind === 'comment' && e.body === 'what I worked out about this one'),
);
check('and its transcript too', store.getTaskHistory(keeper.id).length === 1);

// The same card, the other verb.
store.deleteTask(doomed.id);
const doomedAfter = census(doomed.id);
check(
  'deleteTask destroys all six — row, step, link, attachment, timeline, transcript',
  JSON.stringify(doomedAfter) === JSON.stringify({ task: 0, steps: 0, links: 0, attachments: 0, activity: 0, events: 0 }),
  JSON.stringify(doomedAfter),
);
check('its step went with it', raw.prepare('SELECT COUNT(*) AS n FROM tasks WHERE id = ?').get(doomedStep.id).n === 0);
check('it is on neither list', !store.getPersonalTasks().some((t) => t.id === doomed.id) && !store.getArchivedTasks().some((t) => t.id === doomed.id));
check('and the sync read cannot see it either — a delete is a delete', !store.getPersonalTasksForSync().some((t) => t.id === doomed.id));
check(
  'the neighbour it pointed at survived, and kept the OTHER arrow',
  Boolean(store.getTask(neighbour.id)) && census(neighbour.id).links === 1,
  JSON.stringify(census(neighbour.id)),
);

check('archiving the same card twice is refused', store.archiveTask(keeper.id, AT + 1) === undefined);
check('archiving an unknown id is refused', store.archiveTask('no-such-card', AT) === undefined);
check(
  'archiving a STEP is refused — it is not on the board, so it cannot leave it',
  store.archiveTask(keeperStep.id, AT) === undefined,
);

// ---------------------------------------------------------------------------
section('5. Unarchiving puts it back, same id, everything still attached');

const restored = store.unarchiveTask(keeper.id);
check('unarchiveTask hands the card back', Boolean(restored));
check('with the SAME id it left under', restored && restored.id === keeper.id);
check('and archivedAt cleared', restored && restored.archivedAt === null, restored && String(restored.archivedAt));
// The reason describes an ABSENCE. Left behind, it would still be sitting there the next time
// this card left the board for some entirely different reason.
check('and the reason cleared with it', restored && restored.archivedReason === null, restored && String(restored.archivedReason));

const backOnBoard = store.getPersonalTasks().map((t) => t.id);
check('it is on the board again', backOnBoard.includes(keeper.id));
check('and so is its step', backOnBoard.includes(keeperStep.id));
check('the archived list is empty again', store.getArchivedTasks().length === 0);
check(
  'and it still carries exactly what it carried before any of this',
  JSON.stringify(census(keeper.id)) === JSON.stringify(keeperBefore),
  JSON.stringify(census(keeper.id)),
);
check(
  'the comment is the same comment, not a replacement',
  store.getTaskActivity(keeper.id).some((e) => e.kind === 'comment' && e.body === 'what I worked out about this one'),
);
check('the arrow to its neighbour is still drawn', store.listTaskLinks().some((l) => l.fromTaskId === keeper.id && l.toTaskId === neighbour.id));
check('its attachment row still names the same file', store.attachmentsForTask(keeper.id).map((a) => a.name).join(',') === 'a.png');
check('unarchiving an unknown id is refused', store.unarchiveTask('no-such-card') === undefined);
check('unarchiving one that was never archived is harmless', Boolean(store.unarchiveTask(neighbour.id)) && store.getTask(neighbour.id).archivedAt === null);

// ---------------------------------------------------------------------------
section('6. pruneArchivedBefore respects the cutoff');

const CUTOFF = 1_000_000;
const veryOld = store.createTask(PERSONAL, { title: 'archived long ago' });
const justBefore = store.createTask(PERSONAL, { title: 'archived a moment before the cutoff' });
const exactly = store.createTask(PERSONAL, { title: 'archived exactly at the cutoff' });
const recent = store.createTask(PERSONAL, { title: 'archived recently' });
const veryOldStep = furnish(store, veryOld);
store.addTaskLink(veryOld.id, neighbour.id, 'after-merge');
store.archiveTask(veryOld.id, CUTOFF - DAY);
store.archiveTask(justBefore.id, CUTOFF - 1);
store.archiveTask(exactly.id, CUTOFF);
store.archiveTask(recent.id, CUTOFF + DAY);

const liveBefore = store.getPersonalTasks().length;
check('four cards are archived and waiting', store.getArchivedTasks().filter((t) => t.parentTaskId === null).length === 4);

const pruned = store.pruneArchivedBefore(CUTOFF);
check('it reports the two strictly older than the cutoff', pruned === 2, String(pruned));
check('both are gone for good', !store.getTask(veryOld.id) && !store.getTask(justBefore.id));
check(
  'a card archived EXACTLY at the cutoff survives — the comparison is strict',
  Boolean(store.getTask(exactly.id)),
);
check('and the recent one survives', Boolean(store.getTask(recent.id)));
check('the two survivors are still listed as archived', store.getArchivedTasks().filter((t) => t.parentTaskId === null).length === 2);

check(
  'a pruned card took its step, link, attachments, timeline and transcript with it',
  JSON.stringify(census(veryOld.id)) === JSON.stringify({ task: 0, steps: 0, links: 0, attachments: 0, activity: 0, events: 0 }),
  JSON.stringify(census(veryOld.id)),
);
check('including the step row itself', raw.prepare('SELECT COUNT(*) AS n FROM tasks WHERE id = ?').get(veryOldStep.id).n === 0);
check('it counts CARDS, not the steps it swept up with them', pruned === 2);

check('nothing on the board was touched', store.getPersonalTasks().length === liveBefore);
check('the neighbour kept its remaining arrow', census(neighbour.id).links === 1, JSON.stringify(census(neighbour.id)));
check('a second prune at the same cutoff finds nothing left', store.pruneArchivedBefore(CUTOFF) === 0);
check(
  'and a cutoff before everything prunes nothing at all',
  store.pruneArchivedBefore(0) === 0 && store.getArchivedTasks().filter((t) => t.parentTaskId === null).length === 2,
);

// ---------------------------------------------------------------------------
section('7. A plan project is not a board, and knows nothing about any of this');

const planProject = store.addProject({ path: 'C:/repo/planned', name: 'planned' });
store.syncTasksFromPlan(planProject.id, plan(['first', 'second']));
check('its queue has both tasks', store.getTasks(planProject.id).length === 2);
check(
  'getTasks is unfiltered by design — a queue that silently skipped work would be a queue that stalls',
  store.getTasks(planProject.id).every((t) => t.archivedAt === null),
);
check('and archiving on the board did not disturb it', store.getTasks(planProject.id).length === 2);
// A cutoff far in the future takes every archived card there is — and still leaves a plan
// project's queue whole, because the sweep only ever looks at rows carrying an archivedAt.
check(
  'a sweep that takes every archived card leaves the queue alone',
  store.pruneArchivedBefore(CUTOFF + 10 * DAY) === 2 && store.getTasks(planProject.id).length === 2,
);
check('and there is now nothing archived at all', store.getArchivedTasks().length === 0);
check('while the board still has every card that was on it', store.getPersonalTasks().length === liveBefore);

// ---------------------------------------------------------------------------
section('8. The whole round trip, driven by the sync rather than by hand');

// Everything above calls archiveTask and unarchiveTask directly, which proves the store keeps
// its promises but says nothing about whether the SYNC ever keeps them. This is the trip the
// user actually takes: a real JIRA card, carrying a step, a timeline, a file and an arrow,
// taken off the board by a decision reconcileJiraTasks made, gone from board:tasks, and then
// put back — under the same id, with all of it still attached — because the query returned it
// again. The reconciler is the real one; only the network is absent.

const TICKET = 'ROUND-42';
const ticket = {
  id: '90210',
  key: TICKET,
  fields: {
    summary: 'the card that goes round the whole loop',
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate', name: 'In Progress' } },
    priority: { name: 'High' },
    project: { key: 'ROUND', name: 'Round Trip' },
  },
};
const jiraOpts = { baseUrl: 'https://jira.example.com' };
const SYNC_AT = 9_000_000;

// The card exactly as the app really writes one — through issueToBoardTask, not a hand-built
// lookalike. It is the "Add task with a linked ticket" path deliberately: that lands the issue
// on a row the store had already generated an id for, so the id is NOT the reconciler's own
// fallback ('jira-' + issue.id). Adopting that fallback here would make every "same row" check
// below pass by coincidence — the id a lost card is re-created under would be the id it was
// meant to keep — and the duplicate check at the end could never fire.
const local = store.createTask(PERSONAL, { title: 'raised locally, then linked to a ticket' });
const synced = store.upsertJiraTask(issueToBoardTask(ticket, local, jiraOpts));
check('the sync put a JIRA card on the board', Boolean(synced) && synced.externalKey === TICKET);
check(
  'and its id is its own, not the one a re-created card would land on',
  synced.id === local.id && synced.id !== 'jira-' + ticket.id,
  synced.id,
);
const syncedStep = furnish(store, synced);
store.addTaskLink(synced.id, neighbour.id, 'after-merge');
const syncedBefore = census(synced.id);
check(
  'carrying a step, an arrow, a file, three timeline entries and a transcript',
  JSON.stringify(syncedBefore) ===
    JSON.stringify({ task: 1, steps: 1, links: 1, attachments: 1, activity: 3, events: 1 }),
  JSON.stringify(syncedBefore),
);

// --- the sync takes it off the board ---------------------------------------
// The read that includes archived cards, exactly as ipc.ts does it. An empty issue list is the
// query no longer returning the ticket; queryChecked/queryMatches is JIRA having been ASKED
// about this key and having said no, which is the only thing that makes a removal legal.
const removalRun = reconcileJiraTasks(store.getPersonalTasksForSync(), [], {
  ...jiraOpts,
  queryChecked: [TICKET],
  queryMatches: [],
  truncated: false,
  now: SYNC_AT,
});
check('the reconciler decided to let it go', removalRun.removals.length === 1, JSON.stringify(removalRun.removals));
check('naming the ticket, the title and the reason',
  removalRun.removals[0] &&
    removalRun.removals[0].key === TICKET &&
    removalRun.removals[0].taskId === synced.id &&
    removalRun.removals[0].reason === 'left-query',
  JSON.stringify(removalRun.removals[0]),
);
check('and refused nothing — one card is well under the guard', removalRun.refused.length === 0);
// Applied the way ipc.ts applies it: archiveTask, never deleteTask.
for (const r of removalRun.removals) store.archiveTask(r.taskId, SYNC_AT, r.reason);

// board:tasks IS getPersonalTasks — the handler is a one-liner over it (see ipc.ts).
const boardAfterSync = store.getPersonalTasks().map((t) => t.id);
check('board:tasks no longer shows it', !boardAfterSync.includes(synced.id));
check('nor its step', !boardAfterSync.includes(syncedStep.id));
check('the neighbour it points at is untouched', boardAfterSync.includes(neighbour.id));
check(
  'the Removed-cards list has it, and says why',
  store.getArchivedTasks().find((t) => t.id === synced.id)?.archivedReason === 'left-query',
);
check(
  'NOTHING it carried was destroyed by the sync',
  JSON.stringify(census(synced.id)) === JSON.stringify(syncedBefore),
  JSON.stringify(census(synced.id)),
);

// --- the query returns it, and the sync puts it back -----------------------
// The next poll, with the ticket back in the answer. Nothing else changes — this is the whole
// mechanism by which a card the sync removed comes back on its own.
const restoreRun = reconcileJiraTasks(store.getPersonalTasksForSync(), [ticket], {
  ...jiraOpts,
  now: SYNC_AT + DAY,
});
check('the reconciler asks for it to be restored', JSON.stringify(restoreRun.restoreIds) === JSON.stringify([synced.id]), JSON.stringify(restoreRun.restoreIds));
check('and removes nothing on the way back', restoreRun.removals.length === 0);
check(
  'the upsert lands on the SAME row rather than bringing a second card',
  restoreRun.upserts.length === 1 && restoreRun.upserts[0].id === synced.id,
  JSON.stringify(restoreRun.upserts.map((t) => t.id)),
);
// Restore first, then upsert — the order ipc.ts uses, so the ticket lands on its own card
// rather than beside the archived one.
for (const id of restoreRun.restoreIds) store.unarchiveTask(id);
for (const t of restoreRun.upserts) store.upsertJiraTask(t);

const backOnBoardAfterSync = store.getPersonalTasks().map((t) => t.id);
check('it is on the board again, under the id it left with', backOnBoardAfterSync.includes(synced.id));
check('and its step came back with it', backOnBoardAfterSync.includes(syncedStep.id));
check('the Removed-cards list is empty again', store.getArchivedTasks().length === 0);
check('archivedAt is cleared', store.getTask(synced.id).archivedAt === null);
check('and so is the reason', store.getTask(synced.id).archivedReason === null);
// The assertion the whole archive-instead-of-delete design exists for.
check(
  'it still carries exactly what it carried before the sync ever touched it',
  JSON.stringify(census(synced.id)) === JSON.stringify(syncedBefore),
  JSON.stringify(census(synced.id)),
);
check(
  'the timeline entry is the same one, not a replacement',
  store.getTaskActivity(synced.id).some((e) => e.kind === 'comment' && e.body === 'what I worked out about this one'),
);
check('the transcript survived the round trip', store.getTaskHistory(synced.id).length === 1);
check('the attachment still names the same file', store.attachmentsForTask(synced.id).map((a) => a.name).join(',') === 'a.png');
check('the arrow to its neighbour is still drawn', store.listTaskLinks().some((l) => l.fromTaskId === synced.id && l.toTaskId === neighbour.id));
// The failure this replaces: a sync blind to archived rows mirrors the ticket back in as a
// brand-new card, and everything above is stranded on a row nobody can see.
check(
  'and there is exactly ONE card for the ticket, not the old one plus a fresh copy',
  raw.prepare('SELECT COUNT(*) AS n FROM tasks WHERE externalKey = ?').get(TICKET).n === 1,
  String(raw.prepare('SELECT COUNT(*) AS n FROM tasks WHERE externalKey = ?').get(TICKET).n),
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
