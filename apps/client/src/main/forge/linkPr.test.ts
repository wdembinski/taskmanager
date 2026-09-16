/**
 * `linkMergeRequest` and its two per-forge halves.
 *
 * The halves (`linkGitHubPullRequest` / `linkGitLabMergeRequest`) take an already-built
 * client, exactly as `describeMergeRequest.test.ts` / `describePullRequest.test.ts` stub
 * theirs — so the fetch-then-reconcile behaviour is exercised without a real network call.
 * The entry point, `linkMergeRequest`, is exercised end to end with `fetch` itself stubbed,
 * since it is the one piece that builds its own client from a token rather than taking one —
 * the same thing `forge/createPr.ts` does, and for the same reason (the secret is read at
 * the moment it is spent, never held in a longer-lived object).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MergeRequest } from '@shared/mergeRequest';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settings';
import type { Task } from '@shared/model';
import {
  linkGitHubPullRequest,
  linkGitLabMergeRequest,
  linkMergeRequest,
  type LinkPrDeps,
  type LinkReconcileOpts,
} from './linkPr';
import type { GitHubClient, GitHubPullRequest } from '../github/githubClient';
import type { GitLabClient, GitLabMergeRequest } from '../gitlab/gitlabClient';

const emptyOpts: LinkReconcileOpts = {
  knownKeys: [],
  taskIdByKey: new Map(),
  knownTaskIds: new Set(['task-1']),
  identity: null,
  now: 1_800_000_000_000,
};

/** A prior stored row, carrying read markers a re-link must not throw away. */
const priorRow = (over: Partial<MergeRequest> = {}): MergeRequest =>
  ({
    id: 'gh-42-7',
    taskId: 'task-1',
    openedForTaskId: 'task-1',
    provider: 'github',
    repoId: 42,
    projectPath: 'acme/web',
    number: 7,
    title: 'Add the thing',
    displayName: 'My renamed PR',
    webUrl: 'https://github.com/acme/web/pull/7',
    sourceBranch: 'feat/thing',
    targetBranch: 'main',
    state: 'opened',
    draft: false,
    pipelineStatus: 'unknown',
    pipelineUrl: null,
    pipelineStages: [],
    approvalsRequired: null,
    approvalsGiven: 0,
    changesRequested: false,
    detailedMergeStatus: null,
    hasConflicts: false,
    issueKeys: [],
    latestNoteAt: null,
    lastReadAt: 1_700_000_000_000,
    lastEventAt: null,
    lastEventSeenAt: null,
    updatedAt: 1_600_000_000_000,
    syncedAt: 1_600_000_000_000,
    ...over,
  }) as MergeRequest;

describe('linkGitHubPullRequest', () => {
  const detail = (over: Partial<GitHubPullRequest> = {}): GitHubPullRequest =>
    ({
      id: 999,
      number: 7,
      title: 'Add the thing',
      body: 'Description',
      state: 'open',
      draft: false,
      html_url: 'https://github.com/acme/web/pull/7',
      updated_at: '2026-07-30T10:00:00.000Z',
      head: { ref: 'feat/thing', sha: 'abc123', repo: { id: 42, full_name: 'acme/web' } },
      base: { ref: 'main', repo: { id: 42, full_name: 'acme/web' } },
      ...over,
    }) as GitHubPullRequest;

  function client(pr: GitHubPullRequest): GitHubClient {
    return {
      getPullRequest: async () => pr,
      listReviews: async () => [],
      listIssueComments: async () => [],
      listReviewComments: async () => [],
      getBranchProtection: async () => {
        throw new Error('404');
      },
      listCheckRuns: async () => [],
      getCombinedStatus: async () => ({ statuses: [] }),
    } as unknown as GitHubClient;
  }

  it('reconciles a freshly fetched PR into a row keyed by repoId-number', async () => {
    const row = await linkGitHubPullRequest(
      client(detail()),
      { owner: 'acme', repo: 'web', number: 7 },
      [],
      emptyOpts,
    );
    expect(row.id).toBe('gh-42-7');
    expect(row.provider).toBe('github');
    expect(row.webUrl).toBe('https://github.com/acme/web/pull/7');
  });

  it("keeps a prior row's read markers and display name on a re-link", async () => {
    const row = await linkGitHubPullRequest(
      client(detail()),
      { owner: 'acme', repo: 'web', number: 7 },
      [priorRow()],
      emptyOpts,
    );
    expect(row.lastReadAt).toBe(1_700_000_000_000);
    expect(row.displayName).toBe('My renamed PR');
  });

  it("identifies the row by the TARGET repo, not the head's (a fork's PR)", async () => {
    const forked = detail({
      head: { ref: 'feat/thing', sha: 'abc123', repo: { id: 999, full_name: 'someone/fork' } },
      base: { ref: 'main', repo: { id: 42, full_name: 'acme/web' } },
    });
    const row = await linkGitHubPullRequest(
      client(forked),
      { owner: 'acme', repo: 'web', number: 7 },
      [],
      emptyOpts,
    );
    expect(row.id).toBe('gh-42-7');
  });
});

