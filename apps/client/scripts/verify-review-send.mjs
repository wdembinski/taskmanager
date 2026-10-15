/**
 * Headless verification for `review:send` (F6.9) — the half `reviewService.test.ts` cannot
 * reach, because that suite drives `ReviewService` against a fake `chat` and a fake
 * `DiffService`. The real claim F6.9 makes is about THREE real things joined end to end:
 *
 *  - `DiffService` resolving a real diff off a real git worktree, so `review:add`'s anchor
 *    and `review:send`'s header (head SHA, `diffId`, `baseRef`) are not fixture data;
 *  - `Scheduler.chatWithAgent`, exactly as `apps/client/src/main/ipc.ts` wires it into
 *    `ReviewService`, actually delivering the formatted batch into a running or resumed
 *    CLI's own stdin;
 *  - `Store.markReviewSent` actually stamping `sentAt` in a real SQLite row, not a fake
 *    array splice.
 *
 * So this drives the REAL `ReviewService` + `DiffService` + `Scheduler` + `SessionManager`
 * + SQLite `Store`, with a stub `claude` on PATH standing in for the CLI (same recipe as
 * `scripts/verify-token-savings.mjs` and `scripts/verify-limit-park.mjs`). Unlike those two,
 * the stub here also makes a real git commit in its own worktree before it says a word —
 * standing in for "the agent wrote some code" — so `DiffService` has a real file to diff.
 *
 * Three scenarios:
 *
 *  1. Before the card has ever run, `review:send` refuses `no-branch` (no worktree, no
 *     branch) and an unknown task id refuses `unknown-task` — neither touches chat.
 *  2. While the card's first run is still live, `review:send` batches the one draft comment
 *     into the real message (checked against `formatReviewMessage` byte for byte) and it
 *     lands on the live session's stdin, `status: 'sent'`; the comment is stamped in the
 *     real store; a second immediate send refuses `nothing-to-send`.
 *  3. Once that run settles, a second comment sent with `review:send` resumes the task with
 *     a fresh `--resume` CLI invocation carrying the message as its prompt, `status:
 *     'resumed'` — proving the same wiring on the OTHER half of `chatWithAgent`.
 *
 * The app is NEVER launched (RELEASE.md rule 6). Nothing outside the scratch directory is
 * written: no real profile, no real git repository beyond the one this script creates and
 * removes, no network.
 *
 *   pnpm exec node scripts/verify-review-send.mjs
 *
 * Exits non-zero on the first failed assertion, naming it. To prove the harness can actually
 * fail — not just always agree with the code — flip one `check(...)`'s condition, rerun,
 * confirm a non-zero exit naming that check, then revert.
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
/** `@shared` and `@protocol` live in their own workspace packages, not under this app —
 *  the same two aliases `electron.vite.config.ts` points at their SOURCE. `scheduler.ts`
 *  reaches `@protocol/wire` through `cloudDelta.ts`, so the second alias is not optional. */
const sharedSrc = join(repo, '..', '..', 'packages', 'shared', 'src');
const protocolSrc = join(repo, '..', '..', 'packages', 'protocol', 'src');

/**
 * Everything this script writes lives here, INSIDE the repo rather than in the temp dir,
 * for one reason: the bundle keeps `better-sqlite3` external, so it must sit somewhere
 * Node's resolution can still find `node_modules`. Removed on the way out, and on the way
 * in — a crashed previous run must not leak into this one.
 */
const work = join(repo, '.verify-review-send');

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
    resolve: { alias: { '@shared': sharedSrc, '@protocol': protocolSrc, electron: stub } },
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

/**
 * The fake `claude`, written as a `.cjs` the shim on PATH invokes.
 *
 * Beyond recording argv and speaking the two stream-json lines `mapRawEvent` reads (same as
 * every other stub in this family), this one also:
 *
 *  - makes a REAL git commit in its own cwd the first time it sees that worktree has no
 *    `feature.txt` yet — standing in for "the agent wrote some code", so `DiffService` has
 *    a real diff to resolve rather than an empty worktree. Done synchronously, before the
 *    invocation is even logged, so by the time the driver observes the log entry the commit
 *    has already landed on disk;
 *  - captures EVERY line written to its stdin, not just the first — a chat message pushed
 *    into a still-open session (`SessionManager.send`) arrives as a SECOND line on the same
 *    process, after the run's own opening brief, and the driver needs to read both.
 */
