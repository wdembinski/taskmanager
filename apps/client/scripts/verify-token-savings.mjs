/**
 * Headless verification for the token-usage audit's four fixes (S1, S2, S3, S5) — the half
 * `vitest` cannot reach, because it needs the REAL engine end to end.
 *
 * Each fix is a claim about what gets sent to the `claude` CLI, and only two things can
 * answer that honestly: what actually reaches the process's stdin (the prompt) and what
 * reaches its argv (`--resume` or not). A fake `SessionManager` that records a
 * `StartSessionRequest` would stop one link short of the thing being asserted — this drives
 * the REAL `Scheduler`, the REAL `SessionManager`, a REAL SQLite store, and a REAL git
 * repository through `WorktreeManager`, exactly as `scripts/verify-model-split.mjs` does for
 * the model split, and extends that script's stub `claude` to also capture the PROMPT (the
 * model-split script only needed argv).
 *
 * What each scenario proves:
 *
 *  1. **S5** — a chain's last step landing files a summary on the parent and starts NO
 *     session. `finishParentChain` clears the card's `sessionId` and stamps `chainLandedAt`;
 *     nothing here spawns `claude`.
 *  2. **S5, the other half** — the first chat message sent to that finished card DOES start
 *     a session, and it is a fresh one: no `--resume`, a full brief (not a continuation of
 *     the planner's conversation, which `finishParentChain` deliberately let go stale).
 *  3. **S2 + S3** — a task's first run is fresh (full brief, ticket description included);
 *     when it fails with a retryable reason, the auto-retry resumes the SAME session and
 *     sends only the failure note — never the ticket description again.
 *  4. **S1** — a card whose notes exceed the character budget gets the newest ones and an
 *     explicit line naming how many were dropped, never a silent truncation.
 *
 * Reaching #1 and #2 needs a plan approved into steps and a step whose `settle()` takes the
 * worktree branch — that only happens when `WorktreeManager` is wired in, which is why this
 * script (unlike `verify-model-split.mjs`) sets up a REAL git repository. No merge is
 * required to observe S5: `settle()` calls `finishParentChain` the moment a chain's last step
 * lands on its branch, whether or not that branch has since been merged (auto-integrate is
 * off by default, which is what this script relies on rather than sets).
 *
 * The app is NEVER launched (RELEASE.md rule 6). Nothing outside the scratch directory is
 * written: no real profile, no real git repository beyond the one this script creates and
 * removes, no network.
 *
 *   pnpm exec node scripts/verify-token-savings.mjs
 *
 * Exits non-zero on the first failed assertion, naming it. To prove the harness can actually
 * fail — not just always agree with the code — flip one `check(...)`'s condition (e.g. negate
 * it), rerun, confirm a non-zero exit naming that check, then revert.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
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
const work = join(repo, '.verify-token-savings');

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
 * The plan the stub "produces" for the one card this script plans. A single phase is
 * enough — the point of the chain scenario is what happens once its LAST step lands, and a
 * one-step chain reaches that on its first step.
 */
const PLAN = [
  '# Add a small feature',
  '',
  '## Overview',
  '',
  'Framing, not work. The splitter drops this heading.',
  '',
  '## Phase 1 — Do the one thing',
  '',
  'Make the one change this card is about.',
].join('\n');

