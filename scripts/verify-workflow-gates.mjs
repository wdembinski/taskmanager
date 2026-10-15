/**
 * Headless proof of F8.6: a workflow's GATE steps, dispatched by the real `Scheduler`
 * through the real `GateStepRunner` (`apps/client/src/main/gateStep.ts`), actually loop a
 * failing check back to the agent step it names and actually park a budget-exhausted one
 * in the inbox.
 *
 *     node scripts/verify-workflow-gates.mjs
 *
 * ## Why this is a script and not a test
 *
 * `gateStep.test.ts` proves `GateStepRunner` reacts correctly to a fake `GateRun` and a
 * fake `GateStepDeps`. `scheduler.test.ts`'s own gate coverage stops at
 * `failureActionsFor('gate')` — a pure function. Neither answers what a human cares about:
 * wired into the REAL `Scheduler`, does a gate's command really run in the chain's real
 * worktree, does a real exit code really loop a real agent step back with a note the next
 * real turn actually reads, and does the real inbox actually offer "Skip gate"? That needs
 * the real `Scheduler`, the real `SessionManager`, a real git repo and worktree, and a stub
 * `claude` on PATH standing in for the CLI — no link in that chain faked.
 *
 * Same bundle-then-run-under-Electron-as-Node trick as `scripts/verify-pr-watch.mjs`:
 * `better-sqlite3` only loads under Electron's ABI, so nothing that calls `createStore` can
 * run under the Node that runs vitest.
 *
 * Unlike `verify-pr-watch.mjs`, there is no forge and no bare origin here — a gate's
 * worktree merges straight back into the project's own base branch (`WorktreeManager`'s own
 * `integrate`), so one real (non-bare) git repo is all a chain ever needs.
 *
 * ## What it proves
 *
 *  1. **Scenario A — fail, loop back, pass.** A card's two steps (`implement`, an agent
 *     step; `test`, a gate whose command checks for `fixed.txt`) are added through
 *     `instantiateWorkflow` → `store.addSubtask`, exactly as a real "apply this workflow"
 *     action would build them. The first run writes nothing, so the gate's command really
 *     fails; the real `GateStepRunner` really resets `implement` to `pending`, really writes
 *     a failure note carrying the gate's own output, and really advances the chain back to
 *     it. The SECOND invocation is a real `--resume` of the same session, and its prompt
 *     really contains the gate's failure text (`GATE-SAYS-NO`) — proof the note actually
 *     reached the agent rather than merely being filed on the timeline. That run writes
 *     `fixed.txt` for real, the gate re-runs for real and passes, and both steps land on
 *     `done` with no `task-failed` item ever raised.
 *  2. **Scenario B — the retry budget runs out.** A second card's gate always fails
 *     (`onFail.maxAttempts: 1`), so one retry loop consumes the whole budget and the second
 *     failure is `attempts-exhausted`: a real `task-failed` inbox item, carrying exactly the
 *     three gate actions (`Run gate again`, `Send back to agent`, `Skip gate`). Answering
 *     **Skip gate** through the real `Scheduler.answerAttention` really lands the chain the
 *     same way a passing gate would — the gate step reaches `done`.
 *
 * ## Prove it can fail
 *
 * Commented out the `for (const id of resolved.resetIds) this.deps.setStatus(id, 'pending');`
 * loop in `gateStep.ts`'s `settle` (the `retry` branch) — `implement` then stays `done`
 * forever instead of being sent back, so `advanceSubtasks` finds nothing `pending` to run and
 * the chain goes quiet. Re-running this script against that mutation produced:
 *
 *     PASS  the first run is a fresh session (no --resume)
 *     PASS  the gate recorded one attempt
 *     FAIL  step 1 ("Implement") was sent back to pending
 *     PASS  the gate's own timeline says it sent step 1 back on attempt 1/2
 *     PASS  the first run got a real session id
 *     FAIL  waited for the resumed "Implement" run to spawn — timed out after 30000ms
 *     FAIL  invocation 2 resumes the SAME session as invocation 1 —  != <uuid>
 *     FAIL  waited for invocation 2's own prompt — timed out after 30000ms
 *     Error: ENOENT: no such file or directory, open '…\prompts\prompt-2.txt'
 *
 * — invocation 2 never came, exactly as expected: the gate still recorded its attempt and
 * still noted it (neither of those needed the reset), but nothing downstream of the reset
 * ever fired again. The source was restored byte-identically afterwards (`git diff` empty)
 * before this script was run again to confirm green.
 *
 * Run with Bash, not PowerShell — `ELECTRON_RUN_AS_NODE`'s stdout is invisible there.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const sharedSrc = join(root, 'packages', 'shared', 'src');
const protocolSrc = join(root, 'packages', 'protocol', 'src');

function log(message) {
  process.stdout.write(`${message}\n`);
}

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
 * The fake `claude`. Speaks the two stream-json lines `mapRawEvent` reads, records its argv
 * and cwd, captures the first stdin line's prompt text to its own `prompt-N.txt`, and waits
 * for a `proceed-N` file before ending its turn — so the driver decides exactly when a turn
 * finishes. Writes `fixed.txt` into its OWN cwd the moment that prompt names the gate's
 * failure text — the one fact Scenario A's "the note really reached the agent" check rests
 * on. Scenario B's gate never looks at `fixed.txt`, so this firing harmlessly there too
 * changes nothing: there is nothing for the write to fix.
 */
