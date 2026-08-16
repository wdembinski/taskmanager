/**
 * Headless verification for the SECOND way a usage limit arrives: a run that merely
 * FAILED, with the reason only in its text.
 *
 * `detectLimitFailure` and `decideLimitPark` are pure and unit-tested, and
 * `scheduler.test.ts` proves the engine parks when they say to. Neither can answer the
 * question a human actually has — **does a real CLI ending on that sentence park the board
 * instead of blaming the card?** — because that answer is five things joined end to end:
 * the CLI's stdout, `mapRawEvent`, the classifier, the ladder, and `engageLimit`. A fake
 * `SessionManager` handed a hand-built `result` event stops two links short of the wire.
 *
 * So this drives the REAL engine against the REAL stdout of a fake CLI:
 *
 *  - a real SQLite store (`better-sqlite3`, which only loads under Electron's ABI — the
 *    reason this lives here rather than in the vitest suite),
 *  - the real `Scheduler` and `SessionManager`,
 *  - and a **stub `claude` on PATH**, which speaks the two stream-json lines the app reads
 *    and then ends its turn the way the CLI does when the account runs out of budget —
 *    but only once this script says so, so every assertion is made at a known moment and
 *    nothing races on a timer.
 *
 * The two runs are the whole point, and they differ ONLY in the text:
 *
 *   1. an agent's paragraph *about* usage limits — a card doing exactly the work this
 *      feature is: it must park as an ordinary failure, with the gate left down;
 *   2. the CLI's own sentence with its trailing epoch — the account is out of budget:
 *      the card lands `blocked-by-limit`, the gate is up with that epoch as its
 *      `resetsAt`, and **no** `task-failed` row is ever written against the card.
 *
 * Then a third card is Started while the gate is up, to prove the wall holds the queue
 * rather than merely marking the run that hit it.
 *
 * A fourth card is DELEGATED to an agent project against that same standing gate — the
 * thing this phase is about, since a human may perfectly well hand a card to an agent while
 * the account is walled — and then the gate is lifted, which is the half nothing else here
 * covers: a park is only worth anything if the reset actually starts what it was holding.
 * All three held cards must come back, including the two that never had a session to rejoin.
 *
 * The app is NEVER launched (RELEASE.md rule 6 — there is no single-instance lock, and a
 * second instance killed a live session on 2026-08-02). Nothing outside the scratch
 * directory is written: no real profile, no git repository, no network. `hostFor` returns
 * the local host for a project with no target, so the stub is reached through exactly the
 * spawn the app uses (`shell: true`, which is how Windows resolves a `claude.cmd` at all).
 *
 *   pnpm exec node scripts/verify-limit-park.mjs        # from apps/client
 *
 * Exits non-zero naming every failed assertion. Same bundle-then-run-under-Electron shape
 * as `scripts/verify-model-split.mjs`, whose comments explain the ABI dance.
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
const work = join(repo, '.verify-limit-park');

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

/**
 * When the limit "resets", as a unix epoch in seconds — the field the CLI puts after the
 * pipe, and the only reset time this path can ever learn.
 *
 * Computed here rather than hard-coded so it is always in the FUTURE: a gate whose
 * `resumeAt` has already passed fires its timer at once and resumes everything, which
 * would tear down the very state the assertions are about. An hour is longer than any run
 * of this script and short enough to be obviously a test value.
 *
 * Exactly ten digits until the year 2286, which is what `LIMIT_WITH_EPOCH` matches.
 */
const RESETS_AT = Math.floor(Date.now() / 1000) + 3600;

/**
 * What each invocation of the stub ends its turn with, in order. Both are failures wearing
 * the CLI's usual label for this, `api_error` — which is deliberately NOT one of the
 * classifier's limit labels, so in both runs the TEXT is the only thing that can decide.
 * That is the comparison the whole script exists to make.
 */