/**
 * The fake `claude`, written as a `.cjs` the shim on PATH invokes.
 *
 * Beyond what `verify-model-split.mjs`'s stub does (record argv, speak the two stream-json
 * lines `mapRawEvent` reads, wait for a `proceed-N` file before reporting success), this one
 * also:
 *
 *  - reads the FIRST line off stdin — the only message `SessionManager.start` ever writes
 *    before leaving stdin open (`encodeUserMessage(req.prompt)`) — and saves it to its own
 *    `prompt-N.txt`, so the driver can assert what the brief actually said;
 *  - honors a `fail-N` file the same way `proceed-N` means success, so the retry scenario
 *    (S2 + S3) can make one specific invocation fail on command.
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
    '// agree on which run a `proceed-N`/`fail-N` file releases, and which `prompt-N.txt` is',
    '// this run\'s own. Runs never overlap here.',
    "const index = fs.readFileSync(LOG, 'utf8').trim().split('\\n').length;",
    '',
    '// The prompt arrives asynchronously over stdin — write it out as soon as it does, so a',
    '// scenario that only cares about argv is never held up by one that also wants the text.',
    'const rl = readline.createInterface({ input: process.stdin });',
    "rl.once('line', (line) => {",
    '  let text = \'\';',
    '  try {',
    '    const msg = JSON.parse(line);',
    "    const block = (msg?.message?.content ?? []).find((c) => c.type === 'text');",
    "    text = block?.text ?? '';",
    '  } catch {',
    '    // Not JSON, or not the shape we expect — an empty prompt file still unblocks a',
    '    // driver waiting on it, and a wrong-content assertion fails loudly, which is right.',
    '  }',
    "  fs.writeFileSync(path.join(PROMPTS, 'prompt-' + index + '.txt'), text, 'utf8');",
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
    "    if (fs.existsSync(PROCEED + '/fail-' + index)) {",
    '      clearInterval(timer);',
    '      say({',
    "        type: 'result',",
    "        subtype: 'error',",
    '        is_error: true,',
    "        result: 'the stub failed run ' + index,",
    '        total_cost_usd: 0,',
    '      });',
    '      return;',
    '    }',
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
    '// Never self-exit — the scheduler kills the process after `result` (or after `stop()`',
    '// on a still-running one), exactly as it does the real CLI. The backstop is only so a',
    '// crashed driver leaves nothing behind.',
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

/** A real, minimal git repository — `WorktreeManager` needs one to prepare anything from. */
function initRepo(dir) {
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  mkdirSync(dir, { recursive: true });
  git(['init']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'seed.txt'), 'seed\n', 'utf8');
  git(['add', '-A']);
  git(['commit', '--no-verify', '-m', 'initial']);
}

