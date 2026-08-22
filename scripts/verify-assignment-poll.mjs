/**
 * Headless proof of "desktop is the worker" ("cloud as central control for projects",
 * step 5): a queued `Assignment` for a ticket this desktop actually has locally is
 * claimed and started through `AssignmentPoller`'s real `store.listProjects()`/
 * `store.getTask()` resolution against a REAL SQLite store — not the fake `Store`
 * `assignmentPoller.test.ts` uses — while an assignment for a project this desktop
 * does not serve is left untouched.
 *
 *     node scripts/verify-assignment-poll.mjs
 *
 * Same bundle-then-run-under-Electron-as-Node trick as `scripts/verify-cloud-pull.mjs`
 * (that file's own header is the worked example this follows): `better-sqlite3`'s
 * addon is compiled for Electron's ABI, so nothing that calls `createStore` can run
 * under the Node that runs vitest. `AssignmentPoller`'s own dispatch logic (loop over
 * a page of assignments, skip what this desktop doesn't serve, claim/report over
 * HTTP) already has a fast, fake-store vitest suite (`assignmentPoller.test.ts`); this
 * is the one proof that its `store.listProjects()`/`store.getTask()` calls do what
 * that suite assumes against the real SQL behind them. The network is faked either
 * way — there is no real `@tm/server` here, only `AgentsController`'s contract,
 * matched by hand.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const scratch = mkdtempSync(join(tmpdir(), 'tm-assignment-poll-'));

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
        ...(external ? external.map((mod) => `--external:${mod}`) : []),
        `--outfile=${outfile}`,
        '--log-level=error',
      ],
      { stdio: 'inherit' },
    );

  bundle(join(root, 'apps/client/src/main/store.ts'), join(scratch, 'store.cjs'), [
    'better-sqlite3',
  ]);
  bundle(
    join(root, 'apps/client/src/main/assignmentPoller.ts'),
    join(scratch, 'assignmentPoller.cjs'),
    // `assignmentPoller.ts` pulls in `./log.ts` for its failure logging, which imports
    // `electron` for `app.getPath('logs')`. Left external and resolved at runtime via
    // `NODE_PATH` below — under `ELECTRON_RUN_AS_NODE` that require resolves to the
    // binary's path rather than the app API, so `app` comes back `undefined` and
    // `getLogPath()` throws; `logMain`'s own try/catch swallows exactly that (see its
    // docstring: "never throw — a logger that can crash the app defeats its purpose").
    ['electron'],
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
      NODE_PATH: clientModules,
    },
  });
  process.exit(run.status ?? 1);
}

// ── Phase 2: under Electron-as-Node — the actual checks ──────────────────────────────
const require = createRequire(import.meta.url);
const work = process.argv[2];
const { createStore } = require(join(work, 'store.cjs'));
const { AssignmentPoller } = require(join(work, 'assignmentPoller.cjs'));

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

const dbPath = join(work, 'orchestrator.db');
const store = createStore(dbPath);

// A ticket project this desktop actually serves, with one ticket already pulled down —
// exactly what a prior `CloudBoardPuller` tick (or a locally authored project) leaves
// behind. `AssignmentPoller` reads both back through the real `Store`, not a fake.
const served = store.addProject({ path: '', kind: 'ticket', ticketPrefix: 'TM', name: 'Served' });
const ticket = store.createTicket(served.id, { title: 'Ticket to run' });
check('the served project exists locally', store.getProject(served.id)?.id === served.id);
check('its ticket exists locally', store.getTask(ticket.id)?.id === ticket.id);

const servedAssignment = {
  id: 'assign-served',
  projectId: served.id,
  ticketId: ticket.id,
  profileId: 'profile-1',
  status: 'queued',
  claimedByClientId: null,
  claimedAt: null,
  startedAt: null,
  completedAt: null,
  runId: null,
  createdAt: 0,
  updatedAt: 0,
};
// A queued row for a project this desktop has never pulled down — another desktop's
// project. `AssignmentPoller` must resolve this against the real `listProjects()` and
// leave it alone.
const unservedAssignment = {
  ...servedAssignment,
  id: 'assign-unserved',
  projectId: 'cloud-project-elsewhere',
  ticketId: 'ticket-elsewhere',
};

const calls = [];
const fetchLog = [];
function fakeFetch(url, init) {
  const u = String(url);
  fetchLog.push(u);
  if (u.endsWith('/v1/assignments?status=queued')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => [servedAssignment, unservedAssignment],
    });
  }
  if (u.endsWith('/claim')) {
    calls.push({ kind: 'claim', url: u, body: JSON.parse(init.body) });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ ...servedAssignment, status: 'claimed' }),
    });
  }
  if (u.endsWith('/complete')) {
    calls.push({ kind: 'complete', url: u, body: JSON.parse(init.body) });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ ...servedAssignment, status: 'running' }),
    });
  }
  throw new Error(`unexpected fetch: ${u}`);
}

const runTaskCalls = [];
const poller = new AssignmentPoller({
  store,
  focus: { isFocused: () => true, onChange: () => () => {} },
  getSettings: () => ({
    enabled: true,
    baseUrl: 'https://api.example.com',
    activeIntervalMs: 2500,
    idleIntervalMs: 25000,
    jitterRatio: 0.1,
  }),
  getAccessToken: async () => 'test-token',
  runTracked: (run) => run(),
  fetchImpl: fakeFetch,
  runTask: (taskId) => {
    runTaskCalls.push(taskId);
    return { runId: 'run-123' };
  },
});

await poller.tick();

check(
  'polled GET /v1/assignments?status=queued once',
  fetchLog.filter((u) => u.endsWith('?status=queued')).length === 1,
);
check(
  'claimed the served assignment, not the unserved one',
  calls.filter((c) => c.kind === 'claim').length === 1 &&
    calls.some((c) => c.url.endsWith('/assignments/assign-served/claim')),
);
check(
  'the claim carried this desktop’s own cloud client id',
  calls.find((c) => c.kind === 'claim')?.body.clientId === store.loadCloudClientId(),
);
check(
  'started a session for the served ticket, and only the served ticket',
  runTaskCalls.length === 1 && runTaskCalls[0] === ticket.id,
);
check(
  'reported the assignment running with the scheduler’s own runId',
  calls.find((c) => c.kind === 'complete')?.body.status === 'running' &&
    calls.find((c) => c.kind === 'complete')?.body.runId === 'run-123',
);

// A second tick where the claim loses the race (another desktop got there first) must
// never call `runTask` — the whole point of claiming before starting.
const racedCalls = [];
const racedRunTaskCalls = [];
const racedPoller = new AssignmentPoller({
  store,
  focus: { isFocused: () => true, onChange: () => () => {} },
  getSettings: () => ({
    enabled: true,
    baseUrl: 'https://api.example.com',
    activeIntervalMs: 2500,
    idleIntervalMs: 25000,
    jitterRatio: 0.1,
  }),
  getAccessToken: async () => 'test-token',
  runTracked: (run) => run(),
  fetchImpl: (url, init) => {
    const u = String(url);
    if (u.endsWith('?status=queued')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => [servedAssignment] });
    }
    if (u.endsWith('/claim')) {
      racedCalls.push(u);
      return Promise.resolve({ ok: false, status: 400, json: async () => ({}) });
    }
    throw new Error(`unexpected fetch during race scenario: ${u}`);
  },
  runTask: (taskId) => {
    racedRunTaskCalls.push(taskId);
    return { runId: 'run-should-not-happen' };
  },
});

await racedPoller.tick();
check('a lost claim race attempted exactly one claim', racedCalls.length === 1);
check('a lost claim race never starts a session', racedRunTaskCalls.length === 0);

store.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
