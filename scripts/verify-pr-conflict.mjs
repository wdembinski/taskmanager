/**
 * Headless proof of the PR/MR conflict ladder — end to end, against a real "origin".
 *
 *     node scripts/verify-pr-conflict.mjs
 *
 * ## Why this is a script and not a test
 *
 * `worktreeManager.test.ts` already drives `rebaseForPullRequest` and
 * `finishPullRequestRebase` thoroughly, but every one of those cases passes the local
 * BASE branch name straight in as the target ref, inside a single repository with no
 * remote at all. That proves the rebase ladder itself. It cannot prove the thing
 * `Scheduler.driveForgeConflict` actually does in production: fetch a target branch OFF
 * a remote into a scratch ref, rebase a PR branch onto that fetched ref, and push the
 * result back with `--force-with-lease`. `git.test.ts` proves the lease push in
 * isolation, against a bare repo with nothing rebased. Neither proves the two wired
 * together — that a real conflict fetched from a real "origin" comes out the other end
 * as a real, force-with-lease-pushed commit on that same origin, while the project's own
 * base branch and worktree are left exactly as they were. That is what this script is
 * for.
 *
 * Nothing here is stubbed: `origin` is a real bare repository on disk, the PR branch
 * lives in a real worktree of a real clone, and the "somebody else pushed a conflicting
 * commit to the target while this card was out" step is a second real clone pushing to
 * the same bare repo. `WorktreeManager`, `fetchRef`, `isAncestor`, `stagePaths` and
 * `pushBranch` are the genuine exports of `apps/client/src/main/worktreeManager.ts` and
 * `apps/client/src/main/git.ts`, bundled with esbuild and run directly under this
 * script's own Node — neither file reaches Electron or `better-sqlite3`, so unlike
 * `verify-create-pr.mjs` there is no need to re-exec under `ELECTRON_RUN_AS_NODE`.
 *
 * ## What it proves
 *
 *  1. `fetchRef` pulls a moved target branch, and a PR's own source branch, into scratch
 *     refs inside the PR's worktree — the same two calls `driveForgeConflict` makes.
 *  2. `isAncestor` confirms the fetched source has not diverged from the worktree's own
 *     branch (the "somebody pushed since we last looked" guard).
 *  3. `rebaseForPullRequest` lands on "conflict" for a genuine content clash, leaving the
 *     rebase paused rather than aborting it.
 *  4. After a scripted resolution (write the resolved file, `stagePaths`),
 *     `finishPullRequestRebase` lands on "rebased".
 *  5. The rebased commit is actually built on top of the conflicting commit the second
 *     clone pushed — not merely "no longer conflicted".
 *  6. `pushBranch` with `forceWithLease` lands that commit back on the bare origin, under
 *     the PR branch's own name, leasing the sha fetched in step 1.
 *  7. The project's local base ref never moved, and the worktree was never removed —
 *     a PR/MR rebase touches neither, unlike an ordinary merge into base.
 *  8. The PR branch itself still exists afterwards: rebased, never merged or deleted.
 *
 * ## Prove it can fail
 *
 * A second run of the identical scenario skips step 6 — the lease push — and asserts
 * that the bare origin is then left at the PR branch's PRE-rebase sha. If that assertion
 * ever came back true for a run that DID push, check 6 above would be a tautology that
 * could never catch a dropped push; this is what rules that out. (Reverting the push
 * itself, rather than mutating `git.ts`, is enough here because the behaviour under test
 * is the WIRING between `finishPullRequestRebase` and the push, not `pushBranch`'s own
 * correctness — `git.test.ts`'s lease tests already mutate `pushBranch` directly.)
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The OS temp directory, not a folder inside the repo: a scratch dir under a work tree IS
// part of that work tree, which would leave `git init` inside it confused about which
// repository it is standing in.
const scratchRoot = mkdtempSync(join(tmpdir(), 'tm-pr-conflict-'));

/**
 * esbuild ships as a per-platform binary under a versioned `.pnpm` directory, so it is
 * found by pattern rather than by path: a dependency bump renames the directory, and
 * hard-coding one version would rot this script at the next `pnpm up`.
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
      `--outfile=${outfile}`,
      '--log-level=error',
    ],
    { stdio: 'inherit' },
  );
  if (res.status !== 0) throw new Error(`esbuild failed bundling ${entry}`);
}

// Neither module imports Electron or better-sqlite3 — `worktreeManager.ts` reaches git,
// the exec hosts and node:fs/os/path only — so both bundles run directly under this
// script's own Node, with no Electron-as-Node re-exec.
const wtmFile = join(scratchRoot, 'worktreeManager.cjs');
const gitFile = join(scratchRoot, 'git.cjs');
bundle(join(root, 'apps/client/src/main/worktreeManager.ts'), wtmFile);
bundle(join(root, 'apps/client/src/main/git.ts'), gitFile);

const require = createRequire(import.meta.url);
const { WorktreeManager } = require(wtmFile);
const { fetchRef, pushBranch, isAncestor, stagePaths, currentBranch, branchExists } =
  require(gitFile);

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

/**
 * Build one fresh scenario: a bare "origin", a repo cloned off it with a PR branch in
 * its own worktree already pushed, and a conflicting commit a SECOND clone has since
 * pushed to the target — the shape `driveForgeConflict` is handed by a sync that just
 * noticed the PR/MR is conflicted.
 */
