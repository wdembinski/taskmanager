/**
 * Headless proof of the `mr:merge`/`mr:mergeProposal` IPC handlers' own decision logic
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
 * `GitLabClient.mergeMergeRequest`/`GitHubClient.mergePullRequest`/`getMergeProposal`
 * (`gitlabClient.test.ts`/`githubClient.test.ts`). None of those, alone, prove the SEAM
 * `mr:merge`/`mr:mergeProposal` themselves own: refuse before ever touching the network when
 * `mrReadyToMerge` says no, hand the real client the real head SHA and the dialog's edited
 * message, and read the forge's own proposed message the same way the merge dialog does. This
 * script reconstructs those seams verbatim (mirroring `ipc.ts`'s own `handle('mr:merge', ...)`
 * and `handle('mr:mergeProposal', ...)` bodies) against the REAL `GitLabClient`/`GitHubClient`
 * and the REAL `mrReadyToMerge`, with only `fetch` faked — the same stub-fetch approach
 * `verify-pr-watch.mjs` uses for the forge-rebase action — and then re-reads the merge request
 * the way a post-merge sync would, through the real `toMergeRequestState`/`toPullRequestState`
 * and `mrIsSettled`.
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
 *  5. GitLab proposal: `mr:mergeProposal` POSTs the real `/api/graphql` endpoint and hands
 *     back GitLab's own stubbed default message, unedited.
 *  6. GitLab merge: an edited message reaches the PUT as `merge_commit_message`.
 *  7. GitLab merge: a blank (whitespace-only) message sends none — GitLab applies its own
 *     default, same as before this feature existed.
 *  8. GitHub proposal: a GET for the merge-method toggles, then a GraphQL POST, handing back
 *     GitHub's own stubbed headline (and skipping the body when GitHub proposed none).
 *  9. GitHub merge: an edited message is split across `commit_title`/`commit_message`.
 * 10. GitHub merge: a blank message sends neither field.
 * 11. GitHub, a repository whose toggles resolve to `rebase`: the proposal has no message to
 *     offer and makes no GraphQL call, and the merge PUT carries no message even when one is
 *     given — rebase replays commits and has no commit message of its own to set.
 * 12. GitLab, a GraphQL proposal that fails (a resolver error, a missing scope): the client
 *     itself still throws, but mirroring `ConfirmMergeDialog`'s own `.catch` into a blank
 *     message and merging afterwards sends none — the forge's own default, not a crash.
 * 13. GitHub, the same failing-proposal fallback.
 *
 * ## Prove it can fail
 *
 * Comment out the `if (!mrReadyToMerge(mr)) throw ...` line in `mrMergeHandler` below (or
 * drop its `!`) and re-run: checks 2 and 4 go red, because the not-ready scenarios now reach
 * `fetch` and merge for real instead of refusing. Restore the guard afterwards — this file
 * does not run with it disabled.
 *
 * To turn the new message checks (6, 7, 9, 10, 11, 12, 13) red instead, drop the
 * `const message = options?.message;` pass-through in `mrMergeHandler` (or stop forwarding it
 * into the client calls): every merge PUT then carries no message at all, regardless of what
 * was typed or what the proposal returned, and checks 6/9 (the edited message reaching the
 * PUT) go red first.
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
   * hand the real client the real head SHA and the dialog's (possibly edited, possibly
   * blank) message.
   */
  async function mrMergeHandler(mr, clients, options) {
    if (!mrReadyToMerge(mr)) throw new Error('That merge request is not ready to merge.');
    const message = options?.message;
    if (mr.provider === 'gitlab') {
      return clients.gitlab.mergeMergeRequest(mr.repoId, mr.number, mr.headSha ?? undefined, {
        message,
      });
    }
    const [owner, repo] = mr.projectPath.split('/');
    if (!owner || !repo) throw new Error(`Malformed GitHub repository path: ${mr.projectPath}`);
    return clients.github.mergePullRequest(owner, repo, mr.number, mr.headSha ?? undefined, message);
  }

  /**
   * Mirrors `ipc.ts`'s `handle('mr:mergeProposal', ...)` body verbatim: looked up the same
   * way `mr:merge` is, but never re-checks `mrReadyToMerge` — showing a proposal is not a
   * claim that merging is ready.
   */
  async function mrMergeProposalHandler(mr, clients) {
    if (mr.provider === 'gitlab') {
      return clients.gitlab.getMergeProposal(mr.projectPath, mr.number);
    }
    const [owner, repo] = mr.projectPath.split('/');
    if (!owner || !repo) throw new Error(`Malformed GitHub repository path: ${mr.projectPath}`);
    return clients.github.getMergeProposal(owner, repo, mr.number);
  }

  /**
   * Mirrors `ConfirmMergeDialog`'s own `useEffect` + `merge()`: ask for the proposal, and on
   * ANY rejection (a resolver error, a token missing the GraphQL scope, …) fall back to an
   * empty message exactly as its `.catch` does, rather than letting the rejection reach the
   * merge at all. Then merge with whatever is left — the proposal's message, unedited, or
   * blank when the load failed.
   */
  async function loadProposalThenMerge(mr, clients) {
    let message = '';
    try {
      const proposal = await mrMergeProposalHandler(mr, clients);
      message = proposal.message ?? '';
    } catch {
      message = '';
    }
    return mrMergeHandler(mr, clients, { message });
  }

  const gitlab = new GitLabClient({ baseUrl: 'https://gitlab.example.com', token: 'stub-token' });
  const github = new GitHubClient({ baseUrl: 'https://api.github.com', token: 'stub-token' });
  const clients = { gitlab, github };

  /** A ready, green, approved, open GitLab merge request — `mrReadyToMerge` says yes. */
  const readyGitlabMr = {
    provider: 'gitlab',
    repoId: 42,
    projectPath: 'acme-group/widgets',
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

  // ===========================================================================
  section('5. GitLab proposal: reads the stubbed GraphQL default');

  queue = [
    jsonResponse({
      data: {
        project: {
          mergeMethod: 'MERGE',
          mergeRequest: {
            defaultMergeCommitMessage: 'Merge branch into main\n\nSee merge request !7',
            defaultSquashCommitMessage: null,
            squashOnMerge: false,
          },
        },
      },
    }),
  ];
  const callsBeforeGitlabProposal = calls.length;
  const gitlabProposal = await mrMergeProposalHandler(readyGitlabMr, clients);
  check(
    'exactly one fetch happened — the GraphQL POST',
    calls.length - callsBeforeGitlabProposal === 1,
    calls.length - callsBeforeGitlabProposal,
  );
  const gitlabProposalCall = calls[calls.length - 1];
  check(
    'it POSTed /api/graphql, not /api/v4',
    gitlabProposalCall.url === 'https://gitlab.example.com/api/graphql' &&
      gitlabProposalCall.method === 'POST',
    JSON.stringify(gitlabProposalCall),
  );
  check(
    'and it is the stubbed default message, unedited',
    gitlabProposal.method === 'merge' &&
      gitlabProposal.message === 'Merge branch into main\n\nSee merge request !7',
    JSON.stringify(gitlabProposal),
  );

  // ===========================================================================
  section('6. GitLab merge: an edited message reaches the PUT as merge_commit_message');

  queue = [jsonResponse({ id: 1, iid: 7, project_id: 42, state: 'merged', sha: 'deadbeef' })];
  await mrMergeHandler(readyGitlabMr, clients, { message: 'Custom merge message\n\nWith a body.' });
  const editedGitlabCall = calls[calls.length - 1];
  check(
    'the PUT carries the edited message as merge_commit_message',
    JSON.stringify(editedGitlabCall.body) ===
      JSON.stringify({ sha: 'deadbeef', merge_commit_message: 'Custom merge message\n\nWith a body.' }),
    JSON.stringify(editedGitlabCall.body),
  );

  // ===========================================================================
  section('7. GitLab merge: a blank message sends none');

  queue = [jsonResponse({ id: 1, iid: 7, project_id: 42, state: 'merged', sha: 'deadbeef' })];
  await mrMergeHandler(readyGitlabMr, clients, { message: '   ' });
  const blankGitlabCall = calls[calls.length - 1];
  check(
    'the PUT carries only the sha — no merge_commit_message field at all',
    JSON.stringify(blankGitlabCall.body) === JSON.stringify({ sha: 'deadbeef' }),
    JSON.stringify(blankGitlabCall.body),
  );

  // ===========================================================================
  section('8. GitHub proposal: reads the stubbed GraphQL default');

  queue = [
    jsonResponse({
      number: 9,
      state: 'open',
      base: { ref: 'main', repo: { id: 1, allow_merge_commit: true } },
    }),
    jsonResponse({
      data: {
        repository: {
          pullRequest: {
            viewerMergeHeadlineText: 'Merge pull request #9 from acme/feature',
            viewerMergeBodyText: '',
          },
        },
      },
    }),
  ];
  const callsBeforeGithubProposal = calls.length;
  const githubProposal = await mrMergeProposalHandler(readyGithubMr, clients);
  const githubProposalCalls = calls.slice(callsBeforeGithubProposal);
  check(
    'exactly two fetches happened — the toggle read, then the GraphQL POST',
    githubProposalCalls.length === 2,
    githubProposalCalls.length,
  );
  check(
    'the second POSTed the GraphQL endpoint',
    githubProposalCalls[1].url === 'https://api.github.com/graphql' &&
      githubProposalCalls[1].method === 'POST',
    JSON.stringify(githubProposalCalls[1]),
  );
  check(
    'and it is the stubbed headline, with no body to append (blank body is falsy)',
    githubProposal.method === 'merge' &&
      githubProposal.message === 'Merge pull request #9 from acme/feature',
    JSON.stringify(githubProposal),
  );

  // ===========================================================================
  section('9. GitHub merge: an edited message reaches the PUT split across commit_title/commit_message');

  queue = [
    jsonResponse({
      number: 9,
      state: 'open',
      base: { ref: 'main', repo: { id: 1, allow_merge_commit: true } },
    }),
    jsonResponse({ sha: 'cafef00d', merged: true }),
  ];
  await mrMergeHandler(readyGithubMr, clients, { message: 'Custom title\n\nCustom body line.' });
  const editedGithubCall = calls[calls.length - 1];
  check(
    'the PUT splits the message into commit_title and commit_message',
    JSON.stringify(editedGithubCall.body) ===
      JSON.stringify({
        sha: 'cafef00d',
        merge_method: 'merge',
        commit_title: 'Custom title',
        commit_message: 'Custom body line.',
      }),
    JSON.stringify(editedGithubCall.body),
  );

  // ===========================================================================
  section('10. GitHub merge: a blank message sends neither field');

  queue = [
    jsonResponse({
      number: 9,
      state: 'open',
      base: { ref: 'main', repo: { id: 1, allow_merge_commit: true } },
    }),
    jsonResponse({ sha: 'cafef00d', merged: true }),
  ];
  await mrMergeHandler(readyGithubMr, clients, { message: '  ' });
  const blankGithubCall = calls[calls.length - 1];
  check(
    'the PUT carries only sha and merge_method — no commit_title/commit_message',
    JSON.stringify(blankGithubCall.body) === JSON.stringify({ sha: 'cafef00d', merge_method: 'merge' }),
    JSON.stringify(blankGithubCall.body),
  );

  // ===========================================================================
  section('11. GitHub, a rebase-only repository: no message proposed, none sent even if given');

  const rebaseOnlyGithubMr = { ...readyGithubMr, number: 11 };
  const rebaseRepoToggles = {
    number: 11,
    state: 'open',
    base: {
      ref: 'main',
      repo: { id: 2, allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: true },
    },
  };

  queue = [jsonResponse(rebaseRepoToggles)];
  const callsBeforeRebaseProposal = calls.length;
  const rebaseProposal = await mrMergeProposalHandler(rebaseOnlyGithubMr, clients);
  check(
    'the proposal made exactly one fetch — the toggle read, no GraphQL call',
    calls.length - callsBeforeRebaseProposal === 1,
    calls.length - callsBeforeRebaseProposal,
  );
  check(
    'and it resolved to rebase with no message to propose',
    rebaseProposal.method === 'rebase' && rebaseProposal.message === null,
    JSON.stringify(rebaseProposal),
  );

  queue = [jsonResponse(rebaseRepoToggles), jsonResponse({ sha: 'cafef00d', merged: true })];
  await mrMergeHandler(rebaseOnlyGithubMr, clients, { message: 'This should never appear' });
  const rebaseGithubCall = calls[calls.length - 1];
  check(
    'the merge PUT carries no commit_title/commit_message despite a message being given',
    JSON.stringify(rebaseGithubCall.body) === JSON.stringify({ sha: 'cafef00d', merge_method: 'rebase' }),
    JSON.stringify(rebaseGithubCall.body),
  );

  // ===========================================================================
  section(
    "12. GitLab, a failing GraphQL proposal: the dialog's own fallback merges with no message, not a throw",
  );

  queue = [jsonResponse({ errors: [{ message: "Field 'mergeRequest' doesn't exist on type 'Project'" }] })];
  let gitlabProposalThrew = false;
  try {
    await mrMergeProposalHandler(readyGitlabMr, clients);
  } catch {
    gitlabProposalThrew = true;
  }
  check(
    'the client itself still throws — the fallback lives in the dialog, not the client',
    gitlabProposalThrew,
  );

  queue = [
    jsonResponse({ errors: [{ message: "Field 'mergeRequest' doesn't exist on type 'Project'" }] }),
    jsonResponse({ id: 1, iid: 7, project_id: 42, state: 'merged', sha: 'deadbeef' }),
  ];
  await loadProposalThenMerge(readyGitlabMr, clients);
  const fallbackGitlabCall = calls[calls.length - 1];
  check(
    "merging after a failed load sends no message — the forge's own default",
    JSON.stringify(fallbackGitlabCall.body) === JSON.stringify({ sha: 'deadbeef' }),
    JSON.stringify(fallbackGitlabCall.body),
  );

  // ===========================================================================
  section(
    "13. GitHub, a failing GraphQL proposal: the dialog's own fallback merges with no message, not a throw",
  );

  queue = [
    jsonResponse({
      number: 9,
      state: 'open',
      base: { ref: 'main', repo: { id: 1, allow_merge_commit: true } },
    }),
    jsonResponse({ errors: [{ message: 'Resource not accessible by integration' }] }),
  ];
  let githubProposalThrew = false;
  try {
    await mrMergeProposalHandler(readyGithubMr, clients);
  } catch {
    githubProposalThrew = true;
  }
  check(
    'the client itself still throws — the fallback lives in the dialog, not the client',
    githubProposalThrew,
  );

  queue = [
    jsonResponse({
      number: 9,
      state: 'open',
      base: { ref: 'main', repo: { id: 1, allow_merge_commit: true } },
    }),
    jsonResponse({ errors: [{ message: 'Resource not accessible by integration' }] }),
    jsonResponse({
      number: 9,
      state: 'open',
      base: { ref: 'main', repo: { id: 1, allow_merge_commit: true } },
    }),
    jsonResponse({ sha: 'cafef00d', merged: true }),
  ];
  await loadProposalThenMerge(readyGithubMr, clients);
  const fallbackGithubCall = calls[calls.length - 1];
  check(
    "merging after a failed load sends no message — the forge's own default",
    JSON.stringify(fallbackGithubCall.body) === JSON.stringify({ sha: 'cafef00d', merge_method: 'merge' }),
    JSON.stringify(fallbackGithubCall.body),
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
