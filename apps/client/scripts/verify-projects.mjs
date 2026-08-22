/**
 * Headless verification for "one board for every project" — the half `vitest` cannot reach.
 *
 * The unit tests cover the pure predicates (`hasPlan`/`hasRepo`/`ownsTickets` in
 * `@shared/model`) against plain objects. What they cannot cover is the part that needs a
 * REAL `better-sqlite3`: a database written by the code BEFORE this branch dropped the
 * `kind` discriminator and opened with the code after, the key allocator's transaction, and
 * the union queries behind `getAllBoardTasks`/`getPersonalTasksForSync`. That code only
 * loads inside Electron's ABI, so it runs here rather than in the suite.
 *
 * The app is NEVER launched (RELEASE.md rule 6 — there is no single-instance lock, and a
 * second instance killed a live session on 2026-08-02). This drives the modules directly
 * under `ELECTRON_RUN_AS_NODE`, against scratch databases inside this repo. It never opens,
 * reads or writes the real profile.
 *
 * How it works, and why it is not simply a `node` script: `store.ts` is TypeScript with
 * `@shared` aliases. So each leg is bundled with Vite first (aliasing `electron` to a stub,
 * since nothing on this path calls it), then run under Electron-as-Node so the addon's ABI
 * matches the binary loading it. Same shape as `scripts/verify-attachments.mjs`, whose
 * comments explain the ABI dance at greater length.
 *
 * The migration leg is a real downgrade rather than a hand-cut schema: `development` (this
 * branch's base — see `git merge-base development HEAD`) is extracted whole with
 * `git archive`, and ITS `createStore` writes a database the way a project/task looked
 * before `kind` stopped being read. The current code then opens it. A schema built by
 * today's code minus one column would prove nothing about the migration.
 *
 *   pnpm exec node scripts/verify-projects.mjs
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
/** apps/client — where this script's own node_modules (electron, better-sqlite3) live. */
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The monorepo root — where `git archive` has to run from to reach both workspaces. */
const repoRoot = resolve(appDir, '..', '..');
const sharedSrc = join(repoRoot, 'packages', 'shared', 'src');

/**
 * Everything this script writes lives here, INSIDE `apps/client`, for one reason: the
 * bundles keep `better-sqlite3` external, so they must sit somewhere Node's resolution can
 * still find `node_modules`. Removed on the way out, and on the way in — a crashed previous
 * run must not leak into this one.
 */
const work = join(appDir, '.verify-projects');

/** This branch's base — the pre-refactor state `kind: 'plan'`/`'agent'` rows come from. */
const OLD_REF = 'development';

const electronBin = join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const electronBinPosix = join(appDir, 'node_modules', 'electron', 'dist', 'electron');

