/**
 * `ReviewQueueService` against fake clients, a fake cache and a fake clock — the
 * complete-answer-only removal rule from the header of `queueService.ts`, plus every pure
 * helper it is built from.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MergeRequest } from '@shared/mergeRequest';
import type { Project, Task } from '@shared/model';
import type { ReviewQueueItem, ReviewQueuesSnapshot, ReviewSubject } from '@shared/review';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settings';
import type { GitHubClient, GitHubSearchIssueItem } from '../github/githubClient';
import type { GitLabClient, GitLabMergeRequest } from '../gitlab/gitlabClient';
import {
  dedupe,
  gitlabRowToItem,
  githubRowToItem,
  mergeRequestToItem,
  reconcileSegment,
  taskToItem,
  ReviewQueueService,
  type QueuedRow,
  type ReviewQueueServiceDeps,
} from './queueService';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function githubRow(overrides: Partial<GitHubSearchIssueItem> = {}): GitHubSearchIssueItem {
  return {
    id: 1,
    number: 12,
    title: 'Fix the thing',
    state: 'open',
    html_url: 'https://github.com/acme/web/pull/12',
    repository_url: 'https://api.github.com/repos/acme/web',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function gitlabRow(overrides: Partial<GitLabMergeRequest> = {}): GitLabMergeRequest {
  return {
    id: 1,
    iid: 12,
    project_id: 42,
    title: 'Fix the other thing',
    state: 'opened',
    web_url: 'https://gitlab.com/acme/api/-/merge_requests/12',
    source_branch: 'fix',
    target_branch: 'main',
    updated_at: '2026-01-01T00:00:00Z',
    references: { full: 'acme/api!12' },
    ...overrides,
  };
}

function mergeRequest(overrides: Partial<MergeRequest> = {}): MergeRequest {
  return {
    id: 'gh-99-7',
    taskId: null,
    openedForTaskId: null,
    provider: 'github',
    repoId: 99,
    projectPath: 'acme/web',
    number: 7,
    title: 'My own PR',
    displayName: null,
    webUrl: 'https://github.com/acme/web/pull/7',
    sourceBranch: 'feature',
    targetBranch: 'main',
    state: 'opened',
    draft: false,
    pipelineStatus: 'unknown',
    pipelineUrl: null,
    headSha: 'abc123',
    lastActedSha: null,
    lastActedAction: null,
    pipelineStages: [],
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
    updatedAt: 1000,
    syncedAt: 1000,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'board-1',
    phase: '',
    title: 'Review this',
    status: 'in-review',
    sessionId: null,
    order: 0,
    source: 'adhoc',
    dependsOn: [],
    isContract: false,
    isScaffold: false,
    workedAt: 1000,
    landedAt: null,
    parentTaskId: null,
    ...overrides,
  };
}

/** A `requested`/`mine` row's PR subject, keyed by provider — the shape `gh-1-1`/`gl-1-1` need. */
function prSubject(provider: 'github' | 'gitlab', number = 1): ReviewSubject {
  return { kind: 'pr', provider, repoId: 1, repoPath: 'x/y', number };
}

function row(
  item: Partial<ReviewQueueItem> & Pick<ReviewQueueItem, 'subjectId' | 'queue'>,
): QueuedRow {
  return {
    syncedAt: 1,
    item: {
      subject: prSubject('github'),
      title: '',
      author: '',
      repoPath: '',
      ref: '',
      headSha: null,
      draft: false,
      updatedAt: 0,
      projectId: null,
      taskId: null,
      draftCount: 0,
      viewedCount: 0,
      fileCount: null,
      ...item,
    },
  };
}

describe('githubRowToItem', () => {
  it('parses owner/repo off repository_url and uses the given repoId', () => {
    const item = githubRowToItem(githubRow({ draft: true, user: { login: 'ada' } }), 55);
    expect(item.subject).toEqual({
      kind: 'pr',
      provider: 'github',
      repoId: 55,
      repoPath: 'acme/web',
      number: 12,
    });
    expect(item.queue).toBe('requested');
    expect(item.author).toBe('ada');
    expect(item.draft).toBe(true);
    expect(item.ref).toBe('#12');
    expect(item.headSha).toBeNull();
  });

  it('defaults author and draft when absent', () => {
    const item = githubRowToItem(githubRow({ user: null, draft: undefined }), 1);
    expect(item.author).toBe('');
    expect(item.draft).toBe(false);
  });
});

