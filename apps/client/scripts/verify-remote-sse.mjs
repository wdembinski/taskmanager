/**
 * Headless verification for the PUSH channel — the sibling of `verify-remote-ipc.mjs`, and
 * the half of the mirror round that `vitest` cannot reach.
 *
 * The unit suites cover every piece in isolation: the classification
 * (`ipcEventFanout.test.ts`), the desktop's forwarder (`cloudEventForwarder.test.ts`), the
 * server's ring and its subscriptions (`eventBus.test.ts`), the SSE framing
 * (`sseStream.test.ts`), the browser's reader (`sseEvents.test.ts`) and the composite that
 * chooses between push and poll (`packages/cloud/src/board/eventBus.test.ts`). What none of them
 * covers is the thing that actually has to work: an agent's line, emitted on the desktop,
 * arriving in a browser — through the forwarder's queue, a real `POST /v1/events`, the
 * server's replay ring, real `text/event-stream` bytes, the browser's `ReadableStream`
 * reader and the composite bus, with every one of them in the circuit at once.
 *
 * The app is NEVER launched (RELEASE.md rule 6). Unlike `verify-remote-ipc.mjs` this does not
 * need Electron either, and says so rather than borrowing the ceremony: there is no `Store`
 * and no `better-sqlite3` anywhere on this wire, so it runs under plain Node and the ABI
 * preflight that script opens with would be checking something this one never touches.
 *
 * WHAT IS REAL AND WHAT IS FAKE
 * -----------------------------
 * Real: `CloudEventForwarder`, the server's `EventBus` and `SseStream` (through
 * `openEventStream`), the browser's `SseEventStream` and `SseFrameParser`, and `CloudEventBus`.
 * The bytes between the two halves are real SSE text — encoded, chunked, decoded and parsed.
 *
 * Fake: the transport underneath (`fetch`, routed straight into the server objects), the
 * socket the server writes into (a `ReadableStream` the browser then reads), `PolledEventBus`
 * (a recorder — the point here is WHETHER it runs, which is the never-both rule), and two
 * imports that are ceremony on this path: `electron` (which `logMain` reaches for) and
 * `@nestjs/common` (`@Injectable()` and `Logger`, neither of which does anything the bus
 * depends on). Both are stubbed, exactly as `verify-remote-ipc.mjs` stubs `electron`.
 *
 * The FAKE SERVER IS ONE ROUTE, two methods — `POST /v1/events` and `GET /v1/events` against
 * one `EventBus` instance — because that is what the service is, and a harness that gave each
 * direction its own bus would pass with the two halves wired to nothing.
 *
 *   pnpm exec node apps/client/scripts/verify-remote-sse.mjs
 *
 * Exits non-zero on the first failed assertion, naming it.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '..', '..');
const sharedSrc = join(repo, 'packages', 'shared', 'src');
const protocolSrc = join(repo, 'packages', 'protocol', 'src');
// `SseEventStream` and `CloudEventBus` moved out of apps/web/src and into `@tm/cloud`
// (Phase 27 step 3, so both apps/web and apps/mobile can share one sync layer) — this
// reads their sources directly, same as it always has, just from their new home.
const cloudSrc = join(repo, 'packages', 'cloud', 'src');
const serverSrc = join(repo, 'apps', 'server', 'src');

/**
 * Everything this script writes lives here, inside the app and removed on the way in AND on
 * the way out — a crashed previous run must not leak into this one.
 *
 * A scratch dir inside the repo IS a work tree, so nothing here may run git in it.
 */
const work = join(app, '.verify-remote-sse');

function log(message) {
  process.stdout.write(`${message}\n`);
}

const posix = (path) => path.replace(/\\/g, '/');

/** `@tm/ui/transport` is a type-only import that Vite still resolves. See verify-remote-ipc. */
const EMPTY_MODULE = 'export {};\n';

const ELECTRON_STUB = `const unavailable = (name) => () => {
  throw new Error(\`Electron's \${name} is not available in headless verification\`);
};
export const app = { getPath: unavailable('app.getPath'), on: unavailable('app.on') };
export const ipcMain = { handle: unavailable('ipcMain.handle') };
export const safeStorage = { isEncryptionAvailable: () => false };
export default { app, ipcMain, safeStorage };
`;

