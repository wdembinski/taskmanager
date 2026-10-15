/**
 * Headless proof of a ×3 variant run end to end (F10.7) — `task:startVariants`,
 * `variants:summary`, `variants:pick` and the merge that follows a pick, wired into the
 * REAL engine rather than exercised through fakes.
 *
 *     node scripts/verify-variants.mjs
 *
 * ## Why this is a script and not a test
 *
 * `variants.test.ts` proves `canStartVariants`/`planVariants`/`planVariantPick` are pure and
 * correct; `variantPick.test.ts` and `variantSummary.test.ts` prove the engine-side assembly
 * against a real git repo and a real `WorktreeManager`; `scheduler.test.ts` proves
 * `startVariantRows`/`integrateNow` dispatch correctly with a FAKE store and FAKE worktrees.
 * None of them answers what a human actually cares about: started for real, does a ×3 group
 * really produce three independent worktrees, do the two diversification hints actually
 * reach the CLI as three different prompts, does picking one really delete the other two's
 * worktrees and branches and leave the winner's alone, and does the merge that follows land
 * the winner's file — and only the winner's — in base? That needs the REAL `Scheduler`, the
 * REAL `SessionManager`, the REAL `WorktreeManager` against a REAL git repository, and a
 * REAL (if scripted) `claude` on PATH — a fake `SessionManager` or a fake `WorktreeManager`
 * stops one of those links short of the thing being asserted. `better-sqlite3` also only
 * loads under Electron's ABI, which is the other reason this cannot be a vitest file.
 *
 * ## What is real and what is replayed
 *
 * Real: `Scheduler`, `SessionManager`, `WorktreeManager`, `DiffService`, `pickVariant`,
 * `buildVariantSummary`, `canStartVariants`/`planVariants`, a real SQLite `Store`, and a real
 * git repository this script creates from scratch — every one of the app's own modules,
 * bundled out of `apps/client/src/main` and `packages/shared/src` with esbuild and run under
 * Electron-as-Node (no window, no second instance — see the `verify-electron-app` memory and
 * `RELEASE.md` rule 6).
 *
 * Replayed: `task:startVariants` itself. Unlike the pick and the summary, which `ipc.ts`
 * delegates to standalone, testable functions (`pickVariant`, `buildVariantSummary`), the
 * start handler's body is inlined in `ipc.ts` — there is nothing importable to call. So
 * `startVariantsReplay` below reproduces its essential steps (check `canStartVariants`, plan
 * the rows with `planVariants`, write them with `store.createVariantRow`, note the group on
 * the leader's timeline, hand them to `scheduler.startVariantRows`) directly against the real
 * store and scheduler. The validation branches `ipc.ts` runs before any of that — an unusable
 * model, an unresolvable branch name, a missing agent project — are preconditions this
 * scenario already guarantees true, not behaviour under test here.
 *
 * A fake, scripted `claude` stands in for the CLI (see the `stub-claude-on-path` memory): it
 * logs its own argv/cwd, reads its prompt off stdin, and — this is the part specific to this
 * script — decides which variant it is FROM THAT PROMPT (B's hint contains "simplest
 * change", C's "more thorough", A has neither) and writes and commits its own
 * `variant-<label>.txt` in its own worktree before ever reporting a `result`. That is what
 * lets this script prove the hints in `@shared/variants`' `VARIANT_HINTS` actually reach the
 * CLI, rather than merely reaching `Task.description`.
 *
 * ## What it proves
 *
 *  1. Starting ×3 on a delegated leader creates exactly three hidden rows (A, B, C,
 *     `variantOf` the leader, none a board card), notes the group on the leader's timeline,
 *     and really launches three concurrent sessions in three distinct worktrees under the
 *     worktree root — with A's prompt carrying neither hint and B's/C's carrying their own.
 *  2. Releasing all three lands each one's own `variant-<label>.txt` commit on its own
 *     branch, and touches base not at all — nothing here auto-merges.
 *  3. `buildVariantSummary` reports three entries in label order, each with a one-file
 *     diffstat.
 *  4. `integrateNow` on the still-unpicked leader is refused with `PICK_VARIANT_FIRST`.
 *  5. `pickVariant` keeps B: the leader's `pickedVariantId` becomes B's id, A and C are
 *     archived `'variant-discarded'`, `listVariantRows` returns only B — and, the checks a
 *     disabled cleanup would turn red, A's and C's worktree DIRECTORIES are gone from disk
 *     and their branches are gone from `git branch --list`, while B's worktree and branch are
 *     untouched. The timeline names the pick and carries no "left something behind" note.
 *  6. Re-picking B is a no-op (no new note, leader unchanged); picking C instead is refused,
 *     naming the discard.
 *  7. `integrateNow` on the now-picked leader actually merges: it returns null, the leader's
 *     `landedAt` lands, and `git ls-tree` on base shows `variant-B.txt` and neither of the
 *     other two.
 *  8. Picking C after the merge is refused again, this time naming the merge.
 *
 * ## Prove it can fail
 *
 * Comment out the `deps.cleanup(...)` call (and the `deps.deleteTaskBranch(...)` call right
 * below it) inside the loser loop of `pickVariant` in `apps/client/src/main/variantPick.ts`,
 * and re-run. Check 5's four "gone" assertions turn red — A's and C's worktree directories
 * and branches are all still on disk — while every other check (including the SAME check's
 * `pickedVariantId`/archived/`listVariantRows` assertions, and the "no left something behind"
 * note) stays green, which is the proof those assertions are not vacuous. Restore the calls
 * afterward.
 *
 * The two calls are also independently live, not just live together: disabling only
 * `cleanup` turns the same four checks red PLUS the "left something behind" note (the still
 * live `deleteTaskBranch` call now fails too, because a branch cannot be deleted while its
 * worktree is still checked out) — five red checks in total. Disabling only
 * `deleteTaskBranch`, with `cleanup` left alone, turns on only the two branch "gone" checks —
 * the worktree ones stay green, proving that half of the assertion isolates the branch
 * deletion specifically. Restore the calls afterward either way.
 *
 * Exits non-zero naming every failed check.
 */
