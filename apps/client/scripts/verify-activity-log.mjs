/**
 * Headless verification for F2.16 — does the activity log (F2.1-F2.9) actually fill in,
 * end to end, when a REAL CLI run ends?
 *
 * `scheduler.test.ts` already proves every recorder call site in isolation: a fake
 * `SessionManager` hands the scheduler a hand-built `result`/`exited` event and asserts the
 * right `ActivityRecorder` method was called with the right row
 * (`setActivityRecorder(createActivityRecorder({ append }))` against a fake `append`).
 * `verify-activity-store.mjs` proves the OTHER half: that `store.ts`'s `activity_log` table,
 * its indexes and its queries behave, against hand-built rows nothing ever ran to produce.
 *
 * Neither answers the question a human actually has — **when the real CLI prints its two
 * stream-json lines, does a row really land in SQLite?** — because that answer is the whole
 * chain joined end to end: the stub's stdout, `mapRawEvent`, the classifier
 * (`detectLimitFailure`, `describeEmptyOutcome`), the scheduler's own recorder call, the real
 * `ActivityRecorder`, and the real `store.appendActivity`. This drives all of it:
 *
 *  - a real SQLite store (`better-sqlite3`, which only loads under Electron's ABI — the
 *    reason this lives here rather than in the vitest suite, memory `the-store-has-no-tests`),
 *  - the real `Scheduler` and `SessionManager`,
 *  - and a **stub `claude` on PATH** (memory `stub-claude-on-path`) that speaks the stream-json
 *    the app reads and ends its turn only once this script says so, so every assertion is made
 *    at a known moment and nothing races on a timer (memory `headless-scenario-harness-traps`).
 *
 * What the scenario drives, and the activity-log kind each section is really about:
 *
 *   1. An ordinary human run — `run-started` (origin `human`), then `run-finished`
 *      (`done`, the CLI's own cost).
 *   2. A run that fails on its own merits — `run-finished` (`failed`).
 *   3. A run that reports success but never called the model — `run-finished` (`empty`,
 *      `describeEmptyOutcome`'s first rule), with its cost staying NULL rather than 0.
 *   4. A plan approved into steps — `run-started` for the planning turn (origin `human`),
 *      `plan-presented` the moment `ExitPlanMode` is raised to the inbox
 *      (`recordAttentionRaised`), then each step's OWN `run-started`/`run-finished` pair with
 *      origin `chain` — the row that proves a step is never mistaken for the human's own work.
 *   5. The CLI's own usage-limit sentence — `parked` (origin `human`, the run that hit the
 *      wall), then `resumed` (origin always `resume`) once `resumeLimitNow()` lifts it, and the
 *      resumed run's own `run-finished` carrying origin `resume` too.
 *   6. A human Stop mid-run — `run-finished` (`stopped`), via `stopTask`, never via the
 *      process's own exit code.
 *
 * What this intentionally does NOT drive, and why: `merge-landed`/`merge-failed`/
 * `merge-conflict`/`release-published` all need a real git worktree merge or a release run,
 * and `scheduler.test.ts` (6498-6693) already proves each of those four call sites against a
 * fake recorder — adding a real `WorktreeManager` here to re-prove the SAME wiring this script
 * already establishes for `run-started`/`run-finished`/`parked`/`resumed` would cost a lot of
 * scenario for no new claim. `status-moved` is `ipc.ts`'s `task:move`/`task:setStatus`
 * handlers, which build their OWN store and scheduler
 * (memory `headless-scenario-harness-traps`: "`ipc.ts`'s handlers are out of reach from a
 * harness like this") — its pure half, `toMoveActivity`, has its own unit tests.
 * `question-raised` shares `recordAttentionRaised` with `plan-presented` (section 4 below), so
 * proving one proves the method; the CLI's own `AskUserQuestion` needs a tool-call shape this
 * script would otherwise add purely to re-exercise the same four lines.
 *
 * The app is NEVER launched (RELEASE.md rule 6 / memory `verify-electron-app`). Nothing
 * outside the scratch directory is written: no real profile, no git repository, no network.
 *
 *   pnpm exec node scripts/verify-activity-log.mjs             # the scenario, once, green
 *   pnpm exec node scripts/verify-activity-log.mjs --drop-hook=run-started
 *                                                               # neutralize one recorder call,
 *                                                               # rerun, see it go red
 *   pnpm exec node scripts/verify-activity-log.mjs --prove      # do that for every recorder
 *                                                               # this scenario exercises, and
 *                                                               # report which checks reddened
 *
 * Exits non-zero on the first failed assertion in the plain run, naming it. `--drop-hook`
 * and `--prove` mutate `src/main/scheduler.ts` ON DISK (one `return;` inserted right after a
 * named `recordXxx` method's own `try {`), rerun the bundle against THAT, and always restore
 * the file in a `finally` — `--prove`'s own closing section diffs it against git afterwards so
 * a crash mid-mutation can never leave the source changed.
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
/** `store.ts` reaches `cloudDelta.ts`, which takes a runtime value from `@protocol/wire`. */
const protocolSrc = join(repo, '..', '..', 'packages', 'protocol', 'src');

