/**
 * Headless proof of the PR/MR watcher (`apps/client/src/main/forge/prWatcher.ts`) wired into
 * the real engine — the half the unit tests cannot reach.
 *
 *     node scripts/verify-pr-watch.mjs
 *
 * ## Why this is a script and not a test
 *
 * `mergeRequest.test.ts` proves `prWatchAction` is pure and correct, and
 * `forge/prWatcher.test.ts` proves `watchMergeRequests` dispatches to the right dependency
 * for each action. Neither can answer what a human actually cares about: when a real sync
 * hands the watcher a conflicted merge request, does the conflict ladder actually rebase the
 * card's own branch past a real conflict and push the result back to the forge? That answer
 * is the REAL `Scheduler`, the REAL `SessionManager`, a REAL git worktree against a REAL
 * (local, bare) remote, and — for the rebase action — a REAL `GitLabClient`/`GitHubClient`
 * making a REAL `fetch` call. A fake `PrWatcherDeps` stops every one of those links short of
 * the thing being asserted.
 *
 * So this bundles the app's own modules (`store.ts`, `sessionManager.ts`,
 * `worktreeManager.ts`, `scheduler.ts`, `forge/prWatcher.ts`, `git.ts`) with esbuild and runs
 * them under Electron-as-Node — no window, no second instance of the app (see `RELEASE.md`
 * rule 6 / the `verify-electron-app` memory) — against:
 *
 *  - a real SQLite store (`better-sqlite3`, which only loads under Electron's ABI — the
 *    reason this lives here rather than in the vitest suite),
 *  - a stub `claude` on PATH, which speaks the two stream-json lines the app reads and
 *    captures its own argv and stdin prompt, so the DRIVER controls exactly when a turn
 *    "finishes" and can read back what the engine actually asked the agent to do, and
 *  - a fake forge: `global.fetch` replaced with a recorder for the rebase scenario, since
 *    `GitLabClient`/`GitHubClient` call nothing else.
 *
 * ## What it proves
 *
 *  1. **resolve-conflicts, end to end.** A card runs once (a real worktree, a real commit, a
 *     real push into the bare origin). A second clone then pushes a CONFLICTING commit to the
 *     target directly on that same bare origin — somebody else's work landing while this
 *     card's PR was open. A sync hands the watcher the now-conflicted merge request, and the
 *     watcher's `resolveForgeConflict` call drives the real conflict ladder: a real
 *     `fetchRef` of the target and the card's own source branch, a real `rebaseForPullRequest`
 *     that lands on a genuine content conflict, a real Rung 2 — the SAME card requeued with
 *     the paused rebase handed over, not aborted — and, once the conflict markers are
 *     resolved and staged, a real `finishPullRequestRebase` and a real `--force-with-lease`
 *     push. The bare origin's ref actually advances to the rebased, resolved commit, and a
 *     `merge-base --is-ancestor` check against it proves that commit really sits ON TOP of the
 *     one the second clone pushed — proving the whole loop (watcher → scheduler → worktree →
 *     git → remote) rather than just the call into `resolveForgeConflict`.
 *  2. **Idempotency, through the real store.** Re-running the watcher over the SAME row
 *     (re-read from SQLite, carrying the `lastActedSha` the first run persisted) starts no
 *     third session and files no second note — the guard survives a real round trip through
 *     the database, not just the pure function's own arguments.
 *  3. **forge-rebase, against a real fetch call.** A merge request that has fallen behind
 *     makes the watcher PUT `/merge_requests/{iid}/rebase` on GitLab and
 *     `/pulls/{number}/update-branch` on GitHub — the real clients, a fake forge.
 *  4. **A failed attempt is retried, not written off.** No token saved → the rebase action
 *     throws before any `fetch`, the card is told why, and `lastActedSha` is NOT advanced —
 *     so the very next sync gets another chance once a token exists.
 *  5. **Pipeline notes** land on the card's own timeline, named for which way the pipeline
 *     went.
 *  6. **The feature gate, live.** `features.prAutoResolve: false` and the exact same
 *     conflicted row produces NOTHING — no session, no note, no `lastActedSha` — proven
 *     through the real `watchMergeRequests`, which is the one place that gate is checked
 *     (`prWatchAction` itself has never heard of it).
 *  7. **`chainLandedAt` survives a conflict fix.** A card whose chain just landed carries that
 *     one-shot review marker when its PR turns out to be conflicted. The Rung 2 fix still runs
 *     in the card's OWN worktree (not the shared project directory a review turn would use),
 *     the ladder finishes and pushes exactly as in check 1, and the marker is still sitting on
 *     the card afterwards — proving `startTask` excluded this run from `reviewSeed` rather than
 *     the marker having simply not been consumed yet for some other reason.
 *  8. **A legacy row, stranded mid-rebase, is rescued by one watcher pass after a restart.** A
 *     worktree is driven to a real, paused, resolved-and-staged rebase directly (standing in
 *     for whatever got it there before an app quit mid-fix), and its row is written in the
 *     exact shape the old bug left behind: `lastActedSha === headSha` (stamped at dispatch, the
 *     bug `markMrActed`'s new call sites fix) and `lastActedAction: null` (a row from before
 *     that column existed). A BRAND NEW `Scheduler` over the same store and worktree root —
 *     what a restart actually rebuilds — drives `watchMergeRequests` over that one row ONCE,
 *     with no agent run: `rebaseForPullRequest` finds the rebase already in progress, continues
 *     it, and the push lands and stamps the row for real.
 *  9. **A pipeline-passed note, then a conflict on the SAME head, still triggers resolution.**
 *     A clean MR is noted as `note-pipeline-passed` and stamped. The target then moves under it
 *     and the forge reports the identical head as conflicted — the row is re-read (so the
 *     carried-forward memory comes through `upsertMergeRequest`'s own COALESCE, the same path a
 *     real sync reconciler uses) and handed back to the SAME watcher. `resolve-conflicts` fires
 *     despite the unchanged head, because the last action recorded was a note, not a
 *     remediation — and the ladder runs an agent fix and pushes exactly as in check 1.
 *  10. **An older database migrates.** A copy with `headSha`/`lastActedSha` dropped (every
 *     database written before this feature existed) opens without throwing and is writable
 *     afterwards.
 *
 * ## Prove it can fail
 *
 * Comment out the `deps.markActed(...)` call in `prWatcher.ts`'s `watchOne` and re-run: check
 * 2 goes red (a second drive starts, re-queuing a ladder run against a conflict it was
 * already asked to fix). Put the early `if (!deps.getSettings().features.prAutoResolve) return;`
 * behind a `&& false` and check 6 goes red. Change `forgeRebase` to swallow its own error
 * instead of throwing and check 4's "lastActedSha NOT advanced" half goes red. Comment out
 * `pushForgeRebase`'s call to `this.forgeGit.push` in `scheduler.ts` and check 1's final
 * push-landed assertion goes red while everything up to the rebase still passes — proof that
 * assertion is not a tautology.
 *
 * Drop the `!fixingConflict &&` guard off `startTask`'s `reviewSeed` line (reverting 36c1212)
 * and check 7 goes red: the fix run's `cwd` is the shared project directory instead of the
 * worktree, and `chainLandedAt` is cleared out from under the card before the review it was
 * waiting for ever runs. Revert `prWatchAction` to its pre-ecbde6b shape — suppress on any
 * unchanged head, full stop, with no look at `lastActedAction` — and both checks 8 and 9 go
 * red: the stranded worktree in 8 is never re-driven (nothing ever logs "pushed it back"), and
 * the conflict in 9 is silently left unactioned because its head looks already "handled".
 *
 * Exits non-zero naming every failed check.
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
 * The fake `claude`, written as a `.cjs` the shim on PATH invokes.
 *
 * Records its argv, speaks the two stream-json lines `mapRawEvent` reads, captures the first
 * stdin line (the prompt `SessionManager.start` writes before leaving stdin open) to its own
 * `prompt-N.txt`, and waits for a `proceed-N` file before ending its turn — so the driver
 * decides exactly when a turn finishes and nothing races on a timer.
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

/** A real, minimal git repository with a real, local, BARE remote named `origin`. */
function initRepoWithBareOrigin(repoDir, bareDir) {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, 'init');
  git(repoDir, 'config', 'user.email', 'verify@example.com');
  git(repoDir, 'config', 'user.name', 'Verify');
  git(repoDir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repoDir, 'seed.txt'), 'seed\n', 'utf8');
  git(repoDir, 'add', '-A');
  git(repoDir, 'commit', '--no-verify', '-m', 'initial');
  const base = git(repoDir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  git(repoDir, 'init', '--bare', bareDir);
  git(repoDir, 'remote', 'add', 'origin', bareDir);
  git(repoDir, 'push', 'origin', `HEAD:refs/heads/${base}`);
  return base;
}

