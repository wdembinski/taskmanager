/**
 * Headless proof of "Review open tickets" — a project's open tickets go to ONE read-only
 * agent run, its fenced report is stored against the project, and each recommendation's
 * Apply changes the board, through the REAL engine.
 *
 *     node scripts/verify-board-review.mjs
 *
 * ## Why this is a script and not a test
 *
 * `boardReview.test.ts`, `boardReviewPrompt.test.ts`, `boardReviewer.test.ts` and
 * `boardReviewApply.test.ts` prove the parser, the prompt, the reviewer and every Apply
 * against fakes. None of them can say whether the real `Scheduler.startAuxiliarySession`
 * really spawns a read-only CLI in the project's repo, whether the `board_reviews` table
 * really stores and reads back a report, or whether a DROP really hides a ticket through the
 * real archived epic — the store has no unit tests (the `the-store-has-no-tests` memory).
 *
 * So, the same way `verify-ai-visual-review.mjs` does, this bundles the app's own modules
 * with esbuild and runs them under Electron-as-Node — no window, no second instance of the
 * app — against:
 *
 *  - a real SQLite store (`better-sqlite3`, which only loads under Electron's ABI), and
 *  - a stub `claude` on PATH that records its argv, cwd and stdin prompt, and holds its
 *    `result` until the driver drops a `proceed-N` file — whose CONTENT is the turn's
 *    `resultText`, so the driver plays the reviewer's report.
 *
 * `ipc.ts`'s handlers are out of reach from here (`registerIpcHandlers` builds its own store
 * and scheduler — the `headless-scenario-harness-traps` memory), so `boardReviewer`,
 * `drawChainLink`, `archiveHandlers` and the `project:applyReviewItem` deps below restate its
 * closures line for line.
 *
 * The fixture: a scratch git repo with a `src/a.ts`, and a project on it with a ready-lane
 * cap of 2, an epic, a milestone, four open native tickets (an arrow from the first to the
 * second) and one done ticket.
 *
 * ## What it proves
 *
 *  A. **A report, stored and applied.** `boardReviewer.start` spawns the CLI with
 *     `--permission-mode plan`, `--disallowedTools` and the repo as its cwd; the prompt names
 *     every open ref, the done ticket's title, the cap of 2 and the rubric. The stub answers
 *     with a report; `getLatestBoardReview` is `done` with each verdict on its task id. Then
 *     DROP, REORDER, SPLIT and DECIDE are applied one by one: the archived Dropped epic, the
 *     dropped ticket hidden through it (its own `archivedAt` still null), the new arrow, the
 *     split parts with the original under Dropped, the decision question — and a second
 *     Apply of the same item refused.
 *  B. **A malformed answer fails.** A result with no fenced json report settles the review as
 *     `failed`, with the parser's error.
 *
 * ## Prove it can fail
 *
 * In `apps/client/src/main/boardReviewApply.ts`, delete the `deps.setDecision(...)` line under
 * `case 'DECIDE'`. Re-run and Scenario A goes red on the decision question. Restore the file
 * (`git diff` empty) and the run is green again.
 *
 * Pass `--keep` to leave the scratch directory behind. Exits non-zero naming every failed
 * check.
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
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const sharedSrc = join(root, 'packages', 'shared', 'src');
const protocolSrc = join(root, 'packages', 'protocol', 'src');

function log(message) {
  process.stdout.write(`${message}\n`);
}

/** esbuild's per-platform binary, found by pattern so a dependency bump cannot rot it. */
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
 * The fake `claude`. Records its argv, cwd and pid, captures the stdin prompt to
 * `prompt-N.txt`, and waits for `proceed-N` before ending its turn — with that file's content
 * as the turn's `result`, so the driver decides both WHEN a review finishes and WHAT it said.
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
    "fs.appendFileSync(LOG, JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid }) + '\\n');",
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
    "  const file = PROCEED + '/proceed-' + index;",
    '  if (!fs.existsSync(file)) return;',
    '  clearInterval(timer);',
    "  const text = fs.readFileSync(file, 'utf8');",
    '  say({',
    "    type: 'result',",
    "    subtype: 'success',",
    '    is_error: false,',
    "    result: text || 'the stub finished run ' + index,",
    '    total_cost_usd: 0,',
    '  });',
    '}, 20);',
    '',
    '// Never self-exit — the scheduler kills the process after `result`, as it does the real',
    '// CLI. The backstop is only so a crashed driver leaves nothing behind.',
    'process.stdin.resume();',
    'setTimeout(() => process.exit(0), 120000);',
  ].join('\n');
}

