/**
 * Headless verification for the sign-in gate (`@shared/auth`, `authGate.ts`, the
 * `SignInProbe` in `signIn.ts`) — the account-wide hold that stops the board when the
 * `claude` CLI can no longer authenticate, instead of every card discovering that
 * separately.
 *
 * Shaped exactly like `verify-limit-park.mjs`, for the same reason: the classifier
 * (`detectAuthFailure`) and the gate (`AuthGate`) are pure and unit-tested, but the
 * question a human actually has — **does a real failing run raise the gate, name the
 * right host, and come back on its own once that host's credential is touched?** — is
 * five or six things joined end to end (the CLI's stdout, `mapRawEvent`, the classifier,
 * `engageAuthFailure`, `SignInProbe`'s poll, `resumeAfterSignIn`). So this drives the REAL
 * engine against the REAL stdout of a fake CLI:
 *
 *  - a real SQLite store (`better-sqlite3`, hence Electron-as-Node — see the ABI check
 *    below and `native-abi.mjs`),
 *  - the real `Scheduler`, `SessionManager` and `SignInProbe`,
 *  - and a stub `claude` on PATH that ends its turn exactly the way the real CLI does on
 *    an expired OAuth session — an unambiguous CLI sentence, `terminal_reason: api_error`,
 *    and all-zero `usage` — but only once this script says so.
 *
 * What "the right host" means here is necessarily narrower than production: there is no
 * real WSL distro to fail in a headless run, so the one project this script drives is
 * `local`. That still exercises every line the ticket asks for — `AuthGate` carrying a
 * `target`, the banner's pure text helpers naming it, `SignInProbe` polling the credential
 * — because none of that branches on WHICH target it is holding, only on whether it is
 * `local`. The WSL-specific paths (`signInCommand`'s `wsl.exe` row, `credentialsStamp`'s
 * `host.exec` branch) are unit-tested instead, against a fake `ExecHost`, in
 * `signIn.test.ts` — the same split `verify-limit-park.mjs` draws around what a headless
 * script can and cannot reach.
 *
 * "The wrong host's credential" is stood in for by a decoy `.credentials.json` at a path
 * `credentialsStamp` never looks at — proving the poll is watching a SPECIFIC file, not
 * "any sign-in-shaped file anywhere". A stale copy of the REAL file (older than the gate's
 * `since`) proves the other half: existing is not enough, it has to be NEWER than the
 * failure. Touching the real file after that is what finally lifts it.
 *
 * The app is NEVER launched (RELEASE.md rule 6). Nothing outside the scratch directory is
 * written — `os.homedir()` is redirected into it (`USERPROFILE`/`HOME`) for the whole
 * Electron-as-Node process, so `credentialsPath()`'s default can never resolve to this
 * machine's real `~/.claude`.
 *
 *   pnpm exec node scripts/verify-signin-gate.mjs        # from apps/client
 *
 * Exits non-zero naming every failed assertion. Same bundle-then-run-under-Electron shape
 * as `scripts/verify-limit-park.mjs` and `scripts/verify-model-split.mjs`.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** `@shared` lives in the packages/shared workspace package, not under this app. */
const sharedSrc = join(repo, '..', '..', 'packages', 'shared', 'src');

/**
 * Everything this script writes lives here, INSIDE the repo rather than in the temp dir,
 * for one reason: the bundle keeps `better-sqlite3` external, so it must sit somewhere
 * Node's resolution can still find `node_modules`. Removed on the way out, and on the way
 * in — a crashed previous run must not leak into this one.
 */
const work = join(repo, '.verify-signin-gate');

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

/**
 * Run a bundle under Electron-as-Node, so `better_sqlite3.node` loads against its own ABI.
 *
 * `homeDir` is redirected here rather than in the scenario itself: `os.homedir()` is read
 * the moment `credentialsPath()`'s default parameter is evaluated, which has to happen
 * before this process' OWN `~/.claude` could ever be touched by anything under test.
 */
