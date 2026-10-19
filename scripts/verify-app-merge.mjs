/**
 * Headless proof of "Task Manager merges it itself" — the app's own merge on green, for a
 * forge that cannot auto-merge (a private repo on GitHub Free answers 403 to auto-merge, yet
 * accepts a plain merge PUT).
 *
 *     node scripts/verify-app-merge.mjs
 *
 * Bundles the REAL `forge/prWatcher.ts` (whose app-merge pass calls the real
 * `forge/appMerge.ts`, the real forge clients and the real `appMergeDecision`) and the real
 * `forge/autoMerge.ts` with the repo's own esbuild binary, and fakes only `fetch` — the same
 * stub-fetch approach `verify-mr-merge.mjs` and `verify-pr-watch.mjs` use. The watcher's deps
 * are in-memory fakes; a note lands on an in-memory timeline the next pass reads back, exactly
 * as `store.addComment` → `store.getTaskActivity` would.
 *
 * ## What it proves
 *
 *  1. GitHub, a green PR: exactly ONE `PUT …/pulls/7/merge`, whose body `sha` is the sha the
 *     stub served the check runs for, and whose `merge_method` is the project's own method.
 *  2. The same rows through `watchMergeRequests` a second time: still exactly one PUT, and no
 *     forge call at all on the second pass.
 *  3. A head that moved after the sync (the row says `sha-old`, the forge now says `sha-new`):
 *     zero PUTs and a `stale-sha` refusal note.
 *  4. A PUT answered with 409: one PUT, a refusal note carrying the forge's message, and no
 *     retry on the next pass.
 *  5. GitLab: one `PUT …/merge_requests/3/merge` carrying the sha its pipeline ran for.
 *  6. `requestAutoMerge` against an `enableAutoMerge` answering 403 "Upgrade to GitHub Pro":
 *     the fallback note — and then the watcher merges, on a project still set to `forge`.
 *
 * ## Prove it can fail
 *
 * Disable the attempts-map guard in `apps/client/src/main/forge/prWatcher.ts` — comment out
 * `if (deps.appMergeAttempts.get(mr.id) === mr.headSha) return false;` — and re-run: check 2
 * goes red (the second pass re-reads the forge and PUTs a second merge), and check 4's
 * "no retry" goes red with it. Or drop `sha` from the PUT (`mergePullRequest(owner, repo,
 * mr.number, undefined, …)` in `forge/appMerge.ts`): check 1 goes red. Restore afterwards —
 * this file does not run with either mutation in place.
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

/** esbuild is a per-platform binary under a versioned `.pnpm` directory — found by pattern,
 *  see `verify-pr-watch.mjs`. */
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

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : String(status),
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * A GitHub stub: one PR (`acme/web#7`) whose head is `liveSha`, one green check run on
 * whatever commit is asked for (recorded in `checkedShas`), and a merge PUT answered with
 * `mergeStatus`. `autoMergeStatus`, when set, is what the auto-merge GraphQL mutation answers.
 */
function stubGitHub({
  liveSha,
  mergeStatus = 200,
  mergeMessage,
  autoMergeStatus,
  autoMergeMessage,
}) {
  const calls = [];
  const checkedShas = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: u, body });
    if (method === 'GET' && /\/repos\/acme\/web\/pulls\/7$/.test(u)) {
      return json({
        number: 7,
        state: 'open',
        draft: false,
        node_id: 'PR_7',
        auto_merge: null,
        mergeable: true,
        mergeable_state: 'clean',
        head: { ref: 'feature/x', sha: liveSha, repo: { full_name: 'acme/web' } },
        base: { ref: 'main', repo: { full_name: 'acme/web' } },
      });
    }
    const runs = u.match(/\/commits\/([^/]+)\/check-runs/);
    if (method === 'GET' && runs) {
      checkedShas.push(decodeURIComponent(runs[1]));
      return json({ check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] });
    }
    if (method === 'GET' && /\/commits\/[^/]+\/status/.test(u)) return json({ statuses: [] });
    if (method === 'PUT' && u.endsWith('/pulls/7/merge')) {
      return mergeStatus === 200
        ? json({ merged: true, sha: 'merge-commit' })
        : json({ message: mergeMessage ?? 'Pull Request is not mergeable' }, mergeStatus);
    }
    if (method === 'GET' && u.endsWith('/repos/acme/web')) {
      return json({ delete_branch_on_merge: true });
    }
    if (method === 'POST' && u.endsWith('/graphql') && autoMergeStatus) {
      return json({ message: autoMergeMessage }, autoMergeStatus);
    }
    throw new Error(`unexpected fetch ${method} ${u}`);
  };
  return { calls, checkedShas, puts: () => calls.filter((c) => c.method === 'PUT') };
}