function stubSource(logPath, promptsDir, proceedDir) {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const readline = require('node:readline');",
    `const LOG = ${JSON.stringify(logPath)};`,
    `const PROMPTS = ${JSON.stringify(promptsDir)};`,
    `const PROCEED = ${JSON.stringify(proceedDir)};`,
    'const argv = process.argv.slice(2);',
    'const arg = (name) => {',
    '  const i = argv.indexOf(name);',
    "  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : '';",
    '};',
    "const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    '',
    "fs.appendFileSync(LOG, JSON.stringify({ argv, cwd: process.cwd() }) + '\\n');",
    '// 1-based index of THIS invocation, read back from the log so the driver and the stub',
    "// agree on which run a `proceed-N` file releases and which `prompt-N.txt` is this run's",
    '// own. Runs never overlap here.',
    "const index = fs.readFileSync(LOG, 'utf8').trim().split('\\n').length;",
    '',
    'const rl = readline.createInterface({ input: process.stdin });',
    "rl.once('line', (line) => {",
    "  let text = '';",
    '  try {',
    '    const msg = JSON.parse(line);',
    "    const block = (msg?.message?.content ?? []).find((c) => c.type === 'text');",
    "    text = block?.text ?? '';",
    '  } catch {',
    '    // Not JSON, or not the shape we expect.',
    '  }',
    "  fs.writeFileSync(path.join(PROMPTS, 'prompt-' + index + '.txt'), text, 'utf8');",
    "  if (text.includes('GATE-SAYS-NO')) {",
    "    fs.writeFileSync(path.join(process.cwd(), 'fixed.txt'), 'fixed\\n', 'utf8');",
    '  }',
    '});',
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
    'const timer = setInterval(() => {',
    "  if (!fs.existsSync(PROCEED + '/proceed-' + index)) return;",
    '  clearInterval(timer);',
    '  say({',
    "    type: 'result',",
    "    subtype: 'success',",
    '    is_error: false,',
    "    result: 'the stub finished run ' + index,",
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

/** A real, minimal git repository — no remote. Gates/chains integrate straight into base. */
function initRepo(repoDir) {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, 'init');
  git(repoDir, 'config', 'user.email', 'verify@example.com');
  git(repoDir, 'config', 'user.name', 'Verify');
  git(repoDir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repoDir, 'seed.txt'), 'seed\n', 'utf8');
  git(repoDir, 'add', '-A');
  git(repoDir, 'commit', '--no-verify', '-m', 'initial');
  return git(repoDir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
}

