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
 *  2. It POSTs to `/repos/{owner}/{repo}/pulls` carrying the card's title, base and body.
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
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
        ...(external ? [`--external:${external}`] : []),
        `--outfile=${outfile}`,
        '--log-level=error',
      ],
      { stdio: 'inherit' },
    );

  // Neither of these imports Electron — `createPr.ts` reaches git, the exec hosts and
  // `fetch`, and `store.ts` reaches only node:*, better-sqlite3 and @shared/*. That is what
  // lets both be pulled out of the app and run on their own like this.
  bundle(join(root, 'apps/client/src/main/forge/createPr.ts'), join(scratch, 'createPr.cjs'));
  bundle(join(root, 'apps/client/src/main/store.ts'), join(scratch, 'store.cjs'), 'better-sqlite3');

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
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init: init ?? {} });
  const sent = JSON.parse(String(init?.body ?? '{}'));
  const body = {
    id: 900,
    number: 12,
    title: sent.title,
    state: 'open',
    draft: false,
    html_url: 'https://github.com/acme/checkout/pull/12',
    head: { ref: BRANCH, repo: { id: 555 } },
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

const notes = [];
const deps = {
  getTask: (id) => store.getTask(id),
  getProject: (id) => store.getProject(id),
  getSettings: () => store.getSettings(),
  listMergeRequests: () => store.listMergeRequests(),
  upsertMergeRequest: (mr) => store.upsertMergeRequest(mr),
  // Standing in for `WorktreeManager.inspect`, the one dependency this scenario has no use
  // for: it exists to READ a branch/base pair off disk, and here they are already known.
  inspect: async () => ({ cwd: repo, branch: BRANCH, base }),
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
  'with the card title and its base branch',
  sent.title === 'Fix the export dialog' && sent.base === base,
  JSON.stringify(sent),
);
check(
  'and the card description as the body',
  String(sent.body).includes('forgets the last folder'),
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

store.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