/** The one module this script bundles: everything the driver touches, in ONE copy. */
function entrySource() {
  const main = (p) => JSON.stringify(join(root, 'apps/client/src/main', p).replace(/\\/g, '/'));
  const shared = (p) => JSON.stringify(join(sharedSrc, p).replace(/\\/g, '/'));
  return [
    `export { createStore } from ${main('store')};`,
    `export { SessionManager } from ${main('sessionManager')};`,
    `export { Scheduler } from ${main('scheduler')};`,
    `export { createBoardReviewer } from ${main('boardReviewer')};`,
    `export { applyBoardReviewItem, DROPPED_EPIC_TITLE } from ${main('boardReviewApply')};`,
    `export { createArchiveHandlers } from ${main('archiveHandlers')};`,
    `export { BOARD_REVIEW_RUBRIC } from ${shared('boardReview')};`,
    `export { canLink } from ${shared('taskChain')};`,
    `export { archiveIndexOf, isHidden, visibleTickets } from ${shared('trackerArchive')};`,
    '',
  ].join('\n');
}

async function main() {
  let status = 1;
  // The OS temp directory, NOT a folder inside the repo: the scratch repo below must be a
  // repository of its own, and a directory under a work tree IS part of that work tree.
  const scratch = mkdtempSync(join(tmpdir(), 'tm-board-review-'));
  try {
    const esbuild = findEsbuild();
    const entry = join(scratch, 'entry.mjs');
    writeFileSync(entry, entrySource(), 'utf8');
    // `electron` external for the reason `verify-pr-watch.mjs` gives: inlined, its loader
    // resolves off the bundle's own `__dirname` and throws "Electron failed to install".
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
        `--outfile=${join(scratch, 'app.cjs')}`,
        '--log-level=error',
      ],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) throw new Error('esbuild failed');

    const electron = join(
      clientModules,
      'electron',
      'dist',
      process.platform === 'win32' ? 'electron.exe' : 'electron',
    );
    if (!existsSync(electron)) throw new Error(`electron not installed at ${electron}`);

    const binDir = join(scratch, 'bin');
    for (const dir of [binDir, join(scratch, 'proceed'), join(scratch, 'prompts')]) {
      mkdirSync(dir, { recursive: true });
    }
    const logPath = join(scratch, 'invocations.jsonl');
    writeFileSync(logPath, '', 'utf8');
    const stubPath = join(binDir, 'claude-stub.cjs');
    writeFileSync(
      stubPath,
      stubSource(logPath, join(scratch, 'prompts'), join(scratch, 'proceed')),
      'utf8',
    );
    writeStubCli(binDir, stubPath, electron);

    // The fixture project's repository: one source file the reviewer could cite.
    const repoDir = join(scratch, 'repo');
    const git = (...args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' });
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    git('init');
    git('config', 'user.email', 'verify@example.com');
    git('config', 'user.name', 'Verify');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
    writeFileSync(
      join(repoDir, 'src', 'a.ts'),
      'export const a = 1;\nexport const sum = (x: number) => x + a;\n',
      'utf8',
    );
    git('add', '-A');
    git('commit', '--no-verify', '-m', 'initial');
    const base = git('rev-parse', '--abbrev-ref', 'HEAD').trim();

    const run = spawnSync(electron, [fileURLToPath(import.meta.url), scratch, repoDir, base], {
      stdio: 'inherit',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        // The bundle lives in temp, outside any node_modules tree, so its external
        // `require('better-sqlite3')` needs somewhere to resolve from.
        NODE_PATH: clientModules,
      },
    });
    status = run.status ?? 1;
  } finally {
    if (!process.argv.includes('--keep')) {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    } else {
      log(`\nLeft ${scratch} in place (--keep).`);
    }
  }
  process.exit(status);
}

// ── Phase 1: plain Node — bundle, set up a repo, then hand over to Electron ─────────────
if (!process.versions.electron) {
  await main();
}