function stubSource(logPath, promptsDir, proceedDir) {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { execFileSync } = require('node:child_process');",
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
    '// Index computed from what is on disk BEFORE this invocation is logged, so the commit',
    '// below is guaranteed to have happened by the time the driver sees the log entry.',
    'const priorLines = fs.existsSync(LOG)',
    "  ? fs.readFileSync(LOG, 'utf8').trim().split('\\n').filter(Boolean).length",
    '  : 0;',
    'const index = priorLines + 1;',
    '',
    '// "The agent wrote some code": a real file, really committed, the first time this',
    "// worktree doesn't have it yet. A resumed invocation reuses the same worktree and skips",
    '// this, since there is nothing new to write.',
    'const cwd = process.cwd();',
    "const featurePath = path.join(cwd, 'feature.txt');",
    'if (!fs.existsSync(featurePath)) {',
    "  fs.writeFileSync(featurePath, 'line one\\nline two\\nline three\\n', 'utf8');",
    "  execFileSync('git', ['add', '-A'], { cwd });",
    "  execFileSync('git', ['commit', '--no-verify', '-m', 'agent: add feature.txt'], { cwd });",
    '}',
    '',
    "fs.appendFileSync(LOG, JSON.stringify({ argv, cwd }) + '\\n');",
    '',
    '// Every line this process receives on stdin, numbered from 1 for THIS invocation — the',
    '// opening brief is line 1; a chat message pushed into a still-open session is line 2.',
    'let lineNo = 0;',
    'const rl = readline.createInterface({ input: process.stdin });',
    "rl.on('line', (line) => {",
    '  lineNo += 1;',
    "  let text = '';",
    '  try {',
    '    const msg = JSON.parse(line);',
    "    const block = (msg?.message?.content ?? []).find((c) => c.type === 'text');",
    "    text = block?.text ?? '';",
    '  } catch {',
    '    // Not JSON, or not the shape we expect — an empty prompt file still unblocks a',
    '    // driver waiting on it, and a wrong-content assertion fails loudly, which is right.',
    '  }',
    '  fs.writeFileSync(',
    "    path.join(PROMPTS, 'prompt-' + index + '-' + lineNo + '.txt'),",
    '    text,',
    "    'utf8',",
    '  );',
    '});',
    '',
    'say({',
    "  type: 'system',",
    "  subtype: 'init',",
    "  session_id: arg('--session-id') || arg('--resume'),",
    "  model: arg('--model'),",
    '  cwd,',
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

async function main() {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  // Declared outside the try so the `finally` below can clean it up — it lives outside
  // `work` (see where it's created), so removing `work` alone would leak it.
  let worktreeRoot;

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
    const binDir = join(work, 'bin');
    const proceedDir = join(work, 'proceed');
    const promptsDir = join(work, 'prompts');
    const repoDir = join(scratch, 'repo');
    for (const dir of [scratch, binDir, proceedDir, promptsDir]) {
      mkdirSync(dir, { recursive: true });
    }
    // OUTSIDE the repo, deliberately (see verify-token-savings.mjs for why): a worktree's
    // path grows fast and this repo's own path is already a nested orchestrator checkout.
    worktreeRoot = mkdtempSync(join(tmpdir(), 'vrs-wt-'));
    initRepo(repoDir);
    log(`Real git repo initialized at ${repoDir}`);

    const logPath = join(work, 'invocations.jsonl');
    writeFileSync(logPath, '', 'utf8');
    const stubPath = join(binDir, 'claude-stub.cjs');
    writeFileSync(
      stubPath,
      stubSource(posix(logPath), posix(promptsDir), posix(proceedDir)),
      'utf8',
    );
    writeStubCli(binDir, stubPath, electron);
    log(`Stub claude written to ${binDir}`);

    const entry = join(work, 'entry.ts');
    writeFileSync(
      entry,
      SCENARIOS.replaceAll('__REPO__', posix(repo))
        .replaceAll('__SCRATCH__', posix(scratch))
        .replaceAll('__REPO_DIR__', posix(repoDir))
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
    // database (and git repo) behind, which is the only way to open one afterwards and see
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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';
import { PERSONAL_PROJECT_ID } from '@shared/model';
import { formatReviewMessage } from '@shared/review';
import { hostFor } from '__REPO__/src/main/exec';
import { Scheduler } from '__REPO__/src/main/scheduler';
import { SessionManager } from '__REPO__/src/main/sessionManager';
import { createStore } from '__REPO__/src/main/store';
import { WorktreeManager } from '__REPO__/src/main/worktreeManager';
import { createDiffGit, DiffService } from '__REPO__/src/main/review/diffService';
import { ReviewService } from '__REPO__/src/main/review/reviewService';

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
const WORKTREE_ROOT = '__WORKTREE_ROOT__';
const LOG = '__LOG__';
const PROMPTS = '__PROMPTS__';
const PROCEED = '__PROCEED__';

// The one line that makes the fake CLI the real one for this process. Everything above it
// — the scheduler, the store, the review service, the worktree manager, the spawn — is the
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

/** Wait for invocation N's Mth stdin line and read it back as text. */
async function promptLine(n, m, what) {
  const path = PROMPTS + '/prompt-' + n + '-' + m + '.txt';
  await waitFor(what, () => existsSync(path));
  return readFileSync(path, 'utf8');
}

/** Let run N report its result, which is what settles it. */
const proceed = (n) => writeFileSync(PROCEED + '/proceed-' + n, 'go', 'utf8');

/**
 * The notes \`noteRun\` files against a run (\`task_events\`) — where "Finished on branch…"
 * lands once a run settles cleanly on its branch.
 */
const runNotesOf = (taskId) =>
  store
    .getTaskHistory(taskId)
    .filter((e) => e.kind === 'assistant')
    .map((e) => e.text ?? '')
    .join('\n');

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

// The exact wiring \`apps/client/src/main/ipc.ts\` builds for \`review:send\`: a real
// \`DiffService\` bound to this project's host, and \`chat\` bound to this scheduler's own
// \`chatWithAgent\` — nothing here is a test double for either.
const diffs = new DiffService({
  getTask: (id) => store.getTask(id),
  getProject: (id) => store.getProject(id),
  inspect: (project, ownerTaskId, branchName) => worktrees.inspect(project, ownerTaskId, branchName),
  gitFor: (project) => createDiffGit(hostFor(project.target)),
  listMergeRequests: () => store.listMergeRequests(),
});
const reviews = new ReviewService({
  store,
  diffs,
  chat: (id, msg) => scheduler.chatWithAgent(id, msg),
});

// \`store.addProject\` forces \`useWorktrees\` on for every \`kind: 'agent'\` project — every
// agent-delegated card in this app runs in a worktree, which is what gives \`DiffService\` a
// live worktree to resolve instead of falling back to the bare project branch.
const project = store.addProject({
  path: REPO_DIR,
  name: 'the review repo',
  kind: 'agent',
  defaultModel: 'sonnet',
  defaultPermissionMode: 'acceptEdits',
  useWorktrees: true,
});

const created = store.createTask(PERSONAL_PROJECT_ID, { title: 'Add the feature' });
if (!created) throw new Error('the store refused the card');
const card = store.updateTask(created.id, { agentProjectId: project.id });
if (!card) throw new Error('the store refused the delegation patch');

// ===========================================================================
section('1. Before the card has ever run, review:send refuses without touching chat');

const beforeRun = await reviews.send(card.id);
check(
  'no worktree and no branch yet — refused no-branch',
  JSON.stringify(beforeRun) === JSON.stringify({ status: 'refused', taskId: card.id, reason: 'no-branch' }),
  JSON.stringify(beforeRun),
);
check('nothing was spawned by that refusal', invocations().length === 0, invocations().length + ' invocation(s)');

const unknown = await reviews.send('this-task-does-not-exist');
check(
  'an unknown task id refuses unknown-task',
  JSON.stringify(unknown) ===
    JSON.stringify({ status: 'refused', taskId: 'this-task-does-not-exist', reason: 'unknown-task' }),
  JSON.stringify(unknown),
);

// ===========================================================================
section('2. While the first run is live, review:send batches the draft onto its real stdin');

scheduler.runTask(card.id);
const run1 = await nthInvocation(1, 'the first run to spawn');
check('it is a fresh run, with --session-id', run1.argv.includes('--session-id'));
const openingBrief = await promptLine(1, 1, "the first run's opening brief");
check('the opening brief is the full one, not a chat nudge', openingBrief.length > 0, openingBrief.slice(0, 80));

// The stub already committed feature.txt into the worktree before this invocation was even
// logged — so by now DiffService has a real diff to resolve.
const summary1 = await waitForSummary(card.id, 'the live diff to resolve');
check('the diff resolved ok while the run is live', summary1.status === 'ok', JSON.stringify(summary1));
const featureFile = summary1.status === 'ok' ? summary1.summary.files.find((f) => f.path === 'feature.txt') : undefined;
check('feature.txt shows up as an added file', featureFile?.status === 'added', JSON.stringify(featureFile));

const added = await reviews.add({
  taskId: card.id,
  diffId: summary1.summary.diffId,
  path: 'feature.txt',
  side: 'new',
  line: 2,
  body: 'please rename this',
});
check('the comment anchored against the real diff', added.status === 'ok', JSON.stringify(added));
check(
  'its excerpt is the REAL line from the committed file',
  added.status === 'ok' && added.comment.excerpt === 'line two',
  added.status === 'ok' ? added.comment.excerpt : JSON.stringify(added),
);

const sendWhileLive = await reviews.send(card.id, 'overall note');
check(
  'review:send delivered into the live session',
  sendWhileLive.status === 'sent' && sendWhileLive.taskId === card.id,
  JSON.stringify(sendWhileLive),
);
check(
  'exactly one comment was stamped, and it is the one just added',
  sendWhileLive.status === 'sent' &&
    sendWhileLive.comments.length === 1 &&
    sendWhileLive.comments[0].id === (added.status === 'ok' ? added.comment.id : null) &&
    typeof sendWhileLive.comments[0].sentAt === 'number',
  JSON.stringify(sendWhileLive),
);
check(
  'the REAL store agrees — sentAt is set there too',
  store.listReviewComments(card.id).find((c) => c.id === (added.status === 'ok' ? added.comment.id : ''))?.sentAt !=
    null,
  JSON.stringify(store.listReviewComments(card.id)),
);
check('sending did not spawn a second CLI', invocations().length === 1, invocations().length + ' invocation(s)');

const chatLine = await promptLine(1, 2, "the chat message pushed into the live session's stdin");
const expectedMessage =
  added.status === 'ok'
    ? formatReviewMessage([{ ...added.comment, outdated: false }], summary1.summary, 'overall note')
    : '<unreachable>';
check(
  'and it is EXACTLY the batched review message, byte for byte',
  chatLine === expectedMessage,
  'got:\n' + chatLine + '\n---\nwanted:\n' + expectedMessage,
);

const nothingToSend = await reviews.send(card.id);
check(
  'a second immediate send has nothing left to batch',
  JSON.stringify(nothingToSend) === JSON.stringify({ status: 'refused', taskId: card.id, reason: 'nothing-to-send' }),
  JSON.stringify(nothingToSend),
);

// ===========================================================================
section('3. Once the run settles, review:send resumes the task with a fresh CLI');

proceed(1);
await waitFor('the first run to settle', () => runNotesOf(card.id).includes('Finished on branch'));
check('settling did not touch the stamped comment', store.listReviewComments(card.id)[0].sentAt != null);

const summary2 = await waitForSummary(card.id, 'the diff to still resolve once settled');
check('the diff still resolves after settling', summary2.status === 'ok', JSON.stringify(summary2));

const secondDraft = await reviews.add({
  taskId: card.id,
  diffId: summary2.summary.diffId,
  path: 'feature.txt',
  side: 'new',
  line: 3,
  body: 'and this one too',
});
check('a second draft anchored fine after settling', secondDraft.status === 'ok', JSON.stringify(secondDraft));

const sendAfterSettle = await reviews.send(card.id);
check(
  'review:send resumed the task — no live session to push into',
  sendAfterSettle.status === 'resumed' && sendAfterSettle.taskId === card.id,
  JSON.stringify(sendAfterSettle),
);

const run2 = await nthInvocation(2, 'the resumed run to spawn');
check(
  'the resumed run carries --resume, naming the session the FIRST run opened',
  run2.argv.includes('--resume') && flag(run2, '--resume') === flag(run1, '--session-id'),
  run2.argv.join(' ') + ' vs first session ' + flag(run1, '--session-id'),
);

const resumedPrompt = await promptLine(2, 1, "the resumed run's prompt");
const expectedResumedMessage =
  secondDraft.status === 'ok'
    ? formatReviewMessage([{ ...secondDraft.comment, outdated: false }], summary2.summary, undefined)
    : '<unreachable>';
check(
  'and that prompt IS the second batched review message',
  resumedPrompt === expectedResumedMessage,
  'got:\n' + resumedPrompt + '\n---\nwanted:\n' + expectedResumedMessage,
);
check(
  'the second comment is stamped in the real store too',
  secondDraft.status === 'ok' &&
    store.listReviewComments(card.id).find((c) => c.id === secondDraft.comment.id)?.sentAt != null,
  JSON.stringify(store.listReviewComments(card.id)),
);

// Let run 2 report its result and settle before teardown; nothing further is asserted
// about it — its argv and prompt, checked above, are the whole of what this scenario is
// about.
proceed(2);
await sleep(500);

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

/** \`diffs.summary\`, retried briefly — the first call right after a live run spawns can
 *  race the worktree still being set up, or the commit the stub makes inside it. */
async function waitForSummary(taskId, what) {
  const started = Date.now();
  let last;
  while (Date.now() - started < 30000) {
    last = await diffs.summary(taskId);
    if (last.status === 'ok') return last;
    await sleep(50);
  }
  check('waited for ' + what, false, JSON.stringify(last));
  return last;
}
`;

await main();