/**
 * Nest's two decorations, reduced to what they are on this path: nothing.
 *
 * `EventBus` is constructed with `new` here rather than resolved out of a DI container, so
 * `@Injectable()` is a no-op marker, and its `Logger` writes one line per failed resume. The
 * real package would drag `reflect-metadata` and `rxjs` into a bundle that needs neither.
 */
const NEST_STUB = `export const Injectable = () => () => undefined;
export class Logger {
  constructor(context) { this.context = context; }
  log() {}
  warn() {}
  error() {}
  debug() {}
  verbose() {}
}
`;

async function bundle(entry, outDir) {
  const empty = join(work, 'empty.mjs');
  writeFileSync(empty, EMPTY_MODULE, 'utf8');
  const electronStub = join(work, 'electron-stub.mjs');
  writeFileSync(electronStub, ELECTRON_STUB, 'utf8');
  const nestStub = join(work, 'nest-stub.mjs');
  writeFileSync(nestStub, NEST_STUB, 'utf8');

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
        '@nestjs/common': nestStub,
        electron: electronStub,
      },
    },
    esbuild: {
      // `EventBus` is decorated with `@Injectable()`. esbuild will not transform a legacy
      // decorator unless it is told the flag is on, and Vite does not read apps/server's
      // tsconfig for a build rooted here.
      tsconfigRaw: {
        compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false },
      },
    },
    build: {
      ssr: entry,
      outDir,
      emptyOutDir: true,
      target: 'node20',
      minify: false,
      rollupOptions: { output: { format: 'es', entryFileNames: 'bundle.mjs' } },
    },
  });
  return join(outDir, 'bundle.mjs');
}

/**
 * Plain Node, not Electron-as-Node.
 *
 * Nothing on this wire touches the native addon, so borrowing `verify-remote-ipc.mjs`'s
 * Electron launch would make this script fail for a reason that has nothing to do with what
 * it verifies — and pass only on a machine where `ensure:abi` had been run.
 */