// ── Phase 2: under Electron-as-Node — the actual checks ──────────────────────────────
const require = createRequire(import.meta.url);
const work = process.argv[2];
const repoDir = process.argv[3];
const base = process.argv[4];

const {
  createStore,
  SessionManager,
  Scheduler,
  createBoardReviewer,
  applyBoardReviewItem,
  DROPPED_EPIC_TITLE,
  createArchiveHandlers,
  BOARD_REVIEW_RUBRIC,
  canLink,
  archiveIndexOf,
  isHidden,
  visibleTickets,
} = require(join(work, 'app.cjs'));

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
async function waitFor(what, predicate, timeoutMs = 20000) {
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

/** The value the CLI was given for a flag. */
function flag(invocation, name) {
  const i = invocation.argv.indexOf(name);
  return i >= 0 && i + 1 < invocation.argv.length ? invocation.argv[i + 1] : '';
}

/** Wait for the stub's Nth spawn (1-based) and hand it back. */
async function spawnNumber(n, what) {
  await waitFor(what, () => invocations().length >= n);
  return invocations()[n - 1] ?? { argv: [], cwd: '', pid: 0 };
}

/** Wait for run N's own prompt file and read it. */
async function promptFor(n, what) {
  const path = join(PROMPTS, 'prompt-' + n + '.txt');
  await waitFor(what, () => existsSync(path));
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** Let run N end its turn with `resultText`. */
const proceed = (n, resultText = '') =>
  writeFileSync(join(PROCEED, 'proceed-' + n), resultText, 'utf8');

/** Two paths name the same directory — Windows' drive-letter case and slashes aside. */
const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

process.env.PATH = join(work, 'bin') + delimiter + process.env.PATH;

// ── The engine, wired as `ipc.ts` wires it ─────────────────────────────────────────────
const store = createStore(join(work, 'orchestrator.db'));
const saved = store.getSettings();
store.saveSettings({ ...saved, maxAutoRetries: 0, limitJitterMs: 0 });

const sessions = new SessionManager(() => {});
const scheduler = new Scheduler(
  store,
  sessions,
  () => {},
  () => {},
  () => {},
  () => {},
  () => {},
);

/** Every `project:boardReviewChanged` push, in order. */
const reviewPushes = [];

/** `ipc.ts`'s `boardReviewer`, line for line. */
const boardReviewer = createBoardReviewer({
  store,
  startSession: (projectId, request, onResult, onExit) =>
    scheduler.startAuxiliarySession(projectId, request, {
      onResult: (event) => onResult(event.resultText),
      onExit,
    }),
  stopSession: (runId) => scheduler.stopAuxiliarySession(runId),
  now: () => Date.now(),
  emit: (projectId, review) => reviewPushes.push({ projectId, review }),
});

/** `ipc.ts`'s `archiveHandlers` — the pushes have no window to go to. */
const archiveHandlers = createArchiveHandlers({
  store,
  pushMilestones: () => [],
  pushTasks: () => {},
  now: () => Date.now(),
});

/** `ipc.ts`'s `drawChainLink`, line for line (its push has no window to go to). */
function drawChainLink(fromTaskId, toTaskId, gate) {
  const links = store.listTaskLinks();
  const refusal = canLink(links, store.getTask(fromTaskId), store.getTask(toTaskId));
  if (refusal) return { status: 'refused', reason: refusal };
  const created = store.addTaskLink(fromTaskId, toTaskId, gate ?? 'after-merge');
  if (!created) return { status: 'refused', reason: 'duplicate' };
  scheduler.reconsiderChains('links-changed');
  return { status: 'ok', links: store.listTaskLinks() };
}

/** `ipc.ts`'s `project:applyReviewItem` handler. */
const applyItem = (reviewId, recId) =>
  applyBoardReviewItem(
    {
      store,
      setDecision: (taskId, question) => scheduler.setDecision(taskId, question),
      drawLink: (from, to, gate) => drawChainLink(from, to, gate),
      archiveEpic: (target) => archiveHandlers['archive:apply'](target),
      addComment: (taskId, body) => {
        const task = store.getTask(taskId);
        if (task) store.addComment(task.projectId, taskId, body);
      },
      now: () => Date.now(),
      emitReview: (projectId, review) => reviewPushes.push({ projectId, review }),
      pushTasks: () => {},
    },
    reviewId,
    recId,
  );

// ── The fixture project ───────────────────────────────────────────────────────────────
const project = store.addProject({
  path: repoDir,
  // Plan-less: a project whose cards come from a plan file files no tickets.
  planPath: '',
  name: 'Fixture',
  defaultModel: 'sonnet',
  defaultPermissionMode: 'acceptEdits',
  baseBranch: base,
  readyLanes: 2,
  ticketPrefix: 'FX',
});
check(
  'the fixture project owns tickets and has a ready-lane cap of 2',
  project.ticketPrefix === 'FX' && project.readyLanes === 2,
  JSON.stringify({ ticketPrefix: project.ticketPrefix, readyLanes: project.readyLanes }),
);

const ticket = (input) => {
  const created = store.createTicket(project.id, input);
  if (!created) throw new Error('createTicket refused ' + input.title);
  return created;
};
const epic = ticket({ title: 'Checkout', issueType: 'epic' });
const milestone = store.addMilestone(project.id, { name: 'M1 — first release' });
const splitMe = ticket({
  title: 'Rework the sum helper and its docs',
  description: 'Change `sum` in src/a.ts and rewrite the docs around it.',
  epicTaskId: epic.id,
  milestoneId: milestone.id,
});
const dropMe = ticket({ title: 'Export the constant a', description: 'Already exported.' });
const reorderMe = ticket({ title: 'Use sum in the checkout', description: 'Call sum.' });
const decideMe = ticket({ title: 'Pick a rounding rule', description: 'Up or down?' });
const finished = ticket({ title: 'Create src/a.ts', description: 'The first file.' });
store.updateTask(finished.id, { status: 'done', stoppedAt: Date.now() });
store.addTaskLink(splitMe.id, dropMe.id, 'after-merge');

const refOf = (task) => store.getTask(task.id).ticketKey;
const openTickets = [splitMe, dropMe, reorderMe, decideMe];

const SPLIT_PARTS = [
  { title: 'Change sum in src/a.ts', description: 'Only the code.' },
  { title: 'Rewrite the sum docs', description: 'Only the docs.' },
];
const QUESTION = 'Should totals round half up or half to even?';

/** The report the reviewer ends with, the way the prompt asks: prose, then a ```json block. */
function reportText() {
  const report = {
    summary: 'Four open tickets; one is already done in the code.',
    tickets: [
      {
        ref: refOf(splitMe),
        verdict: 'SPLIT',
        reason: 'Code and docs are unrelated changes.',
        evidence: ['src/a.ts:2 — sum lives here'],
        parts: SPLIT_PARTS,
      },
      {
        ref: refOf(dropMe),
        verdict: 'DROP',
        reason: 'a is already exported.',
        evidence: ['src/a.ts:1 — export const a'],
      },
      {
        ref: refOf(reorderMe),
        verdict: 'REORDER',
        reason: 'Both edit src/a.ts.',
        evidence: [],
        after: [refOf(decideMe)],
      },
      {
        ref: refOf(decideMe),
        verdict: 'DECIDE',
        reason: 'The rounding rule is the owner’s call.',
        evidence: [],
        question: QUESTION,
      },
    ],
    hotFiles: [{ path: 'src/a.ts', refs: [refOf(reorderMe), refOf(decideMe)], note: 'sum' }],
    waves: [
      { refs: [refOf(splitMe), refOf(decideMe)], note: 'first' },
      { refs: [refOf(reorderMe)], note: 'after the rounding call' },
    ],
  };
  return (
    'I read src/a.ts against every ticket.\n\n```json\n' +
    JSON.stringify(report, null, 2) +
    '\n```\n'
  );
}

/** The archive index the board's own `visibleTickets` reads. */
const archiveIndex = () =>
  archiveIndexOf(store.listMilestones(project.id), store.getTasks(project.id), store.listProjects());

try {
  // =========================================================================================
  section('A. A report, stored and applied');

  const started = await boardReviewer.start(project.id);
  check('the review started', typeof started.reviewId === 'string' && !started.error, JSON.stringify(started));
  check(
    'the running row was pushed',
    reviewPushes.some((p) => p.review.id === started.reviewId && p.review.status === 'running'),
  );

  const run1 = await spawnNumber(1, 'the review session to spawn');
  check(
    'it runs in plan mode',
    flag(run1, '--permission-mode') === 'plan',
    flag(run1, '--permission-mode'),
  );
  const disallowed = flag(run1, '--disallowedTools').split(',');
  check(
    '--disallowedTools takes Edit, Write and Bash away',
    ['Edit', 'Write', 'Bash'].every((t) => disallowed.includes(t)),
    disallowed.join(','),
  );
  check("its cwd is the project's repo", samePath(run1.cwd, repoDir), run1.cwd + ' vs ' + repoDir);

  const prompt = await promptFor(1, 'the review prompt');
  for (const t of openTickets) {
    check(`the prompt names open ticket ${refOf(t)}`, prompt.includes(`### ${refOf(t)} — `));
  }
  check('the prompt lists the done ticket by title', prompt.includes(finished.title));
  check(
    'the done ticket is not reviewed as open',
    !prompt.includes(`### ${refOf(finished)} — `),
  );
  check(
    'the prompt states the ready-lane cap of 2',
    prompt.includes('at most 2 ready cards at once'),
  );
  check('the prompt quotes the rubric', prompt.includes(BOARD_REVIEW_RUBRIC));
  check('the prompt names the epic and the milestone', prompt.includes('- Epic: Checkout') && prompt.includes('- Milestone: M1 — first release'));
  check(
    'the prompt shows the existing arrow',
    prompt.includes(`Arrows out (runs before): ${refOf(dropMe)}`),
  );

  proceed(1, reportText());
  await waitFor('the review to settle', () => !boardReviewer.isRunning(project.id));
  const review = store.getLatestBoardReview(project.id);
  check('getLatestBoardReview is done', review?.status === 'done', JSON.stringify(review?.error));
  check('it is the review that started', review?.id === started.reviewId);
  const verdictOf = (task) => review?.report?.tickets.find((t) => t.taskId === task.id)?.verdict;
  check(
    'each verdict is mapped to its task id',
    verdictOf(splitMe) === 'SPLIT' &&
      verdictOf(dropMe) === 'DROP' &&
      verdictOf(reorderMe) === 'REORDER' &&
      verdictOf(decideMe) === 'DECIDE',
    JSON.stringify(review?.report?.tickets.map((t) => [t.ref, t.taskId, t.verdict])),
  );
  check('the parser raised no warnings', review?.report?.warnings.length === 0, JSON.stringify(review?.report?.warnings));
  check(
    'the hot file and both waves came through',
    review?.report?.hotFiles[0]?.path === 'src/a.ts' && review?.report?.waves.length === 2,
  );
  check(
    'the done row was pushed',
    reviewPushes.some((p) => p.review.id === started.reviewId && p.review.status === 'done'),
  );

  // ── DROP ─────────────────────────────────────────────────────────────────────────────
  const drop = await applyItem(review.id, refOf(dropMe));
  check('DROP applied', drop.ok, drop.message);
  const dropped = store
    .getTasks(project.id)
    .find((t) => t.issueType === 'epic' && t.title === DROPPED_EPIC_TITLE);
  check('the Dropped epic exists', dropped !== undefined);
  check(
    'and it is an archived epic of the project',
    store.listArchived(project.id).epics.some((e) => e.id === dropped?.id),
    JSON.stringify(store.listArchived(project.id).epics.map((e) => e.title)),
  );
  const droppedTicket = store.getTask(dropMe.id);
  check(
    'the dropped ticket moved into Dropped',
    droppedTicket.epicTaskId === dropped?.id,
    String(droppedTicket.epicTaskId),
  );
  check(
    "its own archivedAt stays null (never archiveTask)",
    droppedTicket.archivedAt == null,
    String(droppedTicket.archivedAt),
  );
  check('isHidden says it is hidden', isHidden(droppedTicket, archiveIndex()));
  check(
    'visibleTickets leaves it out, and keeps the other open tickets',
    (() => {
      const visible = visibleTickets(store.getBoardTasks(project.id), archiveIndex()).map((t) => t.id);
      return (
        !visible.includes(dropMe.id) &&
        [splitMe, reorderMe, decideMe].every((t) => visible.includes(t.id))
      );
    })(),
  );

  // ── REORDER ──────────────────────────────────────────────────────────────────────────
  const linksBefore = store.listTaskLinks().length;
  const reorder = await applyItem(review.id, refOf(reorderMe));
  check('REORDER applied', reorder.ok, reorder.message);
  check(
    'a new task_links row runs it after the ticket named',
    store
      .listTaskLinks()
      .some(
        (l) => l.fromTaskId === decideMe.id && l.toTaskId === reorderMe.id && l.gate === 'after-merge',
      ) && store.listTaskLinks().length === linksBefore + 1,
    JSON.stringify(store.listTaskLinks()),
  );

  // ── SPLIT ────────────────────────────────────────────────────────────────────────────
  const split = await applyItem(review.id, refOf(splitMe));
  check('SPLIT applied', split.ok, split.message);
  const parts = SPLIT_PARTS.map((p) => store.getTasks(project.id).find((t) => t.title === p.title));
  check('both parts exist', parts.every(Boolean));
  check(
    "each part keeps the original's epic and milestone",
    parts.every((p) => p?.epicTaskId === epic.id && p?.milestoneId === milestone.id),
    JSON.stringify(parts.map((p) => [p?.epicTaskId, p?.milestoneId])),
  );
  check(
    'the parts are chained part to part',
    store
      .listTaskLinks()
      .some((l) => l.fromTaskId === parts[0]?.id && l.toTaskId === parts[1]?.id),
  );
  check(
    'the split original moved into Dropped',
    store.getTask(splitMe.id).epicTaskId === dropped?.id,
    String(store.getTask(splitMe.id).epicTaskId),
  );
  check(
    'one Dropped epic serves both',
    store.getTasks(project.id).filter((t) => t.title === DROPPED_EPIC_TITLE).length === 1,
  );

  // ── DECIDE ───────────────────────────────────────────────────────────────────────────
  const decide = await applyItem(review.id, refOf(decideMe));
  check('DECIDE applied', decide.ok, decide.message);
  check(
    'the ticket needs a decision with the question',
    store.getTask(decideMe.id).decisionQuestion === QUESTION,
    String(store.getTask(decideMe.id).decisionQuestion),
  );

  // ── Applied once ─────────────────────────────────────────────────────────────────────
  const applied = store.getBoardReview(review.id).applied;
  check(
    'each outcome is stored on the review',
    [dropMe, reorderMe, splitMe, decideMe].every((t) => applied[refOf(t)]?.ok === true),
    JSON.stringify(applied),
  );
  const again = await applyItem(review.id, refOf(dropMe));
  check(
    'a second Apply of the same item is refused',
    !again.ok && again.message.includes('already applied'),
    again.message,
  );

  // =========================================================================================
  section('B. A malformed answer fails');

  const startB = await boardReviewer.start(project.id);
  check('a second review started', typeof startB.reviewId === 'string' && startB.reviewId !== review.id);
  await spawnNumber(2, 'the second review session');
  await promptFor(2, 'the second review prompt');
  proceed(2, 'I looked around, and here is no report at all.');
  await waitFor('the second review to settle', () => !boardReviewer.isRunning(project.id));
  const failed = store.getLatestBoardReview(project.id);
  check('getLatestBoardReview is failed', failed?.status === 'failed', String(failed?.status));
  check(
    "with the parser's error",
    failed?.error === 'The review ended without a fenced json report.',
    String(failed?.error),
  );
  check('and no report', failed?.report == null);
  check('two CLI runs in all', invocations().length === 2, String(invocations().length));
} catch (err) {
  failures += 1;
  console.log('  FAIL  the scenario threw — ' + (err instanceof Error ? err.stack : String(err)));
}

// Kill every stub still waiting on a proceed file before the database is closed; the pause is
// for Windows, where a stub keeps its CWD locked until it is really gone.
scheduler.dispose();
sessions.stopAll();
await sleep(750);
store.close();

console.log('\n' + invocations().length + ' CLI invocation(s) observed.');
if (failures > 0) {
  console.error(failures + ' check(s) failed.');
  process.exit(1);
}
console.log('All checks passed.');
process.exit(0);
