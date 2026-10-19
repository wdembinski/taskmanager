/**
 * Headless proof of TM-460's whole ladder — a stale card's branch ends up pushed and its
 * pull request opened with NO human step, end to end, against real git.
 *
 *     node scripts/verify-stale-pr.mjs
 *
 * ## Why this is a script and not a test
 *
 * `scheduler.test.ts`'s own TM-460 suite (`Scheduler.settle — a base-moved conflict found
 * while opening a pull request`) already drives `openPullRequestFor` → `handPrConflictToAgent`
 * → `escalateConflict` → `dispatchConflictFix` → `finishConflict` with a FAKE `worktrees`
 * (`rebaseForPullRequest`/`finishPullRequestRebase` are `vi.fn()`s that just report
 * `'conflict'`/`'rebased'`) and a FAKE `sessions.start` that never spawns anything. That proves
 * the wiring between those methods. It cannot prove the two things that wiring is FOR: that a
 * real base-moved conflict, fetched off a real "origin" through `WorktreeManager`'s real rebase
 * ladder, really lands the agent in a worktree genuinely mid-rebase with real conflict markers
 * — and that a real agent turn, resolving them and staging its fix, really drives
 * `finishPullRequestRebase` to a clean rebase and a second, real, leased/plain push back to the
 * forge. Nothing here is stubbed except the forge's own HTTP API and the CLI binary itself:
 * `Scheduler`, `WorktreeManager`, `SessionManager`, `createPr.ts`'s `openPullRequest` and the
 * real SQLite-backed `Store` are the genuine exports of this repo, bundled with esbuild and run
 * directly under Electron-as-Node (`better-sqlite3`'s addon is compiled for Electron's ABI —
 * see the `the-store-has-no-tests` memory).
 *
 * `origin` is a real bare repository on disk; `git` is pointed at it only through a scratch
 * `GIT_CONFIG_GLOBAL` `insteadOf` rule mapping the exact TOKENIZED github.com URL
 * `createPr.ts` builds to that bare repo's path (the same trick `verify-create-pr.mjs` uses) —
 * the user's own global config is never touched, and nothing about `createPr.ts` or `git.ts` is
 * stubbed or special-cased. The agent turn is a real child process too: a `claude.cmd` shim
 * placed on `PATH` stands in for the CLI (the `stub-claude-on-path` memory), and
 * `SessionManager`/`claudeSession.ts` really spawn it, really feed it stdin, and really parse
 * its NDJSON stdout. The stub's own "work" is real as well — it resolves the conflict by
 * finding every unmerged path with `git diff --diff-filter=U`, writing a merged file over each
 * one, and `git add`ing it, exactly as the resolve prompt asks a real agent to — before it emits
 * the two stream-json lines (`system/init`, then `result`) that make the round trip look like a
 * real turn to `SessionManager`.
 *
 * ## Why `BaseMovedConflictError` has to be bundled only ONCE
 *
 * `openPullRequestFor`'s catch tests `err instanceof BaseMovedConflictError`. `scheduler.ts`
 * imports that class as a VALUE from `./forge/createPr`, and this script also needs it (well,
 * needs `openPullRequest`, which throws it) directly, to wire `setPullRequestOpener`. Bundling
 * `scheduler.ts` and `forge/createPr.ts` as two SEPARATE esbuild entries would inline two
 * independent copies of the class — same source, different constructors — and the `instanceof`
 * check inside the scheduler's own bundle would silently fail against an error thrown by the
 * other bundle's copy, with no error of its own to say why. The fix is the one esbuild already
 * gives for exactly this: one synthetic entry module that re-exports `Scheduler` AND
 * `openPullRequest`/`BaseMovedConflictError` (and everything else this script needs) from their
 * real source files. esbuild's bundler resolves imports by absolute path and dedupes the module
 * graph, so `./forge/createPr` reached through `scheduler.ts`'s own relative import and the
 * entry's direct import of the same absolute file are the SAME module in the ONE output bundle
 * — one class, one identity, exactly as it is inside the real app's own single bundle.
 *
 * ## What it proves
 *
 *  1. **Scenario 1 — an agent-rebased branch that was already pushed once.** The card's branch
 *     was pushed under its pre-rebase SHA, then the project's local base advanced and the
 *     branch was rebased onto it locally (same content, new SHA) — the F… "lease-push" fix's
 *     own scenario, driven this time through `Scheduler.settle` → `landWork` →
 *     `openPullRequestFor`, not through `openPullRequest` called by hand. The push lands leased
 *     against the stale remote tip, the pull request is opened, and the card sees NO attention
 *     item at any point — a human was never involved.
 *  2. **Scenario 2 — a base that moved and conflicts, found while opening the pull request for
 *     the first time.** A second clone pushes a conflicting edit to the SAME line the card's
 *     branch touches, straight to the bare origin, while this card's branch has never been
 *     pushed at all. `settle` → `landWork` → `openPullRequestFor` → `openPullRequest`'s own
 *     `syncOntoRemoteBase` call hits that real conflict and throws a real `BaseMovedConflictError`
 *     — caught by `openPullRequestFor`, handed to `handPrConflictToAgent`, which really leaves
 *     the worktree mid-rebase with real `<<<<<<<` markers in the file. `escalateConflict` →
 *     `dispatchConflictFix` → `requeue` → `startTask` → `prepareAndLaunch` really launches the
 *     stub CLI IN that same worktree (`resumingRebase` hands the pause over rather than
 *     clearing it). The stub resolves the file and stages it; its `result` event drives the
 *     real `onRunEvent` → `settle` → `finishConflict` → `finishPullRequestRebase`, which really
 *     finishes the paused rebase. `applyIntegrationResult`'s `rebased` case (with `ctx.openPr`
 *     set) runs the card's own gates (none, for a plain card) and calls `openPullRequestFor` a
 *     SECOND time — which pushes the now-rebased branch and opens its pull request for real.
 *     The bare origin's branch, at the end, carries both the OTHER clone's commit and the
 *     card's own, and the forge was POSTed to. Zero attention items throughout — no human step,
 *     exactly as the ticket asks.
 *
 * ## Prove it can fail
 *
 * Scenario 2 is re-run against a second Scheduler bundle, built from a byte-for-byte copy of
 * `scheduler.ts` with ONE line patched: `openPullRequestFor`'s catch,
 * `if (err instanceof BaseMovedConflictError && this.worktrees) {`, becomes `if (false) {` —
 * literally reverting the "Part B" catch TM-460 added, so a `BaseMovedConflictError` falls
 * through to the same `raiseTaskFailed` every other wall this function can throw already gets.
 * Against the identical conflicting-base scenario, that run now parks a `pull-request` failure
 * — an attention item appears, the branch is never rebased, and nothing is ever pushed. If this
 * check ever came back clean (no attention item) against the mutated build, the "zero attention
 * items" assertion in scenario 2 would be a tautology that could never catch the catch going
 * missing again; this is what rules that out.
 */
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const mainDir = join(root, 'apps', 'client', 'src', 'main');
// The OS temp directory, deliberately, and NOT a scratch folder inside the repo — a directory
// under a work tree IS part of that work tree, so a `git init` in one leaves git confused
// about which repository it is standing in (see `headless-scenario-harness-traps`).
const scratch = mkdtempSync(join(tmpdir(), 'tm-stale-pr-'));