function buildScenario(label) {
  const work = mkdtempSync(join(scratchRoot, `${label}-`));
  const bare = join(work, 'origin.git');
  sh(work, 'init', '--bare', '-b', 'main', bare);

  const repo = join(work, 'repo');
  sh(work, 'init', '-b', 'main', repo);
  sh(repo, 'config', 'user.email', 'verify@example.com');
  sh(repo, 'config', 'user.name', 'Verify');
  sh(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'shared.txt'), 'base\n');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '--no-verify', '-m', 'initial');
  sh(repo, 'remote', 'add', 'origin', bare);
  sh(repo, 'push', 'origin', 'main');
  const baseSha = sh(repo, 'rev-parse', 'main').stdout.trim();

  const prWorktree = join(work, 'pr-worktree');
  sh(repo, 'worktree', 'add', '-b', 'feature/pr', prWorktree, 'main');
  writeFileSync(join(prWorktree, 'shared.txt'), 'base\nfeature change\n');
  sh(prWorktree, 'add', '-A');
  sh(prWorktree, 'commit', '--no-verify', '-m', 'feature change');
  sh(prWorktree, 'push', 'origin', 'HEAD:refs/heads/feature/pr');
  const prShaBeforeRebase = sh(prWorktree, 'rev-parse', 'HEAD').stdout.trim();

  // A second clone, standing in for whoever merged something else into the target while
  // this card's PR was open.
  const otherClone = join(work, 'other-clone');
  sh(work, 'clone', bare, otherClone);
  sh(otherClone, 'config', 'user.email', 'verify@example.com');
  sh(otherClone, 'config', 'user.name', 'Verify');
  sh(otherClone, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(otherClone, 'shared.txt'), 'base\nconflicting change on main\n');
  sh(otherClone, 'add', '-A');
  sh(otherClone, 'commit', '--no-verify', '-m', 'conflicting change on main');
  sh(otherClone, 'push', 'origin', 'main');
  const targetShaAfterConflict = sh(otherClone, 'rev-parse', 'main').stdout.trim();

  return { work, bare, repo, prWorktree, baseSha, prShaBeforeRebase, targetShaAfterConflict };
}

/**
 * Drive the ladder up to (and including) `finishPullRequestRebase`, common to both the
 * main run and the mutation run — they diverge only on whether the lease push happens.
 */
