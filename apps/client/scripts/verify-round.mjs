/**
 * Headless verification for this round's two engine changes — the half `vitest` cannot reach.
 *
 * The unit tests cover both of them against fakes: `chainRunner.test.ts` drives a
 * `ChainRunnerDeps` made of stubs, and `gitGraph.test.ts` parses canned `git log` output.
 * What neither can do is run the same code against the REAL things it will meet in the app:
 *
 *  - **The chain, against a real store.** `restingStatus`, `preRunStatus` and the whole
 *    borrowing rule are only interesting once a row has been written and read back — a fake
 *    `getTask` that returns the object you handed it can never disagree with SQLite about
 *    what a card's status now is. And `better-sqlite3` only loads inside Electron's ABI, so
 *    it runs here rather than in the suite.
 *  - **The graph, against a real repository.** The parser is pure and tested; `readGitGraph`
 *    is the part that shells out, and the only honest input for it is a repo with real
 *    branches, real merges and real ref decorations. This one uses THIS worktree.
 *
 * The app is NEVER launched (RELEASE.md rule 6 — there is no single-instance lock, and a
 * second instance killed a live session on 2026-08-02). This drives the modules directly
 * under `ELECTRON_RUN_AS_NODE`, against a scratch database inside the work directory. It
 * never opens, reads or writes the real profile. The repository it reads, it reads
 * READ-ONLY: one `git log`, one `rev-parse`, one `for-each-ref`. Nothing is checked out,
 * created or moved — this worktree is shared by every step of the plan.
 *
 * How it works, and why it is not simply a `node` script: `store.ts` and `chainRunner.ts`
 * are TypeScript with `@shared` aliases, and the main-process tree reaches `electron`. So
 * the scenario file is bundled with Vite first (aliasing `electron` to a stub, since none
 * of its symbols is called on this path), then run under Electron-as-Node so the addon's
 * ABI matches the binary loading it. Same shape as `scripts/verify-attachments.mjs`, whose
 * comments explain the ABI dance at greater length.
 *
 *   pnpm exec node scripts/verify-round.mjs
 *
 * Exits non-zero on the first failed assertion, naming it.
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

/**
 * Everything this script writes lives here, INSIDE the repo rather than in the temp dir,
 * for one reason: the bundle keeps `better-sqlite3` external, so it must sit somewhere
 * Node's resolution can still find `node_modules`. Removed on the way out, and on the way
 * in — a crashed previous run must not leak into this one.
 */
const work = join(repo, '.verify-round');

