/**
 * Headless verification for the planning/execution model split (Phase 23).
 *
 * `resolveRunModel` is pure and unit-tested, and `scheduler.test.ts` proves that a run
 * born in `startTask` carries the model the ladder chose. Neither can answer the only
 * question a human actually has — **does the CLI get `--model opus`?** — because that
 * answer is produced by four things joined end to end: the ladder, the run's captured
 * model, `buildClaudeArgs`, and the spawn. A fake `SessionManager` that records a
 * `StartSessionRequest` would stop one link short of the argument being asserted.
 *
 * So this drives the REAL engine and observes the REAL argv:
 *
 *  - a real SQLite store (`better-sqlite3`, which only loads under Electron's ABI —
 *    the reason this lives here rather than in the vitest suite),
 *  - the real `Scheduler` and `SessionManager`,
 *  - and a **stub `claude` on PATH**, which appends its own argv to a log and then
 *    behaves like the CLI: a `plan`-mode run calls `ExitPlanMode` with a plan, any
 *    other run reports a `result` — but only once this script says so, so every
 *    assertion is made while its run is still open and nothing races.
 *
 * The scenario walks one card through the whole split: it is planned, its plan is
 * approved into steps, the chain runs them, and the card is handed back for review.
 * Each of those spawns is a different rung of the ladder, and the model on the command
 * line is what is asserted at every rung.
 *
 * The app is NEVER launched (RELEASE.md rule 6 — there is no single-instance lock, and a
 * second instance killed a live session on 2026-08-02). Nothing outside the scratch
 * directory is written: no real profile, no git repository, no network. `hostFor` returns
 * the local host for a project with no target, so the stub is reached through exactly the
 * spawn the app uses (`shell: true`, which is how Windows resolves a `claude.cmd` at all).
 *
 *   pnpm exec node scripts/verify-model-split.mjs
 *
 * Exits non-zero on the first failed assertion, naming it. Same bundle-then-run-under-
 * Electron shape as `scripts/verify-round.mjs`, whose comments explain the ABI dance.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Everything this script writes lives here, INSIDE the repo rather than in the temp dir,
 * for one reason: the bundle keeps `better-sqlite3` external, so it must sit somewhere
 * Node's resolution can still find `node_modules`. Removed on the way out, and on the way
 * in — a crashed previous run must not leak into this one.
 */
const work = join(repo, '.verify-model-split');

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
    resolve: { alias: { '@shared': join(repo, 'src', 'shared'), electron: stub } },
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
 * The plan the stub "produces". Three `##` sections plus one framing heading, so
 * `splitPlanIntoSteps` yields exactly three steps and drops the Overview — the app's own
 * grammar decides that, which is why the plan is written the way a model would write one
 * rather than trimmed to what the assertions want.
 */
const PLAN = [
  '# Rename the widget',
  '',
  '## Overview',
  '',
  'Framing, not work. The splitter drops this heading.',
  '',
  '## Phase 1 — Rename the type',
  '',
  'Change the type and every reference to it.',
  '',
  '## Phase 2 — Update the callers',
  '',
  'Fix the call sites the rename broke.',
  '',
  '## Phase 3 — Refresh the tests',
  '',
  'Rewrite the tests that named the old type.',
].join('\n');

/**
 * The fake `claude`, written as a `.cjs` the shim on PATH invokes.
 *
 * It does three things and no more: record its argv (the whole point), speak the two
 * stream-json lines `mapRawEvent` reads, and — for anything that is not a planning run —
 * wait for this script to drop a `proceed-N` file before reporting `result`. That wait is
 * what makes the scenario deterministic: a step that settled the instant it started would
 * advance the chain before the assertions on it had been made, and the next step's model
 * could not be set in time to be observed.
 */