const OUTCOMES = [
  {
    // A card doing this feature's own work, reporting on it. It contains the phrase, and
    // it is a paragraph — the case a bare substring test would park the whole board over.
    is_error: true,
    terminal_reason: 'api_error',
    result: [
      'I finished the write-up of how the orchestrator handles a usage limit. The section',
      'now explains that when Claude AI usage limit reached appears at the end of a run,',
      'the account rather than the card is out of budget, that the gate holds every project',
      'until the window resets, and that a weekly limit is waited out differently from a',
      'rolling five-hour one. I could not commit it because the sandbox went away mid-edit.',
    ].join(' '),
  },
  {
    // The CLI's own machine-readable form: the sentence and nothing else, with the reset
    // time after a pipe. Believed on sight — no agent writes a bare epoch like that.
    is_error: true,
    terminal_reason: 'api_error',
    result: `Claude AI usage limit reached|${RESETS_AT}`,
  },
];

/**
 * The fake `claude`, written as a `.cjs` the shim on PATH invokes.
 *
 * It does three things and no more: record its argv, speak the two stream-json lines
 * `mapRawEvent` reads, and wait for this script to drop a `proceed-N` file before ending
 * its turn with the Nth entry of {@link OUTCOMES}. That wait is what makes the scenario
 * deterministic: a run that settled the instant it started would have parked (or failed)
 * before the assertions about it being open had been made, and the driver would be reading
 * the previous run's state without knowing it.
 *
 * Anything past the outcomes is a plain success, so an unexpected extra spawn shows up as
 * the count assertion it is rather than as a second limit.
 */
function stubSource(logPath, proceedDir) {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    `const LOG = ${JSON.stringify(logPath)};`,
    `const PROCEED = ${JSON.stringify(proceedDir)};`,
    `const OUTCOMES = ${JSON.stringify(OUTCOMES)};`,
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
    'const outcome = OUTCOMES[index - 1] || {',
    '  is_error: false,',
    '  terminal_reason: null,',
    "  result: 'the stub finished run ' + index,",
    '};',
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

    const electron = existsSync(electronBin) ? electronBin : electronBinPosix;
    const posix = (p) => p.replace(/\\/g, '/');
    const scratch = join(work, 'scratch');
    const binDir = join(work, 'bin');
    const proceedDir = join(work, 'proceed');
    for (const dir of [scratch, binDir, proceedDir, join(scratch, 'repo')]) {
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
        // Quoted by JSON so a Windows path's backslashes survive into the scenario's own
        // source, where a bare C:\Users\... would be read as escape sequences.
        .replaceAll('__BIN__', JSON.stringify(binDir))
        .replaceAll('__LOG__', posix(logPath))
        .replaceAll('__PROCEED__', posix(proceedDir))
        .replaceAll('__RESETS_AT__', String(RESETS_AT)),
      'utf8',
    );
    log('\nRunning the scenarios against the current code...');
    runUnderElectron(await bundle(entry, join(work, 'out')));

    log('\nAll scenarios passed.');
  } finally {
    // `--keep` leaves the bundle, the invocation log and the scratch database behind, which
    // is the only way to open one afterwards and see what a failing scenario actually did.
    if (process.argv.includes('--keep')) log(`\nLeft ${work} in place (--keep).`);
    else {
      try {
        // Retries because a killed stub's directory handle can outlive it by a moment on
        // Windows, and losing the run's verdict to an EBUSY on cleanup would be absurd.
        rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
      } catch (err) {
        // A scenario that threw never reached `sessions.stopAll()`, so a stub is still
        // holding the scratch directory open and no number of retries will win. Say where
        // it is and let the real error stand — swallowing THIS one is the point, since it
        // would otherwise replace the failure that caused it.
        log(`\nCould not remove ${work} (${err.code ?? err.message}); delete it by hand.`);
      }
    }
  }
}

/**
 * The scenarios themselves, as a template so the paths are baked in rather than passed —
 * a bundle takes no argv worth threading, and every path in it is scratch.
 *
 * NO BACKTICKS below: this is a `String.raw` template, and one inside a comment closes it
 * with a SyntaxError pointing at a word in prose.
 */