describe('linkGitLabMergeRequest', () => {
  const detail = (over: Partial<GitLabMergeRequest> = {}): GitLabMergeRequest =>
    ({
      id: 1,
      iid: 9,
      project_id: 42,
      title: 'Add the thing',
      web_url: 'https://gitlab.com/acme/web/-/merge_requests/9',
      source_branch: 'feat/thing',
      target_branch: 'main',
      state: 'opened',
      updated_at: '2026-07-30T10:00:00.000Z',
      references: { full: 'acme/web!9' },
      ...over,
    }) as GitLabMergeRequest;

  function client(mr: GitLabMergeRequest): GitLabClient {
    return {
      getMergeRequestByPath: async () => mr,
      getMergeRequest: async () => mr,
      getApprovals: async () => {
        throw new Error('tier-gated');
      },
      getReviewers: async () => [],
      listNotes: async () => [],
      listPipelineJobs: async () => [],
    } as unknown as GitLabClient;
  }

  it('reconciles a freshly fetched MR into a row keyed by project_id-iid', async () => {
    const row = await linkGitLabMergeRequest(
      client(detail()),
      { projectPath: 'acme/web', number: 9 },
      [],
      emptyOpts,
    );
    expect(row.id).toBe('gl-42-9');
    expect(row.provider).toBe('gitlab');
    expect(row.webUrl).toBe('https://gitlab.com/acme/web/-/merge_requests/9');
  });

  it('preserves nested subgroup project paths', async () => {
    const row = await linkGitLabMergeRequest(
      client(detail({ references: { full: 'acme/platform/backend!9' } })),
      { projectPath: 'acme/platform/backend', number: 9 },
      [],
      emptyOpts,
    );
    expect(row.projectPath).toBe('acme/platform/backend');
  });
});