const electronBin = join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
const electronBinPosix = join(repo, 'node_modules', 'electron', 'dist', 'electron');

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

    const scratch = join(work, 'scratch').replace(/\\/g, '/');
    const entry = join(work, 'entry.ts');
    writeFileSync(
      entry,
      SCENARIOS.replaceAll('__SCRATCH__', scratch).replaceAll(
        '__REPO__',
        repo.replace(/\\/g, '/'),
      ),
      'utf8',
    );
    log('\nRunning the scenarios against the current code...');
    runUnderElectron(await bundle(entry, join(work, 'out')));

    log('\nAll scenarios passed.');
  } finally {
    // `--keep` leaves the bundle and the scratch database behind, which is the only way to
    // open one afterwards and see what a failing scenario actually wrote.
    if (process.argv.includes('--keep')) log(`\nLeft ${work} in place (--keep).`);
    else rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The scenarios themselves, as a template so the paths are baked in rather than passed —
 * a bundle takes no argv worth threading, and every path in it is scratch or this repo.
 */
const SCENARIOS = String.raw`
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restingStatus } from '@shared/board';
import { autoIntegrateOn } from '@shared/integrate';
import { PERSONAL_PROJECT_ID } from '@shared/model';
import { autoReleaseOn } from '@shared/release';
import { humanStatusPatch } from '__REPO__/src/main/cardStatusGuard';
import { ChainRunner } from '__REPO__/src/main/chainRunner';
import { DEFAULT_GRAPH_LIMIT, cardBranchesFor, readGitGraph } from '__REPO__/src/main/gitGraph';
import { createStore } from '__REPO__/src/main/store';
import { taskBranch } from '__REPO__/src/main/worktreeManager';

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

const REPO = '__REPO__';
const scratch = '__SCRATCH__';
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

const store = createStore(scratch + '/orchestrator.db');

/** The whole timeline of a card as one string, for asking what a note said. */
const timeline = (taskId) =>
  store
    .getTaskActivity(taskId)
    .map((e) => e.body ?? '')
    .join('\n');

// ===========================================================================
section('1. The chain, end to end against a real store');

// The app SETTING says do not auto-merge, and the PROJECT says do not auto-release. Both
// are here so the card's own overrides below are proved to be what is on — a scenario
// where every level agrees could not tell the resolution from a default.
store.saveSettings({ ...store.getSettings(), autoIntegrate: false });
const agent = store.addProject({
  path: REPO,
  name: 'the agent repo',
  kind: 'agent',
  useWorktrees: true,
  autoIntegrate: null,
  autoRelease: false,
});

/** A card on the Personal board, delegated to that agent project. */
function card(title, patch) {
  const created = store.createTask(PERSONAL_PROJECT_ID, { title });
  if (!created) throw new Error('the store refused ' + title);
  const updated = store.updateTask(created.id, { agentProjectId: agent.id, ...patch });
  if (!updated) throw new Error('the store refused the patch for ' + title);
  return updated;
}

// The predecessor: its work is written and filed under review, and it merges and releases
// itself. The successor: chained after it, and carrying a sessionId — it has been PLANNED,
// or somebody chatted with it about the ticket, and has done none of the work the arrow
// was drawn to order. That session used to read as "already worked" and stall the chain.
const first = card('the card that merges and releases itself', {
  status: 'in-review',
  agentBranch: 'orch/first',
  autoIntegrate: true,
  autoRelease: true,
});
const second = card('the card chained after it, already planned', {
  sessionId: 'a-session-left-behind-by-planning',
});
const link = store.addTaskLink(first.id, second.id, 'after-merge');

check('the successor starts out resting in To Do', restingStatus(second) === 'pending', second.status);
check('with a session already on it', Boolean(second.sessionId));
check('and one after-merge arrow between them', Boolean(link) && link.gate === 'after-merge');
check(
  'auto-merge is ON for the first card — its own override beats an app default of off',
  autoIntegrateOn(store.getTask(first.id), agent, store.getSettings()) === true,
);
check(
  'auto-release is ON for it too — over a project that says otherwise',
  autoReleaseOn(store.getTask(first.id), agent) === true,
);
check(
  'and neither is on for the successor, which overrides nothing',
  autoIntegrateOn(store.getTask(second.id), agent, store.getSettings()) === false &&
    autoReleaseOn(store.getTask(second.id), agent) === false,
);

/**
 * The runner, wired to the real store exactly as Scheduler wires it (scheduler.ts, where
 * this.chain = new ChainRunner({...}) is). Two deps stand in for the engine and only two:
 * runTask, because starting one really would spawn a Claude CLI, and limitActive. Both
 * keep the engine's own semantics — runTask reserves the card synchronously, which is
 * what makes "never two agents on one card" hold.
 */
const started = [];
const inFlight = new Set();
const chain = new ChainRunner({
  links: () => store.listTaskLinks(),
  getTask: (id) => store.getTask(id),
  setLandedAt: (id, at) => {
    store.updateTask(id, { landedAt: at });
  },
  addComment: (projectId, taskId, body) => {
    store.addComment(projectId, taskId, body);
  },
  runTask: (id) => {
    if (inFlight.has(id)) return false;
    inFlight.add(id);
    started.push(id);
    return true;
  },
  // Verbatim from Scheduler: the human's patch, not the scheduler's, so it parks in
  // preRunStatus when a run has borrowed status and never meets guardCardStatus.
  markInProgress: (id) => {
    const before = store.getTask(id);
    if (!before) return;
    store.updateTask(id, humanStatusPatch(before, 'in-progress'));
  },
  limitActive: () => false,
  inFlight: (id) => inFlight.has(id),
  branchOf: (task) => task.agentBranch?.trim() || taskBranch(task.id),
  now: () => 1_754_000_000_000,
});

// The moment the whole round turns on: the first card's branch is in base.
chain.landed(first.id);

check(
  'the landing is stamped on the predecessor, and only once',
  store.getTask(first.id).landedAt === 1_754_000_000_000,
  String(store.getTask(first.id).landedAt),
);
check(
  'the successor STARTED — a sessionId is not work, and no longer stalls the chain',
  started.length === 1 && started[0] === second.id,
  JSON.stringify(started),
);

const secondAfter = store.getTask(second.id);
check(
  'and it RESTS in in-progress: the app started it, so the app moved it',
  restingStatus(secondAfter) === 'in-progress',
  restingStatus(secondAfter),
);
check(
  'written to status itself, with nothing parked — no run has borrowed the field yet',
  secondAfter.status === 'in-progress' && secondAfter.preRunStatus === null,
  secondAfter.status + '/' + secondAfter.preRunStatus,
);
check('re-read from the database, not from the object we handed in', Boolean(secondAfter));
check('its session was left alone', secondAfter.sessionId === 'a-session-left-behind-by-planning');

const secondNotes = timeline(second.id);
check(
  'its timeline says a start happened, and names the card that caused it',
  secondNotes.includes('Started automatically') && secondNotes.includes(first.title),
  secondNotes,
);
check(
  'and accounts for the column move nobody asked for',
  secondNotes.includes('moved to In Progress'),
  secondNotes,
);

const firstAfter = store.getTask(first.id);
check(
  'the PREDECESSOR was not moved — a chain writes only the column it starts a card into',
  restingStatus(firstAfter) === 'in-review',
  restingStatus(firstAfter),
);

// A merged MR is re-reported on every GitLab poll, so this happens for real.
chain.landed(first.id);
check(
  'landing again starts nothing a second time',
  started.length === 1,
  JSON.stringify(started),
);

// ---------------------------------------------------------------------------
section('2. A card the human parked is told, not moved');

const third = card('the card parked in Blocked', { status: 'blocked' });
store.addTaskLink(second.id, third.id, 'after-merge');
chain.landed(second.id);

const thirdAfter = store.getTask(third.id);
check('nothing was started for it', started.length === 1, JSON.stringify(started));
check(
  'it is still exactly where the human put it',
  restingStatus(thirdAfter) === 'blocked',
  restingStatus(thirdAfter),
);
const thirdNotes = timeline(third.id);
check(
  'but its timeline says it was ready, and invites a start',
  thirdNotes.includes('Ready to start') && thirdNotes.includes('Start it whenever you like'),
  thirdNotes,
);

// ---------------------------------------------------------------------------
section('3. The re-ask starts and moves a card too');

// Everything this card waits for finished while nobody was asking — the boot case.
const fourth = card('the card whose predecessor landed while the app was shut', {
  sessionId: 'another-session-from-a-plan',
});
store.addTaskLink(first.id, fourth.id, 'after-merge');
chain.reconsider('boot');

const fourthAfter = store.getTask(fourth.id);
check(
  'the re-ask started it',
  started.length === 2 && started[1] === fourth.id,
  JSON.stringify(started),
);
check(
  'and moved it to In Progress, by the same rule',
  restingStatus(fourthAfter) === 'in-progress',
  restingStatus(fourthAfter),
);
check(
  'its note names the trigger rather than saying only "started automatically"',
  timeline(fourth.id).includes('Started on startup'),
  timeline(fourth.id),
);
check(
  'the card already running was not started again, and the blocked one still was not moved',
  restingStatus(store.getTask(third.id)) === 'blocked' && started.length === 2,
);

// ===========================================================================
section('4. The git graph, read from this very worktree');

/** Straight from git, so the assertions below are checked against the repo and not itself. */
const fromGit = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
const headSha = fromGit(['rev-parse', 'HEAD']);
const headSubject = fromGit(['log', '-1', '--format=%s']);
const currentBranch = fromGit(['rev-parse', '--abbrev-ref', 'HEAD']);

/**
 * The same three calls git:graph makes (ipc.ts): the project, every card on every board,
 * and readGitGraph over the branch map. Only the ipcMain.handle wrapper is missing,
 * and that is the part with no logic in it.
 */
const allTasks = store.listProjects().flatMap((p) => store.getTasks(p.id));
const graph = await readGitGraph(agent, cardBranchesFor(allTasks, agent.id));

check('it read the repository — no reason to show instead', graph.reason === undefined, graph.reason);
check('and got commits back', graph.commits.length > 0, String(graph.commits.length));
check(
  'the base branch fell back to the branch this worktree has out',
  graph.baseBranch === currentBranch,
  graph.baseBranch + ' vs ' + currentBranch,
);
check(
  'HEAD is in the window, with the subject git reports for it',
  graph.commits.some((c) => c.sha === headSha && c.subject === headSubject),
  headSha.slice(0, 8) + ' ' + headSubject,
);

const headCommit = graph.commits.find((c) => c.sha === headSha);
const baseRef = headCommit.refs.find((r) => r.name === currentBranch);
check(
  'the checked-out branch decorates it, marked as the base and as HEAD',
  Boolean(baseRef) && baseRef.role === 'base' && baseRef.isHead === true,
  JSON.stringify(headCommit.refs),
);
check(
  'every sha is a full 40 characters, and its short form a real prefix of it',
  graph.commits.every((c) => /^[0-9a-f]{40}$/.test(c.sha) && c.sha.startsWith(c.shortSha)),
);
check(
  'authored dates are UNIX SECONDS, not milliseconds',
  graph.commits.every((c) => c.authoredAt > 1_000_000_000 && c.authoredAt < 10_000_000_000),
);

// The layout, checked against the commits it was built from rather than against itself.
check(
  'one lane per commit, and laneCount covers the widest of them',
  graph.lanes.length === graph.commits.length &&
    graph.laneCount === Math.max(...graph.lanes) + 1,
  graph.lanes.length + '/' + graph.commits.length + ' lanes, count ' + graph.laneCount,
);
const rowOf = new Map(graph.commits.map((c, i) => [c.sha, i]));
check(
  'every edge runs from a child DOWN to a parent, both inside the window',
  graph.edges.every(
    (e) =>
      e.fromRow === rowOf.get(e.fromSha) &&
      e.toRow === rowOf.get(e.toSha) &&
      e.toRow > e.fromRow &&
      e.fromLane === graph.lanes[e.fromRow] &&
      e.toLane === graph.lanes[e.toRow],
  ),
  String(graph.edges.length) + ' edges',
);
check(
  'and there is exactly one edge per in-window parent — none invented, none dropped',
  graph.edges.length ===
    graph.commits.reduce(
      (n, c) => n + c.parents.filter((p) => rowOf.has(p)).length,
      0,
    ),
  String(graph.edges.length),
);
// The parse itself, against git rather than against the graph's own idea of itself: same
// window, same order, and every parent list compared entry for entry.
const fromLog = fromGit([
  'log',
  '--date-order',
  '--all',
  '-n',
  String(graph.commits.length),
  '--format=%H %P',
])
  .split('\n')
  .map((line) => line.trim().split(/\s+/));
check(
  'the commits and their parents are exactly what git prints, in git order',
  fromLog.length === graph.commits.length &&
    fromLog.every(
      ([sha, ...parents], i) =>
        graph.commits[i].sha === sha && graph.commits[i].parents.join(',') === parents.join(','),
    ),
  fromLog.length + ' lines vs ' + graph.commits.length + ' commits',
);
// This repository rebases rather than merges — 271 commits, not one of them with a second
// parent — so there is no fan-out here for the layout to draw, and saying so is the honest
// assertion. The merge case is what assignLanes' unit tests feed by hand.
check(
  'no commit here has a second parent, and the layout invents no edge for one',
  graph.commits.every((c) => c.parents.length <= 1) &&
    graph.edges.every((e) => e.parentIndex === 0),
  graph.edges.filter((e) => e.parentIndex > 0).length + ' second-parent edges',
);
// Several branches ARE in the window (--all is why the drawing shows a card's branch at
// all), so the lane walk had more than one line to keep apart even without a merge.
check(
  'and the branches that diverge still get lanes of their own',
  graph.laneCount > 1,
  'laneCount ' + graph.laneCount,
);

// A card's branch is the other half of the join, and only a REAL ref can prove it. Picked
// from what the graph just read rather than hardcoded: which branches exist here, and
// which of their tips fall inside the window, is not something this script may assume.
const otherBranch = graph.commits
  .flatMap((c) => c.refs)
  .find((r) => r.kind === 'branch' && r.name !== currentBranch && !r.isHead);
if (!otherBranch) {
  check('a second local branch was in the window to mark as a card branch', false, 'none found');
} else {
  store.updateTask(first.id, { agentBranch: otherBranch.name });
  const tasks = store.listProjects().flatMap((p) => store.getTasks(p.id));
  const branches = cardBranchesFor(tasks, agent.id);
  check(
    'cardBranchesFor maps that branch to the card that owns it',
    branches.get(otherBranch.name) === first.id,
    JSON.stringify([...branches]),
  );
  const marked = await readGitGraph(agent, branches);
  const cardRef = marked.commits.flatMap((c) => c.refs).find((r) => r.name === otherBranch.name);
  check(
    'and the graph comes back with "' + otherBranch.name + '" marked as that card\'s branch',
    Boolean(cardRef) && cardRef.role === 'card' && cardRef.taskId === first.id,
    JSON.stringify(cardRef),
  );
  check(
    'while the base branch keeps its own role — base wins over card',
    marked.commits
      .flatMap((c) => c.refs)
      .filter((r) => r.name === currentBranch)
      .every((r) => r.role === 'base'),
  );
}

// The limit is a view's limit, and honesty about cutting history is the whole reason one
// extra commit is fetched.
const small = await readGitGraph(agent, new Map(), 5);
check(
  'a limit of 5 returns 5 and says the history was cut',
  small.commits.length === 5 && small.truncated === true,
  small.commits.length + ', truncated ' + small.truncated,
);
check(
  'and they are the same newest five, in the same order',
  small.commits.map((c) => c.sha).join(',') ===
    graph.commits.slice(0, 5).map((c) => c.sha).join(','),
);
check(
  'the default limit is what an unasked-for read uses',
  graph.commits.length === Math.min(DEFAULT_GRAPH_LIMIT, graph.commits.length),
);

// ---------------------------------------------------------------------------
section('5. A project that has no graph says so instead of throwing');

// In the TEMP dir, not in scratch: scratch lives inside this repo (the bundle needs
// node_modules on the resolution path), and git would rightly call it part of this work
// tree — the first version of this check passed a folder that WAS a repository.
const outside = join(mkdtempSync(join(tmpdir(), 'verify-round-')), 'plain-folder');
mkdirSync(outside, { recursive: true });
const notARepo = store.addProject({ path: outside, name: 'not a repo', kind: 'agent' });
const noGraph = await readGitGraph(notARepo, new Map());
check(
  'a folder that is not a repository comes back empty, with a sentence',
  noGraph.commits.length === 0 && /not a git repository/i.test(noGraph.reason ?? ''),
  noGraph.reason,
);
const missing = store.addProject({ path: scratch + '/no-such-folder', name: 'gone', kind: 'agent' });
const goneGraph = await readGitGraph(missing, new Map());
check(
  'a folder that is not there does too',
  goneGraph.commits.length === 0 && Boolean(goneGraph.reason),
  goneGraph.reason,
);
const pathless = store.addProject({ path: '', name: 'pathless', kind: 'agent' });
const pathlessGraph = await readGitGraph(pathless, new Map());
check(
  'and so does a project with no folder at all',
  pathlessGraph.commits.length === 0 && Boolean(pathlessGraph.reason),
  pathlessGraph.reason,
);

store.close();

console.log('');
if (failures > 0) {
  console.error(failures + ' check(s) failed.');
  process.exit(1);
}
`;

await main();