/**
 * esbuild ships as a per-platform binary under a versioned `.pnpm` directory, so it is found by
 * pattern rather than by path: a dependency bump renames the directory, and hard-coding one
 * version would rot this script at the next `pnpm up`.
 */
function findEsbuild() {
  const pnpm = join(root, 'node_modules', '.pnpm');
  const target = `${process.platform}-${process.arch}`;
  const dir = readdirSync(pnpm).find((d) => d.startsWith(`@esbuild+${target}@`));
  if (!dir) throw new Error(`no esbuild binary for ${target} under ${pnpm}`);
  const exe = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
  return join(pnpm, dir, 'node_modules', '@esbuild', target, exe);
}

function bundle(entry, outfile) {
  const res = spawnSync(
    findEsbuild(),
    [
      entry,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--alias:@shared=${join(root, 'packages', 'shared', 'src')}`,
      `--alias:@protocol=${join(root, 'packages', 'protocol', 'src')}`,
      '--external:better-sqlite3',
      // `scheduler.ts` reaches `./log`, whose `getLogPath()` only calls `app.getPath` lazily
      // (and swallows any failure) — but the bare `import { app } from 'electron'` above it
      // is NOT lazy, and under ELECTRON_RUN_AS_NODE a bundled `require('electron')` resolves
      // to the real npm shim package instead of Electron's own intercepted binding, which
      // throws at require-time ("Electron failed to install correctly"). Left external and
      // shimmed via NODE_PATH below, so that eager require resolves to a harmless stand-in.
      '--external:electron',
      `--outfile=${outfile}`,
      '--log-level=error',
    ],
    { stdio: 'inherit' },
  );
  if (res.status !== 0) throw new Error(`esbuild failed bundling ${entry}`);
}

const posix = (p) => p.replace(/\\/g, '/');

// ── Phase 1: plain Node — bundle, lay down the stub CLI, hand over to Electron-as-Node ──────
if (!process.versions.electron) {
  // One synthetic entry so `Scheduler` and `openPullRequest`/`BaseMovedConflictError` share the
  // SAME bundled copy of `forge/createPr.ts` — see this file's own header for why that matters.
  const entryPath = join(scratch, 'entry.ts');
  writeFileSync(
    entryPath,
    [
      `export { Scheduler } from '${posix(join(mainDir, 'scheduler'))}';`,
      `export { openPullRequest, BaseMovedConflictError } from '${posix(join(mainDir, 'forge', 'createPr'))}';`,
      `export { WorktreeManager } from '${posix(join(mainDir, 'worktreeManager'))}';`,
      `export { createStore } from '${posix(join(mainDir, 'store'))}';`,
      `export { SessionManager } from '${posix(join(mainDir, 'sessionManager'))}';`,
      '',
    ].join('\n'),
    'utf8',
  );
  bundle(entryPath, join(scratch, 'bundle.cjs'));

  // The "prove it can fail" bundle: a byte-for-byte copy of `scheduler.ts` with TM-460's own
  // catch reverted, written NEXT TO the real file (never touching it) so its relative imports
  // resolve exactly as they do for the real one. Deleted again before this block ends, win or
  // lose — this must never be left sitting in the real source tree.
  const needle = 'if (err instanceof BaseMovedConflictError && this.worktrees) {';
  const schedulerSrc = readFileSync(join(mainDir, 'scheduler.ts'), 'utf8');
  if (!schedulerSrc.includes(needle)) {
    throw new Error(
      `scheduler.ts no longer contains the TM-460 catch line this script mutates:\n  ${needle}\n` +
        `Update this script's "prove it can fail" patch to match the current code.`,
    );
  }
  const mutantPath = join(mainDir, 'scheduler.verify-stale-pr-mutant.ts');
  try {
    writeFileSync(mutantPath, schedulerSrc.replace(needle, 'if (false) {'), 'utf8');
    const mutantEntryPath = join(scratch, 'entry-mutant.ts');
    writeFileSync(
      mutantEntryPath,
      `export { Scheduler as MutatedScheduler } from '${posix(mutantPath.replace(/\.ts$/, ''))}';\n`,
      'utf8',
    );
    bundle(mutantEntryPath, join(scratch, 'bundle-mutant.cjs'));
  } finally {
    rmSync(mutantPath, { force: true });
  }

  // The stub CLI: a `.cmd` shim (Windows' shell lookup for a bare `claude` finds it, the way a
  // terminal would) plus the Node script it runs. `claudeSession.ts` feeds the prompt over
  // STDIN (not argv), and the stub never reads it — this is a scripted scenario, so what the
  // "turn" does is fixed in advance: find every unmerged path (`git diff --diff-filter=U`,
  // empty for scenario 1, which never conflicts), write a merged file over each one, and
  // `git add` it — exactly what the real resolve prompt asks an agent to do — then emit the
  // two load-bearing NDJSON lines a real `claude -p --output-format stream-json` run would:
  // `system/init` (the session id `SessionManager` surfaces) and `result` (what `onRunEvent`
  // reads as the turn being over, win or lose).
  const binDir = join(scratch, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'claude.cmd'), '@echo off\r\nnode "%~dp0claude-stub.cjs" %*\r\n');
  writeFileSync(
    join(binDir, 'claude-stub.cjs'),
    [
      "const { spawnSync } = require('child_process');",
      "const fs = require('fs');",
      'const args = process.argv.slice(2);',
      "const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };",
      "const sessionId = at('--session-id') ?? at('--resume') ?? 'stub-session';",
      "const model = at('--model') ?? 'stub';",
      'const cwd = process.cwd();',
      "const diff = spawnSync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd, encoding: 'utf8' });",
      "const conflicted = (diff.stdout ?? '').split('\\n').map((s) => s.trim()).filter(Boolean);",
      'for (const file of conflicted) {',
      "  fs.writeFileSync(require('path').join(cwd, file), 'base\\nmerged: resolved together\\n');",
      "  spawnSync('git', ['add', file], { cwd });",
      '}',
      "process.stdout.write(JSON.stringify({",
      "  type: 'system', subtype: 'init', session_id: sessionId, model,",
      "  cwd, permissionMode: 'acceptEdits',",
      "}) + '\\n');",
      'setTimeout(() => {',
      "  process.stdout.write(JSON.stringify({",
      "    type: 'result', subtype: 'success', is_error: false,",
      "    result: conflicted.length ? `resolved ${conflicted.join(', ')}` : 'stub run complete',",
      '    total_cost_usd: 0,',
      "  }) + '\\n');",
      '}, 200);',
      '// Stay alive — a managed session (stdin kept open) never self-exits after a result; the',
      '// caller (`SessionManager.stop`, which `onRunEvent` calls once it sees that result)',
      '// terminates the process tree once it has what it needs.',
      'process.stdin.resume();',
      '',
    ].join('\n'),
  );

  // The stand-in for `--external:electron` above: `log.ts`'s bare `import { app } from
  // 'electron'` needs SOMETHING to resolve to at require-time. Placed ahead of `clientModules`
  // on `NODE_PATH` so this shim is found before the real (and here, non-functional) npm
  // `electron` package.
  const shimsDir = join(scratch, 'shims');
  mkdirSync(shimsDir, { recursive: true });
  writeFileSync(
    join(shimsDir, 'electron.js'),
    "module.exports = { app: { getPath: () => require('os').tmpdir() } };\n",
  );

  const electron = join(
    clientModules,
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  );
  if (!existsSync(electron)) throw new Error(`electron not installed at ${electron}`);

  const pathSep = process.platform === 'win32' ? ';' : ':';
  const run = spawnSync(electron, [fileURLToPath(import.meta.url), scratch], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: `${shimsDir}${pathSep}${clientModules}`,
      // Prepended, not replacing — `claude.cmd`'s own `node "%~dp0claude-stub.cjs"` still needs
      // the real `node` the rest of PATH provides.
      PATH: `${binDir}${pathSep}${process.env.PATH ?? ''}`,
    },
  });
  process.exit(run.status ?? 1);
}