describe('linkMergeRequest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const task: Task = { id: 'task-1', projectId: 'project-1' } as Task;

  const settings = (over: Partial<AppSettings> = {}): AppSettings => ({
    ...DEFAULT_SETTINGS,
    github: { ...DEFAULT_SETTINGS.github, enabled: true, baseUrl: 'https://api.github.com' },
    gitlab: { ...DEFAULT_SETTINGS.gitlab, enabled: true, baseUrl: 'https://gitlab.com' },
    ...over,
  });

  function deps(over: Partial<LinkPrDeps> = {}): LinkPrDeps {
    return {
      getTask: () => task,
      getSettings: settings,
      listMergeRequests: () => [],
      boardKeyIndex: () => ({
        knownKeys: [],
        taskIdByKey: new Map(),
        knownTaskIds: new Set(['task-1']),
      }),
      upsertMergeRequest: () => {},
      tokenFor: () => 'a-token',
      note: () => {},
      now: () => 1_800_000_000_000,
      ...over,
    };
  }

  /** Answers every GitHub/GitLab detail call with `body`, and 404s everything else. */
  function stubFetch(routes: ReadonlyArray<readonly [string, unknown]>): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        for (const [needle, body] of routes) {
          if (url.includes(needle)) return new Response(JSON.stringify(body), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }),
    );
  }

  it('rejects a URL that names neither an MR nor a PR', async () => {
    await expect(linkMergeRequest(deps(), 'task-1', 'https://example.com/nope')).rejects.toThrow(
      /not a GitLab merge request or GitHub pull request URL/,
    );
  });

  it("refuses when the URL's provider is not enabled", async () => {
    const d = deps({
      getSettings: () => settings({ github: { ...DEFAULT_SETTINGS.github, enabled: false } }),
    });
    await expect(
      linkMergeRequest(d, 'task-1', 'https://github.com/acme/web/pull/7'),
    ).rejects.toThrow(/GitHub is not enabled/);
  });

  it('refuses when no token is saved for that provider', async () => {
    const d = deps({ tokenFor: () => null });
    await expect(
      linkMergeRequest(d, 'task-1', 'https://gitlab.com/acme/web/-/merge_requests/9'),
    ).rejects.toThrow(/No GitLab token is saved/);
  });

  it('refuses when the card no longer exists', async () => {
    const d = deps({ getTask: () => undefined });
    await expect(linkMergeRequest(d, 'gone', 'https://github.com/acme/web/pull/7')).rejects.toThrow(
      /no longer exists/,
    );
  });

  it('links a GitHub URL and pins it to the target card', async () => {
    stubFetch([
      [
        '/repos/acme/web/pulls/7',
        {
          id: 999,
          number: 7,
          title: 'Add the thing',
          html_url: 'https://github.com/acme/web/pull/7',
          state: 'open',
          draft: false,
          updated_at: '2026-07-30T10:00:00.000Z',
          head: { ref: 'feat/thing', sha: 'abc', repo: { id: 42, full_name: 'acme/web' } },
          base: { ref: 'main', repo: { id: 42, full_name: 'acme/web' } },
        },
      ],
    ]);
    const upserted: MergeRequest[] = [];
    const row = await linkMergeRequest(
      deps({ upsertMergeRequest: (mr) => upserted.push(mr) }),
      'task-1',
      'https://github.com/acme/web/pull/7',
    );
    expect(row.id).toBe('gh-42-7');
    expect(row.taskId).toBe('task-1');
    expect(row.openedForTaskId).toBe('task-1');
    expect(upserted).toEqual([row]);
  });

  it('links a GitLab URL and pins it to the target card', async () => {
    stubFetch([
      [
        '/api/v4/projects/acme%2Fweb/merge_requests/9',
        {
          id: 1,
          iid: 9,
          project_id: 42,
          title: 'Add the thing',
          web_url: 'https://gitlab.com/acme/web/-/merge_requests/9',
          source_branch: 'feat/thing',
          target_branch: 'main',
          state: 'opened',
          updated_at: '2026-07-30T10:00:00.000Z',
          references: { full: 'acme/web!9' },
        },
      ],
    ]);
    const row = await linkMergeRequest(
      deps(),
      'task-1',
      'https://gitlab.com/acme/web/-/merge_requests/9',
    );
    expect(row.id).toBe('gl-42-9');
    expect(row.taskId).toBe('task-1');
    expect(row.openedForTaskId).toBe('task-1');
  });

  it('re-linking an already-stored MR overrides its card but keeps its read markers', async () => {
    stubFetch([
      [
        '/repos/acme/web/pulls/7',
        {
          id: 999,
          number: 7,
          title: 'Add the thing',
          html_url: 'https://github.com/acme/web/pull/7',
          state: 'open',
          draft: false,
          updated_at: '2026-07-30T10:00:00.000Z',
          head: { ref: 'feat/thing', sha: 'abc', repo: { id: 42, full_name: 'acme/web' } },
          base: { ref: 'main', repo: { id: 42, full_name: 'acme/web' } },
        },
      ],
    ]);
    const prior = priorRow({ taskId: 'task-other', openedForTaskId: 'task-other' });
    const row = await linkMergeRequest(
      deps({ listMergeRequests: () => [prior] }),
      'task-1',
      'https://github.com/acme/web/pull/7',
    );
    expect(row.taskId).toBe('task-1');
    expect(row.openedForTaskId).toBe('task-1');
    expect(row.lastReadAt).toBe(1_700_000_000_000);
    expect(row.displayName).toBe('My renamed PR');
  });
});