async function main() {
  let status = 1;
  // The OS temp directory, deliberately, and NOT a scratch folder inside the repo: a
  // directory under a work tree IS part of that work tree, so a `git init` in one leaves
  // git confused about which repository it is standing in.
  const scratch = mkdtempSync(join(tmpdir(), 'tm-pr-watch-'));
  // Worktrees live OUTSIDE the scratch tree too: a worktree's path grows fast (project id +
  // task id + git's own `.git/worktrees/<branch>/...`), and nesting it under an already-long
  // temp path is how `git worktree add` hits Windows' MAX_PATH.
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'tm-pr-watch-wt-'));
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
          `--outfile=${outfile}`,
          '--log-level=error',
        ],
        { stdio: 'inherit' },
      );
      if (result.status !== 0) throw new Error(`esbuild failed on ${entry}`);
    };

    // None of these import Electron (checked by hand: scheduler.ts's whole dependency tree —
    // sessionManager, claudeSession, exec/*, worktreeManager, store, prWatcher, the forge
    // clients — never reaches attachments.ts/contextMenu.ts/focusTracker.ts/index.ts/ipc.ts/
    // log.ts/updater.ts, the only seven files under src/main that do). That is what lets all
    // five be pulled out of the app and run on their own like this, no Electron stub needed.
    bundle(join(root, 'apps/client/src/main/store.ts'), join(scratch, 'store.cjs'));
    bundle(join(root, 'apps/client/src/main/sessionManager.ts'), join(scratch, 'sessionManager.cjs'));
    bundle(join(root, 'apps/client/src/main/worktreeManager.ts'), join(scratch, 'worktreeManager.cjs'));
    bundle(join(root, 'apps/client/src/main/scheduler.ts'), join(scratch, 'scheduler.cjs'));
    bundle(join(root, 'apps/client/src/main/forge/prWatcher.ts'), join(scratch, 'prWatcher.cjs'));
    bundle(join(root, 'apps/client/src/main/git.ts'), join(scratch, 'git.cjs'));

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
    const bareDir = join(scratch, 'origin.git');
    for (const dir of [binDir, proceedDir, promptsDir]) mkdirSync(dir, { recursive: true });

    const logPath = join(scratch, 'invocations.jsonl');
    writeFileSync(logPath, '', 'utf8');
    const stubPath = join(binDir, 'claude-stub.cjs');
    writeFileSync(stubPath, stubSource(logPath, promptsDir, proceedDir), 'utf8');
    writeStubCli(binDir, stubPath, electron);
    log(`Stub claude written to ${binDir}`);

    const base = initRepoWithBareOrigin(repoDir, bareDir);
    log(`Real git repo at ${repoDir}, bare origin at ${bareDir}, base branch "${base}"`);

    const run = spawnSync(
      electron,
      [fileURLToPath(import.meta.url), scratch, repoDir, bareDir, base, binDir, worktreeRoot],
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
const bareDir = process.argv[4];
const base = process.argv[5];
const binDir = process.argv[6];
const worktreeRoot = process.argv[7];

const { createStore } = require(join(work, 'store.cjs'));
const { SessionManager } = require(join(work, 'sessionManager.cjs'));
const { WorktreeManager, taskBranch } = require(join(work, 'worktreeManager.cjs'));
const { Scheduler } = require(join(work, 'scheduler.cjs'));
const { watchMergeRequests } = require(join(work, 'prWatcher.cjs'));
const { fetchRef, pushBranch } = require(join(work, 'git.cjs'));

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

/** Wait for the Nth spawn's own prompt file and read it. */
async function promptFor(n, what) {
  const path = join(PROMPTS, 'prompt-' + n + '.txt');
  await waitFor(what, () => existsSync(path));
  return readFileSync(path, 'utf8');
}

/** Let run N report its result, which is what settles it. */
const proceed = (n) => writeFileSync(join(PROCEED, 'proceed-' + n), 'go', 'utf8');

/** One `git` invocation, synchronous. */
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** Write a file, commit it, push it to origin. Mirrors what an agent turn actually does. */
function commitAndPush(cwd, filename, body, branch) {
  writeFileSync(join(cwd, filename), body, 'utf8');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '--no-verify', '-m', `work: ${filename}`);
  git(cwd, 'push', 'origin', `HEAD:refs/heads/${branch}`);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** The bare origin's ref for `branch`, or null if it has never been pushed. */
function originHead(branch) {
  try {
    return git(bareDir, 'rev-parse', `refs/heads/${branch}`);
  } catch {
    return null;
  }
}

/** True when `ancestorSha` is reachable by walking `descendantSha`'s history, in `cwd`. */
function isAncestorOf(cwd, ancestorSha, descendantSha) {
  const res = spawnSync('git', ['merge-base', '--is-ancestor', ancestorSha, descendantSha], {
    cwd,
  });
  return res.status === 0;
}

/**
 * Everything the card's timeline says, as one string — both a card-scoped comment
 * (`kind: 'comment'`, `deps.note`/`noteCard`) and a run-scoped assistant event
 * (`kind: 'event'`, `Scheduler.noteRun`, e.g. the ladder's "attempting AI resolution" and
 * "pushed it back to the forge" notes), which `getTaskActivity` returns in two different
 * shapes — the event's text lives at `e.event.text`, not `e.body`.
 */
const timelineOf = (taskId) =>
  store
    .getTaskActivity(taskId)
    .map((e) => e.body ?? (e.kind === 'event' ? e.event?.text : undefined) ?? '')
    .join('\n');

process.env.PATH = binDir + require('node:path').delimiter + process.env.PATH;

const worktrees = new WorktreeManager(worktreeRoot);
const store = createStore(join(work, 'orchestrator.db'));
store.saveSettings({ ...store.getSettings(), maxAutoRetries: 0, limitJitterMs: 0 });

const sessions = new SessionManager(() => {});
const taskChanges = [];
const scheduler = new Scheduler(
  store,
  sessions,
  (change) => taskChanges.push(change),
  () => {},
  () => {},
  () => {},
  () => {},
  worktrees,
);

// The ladder's fetch/push, against the REAL bare origin this repo already has as `origin` —
// no token or tokenized URL needed, exactly like a plain `git fetch origin`/`git push origin`
// would need none for a local remote.
scheduler.setForgeGit({
  fetch: async (project, cwd, branch, localRef) => {
    const res = await fetchRef(cwd, 'origin', branch, localRef);
    if (res.code !== 0) return { ok: false, message: res.stderr.trim() || 'git fetch failed' };
    return { ok: true, sha: git(cwd, 'rev-parse', localRef) };
  },
  push: async (project, cwd, branch, expected) => {
    const res = await pushBranch(cwd, 'origin', branch, { forceWithLease: { expected } });
    if (res.code !== 0) return { ok: false, message: res.stderr.trim() || 'git push failed' };
    return { ok: true };
  },
});
// `resolve-conflicts` is stamped by the SCHEDULER itself once the ladder reaches one of its
// own terminals (cf8b4f7) — `prWatcher.ts` no longer stamps it at dispatch — so this wiring
// (mirroring `ipc.ts`'s own `scheduler.setMarkMrActed(...)` call) is what makes `lastActedSha`
// ever advance for that action in this script at all. Missing, every `resolve-conflicts`
// episode below would settle and push for real while leaving its row looking untouched —
// exactly the gap this step's three new scenarios, and the two checks below it that already
// existed, are here to catch.
scheduler.setMarkMrActed((mrId, sha, action) => store.markMergeRequestActed(mrId, sha, action));

/**
 * How many times a run on this task has fully exited so far — the empty patch
 * (`runId: null`) the scheduler's `exited` handler emits after deleting the run, per the
 * `headless-turn-has-no-next-turn` / limit-park harness precedent. A plain "has it ever
 * exited" predicate would latch true forever once the FIRST of two runs on the SAME card
 * (as in scenario 1, which reuses one card across two turns) finishes, so callers compare
 * this count against a snapshot taken before the run they are actually waiting on.
 */
const exitCountFor = (taskId) =>
  taskChanges.filter((c) => c.task.id === taskId && c.runId === null).length;

const project = store.addProject({
  path: repoDir,
  name: 'the pr-watch repo',
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

/** A full `MergeRequest` row, defaulted to a clean/mergeable one like `mergeRequest.test.ts`'s. */
function mrRow(over) {
  return {
    id: 'gl-9-1',
    taskId: null,
    openedForTaskId: null,
    provider: 'gitlab',
    repoId: 9,
    projectPath: 'acme/web',
    number: 1,
    title: 'Fix the thing',
    displayName: null,
    webUrl: 'https://gitlab.example.com/acme/web/-/merge_requests/1',
    sourceBranch: 'feature/x',
    targetBranch: base,
    state: 'opened',
    draft: false,
    headSha: 'headsha1',
    lastActedSha: null,
    lastActedAction: null,
    pipelineStatus: 'unknown',
    pipelineStages: [],
    pipelineUrl: null,
    approvalsRequired: null,
    approvalsGiven: 0,
    changesRequested: false,
    detailedMergeStatus: null,
    hasConflicts: false,
    issueKeys: [],
    latestNoteAt: null,
    lastReadAt: null,
    lastEventAt: null,
    lastEventSeenAt: null,
    updatedAt: 1_760_000_000_000,
    syncedAt: 1_760_000_000_000,
    ...over,
  };
}

/** Only what was added to the card's timeline since `before` was captured. */
function notesSince(taskId, before) {
  const all = timelineOf(taskId);
  return all.length > before.length ? all.slice(before.length) : '';
}

// ===========================================================================
section('1. resolve-conflicts: the real scheduler, worktree and git, end to end');

store.saveSettings({
  ...store.getSettings(),
  features: { ...store.getSettings().features, prAutoResolve: true },
});

const chatCard = card('Fix the login form');
const branch = taskBranch(chatCard.id); // the fallback name — this card never set agentBranch
const exitsBeforeFirst = exitCountFor(chatCard.id);
scheduler.runTask(chatCard.id);
const firstRun = await nthInvocation(1, 'the first run to spawn');
check('the run happened in its own worktree, not the project directory', firstRun.cwd.replace(/\\/g, '/') !== repoDir.replace(/\\/g, '/'));

// Modifies `seed.txt`, which already exists on `base` from `initRepoWithBareOrigin` —
// rather than adding a brand-new file — so the conflict manufactured below is an ordinary
// modify/modify clash with real `<<<<<<<` markers, the exact shape `worktreeManager.test.ts`
// already proves the ladder resolves, rather than an add/add clash whose marker shape this
// script would otherwise be guessing at.
const firstSha = commitAndPush(firstRun.cwd, 'seed.txt', 'seed\nbranch work\n', branch);
check(
  'the agent\'s first commit really landed in the bare origin',
  originHead(branch) === firstSha,
  `${originHead(branch)} != ${firstSha}`,
);
proceed(1);
// Two patches land per successful, non-chain, worktree run: `settle()`'s own status patch
// (the branch is unmerged, so the card rests at "pending" with a note on its timeline) and
// the LATER, truly-final one the `exited` handler fires once the process is actually gone
// and `this.runs` no longer holds it. Waiting for only the first one is exactly how this
// script's first draft raced `chatWithAgent`: it found run 1 still in the map (not yet
// deleted) and delivered straight into its dying stdin as `status: 'sent'` instead of
// starting the resumed run this scenario is about.
await waitFor(
  'the first run process to fully exit',
  () => exitCountFor(chatCard.id) >= exitsBeforeFirst + 2,
);
const exitsAfterFirst = exitCountFor(chatCard.id);

const sessionId = store.getTask(chatCard.id).sessionId;
check('a real session id was established', typeof sessionId === 'string' && sessionId.length > 0, sessionId);

// Somebody else's work landing on the target while this card's PR was open — a SECOND
// clone of the bare origin, modifying the same file the card's own first commit modified,
// so rebasing the card's branch onto it is a genuine content conflict.
const baseShaBeforeConflict = git(repoDir, 'rev-parse', base);
const otherClone = join(work, 'other-clone');
git(work, 'clone', bareDir, otherClone);
git(otherClone, 'config', 'user.email', 'verify@example.com');
git(otherClone, 'config', 'user.name', 'Verify');
git(otherClone, 'config', 'commit.gpgsign', 'false');
writeFileSync(join(otherClone, 'seed.txt'), 'seed\nconflicting change on the target\n', 'utf8');
git(otherClone, 'add', '-A');
git(otherClone, 'commit', '--no-verify', '-m', 'conflicting change on the target');
git(otherClone, 'push', 'origin', `HEAD:refs/heads/${base}`);
const targetConflictSha = git(otherClone, 'rev-parse', 'HEAD');

const timelineBeforeConflict = timelineOf(chatCard.id);
const conflictMr = mrRow({
  id: 'gl-501-7',
  openedForTaskId: chatCard.id,
  repoId: 501,
  number: 7,
  webUrl: 'https://gitlab.example.com/acme/web/-/merge_requests/7',
  sourceBranch: branch,
  targetBranch: base,
  headSha: firstSha,
  detailedMergeStatus: 'conflict',
  hasConflicts: true,
});
store.upsertMergeRequest(conflictMr);

const deps = {
  getSettings: () => store.getSettings(),
  getTask: (id) => store.getTask(id),
  tokenFor: () => 'stub-token',
  resolveForgeConflict: (taskId, mr) => scheduler.resolveForgeConflict(taskId, mr),
  note: (projectId, taskId, body) => store.addComment(projectId, taskId, body),
  markActed: (mrId, headSha, action) => store.markMergeRequestActed(mrId, headSha, action),
};

await watchMergeRequests([conflictMr], deps);

// The ladder's own fetch+rebase run in the background (`Scheduler.driveForgeConflict`), and
// lands on a real conflict: a Rung 2 fix is dispatched as a fresh, requeued run of the SAME
// card, in the SAME worktree, with the paused rebase handed over rather than aborted.
const secondRun = await nthInvocation(2, 'the conflict-fix run to spawn');
check(
  'it resumed the card\'s EXACT session, not a fresh one',
  flag(secondRun, '--resume') === sessionId,
  `${flag(secondRun, '--resume')} != ${sessionId}`,
);
check('and in the SAME worktree the first run used', secondRun.cwd === firstRun.cwd, `${secondRun.cwd} != ${firstRun.cwd}`);
check(
  'the worktree really is mid-rebase, with conflict markers in seed.txt',
  readFileSync(join(secondRun.cwd, 'seed.txt'), 'utf8').includes('<<<<<<<'),
);

const rebaseNote = notesSince(chatCard.id, timelineBeforeConflict);
check(
  'the card\'s timeline says the ladder is rebasing, naming the MR',
  rebaseNote.includes('!7') && rebaseNote.includes('conflicts with') && rebaseNote.includes(base),
  rebaseNote,
);

// Resolve it the way a Rung 2 turn is told to: edit the file, `git add` it — never commit,
// push or `rebase --continue`, which is the orchestrator's job once this turn's `result`
// lands (see `dispatchConflictFix`'s own note to the agent).
writeFileSync(join(secondRun.cwd, 'seed.txt'), 'seed\nresolved together\n', 'utf8');
git(secondRun.cwd, 'add', 'seed.txt');
proceed(2);
await waitFor(
  'the conflict-fix run to settle',
  () => exitCountFor(chatCard.id) >= exitsAfterFirst + 2,
);
// `applyIntegrationResult`'s 'rebased' case fires the lease push fire-and-forget
// (`void this.pushForgeRebase(...)`), and `finishConflict` itself is reached the same way
// from the run's own exit handling — so settling the RUN does not mean the push, or the
// note it files right after, have landed yet. Wait for the note rather than the origin ref
// directly: it is written strictly after a successful push, so waiting on it subsumes both.
await waitFor(
  'the lease push to land, and the "pushed it back" note to follow it',
  () => notesSince(chatCard.id, timelineBeforeConflict).includes('pushed it back to the forge'),
);

const pushedSha = originHead(branch);
check(
  'the rebased, resolved commit really landed on the bare origin',
  pushedSha !== null && pushedSha !== firstSha,
  `${pushedSha} (was ${firstSha})`,
);
check(
  // `bareDir` itself, not `otherClone`: it alone has BOTH commits as objects — the
  // conflicting push and the final rebased one — since every push in this scenario lands
  // on it, while `otherClone`'s object store was cloned before the second one existed.
  'and it is built ON TOP of the conflicting commit the second clone pushed',
  pushedSha !== null && isAncestorOf(bareDir, targetConflictSha, pushedSha),
);
check(
  'the local base ref never moved — a PR/MR rebase touches no base ref',
  git(repoDir, 'rev-parse', base) === baseShaBeforeConflict,
);

const pushNote = notesSince(chatCard.id, timelineBeforeConflict);
check(
  'the card\'s timeline says it was pushed back to the forge',
  pushNote.includes('pushed it back to the forge'),
  pushNote,
);

const actedRow = store.listMergeRequests().find((r) => r.id === conflictMr.id);
check(
  'lastActedSha was persisted to the real store',
  actedRow?.lastActedSha === firstSha,
  JSON.stringify(actedRow),
);

// ---------------------------------------------------------------------------
section('2. idempotency, through a real re-read of the row');

const reRead = store.listMergeRequests().find((r) => r.id === conflictMr.id);
const invocationsBeforeReplay = invocations().length;
const timelineBeforeReplay = timelineOf(chatCard.id);
await watchMergeRequests([reRead], deps);
await sleep(400); // a spawn that was going to happen would have happened by now
check('no third run was dispatched', invocations().length === invocationsBeforeReplay, invocations().length);
check('and no further note was filed', timelineOf(chatCard.id) === timelineBeforeReplay);

// ===========================================================================
section('3. forge-rebase: the real GitLabClient/GitHubClient against a fake forge');

const fetchCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), method: init?.method ?? 'GET' });
  return { ok: true, status: 204, statusText: 'No Content', text: async () => '', json: async () => ({}) };
};