// ── Phase 2: under Electron-as-Node — the actual scenarios ──────────────────────────────────
const require = createRequire(import.meta.url);
const work = process.argv[2];
const { Scheduler, openPullRequest, WorktreeManager, createStore, SessionManager } = require(
  join(work, 'bundle.cjs'),
);
const { MutatedScheduler } = require(join(work, 'bundle-mutant.cjs'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) failures++;
};

/** One `git` invocation, synchronous — scenario setup has no reason to be concurrent. */
const sh = (cwd, ...args) => {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

/** Poll a sync condition rather than race a fixed timer (see `headless-scenario-harness-traps`):
 *  the chain this script drives is a real async pipeline (a real child process among other
 *  things), and the only honest way to know it is done is to ask the state it is supposed to
 *  leave behind. */
async function waitUntil(label, predicate, { timeoutMs = 30000, intervalMs = 50 } = {}) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - start > timeoutMs) {
      check(label, false, `timed out after ${timeoutMs}ms waiting for this condition`);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** The `CreatePrDeps` `openPullRequest` needs, built off one real store and one real
 *  `WorktreeManager` — `inspect`/`syncOntoRemoteBase` are the genuine methods, never stubs. */
function buildDeps(store, wtm, token) {
  return {
    getTask: (id) => store.getTask(id),
    getProject: (id) => store.getProject(id),
    getSettings: () => store.getSettings(),
    listMergeRequests: () => store.listMergeRequests(),
    upsertMergeRequest: (mr) => store.upsertMergeRequest(mr),
    listVariantRows: () => [],
    listAttachments: () => [],
    listActivity: () => [],
    inspect: (project, ownerTaskId, branchName) => wtm.inspect(project, ownerTaskId, branchName),
    syncOntoRemoteBase: (project, base, worktree, opts) =>
      wtm.syncOntoRemoteBase(project, base, worktree, opts),
    tokenFor: () => token,
    note: (projectId, taskId, body) => store.addComment(projectId, taskId, body),
    now: () => Date.now(),
  };
}

// Every scenario's `insteadOf` rule lives in ONE harness gitconfig (never the user's own
// `~/.gitconfig`). Each `buildRepo` call appends its own rule and rewrites the file before
// that repo's very first push/fetch needs it — nothing here is written up front by hand, so a
// new scenario cannot silently collide with another's token or URL.
const insteadOfLines = [];
function writeHarnessGitConfig() {
  const gitConfig = join(scratch, 'harness.gitconfig');
  writeFileSync(gitConfig, `${insteadOfLines.join('')}[init]\n\tdefaultBranch = main\n`, 'utf8');
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
}

/** A fresh bare "origin" plus a real clone with `origin` pointed at a fake github.com URL — the
 *  `insteadOf` rule redirecting that URL's TOKENIZED form to the bare repo is appended to the
 *  shared harness gitconfig (see {@link writeHarnessGitConfig}) before the repo is used. */
function buildRepo(label, token, remotePath) {
  const dir = mkdtempSync(join(scratch, `${label}-`));
  const bare = join(dir, 'origin.git');
  sh(dir, 'init', '--bare', '-b', 'main', bare);

  insteadOfLines.push(
    `[url "file://${posix(bare)}"]\n` +
      `\tinsteadOf = ${remotePath.replace('https://', `https://x-access-token:${token}@`)}\n`,
  );
  writeHarnessGitConfig();

  const repo = join(dir, 'repo');
  sh(dir, 'init', '-b', 'main', repo);
  sh(repo, 'config', 'user.email', 'verify@example.com');
  sh(repo, 'config', 'user.name', 'Verify');
  sh(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  writeFileSync(join(repo, 'shared.txt'), 'base\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '--no-verify', '-m', 'initial');
  sh(repo, 'remote', 'add', 'origin', remotePath);
  sh(repo, 'push', bare, 'main:refs/heads/main');

  return { dir, bare, repo };
}

const emitNoop = () => undefined;

/**
 * Build one scenario's project/card/worktree: a card delegated to an agent project with
 * `autoCreatePr` on, its own worktree already carrying one real, committed change — the shape
 * `landWork` finds once a run's work has genuinely finished.
 */
async function buildCard(repo, wtm, { branch, title }) {
  const store = createStore(join(repo.dir, 'orchestrator.db'));
  const project = store.addProject({
    path: repo.repo,
    name: title,
    kind: 'agent',
    useWorktrees: true,
    baseBranch: 'main',
    autoCreatePr: true,
    defaultModel: 'sonnet',
    defaultPermissionMode: 'acceptEdits',
    concurrency: 1,
  });
  const card = store.createTask('personal', { title });
  store.updateTask(card.id, {
    agentProjectId: project.id,
    agentBranch: branch,
    status: 'running',
    // The column this card rests in once its run settles — `guardCardStatus` reads this back
    // (falling to a bare `pending` without it), the same memory a real "Start" on an
    // already-in-progress card would have recorded before borrowing `status` for the run.
    preRunStatus: 'in-progress',
  });
  const saved = store.getSettings();
  store.saveSettings({ ...saved, github: { ...saved.github, enabled: true, baseUrl: 'https://api.github.com' } });

  const prep = await wtm.prepare(project, card, card.id, branch);
  if (prep.mode !== 'worktree') throw new Error(`prepare() did not build a worktree: ${JSON.stringify(prep)}`);
  return { store, project: store.getProject(project.id), card: store.getTask(card.id), cwd: prep.cwd };
}

/**
 * Scenario 1 — an agent-rebased branch that was already pushed once, settled through
 * `Scheduler.settle` rather than through `openPullRequest` called by hand. Proves the lease-push
 * fix (F…'s own ticket) and the base-moved-conflict hand-off (TM-460) are wired to the SAME
 * `settle` → `landWork` → `openPullRequestFor` entry point a real finished card actually uses.
 */
async function scenario1() {
  console.log('\n-- Scenario 1: an already-pushed branch, rebased locally onto an advanced base --');
  const TOKEN = 'ghp_verifystale0001';
  const BRANCH = 'orch/stale1';
  const repo = buildRepo('s1', TOKEN, 'https://github.com/acme/stale1.git');
  const wtm = new WorktreeManager(join(repo.dir, 'wtroot'));
  const { store, project, card, cwd } = await buildCard(repo, wtm, {
    branch: BRANCH,
    title: 'Scenario 1 card',
  });

  // The card's own work: a feature commit, pushed once (as "Create PR" would have, before the
  // base ever moved).
  writeFileSync(join(cwd, 'feature.ts'), 'export const x = 1;\n');
  sh(cwd, 'add', '-A');
  sh(cwd, 'commit', '--no-verify', '-m', 'feature work');
  sh(cwd, 'push', repo.bare, `${BRANCH}:refs/heads/${BRANCH}`);
  const preRebaseSha = sh(repo.bare, 'rev-parse', `refs/heads/${BRANCH}`).stdout.trim();

  // The project's local base advances (another card's merge, or a human's own pull) — not
  // pushed to origin, which is exactly what makes `syncOntoRemoteBase` report `up-to-date`:
  // nothing NEW to fetch, even though this branch's own SHAs are about to change underneath it.
  writeFileSync(join(repo.repo, 'other.ts'), 'export const y = 2;\n');
  sh(repo.repo, 'add', '-A');
  sh(repo.repo, 'commit', '--no-verify', '-m', 'someone else landed first');

  // The agent rebases its own branch onto the advanced base before this settle — same content,
  // new SHA, and no longer an ordinary fast-forward of the remote's own copy.
  const rebased = sh(cwd, 'rebase', 'main');
  check('the branch rebases cleanly onto the advanced local base', rebased.code === 0, rebased.stderr);
  const headAfterRebase = sh(cwd, 'rev-parse', 'HEAD').stdout.trim();
  check('the rebase actually produced a new SHA', headAfterRebase !== preRebaseSha);

  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const sent = JSON.parse(String(init?.body ?? '{}'));
    const body = {
      id: 1,
      number: 7,
      title: sent.title,
      state: 'open',
      draft: false,
      html_url: 'https://github.com/acme/stale1/pull/7',
      head: { ref: BRANCH, repo: { id: 101 } },
      base: { ref: 'main' },
    };
    return {
      ok: true,
      status: 201,
      statusText: 'Created',
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
    };
  };

  const attentionItems = [];
  const sessionsNeverUsed = {
    start: () => {
      throw new Error('scenario 1 must never start an agent session — there is no conflict');
    },
    stop: emitNoop,
    send: emitNoop,
  };
  const scheduler = new Scheduler(
    store,
    sessionsNeverUsed,
    emitNoop,
    emitNoop,
    (item) => attentionItems.push(item),
    emitNoop,
    emitNoop,
    wtm,
  );
  scheduler.setPullRequestOpener((taskId) => openPullRequest(buildDeps(store, wtm, TOKEN), taskId));

  scheduler.settle(
    { runId: 'r1', taskId: card.id, projectId: project.id, branch: BRANCH, base: 'main', worktree: cwd },
    'done',
  );

  await waitUntil('scenario 1 settles (a merge_requests row appears)', () => store.listMergeRequests().length > 0);

  const post = calls.find((c) => (c.init.method ?? 'GET') === 'POST');
  check('the pull request was POSTed to the forge', Boolean(post), JSON.stringify(calls.map((c) => c.url)));

  const originHead = sh(repo.bare, 'rev-parse', `refs/heads/${BRANCH}`).stdout.trim();
  check(
    'the bare origin carries the REBASED commit, leased past the stale pre-rebase tip',
    originHead === headAfterRebase,
    `origin has ${originHead}, worktree has ${headAfterRebase}`,
  );

  check('no attention item was ever raised — no human step', attentionItems.length === 0, JSON.stringify(attentionItems));

  const settled = store.getTask(card.id);
  check('the card is back in-progress, not stuck waiting on anything', settled?.status === 'in-progress', settled?.status);

  store.close();
}

/**
 * Scenario 2 — a base that moved and conflicts, found while opening a pull request for the
 * first time. Shared between the real run (expects the ladder to resolve it with no human step)
 * and the "prove it can fail" run against the mutated bundle (expects a parked attention item),
 * so both exercise the identical conflict rather than two scenarios that could quietly drift
 * apart.
 */
async function scenario2(SchedulerClass, label, { expectAttention }) {
  console.log(`\n-- Scenario 2 (${label}): a conflicting base moved before the PR was ever opened --`);
  const TOKEN = `ghp_verifystale2${label}`;
  const BRANCH = `orch/stale2-${label}`;
  const repo = buildRepo(`s2-${label}`, TOKEN, `https://github.com/acme/stale2-${label}.git`);
  const wtm = new WorktreeManager(join(repo.dir, 'wtroot'));
  const { store, project, card, cwd } = await buildCard(repo, wtm, {
    branch: BRANCH,
    title: `Scenario 2 card (${label})`,
  });

  // The card's own work on the line the OTHER clone is about to touch too — never pushed, since
  // this is the first time its pull request is being opened at all.
  writeFileSync(join(cwd, 'shared.txt'), 'base\nmine: fix the export dialog\n');
  sh(cwd, 'add', '-A');
  sh(cwd, 'commit', '--no-verify', '-m', 'mine: fix the export dialog');

  // A second clone pushes a conflicting edit of the SAME line straight to the bare origin —
  // the shape "development has moved" takes when nothing here has fetched it yet.
  const otherClone = join(repo.dir, 'other-clone');
  sh(repo.dir, 'clone', repo.bare, otherClone);
  sh(otherClone, 'config', 'user.email', 'verify@example.com');
  sh(otherClone, 'config', 'user.name', 'Verify');
  sh(otherClone, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(otherClone, 'shared.txt'), 'base\ntheirs: rework app.ts\n');
  sh(otherClone, 'add', '-A');
  sh(otherClone, 'commit', '--no-verify', '-m', 'theirs: rework app.ts');
  sh(otherClone, 'push', 'origin', 'main');
  const theirsSha = sh(repo.bare, 'rev-parse', 'refs/heads/main').stdout.trim();

  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const sent = JSON.parse(String(init?.body ?? '{}'));
    const body = {
      id: 2,
      number: 9,
      title: sent.title,
      state: 'open',
      draft: false,
      html_url: `https://github.com/acme/stale2-${label}/pull/9`,
      head: { ref: BRANCH, repo: { id: 202 } },
      base: { ref: 'main' },
    };
    return {
      ok: true,
      status: 201,
      statusText: 'Created',
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
    };
  };

  const attentionItems = [];
  const sessions = new SessionManager(emitNoop);
  const scheduler = new SchedulerClass(
    store,
    sessions,
    emitNoop,
    emitNoop,
    (item) => attentionItems.push(item),
    emitNoop,
    emitNoop,
    wtm,
  );
  scheduler.setPullRequestOpener((taskId) => openPullRequest(buildDeps(store, wtm, TOKEN), taskId));

  scheduler.settle(
    { runId: 'r1', taskId: card.id, projectId: project.id, branch: BRANCH, base: 'main', worktree: cwd },
    'done',
  );

  const settledOk = await waitUntil(
    `scenario 2 (${label}) reaches an end state (a merge_requests row, or an attention item)`,
    () => store.listMergeRequests().length > 0 || attentionItems.length > 0,
  );
  if (!settledOk) {
    store.close();
    return;
  }

  if (expectAttention) {
    check(
      `(${label}) an attention item WAS raised — the conflict was parked for a human`,
      attentionItems.length > 0,
      JSON.stringify(attentionItems),
    );
    check(
      `(${label}) no pull request was ever opened`,
      store.listMergeRequests().length === 0,
      JSON.stringify(store.listMergeRequests()),
    );
    const branchStillLocal = sh(repo.bare, 'rev-parse', `refs/heads/${BRANCH}`);
    check(`(${label}) the branch was never pushed`, branchStillLocal.code !== 0, branchStillLocal.stdout);
  } else {
    check(`(${label}) no attention item was ever raised — no human step`, attentionItems.length === 0, JSON.stringify(attentionItems));

    const post = calls.find((c) => (c.init.method ?? 'GET') === 'POST');
    check(`(${label}) the pull request was POSTed to the forge`, Boolean(post), JSON.stringify(calls.map((c) => c.url)));

    const originHead = sh(repo.bare, 'rev-parse', `refs/heads/${BRANCH}`).stdout.trim();
    check(`(${label}) the branch landed on the bare origin`, originHead.length > 0, originHead);
    const carriesTheirs = sh(repo.bare, 'merge-base', '--is-ancestor', theirsSha, originHead);
    check(
      `(${label}) the pushed branch carries the OTHER clone's commit (rebased, not clobbered)`,
      carriesTheirs.code === 0,
    );
    const resolvedContent = readFileSync(join(cwd, 'shared.txt'), 'utf8');
    check(
      `(${label}) the file was actually resolved by the agent, not left as either side's version`,
      resolvedContent.includes('merged: resolved together'),
      resolvedContent,
    );

    const settled = store.getTask(card.id);
    check(`(${label}) the card is back in-progress, not stuck waiting on anything`, settled?.status === 'in-progress', settled?.status);
  }

  store.close();
}

async function main() {
  await scenario1();
  await scenario2(Scheduler, 'main', { expectAttention: false });
  await scenario2(MutatedScheduler, 'mutant', { expectAttention: true });

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