function runUnderElectron(bundlePath, homeDir) {
  const bin = existsSync(electronBin) ? electronBin : electronBinPosix;
  if (!existsSync(bin)) throw new Error(`No Electron binary at ${bin}`);
  const result = spawnSync(bin, [bundlePath], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      // Both names, so this works whichever `os.homedir()` reads on this OS.
      USERPROFILE: homeDir,
      HOME: homeDir,
    },
    encoding: 'utf8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${bundlePath} exited ${result.status ?? `on ${result.signal}`}`);
  }
}

// ---------------------------------------------------------------------------

/**
 * The one outcome the stub ever ends a turn with: the CLI's own unambiguous wording,
 * `terminal_reason: api_error` (deliberately NOT a distinct label — before this feature
 * every path downstream read only that label, which is why the real sentence sat unread
 * in `resultText` for as long as it did), and all-zero usage — a dead credential runs no
 * turns.
 */
const AUTH_FAILURE_TEXT = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const OUTCOME = {
  is_error: true,
  terminal_reason: 'api_error',
  result: AUTH_FAILURE_TEXT,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
};

/**
 * The fake `claude`, written as a `.cjs` the shim on PATH invokes.
 *
 * The FIRST invocation ends on {@link OUTCOME}; every one after that is a plain success,
 * so the resumed run started by the lifted gate has something to succeed at rather than
 * failing the same way twice. Both wait for this script to drop a `proceed-N` file before
 * ending their turn, which is what makes the scenario deterministic: assertions are made
 * at a known moment, never raced against a timer.
 */
function stubSource(logPath, proceedDir) {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    `const LOG = ${JSON.stringify(logPath)};`,
    `const PROCEED = ${JSON.stringify(proceedDir)};`,
    `const OUTCOME = ${JSON.stringify(OUTCOME)};`,
    'const argv = process.argv.slice(2);',
    'const arg = (name) => {',
    '  const i = argv.indexOf(name);',
    "  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : '';",
    '};',
    "const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    '',
    "fs.appendFileSync(LOG, JSON.stringify({ argv, cwd: process.cwd() }) + '\\n');",
    '// 1-based index of THIS invocation, read back from the log so the driver and the stub',
    '// agree on which run a `proceed-N` file releases. Runs never overlap here.',
    "const index = fs.readFileSync(LOG, 'utf8').trim().split('\\n').length;",
    '',
    'say({',
    "  type: 'system',",
    "  subtype: 'init',",
    "  session_id: arg('--session-id') || arg('--resume'),",
    "  model: arg('--model'),",
    '  cwd: process.cwd(),',
    "  permissionMode: arg('--permission-mode'),",
    '});',
    '',
    'const outcome =',
    '  index === 1',
    '    ? OUTCOME',
    "    : { is_error: false, terminal_reason: null, result: 'the stub finished run ' + index };",
    'const timer = setInterval(() => {',
    "  if (!fs.existsSync(PROCEED + '/proceed-' + index)) return;",
    '  clearInterval(timer);',
    '  say({',
    "    type: 'result',",
    "    subtype: outcome.is_error ? 'error_during_execution' : 'success',",
    '    is_error: outcome.is_error,',
    '    result: outcome.result,',
    '    terminal_reason: outcome.terminal_reason,',
    '    total_cost_usd: 0,',
    "    ...(outcome.usage ? { usage: outcome.usage } : {}),",
    '  });',
    '}, 20);',
    '',
    '// Never self-exit — the scheduler kills the process after `result`, exactly as it does',
    '// the real CLI. The backstop is only so a crashed driver leaves nothing behind.',
    'process.stdin.resume();',
    'setTimeout(() => process.exit(0), 120000);',
  ].join('\n');
}

