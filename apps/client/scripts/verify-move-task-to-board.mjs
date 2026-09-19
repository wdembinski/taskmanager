/**
 * Headless verification for `store.moveTaskToBoard` (plan step 2 of "moving tasks between
 * boards") and for the `task:setBoard` IPC handler's guards (step 3) built on top of it.
 *
 * `store.ts` has no automated coverage at all under `vitest`: every store method needs a
 * real `better-sqlite3`, whose native addon is built for Electron's ABI, not the Node that
 * runs the test suite (a plain `require('better-sqlite3')` under `vitest run` fails with
 * `ERR_DLOPEN_FAILED` / a NODE_MODULE_VERSION mismatch — confirmed while writing this
 * script). So, exactly like `verify-tickets.mjs` and `verify-connections.mjs`, this drives
 * `createStore` directly under `ELECTRON_RUN_AS_NODE`, against a scratch database, and never
 * opens, reads or writes the real profile (RELEASE.md rule 6 — the app itself is never
 * launched).
 *
 * Section 5 mirrors `task:setBoard` from `ipc.ts` — its guards, its `store.moveTaskToBoard`
 * call and its two `send`s — the same shape `verify-jira-move.mjs` uses for `task:move`:
 * `ipc.ts` has no test file (`registerIpcHandlers` builds its own store from
 * `app.getPath('userData')`, a real `BrowserWindow`, pollers and git clients — out of reach
 * for a harness like this one), so the handler is copied here line for line rather than
 * restated as a second guess of its own rules. Assertions are on what the REAL store did in
 * response, never on the mirror's own wording.
 *
 * Section 6 mirrors `board:scopes` (plan step 4, "list every project as a board") the same
 * way — Personal first, then every OTHER project, `ownsBoard` no longer filtering any of
 * them out. It runs last so it can assert on the plan-driven and keyless projects sections
 * 1-5 already created: before this step those were exactly the two kinds `ownsBoard` used to
 * drop, so their presence here is the regression this section exists to catch.
 *
 *   pnpm exec node scripts/verify-move-task-to-board.mjs
 *
 * Exits non-zero on the first failed assertion, naming it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** `@shared` for the packages/shared workspace package. */
const sharedSrc = join(repo, '..', '..', 'packages', 'shared', 'src');

/**
 * Everything this script writes lives here, INSIDE the app package: the bundle keeps
 * `better-sqlite3` external, so Node's resolution needs `node_modules` on the path, which
 * means the scratch dir has to sit somewhere that walk reaches. Removed on the way out, and
 * on the way in — a crashed previous run must not leak into this one.
 */
const work = join(repo, '.verify-move-task-to-board');

const electronBin = join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
const electronBinPosix = join(repo, 'node_modules', 'electron', 'dist', 'electron');

function log(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * `protocol` and `app` are imported transitively by nothing on this path — `store.ts` itself
 * never touches Electron — but the stub is kept anyway, exactly as `verify-tickets.mjs` keeps
 * it, so a future import that DOES reach one of these fails loudly here instead of quietly
 * verifying a stub.
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

/** Bundle the scenario file to a runnable ESM module. */
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
    // The ABI the whole exercise depends on. Checked first and by itself, exactly as
    // `verify-tickets.mjs` checks it — every scenario below fails identically and
    // unhelpfully when this is wrong.
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
    const entry = join(work, 'entry.ts');
    writeFileSync(
      entry,
      SCENARIOS.replaceAll('__SCRATCH__', scratch).replaceAll('__REPO__', repo.replace(/\\/g, '/')),
      'utf8',
    );
    log('\nRunning the moveTaskToBoard scenarios against the real store...');
    runUnderElectron(await bundle(entry, join(work, 'out')));

    log('\nAll scenarios passed.');
  } finally {
    if (process.argv.includes('--keep')) log(`\nLeft ${work} in place (--keep).`);
    else rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
}

/**
 * The scenarios, as a template so the paths are baked in rather than passed — a bundle takes
 * no argv worth threading, and every path in it is scratch.
 *
 * NO BACKTICKS below: this is a `String.raw` template, and one inside a comment closes it with
 * a SyntaxError pointing at a word in prose. `${}` still interpolates in `String.raw` too.
 */