store.saveSettings({
  ...store.getSettings(),
  gitlab: { ...store.getSettings().gitlab, baseUrl: 'https://gitlab.example.com' },
  github: { ...store.getSettings().github, baseUrl: 'https://api.github.com' },
});

const gitlabCard = card('Needs a GitLab rebase');
const gitlabMr = mrRow({
  id: 'gl-501-9',
  openedForTaskId: gitlabCard.id,
  repoId: 501,
  number: 9,
  detailedMergeStatus: 'need_rebase',
  headSha: 'gl-rebase-sha',
});
store.upsertMergeRequest(gitlabMr);
const gitlabTimelineBefore = timelineOf(gitlabCard.id);
await watchMergeRequests([gitlabMr], deps);

const gitlabCall = fetchCalls.find((c) => c.url.includes('/merge_requests/9/rebase'));
check(
  'it PUT the GitLab rebase endpoint',
  gitlabCall?.url === 'https://gitlab.example.com/api/v4/projects/501/merge_requests/9/rebase' &&
    gitlabCall.method === 'PUT',
  JSON.stringify(gitlabCall),
);
check(
  'and noted it on the card, naming the forge',
  notesSince(gitlabCard.id, gitlabTimelineBefore).includes('asked GitLab to rebase it'),
  timelineOf(gitlabCard.id),
);
check(
  'lastActedSha advanced for the rebase too',
  store.listMergeRequests().find((r) => r.id === gitlabMr.id)?.lastActedSha === 'gl-rebase-sha',
);