/**
 * Everything this script writes lives here, INSIDE the repo rather than in the temp dir, for
 * one reason: the bundle keeps `better-sqlite3` external, so it must sit somewhere Node's
 * resolution can still find `node_modules`. Removed on the way out, and on the way in — a
 * crashed previous run must not leak into this one.
 */
const work = join(repo, '.verify-activity-log');

const electronBin = join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
const electronBinPosix = join(repo, 'node_modules', 'electron', 'dist', 'electron');
const schedulerPath = join(repo, 'src', 'main', 'scheduler.ts');

function log(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * Nothing under test calls Electron on this path — `store.ts` and `scheduler.ts` never touch
 * it — but every symbol throws rather than returning a plausible value, so a scenario that
 * DOES reach one fails loudly here instead of quietly verifying a stub.
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
    resolve: { alias: { '@shared': sharedSrc, '@protocol': protocolSrc, electron: stub } },
    build: {
      ssr: entry,
      outDir,
      emptyOutDir: true,
      target: 'node20',
      minify: false,
      // The native addon must stay a real `import` resolved at run time — bundling a `.node`
      // file is exactly the mistake this whole ABI dance exists to avoid.
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
 * Captures stdout/stderr (and still prints them) so a mutation run can be graded on which
 * `FAIL` lines it produced, not just its exit code.
 */
function runUnderElectron(bundlePath) {
  const bin = existsSync(electronBin) ? electronBin : electronBinPosix;
  if (!existsSync(bin)) throw new Error(`No Electron binary at ${bin}`);
  const result = spawnSync(bin, [bundlePath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    failLines: (result.stdout ?? '')
      .split('\n')
      .filter((line) => line.includes('FAIL'))
      .map((line) => line.trim()),
  };
}

// ---------------------------------------------------------------------------

/**
 * When the limit "resets", as a unix epoch in seconds — the field the CLI puts after the
 * pipe, and the only reset time this path can ever learn. Computed so it is always in the
 * FUTURE: a gate whose `resumeAt` has already passed fires at once, which would tear down the
 * very state the assertions are about.
 */
const RESETS_AT = Math.floor(Date.now() / 1000) + 3600;

/**
 * The plan the stub "produces" for the chain scenario (section 4). Two `##` phases plus one
 * framing `## Overview` the splitter drops, so `splitPlanIntoSteps` yields exactly two steps —
 * only as many invocations as the chain actually needs to prove origin `chain` travels onto a
 * step and survives to its own `run-finished`.
 */
const PLAN = [
  '# Rename the thing',
  '',
  '## Overview',
  '',
  'Framing, not work. The splitter drops this heading.',
  '',
  '## Phase 1 — Do the first part',
  '',
  'Change the first half of the thing.',
  '',
  '## Phase 2 — Do the second part',
  '',
  'Change the second half of the thing.',
].join('\n');

/**
 * What each invocation of the stub ends its turn with, indexed by invocation number (1-based,
 * so index 0 is invocation 1). A `null` entry is never read — the planning run (invocation 4)
 * is detected by its own `--permission-mode plan` and answered with `ExitPlanMode` instead,
 * the same way it ends in the real CLI.
 *
 *   1 — card1: an ordinary success, with a real cost.
 *   2 — card2: a genuine failure (not a limit, not a login) — `run-finished` 'failed'.
 *   3 — card3: success that spent nothing — `describeEmptyOutcome`'s dead-start rule —
 *       `run-finished` 'empty', and `total_cost_usd` OMITTED so costUsd lands NULL, never 0.
 *   4 — the planning run: unused (ExitPlanMode, detected by permission mode).
 *   5 — step 1 of the chain: origin `chain`.
 *   6 — step 2 of the chain: origin `chain`, the chain's last step.
 *   7 — card5's first attempt: the CLI's own usage-limit sentence, parsed for its epoch.
 *   8 — card5 resumed by `resumeLimitNow()`: an ordinary success again.
 *   9 — card6: never allowed to reach a result — stopped by `stopTask` instead.
 */
const OUTCOMES = [
  { is_error: false, result: 'Wrote up the release notes.', costUsd: 0.42 },
  { is_error: true, result: 'The build broke: TypeError in widget.ts' },
  {
    is_error: false,
    result: '',
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  },
  null,
  { is_error: false, result: 'Changed the first half of the thing.', costUsd: 0.1 },
  { is_error: false, result: 'Changed the second half of the thing.', costUsd: 0.05 },
  {
    is_error: true,
    terminalReason: 'api_error',
    result: `Claude AI usage limit reached|${RESETS_AT}`,
  },
  { is_error: false, result: 'Finished after the reset.', costUsd: 0.01 },
];

/**
 * The fake `claude`, written as a `.cjs` the shim on PATH invokes.
 *
 * It records its argv, speaks the `system`/`init` line every run gets, then branches on
 * whether this is a PLANNING turn: a `--permission-mode plan` run answers with `ExitPlanMode`
 * at once (no `result` ever arrives for it, exactly as a real planning session left for
 * approval), everything else waits for this script to drop a `proceed-N` file before ending
 * on the Nth entry of {@link OUTCOMES}. That wait is what makes the scenario deterministic: a
 * run that settled the instant it started would advance the engine before the assertions
 * about its open state had been made.
 */
function stubSource(logPath, proceedDir) {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    `const LOG = ${JSON.stringify(logPath)};`,
    `const PROCEED = ${JSON.stringify(proceedDir)};`,
    `const PLAN = ${JSON.stringify(PLAN)};`,
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
    "if (arg('--permission-mode') === 'plan') {",
    '  say({',
    "    type: 'assistant',",
    '    message: {',
    "      content: [{ type: 'tool_use', id: 'toolu_plan', name: 'ExitPlanMode', input: { plan: PLAN } }],",
    '    },',
    '  });',
    '} else {',
    '  const outcome = OUTCOMES[index - 1] || { is_error: false, result: \'stub run \' + index };',
    '  const timer = setInterval(() => {',
    "    if (!fs.existsSync(PROCEED + '/proceed-' + index)) return;",
    '    clearInterval(timer);',
    '    const payload = {',
    "      type: 'result',",
    "      subtype: outcome.is_error ? 'error_during_execution' : 'success',",
    '      is_error: Boolean(outcome.is_error),',
    "      result: outcome.result ?? '',",
    '    };',
    '    if (outcome.terminalReason) payload.terminal_reason = outcome.terminalReason;',
    '    // OMITTED when the outcome names no cost, so the real field is absent on the wire —',
    '    // exactly what a CLI that never learned a cost sends, and what must decode to NULL.',
    '    if (outcome.costUsd !== undefined) payload.total_cost_usd = outcome.costUsd;',
    '    if (outcome.usage) payload.usage = outcome.usage;',
    '    say(payload);',
    '  }, 20);',
    '}',
    '',
    '// Never self-exit — the scheduler kills the process once it settles the run, exactly as',
    '// it does the real CLI. The backstop is only so a crashed driver leaves nothing behind.',
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

/**
 * The recorder hooks this scenario can actually exercise, named by the `ActivityKind` they
 * write and the private `scheduler.ts` method that writes it. `--drop-hook`/`--prove` target
 * these by NAME (the kind), not the method, since the kind is what a human reading a failed
 * check already knows.
 */
const HOOKS = [
  { name: 'run-started', method: 'recordRunStarted' },
  { name: 'run-finished', method: 'recordRunFinished' },
  { name: 'parked', method: 'recordParked' },
  { name: 'resumed', method: 'recordResumed' },
  { name: 'plan-presented', method: 'recordAttentionRaised' },
];

/**
 * Neutralize one recorder method: find `private <method>(`, then the FIRST `try {` after it
 * (every one of these methods is `private recordXxx(...): void { try { this.activity...`, so
 * the next `try {` after the signature is always its own), and insert an early `return;` right
 * inside it. The method still runs — it just never reaches `this.activity.*` — so the engine's
 * own behaviour (the park, the resume, the chain) is completely unaffected; only the row never
 * gets written. That is the one-line mutation memory `headless-scenario-harness-traps`
 * describes doing by hand, done here on demand instead.
 */
function dropHook(source, methodName) {
  const marker = `private ${methodName}(`;
  const methodIdx = source.indexOf(marker);
  if (methodIdx === -1) {
    throw new Error(`could not find "${marker}" in scheduler.ts — has it been renamed?`);
  }
  const tryIdx = source.indexOf('try {', methodIdx);
  if (tryIdx === -1) {
    throw new Error(`could not find a try block after "${marker}"`);
  }
  const insertAt = tryIdx + 'try {'.length;
  return (
    source.slice(0, insertAt) +
    '\n      return; // --drop-hook: neutralized for verify-activity-log.mjs' +
    source.slice(insertAt)
  );
}

async function main() {
  const proveAll = process.argv.includes('--prove');
  const dropArg = process.argv.find((a) => a.startsWith('--drop-hook'));
  const dropName = dropArg
    ? dropArg.includes('=')
      ? dropArg.slice(dropArg.indexOf('=') + 1)
      : process.argv[process.argv.indexOf(dropArg) + 1]
    : null;
  if (dropName && !HOOKS.some((h) => h.name === dropName)) {
    throw new Error(
      `unknown --drop-hook "${dropName}" — choose one of: ${HOOKS.map((h) => h.name).join(', ')}`,
    );
  }

  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const originalScheduler = readFileSync(schedulerPath, 'utf8');

  try {
    // The ABI the whole exercise depends on. Checked first and by itself — every scenario
    // below fails identically and unhelpfully when this is wrong.
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
    const logPath = join(work, 'invocations.jsonl');
    const stubPath = join(binDir, 'claude-stub.cjs');

    /**
     * Fresh runtime state for ONE run of the scenario: a new scratch database, an empty
     * invocation log, and an empty proceed directory. `--prove` runs the scenario up to six
     * times (the baseline, then once per dropped hook) and every one of them must start from
     * nothing — reusing the database or the log across runs would let a later run read the
     * PREVIOUS run's rows and invocations, which is exactly backwards for a script whose job
     * is proving what a mutation does and does not change.
     */
    function resetRuntimeDirs() {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(proceedDir, { recursive: true, force: true });
      mkdirSync(join(scratch, 'repo'), { recursive: true });
      mkdirSync(proceedDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(logPath, '', 'utf8');
      writeFileSync(stubPath, stubSource(posix(logPath), posix(proceedDir)), 'utf8');
      writeStubCli(binDir, stubPath, electron);
    }
    resetRuntimeDirs();
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

    /** Bundle and run the (possibly mutated) current `scheduler.ts`, against a fresh outDir. */
    async function runScenarioOnce(label, outDirName) {
      log(`\nRunning the scenario${label ? ` (${label})` : ''}...`);
      resetRuntimeDirs();
      const bundlePath = await bundle(entry, join(work, outDirName));
      return runUnderElectron(bundlePath);
    }

    if (proveAll) {
      const baseline = await runScenarioOnce('baseline', 'out-baseline');
      if (baseline.status !== 0) {
        throw new Error('the unmutated scenario is not green — fix that before --prove means anything');
      }
      log('\nBaseline is green. Dropping each recorder hook in turn...');
      const report = [];
      for (const hook of HOOKS) {
        writeFileSync(schedulerPath, dropHook(originalScheduler, hook.method), 'utf8');
        let outcome;
        try {
          outcome = await runScenarioOnce(`--drop-hook=${hook.name}`, `out-drop-${hook.name}`);
        } finally {
          writeFileSync(schedulerPath, originalScheduler, 'utf8');
        }
        report.push({ hook: hook.name, ...outcome });
      }

      log('\n--prove summary — which checks each dropped recorder turned red:');
      for (const row of report) {
        log(`\n  ${row.hook} (scheduler.${HOOKS.find((h) => h.name === row.hook).method}):`);
        if (row.failLines.length === 0) log('    (nothing failed)');
        for (const line of row.failLines) log(`    ${line}`);
      }

      const uncaught = report.filter((r) => r.failLines.length === 0);
      if (uncaught.length > 0) {
        throw new Error(
          `these recorder hooks were dropped with NO check going red: ${uncaught
            .map((r) => r.hook)
            .join(', ')}`,
        );
      }
      log('\nEvery recorder hook this scenario exercises is load-bearing.');
    } else if (dropName) {
      const method = HOOKS.find((h) => h.name === dropName).method;
      writeFileSync(schedulerPath, dropHook(originalScheduler, method), 'utf8');
      let outcome;
      try {
        outcome = await runScenarioOnce(`--drop-hook=${dropName}`, `out-drop-${dropName}`);
      } finally {
        writeFileSync(schedulerPath, originalScheduler, 'utf8');
      }
      if (outcome.status === 0) {
        throw new Error(`dropping "${dropName}" was expected to turn a check red, but exited 0`);
      }
      log(`\n--drop-hook=${dropName} correctly turned ${outcome.failLines.length} check(s) red.`);
    } else {
      const outcome = await runScenarioOnce(null, 'out');
      if (outcome.status !== 0) {
        throw new Error(`scenario exited ${outcome.status ?? `on ${outcome.signal}`}`);
      }
      log('\nAll scenarios passed.');
    }
  } finally {
    // Belt and suspenders on top of every mutation's own restore above: whatever happened,
    // the file on disk must be byte-identical to what this run started with.
    writeFileSync(schedulerPath, originalScheduler, 'utf8');
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
 * The scenario itself, as a template so the paths are baked in rather than passed — a bundle
 * takes no argv worth threading, and every path in it is scratch or this repo.
 *
 * NO BACKTICKS below: this is a `String.raw` template, and one inside a comment closes it with
 * a SyntaxError pointing at a word in prose.
 */
const SCENARIOS = String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';
import { PERSONAL_PROJECT_ID } from '@shared/model';
import { createActivityRecorder } from '__REPO__/src/main/activityRecorder';
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

// The one line that makes the fake CLI the real one for this process. Everything above it —
// the scheduler, the store, the classifier, the activity recorder, the spawn — is the app's
// own code.
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

const store = createStore(SCRATCH + '/orchestrator.db');
// Two settings, both to remove randomness rather than to change behaviour: no auto-retry, so
// an ordinary failure settles on its first attempt instead of relaunching the stub behind the
// assertions; and no jitter, so the gate's resume time is exactly the reset time.
store.saveSettings({ ...store.getSettings(), maxAutoRetries: 0, limitJitterMs: 0 });

// Every row the real recorder actually appends, in order — the callback F2.9 wires to
// 'activity:appended'. Assertions below read from the STORE, not this array: the array only
// proves ORDER and gives 'waitFor' something to poll.
const appended = [];
const sessions = new SessionManager(() => {});
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
scheduler.setActivityRecorder(
  createActivityRecorder({
    append: (row) => store.appendActivity(row),
    onAppended: (row) => appended.push(row),
  }),
);

// No WorktreeManager on purpose (see the module docstring): every run happens in the plain
// project directory, which keeps this scenario from creating a single branch anywhere and
// matches 'merge-landed' et al already being proven against a fake recorder in
// scheduler.test.ts.
const agent = store.addProject({
  path: SCRATCH + '/repo',
  name: 'the activity log repo',
  kind: 'agent',
  defaultModel: 'sonnet',
  defaultPermissionMode: 'acceptEdits',
  useWorktrees: false,
});

/** A card on the Personal board, delegated to that agent project. */
function card(title, patch) {
  const created = store.createTask(PERSONAL_PROJECT_ID, { title });
  if (!created) throw new Error('the store refused ' + title);
  const updated = store.updateTask(created.id, { agentProjectId: agent.id, ...patch });
  if (!updated) throw new Error('the store refused the patch for ' + title);
  return updated;
}

/** Every row the real store holds for one task, oldest first — read straight from SQLite. */
function rowsFor(taskId) {
  return store
    .listActivity({ sinceMs: 0, limit: 200 })
    .rows.filter((r) => r.taskId === taskId)
    .sort((a, b) => a.id - b.id);
}

/**
 * The scenario's body, wrapped so that a row a dropped recorder hook never writes — which
 * every section after the first few assumes exists — turns into ONE more FAIL rather than an
 * uncaught exception. A crash here would skip the cleanup below it, and a stub left running
 * holds its CWD (the scratch project directory) locked for up to two minutes (its own
 * backstop exit), which is exactly the EBUSY '--prove' would hit trying to reset the next
 * hook's fixtures. Checks before this point in the file (and in sections that have not yet
 * run) still execute and still report PASS/FAIL individually — this only stops one dropped
 * hook from aborting the dispose/stopAll/close below it.
 */
async function runScenario() {
// ===========================================================================
section('1. An ordinary human run: run-started, then run-finished done');

const card1 = card('Write up the release notes');
scheduler.runTask(card1.id);
await nthInvocation(1, 'card1 to spawn');

const startedRows1 = rowsFor(card1.id);
check(
  'a run-started row landed in SQLite the moment the run spawned',
  startedRows1.length === 1 && startedRows1[0].kind === 'run-started',
  JSON.stringify(startedRows1.map((r) => r.kind)),
);
check(
  'it carries origin human, this run id, the card title, and no outcome yet',
  startedRows1[0]?.origin === 'human' &&
    startedRows1[0]?.title === 'Write up the release notes' &&
    startedRows1[0]?.outcome === null &&
    startedRows1[0]?.costUsd === null &&
    typeof startedRows1[0]?.runId === 'string' &&
    startedRows1[0].runId.length > 0,
  JSON.stringify(startedRows1[0]),
);

proceed(1);
await waitFor('card1 to finish', () => rowsFor(card1.id).some((r) => r.kind === 'run-finished'));

const finishedRows1 = rowsFor(card1.id);
check('card1 now has exactly its started and finished rows', finishedRows1.length === 2);
const finished1 = finishedRows1.find((r) => r.kind === 'run-finished');
check(
  "run-finished reads 'done', carries the CLI's own cost, and the SAME runId as run-started",
  finished1?.outcome === 'done' &&
    finished1?.costUsd === 0.42 &&
    finished1?.origin === 'human' &&
    finished1?.runId === startedRows1[0]?.runId,
  JSON.stringify(finished1),
);
// settle() proposes 'in-progress', but card1 is a board card (memory card-state-is-the-humans)
// — guardCardStatus rewrites any resting-status write from the engine back to whatever the
// human had it resting at (here, 'pending' — it was never dragged anywhere), releasing
// preRunStatus. A run never moves a card; this is that rule, not a gap in the scenario.
check(
  "card1 rests back at 'pending' once the run settles — a run never moves a board card",
  store.getTask(card1.id).status === 'pending',
  store.getTask(card1.id).status,
);

// ---------------------------------------------------------------------------
section('2. A run that fails on its own merits: run-finished failed');

const card2 = card('Refactor the widget');
scheduler.runTask(card2.id);
await nthInvocation(2, 'card2 to spawn');
proceed(2);
await waitFor('card2 to finish', () => rowsFor(card2.id).some((r) => r.kind === 'run-finished'));

const finished2 = rowsFor(card2.id).find((r) => r.kind === 'run-finished');
check(
  "a genuine failure records outcome 'failed', not empty and not parked",
  finished2?.outcome === 'failed',
  JSON.stringify(finished2),
);
check(
  'no parked row was ever written for it — this was never a usage limit',
  rowsFor(card2.id).every((r) => r.kind !== 'parked'),
);

// ---------------------------------------------------------------------------
section('3. A success that spent nothing: run-finished empty, cost stays NULL');

const card3 = card('A session that never ran a turn');
scheduler.runTask(card3.id);
await nthInvocation(3, 'card3 to spawn');
proceed(3);
await waitFor('card3 to finish', () => rowsFor(card3.id).some((r) => r.kind === 'run-finished'));

const finished3 = rowsFor(card3.id).find((r) => r.kind === 'run-finished');
check(
  "describeEmptyOutcome's dead-start rule is read all the way through to the row: 'empty'",
  finished3?.outcome === 'empty',
  JSON.stringify(finished3),
);
check(
  'and its cost is NULL, never coerced to 0 — the CLI never said what it cost',
  finished3?.costUsd === null,
  String(finished3?.costUsd),
);

// ---------------------------------------------------------------------------
section('4. A plan approved into a chain: plan-presented, then origin chain on every step');

const parent = card('Rename the thing', { agentMode: 'plan', agentModel: null });
scheduler.runTask(parent.id);
await nthInvocation(4, 'the planning run to spawn');

const parentStarted = rowsFor(parent.id).find((r) => r.kind === 'run-started');
check(
  'the planning run itself records run-started with origin human — it is the human who pressed Run',
  parentStarted !== undefined && parentStarted.origin === 'human',
  JSON.stringify(parentStarted),
);

await waitFor('the plan to reach the inbox', () => raised.some((i) => i.kind === 'plan-approval'));
const approval = raised.find((i) => i.kind === 'plan-approval');
await waitFor('plan-presented to be recorded', () =>
  rowsFor(parent.id).some((r) => r.kind === 'plan-presented'),
);
const presented = rowsFor(parent.id).find((r) => r.kind === 'plan-presented');
check(
  'plan-presented is recorded the moment ExitPlanMode reaches the inbox, origin human, no outcome',
  presented !== undefined && presented.origin === 'human' && presented.outcome === null,
  JSON.stringify(presented),
);

scheduler.answerAttention(approval.id, { decision: 'approve' });
const steps = await (async () => {
  await waitFor('the two steps to be created', () => store.getSubtasks(parent.id).length === 2);
  return store.getSubtasks(parent.id);
})();

await nthInvocation(5, 'step 1 to spawn');
const step1Started = rowsFor(steps[0].id).find((r) => r.kind === 'run-started');
check(
  "step 1's own run-started carries origin chain, filed against the STEP, not the parent",
  step1Started !== undefined && step1Started.origin === 'chain',
  JSON.stringify(step1Started),
);
check(
  "and it is a DIFFERENT run than the planning turn's own",
  step1Started?.runId !== undefined && step1Started.runId !== parentStarted?.runId,
);

proceed(5);
await nthInvocation(6, 'step 2 to spawn');
const step1Finished = rowsFor(steps[0].id).find((r) => r.kind === 'run-finished');
check(
  'step 1 finishes done, origin chain, with its own cost',
  step1Finished !== undefined &&
    step1Finished.outcome === 'done' &&
    step1Finished.origin === 'chain' &&
    step1Finished.costUsd === 0.1,
  JSON.stringify(step1Finished),
);
const step2Started = rowsFor(steps[1].id).find((r) => r.kind === 'run-started');
check(
  "step 2 also records run-started with origin chain — every step of the chain, not just the first",
  step2Started !== undefined && step2Started.origin === 'chain',
  JSON.stringify(step2Started),
);

proceed(6);
await waitFor('step 2 to finish', () =>
  rowsFor(steps[1].id).some((r) => r.kind === 'run-finished'),
);
const step2Finished = rowsFor(steps[1].id).find((r) => r.kind === 'run-finished');
check(
  "the chain's last step finishes done, origin chain too",
  step2Finished !== undefined &&
    step2Finished.outcome === 'done' &&
    step2Finished.origin === 'chain',
  JSON.stringify(step2Finished),
);

// ---------------------------------------------------------------------------
section('5. The CLI own usage-limit sentence: parked, then resumed, through the real gate');

const card5 = card('Something about to be pinned to a wall');
scheduler.runTask(card5.id);
await nthInvocation(7, 'card5 to spawn');
proceed(7);

await waitFor('card5 to be parked behind the gate', () =>
  rowsFor(card5.id).some((r) => r.kind === 'parked'),
);
const parked = rowsFor(card5.id).find((r) => r.kind === 'parked');
check(
  'parked carries origin human (the run that hit the wall was an ordinary human one), ' +
    'the reason, and the runId the gate actually held',
  parked !== undefined &&
    parked.origin === 'human' &&
    parked.detail?.reason === 'limit' &&
    typeof parked.runId === 'string',
  JSON.stringify(parked),
);
check(
  'NO run-finished row exists for that first attempt — a park is not a finish',
  rowsFor(card5.id).every((r) => r.kind !== 'run-finished'),
  JSON.stringify(rowsFor(card5.id).map((r) => r.kind)),
);
check(
  'the gate really is up, and read the sentence epoch correctly',
  scheduler.currentLimit()?.resetsAt === RESETS_AT,
  JSON.stringify(scheduler.currentLimit()),
);

scheduler.resumeLimitNow();
await waitFor('card5 to be resumed', () => rowsFor(card5.id).some((r) => r.kind === 'resumed'));
const resumed = rowsFor(card5.id).find((r) => r.kind === 'resumed');
check(
  "resumed always carries origin 'resume' — it is the GATE handing the work back, " +
    'never the run it is reviving',
  resumed !== undefined && resumed.origin === 'resume',
  JSON.stringify(resumed),
);
check(
  'and it names the run the reset actually started, not null',
  typeof resumed?.runId === 'string' && resumed.runId.length > 0,
  JSON.stringify(resumed),
);

await nthInvocation(8, 'the resumed card5 to spawn');
proceed(8);
await waitFor('the resumed card5 to finish', () =>
  rowsFor(card5.id).some((r) => r.kind === 'run-finished'),
);
const card5Finished = rowsFor(card5.id).find((r) => r.kind === 'run-finished');
check(
  'the resumed run finishes done, and its OWN run-finished also carries origin resume',
  card5Finished !== undefined &&
    card5Finished.outcome === 'done' &&
    card5Finished.origin === 'resume' &&
    card5Finished.runId === resumed.runId,
  JSON.stringify(card5Finished),
);
check(
  'the resumed run is a fresh runId, never the one the wall ended',
  card5Finished?.runId !== undefined && card5Finished.runId !== parked?.runId,
);
check('the gate is down again', scheduler.currentLimit() === null);

// ---------------------------------------------------------------------------
section('6. A human Stop mid-run: run-finished stopped, never from the exit code');

const card6 = card('A card someone stops');
scheduler.runTask(card6.id);
await nthInvocation(9, 'card6 to spawn');
await waitFor('card6 to be running', () => store.getTask(card6.id).status === 'running');

// Never proceed(9) — the point is that this run ends by a human Stop, not by any result the
// stub would otherwise have to fabricate.
const stopped = scheduler.stopTask(card6.id);
check('stopTask reports it actually stopped something', stopped === true);

const card6Finished = rowsFor(card6.id).find((r) => r.kind === 'run-finished');
check(
  "stopTask records run-finished 'stopped' itself — synchronously, not via the process's exit",
  card6Finished !== undefined && card6Finished.outcome === 'stopped' && card6Finished.costUsd === null,
  JSON.stringify(card6Finished),
);
}

try {
  await runScenario();
} catch (err) {
  failures += 1;
  console.error('  FAIL  the scenario threw: ' + (err && err.stack ? err.stack : err));
} finally {
  // Kill every stub still waiting (the planning run from section 4 never got a result, by
  // design — it is left exactly as a real planning session awaiting approval would be). The
  // pause is for Windows: termination is a taskkill of its own, and a stub whose CWD is the
  // project directory keeps that directory locked until it is really gone. In a FINALLY so a
  // dropped hook that crashed a check above still leaves nothing running behind it.
  scheduler.dispose();
  sessions.stopAll();
  await sleep(750);
  store.close();
}

console.log('');
console.log(invocations().length + ' CLI invocation(s) observed, ' + appended.length + ' activity row(s) appended.');
if (failures > 0) {
  console.error(failures + ' check(s) failed.');
  process.exit(1);
}
`;

await main();
