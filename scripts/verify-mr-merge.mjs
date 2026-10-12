/**
 * Headless proof of the `mr:merge` IPC handler's own decision logic
 * (`apps/client/src/main/ipc.ts`) — the half nothing else exercises.
 *
 *     node scripts/verify-mr-merge.mjs
 *
 * ## Why this is a script and not a test
 *
 * `ipc.ts` registers its handlers straight onto Electron's own `ipcMain`/`BrowserWindow`,
 * and says so itself at the top of the file: "There is no test harness for this file, and
 * that is the design" — a decision worth testing is meant to move OUT into a pure module
 * with its own `.test.ts`, not grow a harness here. `mrReadyToMerge` has exactly that kind
 * of suite (`packages/shared/src/mergeRequest.test.ts`), and so do
 * `GitLabClient.mergeMergeRequest`/`GitHubClient.mergePullRequest`
 * (`gitlabClient.test.ts`/`githubClient.test.ts`). None of those, alone, prove the SEAM
 * `mr:merge` itself owns: refuse before ever touching the network when `mrReadyToMerge`
 * says no, and otherwise hand the real client the real head SHA. This script reconstructs
 * that seam verbatim (mirroring `ipc.ts`'s own `handle('mr:merge', ...)` body) against the
 * REAL `GitLabClient`/`GitHubClient` and the REAL `mrReadyToMerge`, with only `fetch` faked
 * — the same stub-fetch approach `verify-pr-watch.mjs` uses for the forge-rebase action —
 * and then re-reads the merge request the way a post-merge sync would, through the real
 * `toMergeRequestState`/`toPullRequestState` and `mrIsSettled`.
 *
 * ## What it proves
 *
 *  1. GitLab, ready: the guard stands aside, GitLab's merge endpoint gets a real
 *     `PUT .../merge_requests/7/merge` carrying `{ sha }`, and a re-read against a
 *     `state: 'merged'` response says the merge request settled.
 *  2. GitLab, not ready (pipeline still running): refused before any `fetch` at all, with
 *     the exact message `ipc.ts` throws.
 *  3. GitHub, ready: a GET for the repo's merge-method toggles, then a real
 *     `PUT .../pulls/9/merge` carrying `{ sha, merge_method }`, and a re-read through
 *     `toPullRequestState` says it merged.
 *  4. GitHub, not ready (draft): refused before any `fetch`.
 *
 * ## Prove it can fail
 *
 * Comment out the `if (!mrReadyToMerge(mr)) throw ...` line in `mrMergeHandler` below (or
 * drop its `!`) and re-run: checks 2 and 4 go red, because the not-ready scenarios now reach
 * `fetch` and merge for real instead of refusing. Restore the guard afterwards — this file
 * does not run with it disabled.
 *
 * Exits non-zero naming every failed check.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sharedSrc = join(root, 'packages', 'shared', 'src');
const protocolSrc = join(root, 'packages', 'protocol', 'src');

function log(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * esbuild ships as a per-platform binary under a versioned `.pnpm` directory, so it is
 * found by pattern rather than by path — see `verify-pr-watch.mjs` for why hard-coding a
 * version would rot this at the next `pnpm up`.
 */
function findEsbuild() {
  const pnpm = join(root, 'node_modules', '.pnpm');
  const target = `${process.platform}-${process.arch}`;
  const dir = readdirSync(pnpm).find((d) => d.startsWith(`@esbuild+${target}@`));
  if (!dir) throw new Error(`no esbuild binary for ${target} under ${pnpm}`);
  const exe = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
  return join(pnpm, dir, 'node_modules', '@esbuild', target, exe);
}

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    log('  PASS  ' + label);
  } else {
    failures += 1;
    log('  FAIL  ' + label + (detail === undefined ? '' : ' — ' + detail));
  }
}
function section(name) {
  log('\n' + name);
}

