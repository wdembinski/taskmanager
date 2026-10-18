/**
 * Headless proof of **Create PR** — the push and the create, end to end.
 *
 *     node scripts/verify-create-pr.mjs
 *
 * ## Why this is a script and not a test
 *
 * Two halves of it cannot live in vitest, for two different reasons — and both are reasons a
 * bug here would go unseen:
 *
 *  - **The push is real.** A temporary repository with a **bare repo as its `origin`** is the
 *    only way to find out whether the branch actually landed on the far side. `git.test.ts`
 *    does that much for `pushBranch` alone; what it cannot do is drive the whole of
 *    `openPullRequest` on top of it.
 *  - **The row is written by the real store.** `better-sqlite3`'s addon is compiled for
 *    ELECTRON's ABI, so `require`ing it under the Node that runs vitest dies with
 *    `ERR_DLOPEN_FAILED` — which is why nothing in the suite calls `createStore` at all. The
 *    way past it is RELEASE.md §5's: run the Electron binary as plain Node
 *    (`ELECTRON_RUN_AS_NODE=1`). No window is opened and the user's profile is never touched
 *    — see the `verify-electron-app` rule.
 *
 * The forge is the only thing stubbed: `fetch` is replaced with a recorder that answers the
 * call GitHub would. Everything else — the repo, the branch, the push, the database — is real.
 *
 * ## How the push reaches a local bare repo while still looking like GitHub
 *
 * The remote has to be a **github.com https URL**, or none of the interesting code runs: that
 * is what makes `pickForge` say GitHub and what makes the push go to a *tokenized* URL. So
 * git is redirected instead of the app: a scratch config (`GIT_CONFIG_GLOBAL`, so the user's
 * own global config is untouched) carries one `insteadOf` rule mapping that exact tokenized
 * URL to the bare repo on disk. Nothing about `createPr.ts` or `git.ts` is stubbed or
 * special-cased — git is simply pointed somewhere reachable, which is the same trick a
 * mirror or a corporate proxy plays on it every day.
 *
 * ## What it proves
 *
 *  1. `openPullRequest` pushes the card's branch into the bare origin, and the commit really
 *     is there afterwards under `refs/heads/<branch>`.
 *  2. It POSTs to `/repos/{owner}/{repo}/pulls` carrying a commit-style title built from the
 *     card, the base branch, and a body summarising the branch's own commits.
 *  3. A `merge_requests` row appears **against the card**, under the id the next sync will
 *     use (`gh-{repoId}-{number}`), so the card shows the PR now and the reconciler
 *     recognises it later rather than filing a duplicate beside it.
 *  4. The token never reaches the repository's `.git/config` — it is spent as argv, and
 *     `--set-upstream` is skipped for exactly that reason.
 *  5. Every refusal names its wall: a repo with no `origin` says so, in those words.
 *  6. A card that keeps working keeps ONE pull request, up to date: the second call pushes the
 *     new commit into the open PR and POSTs nothing. This is the one behaviour here with no
 *     visible symptom when it breaks — the button still succeeds, the note still reads well,
 *     and the work simply never reaches the forge.
 *  7. A forge with no URL configured refuses by naming the setting, not with `Invalid URL`.
 *  8. The **next sync leaves the row on the card**. The card here carries no tracker key, so
 *     matching by key has nothing to work with — and matching by key is all the reconciler
 *     used to do, which is why the row appeared on the button and was gone by the next poll.
 *  9. The same holds for a card that is not on the Personal board at all. A second project is
 *     added with no plan file and a ticket prefix of its own — a board-owning ticket project,
 *     the shape `ticket:create` files a card on — and its card's pull request survives a sync
 *     built with `buildBoardIndex(store.getAllBoardTasks())`, the exact expression `ipc.ts`
 *     now calls. Before that fix the index only ever covered the Personal board, so a card
 *     anywhere else read, to the reconciler, as one that had been deleted.
 *  10. A database written **before** `openedForTaskId` existed upgrades into it and is writable
 *     afterwards. Every installed copy is that database, and this is the only harness in the
 *     repo that can open one at all (see `the-store-has-no-tests`).
 *  11. **The remote is checked before the push.** A second repo/bare-origin pair, so advancing
 *     the remote's copy of `base` here cannot alter anything the checks above already proved.
 *     Someone pushes straight to the bare origin — the shape `base` moving on the remote
 *     without this process ever fetching it — and `openPullRequest` is driven through the
 *     REAL `WorktreeManager.syncOntoRemoteBase`, not a stub: the branch lands on the far side
 *     already rebased onto that push, carrying both its own commit and the remote's.
 *  12. **A second rebase of an already-open pull request pushes with a LEASE.** Base moves on
 *     the remote a second time, after the branch has already been pushed once: the rebase
 *     rewrites its commits again, and an ORDINARY push would now be rejected as non-fast-forward
 *     against what check 11 already put there. `git.pushBranch`'s `--force-with-lease` is what
 *     lets it through anyway — leased against the branch's own tip, fetched fresh.
 *  13. **Work already on the remote base refuses, and POSTs nothing.** A branch whose one
 *     commit has already been merged into `base` on the far side — the shape a card's PR takes
 *     once its own work has already landed, while this worktree's copy of base is still stale.
 *     The rebase the remote check does finds nothing left to replay, and the refusal names that.
 *  14. **A conflict with the remote refuses, naming the file, pushing nothing.** Base and the
 *     branch edit the same line differently; the rebase the remote check does conflicts, and
 *     neither mechanical rung can resolve it. The branch is left exactly as it was — checked
 *     out, no rebase paused, no conflict markers — and nothing reaches the bare origin.
 *  15. **A LOCAL base that has already diverged from origin still opens a clean PR.** The real
 *     bug: `base` itself carries a commit origin never saw (a local merge) while origin ALSO
 *     moved past the fork point. The old remote check tried to fast-forward local base to
 *     origin FIRST and refused outright the moment that failed, before the branch's own
 *     rebase ever ran. The branch still lands, rebased onto origin's fresh tip, carrying only
 *     its own commit — never the one local base picked up on its own — and the pull request's
 *     body names only that one commit too.
 *  16. **`commitLeftover` commits a run's own leftover edits, then opens the PR.** A branch
 *     with no commits of its own yet — sitting exactly on base — but a file left uncommitted
 *     in the worktree, the shape a finished run leaves behind (F7.2's own bug). Asked with
 *     `opts.commitLeftover` (the scheduler's own call, never the button's), `openPullRequest`
 *     commits that file before `hasCommits`/`commitsAhead` ever look at the branch, notes the
 *     commit on the card's timeline, then pushes and opens the pull request exactly as check 1
 *     above does — carrying the file it just committed.
 *  17. **The same leftover work, without the flag, refuses by naming it — and touches nothing.**
 *     The button's own call (no `commitLeftover`) against the identical worktree: no commit is
 *     made, so `commitsAhead` reads 0 and the refusal from check 8's sibling fires — now naming
 *     the uncommitted file instead of guessing "merged, or nothing was ever written". Nothing
 *     is pushed, no pull request is opened, and the branch's `HEAD` and worktree are exactly
 *     what they were before the call.
 *
 * ## Prove it can fail
 *
 * Break the push and watch it go red. In `apps/client/src/main/git.ts`, change `pushBranch`'s
 * refspec from `HEAD:refs/heads/${branch}` to `HEAD:refs/heads/wrong` and re-run: check 1
 * fails, because the branch is not in the bare repo under its own name. Or put
 * `'--set-upstream'` back unconditionally and check 4 fails, because git records the
 * tokenized URL in the repo's own config.
 *
 * For check 6, put the early return back: in `createPr.ts`, return `reportOpen()` as soon as
 * `alreadyOpen` is truthy, before the push. The second call then still answers `#12` and still
 * POSTs nothing — everything a caller can see stays correct — and only "pushes the new commit"
 * goes red, which is exactly why it is worth a check of its own.
 *
 * For check 8, drop `openedForTaskId: taskId` from `rowFor` in `createPr.ts` — the row is still
 * written, still on the card, and still under the right id, and the sync one line later takes
 * it off the card. That is the whole bug, and only check 8 sees it.
 *
 * For check 9, point that scenario's index at `store.getPersonalTasks()` instead of
 * `store.getAllBoardTasks()` — the exact regression this closes, reintroduced by hand. The
 * board card is not on the Personal board, so it vanishes from `knownTaskIds`, `matchTaskId`
 * in `githubPrSync.ts` no longer recognises `openedForTaskId` as one of ours, and the row's
 * `taskId` goes back to `null` — orphaned, open, and belonging to nobody, exactly as reported.
 *
 * For check 10, delete the guarded `ALTER TABLE merge_requests ADD COLUMN openedForTaskId` from
 * `store.ts`: the fresh database above is unaffected — every check up to 9 still passes — and
 * re-opening the older one dies on `no such column`, which is what an installed copy would do
 * on the first press of the button.
 *
 * For check 11, delete the call to `deps.syncOntoRemoteBase` in `createPr.ts` (or revert it to
 * stop before the push): the branch still pushes and the pull request still opens, so this is
 * exactly the kind of regression nothing else in this file would catch — only check 11 looks at
 * whether the far side actually got the remote's own commit along with the branch's.
 *
 * For check 12, drop the `forceWithLease` field from the `pushBranch` call in `createPr.ts` (push
 * plainly even after a sync that rebased). Check 11 still passes — that branch had never been
 * pushed before — and only the SECOND round, against a branch the remote already has under an
 * older history, goes red: git rejects it as non-fast-forward and `openPullRequest` throws.
 *
 * For check 13, delete the post-sync `commitsAhead` re-check in `createPr.ts` (the one run only
 * when `sync.status === 'synced'`). The branch still rebases onto the merged base, still ends
 * up with nothing new to push, and now sails straight through to a POST for a pull request with
 * an empty diff — exactly the one this check exists to catch.
 *
 * For check 14, drop the `abortRebase` call in `syncOntoRemoteBase`'s conflict branch (in
 * `worktreeManager.ts`) — the refusal and its message are unaffected, so the first two parts of
 * check 14 stay green, and only "the branch itself is untouched" and "its work tree is clean"
 * go red: the worktree is left mid-rebase, `HEAD` detached onto a commit rather than the
 * branch, and the conflict markers from `resolveMechanically`'s failed attempt still sitting in
 * `shared.txt`.
 *
 * For check 15, put the fast-forward-first behavior back in `syncOntoRemoteBase` (fail outright
 * when the best-effort `updateLocalBase` call errors, instead of swallowing it): the whole
 * scenario goes red with "could not rebase ... fatal: Not possible to fast-forward" — this is
 * the exact live bug, reproduced.
 *
 * For check 16, revert `createPr.ts`'s `commitLeftover` block to do nothing (or just delete the
 * `commitAll` call inside it): the leftover file is never committed, so `hasCommits` still
 * answers `true` off the repo's own initial commit but `commitsAhead` reads 0, and the call
 * that check 16 expects to open a pull request throws the same "uncommitted changes" refusal
 * check 17 is about instead — exactly the live bug this step exists to close, reproduced on
 * demand. Put the line back and both checks pass again.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
// The OS temp directory, deliberately, and NOT a scratch folder inside the repo: a directory
// under a work tree IS part of that work tree, so a `git init` in one leaves git confused
// about which repository it is standing in — and the whole point here is a repo of our own.
const scratch = mkdtempSync(join(tmpdir(), 'tm-create-pr-'));

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

// ── Phase 1: plain Node — bundle the sources, then hand over to Electron ──────────────
if (!process.versions.electron) {
  const esbuild = findEsbuild();
  const bundle = (entry, outfile, external) =>
    spawnSync(
      esbuild,
      [
        entry,
        '--bundle',
        '--platform=node',
        '--format=cjs',
        `--alias:@shared=${join(root, 'packages', 'shared', 'src')}`,
        // `cloudDelta.ts` — reached from `store.ts` — imports `@protocol/wire`, the same
        // tsconfig path alias as `@shared`, just for a package esbuild has no other way to
        // find outside of actually resolving the workspace's own `node_modules` symlinks.
        `--alias:@protocol=${join(root, 'packages', 'protocol', 'src')}`,
        ...(external ? [`--external:${external}`] : []),
        `--outfile=${outfile}`,
        '--log-level=error',
      ],
      { stdio: 'inherit' },
    );

  // Neither of these imports Electron — `createPr.ts` reaches git, the exec hosts and
  // `fetch`, and `store.ts` reaches only node:*, better-sqlite3, @shared/* and @protocol/*.
  // That is what lets both be pulled out of the app and run on their own like this.
  bundle(join(root, 'apps/client/src/main/forge/createPr.ts'), join(scratch, 'createPr.cjs'));
  bundle(join(root, 'apps/client/src/main/store.ts'), join(scratch, 'store.cjs'), 'better-sqlite3');
  // The reconciler checks 8 and 9 run — pure, and the third module here that reaches no
  // Electron.
  bundle(join(root, 'apps/client/src/main/github/githubPrSync.ts'), join(scratch, 'prSync.cjs'));
  // The board index check 9 builds through, the exact expression `ipc.ts` calls it with —
  // also pure, also no Electron.
  bundle(join(root, 'apps/client/src/main/forge/boardIndex.ts'), join(scratch, 'boardIndex.cjs'));
  // Check 11's `syncOntoRemoteBase` — also pure: `./exec` and `./git` are both system
  // binaries and `node:*`, same as `createPr.ts` itself.
  bundle(
    join(root, 'apps/client/src/main/worktreeManager.ts'),
    join(scratch, 'worktreeManager.cjs'),
  );

  const electron = join(
    clientModules,
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  );
  if (!existsSync(electron)) throw new Error(`electron not installed at ${electron}`);

  const run = spawnSync(electron, [fileURLToPath(import.meta.url), scratch], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      // The bundles live in temp, outside any node_modules tree, so the external
      // `require('better-sqlite3')` inside them needs somewhere to resolve from.
      NODE_PATH: clientModules,
    },
  });
  process.exit(run.status ?? 1);
}

// ── Phase 2: under Electron-as-Node — the actual checks ──────────────────────────────
const require = createRequire(import.meta.url);
const work = process.argv[2];
const { openPullRequest } = require(join(work, 'createPr.cjs'));
const { createStore } = require(join(work, 'store.cjs'));
const { reconcilePullRequests } = require(join(work, 'prSync.cjs'));
const { buildBoardIndex } = require(join(work, 'boardIndex.cjs'));
const { WorktreeManager } = require(join(work, 'worktreeManager.cjs'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) failures++;
};

/** One `git` invocation, synchronous — this script has no reason to be concurrent. */
const git = (cwd, ...args) => {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

// A token with no URL-significant characters, so the `insteadOf` rule below can name the
// tokenized URL literally — `createPr` percent-encodes the token into it.
const TOKEN = 'ghp_verifycreatepr0000';
const BRANCH = 'feat/export-dialog';
const REMOTE = 'https://github.com/acme/checkout.git';

const bare = join(work, 'origin.git');
git(work, 'init', '--bare', bare);

// Redirect the tokenized URL to the bare repo, in a config of OUR OWN — `GIT_CONFIG_GLOBAL`
// replaces the user's `~/.gitconfig` for every git this script runs and touches nothing of
// theirs. It is the harness's file, not the repository's, which is what keeps check 4
// meaningful: the app must still not write the token into `.git/config`.
const gitConfig = join(work, 'harness.gitconfig');
writeFileSync(
  gitConfig,
  `[url "file://${bare.replace(/\\/g, '/')}"]\n` +
    `\tinsteadOf = https://x-access-token:${TOKEN}@github.com/acme/checkout.git\n` +
    `[init]\n\tdefaultBranch = main\n`,
  'utf8',
);
process.env.GIT_CONFIG_GLOBAL = gitConfig;

// ── A repository with a branch that has work base does not have ──────────────────────
const repo = join(work, 'repo');
git(work, 'init', repo);
git(repo, 'config', 'user.email', 'verify@example.com');
git(repo, 'config', 'user.name', 'Verify');
git(repo, 'config', 'commit.gpgsign', 'false');
writeFileSync(join(repo, 'README.md'), '# demo\n');
git(repo, 'add', '-A');
git(repo, 'commit', '--no-verify', '-m', 'initial');
const base = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
git(repo, 'remote', 'add', 'origin', REMOTE);

git(repo, 'checkout', '-b', BRANCH);
writeFileSync(join(repo, 'export.ts'), 'export const ok = true;\n');
git(repo, 'add', '-A');
git(repo, 'commit', '--no-verify', '-m', 'add the export dialog');
const head = git(repo, 'rev-parse', 'HEAD').stdout.trim();

// ── The store: a real database, so the row round-trips through real SQL ──────────────
const store = createStore(join(work, 'orchestrator.db'));
const project = store.addProject({ path: repo, name: 'Checkout', kind: 'agent', baseBranch: base });
const card = store.createTask('personal', {
  title: 'Fix the export dialog',
  description: 'The dialog forgets the last folder.',
});
store.updateTask(card.id, { agentProjectId: project.id, agentBranch: BRANCH });
const saved = store.getSettings();
store.saveSettings({
  ...saved,
  github: { ...saved.github, enabled: true, baseUrl: 'https://api.github.com' },
});

// ── The forge, stubbed: a recorder standing in for GitHub ────────────────────────────
const calls = [];
// One `number` per branch, allocated on first sight and remembered — `BRANCH` gets `#12`
// exactly as every check below assumes, and check 9's board branch gets a number of its
// own rather than colliding with it.
let nextPrNumber = 12;
const prsByBranch = new Map();
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init: init ?? {} });
  const sent = JSON.parse(String(init?.body ?? '{}'));
  const branch = sent.head ?? BRANCH;
  let pr = prsByBranch.get(branch);
  if (!pr) {
    pr = {
      number: nextPrNumber++,
      htmlUrl: `https://github.com/acme/checkout/pull/${nextPrNumber - 1}`,
    };
    prsByBranch.set(branch, pr);
  }
  const body = {
    id: 900,
    number: pr.number,
    title: sent.title,
    state: 'open',
    draft: false,
    html_url: pr.htmlUrl,
    head: { ref: branch, repo: { id: 555 } },
    base: { ref: base },
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

// The REAL `syncOntoRemoteBase` for every scenario below, not a stub — check 11 is what this
// buys: without it, a regression that drops the remote check (or breaks it) would push and
// open a pull request successfully in every check above and go unnoticed by all of them.
const wtm = new WorktreeManager(work);

const notes = [];
const deps = {
  getTask: (id) => store.getTask(id),
  getProject: (id) => store.getProject(id),
  getSettings: () => store.getSettings(),
  listMergeRequests: () => store.listMergeRequests(),
  upsertMergeRequest: (mr) => store.upsertMergeRequest(mr),
  // None of the cards here are ever shot by `ui-shots.mjs`, so these never have anything to
  // find — but `openPullRequest` calls them on every card, so they have to exist.
  listAttachments: (taskId) => store.attachmentsForTask(taskId),
  listActivity: (taskId) => store.getTaskActivity(taskId),
  // Standing in for `WorktreeManager.inspect`, the one dependency this scenario has no use
  // for: it exists to READ a branch/base pair off disk, and here they are already known.
  inspect: async () => ({ cwd: repo, branch: BRANCH, base }),
  syncOntoRemoteBase: (project, base, worktree, opts) =>
    wtm.syncOntoRemoteBase(project, base, worktree, opts),
  tokenFor: () => TOKEN,
  note: (_projectId, _taskId, body) => notes.push(body),
  now: () => 1_760_000_000_000,
};

const opened = await openPullRequest(deps, card.id);

check(
  'it reports the pull request it opened',
  opened.ref === '#12' && opened.existed === false,
  JSON.stringify(opened),
);

// 1 — the branch really landed on the far side, under its own name.
const there = git(bare, 'rev-parse', `refs/heads/${BRANCH}`);
check(
  'the branch landed in the bare origin',
  there.code === 0 && there.stdout.trim() === head,
  there.stderr.trim() || there.stdout.trim(),
);

// 2 — the create went where GitHub's API lives, carrying the card.
const post = calls.find((c) => (c.init.method ?? 'GET') === 'POST');
check(
  'it POSTed to /repos/acme/checkout/pulls',
  post?.url === 'https://api.github.com/repos/acme/checkout/pulls',
  post?.url,
);
const sent = JSON.parse(String(post?.init.body ?? '{}'));
check(
  'with a commit-style title built from the card and its base branch',
  sent.title === 'fix: fix the export dialog' && sent.base === base,
  JSON.stringify(sent),
);
check(
  "and the branch's own commit summarised as the body",
  String(sent.body).includes('add the export dialog'),
  String(sent.body),
);

// 3 — the row, against the card, under the id the next sync will use.
const rows = store.listMergeRequests();
const row = rows.find((r) => r.taskId === card.id);
check(
  'a merge_requests row appeared against the card',
  Boolean(row),
  `${rows.length} row(s), none for ${card.id}`,
);
check('under the id githubPrSync would rebuild', row?.id === 'gh-555-12', row?.id);
check(
  'open, with honest empties for what we do not know yet',
  row?.state === 'opened' &&
    row?.pipelineStatus === 'unknown' &&
    row?.approvalsRequired === null &&
    row?.pipelineStages.length === 0,
  JSON.stringify(row),
);
check(
  'and the note carries the URL',
  notes.some((n) => n.includes('https://github.com/acme/checkout/pull/12')),
  notes.join(' | '),
);

// 4 — the secret is spent as argv and nowhere else. `--set-upstream` is skipped precisely so
// that git cannot record the tokenized URL as `branch.<name>.remote`.
const config = readFileSync(join(repo, '.git', 'config'), 'utf8');
check('the token is NOT written into .git/config', !config.includes(TOKEN), config);
check(
  'and no upstream was recorded for the branch either',
  !config.includes(`[branch "${BRANCH}"]`),
  config,
);

// 5 — a refusal that names its wall.
const lonely = join(work, 'lonely');
git(work, 'init', lonely);
git(lonely, 'config', 'user.email', 'verify@example.com');
git(lonely, 'config', 'user.name', 'Verify');
git(lonely, 'config', 'commit.gpgsign', 'false');
writeFileSync(join(lonely, 'a.txt'), 'x\n');
git(lonely, 'add', '-A');
git(lonely, 'commit', '--no-verify', '-m', 'initial');
const lonelyBase = git(lonely, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
git(lonely, 'checkout', '-b', BRANCH);
writeFileSync(join(lonely, 'b.txt'), 'y\n');
git(lonely, 'add', '-A');
git(lonely, 'commit', '--no-verify', '-m', 'work');

const second = store.createTask('personal', { title: 'A card in a remote-less repo' });
const lonelyProject = store.addProject({
  path: lonely,
  name: 'Lonely',
  kind: 'agent',
  baseBranch: lonelyBase,
});
store.updateTask(second.id, { agentProjectId: lonelyProject.id, agentBranch: BRANCH });

const refusal = await openPullRequest(
  { ...deps, inspect: async () => ({ cwd: lonely, branch: BRANCH, base: lonelyBase }) },
  second.id,
).then(
  () => null,
  (e) => String(e?.message ?? e),
);
check(
  'a repo with no origin refuses, and says so',
  Boolean(refusal && /no "origin" remote/i.test(refusal)),
  refusal ?? '(it did not refuse)',
);

// ── 6: a card that goes on working keeps its ONE pull request up to date ─────────────
// The second settle of the same card — a later step of the plan, a re-run, a chat that wrote
// code. The pull request is already open, so nothing is POSTed; the branch must still be
// pushed, or those commits never leave this machine while the timeline says they did.
writeFileSync(join(repo, 'export.ts'), 'export const ok = true;\nexport const more = 1;\n');
git(repo, 'add', '-A');
git(repo, 'commit', '--no-verify', '-m', 'more work on the export dialog');
const secondHead = git(repo, 'rev-parse', 'HEAD').stdout.trim();
const postsBefore = calls.filter((c) => (c.init.method ?? 'GET') === 'POST').length;

const again = await openPullRequest(deps, card.id);

check(
  'a second run reports the pull request that is already open',
  again.existed === true && again.ref === '#12',
  JSON.stringify(again),
);
const thereNow = git(bare, 'rev-parse', `refs/heads/${BRANCH}`);
check(
  'and pushes the new commit into it rather than stranding it locally',
  thereNow.code === 0 && thereNow.stdout.trim() === secondHead,
  `origin has ${thereNow.stdout.trim() || thereNow.stderr.trim()}, branch is at ${secondHead}`,
);
check(
  'without POSTing a second create',
  calls.filter((c) => (c.init.method ?? 'GET') === 'POST').length === postsBefore,
  `${calls.filter((c) => (c.init.method ?? 'GET') === 'POST').length} POST(s), was ${postsBefore}`,
);
check(
  'and the note says it was pushed, not that a second one was opened',
  notes.some((n) => n.includes('already open') && n.includes('#12')),
  notes.join(' | '),
);

// ── 7: a forge with no URL configured refuses BY NAME ────────────────────────────────
// The guard `ipc.ts`'s client builders have always carried, now shared with this path
// (`forge/baseUrl.ts`). Without it the blank setting reaches `fetch` as the RELATIVE url
// `/api/v3/repos/…` and the human is shown `TypeError: Invalid URL` — thrown from inside the
// one function whose stated contract is that every refusal names its own wall.
//
// A third card, because the two above now carry an open pull request and would stop at it
// before a client was ever built. The push still happens (the branch is already there, so
// git says "Everything up-to-date") and the refusal comes from the create, which is exactly
// where it came from before.
const configured = store.getSettings();
store.saveSettings({ ...configured, github: { ...configured.github, baseUrl: '   ' } });
const third = store.createTask('personal', { title: 'A card whose forge has no URL' });
store.updateTask(third.id, { agentProjectId: project.id, agentBranch: BRANCH });
const noUrl = await openPullRequest(deps, third.id).then(
  () => null,
  (e) => String(e?.message ?? e),
);
check(
  'a forge with no URL configured refuses by naming the setting',
  Boolean(noUrl && /GitHub API URL/.test(noUrl) && !/Invalid URL/i.test(noUrl)),
  noUrl ?? '(it did not refuse)',
);
store.saveSettings(configured);

// ── 8: the next sync leaves the row on the card ──────────────────────────────────────
// The reported bug. The row appears the moment the button is pressed and is gone off the card
// again by the next poll: `reconcilePullRequests` rebuilds `taskId` from the keys it can find
// in the pull request's own text, and this card — typed in here, exactly as a native ticket or
// a hand-made card is — carries none. It wrote `taskId: null` over a link the button had known
// for certain, and the row sat in the table belonging to nobody.
//
// Run through the REAL store, not just the reconciler, because the fix is only as good as the
// column under it: `openedForTaskId` has to survive the round trip through SQLite, including
// the guarded ALTER that adds it to a database written before it existed.
const board = {
  // The board as `boardKeyIndex` builds it for a card with no tracker key: no keys at all,
  // and the card's own id.
  knownKeys: [],
  taskIdByKey: new Map(),
  knownTaskIds: new Set([card.id, second.id, third.id]),
  identity: null,
  now: 1_760_000_100_000,
};
const stored = store.listMergeRequests().filter((r) => r.provider === 'github');
check(
  'the stored row remembers the card it was opened for',
  stored.find((r) => r.id === 'gh-555-12')?.openedForTaskId === card.id,
  JSON.stringify(stored.map((r) => ({ id: r.id, openedForTaskId: r.openedForTaskId }))),
);
// What the sync actually does: the same search row GitHub would return for the open PR.
const listed = {
  repoId: 555,
  number: 12,
  projectPath: 'acme/checkout',
  title: 'Fix the export dialog',
  description: 'The dialog forgets the last folder.',
  webUrl: 'https://github.com/acme/checkout/pull/12',
  sourceBranch: BRANCH,
  targetBranch: base,
  state: 'opened',
  draft: false,
  pipelineStatus: 'unknown',
  pipelineStages: [],
  pipelineUrl: null,
  approvalsRequired: null,
  approvalsGiven: 0,
  changesRequested: false,
  detailedMergeStatus: null,
  hasConflicts: false,
  updatedAt: 1_760_000_050_000,
};
const { upserts, deleteIds } = reconcilePullRequests(stored, [listed], board);
for (const mr of upserts) store.upsertMergeRequest(mr);
store.deleteMergeRequests(deleteIds);

const afterSync = store.listMergeRequests().find((r) => r.id === 'gh-555-12');
check(
  'and the sync leaves it on that card instead of orphaning it',
  afterSync?.taskId === card.id,
  `taskId is ${String(afterSync?.taskId)}, card is ${card.id}`,
);
check(
  'with the link still recorded, so every later sync answers the same',
  afterSync?.openedForTaskId === card.id,
  JSON.stringify(afterSync),
);

// ── 9: a card on a board OTHER than Personal keeps its pull request through a sync ───
// The reported regression, one board over from check 8's: the reconciler's board index used
// to come from `getPersonalTasks()` alone, so a card filed on any other board carried an
// `openedForTaskId` that `knownTaskIds` had never heard of — indistinguishable, to
// `matchTaskId` in `githubPrSync.ts`, from a card that had been deleted. This board is a
// board-owning TICKET project (`planPath: ''`, a `ticketPrefix` of its own) — the shape
// `ticket:create` files a card on — and the index below is built the same way `ipc.ts` now
// builds it: `buildBoardIndex(store.getAllBoardTasks())`, not a hand-assembled stand-in.
const boardProject = store.addProject({
  name: 'Marketing site',
  path: '',
  planPath: '',
  ticketPrefix: 'MKT',
});
const boardBranch = 'feat/pricing-page';
git(repo, 'checkout', '-b', boardBranch);
writeFileSync(join(repo, 'pricing.ts'), 'export const pricing = true;\n');
git(repo, 'add', '-A');
git(repo, 'commit', '--no-verify', '-m', 'add the pricing page');
const boardHead = git(repo, 'rev-parse', 'HEAD').stdout.trim();

const boardCard = store.createTicket(boardProject.id, {
  title: 'Ship the pricing page',
  description: 'New self-serve pricing page.',
});
store.updateTask(boardCard.id, { agentProjectId: project.id, agentBranch: boardBranch });

const boardOpened = await openPullRequest(
  { ...deps, inspect: async () => ({ cwd: repo, branch: boardBranch, base }) },
  boardCard.id,
);
check(
  'a card on a non-Personal board can open a pull request too',
  boardOpened.existed === false,
  JSON.stringify(boardOpened),
);
const boardThere = git(bare, 'rev-parse', `refs/heads/${boardBranch}`);
check(
  'and its branch landed in the bare origin',
  boardThere.code === 0 && boardThere.stdout.trim() === boardHead,
  boardThere.stderr.trim() || boardThere.stdout.trim(),
);

// The same expression `ipc.ts` calls `buildBoardIndex` with — every board, unioned, not the
// Personal one alone.
const boardIndex = buildBoardIndex(store.getAllBoardTasks());
check(
  'the board index knows a card that lives off the Personal board',
  boardIndex.knownTaskIds.has(boardCard.id),
  `${boardIndex.knownTaskIds.size} known id(s), card is ${boardCard.id}`,
);

const boardNumber = Number(boardOpened.ref.replace('#', ''));
const boardStored = store.listMergeRequests().filter((r) => r.provider === 'github');
// What the sync actually does: the same search row GitHub would return for this open PR.
const boardListed = {
  repoId: 555,
  number: boardNumber,
  projectPath: 'acme/checkout',
  title: 'Ship the pricing page',
  description: 'New self-serve pricing page.',
  webUrl: `https://github.com/acme/checkout/pull/${boardNumber}`,
  sourceBranch: boardBranch,
  targetBranch: base,
  state: 'opened',
  draft: false,
  pipelineStatus: 'unknown',
  pipelineStages: [],
  pipelineUrl: null,
  approvalsRequired: null,
  approvalsGiven: 0,
  changesRequested: false,
  detailedMergeStatus: null,
  hasConflicts: false,
  updatedAt: 1_760_000_050_000,
};
// `listed` (check 8's own open PR) rides along too: a real sync's fetch returns every open
// pull request the forge has, not just the one this scenario is interested in, and leaving
// it out would make the ORIGINAL card's row look, to the reconciler, like one GitHub had
// stopped reporting — deleted out from under check 8 by a scenario that never touched it.
const boardSync = reconcilePullRequests(boardStored, [listed, boardListed], {
  ...boardIndex,
  identity: null,
  now: 1_760_000_100_000,
});
for (const mr of boardSync.upserts) store.upsertMergeRequest(mr);
store.deleteMergeRequests(boardSync.deleteIds);

const afterBoardSync = store.listMergeRequests().find((r) => r.id === `gh-555-${boardNumber}`);
check(
  'the sync leaves the board card linked instead of orphaning it',
  afterBoardSync?.taskId === boardCard.id,
  `taskId is ${String(afterBoardSync?.taskId)}, card is ${boardCard.id}`,
);

// ── 11: the branch is rebased onto base AS THE REMOTE HAS IT, before it is pushed ────
// A repo and bare origin of its OWN, so advancing this origin's copy of base cannot alter
// anything the checks above already proved — those never push base itself to `bare`, but
// there is no reason to tempt that.
const resyncRepo = join(work, 'resync-repo');
const resyncOrigin = join(work, 'resync-origin.git');
git(work, 'init', resyncRepo);
git(resyncRepo, 'config', 'user.email', 'verify@example.com');
git(resyncRepo, 'config', 'user.name', 'Verify');
git(resyncRepo, 'config', 'commit.gpgsign', 'false');
writeFileSync(join(resyncRepo, 'README.md'), '# resync\n');
git(resyncRepo, 'add', '-A');
git(resyncRepo, 'commit', '--no-verify', '-m', 'initial');
const resyncBase = git(resyncRepo, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
git(work, 'init', '--bare', resyncOrigin);
// Seed the bare origin with that same initial commit — directly by path, no app code
// involved yet — so the branch built below and the remote's own push share an ancestor.
git(resyncRepo, 'push', resyncOrigin, resyncBase);

// The card's own branch and work, built on top of that shared ancestor.
const RESYNC_BRANCH = 'feat/resync-me';
git(resyncRepo, 'checkout', '-b', RESYNC_BRANCH);
writeFileSync(join(resyncRepo, 'mine.ts'), 'export const mine = true;\n');
git(resyncRepo, 'add', '-A');
git(resyncRepo, 'commit', '--no-verify', '-m', 'add my own file');

// Someone else pushes straight to the bare origin while this branch sits untouched — base
// moving on the remote without this process ever fetching it.
const resyncClone = join(work, 'resync-clone');
git(work, 'clone', resyncOrigin, resyncClone);
git(resyncClone, 'config', 'user.email', 'verify@example.com');
git(resyncClone, 'config', 'user.name', 'Verify');
git(resyncClone, 'config', 'commit.gpgsign', 'false');
writeFileSync(join(resyncClone, 'from-elsewhere.txt'), 'pushed directly\n');
git(resyncClone, 'add', '-A');
git(resyncClone, 'commit', '--no-verify', '-m', 'pushed directly to origin');
git(resyncClone, 'push', 'origin', `HEAD:${resyncBase}`);
const resyncRemoteHead = git(resyncClone, 'rev-parse', 'HEAD').stdout.trim();

// Point this repo's own "origin" at a fake https URL and redirect it to the bare repo — the
// same trick the main scenario's `REMOTE`/`bare` pair uses, so the app's tokenized fetch and
// push both land here instead of at the real github.com.
git(resyncRepo, 'remote', 'add', 'origin', 'https://github.com/acme/resync.git');
writeFileSync(
  gitConfig,
  readFileSync(gitConfig, 'utf8') +
    `[url "file://${resyncOrigin.replace(/\\/g, '/')}"]\n` +
    `\tinsteadOf = https://x-access-token:${TOKEN}@github.com/acme/resync.git\n`,
  'utf8',
);

const resyncProject = store.addProject({
  path: resyncRepo,
  name: 'Resync',
  kind: 'agent',
  baseBranch: resyncBase,
});
const resyncCard = store.createTask('personal', { title: 'Do my own thing' });
store.updateTask(resyncCard.id, {
  agentProjectId: resyncProject.id,
  agentBranch: RESYNC_BRANCH,
});

const resyncOpened = await openPullRequest(
  {
    ...deps,
    inspect: async () => ({ cwd: resyncRepo, branch: RESYNC_BRANCH, base: resyncBase }),
  },
  resyncCard.id,
);
check(
  'a pull request opens even though base moved on the remote underneath it',
  resyncOpened.existed === false,
  JSON.stringify(resyncOpened),
);

// The branch landed on the far side already rebased onto the remote's new tip: it carries
// BOTH the commit pushed "by someone else" and its own.
const resyncLanded = git(resyncOrigin, 'rev-parse', `refs/heads/${RESYNC_BRANCH}`);
check(
  'the pushed branch lands in the bare origin',
  resyncLanded.code === 0,
  resyncLanded.stderr.trim() || resyncLanded.stdout.trim(),
);
const resyncHead = resyncLanded.stdout.trim();
check(
  'carrying the commit that was pushed directly to the remote',
  git(resyncOrigin, 'cat-file', '-e', `${resyncHead}:from-elsewhere.txt`).code === 0,
);
check(
  'and its own work, rebased on top of it',
  git(resyncOrigin, 'cat-file', '-e', `${resyncHead}:mine.ts`).code === 0,
);

// The local base ref was fast-forwarded to match what the remote had — `resyncRepo` is
// checked out on `RESYNC_BRANCH`, not `resyncBase`, so this exercises the bare ref-move half
// of `updateLocalBase` (the merge half is `worktreeManager.test.ts`'s own job).
check(
  'the local base ref was fast-forwarded to match what the remote had',
  git(resyncRepo, 'rev-parse', resyncBase).stdout.trim() === resyncRemoteHead,
);

// ── 12: a SECOND rebase of an already-open pull request pushes with a LEASE ──────────
// Check 11's push above was the branch's first ever — nothing existed on `resyncOrigin` under
// its name, so an ordinary push would have succeeded too. The lease only earns its keep once
// the branch has ALREADY been pushed once (there is an open pull request for it) and base
// moves on the remote a second time: the rebase rewrites the branch's commits again, so the
// remote's own copy — still sitting at what check 11 pushed — is no longer an ancestor of
// what is about to be pushed, and a plain push is rejected as non-fast-forward.
git(resyncClone, 'pull', '--ff-only');
writeFileSync(join(resyncClone, 'from-elsewhere-2.txt'), 'pushed directly, again\n');
git(resyncClone, 'add', '-A');
git(resyncClone, 'commit', '--no-verify', '-m', 'pushed directly to origin, again');
git(resyncClone, 'push', 'origin', resyncBase);
rmSync(resyncClone, { recursive: true, force: true });

const resyncOpenedAgain = await openPullRequest(
  {
    ...deps,
    inspect: async () => ({ cwd: resyncRepo, branch: RESYNC_BRANCH, base: resyncBase }),
  },
  resyncCard.id,
);
check(
  'the already-open pull request is reported again, not opened twice',
  resyncOpenedAgain.existed === true && resyncOpenedAgain.url === resyncOpened.url,
  JSON.stringify(resyncOpenedAgain),
);
const resyncLandedAgain = git(resyncOrigin, 'rev-parse', `refs/heads/${RESYNC_BRANCH}`);
check(
  'the leased push succeeds even though the branch was rewritten a second time',
  resyncLandedAgain.code === 0 && resyncLandedAgain.stdout.trim() !== resyncHead,
  resyncLandedAgain.stderr.trim() || resyncLandedAgain.stdout.trim(),
);
check(
  'carrying every commit pushed directly to the remote, both rounds',
  git(resyncOrigin, 'cat-file', '-e', `${resyncLandedAgain.stdout.trim()}:from-elsewhere.txt`)
    .code === 0 &&
    git(resyncOrigin, 'cat-file', '-e', `${resyncLandedAgain.stdout.trim()}:from-elsewhere-2.txt`)
      .code === 0,
);

// ── 13: work already on origin refuses, and POSTs nothing ───────────────────────────
// The shape a card's pull request takes once its own work has already landed on `base` —
// merged on the forge, or by hand — while this worktree's own copy of base is still the
// stale one it had the last time it looked. The EARLIER "nothing to open a pull request for"
// check only ever compares against that stale copy; this is the first point a freshly
// fetched base can be trusted, and it has to refuse the same way, just a step later.
const refuseRepo = join(work, 'refuse-repo');
const refuseOrigin = join(work, 'refuse-origin.git');
git(work, 'init', refuseRepo);
git(refuseRepo, 'config', 'user.email', 'verify@example.com');
git(refuseRepo, 'config', 'user.name', 'Verify');
git(refuseRepo, 'config', 'commit.gpgsign', 'false');
writeFileSync(join(refuseRepo, 'README.md'), '# refuse\n');
git(refuseRepo, 'add', '-A');
git(refuseRepo, 'commit', '--no-verify', '-m', 'initial');
const refuseBase = git(refuseRepo, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
git(work, 'init', '--bare', refuseOrigin);
git(refuseRepo, 'push', refuseOrigin, refuseBase);

const REFUSE_BRANCH = 'feat/already-merged';
git(refuseRepo, 'checkout', '-b', REFUSE_BRANCH);
writeFileSync(join(refuseRepo, 'mine.ts'), 'export const mine = true;\n');
git(refuseRepo, 'add', '-A');
git(refuseRepo, 'commit', '--no-verify', '-m', 'the work');
// Pushed once, as if a pull request had been opened for it before —
git(refuseRepo, 'push', refuseOrigin, REFUSE_BRANCH);

// — then merged straight into base on the far side, through a throwaway clone so `refuseRepo`
// itself never learns about it: its own `refuseBase` stays exactly where it started.
const refuseMergeClone = join(work, 'refuse-merge-clone');
git(work, 'clone', refuseOrigin, refuseMergeClone);
git(refuseMergeClone, 'config', 'user.email', 'verify@example.com');
git(refuseMergeClone, 'config', 'user.name', 'Verify');
git(refuseMergeClone, 'config', 'commit.gpgsign', 'false');
git(refuseMergeClone, 'checkout', refuseBase);
git(refuseMergeClone, 'merge', '--ff-only', `origin/${REFUSE_BRANCH}`);
git(refuseMergeClone, 'push', 'origin', refuseBase);
rmSync(refuseMergeClone, { recursive: true, force: true });

git(refuseRepo, 'remote', 'add', 'origin', 'https://github.com/acme/refuse.git');
writeFileSync(
  gitConfig,
  readFileSync(gitConfig, 'utf8') +
    `[url "file://${refuseOrigin.replace(/\\/g, '/')}"]\n` +
    `\tinsteadOf = https://x-access-token:${TOKEN}@github.com/acme/refuse.git\n`,
  'utf8',
);
const refuseProject = store.addProject({
  path: refuseRepo,
  name: 'Refuse',
  kind: 'agent',
  baseBranch: refuseBase,
});
const refuseCard = store.createTask('personal', { title: 'Work that is already upstream' });
store.updateTask(refuseCard.id, { agentProjectId: refuseProject.id, agentBranch: REFUSE_BRANCH });

const postsBeforeRefuse = calls.filter((c) => (c.init.method ?? 'GET') === 'POST').length;
const refusedAlreadyLanded = await openPullRequest(
  { ...deps, inspect: async () => ({ cwd: refuseRepo, branch: REFUSE_BRANCH, base: refuseBase }) },
  refuseCard.id,
).then(
  () => null,
  (e) => String(e?.message ?? e),
);
check(
  'a branch whose work is already on the remote base refuses, naming it',
  Boolean(refusedAlreadyLanded && /already have/i.test(refusedAlreadyLanded)),
  refusedAlreadyLanded ?? '(it did not refuse)',
);
check(
  'and nothing was POSTed for it',
  calls.filter((c) => (c.init.method ?? 'GET') === 'POST').length === postsBeforeRefuse,
  `${calls.filter((c) => (c.init.method ?? 'GET') === 'POST').length} POST(s), was ${postsBeforeRefuse}`,
);

// ── 14: a conflict with the remote refuses naming the file, pushes nothing, and leaves the
//        branch untouched (no paused rebase left behind) ────────────────────────────────
const conflictRepo = join(work, 'conflict-repo');
const conflictOrigin = join(work, 'conflict-origin.git');
git(work, 'init', conflictRepo);
git(conflictRepo, 'config', 'user.email', 'verify@example.com');
git(conflictRepo, 'config', 'user.name', 'Verify');
git(conflictRepo, 'config', 'commit.gpgsign', 'false');
writeFileSync(join(conflictRepo, 'shared.txt'), 'original\n');
git(conflictRepo, 'add', '-A');
git(conflictRepo, 'commit', '--no-verify', '-m', 'initial');
const conflictBase = git(conflictRepo, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
git(work, 'init', '--bare', conflictOrigin);
git(conflictRepo, 'push', conflictOrigin, conflictBase);

const CONFLICT_BRANCH = 'feat/conflicts-with-remote';
git(conflictRepo, 'checkout', '-b', CONFLICT_BRANCH);
writeFileSync(join(conflictRepo, 'shared.txt'), 'BRANCH-EDIT\n');
git(conflictRepo, 'commit', '--no-verify', '-am', 'branch edits shared.txt');

// Someone else edits the SAME line on the remote, directly.
const conflictClone = join(work, 'conflict-clone');
git(work, 'clone', conflictOrigin, conflictClone);
git(conflictClone, 'config', 'user.email', 'verify@example.com');
git(conflictClone, 'config', 'user.name', 'Verify');
git(conflictClone, 'config', 'commit.gpgsign', 'false');
writeFileSync(join(conflictClone, 'shared.txt'), 'REMOTE-EDIT\n');
git(conflictClone, 'commit', '--no-verify', '-am', 'remote edits shared.txt');
git(conflictClone, 'push', 'origin', conflictBase);
rmSync(conflictClone, { recursive: true, force: true });

git(conflictRepo, 'remote', 'add', 'origin', 'https://github.com/acme/conflict.git');
writeFileSync(
  gitConfig,
  readFileSync(gitConfig, 'utf8') +
    `[url "file://${conflictOrigin.replace(/\\/g, '/')}"]\n` +
    `\tinsteadOf = https://x-access-token:${TOKEN}@github.com/acme/conflict.git\n`,
  'utf8',
);
const conflictProject = store.addProject({
  path: conflictRepo,
  name: 'Conflict',
  kind: 'agent',
  baseBranch: conflictBase,
});
const conflictCard = store.createTask('personal', { title: 'Work that conflicts upstream' });
store.updateTask(conflictCard.id, {
  agentProjectId: conflictProject.id,
  agentBranch: CONFLICT_BRANCH,
});

const postsBeforeConflict = calls.filter((c) => (c.init.method ?? 'GET') === 'POST').length;
const conflictRefusal = await openPullRequest(
  {
    ...deps,
    inspect: async () => ({ cwd: conflictRepo, branch: CONFLICT_BRANCH, base: conflictBase }),
  },
  conflictCard.id,
).then(
  () => null,
  (e) => String(e?.message ?? e),
);
check(
  'a conflict with the remote refuses, naming the file',
  Boolean(conflictRefusal && /conflicts on.*shared\.txt/i.test(conflictRefusal)),
  conflictRefusal ?? '(it did not refuse)',
);
check(
  'nothing was pushed to the bare origin',
  git(conflictOrigin, 'rev-parse', '--verify', '--quiet', `refs/heads/${CONFLICT_BRANCH}`).code !==
    0,
);
check(
  'and nothing was POSTed for it either',
  calls.filter((c) => (c.init.method ?? 'GET') === 'POST').length === postsBeforeConflict,
  `${calls.filter((c) => (c.init.method ?? 'GET') === 'POST').length} POST(s), was ${postsBeforeConflict}`,
);
check(
  'the branch itself is untouched — checked out, no rebase left paused mid-conflict',
  git(conflictRepo, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim() === CONFLICT_BRANCH,
);
check(
  'and its work tree is clean, no conflict markers left behind',
  git(conflictRepo, 'diff', '--quiet').code === 0,
);

// ── 15: a LOCAL base that has already diverged from origin still opens a clean PR ───
// The live bug this step fixes: `base` itself carries a commit origin never saw (a local
// merge, say) while origin ALSO moved — the shape `docs/plan/README.md`'s "each new task
// fails to create a PR" entry proved against the real repo (16 ahead, 13 behind). The old
// `syncOntoRemoteBase` tried to fast-forward local base to origin FIRST and refused outright
// the moment that failed, never reaching the branch's own rebase at all.
const divergedRepo = join(work, 'diverged-repo');
const divergedOrigin = join(work, 'diverged-origin.git');
git(work, 'init', divergedRepo);
git(divergedRepo, 'config', 'user.email', 'verify@example.com');
git(divergedRepo, 'config', 'user.name', 'Verify');
git(divergedRepo, 'config', 'commit.gpgsign', 'false');
writeFileSync(join(divergedRepo, 'README.md'), '# diverged\n');
git(divergedRepo, 'add', '-A');
git(divergedRepo, 'commit', '--no-verify', '-m', 'initial');
const divergedBase = git(divergedRepo, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
git(work, 'init', '--bare', divergedOrigin);
git(divergedRepo, 'push', divergedOrigin, divergedBase);

// Local base gains a commit of its own that is never pushed — the local-merge half of the
// real bug.
writeFileSync(join(divergedRepo, 'local-only.txt'), 'local-only\n');
git(divergedRepo, 'add', '-A');
git(divergedRepo, 'commit', '--no-verify', '-m', "local base's own commit, never pushed");
const divergedLocalBase = git(divergedRepo, 'rev-parse', divergedBase).stdout.trim();

// The card's own branch, cut from that same local base.
const DIVERGED_BRANCH = 'feat/diverged-base';
git(divergedRepo, 'checkout', '-b', DIVERGED_BRANCH);
writeFileSync(join(divergedRepo, 'mine.ts'), 'export const mine = true;\n');
git(divergedRepo, 'add', '-A');
git(divergedRepo, 'commit', '--no-verify', '-m', 'add my own file');

// Origin moves too, straight past the fork point, through a clone that never sees the
// branch or the local-only commit.
const divergedClone = join(work, 'diverged-clone');
git(work, 'clone', divergedOrigin, divergedClone);
git(divergedClone, 'config', 'user.email', 'verify@example.com');
git(divergedClone, 'config', 'user.name', 'Verify');
git(divergedClone, 'config', 'commit.gpgsign', 'false');
writeFileSync(join(divergedClone, 'from-elsewhere.txt'), 'pushed directly\n');
git(divergedClone, 'add', '-A');
git(divergedClone, 'commit', '--no-verify', '-m', 'pushed directly to origin');
git(divergedClone, 'push', 'origin', `HEAD:${divergedBase}`);
rmSync(divergedClone, { recursive: true, force: true });

git(divergedRepo, 'remote', 'add', 'origin', 'https://github.com/acme/diverged.git');
writeFileSync(
  gitConfig,
  readFileSync(gitConfig, 'utf8') +
    `[url "file://${divergedOrigin.replace(/\\/g, '/')}"]\n` +
    `\tinsteadOf = https://x-access-token:${TOKEN}@github.com/acme/diverged.git\n`,
  'utf8',
);
const divergedProject = store.addProject({
  path: divergedRepo,
  name: 'Diverged',
  kind: 'agent',
  baseBranch: divergedBase,
});
const divergedCard = store.createTask('personal', { title: 'Work on a base that has diverged' });
store.updateTask(divergedCard.id, {
  agentProjectId: divergedProject.id,
  agentBranch: DIVERGED_BRANCH,
});

const postsBeforeDiverged = calls.filter((c) => (c.init.method ?? 'GET') === 'POST').length;
const divergedOpened = await openPullRequest(
  {
    ...deps,
    inspect: async () => ({ cwd: divergedRepo, branch: DIVERGED_BRANCH, base: divergedBase }),
  },
  divergedCard.id,
);
check(
  'a pull request opens even though LOCAL base has already diverged from origin',
  divergedOpened.existed === false,
  JSON.stringify(divergedOpened),
);
check(
  'exactly one POST, not a refusal',
  calls.filter((c) => (c.init.method ?? 'GET') === 'POST').length === postsBeforeDiverged + 1,
);

const divergedPost = calls.findLast((c) => (c.init.method ?? 'GET') === 'POST');
const divergedSent = JSON.parse(String(divergedPost?.init.body ?? '{}'));
check(
  "its body lists only the card's own commit",
  String(divergedSent.body).includes('add my own file') &&
    !String(divergedSent.body).includes("local base's own commit"),
  String(divergedSent.body),
);

const divergedLanded = git(divergedOrigin, 'rev-parse', `refs/heads/${DIVERGED_BRANCH}`);
check(
  'the branch landed carrying the remote commit and its own, never the local-only one',
  divergedLanded.code === 0 &&
    git(divergedOrigin, 'cat-file', '-e', `${divergedLanded.stdout.trim()}:from-elsewhere.txt`)
      .code === 0 &&
    git(divergedOrigin, 'cat-file', '-e', `${divergedLanded.stdout.trim()}:mine.ts`).code === 0 &&
    git(divergedOrigin, 'cat-file', '-e', `${divergedLanded.stdout.trim()}:local-only.txt`).code !==
      0,
  divergedLanded.stderr.trim() || divergedLanded.stdout.trim(),
);
check(
  'local base was left exactly where it was — it can never be fast-forwarded to origin again',
  git(divergedRepo, 'rev-parse', divergedBase).stdout.trim() === divergedLocalBase,
);

// ── 16 & 17: a run's own leftover edits — committed by the scheduler's flag, refused by the
//            button's absence of it — on the IDENTICAL worktree, one call after the other ──
// A branch that sits exactly on base (no commits of its own) with one file left uncommitted —
// the shape F7.2's own run finished in. 17 runs first, against the dirty worktree exactly as
// the run left it; 16 reuses the very same leftover file a moment later, so the commit it
// proves is the one the refusal just above named.
const leftoverRepo = join(work, 'leftover-repo');
const leftoverOrigin = join(work, 'leftover-origin.git');
git(work, 'init', leftoverRepo);
git(leftoverRepo, 'config', 'user.email', 'verify@example.com');
git(leftoverRepo, 'config', 'user.name', 'Verify');
git(leftoverRepo, 'config', 'commit.gpgsign', 'false');
writeFileSync(join(leftoverRepo, 'README.md'), '# leftover\n');
git(leftoverRepo, 'add', '-A');
git(leftoverRepo, 'commit', '--no-verify', '-m', 'initial');
const leftoverBase = git(leftoverRepo, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
git(work, 'init', '--bare', leftoverOrigin);
git(leftoverRepo, 'push', leftoverOrigin, leftoverBase);

const LEFTOVER_BRANCH = 'feat/leftover-work';
git(leftoverRepo, 'checkout', '-b', LEFTOVER_BRANCH);
// No commit of its own — the branch is still exactly at base. The only sign any work happened
// is this file, sitting untracked in the worktree.
writeFileSync(join(leftoverRepo, 'leftover.ts'), 'export const leftover = true;\n');

git(leftoverRepo, 'remote', 'add', 'origin', 'https://github.com/acme/leftover.git');
writeFileSync(
  gitConfig,
  readFileSync(gitConfig, 'utf8') +
    `[url "file://${leftoverOrigin.replace(/\\/g, '/')}"]\n` +
    `\tinsteadOf = https://x-access-token:${TOKEN}@github.com/acme/leftover.git\n`,
  'utf8',
);
const leftoverProject = store.addProject({
  path: leftoverRepo,
  name: 'Leftover',
  kind: 'agent',
  baseBranch: leftoverBase,
});
const leftoverCard = store.createTask('personal', { title: 'Leave the leftover work uncommitted' });
store.updateTask(leftoverCard.id, {
  agentProjectId: leftoverProject.id,
  agentBranch: LEFTOVER_BRANCH,
});
const leftoverInspect = async () => ({
  cwd: leftoverRepo,
  branch: LEFTOVER_BRANCH,
  base: leftoverBase,
});

// ── 17: without the flag, the button refuses by naming the leftover file ────────────────
const headBeforeRefusal = git(leftoverRepo, 'rev-parse', 'HEAD').stdout.trim();
const postsBeforeLeftover = calls.filter((c) => (c.init.method ?? 'GET') === 'POST').length;

const leftoverRefusal = await openPullRequest(
  { ...deps, inspect: leftoverInspect },
  leftoverCard.id,
).then(
  () => null,
  (e) => String(e?.message ?? e),
);
check(
  'without commitLeftover, leftover work refuses, naming the uncommitted file',
  Boolean(
    leftoverRefusal &&
    /uncommitted changes/.test(leftoverRefusal) &&
    leftoverRefusal.includes('leftover.ts'),
  ),
  leftoverRefusal ?? '(it did not refuse)',
);
check(
  'and the worktree is left exactly as it was — no commit, the file still sitting untracked',
  git(leftoverRepo, 'rev-parse', 'HEAD').stdout.trim() === headBeforeRefusal &&
    git(leftoverRepo, 'status', '--porcelain').stdout.includes('leftover.ts'),
  `HEAD ${git(leftoverRepo, 'rev-parse', 'HEAD').stdout.trim()} (was ${headBeforeRefusal}); ` +
    `status: ${git(leftoverRepo, 'status', '--porcelain').stdout.trim()}`,
);
check(
  'nothing was pushed or posted for it',
  git(leftoverOrigin, 'rev-parse', '--verify', '--quiet', `refs/heads/${LEFTOVER_BRANCH}`).code !==
    0 && calls.filter((c) => (c.init.method ?? 'GET') === 'POST').length === postsBeforeLeftover,
);

// ── 16: WITH the flag, the same leftover file is committed, pushed and opens the PR ─────
const leftoverOpened = await openPullRequest(
  { ...deps, inspect: leftoverInspect },
  leftoverCard.id,
  { commitLeftover: true },
);
check(
  'with commitLeftover, the same leftover work opens a pull request',
  leftoverOpened.existed === false,
  JSON.stringify(leftoverOpened),
);
const leftoverLanded = git(leftoverOrigin, 'rev-parse', `refs/heads/${LEFTOVER_BRANCH}`);
check(
  'carrying a commit for the leftover file, pushed to the bare origin',
  leftoverLanded.code === 0 &&
    git(leftoverOrigin, 'cat-file', '-e', `${leftoverLanded.stdout.trim()}:leftover.ts`).code === 0,
  leftoverLanded.stderr.trim() || leftoverLanded.stdout.trim(),
);
check(
  'and the timeline note says the leftover work was committed before the pull request opened',
  notes.some((n) => n.includes('Committed uncommitted work') && n.includes(LEFTOVER_BRANCH)),
  notes.join(' | '),
);
check(
  'and the worktree is clean afterwards — nothing left dangling',
  git(leftoverRepo, 'status', '--porcelain').stdout.trim() === '',
);

store.close();

// ── 10: a database written BEFORE the column upgrades into it ────────────────────────
// Everything above ran against a table the DDL created complete, which is the one shape no
// existing user has: every installed copy has a `merge_requests` table from before this. The
// guarded ALTER is what carries them over, and a broken one does not degrade — the very next
// upsert throws, on a channel a human pressed a button to reach.
//
// Dropped and re-opened rather than mocked: `createStore` runs its migrations on open, so
// taking the column away and asking for the store again exercises the real path.
const dbPath = join(work, 'orchestrator.db');
const raw = new (require('better-sqlite3'))(dbPath);
raw.exec(`ALTER TABLE merge_requests DROP COLUMN openedForTaskId`);
const gone = raw
  .prepare(`PRAGMA table_info(merge_requests)`)
  .all()
  .some((c) => c.name === 'openedForTaskId');
raw.close();
check('the column can be taken away, so the migration has something to do', !gone);

// Caught rather than allowed to throw: without the migration, `createStore` dies while
// PREPARING the upsert — `no such column: openedForTaskId` — and a stack trace out of a
// verification script says far less than the sentence naming what it was doing.
let upgraded = null;
let openError = null;
try {
  upgraded = createStore(dbPath);
} catch (e) {
  openError = String(e?.message ?? e);
}
check('opening an older database does not fall over', upgraded !== null, openError ?? undefined);
if (upgraded) {
  const row9 = upgraded.listMergeRequests().find((r) => r.id === 'gh-555-12');
  check(
    'the migration adds the column back, empty',
    row9 !== undefined && row9.openedForTaskId === null,
    JSON.stringify(row9 ?? null),
  );
  // And it is writable afterwards — an ALTER that ran but left the INSERT naming a column
  // that is not there would only be found here.
  upgraded.upsertMergeRequest({ ...row9, openedForTaskId: card.id });
  check(
    'and the row can be written and read back through it',
    upgraded.listMergeRequests().find((r) => r.id === 'gh-555-12')?.openedForTaskId === card.id,
    JSON.stringify(upgraded.listMergeRequests().find((r) => r.id === 'gh-555-12') ?? null),
  );
  upgraded.close();
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
