/**
 * Headless verification for Phase 26's remote IPC relay — the half `vitest` cannot reach.
 *
 * The unit suites cover every piece in isolation: the policy (`ipcRelay.test.ts`), the
 * server's lease (`commandQueue.test.ts`), the serial drain (`main/commandQueue.test.ts`),
 * the registry (`ipcRegistry.test.ts`), the applier (`cloudCommands.test.ts`), the browser
 * transport (`httpTransport.test.ts`) and the event bus (`polledEvents.test.ts`). What none
 * of them covers is the thing that actually has to work: a click in a browser reaching a
 * desktop handler and its answer coming back, through a REAL `Store` on a REAL SQLite file,
 * with the queue, the ledger and the poll loop all in the circuit at once.
 *
 * The app is NEVER launched (RELEASE.md rule 6 — there is no single-instance lock, and a
 * second instance killed a live session on 2026-08-02). This drives the modules directly
 * under `ELECTRON_RUN_AS_NODE`, against a scratch database in a scratch directory. It never
 * opens, reads or writes the real profile.
 *
 * WHAT IS REAL AND WHAT IS FAKE
 * -----------------------------
 * Real: `Store` (a real `better-sqlite3` file, real triggers, the real ledger),
 * `RelayRegistry`, `applyCloudCommand`, `CommandQueue`, `HttpTransport`.
 *
 * Fake: the server (an in-memory command queue and result table implementing the same lease
 * rule as `apps/server/src/mirror/commandQueue.ts`), `fetch` (routed straight into it), and
 * the handlers the registry is filled with — a stub apiece, because the point is the RELAY,
 * not `ipc.ts`'s 115 handlers, which have their own tests and need Electron.
 *
 * Not bundled with Vite the way `verify-attachments.mjs` is, because nothing here imports
 * `electron` — `ipcRegistry`, `commandQueue`, `cloudCommands` and `httpTransport` were all
 * written to be reachable without it, which is most of the point of them being their own
 * files. Only `store.ts` needs the addon, hence Electron-as-Node.
 *
 *   pnpm exec node apps/client/scripts/verify-remote-ipc.mjs
 *
 * Exits non-zero on the first failed assertion, naming it.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const require = createRequire(import.meta.url);
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '..', '..');
const sharedSrc = join(repo, 'packages', 'shared', 'src');
const protocolSrc = join(repo, 'packages', 'protocol', 'src');
const webSrc = join(repo, 'apps', 'web', 'src');

/**
 * Everything this script writes lives here, INSIDE the app rather than in the temp dir, for
 * one reason: the bundle keeps `better-sqlite3` external, so it must sit somewhere Node's
 * resolution can still find `node_modules`. Removed on the way out AND on the way in — a
 * crashed previous run must not leak into this one.
 *
 * A scratch dir inside the repo IS a work tree, so nothing here may run git in it.
 */
const work = join(app, '.verify-remote-ipc');

// apps/client's own node_modules, not the workspace root's: pnpm links Electron and the
// addon into the package that declares them, and the root has neither.
const electronBin = join(app, 'node_modules', 'electron', 'dist', 'electron.exe');
const electronBinPosix = join(app, 'node_modules', 'electron', 'dist', 'electron');