async function main() {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  // Declared outside the try so the `finally` below can clean it up — it lives outside
  // `work` (see where it's created), so removing `work` alone would leak it.
  let worktreeRoot;

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
    const promptsDir = join(work, 'prompts');
    const repoDir = join(scratch, 'repo');
    const sharedDir = join(scratch, 'shared-repo');
    for (const dir of [scratch, binDir, proceedDir, promptsDir, sharedDir]) {
      mkdirSync(dir, { recursive: true });
    }
    // OUTSIDE the repo, deliberately: a worktree's path grows fast (project id + task id +
    // git's own `.git/worktrees/<branch>/...` internals), and this repo's own path is
    // already long (a nested orchestrator worktree checkout) — nesting worktrees inside it
    // too is exactly how `git worktree add` hits Windows' MAX_PATH with "Filename too long".
    // The OS temp root is the shortest stable prefix available.
    worktreeRoot = mkdtempSync(join(tmpdir(), 'vts-wt-'));
    initRepo(repoDir);
    initRepo(sharedDir);
    log(`Real git repos initialized at ${repoDir} and ${sharedDir}`);

    const logPath = join(work, 'invocations.jsonl');
    writeFileSync(logPath, '', 'utf8');
    const stubPath = join(binDir, 'claude-stub.cjs');
    writeFileSync(stubPath, stubSource(posix(logPath), posix(promptsDir), posix(proceedDir)), 'utf8');
    writeStubCli(binDir, stubPath, electron);
    log(`Stub claude written to ${binDir}`);

    const entry = join(work, 'entry.ts');
    writeFileSync(
      entry,
      SCENARIOS.replaceAll('__REPO__', posix(repo))
        .replaceAll('__SCRATCH__', posix(scratch))
        .replaceAll('__REPO_DIR__', posix(repoDir))
        .replaceAll('__SHARED_DIR__', posix(sharedDir))
        .replaceAll('__WORKTREE_ROOT__', posix(worktreeRoot))
        // Quoted by JSON so a Windows path's backslashes survive into the scenario's own
        // source, where a bare C:\Users\... would be read as escape sequences.
        .replaceAll('__BIN__', JSON.stringify(binDir))
        .replaceAll('__LOG__', posix(logPath))
        .replaceAll('__PROMPTS__', posix(promptsDir))
        .replaceAll('__PROCEED__', posix(proceedDir)),
      'utf8',
    );
    log('\nRunning the scenarios against the current code...');
    runUnderElectron(await bundle(entry, join(work, 'out')));

    log('\nAll scenarios passed.');
  } finally {
    // `--keep` leaves the bundle, the invocation log, the prompt captures and the scratch
    // database (and git repos) behind, which is the only way to open one afterwards and see
    // what a failing scenario actually did.
    if (process.argv.includes('--keep')) {
      log(`\nLeft ${work} in place (--keep).`);
      if (worktreeRoot) log(`Left the worktrees in place too, at ${worktreeRoot}.`);
    } else if (worktreeRoot) {
      rmSync(worktreeRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    }
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
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';
import { PERSONAL_PROJECT_ID } from '@shared/model';
import { Scheduler } from '__REPO__/src/main/scheduler';
import { SessionManager } from '__REPO__/src/main/sessionManager';
import { createStore } from '__REPO__/src/main/store';
import { WorktreeManager } from '__REPO__/src/main/worktreeManager';

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
const REPO_DIR = '__REPO_DIR__';
const SHARED_DIR = '__SHARED_DIR__';
const WORKTREE_ROOT = '__WORKTREE_ROOT__';
const LOG = '__LOG__';
const PROMPTS = '__PROMPTS__';
const PROCEED = '__PROCEED__';

// The one line that makes the fake CLI the real one for this process. Everything above it
// — the scheduler, the store, the worktree manager, the spawn — is the app's own code.
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
  return invocations()[n - 1] ?? { argv: [], cwd: '' };
}

/** Wait for the Nth spawn's own prompt file (written once its stdin line arrives) and read it. */
async function promptFor(n, what) {
  const path = PROMPTS + '/prompt-' + n + '.txt';
  await waitFor(what, () => existsSync(path));
  return readFileSync(path, 'utf8');
}

/**
 * A card's whole timeline as one string. Used to detect that a run actually SETTLED —
 * not \`task.status\`, which a plain card never keeps: \`guardCardStatus\` (the "a card's
 * state is the human's" rule) rewrites every \`in-progress\` the scheduler proposes back to
 * whatever the card was resting at before the run (here, \`pending\` — nobody dragged these
 * cards anywhere), so a card that settled cleanly and one that never ran look identical by
 * status alone. The "Finished on branch" note settle() files is the honest signal.
 */
const timelineOf = (taskId) =>
  store
    .getTaskActivity(taskId)
    .map((e) => e.body ?? '')
    .join('\n');

/**
 * The notes \`noteRun\` files against a run — a DIFFERENT table from \`timelineOf\` above
 * (\`task_events\`, not \`task_activity\`: a run-scoped note, not a card comment). This is
 * where "Finished on branch…" — settle()'s own signal that it reached the unmerged-parked
 * branch — actually lands.
 */
const runNotesOf = (taskId) =>
  store
    .getTaskHistory(taskId)
    .filter((e) => e.kind === 'assistant')
    .map((e) => e.text ?? '')
    .join('\n');

/** Let run N report its result, which is what advances the chain. */
const proceed = (n) => writeFileSync(PROCEED + '/proceed-' + n, 'go', 'utf8');
/** Tell run N to report a failure instead — for the retry scenario. */
const fail = (n) => writeFileSync(PROCEED + '/fail-' + n, 'go', 'utf8');

const worktrees = new WorktreeManager(WORKTREE_ROOT);
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
  worktrees,
);

// Two separate repos so the chain scenario's card and the retry/notes scenarios' cards
// never share a worktree. \`store.addProject\` forces \`useWorktrees\` on for every
// \`kind: 'agent'\` project regardless of what is passed — every agent-delegated card in
// this app runs in a worktree, which is also exactly what \`settle()\` needs to see a
// branch and call \`finishParentChain\`.
const chainProject = store.addProject({
  path: REPO_DIR,
  name: 'the chain repo',
  kind: 'agent',
  defaultModel: 'sonnet',
  defaultPermissionMode: 'acceptEdits',
});
const sharedProject = store.addProject({
  path: SHARED_DIR,
  name: 'the other repo',
  kind: 'agent',
  defaultModel: 'sonnet',
  defaultPermissionMode: 'acceptEdits',
});