const githubCard = card('Needs a GitHub rebase');
const githubMr = mrRow({
  id: 'gh-777-14',
  provider: 'github',
  openedForTaskId: githubCard.id,
  repoId: 777,
  projectPath: 'acme/web2',
  number: 14,
  detailedMergeStatus: 'behind', // GitHub's own spelling of "needs a rebase"
  headSha: 'gh-rebase-sha',
});
store.upsertMergeRequest(githubMr);
await watchMergeRequests([githubMr], deps);
const githubCall = fetchCalls.find((c) => c.url.includes('/pulls/14/update-branch'));
check(
  'and it PUT the GitHub update-branch endpoint',
  githubCall?.url === 'https://api.github.com/repos/acme/web2/pulls/14/update-branch' &&
    githubCall.method === 'PUT',
  JSON.stringify(githubCall),
);

// ---------------------------------------------------------------------------
section('4. a rebase that could not even be attempted is retried, not written off');

const noTokenCard = card('No GitLab token saved yet');
const noTokenMr = mrRow({
  id: 'gl-501-10',
  openedForTaskId: noTokenCard.id,
  repoId: 501,
  number: 10,
  detailedMergeStatus: 'need_rebase',
  headSha: 'no-token-sha',
});
store.upsertMergeRequest(noTokenMr);
const fetchCallsBefore = fetchCalls.length;
await watchMergeRequests([noTokenMr], { ...deps, tokenFor: () => null });
check('no fetch was even attempted', fetchCalls.length === fetchCallsBefore, fetchCalls.length - fetchCallsBefore);
check(
  'the card is told why, by name',
  timelineOf(noTokenCard.id).includes('No GitLab token is saved'),
  timelineOf(noTokenCard.id),
);
check(
  'and lastActedSha was NOT advanced — the next sync gets another chance',
  store.listMergeRequests().find((r) => r.id === noTokenMr.id)?.lastActedSha === null,
);