const scratch = mkdtempSync(join(tmpdir(), 'tm-app-merge-'));
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
  bundle(join(root, 'apps/client/src/main/forge/prWatcher.ts'), join(scratch, 'prWatcher.cjs'));
  bundle(join(root, 'apps/client/src/main/forge/autoMerge.ts'), join(scratch, 'autoMerge.cjs'));
  bundle(join(root, 'packages/shared/src/settings.ts'), join(scratch, 'settings.cjs'));

  const require = createRequire(import.meta.url);
  const { watchMergeRequests } = require(join(scratch, 'prWatcher.cjs'));
  const { requestAutoMerge } = require(join(scratch, 'autoMerge.cjs'));
  const { DEFAULT_SETTINGS } = require(join(scratch, 'settings.cjs'));

  const settings = {
    ...DEFAULT_SETTINGS,
    // OFF on purpose: the app-merge pass must not depend on it.
    features: { ...DEFAULT_SETTINGS.features, prAutoResolve: false },
    github: { ...DEFAULT_SETTINGS.github, baseUrl: 'https://api.github.com' },
    gitlab: { ...DEFAULT_SETTINGS.gitlab, baseUrl: 'https://gitlab.example.com' },
  };

  const row = (over = {}) => ({
    id: 'gh-5-7',
    taskId: null,
    openedForTaskId: 'task-1',
    provider: 'github',
    repoId: 5,
    projectPath: 'acme/web',
    number: 7,
    title: 'Fix the thing',
    displayName: null,
    webUrl: 'https://github.com/acme/web/pull/7',
    sourceBranch: 'feature/x',
    targetBranch: 'main',
    state: 'opened',
    draft: false,
    headSha: 'sha-green',
    lastActedSha: null,
    lastActedAction: null,
    pipelineStatus: 'success',
    pipelineStages: [],
    pipelineUrl: null,
    approvalsRequired: null,
    approvalsGiven: 0,
    changesRequested: false,
    detailedMergeStatus: 'clean',
    hasConflicts: false,
    issueKeys: [],
    latestNoteAt: null,
    lastReadAt: null,
    lastEventAt: null,
    lastEventSeenAt: null,
    updatedAt: 0,
    syncedAt: 0,
    ...over,
  });

  /** A world with one card on a project that merges on green — by `autoMergeBy`. */
  function world(autoMergeBy = 'app') {
    const activity = [];
    const project = {
      id: 'agent-1',
      autoMergeOnGreen: true,
      autoMergeBy,
      autoMergeMethod: 'merge',
      autoMergeRequiredChecks: ['build'],
    };
    const task = { id: 'task-1', projectId: 'board-1', agentProjectId: 'agent-1', title: 'A card' };
    const deps = {
      getSettings: () => settings,
      getTask: (id) => (id === task.id ? task : undefined),
      getProject: (id) => (id === project.id ? project : undefined),
      tokenFor: () => 'a-token',
      resolveForgeConflict: () => {},
      chatWithAgent: (taskId) => ({ status: 'sent', taskId, runId: 'r' }),
      note: (_projectId, _taskId, body) =>
        activity.push({ kind: 'comment', id: activity.length + 1, body, createdAt: Date.now() }),
      markActed: () => {},
      listAttachments: () => [],
      listActivity: () => activity,
      appMergeAttempts: new Map(),
    };
    const notes = () => activity.map((e) => e.body);
    return { deps, project, task, notes };
  }

  section('1. GitHub — a green PR is merged once, with the checked sha');
  {
    const gh = stubGitHub({ liveSha: 'sha-green' });
    const w = world();
    await watchMergeRequests([row()], w.deps);
    const puts = gh.puts();
    check('exactly one merge PUT', puts.length === 1, `${puts.length} PUTs`);
    check(
      'the PUT sha is the sha the check runs were served for',
      puts[0]?.body?.sha === 'sha-green' && gh.checkedShas.includes(puts[0]?.body?.sha),
      JSON.stringify({ body: puts[0]?.body, checked: gh.checkedShas }),
    );
    check(
      "merge_method is the project's method",
      puts[0]?.body?.merge_method === 'merge',
      String(puts[0]?.body?.merge_method),
    );
    check(
      'a merged note',
      w.notes().some((n) => n.startsWith('Merged by Task Manager: #7 into main')),
      JSON.stringify(w.notes()),
    );

    section('2. the same rows a second time — still one PUT');
    const before = gh.calls.length;
    await watchMergeRequests([row()], w.deps);
    check('still exactly one merge PUT', gh.puts().length === 1, `${gh.puts().length} PUTs`);
    check('no forge call at all on the second pass', gh.calls.length === before);
  }

  section('3. the head moved after the sync — no merge');
  {
    const gh = stubGitHub({ liveSha: 'sha-new' });
    const w = world();
    await watchMergeRequests([row({ headSha: 'sha-old' })], w.deps);
    check('zero merge PUTs', gh.puts().length === 0, `${gh.puts().length} PUTs`);
    check(
      'a stale-sha refusal note',
      w.notes().some((n) => n.startsWith('Task Manager did not merge #7 (stale-sha)')),
      JSON.stringify(w.notes()),
    );
  }

  section('4. the forge answers the PUT with 409 — one try, no retry');
  {
    const gh = stubGitHub({
      liveSha: 'sha-green',
      mergeStatus: 409,
      mergeMessage: 'Base branch was modified. Review and try the merge again.',
    });
    const w = world();
    await watchMergeRequests([row()], w.deps);
    check('one merge PUT', gh.puts().length === 1, `${gh.puts().length} PUTs`);
    check(
      "a refusal note carrying the forge's message",
      w
        .notes()
        .some(
          (n) =>
            n.startsWith('Task Manager did not merge #7') && n.includes('Base branch was modified'),
        ),
      JSON.stringify(w.notes()),
    );
    await watchMergeRequests([row()], w.deps);
    check('no retry on the next pass', gh.puts().length === 1, `${gh.puts().length} PUTs`);
  }

  section('5. GitLab — one merge PUT carrying the checked sha');
  {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, url: u, body });
      if (method === 'GET' && u.endsWith('/projects/acme%2Fweb/merge_requests/3')) {
        return json({
          id: 1,
          iid: 3,
          project_id: 9,
          title: 'Fix',
          state: 'opened',
          draft: false,
          web_url: 'https://gitlab.example.com/acme/web/-/merge_requests/3',
          source_branch: 'feature/x',
          target_branch: 'main',
          updated_at: '2026-10-19T00:00:00Z',
          sha: 'gl-sha',
          detailed_merge_status: 'mergeable',
          has_conflicts: false,
          head_pipeline: { id: 11, status: 'success', sha: 'gl-sha' },
          force_remove_source_branch: true,
        });
      }
      if (method === 'GET' && u.includes('/projects/9/pipelines/11/jobs')) {
        return json([{ name: 'build', status: 'success' }]);
      }
      if (method === 'PUT' && u.endsWith('/projects/9/merge_requests/3/merge')) {
        return json({ iid: 3, state: 'merged' });
      }
      throw new Error(`unexpected fetch ${method} ${u}`);
    };
    const w = world();
    await watchMergeRequests(
      [
        row({
          id: 'gl-9-3',
          provider: 'gitlab',
          repoId: 9,
          number: 3,
          headSha: 'gl-sha',
          detailedMergeStatus: 'mergeable',
        }),
      ],
      w.deps,
    );
    const puts = calls.filter((c) => c.method === 'PUT');
    check('exactly one merge PUT', puts.length === 1, `${puts.length} PUTs`);
    check(
      'it carries the checked sha',
      puts[0]?.body?.sha === 'gl-sha',
      JSON.stringify(puts[0]?.body),
    );
    check(
      'a merged note',
      w.notes().some((n) => n.startsWith('Merged by Task Manager: !3 into main')),
      JSON.stringify(w.notes()),
    );
  }

  section('6. auto-merge refused with 403 — the fallback note, then the watcher merges');
  {
    const gh = stubGitHub({
      liveSha: 'sha-green',
      autoMergeStatus: 403,
      autoMergeMessage:
        'Upgrade to GitHub Pro or make this repository public to enable this feature.',
    });
    const w = world('forge');
    await requestAutoMerge(w.deps, {
      project: w.project,
      owner: w.task,
      mr: { provider: 'github', projectPath: 'acme/web', number: 7 },
      token: 'a-token',
      settings,
    });
    check(
      'the fallback note',
      w.notes().some((n) => n.startsWith('Auto-merge is not available on #7')),
      JSON.stringify(w.notes()),
    );
    await watchMergeRequests([row()], w.deps);
    const puts = gh.puts();
    check('then exactly one merge PUT', puts.length === 1, `${puts.length} PUTs`);
    check(
      'with the checked sha',
      puts[0]?.body?.sha === 'sha-green',
      JSON.stringify(puts[0]?.body),
    );
  }
} catch (err) {
  failures += 1;
  log('  FAIL  the script itself threw — ' + (err instanceof Error ? err.stack : String(err)));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