/** A card on the Personal board, delegated to the given agent project. */
function card(title, patch, projectId) {
  const created = store.createTask(PERSONAL_PROJECT_ID, { title });
  if (!created) throw new Error('the store refused ' + title);
  const updated = store.updateTask(created.id, { agentProjectId: projectId, ...patch });
  if (!updated) throw new Error('the store refused the patch for ' + title);
  return updated;
}

// ===========================================================================
section('1. S5 — a chain landing files a summary and spawns no session');

const chained = card('Add a small feature', { agentMode: 'plan', agentModel: null }, chainProject.id);
scheduler.runTask(chained.id);
const planning = await nthInvocation(1, 'the planning run to spawn');
check(
  'the planning run asked for a plan',
  flag(planning, '--permission-mode') === 'plan',
  flag(planning, '--permission-mode'),
);

await waitFor('the plan to reach the inbox', () => raised.some((i) => i.kind === 'plan-approval'));
const approval = raised.find((i) => i.kind === 'plan-approval');
check('the one-phase plan produced exactly one step', approval.steps.length === 1, JSON.stringify(approval?.steps));
scheduler.answerAttention(approval.id, { decision: 'approve' });

await waitFor('the step to be created', () => store.getSubtasks(chained.id).length === 1);

const stepRun = await nthInvocation(2, 'the step to spawn');
check(
  'the step ran in its own worktree, not the project directory',
  stepRun.cwd.replace(/\\/g, '/') !== REPO_DIR,
  stepRun.cwd,
);
check(
  'the step inherited bypassPermissions from the approved plan',
  flag(stepRun, '--permission-mode') === 'bypassPermissions',
  flag(stepRun, '--permission-mode'),
);
proceed(2);

// finishParentChain runs synchronously off settle() the moment this last step "lands" on
// its branch — no merge required (auto-integrate is off by default, and this script never
// turns it on). It clears the card's session and stamps chainLandedAt.
await waitFor(
  'the chain to land on the parent card',
  () => {
    const t = store.getTask(chained.id);
    return t.sessionId === null && t.chainLandedAt !== null;
  },
);

check(
  'landing the chain did not spawn a THIRD session',
  invocations().length === 2,
  invocations().length + ' invocation(s)',
);
check(
  'a chain summary was filed on the parent card timeline',
  timelineOf(chained.id).includes('Plan complete'),
  timelineOf(chained.id).slice(0, 200),
);

// ---------------------------------------------------------------------------
section('2. S5 — the first chat message after that spawns ONE session, fresh');

const plannerSessionId = flag(planning, '--session-id');
const chat = scheduler.chatWithAgent(chained.id, 'How did the small feature go?');
check('the chat was accepted as a new run', chat.status === 'resumed', JSON.stringify(chat));

const reviewRun = await nthInvocation(3, 'the review run to spawn');
check(
  'it does NOT resume any session at all',
  !reviewRun.argv.includes('--resume'),
  reviewRun.argv.join(' '),
);
check(
  'in particular, it never names the planner session id',
  !reviewRun.argv.includes(plannerSessionId),
  reviewRun.argv.join(' '),
);
check('it starts fresh, with --session-id', reviewRun.argv.includes('--session-id'));

const reviewPrompt = await promptFor(3, 'the review run prompt');
check(
  'the fresh brief carries what the human just typed',
  reviewPrompt.includes('How did the small feature go?'),
  reviewPrompt.slice(0, 200),
);
check(
  'and it is a FULL brief, not a resume nudge — it names the project',
  reviewPrompt.includes('You are working in the repository for the project'),
  reviewPrompt.slice(0, 200),
);
// Not proceeded, deliberately: this run's permission-mode is 'plan' (inherited from the
// card, which was assigned 'plan' to drive the chain in section 1 — a card's mode outlives
// the chain that used it, so the review conversation inherits it too). The stub already
// answered with ExitPlanMode the instant it saw that, exactly as the real CLI would if
// asked to continue a plan-mode conversation; it never reads a proceed file. What this
// scenario is about — argv and the prompt text — is already asserted above. Left running;
// \`sessions.stopAll()\` kills it at the very end, same as \`verify-model-split.mjs\` leaves
// its own plan-mode chat run (its scenario 4) unproceeded.