import { execFileSync, spawnSync } from 'node:child_process';
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
 * The fake `claude`, written as a `.cjs` the shim on PATH invokes.
 *
 * Records its argv, speaks the two stream-json lines `mapRawEvent` reads, and — specific to
 * this script — reads its own prompt off stdin, decides which variant it is FROM the hint
 * text alone (B's contains "simplest change", C's "more thorough", A has neither), and
 * writes-and-commits its own `variant-<label>.txt` in `process.cwd()` (the row's own
 * worktree) before ever reporting a `result`. It still waits for a `proceed-N` file before
 * reporting that result, so the driver decides exactly when each turn finishes.
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
    '',
    "  const label = text.includes('simplest change') ? 'B' : text.includes('more thorough') ? 'C' : 'A';",
    "  const filename = 'variant-' + label + '.txt';",
    '  try {',
    "    fs.writeFileSync(path.join(process.cwd(), filename), 'variant ' + label + ' wrote this\\n', 'utf8');",
    "    execFileSync('git', ['add', '-A'], { cwd: process.cwd() });",
    "    execFileSync('git', ['commit', '--no-verify', '-m', 'work: ' + filename], { cwd: process.cwd() });",
    '  } catch (err) {',
    "    fs.appendFileSync(LOG, 'COMMIT FAILED for run ' + index + ': ' + String(err) + '\\n');",
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
    '    total_cost_usd: 0.01,',
    '  });',
    '}, 20);',
    '',
    '// Never self-exit — the scheduler kills the process after `result`, exactly as it does',
    '// the real CLI. The backstop is only so a crashed driver leaves nothing behind.',
    'process.stdin.resume();',
    'setTimeout(() => process.exit(0), 120000);',
  ].join('\n');
}