const SCENARIOS = String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';
import { PERSONAL_PROJECT_ID } from '@shared/model';
import { CARD_RECORDS_PARK, isParkedRefusal } from '@shared/scheduler';
import { Scheduler } from '__REPO__/src/main/scheduler';
import { SessionManager } from '__REPO__/src/main/sessionManager';
import { createStore } from '__REPO__/src/main/store';

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
const LOG = '__LOG__';
const PROCEED = '__PROCEED__';
const RESETS_AT = __RESETS_AT__;

// The one line that makes the fake CLI the real one for this process. Everything above it
// — the scheduler, the store, the classifier, the gate, the spawn — is the app's own code.
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

/** The persisted inbox rows for one task — what survives a restart, not just the map. */
const storedItemsFor = (taskId) =>
  store.listAttention().filter((row) => row.item.taskId === taskId);

/** Everything the card's timeline says, as one string. */
const timelineOf = (taskId) =>
  store
    .getTaskHistory(taskId)
    .map((e) => (typeof e.text === 'string' ? e.text : ''))
    .join('\n');

const store = createStore(SCRATCH + '/orchestrator.db');
// Two settings, both to remove randomness rather than to change behaviour: no auto-retry,
// so an ordinary failure reaches the inbox on its first attempt instead of relaunching the
// stub behind the assertions; and no jitter, so the gate's resume time is exactly the reset
// time and can be compared against the epoch the CLI printed.
store.saveSettings({ ...store.getSettings(), maxAutoRetries: 0, limitJitterMs: 0 });

const sessions = new SessionManager(() => {});
const raised = [];
const resolvedItems = [];
const limits = [];
const taskChanges = [];
const scheduler = new Scheduler(
  store,
  sessions,
  (change) => taskChanges.push(change),
  () => {},
  (item) => raised.push(item),
  (id) => resolvedItems.push(id),
  (state) => limits.push(state),
);

/**
 * Whether this task run process is really gone.
 *
 * activeRuns() cannot answer it: a run is marked settled the moment its turn ends, so it
 * drops out of that list while its process is still being killed and its entry is still in
 * the scheduler runs map — where the next gate would park it as a casualty. The honest
 * signal is the empty patch the exited handler emits AFTER deleting the run, which is the
 * only task change a run ever emits with no runId on it.
 */
const runIsGone = (taskId) =>
  taskChanges.some((c) => c.task.id === taskId && c.runId === null);

// No WorktreeManager on purpose: every run then happens in the project directory. Nothing
// here is about where git puts the work, and it keeps the script from creating a single
// branch or worktree anywhere. No usage probe either (setUsageProbe is never called) —
// that is the "no reading" case, which is what a machine with no CLI to ask would see.
const agent = store.addProject({
  path: SCRATCH + '/repo',
  name: 'the limit repo',
  kind: 'agent',
  defaultModel: 'sonnet',
  defaultPermissionMode: 'acceptEdits',
  useWorktrees: false,
});

/** A card on the Personal board, delegated to that agent project. */
function card(title) {
  const created = store.createTask(PERSONAL_PROJECT_ID, { title });
  if (!created) throw new Error('the store refused ' + title);
  const updated = store.updateTask(created.id, { agentProjectId: agent.id });
  if (!updated) throw new Error('the store refused the patch for ' + title);
  return updated;
}

// ===========================================================================
section('1. An agent WRITING about usage limits is still the card own failure');

const writer = card('Write up how the usage limit works');
scheduler.runTask(writer.id);
await nthInvocation(1, 'the write-up run to spawn');
check(
  'its run is live and the card says so',
  store.getTask(writer.id).status === 'running',
  store.getTask(writer.id).status,
);

// The turn now ends on a paragraph that CONTAINS the phrase. A substring test would read
// this as the account being out of budget and stop every project.
proceed(1);
await waitFor('the failure to reach the inbox', () =>
  raised.some((i) => i.taskId === writer.id && i.kind === 'task-failed'),
);