// ===========================================================================
section('3. S2 + S3 — a retry on a resumed session sends the failure note, not the ticket again');

const retryCard = card(
  'Fix the parser',
  {
    externalKey: 'ORC-42',
    externalDescription: 'TICKET_DESCRIPTION_MARKER: the parser drops trailing commas.',
  },
  sharedProject.id,
);
scheduler.runTask(retryCard.id);
const firstAttempt = await nthInvocation(4, 'the first attempt to spawn');
check('the first attempt is fresh — no --resume', !firstAttempt.argv.includes('--resume'));
const firstPrompt = await promptFor(4, 'the first attempt prompt');
check(
  'and its full brief carries the ticket description',
  firstPrompt.includes('TICKET_DESCRIPTION_MARKER'),
  firstPrompt.slice(0, 300),
);
fail(4);

const retryAttempt = await nthInvocation(5, 'the auto-retry to spawn');
check(
  'the retry RESUMES the session the first attempt opened',
  retryAttempt.argv.includes('--resume') &&
    flag(retryAttempt, '--resume') === flag(firstAttempt, '--session-id'),
  retryAttempt.argv.join(' ') + ' vs first session ' + flag(firstAttempt, '--session-id'),
);
const retryPrompt = await promptFor(5, 'the retry prompt');
check(
  'it carries the failure note',
  retryPrompt.toLowerCase().includes('previous attempt') &&
    retryPrompt.includes('the session ended without success'),
  retryPrompt,
);
check(
  'and it does NOT re-send the ticket description — that is what --resume is for',
  !retryPrompt.includes('TICKET_DESCRIPTION_MARKER'),
  retryPrompt,
);
proceed(5);
await waitFor('the retry to settle', () => runNotesOf(retryCard.id).includes('Finished on branch'));

// ===========================================================================
section('4. S1 — a long note history sends the bounded set plus the omission line');

const notesCard = card('Card with a lot of history', {}, sharedProject.id);
const NOTE_COUNT = 40;
for (let i = 0; i < NOTE_COUNT; i++) {
  store.addComment(notesCard.projectId, notesCard.id, 'note-' + i + ': ' + 'x'.repeat(400));
}
scheduler.runTask(notesCard.id);
const notesRun = await nthInvocation(6, 'the notes-card run to spawn');
check('it is a fresh run, so the full (bounded) brief is built', !notesRun.argv.includes('--resume'));
const notesPrompt = await promptFor(6, 'the notes-card prompt');

const omissionMatch = notesPrompt.match(/_\((\d+) earlier notes? omitted — ask if you need them\.\)_/);
check('the brief carries an omission line', Boolean(omissionMatch), notesPrompt.slice(0, 400));
const omitted = omissionMatch ? Number(omissionMatch[1]) : 0;
const keptCount = (notesPrompt.match(/note-\d+:/g) ?? []).length;
check(
  'the omitted count plus the kept notes add up to every note that was written',
  omitted + keptCount === NOTE_COUNT,
  omitted + ' omitted + ' + keptCount + ' kept vs ' + NOTE_COUNT + ' written',
);
check('it is a real cap, not a no-op — something was actually dropped', omitted > 0, String(omitted));
check(
  'the newest note survived the cap',
  notesPrompt.includes('note-' + (NOTE_COUNT - 1) + ':'),
  notesPrompt.slice(-200),
);
check('the oldest note did not', !notesPrompt.includes('note-0:'), notesPrompt.slice(0, 400));
proceed(6);
await waitFor('the notes-card run to settle', () => runNotesOf(notesCard.id).includes('Finished on branch'));

// ===========================================================================
// Kill every stub still waiting before the database is closed. The pause is for Windows:
// termination is a taskkill of its own, and a stub whose CWD is a worktree keeps that
// directory locked until it is really gone.
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