async function main() {
  let status = 1;
  // The OS temp directory, deliberately, and NOT a scratch folder inside the repo: a
  // directory under a work tree IS part of that work tree, so a `git init` in one leaves
  // git confused about which repository it is standing in.
  const scratch = mkdtempSync(join(tmpdir(), 'tm-wf-gates-'));
  // Worktrees live OUTSIDE the scratch tree too — same MAX_PATH concern `verify-pr-watch.mjs`
  // documents.
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'tm-wf-gates-wt-'));
  try {
    const esbuild = findEsbuild();
    const bundle = (entry, outfile) => {
      const result = spawnSync(
        esbuild,
        [
          entry,
          '--bundle',
          '--platform=node',
          '--format=cjs',
          `--alias:@shared=${sharedSrc}`,
          `--alias:@protocol=${protocolSrc}`,
          '--external:better-sqlite3',
          '--external:electron',
          `--outfile=${outfile}`,
          '--log-level=error',
        ],
        { stdio: 'inherit' },
      );
      if (result.status !== 0) throw new Error(`esbuild failed on ${entry}`);
    };

    bundle(join(root, 'apps/client/src/main/store.ts'), join(scratch, 'store.cjs'));
    bundle(join(root, 'apps/client/src/main/sessionManager.ts'), join(scratch, 'sessionManager.cjs'));
    // Scheduler.ts pulls in `gateStep.ts`, `gateRunner.ts`, `chainRunner.ts` and
    // `@shared/workflow` itself as ordinary (non-type-only) imports — bundled in here too.
    bundle(join(root, 'apps/client/src/main/scheduler.ts'), join(scratch, 'scheduler.cjs'));
    // The driver needs its OWN `WorktreeManager` instance to hand to the `Scheduler`'s
    // constructor, and `instantiateWorkflow` to build a card's steps the way a real "apply
    // this workflow" action would — both bundled standalone since the driver calls them
    // directly rather than through the scheduler.
    bundle(join(root, 'apps/client/src/main/worktreeManager.ts'), join(scratch, 'worktreeManager.cjs'));
    bundle(join(sharedSrc, 'workflow.ts'), join(scratch, 'workflow.cjs'));

    const electron = join(
      clientModules,
      'electron',
      'dist',
      process.platform === 'win32' ? 'electron.exe' : 'electron',
    );
    if (!existsSync(electron)) throw new Error(`electron not installed at ${electron}`);

    const binDir = join(scratch, 'bin');
    const proceedDir = join(scratch, 'proceed');
    const promptsDir = join(scratch, 'prompts');
    const repoDir = join(scratch, 'repo');
    for (const dir of [binDir, proceedDir, promptsDir]) mkdirSync(dir, { recursive: true });

    const logPath = join(scratch, 'invocations.jsonl');
    writeFileSync(logPath, '', 'utf8');
    const stubPath = join(binDir, 'claude-stub.cjs');
    writeFileSync(stubPath, stubSource(logPath, promptsDir, proceedDir), 'utf8');
    writeStubCli(binDir, stubPath, electron);
    log(`Stub claude written to ${binDir}`);

    const base = initRepo(repoDir);
    log(`Real git repo at ${repoDir}, base branch "${base}"`);

    const run = spawnSync(
      electron,
      [fileURLToPath(import.meta.url), scratch, repoDir, base, worktreeRoot],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          // The bundles live in scratch, outside any node_modules tree, so the external
          // `require('better-sqlite3')` inside them needs somewhere to resolve from.
          NODE_PATH: clientModules,
          PATH: binDir + (process.platform === 'win32' ? ';' : ':') + process.env.PATH,
        },
      },
    );
    status = run.status ?? 1;
  } finally {
    if (!process.argv.includes('--keep')) {
      rmSync(worktreeRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
      rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    } else {
      log(`\nLeft ${scratch} and ${worktreeRoot} in place (--keep).`);
    }
  }
  process.exit(status);
}

// ── Phase 1: plain Node — bundle, seed a real repo, then hand over to Electron ──────────
if (!process.versions.electron) {
  await main();
}

// ── Phase 2: under Electron-as-Node — the actual checks ─────────────────────────────────

const require = createRequire(import.meta.url);
const work = process.argv[2];
const repoDir = process.argv[3];
const base = process.argv[4];
const worktreeRoot = process.argv[5];

const { createStore } = require(join(work, 'store.cjs'));
const { SessionManager } = require(join(work, 'sessionManager.cjs'));
const { Scheduler, FAILURE_ACTION } = require(join(work, 'scheduler.cjs'));
const { WorktreeManager } = require(join(work, 'worktreeManager.cjs'));
const { instantiateWorkflow } = require(join(work, 'workflow.cjs'));

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

const LOG = join(work, 'invocations.jsonl');
const PROMPTS = join(work, 'prompts');
const PROCEED = join(work, 'proceed');