function log(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * Nothing under test calls Electron on this path, so every symbol throws rather than
 * returning a plausible value: if a scenario ever does reach it, the run must fail loudly
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
  // scenario below fails identically and unhelpfully when this is wrong.
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

  // `${OLD_REF}`'s tree, extracted whole — both workspaces it takes to run `store.ts`, so
  // the old code sees the old `@shared/model` (with `kind`/`ProjectKind`) rather than
  // today's. `git archive` rather than a checkout: this worktree is shared by every step
  // of the plan and must not move off its branch.
  const oldRoot = join(work, 'old');
  mkdirSync(oldRoot, { recursive: true });
  const tar = execFileSync(
    'git',
    ['archive', '--format=tar', OLD_REF, 'apps/client/src', 'packages/shared/src'],
    { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' },
  );
  // Both the archive and the extraction are RELATIVE, run from `oldRoot`: tar reads a
  // leading `C:\` as a remote host ("Cannot connect to C: resolve failed"), so no absolute
  // Windows path can be handed to it.
  writeFileSync(join(oldRoot, 'old.tar'), tar);
  execFileSync('tar', ['-xf', 'old.tar'], { cwd: oldRoot });
  const oldStoreSrc = join(oldRoot, 'apps', 'client', 'src', 'main', 'store');
  const oldSharedSrc = join(oldRoot, 'packages', 'shared', 'src');
  if (!existsSync(`${oldStoreSrc}.ts`)) {
    throw new Error(`Could not extract ${OLD_REF}'s store.ts`);
  }
  log(`Extracted ${OLD_REF} for the migration leg`);

  const scratch = join(work, 'scratch').replace(/\\/g, '/');
  const oldDb = `${scratch}/old-profile/orchestrator.db`;

  // Leg 1 — the OLD code writes a database with a 'plan' project and an 'agent' project,
  // the two shapes the `kind` column used to discriminate.
  const oldEntry = join(work, 'entry-old.ts');
  writeFileSync(
    oldEntry,
    OLD_LEG.replaceAll('__SCRATCH__', scratch).replaceAll(
      '__OLD_STORE__',
      oldStoreSrc.replace(/\\/g, '/'),
    ),
    'utf8',
  );
  log(`\nWriting a ${OLD_REF} database with ${OLD_REF}'s own code...`);
  runUnderElectron(await bundle(oldEntry, join(work, 'out-old'), oldSharedSrc));

  // Leg 2 — the CURRENT code, against the old database and against fresh profiles.
  const newEntry = join(work, 'entry-new.ts');
  writeFileSync(
    newEntry,
    SCENARIOS.replaceAll('__SCRATCH__', scratch)
      .replaceAll('__OLD_DB__', oldDb)
      .replaceAll('__REPO__', appDir.replace(/\\/g, '/'))
      .replaceAll('__OLD_REF__', OLD_REF),
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
 * The OLD leg: two projects in the shapes `kind` used to name, plus a task on each, plus
 * a raw-SQL mutation that blanks the plan project's `planPath` — reproducing the exact
 * anomaly the current migration's backfill exists for (a real directory, no plan file on
 * record). The ids it minted are written to disk for the new leg to compare against.
 */
const OLD_LEG = String.raw`
import { mkdirSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createStore } from '__OLD_STORE__';

const scratch = '__SCRATCH__';
mkdirSync(scratch + '/old-profile', { recursive: true });
const dbPath = scratch + '/old-profile/orchestrator.db';
const store = createStore(dbPath);

const planProject = store.addProject({
  path: 'C:/repo/legacy-plan',
  name: 'legacy-plan',
  kind: 'plan',
});
const planTask = store.createTask(planProject.id, { title: 'a plan card from before' });
if (!planTask) throw new Error('old store refused the plan card');

const agentProject = store.addProject({
  path: 'C:/repo/legacy-agent',
  name: 'legacy-agent',
  kind: 'agent',
  jiraEpicKeys: ['EPIC-1', 'EPIC-2'],
});
const agentTask = store.createTask(agentProject.id, { title: 'an agent card from before' });
if (!agentTask) throw new Error('old store refused the agent card');

// Two genuinely PLAN-LESS, non-Personal projects — the other shape this branch's
// guaranteed-prefix backfill (step 2 of this plan) exists for. planPath is set
// explicitly to '': __OLD_REF__'s own addProject defaults a plan path from path alone
// (see the comment above it), so a project with a real directory and no override would
// come out plan-driven, not board-driven — the same trap 'legacy-boardish' avoids in
// verify-tickets.mjs. Two of them, so the backfill can be shown to hand out DISTINCT
// prefixes rather than just A prefix.
const boardProjectA = store.addProject({
  path: 'C:/repo/legacy-board-a',
  name: 'legacy-board-a',
  kind: 'agent',
  planPath: '',
});
const boardTaskA = store.createTask(boardProjectA.id, { title: 'a board card from before (A)' });
if (!boardTaskA) throw new Error('old store refused board card A');

const boardProjectB = store.addProject({
  path: 'C:/repo/legacy-board-b',
  name: 'legacy-board-b',
  kind: 'agent',
  planPath: '',
});
const boardTaskB = store.createTask(boardProjectB.id, { title: 'a board card from before (B)' });
if (!boardTaskB) throw new Error('old store refused board card B');

store.close();

// The anomaly the migration's backfill exists for: a real directory, but a blank planPath
// on record (e.g. hand-edited, or a build that predates the default). Done as raw SQL so
// it is independent of whatever the old addProject happened to default.
const raw = new Database(dbPath);
raw.prepare('UPDATE projects SET planPath = ? WHERE id = ?').run('', planProject.id);
raw.close();

writeFileSync(
  scratch + '/old-ids.json',
  JSON.stringify({
    planProjectId: planProject.id,
    planTaskId: planTask.id,
    agentProjectId: agentProject.id,
    agentTaskId: agentTask.id,
    boardProjectAId: boardProjectA.id,
    boardTaskAId: boardTaskA.id,
    boardProjectBId: boardProjectB.id,
    boardTaskBId: boardTaskB.id,
  }),
);
console.log(
  '  wrote an __OLD_REF__ database: plan project ' +
    planProject.id +
    ', agent project ' +
    agentProject.id +
    ', board project A ' +
    boardProjectA.id +
    ', board project B ' +
    boardProjectB.id,
);
`;

/**
 * The scenarios themselves, as a template so the paths are baked in rather than passed —
 * a bundle takes no argv worth threading, and every path in it is scratch or this repo.
 */
const SCENARIOS = String.raw`
import { mkdirSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { PERSONAL_PROJECT_ID, hasPlan, hasRepo, ownsTickets } from '@shared/model';
import { createStore } from '__REPO__/src/main/store';
import { buildAgentTaskPrompt } from '__REPO__/src/main/agentTaskPrompt';

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
const oldDb = '__OLD_DB__';

// ---------------------------------------------------------------------------
section('1. Migration from __OLD_REF__ is behaviour-preserving');

const ids = JSON.parse(readFileSync(scratch + '/old-ids.json', 'utf8'));

const before = new Database(oldDb, { readonly: true });
const beforePlanPath = before
  .prepare('SELECT planPath FROM projects WHERE id = ?')
  .get(ids.planProjectId).planPath;
const beforeBoardAPlanPath = before
  .prepare('SELECT planPath, ticketPrefix FROM projects WHERE id = ?')
  .get(ids.boardProjectAId);
const beforeBoardBPlanPath = before
  .prepare('SELECT planPath, ticketPrefix FROM projects WHERE id = ?')
  .get(ids.boardProjectBId);
before.close();
check(
  'the __OLD_REF__ database genuinely has the anomaly this backfill exists for',
  beforePlanPath === '',
  JSON.stringify(beforePlanPath),
);
check(
  'and both board projects genuinely have no plan and no ticket prefix either — the other ' +
    "anomaly this step's migration proof exists for",
  beforeBoardAPlanPath.planPath === '' &&
    (beforeBoardAPlanPath.ticketPrefix === '' || beforeBoardAPlanPath.ticketPrefix === null) &&
    beforeBoardBPlanPath.planPath === '' &&
    (beforeBoardBPlanPath.ticketPrefix === '' || beforeBoardBPlanPath.ticketPrefix === null),
  JSON.stringify({ boardA: beforeBoardAPlanPath, boardB: beforeBoardBPlanPath }),
);

const migrated = createStore(oldDb);

const planProject = migrated.getProject(ids.planProjectId);
check('the plan project survived the open, same id', Boolean(planProject) && planProject.id === ids.planProjectId);
check(
  'and still has a watched plan path — the backfill caught the blank one',
  Boolean(planProject) && planProject.planPath !== '' && hasPlan(planProject),
  planProject && planProject.planPath,
);
check(
  "the backfilled path is under the project's own directory",
  Boolean(planProject) && planProject.planPath.includes('legacy-plan'),
  planProject && planProject.planPath,
);

const planTask = migrated.getTask(ids.planTaskId);
check(
  "the plan project's card kept its id and title",
  Boolean(planTask) && planTask.id === ids.planTaskId && planTask.title === 'a plan card from before',
);

const agentProject = migrated.getProject(ids.agentProjectId);
check('the agent project survived the open, same id', Boolean(agentProject) && agentProject.id === ids.agentProjectId);
check(
  'and still has its repo and its epics — read from fields, no kind column involved',
  Boolean(agentProject) &&
    hasRepo(agentProject) &&
    agentProject.path === 'C:/repo/legacy-agent' &&
    agentProject.jiraEpicKeys.join(',') === 'EPIC-1,EPIC-2',
  agentProject && JSON.stringify({ path: agentProject.path, epics: agentProject.jiraEpicKeys }),
);

const agentTask = migrated.getTask(ids.agentTaskId);
check(
  "the agent project's card kept its id and title too",
  Boolean(agentTask) && agentTask.id === ids.agentTaskId && agentTask.title === 'an agent card from before',
);

// The migration proof for step 2 of this plan (guaranteeing every board project a key
// prefix): opening a real pre-prefix database with today's store must backfill every
// plan-less, non-Personal project a DISTINCT prefix, leave every plan project's prefix
// alone (both 'legacy-plan' above and the plan-driven 'legacy-agent', which — despite its
// __OLD_REF__ kind of 'agent' — got a real directory and so a real plan path defaulted
// onto it by __OLD_REF__'s own addProject, exactly like the plan project did), and let
// createTicket succeed on a plan-less project where the __OLD_REF__ build refused it
// outright.
check(
  "the plan-driven 'legacy-agent' project kept NO prefix — the guarantee is board-only, " +
    'and this one has a plan whether or not its old kind said agent',
  Boolean(agentProject) && hasPlan(agentProject) && agentProject.ticketPrefix === '',
  agentProject && JSON.stringify({ planPath: agentProject.planPath, prefix: agentProject.ticketPrefix }),
);
check(
  'the plan project kept NO prefix at all either',
  Boolean(planProject) && planProject.ticketPrefix === '',
  planProject && planProject.ticketPrefix,
);

const boardProjectA = migrated.getProject(ids.boardProjectAId);
check(
  'board project A survived the open, same id, genuinely plan-less',
  Boolean(boardProjectA) && boardProjectA.id === ids.boardProjectAId && !hasPlan(boardProjectA),
);
check(
  'and it was backfilled a real prefix',
  Boolean(boardProjectA) && Boolean(boardProjectA.ticketPrefix),
  boardProjectA && boardProjectA.ticketPrefix,
);

const boardProjectB = migrated.getProject(ids.boardProjectBId);
check(
  'board project B survived the open, same id, genuinely plan-less',
  Boolean(boardProjectB) && boardProjectB.id === ids.boardProjectBId && !hasPlan(boardProjectB),
);
check(
  'and it too was backfilled a real prefix',
  Boolean(boardProjectB) && Boolean(boardProjectB.ticketPrefix),
  boardProjectB && boardProjectB.ticketPrefix,
);
check(
  'the two plan-less projects were handed DISTINCT prefixes, not a collision',
  Boolean(boardProjectA) &&
    Boolean(boardProjectB) &&
    boardProjectA.ticketPrefix !== boardProjectB.ticketPrefix,
  JSON.stringify({
    boardA: boardProjectA && boardProjectA.ticketPrefix,
    boardB: boardProjectB && boardProjectB.ticketPrefix,
  }),
);

const ticketOnBoardA = migrated.createTicket(ids.boardProjectAId, {
  title: 'a ticket the __OLD_REF__ build would have refused',
});
check(
  'createTicket now succeeds on a migrated board project that used to refuse every ticket',
  Boolean(ticketOnBoardA) && ticketOnBoardA.ticketKey === boardProjectA.ticketPrefix + '-1',
  ticketOnBoardA && ticketOnBoardA.ticketKey,
);

migrated.close();

// ---------------------------------------------------------------------------
section('2. A project created with no folder is legal');

mkdirSync(scratch + '/fresh', { recursive: true });
const store = createStore(scratch + '/fresh/orchestrator.db');

const noFolder = store.addProject({ name: 'no folder project' });
check('path defaults to empty, not thrown', noFolder.path === '');
check("planPath is empty — nothing to default it against", noFolder.planPath === '');
check('hasRepo is false for it', !hasRepo(noFolder));
check('hasPlan is false for it too, so it belongs on the board, not a queue', !hasPlan(noFolder));

// ---------------------------------------------------------------------------
section('3. Key allocation: TM-1..TM-50, no gaps, no re-issue');

const tracker = store.addProject({ name: 'Tracker', ticketPrefix: 'TM' });
check('the prefix normalized to TM', tracker.ticketPrefix === 'TM');

const tickets = [];
for (let i = 1; i <= 50; i++) {
  const t = store.createTicket(tracker.id, { title: 'ticket ' + i });
  if (!t) throw new Error('refused ticket ' + i + ' — cannot continue the allocation scenario');
  tickets.push(t);
}
const expectedKeys = Array.from({ length: 50 }, (_, i) => 'TM-' + (i + 1)).join(',');
check(
  'fifty tickets came back as TM-1..TM-50, in order, no gaps',
  tickets.map((t) => t.ticketKey).join(',') === expectedKeys,
  tickets.map((t) => t.ticketKey).join(','),
);

const tm25 = tickets[24];
store.deleteTask(tm25.id);
const afterDelete = store.createTicket(tracker.id, { title: 'ticket 51' });
check(
  'deleting TM-25 does not make the next ticket TM-25 again',
  Boolean(afterDelete) && afterDelete.ticketKey === 'TM-51',
  afterDelete && afterDelete.ticketKey,
);

const refused = store.createTicket(tracker.id, { title: '   ' });
check('a blank title is refused', refused === undefined);
const afterRefusal = store.createTicket(tracker.id, { title: 'ticket 52' });
check(
  'and the refusal did not burn a number — the next one is still TM-52',
  Boolean(afterRefusal) && afterRefusal.ticketKey === 'TM-52',
  afterRefusal && afterRefusal.ticketKey,
);

const otherPrefix = store.addProject({ name: 'Other Tracker', ticketPrefix: 'OTH' });
check('a genuinely different prefix is fine', otherPrefix.ticketPrefix === 'OTH');

let duplicateThrew = false;
try {
  store.addProject({ name: 'Duplicate Tracker', ticketPrefix: 'tm' });
} catch {
  duplicateThrew = true;
}
check(
  'the same prefix in a different case is refused, case-blind',
  duplicateThrew,
);
check(
  'and the refusal left the real Tracker as the only holder of TM',
  store.listProjects().filter((p) => p.ticketPrefix === 'TM').length === 1,
);

// ---------------------------------------------------------------------------
section('4. getAllBoardTasks and getPersonalTasksForSync');

const personalCard = store.createTask(PERSONAL_PROJECT_ID, { title: 'a personal card' });
if (!personalCard) throw new Error('refused the personal card');

// planPath explicitly '' — otherwise addProject defaults one from the path, and this
// would be a plan project rather than the plan-less bare repo the scenario needs.
const bareRepo = store.addProject({ path: scratch + '/bare-repo', name: 'bare repo', planPath: '' });
check('the bare repo really has no plan on record', !hasPlan(bareRepo));
const bareCard = store.createTask(bareRepo.id, { title: 'a bare-repo card' });
if (!bareCard) throw new Error('refused the bare-repo card');

const planQueue = store.addProject({ path: scratch + '/with-plan', name: 'with plan' });
const planCard = store.createTask(planQueue.id, { title: 'a plan-queue card' });
if (!planCard) throw new Error('refused the plan-queue card');
check('the plan project really has a plan file on record', hasPlan(planQueue));

const ticketCard = store.createTicket(tracker.id, { title: 'a native ticket' });
if (!ticketCard) throw new Error('refused the native ticket');

const board = store.getAllBoardTasks();
const onBoard = new Set(board.map((t) => t.id));
check('the Personal card is on the union board', onBoard.has(personalCard.id));
check("a plan-less project's card is on it too", onBoard.has(bareCard.id));
check("a ticket project's card is on it too — plan-less, same as any other", onBoard.has(ticketCard.id));
check(
  "a PLAN project's card is NOT on it — that is a queue the scheduler drains, not a board",
  !onBoard.has(planCard.id),
);

store.archiveTask(bareCard.id, Date.now());
const boardAfterArchive = store.getAllBoardTasks();
check('archiving drops a card from the union board', !boardAfterArchive.some((t) => t.id === bareCard.id));
const archivedBoard = store.getAllArchivedBoardTasks();
check(
  'and it shows up in the archived union instead',
  archivedBoard.some((t) => t.id === bareCard.id),
);

const sync = store.getPersonalTasksForSync();
const inSync = new Set(sync.map((t) => t.id));
check('getPersonalTasksForSync sees the Personal card', inSync.has(personalCard.id));
check(
  'and nothing else — not the bare-repo, plan or ticket project cards',
  !inSync.has(bareCard.id) && !inSync.has(planCard.id) && !inSync.has(ticketCard.id),
);

// ---------------------------------------------------------------------------
section('5. Guaranteeing every board project a key prefix');

const derivedPrefix = store.addProject({ name: 'Derived Prefix Co' });
check(
  'a plan-less project added with no prefix comes back with a derived one',
  Boolean(derivedPrefix.ticketPrefix),
  derivedPrefix.ticketPrefix,
);

const derivedPrefixTwin = store.addProject({ name: 'Derived Prefix Co' });
check(
  'a second project of the same name gets a distinct prefix, not a collision',
  Boolean(derivedPrefixTwin.ticketPrefix) &&
    derivedPrefixTwin.ticketPrefix !== derivedPrefix.ticketPrefix,
  JSON.stringify({ first: derivedPrefix.ticketPrefix, second: derivedPrefixTwin.ticketPrefix }),
);

const derivedPlanProject = store.addProject({
  path: scratch + '/derived-plan',
  name: 'Derived Plan Co',
});
check(
  "it really is plan-driven, so the guarantee shouldn't reach it (sanity check)",
  hasPlan(derivedPlanProject),
);
check(
  'a plan project added with no prefix still has none — the guarantee is board-only',
  derivedPlanProject.ticketPrefix === '',
  derivedPlanProject.ticketPrefix,
);

// ---------------------------------------------------------------------------
section('6. The four settings restored to ProjectForm round-trip through the store');

// Step 4 of this plan restored standing instructions, concurrency, the isolated-worktrees
// switch and write-back-to-plan to the UI. The engine side (addProject/updateProject) was
// never the bug — this proves it, independently of any UI: add with all four set, read
// back, edit all four, read back again.
const settingsProject = store.addProject({
  name: 'Settings Round Trip',
  path: scratch + '/settings-rt',
  instructions: 'Source ./env.sh before any command.',
  concurrency: 3,
  useWorktrees: false,
  writeBackPlan: true,
});
check('instructions came back from addProject unchanged', settingsProject.instructions === 'Source ./env.sh before any command.');
check('concurrency came back from addProject unchanged', settingsProject.concurrency === 3);
check('useWorktrees came back from addProject unchanged', settingsProject.useWorktrees === false);
check('writeBackPlan came back from addProject unchanged', settingsProject.writeBackPlan === true);

const settingsAfterAdd = store.listProjects().find((p) => p.id === settingsProject.id);
check(
  'and all four read back the same way through a fresh listProjects',
  Boolean(settingsAfterAdd) &&
    settingsAfterAdd.instructions === 'Source ./env.sh before any command.' &&
    settingsAfterAdd.concurrency === 3 &&
    settingsAfterAdd.useWorktrees === false &&
    settingsAfterAdd.writeBackPlan === true,
  JSON.stringify(settingsAfterAdd),
);

const settingsAfterUpdate = store.updateProject(settingsProject.id, {
  instructions: 'Run every command through ./scripts/wrapper.sh instead.',
  concurrency: 6,
  useWorktrees: true,
  writeBackPlan: false,
});
check(
  'instructions took the new value from updateProject',
  settingsAfterUpdate.instructions === 'Run every command through ./scripts/wrapper.sh instead.',
);
check('concurrency took the new value from updateProject', settingsAfterUpdate.concurrency === 6);
check('useWorktrees took the new value from updateProject', settingsAfterUpdate.useWorktrees === true);
check('writeBackPlan took the new value from updateProject', settingsAfterUpdate.writeBackPlan === false);

const settingsAfterUpdateReadBack = store.listProjects().find((p) => p.id === settingsProject.id);
check(
  'and all four read back the updated values too, through another fresh listProjects',
  Boolean(settingsAfterUpdateReadBack) &&
    settingsAfterUpdateReadBack.instructions === 'Run every command through ./scripts/wrapper.sh instead.' &&
    settingsAfterUpdateReadBack.concurrency === 6 &&
    settingsAfterUpdateReadBack.useWorktrees === true &&
    settingsAfterUpdateReadBack.writeBackPlan === false,
  JSON.stringify(settingsAfterUpdateReadBack),
);

// instructions is the one of the four with a second consumer: agentTaskPrompt.ts injects
// it into every run's prompt. Prove the value that just round-tripped through the store
// actually reaches that prompt, not merely that the store kept it.
const promptForSettingsProject = buildAgentTaskPrompt(
  settingsAfterUpdateReadBack.name,
  { title: 'a task', externalKey: null, externalUrl: null, externalDescription: null },
  { instructions: settingsAfterUpdateReadBack.instructions },
);
check(
  "the project's instructions, read back from the store, reach the agent's own prompt",
  promptForSettingsProject.includes('Project setup notes you must follow:') &&
    promptForSettingsProject.includes(settingsAfterUpdateReadBack.instructions),
  promptForSettingsProject,
);

// ---------------------------------------------------------------------------
section("7. 'personal' opts a project out of the guaranteed prefix");

const personalProject = store.addProject({ name: 'Alpha Personal', personal: true });
check(
  'a plan-less project added with personal: true gets no derived prefix',
  personalProject.ticketPrefix === '',
  personalProject.ticketPrefix,
);
check('and reads back as NOT owning tickets', !ownsTickets(personalProject));

const contradictoryProject = store.addProject({
  name: 'Contradiction Co',
  personal: true,
  ticketPrefix: 'CC',
});
check(
  'personal: true wins even when a prefix is also supplied — the explicit choice, not the field order',
  contradictoryProject.ticketPrefix === '',
  contradictoryProject.ticketPrefix,
);

const switchable = store.addProject({ name: 'Switchable Co' });
check(
  'sanity check: this one got the ordinary guaranteed prefix',
  Boolean(switchable.ticketPrefix),
  switchable.ticketPrefix,
);

const backToPersonal = store.updateProject(switchable.id, { ticketPrefix: '', personal: true });
check(
  'switching an untouched board project back to Personal succeeds — no tickets issued yet',
  Boolean(backToPersonal) && backToPersonal.ticketPrefix === '',
  backToPersonal && backToPersonal.ticketPrefix,
);
check(
  'and it now reads back as NOT owning tickets',
  Boolean(backToPersonal) && !ownsTickets(backToPersonal),
);

const issuedProject = store.addProject({ name: 'Already Filing Co' });
const issuedTicket = store.createTicket(issuedProject.id, { title: 'a ticket already on the books' });
check('sanity check: the ticket was actually created', Boolean(issuedTicket), issuedTicket);

const refusedPersonal = store.updateProject(issuedProject.id, {
  ticketPrefix: '',
  personal: true,
});
check(
  'switching back to Personal is refused once the project has issued a ticket',
  Boolean(refusedPersonal) && refusedPersonal.ticketPrefix === issuedProject.ticketPrefix,
  refusedPersonal && refusedPersonal.ticketPrefix,
);
check(
  'the ticket it already issued is untouched — still keyed under the old prefix',
  issuedTicket.ticketKey === issuedProject.ticketPrefix + '-1',
  issuedTicket.ticketKey,
);

// The exact bug this section exists to catch: the guaranteed-prefix backfill (section 5)
// runs on every store OPEN, not just once ever — so a Personal project has to survive a
// restart with no prefix, not merely survive the addProject/updateProject call that made
// it Personal in the first place. Close and reopen the same database file to prove it.
store.close();
const reopened = createStore(scratch + '/fresh/orchestrator.db');
const personalAfterRestart = reopened.getProject(personalProject.id);
check(
  'a project added as personal: true keeps no prefix after the store restarts',
  Boolean(personalAfterRestart) && personalAfterRestart.ticketPrefix === '',
  personalAfterRestart && personalAfterRestart.ticketPrefix,
);
const backToPersonalAfterRestart = reopened.getProject(backToPersonal.id);
check(
  'a project switched back to personal keeps no prefix after the store restarts too',
  Boolean(backToPersonalAfterRestart) && backToPersonalAfterRestart.ticketPrefix === '',
  backToPersonalAfterRestart && backToPersonalAfterRestart.ticketPrefix,
);
reopened.close();

console.log('');
if (failures > 0) {
  console.error(failures + ' check(s) failed.');
  process.exit(1);
}
`;

await main();