globalThis.fetch = realFetch;

// ===========================================================================
section('5. pipeline notes');

const pipelineCard = card('Watching a pipeline');
const failedMr = mrRow({
  id: 'gl-501-11',
  openedForTaskId: pipelineCard.id,
  repoId: 501,
  number: 11,
  pipelineStatus: 'failed',
  pipelineUrl: 'https://gitlab.example.com/acme/web/-/pipelines/999',
  headSha: 'pipeline-failed-sha',
});
store.upsertMergeRequest(failedMr);
await watchMergeRequests([failedMr], deps);
check(
  'a failed pipeline is noted, with its URL',
  timelineOf(pipelineCard.id).includes("pipeline failed") &&
    timelineOf(pipelineCard.id).includes('pipelines/999'),
  timelineOf(pipelineCard.id),
);

const passedMr = mrRow({
  id: 'gl-501-12',
  openedForTaskId: pipelineCard.id,
  repoId: 501,
  number: 12,
  pipelineStatus: 'success',
  headSha: 'pipeline-passed-sha',
});
store.upsertMergeRequest(passedMr);
const beforePassed = timelineOf(pipelineCard.id);
await watchMergeRequests([passedMr], deps);
check(
  'and a passed one too, distinctly',
  notesSince(pipelineCard.id, beforePassed).includes('pipeline passed'),
  notesSince(pipelineCard.id, beforePassed),
);

// ===========================================================================
section('6. the feature gate, live — through the real watchMergeRequests, not the pure fn');

store.saveSettings({
  ...store.getSettings(),
  features: { ...store.getSettings().features, prAutoResolve: false },
});
const gatedCard = card('Would have needed the agent, but the gate is off');
const gatedMr = mrRow({
  id: 'gl-501-13',
  openedForTaskId: gatedCard.id,
  repoId: 501,
  number: 13,
  detailedMergeStatus: 'conflict',
  hasConflicts: true,
  headSha: 'gated-sha',
});
store.upsertMergeRequest(gatedMr);
const invocationsBeforeGate = invocations().length;
await watchMergeRequests([gatedMr], deps);
await sleep(300);
check('no session was started while the gate is off', invocations().length === invocationsBeforeGate);
check('no note was filed either', timelineOf(gatedCard.id) === '');
check(
  'and lastActedSha stayed null — the gate never even looked',
  store.listMergeRequests().find((r) => r.id === gatedMr.id)?.lastActedSha === null,
);