function log(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * `@tm/ui/transport` is a TYPE-only import in `httpTransport.ts`, but the specifier is still
 * in the file and Vite still resolves it. Aliased to an empty module rather than to the real
 * package, which would pull React in for a type that is erased.
 */
const EMPTY_MODULE = 'export {};\n';

async function bundle(entry, outDir) {
  const empty = join(work, 'empty.mjs');
  writeFileSync(empty, EMPTY_MODULE, 'utf8');
  const electronStub = join(work, 'electron-stub.mjs');
  writeFileSync(
    electronStub,
    `const unavailable = (name) => () => {
  throw new Error(\`Electron's \${name} is not available in headless verification\`);
};
export const app = { getPath: unavailable('app.getPath'), on: unavailable('app.on') };
export const ipcMain = { handle: unavailable('ipcMain.handle') };
export const safeStorage = { isEncryptionAvailable: () => false };
export default { app, ipcMain, safeStorage };
`,
    'utf8',
  );
  await build({
    configFile: false,
    logLevel: 'error',
    resolve: {
      alias: {
        '@shared': sharedSrc,
        '@protocol': protocolSrc,
        '@tm/shared': sharedSrc,
        '@tm/protocol': protocolSrc,
        '@tm/ui/transport': empty,
        '@web': webSrc,
        electron: electronStub,
      },
    },
    build: {
      ssr: entry,
      outDir,
      emptyOutDir: true,
      target: 'node20',
      minify: false,
      rollupOptions: {
        external: ['better-sqlite3'],
        output: { format: 'es', entryFileNames: 'bundle.mjs' },
      },
    },
  });
  return join(outDir, 'bundle.mjs');
}

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

const SCENARIO = (scratch) => `
import { mkdirSync } from 'node:fs';
import { createStore } from '${join(app, 'src/main/store').replace(/\\/g, '/')}';
import { RelayRegistry } from '${join(app, 'src/main/ipcRegistry').replace(/\\/g, '/')}';
import { CommandQueue } from '${join(app, 'src/main/commandQueue').replace(/\\/g, '/')}';
import { applyCloudCommand } from '${join(app, 'src/main/cloudCommands').replace(/\\/g, '/')}';
import { HttpTransport } from '${join(webSrc, 'board/httpTransport').replace(/\\/g, '/')}';
import { PolledEventBus } from '${join(webSrc, 'board/polledEvents').replace(/\\/g, '/')}';
import {
  acknowledgeable,
  isDeliverable,
} from '${join(repo, 'apps/server/src/mirror/commandQueue').replace(/\\/g, '/')}';

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log('  ok   ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

mkdirSync('${scratch}', { recursive: true });
const store = createStore('${scratch}/orchestrator.db');

// ---------------------------------------------------------------------------
// The fake server. Holds the command queue and the result table, and implements the SAME
// lease rule the real one does — imported from it, not restated, so this harness cannot
// pass against a redelivery policy the server no longer has.
// ---------------------------------------------------------------------------
class FakeServer {
  constructor() {
    this.commands = [];
    this.results = [];
    // Stands in for command_results.rowVersion: unique and increasing across the whole
    // table, INCLUDING on an update. A counter derived from results.length would hand a
    // replaced row the same number as a freshly appended one, and a browser already past
    // that number would never be told about either.
    this.nextSeq = 1;
    this.now = 1_000_000;
    /** Set to drop the NEXT sync's response — how a lost reply is staged. */
    this.dropNextSyncResponse = false;
  }

  /** POST /v1/commands — idempotent, exactly as MirrorService.enqueueCommand now is. */
  enqueue(request) {
    if (this.commands.some((c) => c.id === request.command.id)) return { ok: true, status: 202 };
    this.commands.push({
      ...request.command,
      deliveredAt: null,
      ackedAt: null,
      createdAt: this.commands.length,
    });
    return { ok: true, status: 202 };
  }

  /** POST /v1/sync — ack, store results, then lease out whatever is still owed. */
  sync(body) {
    for (const id of body.ackedCommandIds ?? []) {
      const row = this.commands.find((c) => c.id === id);
      if (acknowledgeable([row].filter(Boolean), [id]).length) row.ackedAt = new Date(this.now);
    }
    for (const result of body.results ?? []) {
      const command = this.commands.find((c) => c.id === result.commandId);
      if (!command) continue;
      const existing = this.results.findIndex((r) => r.commandId === result.commandId);
      const row = { ...result, issuedBy: command.issuedBy, seq: this.nextSeq++ };
      if (existing >= 0) this.results[existing] = row;
      else this.results.push(row);
    }

    const due = this.commands.filter((c) => isDeliverable(c, this.now));
    for (const c of due) c.deliveredAt = new Date(this.now);

    if (this.dropNextSyncResponse) {
      this.dropNextSyncResponse = false;
      // The commands were marked delivered on the server and the response never arrived —
      // the exact failure at-most-once delivery could not survive.
      throw new Error('network went away after the server committed');
    }
    return { cursor: 'c', cadence: { tier: 'active', intervalMs: 2500 }, commands: due };
  }

  /** GET /v1/results?since= — scoped by issuedBy, which is the whole point of the route. */
  resultsFor(issuedBy, since) {
    const from = since ? Number(since) : 0;
    const rows = this.results.filter((r) => r.issuedBy === issuedBy && r.seq > from);
    const cursor = rows.length ? String(rows[rows.length - 1].seq) : (since ?? '0');
    return {
      results: rows.map(({ commandId, ok, value, error }) => ({ commandId, ok, value, error })),
      cursor,
    };
  }
}

const server = new FakeServer();

/** The browser's fetch, routed into the fake server. */
const fetchImpl = async (url, init) => {
  const u = new URL(url);
  if (u.pathname === '/v1/commands') {
    // Queued HERE rather than inside json(): the transport never reads a 202's body, so a
    // lazy mock would have accepted every command and stored none — which is exactly the
    // shape of bug this harness exists to catch, and it caught itself with it first.
    const answer = server.enqueue(JSON.parse(init.body));
    return { ...answer, json: async () => answer };
  }
  if (u.pathname === '/v1/results') {
    const body = server.resultsFor('web-tab-1', u.searchParams.get('since'));
    return { ok: true, status: 200, json: async () => body };
  }
  throw new Error('unexpected fetch ' + url);
};

// ---------------------------------------------------------------------------
// The desktop side: a real registry of stub handlers, the real applier, the real queue,
// and a sync tick that is the poller's send() reduced to the parts under test.
// ---------------------------------------------------------------------------
const calls = [];
const registry = new RelayRegistry();
registry.register('board:tasks', async () => {
  calls.push('board:tasks');
  return store.getTasks(personalId);
});
/**
 * Deliberately SLOW when the note says so, and the slowness is the test.
 *
 * A handler that resolves in one microtask looks identical whether the drain is serial or
 * fire-and-forget, so an ordering check against one proves nothing. Making the first of a
 * pair take longer than the second means a concurrent drain visibly reverses them.
 */
registry.register('task:setStatusNote', async (taskId, note) => {
  if (note === 'one') await new Promise((r) => setTimeout(r, 25));
  calls.push('task:setStatusNote:' + taskId);
  return store.updateTask(taskId, { statusNote: note });
});
registry.register('task:run', async (taskId) => {
  calls.push('task:run:' + taskId);
  return { runId: 'run-for-' + taskId };
});
registry.register('task:move', async () => {
  calls.push('task:move');
  throw new Error('Card is locked by a running session.');
});
// Registered AND host-only — the classification decides, not the wiring.
registry.register('attachment:pick', async () => ['C:/private/secrets.txt']);

const queue = new CommandQueue({
  run: (command) => applyCloudCommand(store, command, registry),
});

/** One /v1/sync round trip, as cloudPoller.send() does it. */
function tick() {
  const acks = store.getPendingCloudAcks();
  const pending = store.getPendingCloudResults();
  const results = pending.map((row) => ({
    commandId: row.commandId,
    ok: row.ok,
    ...(row.value === undefined ? {} : { value: row.value }),
    ...(row.reason === null ? {} : { error: row.reason }),
  }));
  let response;
  try {
    response = server.sync({ ackedCommandIds: acks, results });
  } catch {
    return { lost: true }; // the response never came back — nothing is marked sent
  }
  if (acks.length) store.markCloudAcksSent(acks);
  if (results.length) store.markCloudResultsSent(results.map((r) => r.commandId));
  queue.enqueue(response.commands);
  return { delivered: response.commands.length };
}

/** Run ticks until the queue settles and the browser's promise has had its chance. */
async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    tick();
    await queue.idle();
    // Long enough for the transport's 1ms result poll to fire at least once between ticks.
    await new Promise((r) => setTimeout(r, 5));
  }
}

const project = store.addProject({ path: '', name: 'Personal', kind: 'ticket' });
const personalId = project.id;
const card = store.createTask(personalId, { title: 'A card to poke at' });

const transport = new HttpTransport({
  apiBase: 'https://fake.invalid',
  clientId: 'web-tab-1',
  getAccessToken: async () => 'token',
  getTargetClientId: () => 'desktop-1',
  hasLiveClient: () => true,
  fetchImpl,
  // A 1ms timer rather than the 300ms default: the run should be instant, but it must
  // still be a MACROTASK. A microtask-based poll re-schedules itself without ever yielding
  // to the event loop, which starves the sync ticks it is waiting for — the loop spins and
  // the call times out against a desktop that never got a chance to answer.
  setTimeoutImpl: (cb) => setTimeout(cb, 1),
});

// --- 1. A relayed invoke round-trips -----------------------------------------
{
  const pending = transport.invoke('task:setStatusNote', card.id, 'poked from a browser');
  await settle();
  const answer = await pending;
  check('a relayed invoke round-trips', answer && answer.statusNote === 'poked from a browser',
    JSON.stringify(answer));
  check('and the write really landed in SQLite',
    store.getTask(card.id).statusNote === 'poked from a browser');
}

// --- 2. A host-only channel is refused by name -------------------------------
{
  let message = null;
  await transport.invoke('attachment:pick').catch((e) => { message = e.message; });
  check('a host-only channel is refused by name, before the network',
    message && message.includes('attachment:pick') && message.includes('file picker'), message);
  check('and no command was queued for it', !server.commands.some(
    (c) => c.kind === 'ipc-invoke' && c.payload.channel === 'attachment:pick'));
}

// --- 3. A lost result is redelivered and REPLAYED, not re-executed -----------
{
  calls.length = 0;
  const pending = transport.invoke('task:run', card.id);
  // Let the POST land before the first tick: invoke awaits a token and a fetch, so a tick
  // fired in the same turn would sync an empty queue and the scenario would prove nothing.
  await new Promise((r) => setTimeout(r, 5));
  // The command is delivered and applied, and the sync carrying its result is lost.
  tick();
  await queue.idle();
  server.dropNextSyncResponse = true;
  const lost = tick();
  check('the sync carrying the result was lost', lost.lost === true);
  check('so nothing was marked sent', store.getPendingCloudResults().length === 1);

  // Past the lease, the server offers the command again.
  server.now += 10 * 60 * 1000;
  await settle();
  const answer = await pending;
  check('the browser still gets its answer after a lost reply',
    answer && answer.runId === 'run-for-' + card.id, JSON.stringify(answer));
  check('and the handler ran exactly ONCE — the ledger replayed it',
    calls.filter((c) => c.startsWith('task:run')).length === 1, calls.join(','));

  // And the replay hands back the ANSWER, not merely "applied". This is the half a
  // boolean ledger got wrong: a redelivered task:run on a card that is running BECAUSE OF
  // THAT COMMAND would answer the browser "already running" for a command that succeeded.
  const ran = server.commands.find(
    (c) => c.kind === 'ipc-invoke' && c.payload.channel === 'task:run',
  );
  const replayed = await applyCloudCommand(store, ran, registry);
  check('a replayed command returns its stored value, not a bare ok',
    replayed.ok === true && replayed.value && replayed.value.runId === 'run-for-' + card.id,
    JSON.stringify(replayed));
  check('and still did not re-run the handler',
    calls.filter((c) => c.startsWith('task:run')).length === 1, calls.join(','));
}

// --- 4. Ordering holds across interleaved batches ---------------------------
{
  calls.length = 0;
  const a = store.createTask(personalId, { title: 'first' });
  const b = store.createTask(personalId, { title: 'second' });
  // Caught as they are created, and awaited below: a rejection with no handler attached
  // yet is an unhandled rejection, which takes the process down before any check runs.
  const pa = transport.invoke('task:setStatusNote', a.id, 'one').then(
    () => null,
    (e) => e.message,
  );
  const pb = transport.invoke('task:setStatusNote', b.id, 'two').then(
    () => null,
    (e) => e.message,
  );
  await new Promise((r) => setTimeout(r, 5));
  await settle();
  const answers = await Promise.all([pa, pb]);
  check('both concurrent calls got their own answer back', eq(answers, [null, null]),
    answers.join(' / '));
  check('commands run in the order the server delivered them',
    eq(calls, ['task:setStatusNote:' + a.id, 'task:setStatusNote:' + b.id]), calls.join(','));
}

// --- 5. A rejecting handler does not roll back its predecessor --------------
{
  const c = store.createTask(personalId, { title: 'survivor' });
  const ok = transport.invoke('task:setStatusNote', c.id, 'this must survive');
  // Caught the moment it is created: it rejects during settle(), and a rejection with no
  // handler yet attached is an unhandled rejection that takes the whole process down.
  const bad = transport.invoke('task:move', c.id, 'done').then(
    () => null,
    (e) => e.message,
  );
  await settle();
  await ok;
  const message = await bad;
  check('the failing command reports the handler’s own message',
    message === 'Card is locked by a running session.', message);
  check('and its predecessor’s write is still there',
    store.getTask(c.id).statusNote === 'this must survive');
}

// --- 6. PolledEventBus reproduces task:changed from a board:tasks diff ------
{
  const seen = [];
  const bus = new PolledEventBus({
    invoke: (channel, ...args) => transport.invoke(channel, ...args),
    setIntervalImpl: () => 0,
    clearIntervalImpl: () => {},
  });
  const off = bus.on('task:changed', (payload) => seen.push(payload.task.id));

  const poll = async () => {
    const p = bus.poll();
    await settle();
    await p;
  };
  await poll();                       // baseline
  check('the first poll is a baseline, not a change', seen.length === 0, seen.join(','));

  const moved = store.createTask(personalId, { title: 'appears later' });
  await poll();
  check('a card that appeared is announced as task:changed',
    seen.includes(moved.id), seen.join(','));
  off();
  bus.dispose();
}

store.close();
console.log(failures === 0 ? '\\nAll remote-IPC checks passed.' : '\\n' + failures + ' check(s) failed.');
process.exit(failures === 0 ? 0 : 1);
`;

async function main() {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  try {
    // The ABI the whole exercise depends on. Checked first and by itself, because the
    // scenario fails identically and unhelpfully when this is wrong.
    const abi = require('./native-abi.mjs');
    const addon = join(
      dirname(require.resolve('better-sqlite3/package.json')),
      abi.ADDON_RELATIVE_PATH,
    );
    const expected = abi.readElectronAbi(require('electron'));
    const { readFileSync } = await import('node:fs');
    const actual = abi.readModuleAbi(readFileSync(addon));
    if (expected !== actual) {
      throw new Error(
        `better_sqlite3.node targets ABI ${actual} but Electron is ABI ${expected} — ` +
          'run `pnpm ensure:abi` first',
      );
    }
    log(`ABI ok: addon and Electron both ${actual}`);

    const scratch = join(work, 'scratch').replace(/\\/g, '/');
    const entry = join(work, 'scenario.ts');
    writeFileSync(entry, SCENARIO(scratch), 'utf8');

    log('\nDriving a browser click through the relay to a real Store...');
    runUnderElectron(await bundle(entry, join(work, 'out')));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  process.stderr.write(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