describe('gitlabRowToItem', () => {
  it('reads the project path off references.full and prefers author.name', () => {
    const item = gitlabRowToItem(
      gitlabRow({ author: { username: 'ada-l', name: 'Ada Lovelace' }, sha: 'deadbeef' }),
    );
    expect(item.subject).toEqual({
      kind: 'pr',
      provider: 'gitlab',
      repoId: 42,
      repoPath: 'acme/api',
      number: 12,
    });
    expect(item.author).toBe('Ada Lovelace');
    expect(item.ref).toBe('!12');
    expect(item.headSha).toBe('deadbeef');
  });

  it('falls back to username, then to the web URL for the path', () => {
    const item = gitlabRowToItem(gitlabRow({ author: { username: 'ada-l' }, references: null }));
    expect(item.author).toBe('ada-l');
    expect(item.subject.kind === 'pr' && item.subject.repoPath).toBe('acme/api');
  });

  it('treats work_in_progress as draft when draft itself is absent', () => {
    const item = gitlabRowToItem(gitlabRow({ draft: undefined, work_in_progress: true }));
    expect(item.draft).toBe(true);
  });

  it('carries the source branch and a known head pipeline', () => {
    const item = gitlabRowToItem(gitlabRow({ head_pipeline: { status: 'success' } }));
    expect(item.headRef).toBe('fix');
    expect(item.pipeline).toBe('success');
    expect(item.ref).toBe('!12');
  });

  it('leaves the pipeline unknown when the list row omits or misspells it', () => {
    expect(gitlabRowToItem(gitlabRow()).pipeline).toBeNull();
    expect(gitlabRowToItem(gitlabRow({ head_pipeline: { status: 'weird' } })).pipeline).toBeNull();
  });
});

describe('mergeRequestToItem', () => {
  it('uses displayName over title, and the caller-supplied author', () => {
    const mr = mergeRequest({ displayName: 'Nicer title', taskId: 'task-5' });
    const item = mergeRequestToItem(mr, () => 'me');
    expect(item.title).toBe('Nicer title');
    expect(item.author).toBe('me');
    expect(item.queue).toBe('mine');
    expect(item.taskId).toBe('task-5');
    expect(item.ref).toBe('#7');
  });

  it('carries the source branch and the stored pipeline status', () => {
    const item = mergeRequestToItem(
      mergeRequest({ sourceBranch: 'marta/retry-uploads', pipelineStatus: 'running' }),
      () => 'me',
    );
    expect(item.headRef).toBe('marta/retry-uploads');
    expect(item.pipeline).toBe('running');
  });
});

describe('taskToItem', () => {
  it('maps a task onto an agent row with no forge concepts', () => {
    const item = taskToItem(task(), 'My Project');
    expect(item.queue).toBe('agent');
    expect(item.subject).toEqual({ kind: 'task', taskId: 'task-1' });
    expect(item.repoPath).toBe('My Project');
    expect(item.updatedAt).toBe(1000);
    expect(item.author).toBe('');
  });
});

describe('reconcileSegment', () => {
  it('changes nothing on failure', () => {
    const cached = [row({ subjectId: 'gh-1-1', queue: 'requested' })];
    expect(
      reconcileSegment(cached, 'failure', 999, { queue: 'requested', provider: 'github' }),
    ).toEqual(cached);
  });

  it('upserts returned rows and deletes nothing when incomplete', () => {
    const cached = [
      row({ subjectId: 'gh-1-1', queue: 'requested', title: 'old' }),
      row({ subjectId: 'gh-1-2', queue: 'requested', title: 'kept' }),
    ];
    const fresh: ReviewQueueItem = { ...cached[0].item, title: 'new' };
    const next = reconcileSegment(cached, { rows: [fresh], complete: false }, 500, {
      queue: 'requested',
      provider: 'github',
    });
    expect(next).toHaveLength(2);
    expect(next.find((r) => r.item.subjectId === 'gh-1-1')).toEqual({ item: fresh, syncedAt: 500 });
    expect(next.find((r) => r.item.subjectId === 'gh-1-2')).toEqual(cached[1]);
  });

  it('drops every other cached row in the segment when complete', () => {
    const cached = [
      row({ subjectId: 'gh-1-1', queue: 'requested' }),
      row({ subjectId: 'gh-1-2', queue: 'requested' }),
      // A different segment's row (same queue, other provider) must survive untouched.
      row({
        subjectId: 'gl-1-1',
        queue: 'requested',
        subject: { kind: 'pr', provider: 'gitlab', repoId: 1, repoPath: 'x/y', number: 1 },
      }),
    ];
    const next = reconcileSegment(cached, { rows: [cached[0].item], complete: true }, 500, {
      queue: 'requested',
      provider: 'github',
    });
    expect(next.map((r) => r.item.subjectId).sort()).toEqual(['gh-1-1', 'gl-1-1']);
  });

  it('never touches rows outside the segment (a different queue)', () => {
    const cached = [row({ subjectId: 'task:a', queue: 'agent' })];
    const next = reconcileSegment(cached, { rows: [], complete: true }, 1, { queue: 'mine' });
    expect(next).toEqual(cached);
  });
});