async function rebaseAndResolve(scenario) {
  const { repo, prWorktree, work } = scenario;
  const project = { id: `proj-${Math.random().toString(36).slice(2)}`, path: repo, target: { kind: 'local' } };
  const targetRef = 'refs/remotes/origin/main';
  const wtm = new WorktreeManager(join(work, 'wtroot'));

  const fetchedTarget = await fetchRef(prWorktree, 'origin', 'main', targetRef);
  check('fetchRef pulls the moved target into a scratch ref', fetchedTarget.code === 0, fetchedTarget.stderr);

  const sourceRef = 'refs/orch/pr-source/demo';
  const fetchedSource = await fetchRef(prWorktree, 'origin', 'feature/pr', sourceRef);
  check('fetchRef pulls the PR\'s own source branch too', fetchedSource.code === 0, fetchedSource.stderr);
  const leaseSha = sh(prWorktree, 'rev-parse', sourceRef).stdout.trim();
  check(
    'the fetched source sha matches what was pushed before the conflict',
    leaseSha === scenario.prShaBeforeRebase,
    `${leaseSha} vs ${scenario.prShaBeforeRebase}`,
  );

  const ancestorOk = await isAncestor(prWorktree, leaseSha, 'feature/pr');
  check('isAncestor confirms the branch has not diverged from what was just fetched', ancestorOk);

  const first = await wtm.rebaseForPullRequest(
    project,
    'feature/pr',
    targetRef,
    prWorktree,
    'orchestrator: rebase for !1',
  );
  check(
    'rebaseForPullRequest lands on "conflict" for a real content clash',
    first.status === 'conflict',
    JSON.stringify(first),
  );

  writeFileSync(join(prWorktree, 'shared.txt'), 'base\nresolved together\n');
  const staged = await stagePaths(prWorktree, ['shared.txt']);
  check('the scripted resolution stages cleanly', staged.code === 0, staged.stderr);

  const second = await wtm.finishPullRequestRebase(project, 'feature/pr', targetRef, prWorktree);
  check(
    'finishPullRequestRebase lands on "rebased" after the scripted resolution',
    second.status === 'rebased' &&
      second.branch === 'feature/pr' &&
      second.base === targetRef &&
      second.worktree === prWorktree,
    JSON.stringify(second),
  );

  return { leaseSha };
}

async function runMainCase() {
  const scenario = buildScenario('main');
  const { leaseSha } = await rebaseAndResolve(scenario);

  const newHead = sh(scenario.prWorktree, 'rev-parse', 'HEAD').stdout.trim();
  const onTarget = await isAncestor(scenario.prWorktree, scenario.targetShaAfterConflict, newHead);
  check('the rebased commit is built on top of the conflicting target commit', onTarget);

  const pushed = await pushBranch(scenario.prWorktree, 'origin', 'feature/pr', {
    forceWithLease: { expected: leaseSha },
  });
  check('the lease push succeeds, leasing the sha fetched before the rebase', pushed.code === 0, pushed.stderr);

  const originHead = sh(scenario.bare, 'rev-parse', 'refs/heads/feature/pr').stdout.trim();
  check(
    'origin\'s PR branch now carries the rebased commit',
    originHead === newHead,
    `origin has ${originHead}, worktree has ${newHead}`,
  );
  const originOnTarget = sh(scenario.bare, 'merge-base', '--is-ancestor', scenario.targetShaAfterConflict, originHead);
  check('and that commit really is rebased onto the target, on origin itself', originOnTarget.code === 0);

  const baseNow = sh(scenario.repo, 'rev-parse', 'main').stdout.trim();
  check('the local base ref never moved', baseNow === scenario.baseSha, `${baseNow} vs ${scenario.baseSha}`);

  check('the worktree is still there, never removed', existsSync(scenario.prWorktree));
  const branchNow = await currentBranch(scenario.prWorktree);
  check('and still checked out on the PR branch', branchNow === 'feature/pr', branchNow);
  const branchStillExists = await branchExists(scenario.repo, 'feature/pr');
  check('the PR branch still exists — rebased, never merged or deleted', branchStillExists);
}

/**
 * Same scenario, same rebase, same resolution — but the lease push is skipped, so the
 * check this proves is "would the main run's push-landed assertions have caught this?".
 */
async function runMutationCase() {
  const scenario = buildScenario('mutation');
  await rebaseAndResolve(scenario);

  const originHead = sh(scenario.bare, 'rev-parse', 'refs/heads/feature/pr').stdout.trim();
  check(
    '[mutation: push skipped] origin is left at the pre-rebase sha, which the main ' +
      'run\'s "origin carries the rebased commit" checks would have caught',
    originHead === scenario.prShaBeforeRebase,
    `origin has ${originHead}, expected the pre-rebase ${scenario.prShaBeforeRebase}`,
  );
}

await runMainCase();
await runMutationCase();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
