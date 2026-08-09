/**
 * Headless verification for `scripts/recover-deleted-tasks.mjs` — the scavenger that digs deleted
 * cards back out of an `orchestrator.db`.
 *
 * There is nothing here `vitest` could take over, and that is the whole point. Every claim being
 * made is a claim about the BYTES of a real SQLite file: that a card `deleteTask` removed is still
 * lying in the page it was deleted from, that its transcript, comments, steps, arrows and
 * attachment row are lying there with it, that the scan finds them through a `-wal` and equally
 * through a checkpointed main file, that files on disk with no row left are re-adopted, and — the
 * assertion that keeps the rest honest — that a database nothing was ever deleted from recovers
 * NOTHING. Asserting any of that against a mock would assert nothing at all.
 *
 * The app is NEVER launched (RELEASE.md rule 6 — there is no single-instance lock, and a second
 * instance killed a live session on 2026-08-02). The seed and the read-back drive `store.ts`
 * directly under `ELECTRON_RUN_AS_NODE`, against scratch databases under `.verify-recovery/`. It
 * never opens, reads or writes the real profile.
 *
 * The scavenger itself is run the way a person would run it: as a separate `node` process, over
 * argv, reading its JSON report back. That is deliberate — it is the only leg that proves the
 * script works under plain `node`, without Electron's ABI, which is its whole reason for parsing
 * the file format by hand. `--apply` then proves the other half: that when it DOES need a SQL
 * engine it finds one, by re-executing itself under the bundled Electron.
 *
 * How the Electron legs work, and why they are not simply `node` scripts: `store.ts` is TypeScript
 * with `@shared` aliases and an `electron` import in its dependency graph. So each scenario file is
 * bundled with Vite first (aliasing `electron` to a stub whose every symbol throws — a scenario
 * that somehow reached Electron must fail loudly rather than quietly verify a stub), then run under
 * Electron-as-Node so the addon's ABI matches the binary loading it.
 *
 *   pnpm exec node scripts/verify-recovery.mjs
 *
 * Exits non-zero naming every failed assertion.
 *
 * To confirm the harness can fail rather than merely pass: delete the `store.deleteTask(...)` line
 * in the seed and re-run. Sections 2 and 3 should collapse — nothing was deleted, so nothing is
 * there to find. (Section 4's "an untouched database recovers nothing" is the same control, run
 * the right way up, on every ordinary run.)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** `@shared` now lives in the packages/shared workspace package, not under this app. */
const sharedSrc = join(repo, '..', '..', 'packages', 'shared', 'src');
const scavenger = join(repo, 'scripts', 'recover-deleted-tasks.mjs');

/**
 * Everything this script writes lives here, INSIDE the repo rather than in the temp dir, for one
 * reason: the bundles keep `better-sqlite3` external, so they must sit somewhere Node's resolution
 * can still find `node_modules`. Removed on the way out, and on the way in — a crashed previous
 * run must not leak into this one.
 */
const work = join(repo, '.verify-recovery');

const electronBin = join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
const electronBinPosix = join(repo, 'node_modules', 'electron', 'dist', 'electron');

let failures = 0;

function log(message = '') {
  process.stdout.write(`${message}\n`);
}

function section(name) {
  log(`\n${name}`);
}