/** A real, minimal git repository — one seed commit, nothing else. No remote: the merge this
 * script drives is a local worktree-into-base integration, which never pushes anywhere. */
function initRepo(repoDir) {
  const g = (...args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  mkdirSync(repoDir, { recursive: true });
  g('init');
  g('config', 'user.email', 'verify@example.com');
  g('config', 'user.name', 'Verify');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repoDir, 'seed.txt'), 'seed\n', 'utf8');
  g('add', '-A');
  g('commit', '--no-verify', '-m', 'initial');
  return g('rev-parse', '--abbrev-ref', 'HEAD').trim();
}

async function main() {
  let status = 1;
  // The OS temp directory, deliberately, and NOT a scratch folder inside the repo: a
  // directory under a work tree IS part of that work tree, so a `git init` in one leaves
  // git confused about which repository it is standing in.
  const scratch = mkdtempSync(join(tmpdir(), 'tm-variants-'));
  // Worktrees live OUTSIDE the scratch tree too: a worktree's path grows fast (project id +
  // task id), and nesting it under an already-long temp path is how `git worktree add` hits
  // Windows' MAX_PATH.
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'tm-variants-wt-'));
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
    bundle(join(root, 'apps/client/src/main/worktreeManager.ts'), join(scratch, 'worktreeManager.cjs'));
    bundle(join(root, 'apps/client/src/main/scheduler.ts'), join(scratch, 'scheduler.cjs'));
    bundle(join(root, 'apps/client/src/main/review/diffService.ts'), join(scratch, 'diffService.cjs'));
    bundle(join(root, 'apps/client/src/main/exec/index.ts'), join(scratch, 'exec.cjs'));
    bundle(join(root, 'apps/client/src/main/variantPick.ts'), join(scratch, 'variantPick.cjs'));
    bundle(join(root, 'apps/client/src/main/variantSummary.ts'), join(scratch, 'variantSummary.cjs'));
    bundle(join(root, 'packages/shared/src/variants.ts'), join(scratch, 'variants.cjs'));
    bundle(join(root, 'packages/shared/src/board.ts'), join(scratch, 'board.cjs'));

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
      [fileURLToPath(import.meta.url), scratch, repoDir, base, binDir, worktreeRoot],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          // The bundles live in scratch, outside any node_modules tree, so the external
          // `require('better-sqlite3')` inside them needs somewhere to resolve from.
          NODE_PATH: clientModules,
        },
      },
    );
    status = run.status ?? 1;
  } finally {
    if (!process.argv.includes('--keep')) {
      // Retries because a killed stub's directory handle can outlive it by a moment on
      // Windows, and losing the run's verdict to an EBUSY on cleanup would be absurd.
      rmSync(worktreeRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
      rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    } else {
      log(`\nLeft ${scratch} and ${worktreeRoot} in place (--keep).`);
    }
  }
  process.exit(status);
}

// ── Phase 1: plain Node — bundle, set up a real repo, then hand over to Electron ──────
if (!process.versions.electron) {
  await main();
}

// ── Phase 2: under Electron-as-Node — the actual checks ──────────────────────────────

const require = createRequire(import.meta.url);
const work = process.argv[2];
const repoDir = process.argv[3];
const base = process.argv[4];
const binDir = process.argv[5];
const worktreeRoot = process.argv[6];

const { createStore } = require(join(work, 'store.cjs'));
const { SessionManager } = require(join(work, 'sessionManager.cjs'));
const { WorktreeManager, taskBranch } = require(join(work, 'worktreeManager.cjs'));
const { Scheduler } = require(join(work, 'scheduler.cjs'));
const { DiffService, createDiffGit } = require(join(work, 'diffService.cjs'));
const { hostFor } = require(join(work, 'exec.cjs'));
const { pickVariant } = require(join(work, 'variantPick.cjs'));
const { buildVariantSummary } = require(join(work, 'variantSummary.cjs'));
const { canStartVariants, planVariants, VARIANT_REFUSAL_MESSAGE, PICK_VARIANT_FIRST } = require(
  join(work, 'variants.cjs'),
);
const { isBoardCard, isRunStatus } = require(join(work, 'board.cjs'));

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