const writerItem = raised.find((i) => i.taskId === writer.id);
check(
  'it parked as an ordinary failure, filed against the card',
  writerItem !== undefined && writerItem.kind === 'task-failed',
  writerItem === undefined ? 'nothing was raised' : writerItem.kind,
);
check(
  'and named the CLI reason, not a limit',
  writerItem !== undefined && /api_error/.test(writerItem.prompt),
  writerItem === undefined ? 'nothing was raised' : writerItem.prompt,
);
check(
  'the card waits for a human',
  store.getTask(writer.id).status === 'waiting-input',
  store.getTask(writer.id).status,
);
check(
  'the row is persisted, so a restart still offers the choice',
  storedItemsFor(writer.id).some((row) => row.item.kind === 'task-failed'),
);

// The half that matters most: the account was never blamed.
check('NO gate went up', scheduler.currentLimit() === null, JSON.stringify(scheduler.currentLimit()));
check(
  'nothing was persisted for a restart to restore either',
  store.loadLimitGate() === null,
  JSON.stringify(store.loadLimitGate()),
);
check(
  'and the banner was never told about a limit',
  limits.length === 0,
  JSON.stringify(limits),
);

// The run has to be fully gone before the next one, or the gate below would park a process
// that is only still in the map because Windows has not reaped it yet — and then the
// section-2 assertion that this card was left alone would be measuring the wrong thing.
await waitFor('the failed run to exit', () => runIsGone(writer.id));

// ---------------------------------------------------------------------------
section('2. The CLI own sentence parks the ACCOUNT, and never the card');

const worker = card('Refactor the widget');
scheduler.runTask(worker.id);
await nthInvocation(2, 'the refactor run to spawn');
proceed(2);

await waitFor(
  'the card to be parked behind the gate',
  () => store.getTask(worker.id).status === 'blocked-by-limit',
);

const gate = scheduler.currentLimit();
check('the gate is up', gate !== null);
check(
  'it parsed the reset time out of the sentence',
  gate !== null && gate.resetsAt === RESETS_AT,
  gate === null ? 'no gate' : String(gate.resetsAt) + ' != ' + String(RESETS_AT),
);
check(
  'it read the limit as rolling — weekly is claimed only when the wording says so',
  gate !== null && gate.limitType === 'rolling',
  gate === null ? 'no gate' : gate.limitType,
);
check(
  'it will resume at that reset time (jitter is 0 here), not five hours from now',
  gate !== null && gate.resumeAt === RESETS_AT * 1000,
  gate === null ? 'no gate' : String(gate.resumeAt) + ' != ' + String(RESETS_AT * 1000),
);
check(
  'the run that hit the wall is what it holds',
  gate !== null && gate.parkedTaskIds.includes(worker.id),
  gate === null ? 'no gate' : JSON.stringify(gate.parkedTaskIds),
);
check(
  'the banner was told',
  limits.length > 0 && limits[limits.length - 1] !== null,
  JSON.stringify(limits),
);
check(
  'and it is persisted, so a restart comes back still holding the work',
  (store.loadLimitGate() ?? {}).resetsAt === RESETS_AT,
  JSON.stringify(store.loadLimitGate()),
);

// The claim this whole path exists to make.
check(
  'NO task-failed was raised against the card',
  !raised.some((i) => i.taskId === worker.id && i.kind === 'task-failed'),
  JSON.stringify(raised.filter((i) => i.taskId === worker.id).map((i) => i.kind)),
);
check(
  'and none was written to the database either',
  storedItemsFor(worker.id).length === 0,
  JSON.stringify(storedItemsFor(worker.id).map((row) => row.item.kind)),
);
check(
  'the card is not left silent — its timeline says the account hit its limit',
  /usage limit/i.test(timelineOf(worker.id)),
  timelineOf(worker.id).slice(-200),
);
// The process is ENDED, not merely marked: a limit resumes by spawning a fresh --resume at
// reset time, so a session left running behind the gate is one nobody is paying attention to.
await waitFor('the parked run process to end', () => runIsGone(worker.id));
check(
  'the run was ended rather than left spinning',
  runIsGone(worker.id) && scheduler.activeRuns().every((r) => r.taskId !== worker.id),
  JSON.stringify(scheduler.activeRuns().map((r) => r.taskId)),
);
check(
  'and the card is STILL parked afterwards — its exit did not undo the park',
  store.getTask(worker.id).status === 'blocked-by-limit',
  store.getTask(worker.id).status,
);