const SCENARIOS = String.raw`
import { mkdirSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createStore } from '__REPO__/src/main/store';
import { PERSONAL_PROJECT_ID, hasPlan } from '@shared/model';

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
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

const dbPath = scratch + '/orchestrator.db';
const store = createStore(dbPath);
const raw = new Database(dbPath);
raw.pragma('foreign_keys = ON');

/** Seed one task_events row and one task_activity row for a task, on its CURRENT project. */
function seedHistory(projectId, taskId) {
  store.appendTaskEvent(projectId, taskId, 'run-1', { type: 'system', subtype: 'init' });
  store.addComment(projectId, taskId, 'a note written before the move');
}

function eventsProjectIds(taskId) {
  return raw.prepare('SELECT projectId FROM task_events WHERE taskId = ?').all(taskId).map((r) => r.projectId);
}
function activityProjectIds(taskId) {
  return raw.prepare('SELECT projectId FROM task_activity WHERE taskId = ?').all(taskId).map((r) => r.projectId);
}

// ---------------------------------------------------------------------------
section('1. adhoc -> a ticket-owning board: allocates a dest-prefixed key, source becomes ticket');

const destA = store.addProject({ path: '', kind: 'ticket', ticketPrefix: 'DA', name: 'dest A' });
// Give the destination a head start so the allocated number is provably its OWN next, not 1
// by coincidence.
store.createTicket(destA.id, { title: 'already on dest A, #1' });
store.createTicket(destA.id, { title: 'already on dest A, #2' });

const adhoc = store.createTask(PERSONAL_PROJECT_ID, { title: 'a plain card' });
check('the source card starts as adhoc, unkeyed', adhoc.source === 'adhoc' && !adhoc.ticketKey);
seedHistory(PERSONAL_PROJECT_ID, adhoc.id);

const destABoardCountBefore = store.getBoardTasks(destA.id).length;
const moved1 = store.moveTaskToBoard(adhoc.id, destA.id);
check('the move returns the updated task', Boolean(moved1));
check('the card now lives on the destination project', moved1.projectId === destA.id);
check(
  'it was allocated a DA-prefixed key as ticket #3 (after DA-1 and DA-2)',
  moved1.ticketKey === 'DA-3' && moved1.ticketNumber === 3,
  moved1.ticketKey + ' / ' + moved1.ticketNumber,
);
check("its source became 'ticket'", moved1.source === 'ticket');
check(
  "'order' is the destination's own next order",
  moved1.order === destABoardCountBefore,
  String(moved1.order),
);
check('epicTaskId is null (it had none to begin with)', moved1.epicTaskId === null);
check('milestoneId is null (it had none to begin with)', moved1.milestoneId === null);
check('projectTagId follows the card to its new board', moved1.projectTagId === destA.id);
check(
  'its task_events row followed to the new project',
  eventsProjectIds(adhoc.id).every((id) => id === destA.id),
  JSON.stringify(eventsProjectIds(adhoc.id)),
);
check(
  'its task_activity row followed to the new project',
  activityProjectIds(adhoc.id).every((id) => id === destA.id),
  JSON.stringify(activityProjectIds(adhoc.id)),
);

// ---------------------------------------------------------------------------
section('2. ticket board -> ticket board: re-keys off the DEST counter, never the old number');

const source = store.addProject({ path: '', kind: 'ticket', ticketPrefix: 'SRC', name: 'source board' });
const destB = store.addProject({ path: '', kind: 'ticket', ticketPrefix: 'DB', name: 'dest B' });

// Run the source project's counter well past the destination's, so a bug that kept the old
// NUMBER (rather than allocating a fresh one from the destination) is unmistakable.
for (let i = 1; i <= 4; i++) store.createTicket(source.id, { title: 'source filler ' + i });
const epic = store.createTicket(source.id, { title: 'an epic', issueType: 'epic' });
const milestone = store.addMilestone(source.id, { name: 'a milestone on the source board' });
const sourceTicket = store.createTicket(source.id, {
  title: 'the one that moves',
  epicTaskId: epic.id,
  milestoneId: milestone.id,
});
check(
  'the source ticket starts with a high number and both epic/milestone set',
  sourceTicket.ticketNumber === 6 &&
    sourceTicket.epicTaskId === epic.id &&
    sourceTicket.milestoneId === milestone.id,
  JSON.stringify(sourceTicket),
);

// Destination already has its own, independent, lower count.
store.createTicket(destB.id, { title: 'already on dest B' });

const moved2 = store.moveTaskToBoard(sourceTicket.id, destB.id);
check('the move returns the updated task', Boolean(moved2));
check(
  'it is re-keyed under DB, off DB\'s own counter (DB-2), never SRC\'s old number (6)',
  moved2.ticketKey === 'DB-2' && moved2.ticketNumber === 2,
  moved2.ticketKey + ' / ' + moved2.ticketNumber,
);
check("source stays 'ticket'", moved2.source === 'ticket');
check('epicTaskId is nulled (the epic belongs to the SOURCE board)', moved2.epicTaskId === null);
check('milestoneId is nulled (the milestone belongs to the SOURCE board)', moved2.milestoneId === null);
check('projectTagId follows the card to its new board', moved2.projectTagId === destB.id);

const destBSeqAfter = raw.prepare('SELECT ticketSeq FROM projects WHERE id = ?').get(destB.id);
check("dest B's own allocator advanced by exactly one", destBSeqAfter.ticketSeq === 2);
const srcSeqAfter = raw.prepare('SELECT ticketSeq FROM projects WHERE id = ?').get(source.id);
check("the source board's allocator is untouched by the move", srcSeqAfter.ticketSeq === 6);

// ---------------------------------------------------------------------------
section('3. -> Personal or a keyless board: the key freezes');

const source2 = store.addProject({ path: '', kind: 'ticket', ticketPrefix: 'FRZ', name: 'freeze source' });
const frozenTicket = store.createTicket(source2.id, { title: 'moving to Personal' });
check('it starts with a real FRZ key', frozenTicket.ticketKey === 'FRZ-1');
seedHistory(source2.id, frozenTicket.id);

const movedToPersonal = store.moveTaskToBoard(frozenTicket.id, PERSONAL_PROJECT_ID);
check('the move returns the updated task', Boolean(movedToPersonal));
check('the card now lives on Personal', movedToPersonal.projectId === PERSONAL_PROJECT_ID);
check(
  'its ticketKey/ticketNumber are FROZEN — unchanged by a destination with no allocator',
  movedToPersonal.ticketKey === 'FRZ-1' && movedToPersonal.ticketNumber === 1,
  movedToPersonal.ticketKey + ' / ' + movedToPersonal.ticketNumber,
);
check("source stays 'ticket' — freezing means untouched, not downgraded", movedToPersonal.source === 'ticket');
check('projectTagId follows to Personal', movedToPersonal.projectTagId === PERSONAL_PROJECT_ID);
check(
  'its task_events row followed to Personal',
  eventsProjectIds(frozenTicket.id).every((id) => id === PERSONAL_PROJECT_ID),
);
check(
  'its task_activity row followed to Personal',
  activityProjectIds(frozenTicket.id).every((id) => id === PERSONAL_PROJECT_ID),
);

// A keyless board that is NOT Personal — a plan-less project that opted out of the
// guaranteed-prefix backfill (\`personal: true\` on create) — freezes exactly the same way.
const keylessBoard = store.addProject({ path: '', name: 'a keyless board', personal: true });
check('the keyless board really has no prefix', keylessBoard.ticketPrefix === '');

const source3 = store.addProject({ path: '', kind: 'ticket', ticketPrefix: 'FRZ2', name: 'freeze source 2' });
const anotherFrozenTicket = store.createTicket(source3.id, { title: 'moving to a keyless board' });
const movedToKeyless = store.moveTaskToBoard(anotherFrozenTicket.id, keylessBoard.id);
check(
  'moving onto a keyless (non-Personal) board freezes the key the same way',
  movedToKeyless.ticketKey === 'FRZ2-1' &&
    movedToKeyless.ticketNumber === 1 &&
    movedToKeyless.projectId === keylessBoard.id &&
    movedToKeyless.projectTagId === keylessBoard.id,
  JSON.stringify(movedToKeyless),
);

const adhocToKeyless = store.createTask(PERSONAL_PROJECT_ID, { title: 'an adhoc card, staying keyless' });
const movedAdhocToKeyless = store.moveTaskToBoard(adhocToKeyless.id, keylessBoard.id);
check(
  'an adhoc card moved onto a keyless board stays keyless too — nothing to freeze but null',
  movedAdhocToKeyless.source === 'adhoc' &&
    movedAdhocToKeyless.ticketKey === null &&
    movedAdhocToKeyless.ticketNumber === null,
  JSON.stringify(movedAdhocToKeyless),
);

// ---------------------------------------------------------------------------
section('4. Missing task or destination refuses cleanly, never throws');

const liveProj = store.addProject({ path: '', kind: 'ticket', ticketPrefix: 'LIVE', name: 'live' });
const liveTicket = store.createTicket(liveProj.id, { title: 'stays put' });

let threwOnMissingDest = false;
let resultMissingDest;
try {
  resultMissingDest = store.moveTaskToBoard(liveTicket.id, 'does-not-exist');
} catch {
  threwOnMissingDest = true;
}
check('a missing destination project returns undefined rather than throwing', !threwOnMissingDest);
check('and the return value is literally undefined', resultMissingDest === undefined);

const liveTicketAfter = store.getTask(liveTicket.id);
check(
  'the card is completely untouched by the refused move',
  liveTicketAfter.projectId === liveProj.id && liveTicketAfter.ticketKey === liveTicket.ticketKey,
);

let threwOnMissingTask = false;
let resultMissingTask;
try {
  resultMissingTask = store.moveTaskToBoard('does-not-exist-either', liveProj.id);
} catch {
  threwOnMissingTask = true;
}
check('a missing task ALSO returns undefined rather than throwing', !threwOnMissingTask);
check('and its return value is literally undefined too', resultMissingTask === undefined);

// ---------------------------------------------------------------------------
section('5. task:setBoard (ipc.ts), mirrored — its guards, its move, its two sends');

/**
 * Copied line for line from the real \`handle('task:setBoard', ...)\` in ipc.ts, minus the
 * parts that need its closure (the real \`send\` becomes a push onto \`sent\` instead of an
 * IPC broadcast). If ipc.ts changes, this must be re-read against it.
 */
function setBoard(taskId, boardId, sent) {
  const existing = store.getTask(taskId);
  if (!existing) throw new Error('Task not found.');
  if (existing.status === 'running' || existing.status === 'waiting-input') {
    throw new Error('Stop the task before moving it to another board.');
  }
  const sourceProject = store.getProject(existing.projectId);
  if (sourceProject && hasPlan(sourceProject)) {
    throw new Error(
      "This card's board comes from its plan file — edit the plan to move it, not by hand.",
    );
  }
  if (existing.externalSource === 'jira' || existing.externalSource === 'github') {
    throw new Error(
      'This card is synced from ' +
        (existing.externalSource === 'jira' ? 'JIRA' : 'GitHub') +
        ' — set its Project field instead of moving the board directly; the sync follows that.',
    );
  }
  const dest = store.getProject(boardId);
  if (!dest) throw new Error('Unknown board.');
  if (boardId === existing.projectId) return existing;

  const task = store.moveTaskToBoard(taskId, boardId);
  if (!task) throw new Error('Task not found.');
  sent.push(['task:changed', { task, runId: null }]);
  sent.push([
    'project:tasksChanged',
    { projectId: existing.projectId, tasks: store.getTasks(existing.projectId) },
  ]);
  sent.push(['project:tasksChanged', { projectId: boardId, tasks: store.getTasks(boardId) }]);
  return task;
}

function throws(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

const destC = store.addProject({ path: '', kind: 'ticket', ticketPrefix: 'DC', name: 'dest C' });

// -- running-card refusal ----------------------------------------------------
const runningTask = store.createTask(PERSONAL_PROJECT_ID, { title: 'mid-run card' });
store.updateTask(runningTask.id, { status: 'running' });
let runningErr = throws(() => setBoard(runningTask.id, destC.id, []));
check(
  'a running card refuses the move',
  runningErr?.message === 'Stop the task before moving it to another board.',
  runningErr?.message,
);
check(
  'and a waiting-input card refuses it the same way',
  (() => {
    store.updateTask(runningTask.id, { status: 'waiting-input' });
    const err = throws(() => setBoard(runningTask.id, destC.id, []));
    return err?.message === 'Stop the task before moving it to another board.';
  })(),
);
check(
  'the refused card never moved',
  store.getTask(runningTask.id).projectId === PERSONAL_PROJECT_ID,
);

// -- plan refusal -------------------------------------------------------------
const planProject = store.addProject({ path: '', planPath: 'plan.md', name: 'a plan-driven board' });
check('the plan board really carries a plan file', hasPlan(planProject));
const planTask = store.createTask(planProject.id, { title: 'a plan-driven card' });
let planErr = throws(() => setBoard(planTask.id, destC.id, []));
check(
  'a card resting on a plan-driven board refuses the move',
  planErr?.message === "This card's board comes from its plan file — edit the plan to move it, not by hand.",
  planErr?.message,
);
check('and stays on its plan-driven board', store.getTask(planTask.id).projectId === planProject.id);

// -- jira / github refusals ---------------------------------------------------
const jiraTask = store.createTask(PERSONAL_PROJECT_ID, { title: 'a synced JIRA card' });
store.updateTask(jiraTask.id, { externalSource: 'jira', externalKey: 'AB-1' });
let jiraErr = throws(() => setBoard(jiraTask.id, destC.id, []));
check(
  'a JIRA-synced card refuses the move',
  jiraErr?.message ===
    'This card is synced from JIRA — set its Project field instead of moving the board directly; the sync follows that.',
  jiraErr?.message,
);

const githubTask = store.createTask(PERSONAL_PROJECT_ID, { title: 'a synced GitHub card' });
store.updateTask(githubTask.id, { externalSource: 'github', externalKey: 'octo/repo#1' });
let githubErr = throws(() => setBoard(githubTask.id, destC.id, []));
check(
  'a GitHub-synced card refuses the move',
  githubErr?.message ===
    'This card is synced from GitHub — set its Project field instead of moving the board directly; the sync follows that.',
  githubErr?.message,
);
check(
  'neither synced card moved',
  store.getTask(jiraTask.id).projectId === PERSONAL_PROJECT_ID &&
    store.getTask(githubTask.id).projectId === PERSONAL_PROJECT_ID,
);

// -- unknown destination refusal ----------------------------------------------
const plainTask = store.createTask(PERSONAL_PROJECT_ID, { title: 'moves cleanly' });
let unknownDestErr = throws(() => setBoard(plainTask.id, 'does-not-exist', []));
check(
  'an unknown destination is refused by the IPC guard, not left to the store\'s undefined',
  unknownDestErr?.message === 'Unknown board.',
  unknownDestErr?.message,
);

// -- both-board events emitted -------------------------------------------------
const sent = [];
const moved = setBoard(plainTask.id, destC.id, sent);
check('the move itself succeeded', moved.projectId === destC.id);
check('exactly three events were sent', sent.length === 3, JSON.stringify(sent.map((s) => s[0])));
check("the first is task:changed, carrying the moved task", sent[0][0] === 'task:changed' && sent[0][1].task.id === plainTask.id);
check(
  'the second is project:tasksChanged for the SOURCE board (Personal), which no longer lists the card',
  sent[1][0] === 'project:tasksChanged' &&
    sent[1][1].projectId === PERSONAL_PROJECT_ID &&
    !sent[1][1].tasks.some((t) => t.id === plainTask.id),
);
check(
  'the third is project:tasksChanged for the DESTINATION board, which now lists the card',
  sent[2][0] === 'project:tasksChanged' &&
    sent[2][1].projectId === destC.id &&
    sent[2][1].tasks.some((t) => t.id === plainTask.id),
);

// A move onto the card's own current board is a no-op: no store write, no events.
const noopSent = [];
const noopResult = setBoard(moved.id, destC.id, noopSent);
check('moving onto the board a card is already on is a no-op', noopResult.id === moved.id);
check('and sends nothing', noopSent.length === 0, JSON.stringify(noopSent));

// ---------------------------------------------------------------------------
section('6. board:scopes (ipc.ts), mirrored — Personal first, then every other project');

/** Copied line for line from the real \`handle('board:scopes', ...)\` in ipc.ts. */
function boardScopes() {
  const personal = store.getProject(PERSONAL_PROJECT_ID);
  const scopes = personal ? [{ id: personal.id, name: personal.name, color: personal.color }] : [];
  for (const project of store.listProjects()) {
    if (project.id === PERSONAL_PROJECT_ID) continue;
    scopes.push({ id: project.id, name: project.name, color: project.color });
  }
  return scopes;
}

const scopes = boardScopes();
const allProjects = store.listProjects();
check('Personal is first', scopes[0]?.id === PERSONAL_PROJECT_ID);
check(
  'Personal appears exactly once, never duplicated from listProjects()',
  scopes.filter((s) => s.id === PERSONAL_PROJECT_ID).length === 1,
);
check(
  'every project is a board now — one scope per project, nothing filtered out',
  scopes.length === allProjects.length,
  scopes.length + ' scopes vs ' + allProjects.length + ' projects',
);
check(
  'a plan-driven board (no ticket prefix) is included — ownsBoard used to drop it',
  scopes.some((s) => s.id === planProject.id),
);
check(
  'a keyless, non-plan board is included too — ownsBoard used to drop this one as well',
  scopes.some((s) => s.id === keylessBoard.id),
);
check(
  'a ticket-owning board (the pre-existing case) is still included',
  scopes.some((s) => s.id === destC.id),
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