/** Every invocation of the stub so far, oldest first. */
const invocations = () =>
  readFileSync(LOG, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

/** Wait for the Nth spawn (1-based) and hand it back. */
async function nthInvocation(n, what) {
  await waitFor(what, () => invocations().length >= n);
  return invocations()[n - 1] ?? { argv: [], cwd: '' };
}

/** Wait for the Nth spawn's own prompt file and read it. */
async function promptFor(n, what) {
  const path = join(PROMPTS, 'prompt-' + n + '.txt');
  await waitFor(what, () => existsSync(path));
  return readFileSync(path, 'utf8');
}

/** Let run N report its result, which is what settles it. */
const proceed = (n) => writeFileSync(join(PROCEED, 'proceed-' + n), 'go', 'utf8');

/** The value an invocation's argv was given for a flag — read positionally, as the CLI does. */
function flag(invocation, name) {
  const i = invocation.argv.indexOf(name);
  return i >= 0 && i + 1 < invocation.argv.length ? invocation.argv[i + 1] : '';
}

const store = createStore(join(work, 'orchestrator.db'));
store.saveSettings({ ...store.getSettings(), maxAutoRetries: 0, limitJitterMs: 0 });

const sessions = new SessionManager(() => {});
const taskChanges = [];
/** Every inbox item the scheduler has ever raised, in order — Scenario A's "no task-failed
 *  item" check, and Scenario B's "a task-failed item with the three gate actions" one, both
 *  read off this rather than the scheduler's live (mutable) attention map. */
const attentionItems = [];

const worktrees = new WorktreeManager(worktreeRoot);
const scheduler = new Scheduler(
  store,
  sessions,
  (change) => taskChanges.push(change),
  () => {},
  (item) => attentionItems.push(item),
  () => {},
  () => {},
  worktrees,
);

const project = store.addProject({
  path: repoDir,
  name: 'the workflow-gates repo',
  kind: 'agent',
  defaultModel: 'sonnet',
  defaultPermissionMode: 'acceptEdits',
  baseBranch: base,
});

// `PERSONAL_PROJECT_ID` from `@shared/model` — hardcoded rather than imported, since the
// driver here is plain JS calling into bundled modules, not a TS file of its own.
const PERSONAL_PROJECT_ID = 'personal';

function card(title) {
  const created = store.createTask(PERSONAL_PROJECT_ID, { title });
  if (!created) throw new Error('the store refused ' + title);
  const updated = store.updateTask(created.id, { agentProjectId: project.id });
  if (!updated) throw new Error('the store refused the patch for ' + title);
  return updated;
}

/**
 * Build a two-step workflow (an `implement` agent step, a `test` gate) exactly the way a
 * real "apply this workflow" action would: `instantiateWorkflow` produces the drafts,
 * `store.addSubtask` writes each one as a real step row, `stepSpec`/`workflowId` and all.
 *
 * `gateCommand` is the gate's own command string — the two scenarios below use different
 * ones (one that can pass, one that never can) but share this construction.
 */
function buildChain(title, gateCommand, maxAttempts) {
  const owner = card(title);
  const doc = {
    version: 1,
    id: 'wf-' + owner.id,
    name: 'Gate loop',
    steps: [
      { id: 'implement', kind: 'agent', title: 'Implement', brief: 'Implement the fix.' },
      {
        id: 'test',
        kind: 'gate',
        title: 'Run tests',
        command: gateCommand,
        onFail: { retryFrom: 'implement', maxAttempts },
      },
    ],
  };
  const drafts = instantiateWorkflow(doc, owner, 1);
  for (const draft of drafts) {
    store.addSubtask(owner.id, {
      title: draft.title,
      description: draft.description,
      round: draft.planRound,
      stepSpec: draft.stepSpec,
      workflowId: draft.workflowId,
    });
  }
  const steps = store.getSubtasks(owner.id);
  return {
    owner,
    implement: steps.find((s) => s.title === 'Implement'),
    test: steps.find((s) => s.title === 'Run tests'),
  };
}

/** Only the `task-failed` items raised for one STEP (a gate failure's `taskId` is the gate
 *  step's own id, per `raiseGateFailure` — never the owner card's). */
const taskFailedFor = (taskId) => attentionItems.filter((i) => i.kind === 'task-failed' && i.taskId === taskId);

async function runChecks() {
  // ===========================================================================
  section('Scenario A: a failing gate loops back, the agent fixes it, the gate passes');

  const gateCommand =
    process.platform === 'win32'
      ? 'if exist fixed.txt (exit /b 0) else (echo GATE-SAYS-NO & exit /b 3)'
      : 'test -f fixed.txt || { echo GATE-SAYS-NO; exit 3; }';
  const a = buildChain('Gate loop: fail then fix', gateCommand, 2);

  scheduler.runTask(a.owner.id);
  const first = await nthInvocation(1, 'the first "Implement" run to spawn');
  check('the first run is a fresh session (no --resume)', !first.argv.includes('--resume'));
  proceed(1);

  // `implement`'s status visits `pending` TWICE — once at creation (before invocation 1
  // has even been told to resume) and again once the gate's retry resets it — so waiting on
  // that status alone is ambiguous between the two. `gateAttempts` only ever moves 0 → 1 as
  // part of the SAME synchronous write as the reset and the note below, so waiting on it
  // instead pins the check to the real moment, unambiguously.
  await waitFor('the gate to fail and send step 1 back', () => store.getTask(a.test.id)?.gateAttempts === 1);
  const implementAfterFail = store.getTask(a.implement.id);
  const gateAfterFail = store.getTask(a.test.id);
  check('the gate recorded one attempt', gateAfterFail?.gateAttempts === 1, gateAfterFail?.gateAttempts);
  check('step 1 ("Implement") was sent back to pending', implementAfterFail?.status === 'pending');
  const gateNoteText = store
    .getTaskActivity(a.test.id)
    .map((e) => e.body ?? (e.kind === 'event' ? e.event?.text : undefined) ?? '')
    .join('\n');
  check(
    'the gate\'s own timeline says it sent step 1 back on attempt 1/2',
    gateNoteText.includes('sending step 1 back (attempt 1/2)'),
    gateNoteText,
  );

  const firstSessionId = flag(first, '--session-id');
  check('the first run got a real session id', firstSessionId.length > 0, firstSessionId);

  const second = await nthInvocation(2, 'the resumed "Implement" run to spawn');
  check(
    'invocation 2 resumes the SAME session as invocation 1',
    flag(second, '--resume') === firstSessionId && firstSessionId.length > 0,
    `${flag(second, '--resume')} != ${firstSessionId}`,
  );
  const secondPrompt = await promptFor(2, 'invocation 2\'s own prompt');
  check(
    'invocation 2\'s prompt carries the gate\'s failure text — the note really reached the agent',
    secondPrompt.includes('GATE-SAYS-NO'),
    secondPrompt,
  );
  proceed(2);

  await waitFor('both steps of Scenario A to finish', () => {
    const implement = store.getTask(a.implement.id);
    const test = store.getTask(a.test.id);
    return implement?.status === 'done' && test?.status === 'done';
  });
  check('step 1 ("Implement") is done', store.getTask(a.implement.id)?.status === 'done');
  check('step 2 ("Run tests") is done', store.getTask(a.test.id)?.status === 'done');
  check('exactly 2 "Implement" invocations happened', invocations().length === 2, invocations().length);
  check('no task-failed item was ever raised for the gate', taskFailedFor(a.test.id).length === 0);

  // ===========================================================================
  section('Scenario B: the retry budget runs out — a task-failed item, then Skip gate');

  const alwaysFailCommand =
    process.platform === 'win32' ? 'echo GATE-SAYS-NO & exit /b 3' : 'echo GATE-SAYS-NO; exit 3';
  const b = buildChain('Gate loop: never fixed', alwaysFailCommand, 1);

  const invocationsBeforeB = invocations().length;
  scheduler.runTask(b.owner.id);
  const bFirst = await nthInvocation(invocationsBeforeB + 1, "Scenario B's first \"Implement\" run");
  check('Scenario B\'s first run is a fresh session (no --resume)', !bFirst.argv.includes('--resume'));
  proceed(invocationsBeforeB + 1);

  // One retry is spent on the first failure (`attemptsUsed(0) < maxAttempts(1)`), so the
  // SAME session runs a second time before the budget is actually exhausted.
  await waitFor(
    'the second "Implement" run (the one retry this budget allows) to spawn',
    () => invocations().length >= invocationsBeforeB + 2,
  );
  proceed(invocationsBeforeB + 2);

  await waitFor('a task-failed item to land on the gate', () => taskFailedFor(b.test.id).length > 0);
  const failedItems = taskFailedFor(b.test.id);
  check('exactly one task-failed item was raised', failedItems.length === 1, failedItems.length);
  const item = failedItems[0];
  check(
    'it carries exactly the three gate actions',
    JSON.stringify(item.options) ===
      JSON.stringify([FAILURE_ACTION.runGateAgain, FAILURE_ACTION.sendBackToAgent, FAILURE_ACTION.skipGate]),
    JSON.stringify(item.options),
  );
  // `raiseTaskFailed` parks the task at `waiting-input` (the standard "awaiting a human
  // decision" status every parked failure — run, integration, or gate — settles on), even
  // though `GateStepRunner.settle` itself writes `failed` a moment earlier: `raiseGateFailure`
  // → `raiseTaskFailed` overwrites it synchronously right after.
  check('the gate step is parked awaiting the human\'s choice', store.getTask(b.test.id)?.status === 'waiting-input');

  scheduler.answerAttention(item.id, { decision: 'reply', text: FAILURE_ACTION.skipGate });
  await waitFor('Skip gate to land the chain', () => store.getTask(b.test.id)?.status === 'done');
  check('"Skip gate" marked the gate step done', store.getTask(b.test.id)?.status === 'done');

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);

  scheduler.dispose();
  sessions.stopAll();
  await sleep(300);
  store.close();
  process.exit(failures === 0 ? 0 : 1);
}

runChecks().catch((err) => {
  console.error(err);
  process.exit(1);
});