// The limit takes back only what the limit caused: the earlier card failed on its own and
// its inbox item is still there to answer.
check(
  'the OTHER card failure was left alone',
  storedItemsFor(writer.id).some((row) => row.item.kind === 'task-failed'),
  JSON.stringify(storedItemsFor(writer.id).map((row) => row.item.kind)),
);

// ---------------------------------------------------------------------------
section('3. While the gate is up, Start parks rather than spawning');

const next = card('Something else entirely');
const outcome = scheduler.startTaskNow(next.id);
check(
  'the app refuses, and says a usage limit is why',
  outcome.refused === 'limit',
  JSON.stringify(outcome),
);
check(
  'the card is parked, not dropped — the gate is the only thing that remembers work',
  store.getTask(next.id).status === 'blocked-by-limit',
  store.getTask(next.id).status,
);
check(
  'so the resume will name it',
  (scheduler.currentLimit() ?? { parkedTaskIds: [] }).parkedTaskIds.includes(next.id),
  JSON.stringify(scheduler.currentLimit()),
);

// Nothing was launched into the wall. A generous pause first: a spawn that was going to
// happen would have happened by now.
await sleep(500);
check(
  'and no third CLI was spawned',
  invocations().length === 2,
  invocations().length + ' invocation(s)',
);

// ---------------------------------------------------------------------------
section('4. A card DELEGATED into the wall is queued, and the reset starts it');

/**
 * What this section can and cannot reach.
 *
 * The task:assignAgent handler itself is not called: ipc.ts needs Electron ipcMain, and
 * registerIpcHandlers builds its OWN store, scheduler and background pollers — one of which
 * (ClaudeUsagePoller) spawns the CLI on its own clock and would put invocations in the log
 * that every count above asserts the absence of. So what runs here is what the handler runs,
 * in its order: the assignment patch it writes before it starts anything (ipc.ts:884), the
 * startTaskNow it calls, the re-read it hands back, and the shared rule it branches on —
 * isReportablePark IS the two imports below, so flipping CARD_RECORDS_PARK.limit turns
 * "resolves" back into "throws" here exactly as it does there. The handler own two lines are
 * covered by their premises rather than executed.
 */
const delegated = store.createTask(PERSONAL_PROJECT_ID, { title: 'Delegate this into the wall' });
if (!delegated) throw new Error('the store refused the delegated card');
check(
  'the new card is unassigned and unheld to begin with',
  !delegated.agentProjectId && delegated.status !== 'blocked-by-limit',
  delegated.status + ' / ' + JSON.stringify(delegated.agentProjectId),
);

// The delegation lands on the card BEFORE anything is started, which is the whole reason a
// wall cannot turn it into a failed assignment: by the time the gate answers, the card
// already belongs to the agent project.
const assigned = store.updateTask(delegated.id, {
  agentProjectId: agent.id,
  projectTagId: agent.id,
  agentMode: null,
  agentModel: null,
  agentBranch: null,
  sessionId: null,
});
check(
  'the assignment stuck',
  assigned !== null && assigned.agentProjectId === agent.id,
  JSON.stringify(assigned === null ? null : assigned.agentProjectId),
);