/** Put the fake `claude` on disk, in the shape each platform resolves from PATH. */
function writeStubCli(binDir, stubPath, electron) {
  writeFileSync(
    join(binDir, 'claude.cmd'),
    ['@echo off', 'set ELECTRON_RUN_AS_NODE=1', `"${electron}" "${stubPath}" %*`, ''].join('\r\n'),
    'utf8',
  );
  const posix = join(binDir, 'claude');
  writeFileSync(
    posix,
    ['#!/bin/sh', `ELECTRON_RUN_AS_NODE=1 exec "${electron}" "${stubPath}" "$@"`, ''].join('\n'),
    'utf8',
  );
  try {
    chmodSync(posix, 0o755);
  } catch {
    // Windows has no execute bit; the `.cmd` above is what runs there.
  }
}

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

    const electron = existsSync(electronBin) ? electronBin : electronBinPosix;
    const posix = (p) => p.replace(/\\/g, '/');
    const scratch = join(work, 'scratch');
    // The redirected $HOME/%USERPROFILE% for the whole run — `credentialsPath()`'s
    // default resolves here, never into this machine's real profile.
    const home = join(work, 'home');
    const binDir = join(work, 'bin');
    const proceedDir = join(work, 'proceed');
    for (const dir of [scratch, join(home, '.claude'), binDir, proceedDir, join(scratch, 'repo')]) {
      mkdirSync(dir, { recursive: true });
    }
    const logPath = join(work, 'invocations.jsonl');
    writeFileSync(logPath, '', 'utf8');
    const stubPath = join(binDir, 'claude-stub.cjs');
    writeFileSync(stubPath, stubSource(posix(logPath), posix(proceedDir)), 'utf8');
    writeStubCli(binDir, stubPath, electron);
    log(`Stub claude written to ${binDir}`);

    const entry = join(work, 'entry.ts');
    writeFileSync(
      entry,
      SCENARIOS.replaceAll('__REPO__', posix(repo))
        .replaceAll('__SCRATCH__', posix(scratch))
        .replaceAll('__HOME__', posix(home))
        // Quoted by JSON so a Windows path's backslashes survive into the scenario's own
        // source, where a bare C:\Users\... would be read as escape sequences.
        .replaceAll('__BIN__', JSON.stringify(binDir))
        .replaceAll('__LOG__', posix(logPath))
        .replaceAll('__PROCEED__', posix(proceedDir)),
      'utf8',
    );
    log('\nRunning the scenario against the current code...');
    runUnderElectron(await bundle(entry, join(work, 'out')), home);

    log('\nAll scenarios passed.');
  } finally {
    if (process.argv.includes('--keep')) log(`\nLeft ${work} in place (--keep).`);
    else {
      try {
        // Retries because a killed stub's directory handle can outlive it by a moment on
        // Windows, and losing the run's verdict to an EBUSY on cleanup would be absurd.
        rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
      } catch (err) {
        log(`\nCould not remove ${work} (${err.code ?? err.message}); delete it by hand.`);
      }
    }
  }
}

/**
 * The scenario itself, as a template so the paths are baked in rather than passed.
 *
 * NO BACKTICKS below: this is a `String.raw` template, and one inside a comment closes it
 * with a SyntaxError pointing at a word in prose.
 */