/** Let run N report its result, which is what settles it. */
const proceed = (n) => writeFileSync(join(PROCEED, 'proceed-' + n), 'go', 'utf8');

/** Wait for run N's own prompt file and read it. */
async function promptFor(n, what) {
  const path = join(PROMPTS, 'prompt-' + n + '.txt');
  await waitFor(what, () => n > 0 && existsSync(path));
  return n > 0 ? readFileSync(path, 'utf8') : '';
}

/** Forward slashes, lower case — so a Windows path comparison ignores drive-letter case and
 * separator style. */
const normPath = (p) => p.replace(/\\/g, '/').toLowerCase();

/** Whether `cwd` really is a git-tracked file at `ref` (default `HEAD`) — committed, not
 * merely present on disk. */
function hasCommittedFile(cwd, filename, ref = 'HEAD') {
  try {
    // `stdio: ['ignore', 'pipe', 'ignore']` so a missing path's expected `fatal:` line never
    // reaches the terminal — this helper is asked "does it exist?", not "prove it doesn't".
    execFileSync('git', ['show', `${ref}:${filename}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/** `git branch --list <branch>` in `cwd`, trimmed — `''` when the branch does not exist. */
function gitBranchList(cwd, branch) {
  return execFileSync('git', ['branch', '--list', branch], { cwd, encoding: 'utf8' }).trim();
}

/** Every path `ref`'s tree holds, in `cwd`. */
function gitLsTree(cwd, ref = 'HEAD') {
  return execFileSync('git', ['ls-tree', '-r', '--name-only', ref], { cwd, encoding: 'utf8' });
}

/** The card's timeline as one string — every comment's body, in order. Both the "Started…"
 * note and a pick's note are plain comments (`store.addComment`), not run-scoped events. */
const timelineOf = (taskId) =>
  store
    .getTaskActivity(taskId)
    .map((e) => e.body ?? '')
    .join('\n');

process.env.PATH = binDir + require('node:path').delimiter + process.env.PATH;

const worktrees = new WorktreeManager(worktreeRoot);
const store = createStore(join(work, 'orchestrator.db'));
store.saveSettings({ ...store.getSettings(), maxAutoRetries: 0, limitJitterMs: 0 });

const sessions = new SessionManager(() => {});
const scheduler = new Scheduler(
  store,
  sessions,
  () => {},
  () => {},
  () => {},
  () => {},
  () => {},
  worktrees,
);

const diffs = new DiffService({
  getTask: (id) => store.getTask(id),
  getProject: (id) => store.getProject(id),
  inspect: (project, ownerTaskId, branchName) => worktrees.inspect(project, ownerTaskId, branchName),
  gitFor: (project) => createDiffGit(hostFor(project.target)),
  listMergeRequests: () => store.listMergeRequests(),
});

// `PERSONAL_PROJECT_ID` from `@shared/model` — hardcoded rather than imported, since the
// driver here is plain JS calling into bundled modules, not a TS file of its own.
const PERSONAL_PROJECT_ID = 'personal';

/** `task:startVariants`, replayed — see the header comment for why this is replayed rather
 * than imported: the real handler's body lives inline in `ipc.ts`, with nothing standalone
 * to call. The validation `ipc.ts` runs ahead of this (a usable model, a resolvable branch
 * name, a project that exists) is skipped — this scenario already guarantees all of it. */
function startVariantsReplay(leader, count, input) {
  const eligible = canStartVariants(leader, input);
  if ('refused' in eligible) throw new Error(VARIANT_REFUSAL_MESSAGE[eligible.refused]);
  const drafts = planVariants(
    { ...leader, description: leader.externalDescription },
    count,
    input,
    [],
  );
  const rowIds = [];
  for (const draft of drafts) {
    const row = store.createVariantRow(leader, draft, input.branch?.trim() || null);
    if (draft.notes) store.addComment(row.projectId, row.id, draft.notes);
    rowIds.push(row.id);
  }
  store.addComment(
    leader.projectId,
    leader.id,
    `Started ${count} variants — ${drafts.map((d) => d.variantLabel).join(', ')}.`,
  );
  const outcomes = scheduler.startVariantRows(rowIds);
  return { rowIds, outcomes };
}

let leader;
try {
  // ===========================================================================
  section('1. setup — a leader card delegated to a ×3-capable agent project');

  const project = store.addProject({
    path: repoDir,
    name: 'the variants repo',
    defaultModel: 'sonnet',
    defaultPermissionMode: 'acceptEdits',
    concurrency: 3,
    baseBranch: base,
    autoIntegrate: false,
  });

  const created = store.createTask(PERSONAL_PROJECT_ID, { title: 'Reticulate the splines' });
  if (!created) throw new Error('the store refused to create the leader card');
  leader = store.updateTask(created.id, { agentProjectId: project.id });
  if (!leader) throw new Error('the store refused to delegate the leader card');
  check('the leader is a board card before anything starts', isBoardCard(leader));

  // ===========================================================================
  section('2. task:startVariants, replayed — three rows, three worktrees, the hints reaching the CLI');

  const { outcomes } = startVariantsReplay(leader, 3, { agentProjectId: project.id });
  check(
    'all 3 rows started immediately — concurrency 3, nothing queued',
    outcomes.every((o) => 'runId' in o),
    JSON.stringify(outcomes),
  );

  const rows = store.listVariantRows(leader.id);
  check('exactly 3 rows exist', rows.length === 3, rows.length);
  check(
    'labelled A, B, C',
    rows.map((r) => r.variantLabel).sort().join('') === 'ABC',
    JSON.stringify(rows.map((r) => r.variantLabel)),
  );
  check('every row points variantOf at the leader', rows.every((r) => r.variantOf === leader.id));
  check('no row is a board card', rows.every((r) => !isBoardCard(r)));

  const timelineAfterStart = timelineOf(leader.id);
  check(
    "the leader's timeline reads \"Started 3 variants — A, B, C.\"",
    timelineAfterStart.includes('Started 3 variants — A, B, C.'),
    timelineAfterStart,
  );

  await waitFor('3 stub invocations', () => invocations().length >= 3);
  const startInvocations = invocations();
  check(
    '3 distinct cwds, each under the worktree root',
    new Set(startInvocations.map((i) => i.cwd)).size === 3 &&
      startInvocations.every((i) => normPath(i.cwd).startsWith(normPath(worktreeRoot))),
    JSON.stringify(startInvocations.map((i) => i.cwd)),
  );

  const rowA = rows.find((r) => r.variantLabel === 'A');
  const rowB = rows.find((r) => r.variantLabel === 'B');
  const rowC = rows.find((r) => r.variantLabel === 'C');

  const liveA = await worktrees.inspect(project, rowA.id);
  const liveB = await worktrees.inspect(project, rowB.id);
  const liveC = await worktrees.inspect(project, rowC.id);
  check('row A has its own live worktree', liveA != null);
  check('row B has its own live worktree', liveB != null);
  check('row C has its own live worktree', liveC != null);

  const invocationIndexForCwd = (cwd) => {
    const idx = startInvocations.findIndex((i) => normPath(i.cwd) === normPath(cwd));
    return idx === -1 ? -1 : idx + 1;
  };
  const promptA = liveA ? await promptFor(invocationIndexForCwd(liveA.cwd), "A's prompt") : '';
  const promptB = liveB ? await promptFor(invocationIndexForCwd(liveB.cwd), "B's prompt") : '';
  const promptC = liveC ? await promptFor(invocationIndexForCwd(liveC.cwd), "C's prompt") : '';
  check(
    "A's prompt carries neither hint",
    !promptA.includes('simplest change') && !promptA.includes('more thorough'),
    promptA,
  );
  check("B's prompt carries its own hint", promptB.includes('simplest change'), promptB);
  check("C's prompt carries its own hint", promptC.includes('more thorough'), promptC);

  // ===========================================================================
  section('3. release all three — each lands its own commit on its own branch, base untouched');

  for (let n = 1; n <= 3; n++) proceed(n);
  await waitFor('all 3 rows to settle', () =>
    [rowA, rowB, rowC].every((r) => !isRunStatus(store.getTask(r.id)?.status)),
  );

  const liveAfterRelease = {};
  for (const row of [rowA, rowB, rowC]) {
    const live = await worktrees.inspect(project, row.id);
    liveAfterRelease[row.id] = live;
    check(`row ${row.variantLabel} still has its own worktree`, live != null);
    if (!live) continue;
    const filename = `variant-${row.variantLabel}.txt`;
    check(
      `row ${row.variantLabel} committed ${filename} on its own branch`,
      hasCommittedFile(live.cwd, filename),
    );
  }
  for (const label of ['A', 'B', 'C']) {
    check(
      `base has no variant-${label}.txt — nothing auto-merged`,
      !hasCommittedFile(repoDir, `variant-${label}.txt`),
    );
  }

  // ===========================================================================
  section('4. variants:summary — one entry per row, in label order, each a one-file diffstat');

  const summaryDeps = {
    getTask: (id) => store.getTask(id),
    listVariantRows: (id) => store.listVariantRows(id),
    getTaskHistory: (id) => store.getTaskHistory(id),
    diffStat: (id) => diffs.stat(id),
  };
  const summary = await buildVariantSummary(summaryDeps, leader.id);
  check(
    '3 entries, in order A, B, C',
    summary.map((s) => s.label).join('') === 'ABC',
    JSON.stringify(summary.map((s) => s.label)),
  );
  check(
    'each reports 1 file changed',
    summary.every((s) => s.diffStat.files === 1),
    JSON.stringify(summary.map((s) => s.diffStat)),
  );

  // ===========================================================================
  section('5. integrateNow on an unpicked leader is refused');

  const beforePick = await scheduler.integrateNow(leader.id);
  check('refused with PICK_VARIANT_FIRST', beforePick === PICK_VARIANT_FIRST, beforePick);

  // ===========================================================================
  section('6. variants:pick — keep B, discard A and C, their worktrees and branches');

  const pickDeps = {
    getTask: (id) => store.getTask(id),
    getProject: (id) => store.getProject(id),
    listVariantRows: (id) => store.listVariantRows(id),
    discardVariantRow: (id) => scheduler.discardVariantRow(id),
    cleanup: (p, taskId) => worktrees.cleanup(p, taskId),
    deleteTaskBranch: (p, branch) => worktrees.deleteTaskBranch(p, branch),
    archiveTask: (id, at, reason) => store.archiveTask(id, at, reason),
    updateTask: (id, patch) => store.updateTask(id, patch),
    addComment: (projectId, taskId, body) => store.addComment(projectId, taskId, body),
  };

  const aCwd = liveAfterRelease[rowA.id]?.cwd;
  const cCwd = liveAfterRelease[rowC.id]?.cwd;
  const bCwd = liveAfterRelease[rowB.id]?.cwd;

  const pickedLeader = await pickVariant(pickDeps, leader.id, rowB.id);
  check("leader.pickedVariantId is B's id", pickedLeader.pickedVariantId === rowB.id, pickedLeader.pickedVariantId);

  const archivedA = store.getTask(rowA.id);
  const archivedC = store.getTask(rowC.id);
  check(
    'A is archived as variant-discarded',
    archivedA?.archivedAt != null && archivedA?.archivedReason === 'variant-discarded',
    JSON.stringify(archivedA),
  );
  check(
    'C is archived as variant-discarded',
    archivedC?.archivedAt != null && archivedC?.archivedReason === 'variant-discarded',
    JSON.stringify(archivedC),
  );
  const liveRowsAfterPick = store.listVariantRows(leader.id);
  check(
    'listVariantRows returns only B',
    liveRowsAfterPick.length === 1 && liveRowsAfterPick[0].id === rowB.id,
    JSON.stringify(liveRowsAfterPick.map((r) => r.id)),
  );

  // These are the checks a disabled cleanup (see the header's "Prove it can fail") turns red.
  check("A's worktree directory is gone", aCwd != null && !existsSync(aCwd));
  check("C's worktree directory is gone", cCwd != null && !existsSync(cCwd));
  check("A's branch is gone", gitBranchList(repoDir, taskBranch(rowA.id)) === '');
  check("C's branch is gone", gitBranchList(repoDir, taskBranch(rowC.id)) === '');
  check("B's worktree is still there", bCwd != null && existsSync(bCwd));
  check("B's branch is still there", gitBranchList(repoDir, taskBranch(rowB.id)) !== '');

  const timelineAfterPick = timelineOf(leader.id);
  check('the timeline has "Picked B of 3."', timelineAfterPick.includes('Picked B of 3'), timelineAfterPick);
  check(
    'and no "left something behind" note',
    !timelineAfterPick.includes('left something behind'),
    timelineAfterPick,
  );

  // ===========================================================================
  section('7. re-pick rules — same id is a no-op, a different id is refused');

  const timelineBeforeRepick = timelineOf(leader.id);
  const repickSame = await pickVariant(pickDeps, leader.id, rowB.id);
  check('re-picking B is a no-op: pickedVariantId unchanged', repickSame.pickedVariantId === rowB.id);
  check('and files no new note', timelineOf(leader.id) === timelineBeforeRepick);

  let repickCMessage = null;
  try {
    await pickVariant(pickDeps, leader.id, rowC.id);
  } catch (err) {
    repickCMessage = err instanceof Error ? err.message : String(err);
  }
  check(
    'picking C instead is refused, naming the discard',
    repickCMessage != null && repickCMessage.includes('discarded'),
    repickCMessage,
  );

  // ===========================================================================
  section('8. integrateNow on the picked leader actually merges B into base');

  const mergeResult = await scheduler.integrateNow(leader.id);
  check('integrateNow returns null — a merge is under way', mergeResult === null, mergeResult);
  await waitFor("the leader's landedAt to be set", () => store.getTask(leader.id)?.landedAt != null);

  const baseTree = gitLsTree(repoDir);
  check('base now has variant-B.txt', baseTree.includes('variant-B.txt'), baseTree);
  check('base still has no variant-A.txt', !baseTree.includes('variant-A.txt'), baseTree);
  check('base still has no variant-C.txt', !baseTree.includes('variant-C.txt'), baseTree);

  // ===========================================================================
  section('9. re-pick after the merge is refused, naming the merge');

  let afterMergeMessage = null;
  try {
    await pickVariant(pickDeps, leader.id, rowC.id);
  } catch (err) {
    afterMergeMessage = err instanceof Error ? err.message : String(err);
  }
  check(
    'refused, naming the merge',
    afterMergeMessage != null && afterMergeMessage.toLowerCase().includes('merged'),
    afterMergeMessage,
  );
} catch (err) {
  failures += 1;
  console.error('\nScenario threw: ' + (err instanceof Error ? err.stack ?? err.message : String(err)));
  console.error('Scratch directory: ' + work);
  console.error('Worktree root: ' + worktreeRoot);
} finally {
  // Kill every stub still waiting on a proceed file before the database is closed. The pause
  // is for Windows: termination is its own kill, and a stub whose CWD is a worktree keeps
  // that directory locked until it is really gone.
  scheduler.dispose();
  sessions.stopAll();
  await sleep(750);
  store.close();
}

console.log('');
console.log(invocations().length + ' CLI invocation(s) observed.');
if (failures > 0) {
  console.error(failures + ' check(s) failed.');
  process.exit(1);
}
console.log('ALL PASS');
process.exit(0);