function stubSource(logPath, proceedDir) {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    `const LOG = ${JSON.stringify(logPath)};`,
    `const PROCEED = ${JSON.stringify(proceedDir)};`,
    `const PLAN = ${JSON.stringify(PLAN)};`,
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
    "if (arg('--permission-mode') === 'plan') {",
    '  // What a planning agent ends its turn with. The orchestrator captures the markdown',
    '  // and raises a plan-approval item from this alone (no gate is wired here).',
    '  say({',
    "    type: 'assistant',",
    '    message: {',
    "      content: [{ type: 'tool_use', id: 'toolu_plan', name: 'ExitPlanMode', input: { plan: PLAN } }],",
    '    },',
    '  });',
    '} else {',
    '  const timer = setInterval(() => {',
    "    if (!fs.existsSync(PROCEED + '/proceed-' + index)) return;",
    '    clearInterval(timer);',
    '    say({',
    "      type: 'result',",
    "      subtype: 'success',",
    '      is_error: false,',
    "      result: 'the stub finished run ' + index,",
    '      total_cost_usd: 0,',
    '    });',
    '  }, 20);',
    '}',
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
        .replaceAll('__PROCEED__', posix(proceedDir)),
      'utf8',
    );
    log('\nRunning the scenarios against the current code...');
    runUnderElectron(await bundle(entry, join(work, 'out')));

    log('\nAll scenarios passed.');
  } finally {
    // `--keep` leaves the bundle, the invocation log and the scratch database behind, which
    // is the only way to open one afterwards and see what a failing scenario actually did.
    if (process.argv.includes('--keep')) log(`\nLeft ${work} in place (--keep).`);
    // Retries because a killed stub's directory handle can outlive it by a moment on
    // Windows, and losing the run's verdict to an EBUSY on cleanup would be absurd.
    else rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';
import { PERSONAL_PROJECT_ID } from '@shared/model';
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

// The one line that makes the fake CLI the real one for this process. Everything above it
// — the scheduler, the store, buildClaudeArgs, the spawn — is the app's own code.
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

/** The value the CLI was given for a flag — read off the argv, positionally, as the CLI does. */
function flag(invocation, name) {
  const i = invocation.argv.indexOf(name);
  return i >= 0 && i + 1 < invocation.argv.length ? invocation.argv[i + 1] : '';
}

/** Wait for the Nth spawn (1-based) and hand it back. */
async function nthInvocation(n, what) {
  await waitFor(what, () => invocations().length >= n);
  return invocations()[n - 1] ?? { argv: [] };
}

/** Let run N report its result, which is what advances the chain. */
const proceed = (n) => writeFileSync(PROCEED + '/proceed-' + n, 'go', 'utf8');

const store = createStore(SCRATCH + '/orchestrator.db');
const sessions = new SessionManager(() => {});
const raised = [];
const scheduler = new Scheduler(
  store,
  sessions,
  () => {},
  () => {},
  (item) => raised.push(item),
  () => {},
  () => {},
);

// No WorktreeManager on purpose: every run then happens in the project directory, which is
// what this is about — the model on the command line, not where git puts the work. It also
// keeps the script from creating a single branch or worktree anywhere.
const agent = store.addProject({
  path: SCRATCH + '/repo',
  name: 'the split repo',
  kind: 'agent',
  defaultModel: 'haiku',
  planningModel: 'opus',
  defaultPermissionMode: 'acceptEdits',
  useWorktrees: false,
});

check(
  'the project plans on opus and executes on haiku',
  agent.planningModel === 'opus' && agent.defaultModel === 'haiku',
  agent.planningModel + '/' + agent.defaultModel,
);

/** A card on the Personal board, delegated to that agent project. */
function card(title, patch) {
  const created = store.createTask(PERSONAL_PROJECT_ID, { title });
  if (!created) throw new Error('the store refused ' + title);
  const updated = store.updateTask(created.id, { agentProjectId: agent.id, ...patch });
  if (!updated) throw new Error('the store refused the patch for ' + title);
  return updated;
}

// ===========================================================================
section('1. The planning turn is charged at the planning model');

// Assigned in plan mode and with NO model of its own — the card the migration in step 5
// leaves behind, and the only shape for which a project-level planning model can decide
// anything at all.
const parent = card('Rename the widget', { agentMode: 'plan', agentModel: null });
check('the card overrides no model, so its project decides', parent.agentModel === null);

scheduler.runTask(parent.id);
const planning = await nthInvocation(1, 'the planning run to spawn');

check(
  'the CLI was given --model opus',
  flag(planning, '--model') === 'opus',
  planning.argv.join(' '),
);
check(
  'and --permission-mode plan, which is what made it a planning run',
  flag(planning, '--permission-mode') === 'plan',
  flag(planning, '--permission-mode'),
);
check(
  'the model is a real argv PAIR, not two flags that happen to both be present',
  planning.argv[planning.argv.indexOf('--model') + 1] === 'opus',
);
check('it ran in the project directory', planning.cwd.replace(/\\/g, '/').endsWith('/repo'), planning.cwd);

// ---------------------------------------------------------------------------
section('2. Approving the plan hands over to steps, which are charged at the execution model');

await waitFor('the plan to reach the inbox', () => raised.some((i) => i.kind === 'plan-approval'));
const approval = raised.find((i) => i.kind === 'plan-approval');
check(
  'the inbox item carries the three steps the plan proposes',
  approval.steps.length === 3,
  JSON.stringify(approval?.steps),
);

scheduler.answerAttention(approval.id, { decision: 'approve' });

const steps = await (async () => {
  await waitFor('the steps to be created', () => store.getSubtasks(parent.id).length === 3);
  return store.getSubtasks(parent.id);
})();
check(
  'no step carries a model of its own — NULL is "follow the project"',
  steps.every((s) => s.agentModel === null),
  JSON.stringify(steps.map((s) => s.agentModel)),
);
check(
  'they do inherit where they run, and the mode an approved plan forces',
  steps.every((s) => s.agentProjectId === agent.id && s.agentMode === 'bypassPermissions'),
);

const stepOne = await nthInvocation(2, 'step 1 to spawn');
check(
  'step 1 was given --model haiku — the execution model, not the one it was planned on',
  flag(stepOne, '--model') === 'haiku',
  stepOne.argv.join(' '),
);
check(
  'and --permission-mode bypassPermissions, so plan mode did not travel down with it',
  flag(stepOne, '--permission-mode') === 'bypassPermissions',
  flag(stepOne, '--permission-mode'),
);

// ---------------------------------------------------------------------------
section('3. One step overridden changes that step and nothing else');

// Set while step 1 is still open, which is the honest moment: the human reads step 1
// running and decides step 2 needs a better model.
store.updateTask(steps[1].id, { agentModel: 'sonnet' });
check(
  'step 2 now names a model; its siblings still name none',
  store.getSubtasks(parent.id).map((s) => s.agentModel).join(',') === ',sonnet,',
  store.getSubtasks(parent.id).map((s) => String(s.agentModel)).join(','),
);

proceed(2);
const stepTwo = await nthInvocation(3, 'step 2 to spawn');
check(
  'step 2 was given --model sonnet — the card override out-ranks both project models',
  flag(stepTwo, '--model') === 'sonnet',
  stepTwo.argv.join(' '),
);

proceed(3);
const stepThree = await nthInvocation(4, 'step 3 to spawn');
check(
  'step 3 is untouched and still --model haiku — one step changed, not the chain',
  flag(stepThree, '--model') === 'haiku',
  stepThree.argv.join(' '),
);

proceed(4);

// ---------------------------------------------------------------------------
section('4. Plan MODE is not planning — only a turn that asked for a plan is');

// Two cards, identical but for what is asked of them: both are assigned plan mode, both
// have a conversation to continue. One is talked to; the other is asked for another round
// of steps. That is the whole distinction the ladder turns on, and it is only visible
// here, where the two runs are compared by the argument each was actually spawned with.
const talked = card('A card someone talks to', {
  agentMode: 'plan',
  agentModel: null,
  sessionId: 'a-session-from-an-earlier-run',
});
check('it is chattable — it has a conversation to resume', Boolean(talked.sessionId));
scheduler.chatWithAgent(talked.id, 'What did you change in the widget?');
const chat = await nthInvocation(5, 'the chat reply to spawn');
check(
  'the chat run carries --permission-mode plan, inherited from the card',
  flag(chat, '--permission-mode') === 'plan',
  flag(chat, '--permission-mode'),
);
check(
  'and it resumes rather than starting fresh',
  chat.argv.includes('--resume'),
  chat.argv.join(' '),
);
check(
  'but --model haiku: a conversation is not planning, whatever mode it inherited',
  flag(chat, '--model') === 'haiku',
  chat.argv.join(' '),
);

const replanned = card('A card asked to plan again', {
  agentMode: 'plan',
  agentModel: null,
  sessionId: 'another-session-from-an-earlier-run',
});
scheduler.replanCard(replanned.id, 'There is more to do than the first plan saw.');
const replan = await nthInvocation(6, 'the re-plan turn to spawn');
check(
  'the re-plan turn was given --model opus — it was ASKED for a plan',
  flag(replan, '--model') === 'opus',
  replan.argv.join(' '),
);
check(
  'in plan mode, the same mode the chat run had and was not billed for',
  flag(replan, '--permission-mode') === 'plan',
  flag(replan, '--permission-mode'),
);

// ---------------------------------------------------------------------------
section('5. A project that names no planning model behaves exactly as it did');

const legacy = store.addProject({
  path: SCRATCH + '/repo',
  name: 'a project from before the split',
  kind: 'agent',
  defaultModel: 'sonnet',
  defaultPermissionMode: 'acceptEdits',
  useWorktrees: false,
});
check('it has no planning model at all', legacy.planningModel === null, String(legacy.planningModel));

const legacyCreated = store.createTask(PERSONAL_PROJECT_ID, { title: 'Plan something old' });
const legacyCard = store.updateTask(legacyCreated.id, {
  agentProjectId: legacy.id,
  agentMode: 'plan',
  agentModel: null,
});
scheduler.runTask(legacyCard.id);
const legacyPlanning = await nthInvocation(7, 'the legacy planning run to spawn');
check(
  'its planning run falls through to the execution model — --model sonnet',
  flag(legacyPlanning, '--model') === 'sonnet',
  legacyPlanning.argv.join(' '),
);

// ---------------------------------------------------------------------------
section('6. A step does not inherit the model its parent was planned on');

// The parent is pinned to a model that is neither of its project's two, so an inherited
// value would be unmistakable in the argv.
const pinned = card('A card someone pinned to sonnet', {
  agentMode: 'plan',
  agentModel: 'sonnet',
});
const inheritedStep = store.addSubtask(pinned.id, { title: 'The one step of it' });
check(
  'the step was created with no model, though its parent has one',
  inheritedStep.agentModel === null,
  String(inheritedStep.agentModel),
);

scheduler.runTask(pinned.id);
const pinnedStep = await nthInvocation(8, 'the pinned card to divert to its step');
check(
  'so it runs on --model haiku, the project execution model — not the parent sonnet',
  flag(pinnedStep, '--model') === 'haiku',
  pinnedStep.argv.join(' '),
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