const SCENARIOS = String.raw`
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describeAuthFailure, signInCommandText } from '@shared/auth';
import { PERSONAL_PROJECT_ID } from '@shared/model';
import { Scheduler } from '__REPO__/src/main/scheduler';
import { SessionManager } from '__REPO__/src/main/sessionManager';
import { createStore } from '__REPO__/src/main/store';
import { credentialsPath, SignInProbe } from '__REPO__/src/main/signIn';

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

const SCRATCH = '__SCRATCH__';
const HOME = '__HOME__';
const LOG = '__LOG__';
const PROCEED = '__PROCEED__';

// The one line that makes the fake CLI the real one for this process. Everything above it
// — the scheduler, the store, the classifier, the gate, the probe, the spawn — is the
// app's own code.
process.env.PATH = __BIN__ + delimiter + process.env.PATH;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what, predicate, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(20);
  }
  check('waited for ' + what, false, 'timed out after ' + timeoutMs + 'ms');
  return false;
}

/** Every invocation of the stub so far, oldest first. */
const invocations = () =>
  readFileSync(LOG, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

/** Wait for the Nth spawn (1-based) and hand it back. */
async function nthInvocation(n, what) {
  await waitFor(what, () => invocations().length >= n);
  return invocations()[n - 1] ?? { argv: [] };
}

/** Let run N end its turn, which is the moment everything under test happens. */
const proceed = (n) => writeFileSync(PROCEED + '/proceed-' + n, 'go', 'utf8');

/** Everything the card's timeline says, as one string. */
const timelineOf = (taskId) =>
  store
    .getTaskHistory(taskId)
    .map((e) => (typeof e.text === 'string' ? e.text : ''))
    .join('\n');

const store = createStore(SCRATCH + '/orchestrator.db');
// No auto-retry: an ordinary failure would otherwise relaunch instead of reaching the
// inbox — irrelevant to the auth path (it diverts before the retry ladder either way),
// kept only so a regression that stopped diverting would fail loudly instead of quietly
// retrying into the same wall.
store.saveSettings({ ...store.getSettings(), maxAutoRetries: 0, limitJitterMs: 0 });

const sessions = new SessionManager(() => {});
const authStates = [];
const taskChanges = [];
const raised = [];
const scheduler = new Scheduler(
  store,
  sessions,
  (change) => taskChanges.push(change),
  () => {},
  (item) => raised.push(item),
  () => {},
  () => {},
);

// Wired exactly as ipc.ts wires it: every gate change starts or stops the probe, and a
// short pollMs (instead of production's 20s) is the only difference — the poll ITSELF,
// and the >since comparison it makes, are the real code under test.
const probe = new SignInProbe({ onSignIn: () => scheduler.signedIn(), pollMs: 150 });
scheduler.setAuthNotifier((state) => {
  authStates.push(state);
  if (state) probe.start(state);
  else probe.stop();
});

/**
 * Whether this task run process is really gone — see verify-limit-park.mjs for why
 * activeRuns() cannot answer it.
 */
const runIsGone = (taskId) => taskChanges.some((c) => c.task.id === taskId && c.runId === null);

const CRED_PATH = credentialsPath(HOME);

// A STALE credential already sits where the real one lives — simulating the ordinary
// case (a login that has since expired) rather than "never signed in at all". Written
// well before the gate engages, so its mtime is unambiguously OLDER than the gate's
// \`since\` once the run below fails. (The directory already exists — the driver created
// it so \`credentialsPath()\`'s redirected HOME has somewhere to sit before Electron ever
// starts.)
writeFileSync(CRED_PATH, 'stale-credential', 'utf8');
await sleep(300);

// No WorktreeManager on purpose: every run happens in the project directory, and no
// branch or worktree is created anywhere.
const agent = store.addProject({
  path: SCRATCH + '/repo',
  name: 'the sign-in repo',
  kind: 'agent',
  defaultModel: 'sonnet',
  defaultPermissionMode: 'acceptEdits',
  useWorktrees: false,
});
check('the project defaults to the local host', agent.target.kind === 'local', agent.target.kind);

function card(title) {
  const created = store.createTask(PERSONAL_PROJECT_ID, { title });
  if (!created) throw new Error('the store refused ' + title);
  const updated = store.updateTask(created.id, { agentProjectId: agent.id });
  if (!updated) throw new Error('the store refused the patch for ' + title);
  return updated;
}

// ===========================================================================
section('1. A dead credential raises the gate, carrying the failing host');

const worker = card('Refactor the widget');
scheduler.runTask(worker.id);
await nthInvocation(1, 'the first run to spawn');
const engagedAt = Date.now();
proceed(1);

await waitFor('the gate to engage', () => scheduler.currentAuth() !== null);

const gate = scheduler.currentAuth();
check('the gate is up', gate !== null);
check(
  'it carries the CLI own sentence, not just the api_error label',
  gate !== null && gate.reason === ${JSON.stringify(AUTH_FAILURE_TEXT)},
  gate === null ? 'no gate' : gate.reason,
);
check(
  'it holds the run that proved it',
  gate !== null && gate.parkedTaskIds.includes(worker.id),
  gate === null ? 'no gate' : JSON.stringify(gate.parkedTaskIds),
);
check(
  'it names the LOCAL host — the only project this headless run can drive',
  gate !== null && (gate.target === undefined || gate.target.kind === 'local'),
  gate === null ? 'no gate' : JSON.stringify(gate.target),
);
check(
  'the card is parked, plain pending — not filed as a failure of its own',
  store.getTask(worker.id).status === 'pending',
  store.getTask(worker.id).status,
);
check(
  'NO task-failed item was raised against the card',
  !raised.some((i) => i.taskId === worker.id),
  JSON.stringify(raised.map((i) => i.kind)),
);
check(
  'the card timeline says an account-wide sign-in is why',
  /could not authenticate/i.test(timelineOf(worker.id)),
  timelineOf(worker.id).slice(-200),
);
await waitFor('the failed run to exit', () => runIsGone(worker.id));

// ---------------------------------------------------------------------------
section('2. The banner text names the host and the command that fixes it');

check(
  'describeAuthFailure reads the LIVE gate — no restored-gate caveat this session',
  describeAuthFailure(gate) === 'Claude could not authenticate: ' + ${JSON.stringify(AUTH_FAILURE_TEXT)},
  describeAuthFailure(gate),
);
check(
  'signInCommandText is the bare CLI for a local gate',
  signInCommandText(gate.target) === 'claude',
  signInCommandText(gate.target),
);

// ---------------------------------------------------------------------------
section('3. Touching the WRONG credential does not lift it');

// A decoy at a path credentialsStamp never looks at — standing in for "a different
// host's" credential, since there is no real WSL distro to fail in this headless run.
const decoyClaude = join(SCRATCH, 'decoy-home', '.claude');
mkdirSync(decoyClaude, { recursive: true });
writeFileSync(join(decoyClaude, '.credentials.json'), 'not-the-one', 'utf8');
await sleep(500); // several poll intervals at pollMs=150

check(
  'the gate is still up — a decoy at a path credentialsStamp never looks at changes nothing',
  scheduler.currentAuth() !== null,
);
check(
  'and the STALE real file (present since before the failure) did not lift it either — ' +
    'only a stamp NEWER than the gate does',
  scheduler.currentAuth() !== null,
  'the gate cleared on a stale file, which the >since rule exists to prevent',
);

// ---------------------------------------------------------------------------
section('4. Touching the RIGHT credential lifts it, and the parked card restarts');

// A fresh write — mtime now, unambiguously after \`engagedAt\`.
writeFileSync(CRED_PATH, 'fresh-credential', 'utf8');
const freshStamp = new Date();
utimesSync(CRED_PATH, freshStamp, freshStamp);
check('the fresh write really is newer than the gate', freshStamp.getTime() > engagedAt);

await waitFor('the probe to notice and lift the gate', () => scheduler.currentAuth() === null);
check('the gate is down', scheduler.currentAuth() === null);
check(
  'and the banner was told the wait is over',
  authStates.length > 0 && authStates[authStates.length - 1] === null,
  JSON.stringify(authStates[authStates.length - 1]),
);

const before = invocations().length;
await waitFor('the parked card to restart', () => invocations().length > before);
const resumedArgv = invocations()[invocations().length - 1].argv;
check(
  'it was RESUMED, not restarted from nothing — same conversation, not a fresh one',
  resumedArgv.includes('--resume'),
  JSON.stringify(resumedArgv),
);
// A board card's OWN status is the human's (\`cardStatusGuard.ts\`) — the run only borrows
// the field while it is live and hands back whatever the card rested at before, which for
// a freshly delegated card is \`pending\`. So \`running\` is not immediate here (the scheduler
// sets it once it has processed the child's own startup event, a beat after the log file
// the spawn already wrote to), and it is not the FINAL word either.
await waitFor(
  'the resumed run to actually be live',
  () => store.getTask(worker.id).status === 'running',
);

// Let the resumed run finish too, so the process is cleanly gone before the store closes,
// and so the resting status a human would actually see is provable, not assumed.
proceed(invocations().length);
await waitFor(
  'the resumed run to hand the card back to its resting status',
  () => store.getTask(worker.id).status === 'pending',
);
check(
  'it finished as ordinary work, back at the SAME resting status the card started at — ' +
    'the run never moved the card',
  store.getTask(worker.id).status === 'pending',
  store.getTask(worker.id).status,
);
check(
  'and the gate did not re-engage behind it',
  scheduler.currentAuth() === null,
  JSON.stringify(scheduler.currentAuth()),
);
check(
  'exactly two CLI launches total — the failure and the one resume, no retry loop',
  invocations().length === 2,
  invocations().length,
);

// ===========================================================================
probe.stop();
scheduler.dispose();
sessions.stopAll();
await sleep(750);
store.close();

console.log('');
console.log(invocations().length + ' CLI invocation(s) observed.');
if (failures > 0) {
  console.error(failures + ' check(s) failed.');
  process.exit(1);
}
`;

await main();