// Restore for cleanliness before the sections below reopen the same database.
store.saveSettings({
  ...store.getSettings(),
  features: { ...store.getSettings().features, prAutoResolve: true },
});

// ===========================================================================
section('7. chainLandedAt is not consumed by a conflict fix (36c1212)');

const chainCard = card('Chain just landed, then hit a conflict');
const chainBranch = taskBranch(chainCard.id);
const chainExitsBefore = exitCountFor(chainCard.id);
const chainFirstRunN = invocations().length + 1;
scheduler.runTask(chainCard.id);
const chainFirstRun = await nthInvocation(chainFirstRunN, "the chain-landed card's first run");
const chainFirstSha = commitAndPush(chainFirstRun.cwd, 'seed.txt', 'seed\nchain-landed branch work\n', chainBranch);
proceed(chainFirstRunN);
await waitFor(
  "the chain-landed card's first run to fully exit",
  () => exitCountFor(chainCard.id) >= chainExitsBefore + 2,
);

// `finishParentChain`'s own one-shot marker — set here by hand rather than by driving a
// whole parent chain to completion, since only its PRESENCE on the card matters to `startTask`.
store.updateTask(chainCard.id, { chainLandedAt: 1_700_000_000_000 });

const chainOtherClone = join(work, 'chain-other-clone');
git(work, 'clone', bareDir, chainOtherClone);
git(chainOtherClone, 'config', 'user.email', 'verify@example.com');
git(chainOtherClone, 'config', 'user.name', 'Verify');
git(chainOtherClone, 'config', 'commit.gpgsign', 'false');
writeFileSync(join(chainOtherClone, 'seed.txt'), 'seed\nconflicting change for the chain-landed card\n', 'utf8');
git(chainOtherClone, 'add', '-A');
git(chainOtherClone, 'commit', '--no-verify', '-m', 'conflicting change for the chain-landed card');
git(chainOtherClone, 'push', 'origin', `HEAD:refs/heads/${base}`);
const chainTargetConflictSha = git(chainOtherClone, 'rev-parse', 'HEAD');

const chainTimelineBefore = timelineOf(chainCard.id);
const chainMr = mrRow({
  id: 'gl-700-30',
  openedForTaskId: chainCard.id,
  repoId: 700,
  number: 30,
  webUrl: 'https://gitlab.example.com/acme/web/-/merge_requests/30',
  sourceBranch: chainBranch,
  targetBranch: base,
  headSha: chainFirstSha,
  detailedMergeStatus: 'conflict',
  hasConflicts: true,
});
store.upsertMergeRequest(chainMr);

const chainFixRunN = invocations().length + 1;
await watchMergeRequests([chainMr], deps);
const chainFixRun = await nthInvocation(chainFixRunN, "the chain-landed card's conflict-fix run");
check(
  "the fix run landed in the card's OWN worktree, not a shared project directory — " +
    'chainLandedAt must not have routed it through reviewSeed',
  chainFixRun.cwd === chainFirstRun.cwd,
  `${chainFixRun.cwd} != ${chainFirstRun.cwd}`,
);
check(
  'chainLandedAt is still set while the fix is in flight — a conflict fix must not consume it',
  store.getTask(chainCard.id).chainLandedAt === 1_700_000_000_000,
);

writeFileSync(join(chainFixRun.cwd, 'seed.txt'), 'seed\nresolved for the chain-landed card\n', 'utf8');
git(chainFixRun.cwd, 'add', 'seed.txt');
proceed(chainFixRunN);
await waitFor(
  "the chain-landed card's fix to settle and push",
  () => notesSince(chainCard.id, chainTimelineBefore).includes('pushed it back to the forge'),
);

const chainPushedSha = originHead(chainBranch);
check(
  'the rebased commit landed on origin for the chain-landed card too',
  chainPushedSha !== null && chainPushedSha !== chainFirstSha,
  `${chainPushedSha} (was ${chainFirstSha})`,
);
check(
  'built on top of the conflicting target commit',
  chainPushedSha !== null && isAncestorOf(bareDir, chainTargetConflictSha, chainPushedSha),
);
const chainNotes = notesSince(chainCard.id, chainTimelineBefore);
check(
  'the card\'s timeline says "Rebased … and pushed"',
  chainNotes.includes('Rebased') && chainNotes.includes('and pushed it back to the forge'),
  chainNotes,
);
const chainRow = store.listMergeRequests().find((r) => r.id === chainMr.id);
check(
  'and the row is stamped once the ladder actually settled',
  chainRow?.lastActedSha === chainFirstSha && chainRow?.lastActedAction === 'resolve-conflicts',
  JSON.stringify(chainRow),
);
check(
  'chainLandedAt is STILL set afterwards — left for whichever run actually reviews the card',
  store.getTask(chainCard.id).chainLandedAt === 1_700_000_000_000,
);

// ===========================================================================
section('8. a legacy row, stranded mid-rebase, is rescued by one watcher pass after a restart (cf8b4f7)');

const strandedCard = card('Stranded mid-rebase after a restart');
const strandedBranch = taskBranch(strandedCard.id);
const strandedExitsBefore = exitCountFor(strandedCard.id);
const strandedRunN = invocations().length + 1;
scheduler.runTask(strandedCard.id);
const strandedRun = await nthInvocation(strandedRunN, "the stranded card's only run");
const strandedSha = commitAndPush(strandedRun.cwd, 'seed.txt', 'seed\nstranded branch work\n', strandedBranch);
proceed(strandedRunN);
await waitFor(
  "the stranded card's run to fully exit",
  () => exitCountFor(strandedCard.id) >= strandedExitsBefore + 2,
);

const strandedOtherClone = join(work, 'stranded-other-clone');
git(work, 'clone', bareDir, strandedOtherClone);
git(strandedOtherClone, 'config', 'user.email', 'verify@example.com');
git(strandedOtherClone, 'config', 'user.name', 'Verify');
git(strandedOtherClone, 'config', 'commit.gpgsign', 'false');
writeFileSync(join(strandedOtherClone, 'seed.txt'), 'seed\nconflicting change for the stranded card\n', 'utf8');
git(strandedOtherClone, 'add', '-A');
git(strandedOtherClone, 'commit', '--no-verify', '-m', 'conflicting change for the stranded card');
git(strandedOtherClone, 'push', 'origin', `HEAD:refs/heads/${base}`);
const strandedTargetConflictSha = git(strandedOtherClone, 'rev-parse', 'HEAD');