const assignOutcome = scheduler.startTaskNow(delegated.id);
const assignRefusal = 'refused' in assignOutcome ? assignOutcome.refused : null;
check(
  'the start is held by the standing gate',
  assignRefusal === 'limit',
  JSON.stringify(assignOutcome),
);
check(
  'and that refusal is a park the CARD records — which is what lets the handler RESOLVE',
  assignRefusal !== null && isParkedRefusal(assignRefusal) && CARD_RECORDS_PARK[assignRefusal],
  JSON.stringify(assignRefusal),
);
// Why the handler re-reads instead of returning the row it already had: the park is written
// DURING startTaskNow, so the row it fetched a moment earlier still says nothing is held.
check(
  'the row fetched before the start does NOT yet say the card is held',
  assigned !== null && assigned.status !== 'blocked-by-limit',
  assigned === null ? 'no row' : assigned.status,
);
const rereadDelegated = store.getTask(delegated.id);
check(
  'the card the handler hands back explains itself: blocked-by-limit',
  rereadDelegated.status === 'blocked-by-limit',
  rereadDelegated.status,
);
check(
  'and the gate ON DISK names it, so the reset will come for it',
  ((store.loadLimitGate() ?? {}).parkedTaskIds ?? []).includes(delegated.id),
  JSON.stringify(store.loadLimitGate()),
);
await sleep(400);
check(
  'delegating started no CLI of its own',
  invocations().length === 2,
  invocations().length + ' invocation(s)',
);

// ---------------------------------------------------------------------------
// The reset. resumeLimitNow is what the banner "Resume now" hits, and what the gate's
// own timer does an hour from now — the same lift either way. A park is only worth
// something if this actually starts the work again, and the two cards that never ran have
// nothing to resume BY: no session id, and (for the delegated one) no recipe either.
const before = invocations().length;
scheduler.resumeLimitNow();

await waitFor('the reset to start the parked cards', () => invocations().length >= before + 3);
await sleep(400);
check(
  'exactly the three cards the gate held were started, and nothing else',
  invocations().length === before + 3,
  invocations().length - before + ' new invocation(s)',
);

/**
 * The argv of the run the reset started for one card, or null if it started none.
 *
 * Matched on the session id the CLI echoed back onto the task, because that is the only
 * thing in an argv that names a task at all — the prompt goes over stdin, and all three runs
 * share one cwd.
 */
async function resumedArgv(task, what) {
  await waitFor(what + ' to be running again', () => {
    const live = store.getTask(task.id);
    return live.status === 'running' && typeof live.sessionId === 'string';
  });
  const sessionId = store.getTask(task.id).sessionId;
  const found = invocations()
    .slice(before)
    .find((inv) => inv.argv.includes(sessionId));
  return found ? found.argv : null;
}

const delegatedArgv = await resumedArgv(delegated, 'the delegated card');
check(
  'the card delegated into the wall got its own CLI at the reset',
  delegatedArgv !== null,
  JSON.stringify(store.getTask(delegated.id).status),
);
const nextArgv = await resumedArgv(next, 'the card Started against the gate');
check('so did the card a human Started against the gate', nextArgv !== null, JSON.stringify(nextArgv));
check(
  'and it opened a FRESH session — it never had one to resume',
  nextArgv !== null && nextArgv.includes('--session-id') && !nextArgv.includes('--resume'),
  JSON.stringify(nextArgv),
);
const workerArgv = await resumedArgv(worker, 'the card that hit the wall');
check(
  'while the card that DID run is rejoined by --resume, not restarted from nothing',
  workerArgv !== null && workerArgv.includes('--resume'),
  JSON.stringify(workerArgv),
);

check('the gate is down', scheduler.currentLimit() === null, JSON.stringify(scheduler.currentLimit()));
check(
  'its row is gone from app_state, so a restart comes back holding nothing',
  store.loadLimitGate() === null,
  JSON.stringify(store.loadLimitGate()),
);
check(
  'and the banner was told the wait is over',
  limits.length > 0 && limits[limits.length - 1] === null,
  JSON.stringify(limits[limits.length - 1]),
);
check(
  'no card was left behind blocked-by-limit',
  [worker, next, delegated].every((t) => store.getTask(t.id).status !== 'blocked-by-limit'),
  JSON.stringify([worker, next, delegated].map((t) => store.getTask(t.id).status)),
);

// ===========================================================================
// Kill every stub still waiting on a proceed file before the database is closed. The pause
// is for Windows: termination is a taskkill of its own, and a stub whose CWD is the project
// directory keeps that directory locked until it is really gone.
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