function check(label, condition, detail) {
  if (condition) {
    log(`  PASS  ${label}`);
  } else {
    failures += 1;
    log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

/**
 * Nothing on these paths calls into Electron: `store.ts` needs none of it, `attachments.ts` only
 * imports `protocol` for a handler this never registers, and `logMain`'s `app.getPath` already sits
 * inside a `try` that swallows the throw. Throwing rather than returning a plausible value is
 * deliberate — a scenario that ever does reach Electron must fail loudly here.
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

/** Bundle one scenario file to a runnable ESM module. */
async function bundle(entry, outDir) {
  const stub = join(work, 'electron-stub.mjs');
  writeFileSync(stub, ELECTRON_STUB, 'utf8');
  await build({
    configFile: false,
    logLevel: 'error',
    resolve: { alias: { '@shared': sharedSrc, electron: stub } },
    build: {
      ssr: entry,
      outDir,
      emptyOutDir: true,
      target: 'node20',
      minify: false,
      // The native addon must stay a real `import` resolved at run time — bundling a `.node` file
      // is exactly the mistake this whole ABI dance exists to avoid.
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

/**
 * Run the scavenger exactly as a person would: a separate `node` process, arguments over argv.
 *
 * `--force` on every call. The refusal it bypasses is tested on its own in section 5, and this
 * repository's own worktrees live under `%APPDATA%\claude-orchestrator`, so without it every
 * scenario here would be refused for a reason that has nothing to do with what it is testing.
 */
function scavenge(args, { expectStatus = 0 } = {}) {
  const result = spawnSync(process.execPath, [scavenger, ...args], { encoding: 'utf8' });
  if (result.status !== expectStatus) {
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`recover-deleted-tasks.mjs exited ${result.status}, expected ${expectStatus}`);
  }
  return result;
}

const readReport = (path) => JSON.parse(readFileSync(path, 'utf8'));

// ---------------------------------------------------------------------------

async function main() {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  try {
    // The ABI the whole exercise depends on. Checked first and by itself, because every scenario
    // below fails identically and unhelpfully when this is wrong (v0.25.0's Linux build shipped a
    // Node-22 addon against Electron 33 and every tab just said "Loading").
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

    const scratch = join(work, 'scratch').replace(/\\/g, '/');

    // Leg 1 — seed two profiles with the real store, and delete a card out of one of them.
    const seedEntry = join(work, 'entry-seed.ts');
    writeFileSync(
      seedEntry,
      SEED.replaceAll('__SCRATCH__', scratch).replaceAll('__REPO__', repo.replace(/\\/g, '/')),
      'utf8',
    );
    log('\nSeeding two boards and deleting a card out of one...');
    runUnderElectron(await bundle(seedEntry, join(work, 'out-seed')));
    const seeded = JSON.parse(readFileSync(join(scratch, 'seeded.json'), 'utf8'));

    // Leg 2 — the scavenger, under plain node, over three databases.
    log('\nScavenging (plain node, no Electron)...');
    const liveDb = `${scratch}/live/orchestrator.db`;
    const walDb = `${scratch}/live/before-close.db`;
    const cleanDb = `${scratch}/clean/orchestrator.db`;
    const reports = {};
    for (const [name, db] of Object.entries({ wal: walDb, checkpointed: liveDb, clean: cleanDb })) {
      const json = join(work, `report-${name}.json`);
      scavenge([db, '--force', '--json', json]);
      reports[name] = readReport(json);
    }

    assertReports(reports, seeded);

    // A `-shm` file means a process has the database open. Refusing then is the whole safety
    // story: reading a moving file gives a torn copy, and every write the app makes is another
    // chance to reuse the page the missing card is lying in.
    section('5. It refuses a database that looks live, until told twice');
    writeFileSync(`${cleanDb}-shm`, '', 'utf8');
    const refused = scavenge([cleanDb], { expectStatus: 2 });
    check('it exits 2 rather than reading it', true);
    check(
      'and says to quit the app first',
      refused.stdout.includes('QUIT THE APP FIRST'),
      refused.stdout.slice(0, 200),
    );
    check(
      'naming the -shm as the reason',
      refused.stdout.includes('-shm'),
      refused.stdout.slice(0, 200),
    );
    check('--force gets past it', scavenge([cleanDb, '--force']).status === 0);
    rmSync(`${cleanDb}-shm`, { force: true });

    // Leg 3 — put it back, then read it back through the store that will have to live with it.
    section('6. --apply puts the card and its history back');
    const applyJson = join(work, 'report-apply.json');
    const applied = scavenge([liveDb, '--force', '--apply', liveDb, '--json', applyJson]);
    check(
      'it re-executed itself under Electron for the SQL engine',
      applied.stdout.includes("built for Electron's ABI"),
      'no relaunch line in the output',
    );
    const applyReport = readReport(applyJson);
    check(
      'the transaction inserted the card',
      applyReport.applied && applyReport.applied.inserted.tasks >= 1,
      JSON.stringify(applyReport.applied?.inserted),
    );
    check('and a .bak was taken first', existsSync(`${liveDb}.bak`));

    const readEntry = join(work, 'entry-read.ts');
    writeFileSync(
      readEntry,
      READBACK.replaceAll('__SCRATCH__', scratch)
        .replaceAll('__REPO__', repo.replace(/\\/g, '/'))
        .replaceAll('__SEEDED__', JSON.stringify(seeded).replaceAll("'", "\\'")),
      'utf8',
    );
    runUnderElectron(await bundle(readEntry, join(work, 'out-read')));
    const readback = JSON.parse(readFileSync(join(scratch, 'readback.json'), 'utf8'));
    for (const [label, ok, detail] of readback.checks) check(label, ok, detail);

    section('7. Running --apply a second time changes nothing');
    const secondJson = join(work, 'report-apply-2.json');
    scavenge([liveDb, '--force', '--apply', liveDb, '--json', secondJson]);
    const second = readReport(secondJson);
    check(
      'nothing was inserted twice',
      Object.values(second.applied.inserted).every((n) => n === 0),
      JSON.stringify(second.applied.inserted),
    );

    log('');
    if (failures > 0) {
      log(`${failures} check(s) failed.`);
      process.exitCode = 1;
    } else {
      log('All scenarios passed.');
    }
  } finally {
    // `--keep` leaves the bundles and the scratch databases behind, which is the only way to open
    // one afterwards and see what a failing scenario actually wrote.
    if (process.argv.includes('--keep')) log(`\nLeft ${work} in place (--keep).`);
    else rmSync(work, { recursive: true, force: true });
  }
}

/** Everything the three read-only reports have to say, asserted here in the harness. */
function assertReports(reports, seeded) {
  for (const [name, report] of Object.entries(reports)) {
    section(`${name === 'clean' ? '4' : name === 'wal' ? '2' : '3'}. The ${name} database`);

    check(
      'the scan recognised every card that is still there',
      report.sanity.recognisedCards === report.sanity.liveCards,
      `${report.sanity.recognisedCards} of ${report.sanity.liveCards}`,
    );

    if (name === 'clean') {
      // The control. Nothing was ever deleted from this database, so a scan that reports a
      // recovered card here is matching noise, and every PASS above it means nothing.
      check('no cards were recovered', report.cards.length === 0, JSON.stringify(report.cards));
      check('no task rows at all', report.totals.tasks === 0, String(report.totals.tasks));
      check(
        'no transcript events',
        report.totals.task_events === 0,
        String(report.totals.task_events),
      );
      check(
        'no comments, links or attachment rows',
        report.totals.task_activity === 0 &&
          report.totals.task_links === 0 &&
          report.totals.task_attachments === 0,
        JSON.stringify(report.totals),
      );
      continue;
    }

    const card = report.cards.find((c) => c.id === seeded.doomedId);
    check(
      'the deleted card came back',
      Boolean(card),
      JSON.stringify(report.cards.map((c) => c.id)),
    );
    if (!card) continue;
    check('with its title', card.title === seeded.doomedTitle, card.title);
    check('with its JIRA key', card.key === seeded.doomedKey, String(card.key));
    check('with the status it had', card.status === seeded.doomedStatus, card.status);
    check('with its project', card.projectId === seeded.projectId, card.projectId);
    check(
      `with its ${seeded.eventCount} transcript event(s)`,
      card.events >= seeded.eventCount,
      String(card.events),
    );
    check(
      `with its ${seeded.commentCount} comment(s)/note(s)`,
      card.comments >= seeded.commentCount,
      String(card.comments),
    );
    check(
      `with its ${seeded.stepCount} step(s)`,
      card.steps >= seeded.stepCount,
      String(card.steps),
    );
    check('with the arrow drawn from it', card.links >= 1, String(card.links));
    check('with its attachment', card.attachments >= 1, String(card.attachments));
    check(
      'and the files on disk that had lost their row were re-adopted',
      report.adoptedAttachments >= 1,
      String(report.adoptedAttachments),
    );
    check(
      'the surviving cards were NOT reported as recovered',
      !report.cards.some((c) => seeded.survivorIds.includes(c.id)),
      JSON.stringify(report.cards.map((c) => c.id)),
    );
  }
}

/**
 * The seed, as a template so the paths are baked in rather than passed — a bundle takes no argv
 * worth threading, and every path in it is scratch.
 *
 * No backticks and no `${` below: `String.raw` still interpolates, so a template literal in here
 * would be evaluated by THIS file rather than by the scenario. Plain quotes and `+`.
 */
const SEED = String.raw`
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createStore } from '__REPO__/src/main/store';
import { addAttachments } from '__REPO__/src/main/attachments';
import { attachmentDir } from '__REPO__/src/main/attachmentPaths';

const scratch = '__SCRATCH__';
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch + '/live', { recursive: true });
mkdirSync(scratch + '/clean', { recursive: true });
mkdirSync(scratch + '/sources', { recursive: true });

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
writeFileSync(scratch + '/sources/shot.png', PNG);

const EVENTS = 4;
const COMMENTS = 3;
const STEPS = 2;
const TITLE = 'the card that vanished from the board';
const KEY = 'ABC-123';
const STATUS = 'in-progress';

/**
 * One board: a project, cards that stay, and one card carrying every kind of history a deleted
 * card takes with it — a transcript, comments, steps, an arrow and an attachment.
 *
 * Deliberately more than one card. A page with a single row on it empties completely and goes to
 * the free list untouched, which is the EASY case; a card deleted from a page its neighbours still
 * live on is the one where SQLite writes a free-block header over the front of the cell, and that
 * is the case the scan's second anchor exists for.
 */
async function seed(root) {
  const dbPath = root + '/orchestrator.db';
  const store = createStore(dbPath);
  const project = store.addProject({ path: 'C:/repo/demo', name: 'demo' });
  const survivors = [];
  for (let i = 0; i < 6; i += 1) {
    const card = store.createTask(project.id, { title: 'a card that stays ' + i });
    store.addComment(project.id, card.id, 'a note on a card that stays');
    store.appendTaskEvent(project.id, card.id, 'run-stays-' + i, { type: 'assistant', text: 'ok' });
    survivors.push(card.id);
  }

  const doomed = store.createTask(project.id, { title: TITLE });
  for (let i = 0; i < EVENTS; i += 1) {
    store.appendTaskEvent(project.id, doomed.id, 'run-1', {
      type: 'assistant',
      text: 'the agent said something worth keeping, number ' + i,
    });
  }
  for (let i = 0; i < COMMENTS; i += 1) {
    store.addComment(project.id, doomed.id, 'a comment a human typed, number ' + i);
  }
  const steps = [];
  for (let i = 0; i < STEPS; i += 1) {
    steps.push(store.addSubtask(doomed.id, { title: 'step number ' + i }));
  }
  store.addTaskLink(doomed.id, survivors[0], 'after-merge');
  await addAttachments(store, root, doomed.id, [scratch + '/sources/shot.png']);

  // The tracker fields the report prints, written straight in: upsertJiraTask wants a whole issue
  // built from a live JIRA response, and the only parts that matter here are the key and a status
  // that is not the default, so the report has something to be right or wrong about.
  const raw = new Database(dbPath);
  raw
    .prepare(
      'UPDATE tasks SET externalSource = ?, externalKey = ?, externalId = ?, status = ? WHERE id = ?',
    )
    .run('jira', KEY, '10001', STATUS, doomed.id);
  raw.close();

  return { store, project, doomed, steps, survivors };
}

// --- the profile a card is deleted out of --------------------------------------------------
const live = await seed(scratch + '/live');

// Files with no row at all, of the kind a cascade leaves behind: the bytes live on disk, where no
// foreign key reaches them, so a card whose rows are gone still has its files.
const stranded = attachmentDir(scratch + '/live', 'a-card-whose-rows-are-gone');
mkdirSync(stranded, { recursive: true });
writeFileSync(join(stranded, 'evidence.png'), PNG);

live.store.deleteTask(live.doomed.id);

// A copy taken while the connection is still open, so its -wal still holds the page images from
// before the delete. The other half of the test is the same database after close(), which
// checkpoints the WAL away and leaves only the free space inside the main file.
copyFileSync(scratch + '/live/orchestrator.db', scratch + '/live/before-close.db');
copyFileSync(scratch + '/live/orchestrator.db-wal', scratch + '/live/before-close.db-wal');
live.store.close();

// --- the control: the same board, with nothing deleted --------------------------------------
const clean = await seed(scratch + '/clean');
clean.store.close();

writeFileSync(
  scratch + '/seeded.json',
  JSON.stringify(
    {
      projectId: live.project.id,
      doomedId: live.doomed.id,
      doomedTitle: TITLE,
      doomedKey: KEY,
      doomedStatus: STATUS,
      stepIds: live.steps.map((s) => s.id),
      survivorIds: live.survivors,
      eventCount: EVENTS,
      commentCount: COMMENTS,
      stepCount: STEPS,
    },
    null,
    2,
  ),
  'utf8',
);
console.log('  seeded: card ' + live.doomed.id + ' deleted out of a board of 7');
`;

/**
 * The read-back, after `--apply`: does the store the app actually uses see the card again?
 *
 * The recovery is only worth anything if `createStore` opens the result and hands back a card with
 * its transcript, its comments, its steps, its arrow and its attachment. Nothing below reaches into
 * SQL — it asks the same methods the board asks.
 */
const READBACK = String.raw`
import { writeFileSync } from 'node:fs';
import { createStore } from '__REPO__/src/main/store';

const scratch = '__SCRATCH__';
const seeded = JSON.parse('__SEEDED__');
const checks = [];
const check = (label, ok, detail) => checks.push([label, Boolean(ok), detail]);

const store = createStore(scratch + '/live/orchestrator.db');
const card = store.getTask(seeded.doomedId);
check('the store hands the card back by its original id', Boolean(card), 'undefined');
if (card) {
  check('with its title', card.title === seeded.doomedTitle, card.title);
  check('with its JIRA key', card.externalKey === seeded.doomedKey, String(card.externalKey));
  check('with the status it had', card.status === seeded.doomedStatus, card.status);
  check('filed under its project', card.projectId === seeded.projectId, card.projectId);
}
check(
  'its transcript is there, in full',
  store.getTaskHistory(seeded.doomedId).length >= seeded.eventCount,
  String(store.getTaskHistory(seeded.doomedId).length),
);
check(
  'its comments are there',
  store.getTaskActivity(seeded.doomedId).filter((e) => e.kind === 'comment').length >=
    seeded.commentCount,
  JSON.stringify(store.getTaskActivity(seeded.doomedId).map((e) => e.kind)),
);
check(
  'its steps hang off it again',
  store.getSubtasks(seeded.doomedId).length >= seeded.stepCount,
  String(store.getSubtasks(seeded.doomedId).length),
);
check(
  'the arrow drawn from it is back',
  store.listTaskLinks().some((l) => l.fromTaskId === seeded.doomedId),
  JSON.stringify(store.listTaskLinks()),
);
const files = store.attachmentsForTask(seeded.doomedId);
check('its attachment is described again', files.length >= 1, String(files.length));
check(
  'and the row points at a file that is still on disk',
  files.length >= 1 && files[0].size > 0,
  JSON.stringify(files),
);
// The other half of the attachment story: bytes whose row went with a cascade, re-adopted.
check(
  'the stranded files got rows of their own',
  store.attachmentsForTask('a-card-whose-rows-are-gone').length >= 1,
  String(store.attachmentsForTask('a-card-whose-rows-are-gone').length),
);
// Nothing was trampled on the way in.
check(
  'every card that never left is still there',
  seeded.survivorIds.every((id) => Boolean(store.getTask(id))),
  'a survivor went missing',
);
store.close();

writeFileSync(scratch + '/readback.json', JSON.stringify({ checks }, null, 2), 'utf8');
`;

await main();