// Manufacture the exact state a stranded worktree was left in before cf8b4f7: fetch the
// target, rebase directly against it (bypassing the watcher entirely — this scenario is about
// the watcher RESCUING a worktree, not about how it got stuck), resolve and stage the
// conflict, but never call `finishPullRequestRebase` — the rebase is left paused, exactly as
// an app that quit mid-fix would leave it.
const strandedTargetRef = `refs/remotes/origin/${base}`;
const strandedFetch = await fetchRef(strandedRun.cwd, 'origin', base, strandedTargetRef);
check('fetched the target ref to manufacture the stranded state', strandedFetch.code === 0, strandedFetch.stderr);
const strandedRebase = await worktrees.rebaseForPullRequest(
  project,
  strandedBranch,
  strandedTargetRef,
  strandedRun.cwd,
  'orchestrator: rebase for the stranded MR',
);
check(
  'rebaseForPullRequest lands on "conflict", manufacturing the stranded state',
  strandedRebase.status === 'conflict',
  JSON.stringify(strandedRebase),
);
writeFileSync(
  join(strandedRun.cwd, 'seed.txt'),
  'seed\nstranded resolution, staged but never continued\n',
  'utf8',
);
git(strandedRun.cwd, 'add', 'seed.txt');

// The legacy row: `lastActedSha` already equals `headSha` — the old code stamped this at
// DISPATCH, before the ladder it queued had run a single git command — and `lastActedAction`
// is null, either because the column predates this row or because that dispatch-time stamp
// predates the action ever being recorded. Exactly what six real worktrees on this host
// looked like.
const strandedMr = mrRow({
  id: 'gl-900-21',
  openedForTaskId: strandedCard.id,
  repoId: 900,
  number: 21,
  webUrl: 'https://gitlab.example.com/acme/web/-/merge_requests/21',
  sourceBranch: strandedBranch,
  targetBranch: base,
  headSha: strandedSha,
  lastActedSha: strandedSha,
  lastActedAction: null,
  detailedMergeStatus: 'conflict',
  hasConflicts: true,
});
store.upsertMergeRequest(strandedMr);

// A brand-new Scheduler, exactly as a restart would build one: no in-memory
// `forgeConflictHandled`/`pendingConflictFix` state survives a restart, over the SAME store,
// session manager and worktree root.
const restarted = new Scheduler(
  store,
  sessions,
  (change) => taskChanges.push(change),
  () => {},
  () => {},
  () => {},
  () => {},
  worktrees,
);
restarted.setForgeGit({
  fetch: async (restartedProject, cwd, branch, localRef) => {
    const res = await fetchRef(cwd, 'origin', branch, localRef);
    if (res.code !== 0) return { ok: false, message: res.stderr.trim() || 'git fetch failed' };
    return { ok: true, sha: git(cwd, 'rev-parse', localRef) };
  },
  push: async (restartedProject, cwd, branch, expected) => {
    const res = await pushBranch(cwd, 'origin', branch, { forceWithLease: { expected } });
    if (res.code !== 0) return { ok: false, message: res.stderr.trim() || 'git push failed' };
    return { ok: true };
  },
});
// The same wiring as the main scheduler's own `setMarkMrActed` above — a restart rebuilds
// this too, and without it the stranded row would get rescued but never stamped.
restarted.setMarkMrActed((mrId, sha, action) => store.markMergeRequestActed(mrId, sha, action));
const restartedDeps = {
  ...deps,
  resolveForgeConflict: (taskId, mr) => restarted.resolveForgeConflict(taskId, mr),
};

const strandedTimelineBefore = timelineOf(strandedCard.id);
const invocationsBeforeRestart = invocations().length;
await watchMergeRequests([strandedMr], restartedDeps);
await waitFor(
  'the restarted scheduler to finish and push the stranded rebase',
  () => notesSince(strandedCard.id, strandedTimelineBefore).includes('pushed it back to the forge'),
);

check(
  'no new agent run was needed — the resolution was already staged in the worktree',
  invocations().length === invocationsBeforeRestart,
  invocations().length - invocationsBeforeRestart,
);
const strandedPushedSha = originHead(strandedBranch);
check(
  'the stranded rebase really landed on origin',
  strandedPushedSha !== null && strandedPushedSha !== strandedSha,
  `${strandedPushedSha} (was ${strandedSha})`,
);
check(
  'built on top of the conflicting commit the other clone pushed',
  strandedPushedSha !== null && isAncestorOf(bareDir, strandedTargetConflictSha, strandedPushedSha),
);
const strandedRow = store.listMergeRequests().find((r) => r.id === strandedMr.id);
check(
  'and the row is finally stamped correctly, now that the ladder actually settled',
  strandedRow?.lastActedSha === strandedSha && strandedRow?.lastActedAction === 'resolve-conflicts',
  JSON.stringify(strandedRow),
);

restarted.dispose();

// ===========================================================================
section('9. a pipeline-passed note, then a conflict on the SAME head, still triggers resolution (ecbde6b)');

const pcCard = card('Pipeline passed, then the target moved and left a conflict');
const pcBranch = taskBranch(pcCard.id);
const pcExitsBefore = exitCountFor(pcCard.id);
const pcFirstRunN = invocations().length + 1;
scheduler.runTask(pcCard.id);
const pcFirstRun = await nthInvocation(pcFirstRunN, "the pipeline/conflict card's first run");
const pcSha = commitAndPush(pcFirstRun.cwd, 'seed.txt', 'seed\npipeline/conflict branch work\n', pcBranch);
proceed(pcFirstRunN);
await waitFor(
  "the pipeline/conflict card's first run to fully exit",
  () => exitCountFor(pcCard.id) >= pcExitsBefore + 2,
);

const pcTimelineBeforeNote = timelineOf(pcCard.id);
const pcMrPassed = mrRow({
  id: 'gl-800-40',
  openedForTaskId: pcCard.id,
  repoId: 800,
  number: 40,
  webUrl: 'https://gitlab.example.com/acme/web/-/merge_requests/40',
  sourceBranch: pcBranch,
  targetBranch: base,
  headSha: pcSha,
  pipelineStatus: 'success',
});
store.upsertMergeRequest(pcMrPassed);
await watchMergeRequests([pcMrPassed], deps);
check(
  'the pipeline passing is noted',
  notesSince(pcCard.id, pcTimelineBeforeNote).includes('pipeline passed'),
  timelineOf(pcCard.id),
);
const pcRowAfterNote = store.listMergeRequests().find((r) => r.id === pcMrPassed.id);
check(
  'and the row remembers which action fired, on this exact head',
  pcRowAfterNote?.lastActedSha === pcSha && pcRowAfterNote?.lastActedAction === 'note-pipeline-passed',
  JSON.stringify(pcRowAfterNote),
);