describe('dedupe', () => {
  it('drops a requested row whose subject also sits in mine', () => {
    const mine = row({ subjectId: 'gh-1-1', queue: 'mine' });
    const requested = row({ subjectId: 'gh-1-1', queue: 'requested' });
    const other = row({ subjectId: 'gh-1-2', queue: 'requested' });
    const deduped = dedupe([mine, requested, other]);
    expect(deduped).toHaveLength(2);
    expect(
      deduped.find((r) => r.item.subjectId === 'gh-1-1' && r.item.queue === 'requested'),
    ).toBeUndefined();
    expect(
      deduped.find((r) => r.item.subjectId === 'gh-1-1' && r.item.queue === 'mine'),
    ).toBeDefined();
    expect(
      deduped.find((r) => r.item.subjectId === 'gh-1-2' && r.item.queue === 'requested'),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ReviewQueueService — fake cache, clients and clock
// ---------------------------------------------------------------------------

interface FakeStore {
  rows: QueuedRow[];
  mergeRequests: MergeRequest[];
  projects: Project[];
  tasksByProject: Map<string, Task[]>;
  settings: AppSettings;
  githubIdentity: { id: number | null; login: string; baseUrl: string } | null;
  gitlabIdentity: { id: number | null; username: string; baseUrl: string } | null;
  draftCounts: Map<string, number>;
  viewedCounts: Map<string, number>;
}

function fakeStore(
  overrides: Partial<FakeStore> = {},
): FakeStore & ReviewQueueServiceDeps['store'] {
  const state: FakeStore = {
    rows: [],
    mergeRequests: [],
    projects: [],
    tasksByProject: new Map(),
    settings: DEFAULT_SETTINGS,
    githubIdentity: null,
    gitlabIdentity: null,
    draftCounts: new Map(),
    viewedCounts: new Map(),
    ...overrides,
  };
  // `Object.assign` onto `state` itself — not a spread into a new object — so `store.rows`
  // keeps reading the SAME field `applyReviewQueue`'s closure reassigns. A spread would
  // have copied `rows` once at construction time, and every reassignment after that would
  // update `state.rows` while the test's own `store.rows` kept pointing at the stale array.
  const methods: ReviewQueueServiceDeps['store'] = {
    listReviewQueue: () => state.rows.map((r) => ({ item: { ...r.item }, syncedAt: r.syncedAt })),
    applyReviewQueue: (segment, items, syncedAt, opts) => {
      state.rows = reconcileSegment(
        state.rows,
        { rows: [...items], complete: opts.complete },
        syncedAt,
        segment,
      );
    },
    countReviewDrafts: () => state.draftCounts,
    countReviewViewed: () => state.viewedCounts,
    listMergeRequests: () => state.mergeRequests,
    listProjects: () => state.projects,
    getTasks: (projectId) => state.tasksByProject.get(projectId) ?? [],
    getSettings: () => state.settings,
    loadGitHubIdentity: () => state.githubIdentity,
    loadGitLabIdentity: () => state.gitlabIdentity,
  };
  return Object.assign(state, methods);
}

function fakeGitHubClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    listReviewRequests: vi.fn(async () => ({
      items: [],
      incompleteResults: false,
      truncated: false,
    })),
    getRepository: vi.fn(async () => {
      throw new Error('not configured');
    }),
    ...overrides,
  } as unknown as GitHubClient;
}

function fakeGitLabClient(overrides: Partial<GitLabClient> = {}): GitLabClient {
  return {
    listReviewerMergeRequests: vi.fn(async () => ({ mergeRequests: [], truncated: false })),
    ...overrides,
  } as unknown as GitLabClient;
}

function fakeDiffs(): ReviewQueueServiceDeps['diffs'] {
  return {
    matchProject: vi.fn(async () => null),
    pruneReviewRefs: vi.fn(async () => {}),
  };
}

function setup(opts: {
  store?: Partial<FakeStore>;
  github?: GitHubClient;
  gitlab?: GitLabClient;
  diffs?: ReviewQueueServiceDeps['diffs'];
  now?: () => number;
}) {
  const store = fakeStore(opts.store);
  const github = opts.github ?? fakeGitHubClient();
  const gitlab = opts.gitlab ?? fakeGitLabClient();
  const diffs = opts.diffs ?? fakeDiffs();
  const emit = vi.fn<(snapshot: ReviewQueuesSnapshot) => void>();
  const githubFactory = vi.fn(() => github);
  const gitlabFactory = vi.fn(() => gitlab);
  const service = new ReviewQueueService({
    store,
    diffs,
    github: githubFactory,
    gitlab: gitlabFactory,
    emit,
    now: opts.now ?? (() => 1000),
  });
  return { service, store, github, gitlab, diffs, emit, githubFactory, gitlabFactory };
}

const enabledSettings: AppSettings = {
  ...DEFAULT_SETTINGS,
  github: { ...DEFAULT_SETTINGS.github, enabled: true },
  gitlab: { ...DEFAULT_SETTINGS.gitlab, enabled: true },
};

describe('ReviewQueueService.refresh', () => {
  it('a truncated search keeps previously cached rows and refreshes the ones it returned', async () => {
    const { service, github, store } = setup({
      store: { settings: enabledSettings },
      github: fakeGitHubClient({
        listReviewRequests: vi.fn(async () => ({
          items: [githubRow({ number: 1, repository_url: 'https://api.github.com/repos/a/a' })],
          incompleteResults: false,
          truncated: false,
        })),
        getRepository: vi.fn(async () => ({ id: 1, full_name: 'a/a' })),
      }),
    });
    await service.refresh();
    expect(store.rows.filter((r) => r.item.queue === 'requested')).toHaveLength(1);

    // Second refresh: truncated, and only returns a DIFFERENT row — the first must survive.
    (github.listReviewRequests as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [githubRow({ number: 2, repository_url: 'https://api.github.com/repos/b/b' })],
      incompleteResults: false,
      truncated: true,
    });
    (github.getRepository as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 2,
      full_name: 'b/b',
    });
    await service.refresh();
    const requestedIds = store.rows
      .filter((r) => r.item.queue === 'requested')
      .map((r) => r.item.subjectId)
      .sort();
    expect(requestedIds).toEqual(['gh-1-1', 'gh-2-2']);
  });

  it('a forge outage keeps the cache, leaves syncedAt unchanged, and still reconciles the other provider', async () => {
    const { service, store } = setup({
      store: {
        settings: enabledSettings,
        gitlabIdentity: { id: 1, username: 'me', baseUrl: 'https://gitlab.com' },
      },
      github: fakeGitHubClient({
        listReviewRequests: vi.fn(async () => {
          throw new Error('network down');
        }),
      }),
      gitlab: fakeGitLabClient({
        listReviewerMergeRequests: vi.fn(async () => ({
          mergeRequests: [gitlabRow()],
          truncated: false,
        })),
      }),
      now: () => 777,
    });
    // Seed a cached github row from an earlier, successful refresh.
    store.rows.push(
      row({
        subjectId: 'gh-5-1',
        queue: 'requested',
        subject: { kind: 'pr', provider: 'github', repoId: 5, repoPath: 'x/y', number: 1 },
      }),
    );
    store.rows[0].syncedAt = 10;

    const snapshot = await service.refresh().then(() => service.snapshot());

    const githubRows = store.rows.filter(
      (r) => r.item.subject.kind === 'pr' && r.item.subject.provider === 'github',
    );
    expect(githubRows).toHaveLength(1);
    expect(githubRows[0].syncedAt).toBe(10); // untouched

    const gitlabRows = store.rows.filter(
      (r) => r.item.subject.kind === 'pr' && r.item.subject.provider === 'gitlab',
    );
    expect(gitlabRows).toHaveLength(1);
    expect(gitlabRows[0].syncedAt).toBe(777); // the working provider still reconciled

    expect(snapshot.partial).toContain('requested');
  });

  it('a card leaving in-review drops its row on the next local refresh', async () => {
    const projectId = 'board-1';
    const { service, store } = setup({
      store: {
        projects: [{ id: projectId, name: 'Board' } as unknown as Project],
        tasksByProject: new Map([[projectId, [task()]]]),
      },
    });
    await service.refresh();
    expect(store.rows.some((r) => r.item.queue === 'agent')).toBe(true);

    store.tasksByProject.set(projectId, [task({ status: 'done' })]);
    await service.refreshLocal();
    expect(store.rows.some((r) => r.item.queue === 'agent')).toBe(false);
  });

  it('a PR that is both mine and requested is shown once, under mine', async () => {
    const mr = mergeRequest({
      provider: 'gitlab',
      repoId: 42,
      projectPath: 'acme/api',
      number: 12,
    });
    const { service } = setup({
      store: {
        settings: enabledSettings,
        mergeRequests: [mr],
        gitlabIdentity: { id: 1, username: 'me', baseUrl: 'https://gitlab.com' },
      },
      gitlab: fakeGitLabClient({
        listReviewerMergeRequests: vi.fn(async () => ({
          mergeRequests: [
            gitlabRow({ project_id: 42, iid: 12, references: { full: 'acme/api!12' } }),
          ],
          truncated: false,
        })),
      }),
    });
    await service.refresh();
    const snapshot = service.snapshot();
    const matches = snapshot.items.filter((item) => item.subjectId === 'gl-42-12');
    expect(matches).toHaveLength(1);
    expect(matches[0].queue).toBe('mine');
  });

  it('marks the segment incomplete when a repo id cannot be resolved', async () => {
    const { service, store } = setup({
      store: { settings: enabledSettings },
      github: fakeGitHubClient({
        listReviewRequests: vi.fn(async () => ({
          items: [githubRow()],
          incompleteResults: false,
          truncated: false,
        })),
        getRepository: vi.fn(async () => {
          throw new Error('404');
        }),
      }),
    });
    const snapshot = await service.refresh().then(() => service.snapshot());
    expect(store.rows.filter((r) => r.item.queue === 'requested')).toHaveLength(0);
    expect(snapshot.partial).toContain('requested');
  });

  it('fills projectId, draftCount and viewedCount during enrichment', async () => {
    const project = { id: 'proj-1', name: 'Web' } as unknown as Project;
    const { service, store } = setup({
      store: {
        settings: enabledSettings,
        draftCounts: new Map([['gh-1-12', 3]]),
        viewedCounts: new Map([['gh-1-12', 5]]),
      },
      github: fakeGitHubClient({
        listReviewRequests: vi.fn(async () => ({
          items: [githubRow()],
          incompleteResults: false,
          truncated: false,
        })),
        getRepository: vi.fn(async () => ({ id: 1, full_name: 'acme/web' })),
      }),
      diffs: {
        matchProject: vi.fn(async () => ({
          project,
          remote: { name: 'origin', fetchUrl: '', pushUrl: '' },
          parsedRemote: { host: 'github.com', path: 'acme/web' },
        })),
        pruneReviewRefs: vi.fn(async () => {}),
      },
    });
    await service.refresh();
    const item = store.rows.find((r) => r.item.subjectId === 'gh-1-12')?.item;
    expect(item?.projectId).toBe('proj-1');
    expect(item?.draftCount).toBe(3);
    expect(item?.viewedCount).toBe(5);
  });

  it('concurrent refresh() calls make one set of forge calls', async () => {
    const { service, github, gitlab } = setup({
      store: {
        settings: enabledSettings,
        gitlabIdentity: { id: 1, username: 'me', baseUrl: 'https://gitlab.com' },
      },
    });
    await Promise.all([service.refresh(), service.refresh()]);
    expect(github.listReviewRequests).toHaveBeenCalledTimes(1);
    expect(gitlab.listReviewerMergeRequests).toHaveBeenCalledTimes(1);
  });

  it('emits only when the deduped snapshot actually changes', async () => {
    const { service, emit } = setup({ store: {} });
    await service.refresh();
    expect(emit).toHaveBeenCalledTimes(1);
    await service.refresh();
    expect(emit).toHaveBeenCalledTimes(1); // nothing changed the second time

    await service.refreshLocal();
    expect(emit).toHaveBeenCalledTimes(1); // still nothing to say
  });

  it('prunes refs with the union of every cached subject, pre-dedup', async () => {
    const mr = mergeRequest({ provider: 'github', repoId: 1, projectPath: 'acme/web', number: 12 });
    const { service, diffs } = setup({
      store: {
        settings: enabledSettings,
        mergeRequests: [mr],
      },
      github: fakeGitHubClient({
        listReviewRequests: vi.fn(async () => ({
          items: [githubRow({ number: 12 })],
          incompleteResults: false,
          truncated: false,
        })),
        getRepository: vi.fn(async () => ({ id: 1, full_name: 'acme/web' })),
      }),
    });
    await service.refresh();
    expect(diffs.pruneReviewRefs).toHaveBeenCalledWith(new Set(['gh-1-12']));
  });
});