const scratch = mkdtempSync(join(tmpdir(), 'tm-mr-merge-'));
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
        '--external:electron',
        `--outfile=${outfile}`,
        '--log-level=error',
      ],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) throw new Error(`esbuild failed on ${entry}`);
  };

  bundle(join(root, 'apps/client/src/main/gitlab/gitlabClient.ts'), join(scratch, 'gitlabClient.cjs'));
  bundle(join(root, 'apps/client/src/main/github/githubClient.ts'), join(scratch, 'githubClient.cjs'));
  bundle(join(root, 'packages/shared/src/mergeRequest.ts'), join(scratch, 'mergeRequest.cjs'));

  const require = createRequire(import.meta.url);
  const { GitLabClient, toMergeRequestState } = require(join(scratch, 'gitlabClient.cjs'));
  const { GitHubClient, toPullRequestState } = require(join(scratch, 'githubClient.cjs'));
  const { mrReadyToMerge, mrIsSettled } = require(join(scratch, 'mergeRequest.cjs'));

  /** Every `fetch` call so far, in order: `{ url, method, body }`. */
  const calls = [];
  /** FIFO of fixtures; each scenario queues exactly as many as it expects to consume. */
  let queue = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    return next;
  };
  const jsonResponse = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  });

  /**
   * Mirrors `ipc.ts`'s `handle('mr:merge', ...)` body verbatim (the store lookup aside —
   * there is no store here, only the merge request the caller already has in hand): refuse
   * anything `mrReadyToMerge` does not call ready before touching the network, otherwise
   * hand the real client the real head SHA.
   */
  async function mrMergeHandler(mr, clients) {
    if (!mrReadyToMerge(mr)) throw new Error('That merge request is not ready to merge.');
    if (mr.provider === 'gitlab') {
      return clients.gitlab.mergeMergeRequest(mr.repoId, mr.number, mr.headSha ?? undefined);
    }
    const [owner, repo] = mr.projectPath.split('/');
    if (!owner || !repo) throw new Error(`Malformed GitHub repository path: ${mr.projectPath}`);
    return clients.github.mergePullRequest(owner, repo, mr.number, mr.headSha ?? undefined);
  }

  const gitlab = new GitLabClient({ baseUrl: 'https://gitlab.example.com', token: 'stub-token' });
  const github = new GitHubClient({ baseUrl: 'https://api.github.com', token: 'stub-token' });
  const clients = { gitlab, github };

  /** A ready, green, approved, open GitLab merge request — `mrReadyToMerge` says yes. */
  const readyGitlabMr = {
    provider: 'gitlab',
    repoId: 42,
    number: 7,
    state: 'opened',
    draft: false,
    headSha: 'deadbeef',
    pipelineStatus: 'success',
    approvalsRequired: 1,
    approvalsGiven: 1,
    changesRequested: false,
    detailedMergeStatus: 'mergeable',
    hasConflicts: false,
  };

  // ===========================================================================
  section('1. GitLab, ready: PUT the real merge endpoint with the real sha, then re-sync');

  check('mrReadyToMerge agrees this one is ready before we even start', mrReadyToMerge(readyGitlabMr));

  queue = [jsonResponse({ id: 1, iid: 7, project_id: 42, state: 'merged', sha: 'deadbeef' })];
  await mrMergeHandler(readyGitlabMr, clients);

  check('exactly one fetch happened — the merge PUT, nothing more', calls.length === 1, calls.length);
  const gitlabMergeCall = calls[0];
  check(
    'it PUT the real GitLab merge endpoint',
    gitlabMergeCall.url === 'https://gitlab.example.com/api/v4/projects/42/merge_requests/7/merge' &&
      gitlabMergeCall.method === 'PUT',
    JSON.stringify(gitlabMergeCall),
  );
  check(
    'carrying the head sha, so GitLab refuses if the branch moved under us',
    JSON.stringify(gitlabMergeCall.body) === JSON.stringify({ sha: 'deadbeef' }),
    JSON.stringify(gitlabMergeCall.body),
  );

  // The re-sync a real `mr:merge` handler triggers next (`syncGitLab`) re-reads any MR that
  // dropped out of the `state=opened` list — see `ipc.ts`'s own comment on that read-back —
  // through the same `GitLabClient.getMergeRequest` and `toMergeRequestState` this re-creates.
  queue = [jsonResponse({ id: 1, iid: 7, project_id: 42, state: 'merged' })];
  const resynced = await gitlab.getMergeRequest(42, 7);
  const resyncedState = toMergeRequestState(resynced.state);
  check('the re-sync reads the merge request back as merged', resyncedState === 'merged', resyncedState);
  check('and mrIsSettled agrees it is done', mrIsSettled({ state: resyncedState }));

  // ===========================================================================
  section('2. GitLab, not ready: refused before any fetch, no PUT');

  const notReadyGitlabMr = { ...readyGitlabMr, number: 8, pipelineStatus: 'running' };
  check('mrReadyToMerge agrees this one is not ready', !mrReadyToMerge(notReadyGitlabMr));

  const callsBeforeRefusal = calls.length;
  queue = [];
  let refusalMessage = null;
  try {
    await mrMergeHandler(notReadyGitlabMr, clients);
  } catch (err) {
    refusalMessage = err instanceof Error ? err.message : String(err);
  }
  check(
    'it refused with the exact message ipc.ts throws',
    refusalMessage === 'That merge request is not ready to merge.',
    refusalMessage,
  );
  check('and no fetch was even attempted', calls.length === callsBeforeRefusal, calls.length - callsBeforeRefusal);

  // ===========================================================================
  section('3. GitHub, ready: read the merge-method toggles, PUT the merge, then re-sync');

  const readyGithubMr = {
    provider: 'github',
    projectPath: 'acme/web2',
    number: 9,
    state: 'opened',
    draft: false,
    headSha: 'cafef00d',
    pipelineStatus: 'success',
    approvalsRequired: 1,
    approvalsGiven: 1,
    changesRequested: false,
    detailedMergeStatus: 'clean',
    hasConflicts: false,
  };
  check('mrReadyToMerge agrees this one is ready too', mrReadyToMerge(readyGithubMr));

  const callsBeforeGithub = calls.length;
  queue = [
    jsonResponse({
      number: 9,
      state: 'open',
      base: { ref: 'main', repo: { id: 1, allow_merge_commit: true } },
    }),
    jsonResponse({ sha: 'cafef00d', merged: true }),
  ];
  await mrMergeHandler(readyGithubMr, clients);

  const githubCalls = calls.slice(callsBeforeGithub);
  check('exactly two fetches happened — the toggle read, then the merge PUT', githubCalls.length === 2, githubCalls.length);
  check(
    'the first read the pull request\'s own merge-method toggles',
    githubCalls[0].url === 'https://api.github.com/repos/acme/web2/pulls/9' &&
      githubCalls[0].method === 'GET',
    JSON.stringify(githubCalls[0]),
  );
  check(
    'and the second PUT the real GitHub merge endpoint',
    githubCalls[1].url === 'https://api.github.com/repos/acme/web2/pulls/9/merge' &&
      githubCalls[1].method === 'PUT',
    JSON.stringify(githubCalls[1]),
  );
  check(
    'carrying the head sha and the resolved merge method',
    JSON.stringify(githubCalls[1].body) === JSON.stringify({ sha: 'cafef00d', merge_method: 'merge' }),
    JSON.stringify(githubCalls[1].body),
  );

  queue = [jsonResponse({ number: 9, state: 'closed', merged: true, merged_at: '2026-10-12T00:00:00Z' })];
  const githubResynced = await github.getPullRequest('acme', 'web2', 9);
  const githubResyncedState = toPullRequestState(githubResynced);
  check('the re-sync reads the pull request back as merged', githubResyncedState === 'merged', githubResyncedState);
  check('and mrIsSettled agrees it is done', mrIsSettled({ state: githubResyncedState }));

  // ===========================================================================
  section('4. GitHub, not ready (draft): refused before any fetch, no PUT');

  const draftGithubMr = { ...readyGithubMr, number: 10, draft: true };
  check('mrReadyToMerge agrees a draft is not ready', !mrReadyToMerge(draftGithubMr));

  const callsBeforeDraftRefusal = calls.length;
  queue = [];
  let draftRefusalMessage = null;
  try {
    await mrMergeHandler(draftGithubMr, clients);
  } catch (err) {
    draftRefusalMessage = err instanceof Error ? err.message : String(err);
  }
  check(
    'it refused with the exact message ipc.ts throws',
    draftRefusalMessage === 'That merge request is not ready to merge.',
    draftRefusalMessage,
  );
  check(
    'and no fetch was even attempted',
    calls.length === callsBeforeDraftRefusal,
    calls.length - callsBeforeDraftRefusal,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
}

log('');
if (failures > 0) {
  log(`${failures} check(s) failed.`);
  process.exit(1);
}
log('All checks passed.');