// The target moves underneath it — same head, a conflict the forge did not report a moment
// ago. `lastActedSha`/`lastActedAction` are left off this update, same as every other row this
// script builds by hand — `upsertMergeRequest`'s own COALESCE is what carries the real ones
// forward, exactly as a sync reconciler's own update does.
const pcOtherClone = join(work, 'pipeline-conflict-other-clone');
git(work, 'clone', bareDir, pcOtherClone);
git(pcOtherClone, 'config', 'user.email', 'verify@example.com');
git(pcOtherClone, 'config', 'user.name', 'Verify');
git(pcOtherClone, 'config', 'commit.gpgsign', 'false');
writeFileSync(join(pcOtherClone, 'seed.txt'), 'seed\nconflicting change after the pipeline passed\n', 'utf8');
git(pcOtherClone, 'add', '-A');
git(pcOtherClone, 'commit', '--no-verify', '-m', 'conflicting change after the pipeline passed');
git(pcOtherClone, 'push', 'origin', `HEAD:refs/heads/${base}`);
const pcTargetConflictSha = git(pcOtherClone, 'rev-parse', 'HEAD');

store.upsertMergeRequest(
  mrRow({
    id: pcMrPassed.id,
    openedForTaskId: pcCard.id,
    repoId: 800,
    number: 40,
    webUrl: pcMrPassed.webUrl,
    sourceBranch: pcBranch,
    targetBranch: base,
    headSha: pcSha, // unchanged — no new push to the PR branch itself
    pipelineStatus: 'success',
    detailedMergeStatus: 'conflict',
    hasConflicts: true,
  }),
);
const pcReRead = store.listMergeRequests().find((r) => r.id === pcMrPassed.id);
check(
  'the re-read row still carries the note forward, same head, before the watcher looks again',
  pcReRead?.lastActedSha === pcSha && pcReRead?.lastActedAction === 'note-pipeline-passed',
  JSON.stringify(pcReRead),
);

const pcTimelineBeforeFix = timelineOf(pcCard.id);
const pcFixRunN = invocations().length + 1;
await watchMergeRequests([pcReRead], deps);
const pcFixRun = await nthInvocation(
  pcFixRunN,
  'the conflict-fix run on an unchanged head whose last action was a note',
);
check(
  "resolve-conflicts fired in the card's own worktree despite the unchanged head, because " +
    'the last action was a NOTE, not a remediation',
  pcFixRun.cwd === pcFirstRun.cwd,
  `${pcFixRun.cwd} != ${pcFirstRun.cwd}`,
);

writeFileSync(join(pcFixRun.cwd, 'seed.txt'), 'seed\nresolved after the pipeline-passed note\n', 'utf8');
git(pcFixRun.cwd, 'add', 'seed.txt');
proceed(pcFixRunN);
await waitFor(
  'the fix to settle and push',
  () => notesSince(pcCard.id, pcTimelineBeforeFix).includes('pushed it back to the forge'),
);

const pcPushedSha = originHead(pcBranch);
check('the rebased commit landed on origin', pcPushedSha !== null && pcPushedSha !== pcSha, `${pcPushedSha} (was ${pcSha})`);
check(
  'built on top of the conflicting target commit',
  pcPushedSha !== null && isAncestorOf(bareDir, pcTargetConflictSha, pcPushedSha),
);
const pcFinalRow = store.listMergeRequests().find((r) => r.id === pcMrPassed.id);
check(
  'and the row now remembers the remediation, not the stale note',
  pcFinalRow?.lastActedSha === pcSha && pcFinalRow?.lastActedAction === 'resolve-conflicts',
  JSON.stringify(pcFinalRow),
);

// ===========================================================================
// Kill every stub still waiting on a proceed file before the database is closed. The pause
// is for Windows: termination is its own kill, and a stub whose CWD is a worktree keeps that
// directory locked until it is really gone.
scheduler.dispose();
sessions.stopAll();
await sleep(750);

const dbPath = join(work, 'orchestrator.db');
store.close();

// ===========================================================================
section('10. an older database — written before headSha/lastActedSha/lastActedAction existed — migrates');

const raw = new (require('better-sqlite3'))(dbPath);
raw.exec(`ALTER TABLE merge_requests DROP COLUMN headSha`);
raw.exec(`ALTER TABLE merge_requests DROP COLUMN lastActedSha`);
raw.exec(`ALTER TABLE merge_requests DROP COLUMN lastActedAction`);
const columnsNow = raw.prepare(`PRAGMA table_info(merge_requests)`).all().map((c) => c.name);
raw.close();
check(
  'all three columns can be taken away, so the migration has something to do',
  !columnsNow.includes('headSha') &&
    !columnsNow.includes('lastActedSha') &&
    !columnsNow.includes('lastActedAction'),
  JSON.stringify(columnsNow),
);

let upgraded = null;
let openError = null;
try {
  upgraded = createStore(dbPath);
} catch (e) {
  openError = String(e?.message ?? e);
}
check('opening the older database does not throw', upgraded !== null, openError ?? undefined);
if (upgraded) {
  const row = upgraded.listMergeRequests().find((r) => r.id === conflictMr.id);
  check(
    'the migration adds all three columns back, empty',
    row !== undefined &&
      row.headSha === null &&
      row.lastActedSha === null &&
      row.lastActedAction === null,
    JSON.stringify(row ?? null),
  );
  // Writable afterwards — an ALTER that ran but left the UPSERT naming a column that is not
  // there would only be found here.
  upgraded.markMergeRequestActed(conflictMr.id, 'after-migration-sha', 'resolve-conflicts');
  const rewritten = upgraded.listMergeRequests().find((r) => r.id === conflictMr.id);
  check(
    'and the new columns can be written and read back through it',
    rewritten?.lastActedSha === 'after-migration-sha' &&
      rewritten?.lastActedAction === 'resolve-conflicts',
    JSON.stringify(rewritten),
  );
  upgraded.close();
}

console.log('');
console.log(invocations().length + ' CLI invocation(s) observed.');
if (failures > 0) {
  console.error(failures + ' check(s) failed.');
  process.exit(1);
}
