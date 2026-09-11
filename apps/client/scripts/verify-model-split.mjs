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
 * Sections 1-6 exercise the three aliases (`opus`/`sonnet`/`haiku`) — the only shapes the
 * ladder had before the model catalog widened `ClaudeModel` to any dated version id or
 * custom string. Sections 7-8 repeat the same end-to-end claim against that wider shape: a
 * project pinned to two of the catalog's actual dated versions (`claude-fable-5-1` for
 * planning, `claude-opus-4-7` for steps), and a card pinned to an id that is not in the
 * catalog at all — proving the override outranks both project models on the strength of
 * `isUsableModel`'s shape check alone, and that a step still never inherits it.
 *
 * None of sections 1-8 ever sets a card's OWN `agentPlanningModel` — only `agentModel`. So
 * they cannot answer whether the newest rung of the ladder (`task.agentPlanningModel ??` —
 * the split added in `resolveRunModel`) is actually plumbed all the way through
 * `buildClaudeArgs` and the spawn, rather than just through the pure function `model.test.ts`
 * already covers. Section 9 is that card-level proof: a card whose `agentPlanningModel` and
 * `agentModel` are both set, to two different models, on a project that itself splits (a
 * third and fourth model again) — four distinct ids in play, so an argv can't satisfy an
 * assertion by accident.
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
 *
 * **Proving it can fail.** 33 green checks say nothing until a mutation turns them red. Run
 * on 2026-09-07, restored afterward with `git status` showing `model.ts` byte-identical
 * again: swap `resolveRunModel`'s return to
 * `(planning ? (project.planningModel ?? null) : null) ?? task.agentModel ?? project.defaultModel`
 * — i.e. let the project's planning model outrank a card's own override. Sections 7 and 8
 * go red exactly where that lie shows up, and nowhere else: section 7's versioned project
 * stays green (its card carries no override to be out-ranked), but section 8's custom-pinned
 * card fails both of its planning-run checks — the CLI is given `--model claude-fable-5-1`,
 * the project's planning model, instead of the card's own `claude-internal-eval-3`. The
 * other three checks in that section stay green (the step still doesn't inherit the pin,
 * and still runs on the execution model), which is itself evidence the mutation is scoped to
 * planning runs exactly as the line it changed is.
 *
 * Section 9 gets its own pass at the same discipline, targeting the term unique to IT: drop
 * `task.agentPlanningModel ??` from the planning branch, so the ladder reads
 * `task.agentModel ?? project.planningModel ?? project.defaultModel` for a planning run. Run
 * on 2026-09-11, restored afterward the same way. Only section 9 goes red — its
 * planning-run check, expecting `--model opus` (the card's own `agentPlanningModel`), gets
 * `--model fable` instead (the card's `agentModel`, the next rung down now that the removed
 * term no longer shadows it). Sections 1-8 stay green: none of their cards ever sets
 * `agentPlanningModel`, so the removed term was already `null` on every one of them and
 * dropping it changes nothing they were relying on.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
section('7. A project pinned to real dated versions, not aliases');

// Fable 5.1 for planning, a specific dated Opus snapshot for steps — two catalog entries
// sections 1-6 never touch, since MODELS/the ladder never cared whether an id was an
// alias or a version. Concurrency 2 so section 8 can run its own card on this same
// project without queuing behind this one's still-open step.
const versioned = store.addProject({
  path: SCRATCH + '/repo',
  name: 'a project on dated versions',
  kind: 'agent',
  defaultModel: 'claude-opus-4-7',
  planningModel: 'claude-fable-5-1',
  defaultPermissionMode: 'acceptEdits',
  concurrency: 2,
  useWorktrees: false,
});

const versionedCard = card('A card someone versions', {
  agentProjectId: versioned.id,
  agentMode: 'plan',
  agentModel: null,
});

scheduler.runTask(versionedCard.id);
const versionedPlanning = await nthInvocation(9, 'the versioned planning run to spawn');
check(
  'the CLI was given --model claude-fable-5-1 — the project\'s planning model',
  flag(versionedPlanning, '--model') === 'claude-fable-5-1',
  versionedPlanning.argv.join(' '),
);
check(
  'as a real argv PAIR, not a substring of the joined command line',
  versionedPlanning.argv[versionedPlanning.argv.indexOf('--model') + 1] === 'claude-fable-5-1',
);

await waitFor(
  'the versioned plan to reach the inbox',
  () => raised.some((i) => i.kind === 'plan-approval' && i.taskId === versionedCard.id),
);
const versionedApproval = raised.find(
  (i) => i.kind === 'plan-approval' && i.taskId === versionedCard.id,
);
scheduler.answerAttention(versionedApproval.id, { decision: 'approve' });
await waitFor(
  'the versioned steps to be created',
  () => store.getSubtasks(versionedCard.id).length === 3,
);

const versionedStepOne = await nthInvocation(10, 'versioned step 1 to spawn');
check(
  'step 1 was given --model claude-opus-4-7 — the project\'s execution model, not the one it was planned on',
  flag(versionedStepOne, '--model') === 'claude-opus-4-7',
  versionedStepOne.argv.join(' '),
);
check(
  'again a real argv pair',
  versionedStepOne.argv[versionedStepOne.argv.indexOf('--model') + 1] === 'claude-opus-4-7',
);
// Left running (never proceed(10)'d), same as invocation 8 above — nothing past this
// point needs it to finish, and the final cleanup tears it down regardless.

// ---------------------------------------------------------------------------
section('8. A card-level custom override still outranks both project models, and a step never inherits it');

// A string not in MODEL_CATALOG at all — only isUsableModel's shape check gates an
// override, so this proves the ladder does not secretly require catalog membership.
const CUSTOM_MODEL = 'claude-internal-eval-3';
const customPinned = card('A card someone pins to a custom build', {
  agentProjectId: versioned.id,
  agentMode: 'plan',
  agentModel: CUSTOM_MODEL,
});

scheduler.runTask(customPinned.id);
const customPlanning = await nthInvocation(11, 'the custom-pinned planning run to spawn');
check(
  'the override outranks the PLANNING model — --model claude-internal-eval-3, not claude-fable-5-1',
  flag(customPlanning, '--model') === CUSTOM_MODEL,
  customPlanning.argv.join(' '),
);
check(
  'as a real argv pair, not a substring of the joined command line',
  customPlanning.argv[customPlanning.argv.indexOf('--model') + 1] === CUSTOM_MODEL,
);

await waitFor(
  'the custom-pinned plan to reach the inbox',
  () => raised.some((i) => i.kind === 'plan-approval' && i.taskId === customPinned.id),
);
const customApproval = raised.find(
  (i) => i.kind === 'plan-approval' && i.taskId === customPinned.id,
);
scheduler.answerAttention(customApproval.id, { decision: 'approve' });

const customSteps = await (async () => {
  await waitFor(
    'the custom-pinned steps to be created',
    () => store.getSubtasks(customPinned.id).length === 3,
  );
  return store.getSubtasks(customPinned.id);
})();
check(
  'no step inherited the parent\'s custom pin — NULL is still "follow the project"',
  customSteps.every((s) => s.agentModel === null),
  JSON.stringify(customSteps.map((s) => s.agentModel)),
);

const customStepOne = await nthInvocation(12, 'the custom-pinned step 1 to spawn');
check(
  'so it runs on --model claude-opus-4-7 — the project execution model, not the parent\'s custom pin',
  flag(customStepOne, '--model') === 'claude-opus-4-7',
  customStepOne.argv.join(' '),
);
check(
  'and outranks the EXECUTION model just as clearly — the override never surfaces on this step',
  flag(customStepOne, '--model') !== CUSTOM_MODEL,
);

// ---------------------------------------------------------------------------
section("9. A card-level split: its own planning override, its own steps override, both distinct from the project's");

// Four distinct ids in play — the project's own two, plus the card's own two — so no
// assertion below can pass by an accidental coincidence between them.
const doubleSplit = store.addProject({
  path: SCRATCH + '/repo',
  name: 'a project the card out-ranks in both directions',
  kind: 'agent',
  defaultModel: 'sonnet',
  planningModel: 'haiku',
  defaultPermissionMode: 'acceptEdits',
  useWorktrees: false,
});

const doubleSplitCard = card('A card that names its own planning and steps model', {
  agentProjectId: doubleSplit.id,
  agentMode: 'plan',
  agentModel: 'fable',
  agentPlanningModel: 'opus',
});
check(
  'the card overrides both kinds of run, and to two different models',
  doubleSplitCard.agentPlanningModel === 'opus' && doubleSplitCard.agentModel === 'fable',
  doubleSplitCard.agentPlanningModel + '/' + doubleSplitCard.agentModel,
);

scheduler.runTask(doubleSplitCard.id);
const doubleSplitPlanning = await nthInvocation(13, 'the double-split planning run to spawn');
check(
  "the CLI was given --model opus — the card's own agentPlanningModel, not haiku (the project's) or fable (the card's own steps model)",
  flag(doubleSplitPlanning, '--model') === 'opus',
  doubleSplitPlanning.argv.join(' '),
);
check(
  'as a real argv pair, not a substring of the joined command line',
  doubleSplitPlanning.argv[doubleSplitPlanning.argv.indexOf('--model') + 1] === 'opus',
);

await waitFor(
  'the double-split plan to reach the inbox',
  () => raised.some((i) => i.kind === 'plan-approval' && i.taskId === doubleSplitCard.id),
);
const doubleSplitApproval = raised.find(
  (i) => i.kind === 'plan-approval' && i.taskId === doubleSplitCard.id,
);
scheduler.answerAttention(doubleSplitApproval.id, { decision: 'approve' });

const doubleSplitSteps = await (async () => {
  await waitFor(
    'the double-split steps to be created',
    () => store.getSubtasks(doubleSplitCard.id).length === 3,
  );
  return store.getSubtasks(doubleSplitCard.id);
})();
check(
  "no step inherited either of the parent's overrides — NULL is still \"follow the project\"",
  doubleSplitSteps.every((s) => s.agentModel === null),
  JSON.stringify(doubleSplitSteps.map((s) => s.agentModel)),
);

const doubleSplitStepOne = await nthInvocation(14, 'the double-split step 1 to spawn');
check(
  "step 1 runs on --model sonnet — the project's execution model, since the step carries none of its own",
  flag(doubleSplitStepOne, '--model') === 'sonnet',
  doubleSplitStepOne.argv.join(' '),
);
check(
  "and never the card's planning override — a step is not a planning run",
  flag(doubleSplitStepOne, '--model') !== 'opus',
);
check(
  "nor the card's own steps override — a step is charged the PROJECT model, exactly as section 6 already showed for a lone agentModel pin",
  flag(doubleSplitStepOne, '--model') !== 'fable',
);
// Left running (never proceed(14)'d), same as invocations 8, 10 and 12 above — nothing past
// this point needs it to finish, and the final cleanup tears it down regardless.

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