function runUnderNode(bundlePath) {
  const result = spawnSync(process.execPath, [bundlePath], { encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${bundlePath} exited ${result.status ?? `on ${result.signal}`}`);
  }
}

const SCENARIO = `
import { CloudEventForwarder } from '${posix(join(app, 'src/main/cloudEventForwarder'))}';
import { EventBus } from '${posix(join(serverSrc, 'events/eventBus'))}';
import { openEventStream } from '${posix(join(serverSrc, 'events/sseStream'))}';
import { SseEventStream } from '${posix(join(cloudSrc, 'board/sseEvents'))}';
import { CloudEventBus } from '${posix(join(cloudSrc, 'board/eventBus'))}';
import { MAX_EVENT_BYTES } from '${posix(join(sharedSrc, 'ipcEventFanout'))}';

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log('  ok   ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

const ACCOUNT = 'acct-1';
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The fake service: ONE EventBus, reached by both methods of /v1/events. The GET opens a real
// SseStream writing into a ReadableStream the browser reads — so the bytes between the two
// halves are the bytes the service would put on the socket.
// ---------------------------------------------------------------------------
const bus = new EventBus();
/** Every SSE connection opened, so a test can close one the way the server would. */
const connections = [];
/** Every batch body the desktop POSTed, in order. */
const posted = [];
/** Timings for every GET. The heartbeat is fast so several fire inside one check. */
let nextTimings = { heartbeatMs: 50, maxLifetimeMs: 60_000, retryMs: 10 };

function openConnection(lastEventId) {
  const encoder = new TextEncoder();
  let controller = null;
  // Constructed BEFORE the socket so \`start\` has already captured the controller by the time
  // openEventStream writes its \`retry:\` and \`hello\` — both of which it writes synchronously.
  const body = new ReadableStream({
    start(c) {
      controller = c;
    },
    cancel() {
      connection.stream.dispose();
      connection.open = false;
    },
  });
  const socket = {
    writeHead() {},
    write(chunk) {
      if (!connection.open) return true;
      controller.enqueue(encoder.encode(chunk));
      return true;
    },
    once() {},
    end() {
      connection.open = false;
      try {
        controller.close();
      } catch {}
    },
  };
  const connection = { open: true, body, stream: null };
  connection.stream = openEventStream({ socket, bus, accountId: ACCOUNT, lastEventId, ...nextTimings });
  connections.push(connection);
  return connection;
}

/** The desktop's fetch — POST only. */
const desktopFetch = async (url, init) => {
  const u = new URL(url);
  if (u.pathname !== '/v1/events' || init?.method !== 'POST') throw new Error('unexpected ' + url);
  const batch = JSON.parse(init.body);
  posted.push(batch);
  bus.publish(ACCOUNT, batch.events, batch.gap ?? 0);
  const answer = { listeners: bus.listeners(ACCOUNT) };
  return { ok: true, status: 200, json: async () => answer };
};

/** Set to make every FUTURE GET fail — an old server with no /v1/events, or a proxy eating it. */
let streamBroken = false;

/** The browser's fetch — GET only, and it hands back a real byte stream. */
const browserFetch = async (url, init) => {
  const u = new URL(url);
  if (u.pathname !== '/v1/events' || init?.method) throw new Error('unexpected ' + url);
  if (streamBroken) return { ok: false, status: 502, statusText: 'Bad Gateway', body: null };
  const header = init?.headers?.['last-event-id'];
  const connection = openConnection(header === undefined ? null : Number(header));
  return { ok: true, status: 200, statusText: 'OK', body: connection.body };
};

// ---------------------------------------------------------------------------
// The two ends.
// ---------------------------------------------------------------------------
const forwarder = new CloudEventForwarder();
forwarder.configure({
  getSettings: () => ({ enabled: true, baseUrl: 'https://fake.invalid' }),
  getAccessToken: async () => 'token',
  getClientId: () => 'desktop-1',
  fetchImpl: desktopFetch,
});

/**
 * \`PolledEventBus\`, reduced to the questions this circuit asks of it: is it running, and was
 * it asked for a one-off catch-up read?
 *
 * \`poll()\` is not optional padding. \`CloudEventBus.catchUp\` calls it on every \`gap\` frame,
 * inside the browser's read loop — so a fake without it throws there, and the throw takes the
 * whole SSE connection down until the reconnect. That is how this harness found out that a
 * gap frame reaches a browser far more often than an outage does: the desktop coalescing two
 * updates to one card IS a hole, by design, and it is reported as one.
 */
const polled = {
  paused: 0,
  resumed: 0,
  polls: 0,
  disposed: false,
  running: false,
  listeners: new Map(),
  pause() { this.paused++; this.running = false; },
  resume() { this.resumed++; this.running = true; },
  async poll() { this.polls++; },
  on(channel, cb) {
    this.listeners.set(channel, cb);
    return () => this.listeners.delete(channel);
  },
  dispose() { this.disposed = true; },
};

const gaps = [];
const errors = [];
const webBus = new CloudEventBus({
  polled,
  createStream: (handlers) =>
    new SseEventStream({
      apiBase: 'https://fake.invalid',
      getAccessToken: async () => 'token',
      fetchImpl: browserFetch,
      onError: (e) => errors.push(e),
      ...handlers,
      onGap: (gap) => {
        gaps.push(gap);
        handlers.onGap(gap);
      },
    }),
  graceMs: 60,
});

const seen = { 'session:event': [], 'task:changed': [], 'window:maximizedChanged': [] };
for (const channel of Object.keys(seen)) {
  webBus.on(channel, (payload) => seen[channel].push(payload));
}

/**
 * The one thing the real system does that this harness has to stand in for.
 *
 * \`CloudPoller\` learns the listener count from \`SyncResponse.eventListeners\` and hands it to
 * the forwarder; there is no poller here, so this is that hand-off, made explicit rather than
 * hidden inside a fake sync. Everything else on this wire is the real object.
 */
const tellDesktopWhoIsWatching = () => forwarder.setListeners(bus.listeners(ACCOUNT));

// --- 1. The gate: nothing is queued or sent until somebody is watching -------
{
  forwarder.publish('session:event', { runId: 'r0', event: { kind: 'assistant', text: 'unheard' } });
  await tick(160);
  check('an unwatched desktop posts nothing at all', posted.length === 0, JSON.stringify(posted));
}

// --- 2. The browser connects, and the desktop is told ------------------------
{
  await tick(30);
  check('the browser opened a stream', connections.length === 1);
  check('and the push channel reports itself live', webBus.isPushing === true);
  check('the server counts one listener', bus.listeners(ACCOUNT) === 1);
  tellDesktopWhoIsWatching();
}

// --- 3. Never both: a live stream pauses the poll fallback -------------------
{
  check('the fallback was paused, not unsubscribed', polled.paused > 0 && polled.running === false,
    'paused=' + polled.paused + ' running=' + polled.running);
  check('and it never started polling beside the stream', polled.resumed === 0);
  check('while still holding a subscription per watched channel — its baselines',
    polled.listeners.size === 3, String(polled.listeners.size));
}

// --- 4. An agent's line reaches the browser ---------------------------------
{
  forwarder.publish('session:event', { runId: 'r1', event: { kind: 'assistant', text: 'hello there' } });
  await tick(200);
  check('a session:event crossed the whole circuit',
    seen['session:event'].length === 1 &&
      seen['session:event'][0].event.text === 'hello there',
    JSON.stringify(seen['session:event']));
  check('and it went out as one POST /v1/events batch', posted.length === 1, String(posted.length));
}

// --- 5. A dropped channel never leaves the desktop --------------------------
{
  const before = posted.length;
  forwarder.publish('window:maximizedChanged', true);
  await tick(200);
  check('window:maximizedChanged is not forwarded at all',
    posted.length === before && seen['window:maximizedChanged'].length === 0);
}

// --- 6. Coalescing collapses one card, keeps two apart, and ADMITS to it ----
{
  const pollsBefore = polled.polls;
  const gapsBefore = gaps.length;
  const card = (id, title) => ({ task: { id, title }, runId: null });
  forwarder.publish('task:changed', card('t1', 'first draft'));
  forwarder.publish('task:changed', card('t1', 'second draft'));
  forwarder.publish('task:changed', card('t2', 'another card'));
  await tick(250);

  const ids = seen['task:changed'].map((c) => c.task.id);
  check('two updates to one card arrived as one', ids.filter((id) => id === 't1').length === 1,
    ids.join(','));
  check('and it is the NEWER of the two',
    seen['task:changed'].some((c) => c.task.title === 'second draft'),
    JSON.stringify(seen['task:changed']));
  check('two different cards did not collapse into each other', ids.includes('t2'), ids.join(','));

  // The half that is easy to forget: what was coalesced away is a hole, and the wire says so
  // rather than presenting three events as two. EventBatchRequest.gap on the way up, a gap
  // frame on the way down, one catch-up read at the far end.
  check('the batch admitted to the event it coalesced away',
    posted[posted.length - 1].gap === 1, JSON.stringify(posted[posted.length - 1].gap));
  check('which reached the browser as a gap frame, reason "sender"',
    gaps.length === gapsBefore + 1 && gaps[gaps.length - 1].reason === 'sender',
    JSON.stringify(gaps));
  check('and the browser answered it with exactly one catch-up read',
    polled.polls === pollsBefore + 1, String(polled.polls - pollsBefore));
  check('without starting the poll timer — the stream is still the live source',
    polled.running === false && polled.resumed === 0);
}

// --- 7. A payload over the cap arrives clipped, and still identifies itself --
{
  seen['session:event'].length = 0;
  forwarder.publish('session:event', {
    runId: 'r2',
    event: {
      kind: 'tool-use',
      name: 'Write',
      input: { file_path: '/repo/src/huge.ts', content: 'x'.repeat(200_000) },
    },
  });
  await tick(250);
  const got = seen['session:event'][0];
  check('an oversized event still arrives', Boolean(got));
  check('capped to the envelope budget', got && bytes(got) <= MAX_EVENT_BYTES,
    got ? String(bytes(got)) : 'n/a');
  check('with the file it was writing intact',
    got && got.event.input.file_path === '/repo/src/huge.ts');
  check('and saying what it lost', got && got.event.input.content.includes('characters'));
}

// --- 8. The heartbeat is not an event ---------------------------------------
{
  const before = seen['session:event'].length + seen['task:changed'].length;
  await tick(180); // three heartbeats at 50ms
  check('the : heartbeat produced no phantom event',
    seen['session:event'].length + seen['task:changed'].length === before);
  check('and the connection is still the one that was opened', connections.length === 1);
}

// --- 9. The server hangs up; the browser resumes from Last-Event-ID ---------
{
  seen['session:event'].length = 0;
  const gapsBeforeResume = gaps.length;
  connections[0].stream.close('lifetime');
  await tick(30);
  check('a bye left the push channel not-live', webBus.isPushing === false);

  // Published while nobody is connected. The account is inside its listener grace, so the
  // desktop is still told to forward — which is the whole reason the grace exists.
  tellDesktopWhoIsWatching();
  forwarder.publish('session:event', { runId: 'r3', event: { kind: 'assistant', text: 'while away' } });
  await tick(200);

  // SSE_RETRY_MIN_MS is a one-second FLOOR, so the server's own retry directive of 10ms is
  // clamped up to it — the reconnect cannot be hurried by making the fake server impatient.
  await tick(1_400);
  check('the browser reconnected', connections.length === 2, String(connections.length));
  check('the event published during the gap arrived on the new connection',
    seen['session:event'].some((e) => e.event.text === 'while away'),
    JSON.stringify(seen['session:event'].map((e) => e.event.text)));
  check('exactly once — the ring replayed it, it was not re-sent',
    seen['session:event'].filter((e) => e.event.text === 'while away').length === 1);
  check('and the resume reported no NEW hole', gaps.length === gapsBeforeResume,
    JSON.stringify(gaps));
}

// --- 10. A resume the server cannot honour admits to the hole ---------------
{
  // Straight at the bus rather than through the browser: the position has to be one this
  // process never issued, and the browser can only ever ask for one it was given.
  const orphan = bus.subscribe(ACCOUNT, 9_999);
  const drained = orphan.drain();
  check('a resume from an unknown id is refused', orphan.resumed === false);
  check('and the refusal is a countable-or-not gap, not silence',
    drained.gap !== null && drained.gap.reason === 'reset', JSON.stringify(drained.gap));
  orphan.close();
}

// --- 11. The fallback takes over when the stream cannot come back -----------
{
  const resumedBefore = polled.resumed;
  streamBroken = true;
  connections[connections.length - 1].stream.close('shutdown');
  // Long enough for the 60ms fallback grace AND for at least one reconnect attempt to be made
  // and refused — the attempt is what records a failure, and it does not happen for a second
  // (see the retry floor above). Two different clocks, one wait.
  await tick(1_800);
  check('a stream that stays down hands over to polling',
    polled.resumed > resumedBefore, 'resumed=' + polled.resumed);
  check('and the fallback is running for the first time in this run', polled.running === true);
  check('the bus says it is no longer pushing', webBus.isPushing === false);
  check('and the failures were reported rather than swallowed', errors.length > 0,
    String(errors.length));
}

// --- 12. Nobody watching drops the desktop's queue --------------------------
{
  webBus.dispose();
  await tick(30);
  forwarder.setListeners(0);
  const before = posted.length;
  forwarder.publish('session:event', { runId: 'r9', event: { kind: 'assistant', text: 'nobody home' } });
  await tick(200);
  check('a desktop told the audience left posts nothing more',
    posted.length === before, String(posted.length - before));
  check('and the fallback was disposed with the bus', polled.disposed === true);
}

forwarder.dispose();
for (const connection of connections) connection.stream.dispose();
console.log(failures === 0 ? '\\nAll push-channel checks passed.' : '\\n' + failures + ' check(s) failed.');
process.exit(failures === 0 ? 0 : 1);
`;

async function main() {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  try {
    // The scenario is a template literal, so a backtick written inside it — in prose, naming
    // a symbol, the way every other comment in this repo does — ENDS the template. What
    // reaches disk is then a truncated file, and Node reports it as a syntax error pointing
    // at whatever word followed. It cost two rounds here before this line existed. The
    // scenario is checked as SOURCE rather than as the interpolated string, because by the
    // time the string exists the damage has already been done silently.
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const scenarioBody = source.slice(
      source.indexOf('const SCENARIO = `') + 'const SCENARIO = `'.length,
      source.indexOf('\n`;\n'),
    );
    const stray = scenarioBody.split('\n').filter((line) => /(^|[^\\])`/.test(line));
    if (stray.length > 0) {
      throw new Error(
        `unescaped backtick inside SCENARIO — escape it as \\\` or reword:\n  ${stray.join('\n  ')}`,
      );
    }

    const entry = join(work, 'scenario.ts');
    writeFileSync(entry, SCENARIO, 'utf8');
    log('Driving an engine event from the desktop to a browser over real SSE bytes...\n');
    runUnderNode(await bundle(entry, join(work, 'out')));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  process.stderr.write(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
