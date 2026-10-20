/**
 * `applyVisualSignOff` — the forge-side half of a human's Approve/Needs-changes press on the
 * card panel's own Visual sign-off section. "VisualSignOff Approve enables auto-merge" is the
 * ticket's own name for the case this proves end to end: a UI card whose owner just approved
 * reaches the SAME GitHub call `requestAutoMerge` makes from a push, and a needs-changes
 * verdict withdraws it instead — never the other way around.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskAttachment } from '@shared/attachments';
import type { MergeRequest } from '@shared/mergeRequest';
import type { Project, Task, TaskActivityEntry } from '@shared/model';
import type { AppSettings } from '@shared/settings';
import { AI_REVIEW_GAVE_UP_PREFIX } from '@shared/aiVisualReview';
import { autoMergeAwaitAiReviewNote, autoMergeAwaitSignOffNote } from '@shared/autoMerge';
import { formatSignOff } from '@shared/visualSignOff';
import {
  applyVisualSignOff,
  collectAutoMergePrerequisites,
  requestAutoMerge,
  type AutoMergeDeps,
  type AutoMergePrerequisiteDeps,
  type AutoMergePrerequisiteProject,
  type VisualSignOffDeps,
} from './autoMerge';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const git = (cwd: string, ...args: string[]) => {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

/** A real git repo with a GitHub `origin` remote — enough for `resolveForgeGitTarget` to
 *  read, since this never pushes anything. */
function setupRepo(suffix: string) {
  const work = mkdtempSync(join(tmpdir(), `tm-automerge-signoff-${suffix}-`));
  const repo = join(work, 'repo');
  git(work, 'init', repo);
  git(repo, 'config', 'user.email', 'verify@example.com');
  git(repo, 'config', 'user.name', 'Verify');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '--no-verify', '-m', 'initial');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/checkout.git');
  return { work, repo };
}

const PR_NUMBER = 42;
const TOKEN = 'ghp_signoff0000';

function attachment(over: Partial<TaskAttachment> & { id: string; name: string }): TaskAttachment {
  return {
    taskId: 'owner-1',
    fileName: over.name,
    mimeType: null,
    size: 0,
    createdAt: 0,
    ...over,
  };
}

/** A full `MergeRequest` row, the same fixture shape `prWatcher.test.ts` uses. */
function mr(over: Partial<MergeRequest> = {}): MergeRequest {
  return {
    id: 'gh-555-42',
    taskId: 'owner-1',
    openedForTaskId: 'owner-1',
    provider: 'github',
    repoId: 555,
    projectPath: 'acme/checkout',
    number: PR_NUMBER,
    title: 'Add the merge switch',
    displayName: null,
    webUrl: `https://github.com/acme/checkout/pull/${PR_NUMBER}`,
    sourceBranch: 'feat/auto-merge-signoff',
    targetBranch: 'main',
    state: 'opened',
    draft: false,
    headSha: 'sha0',
    lastActedSha: null,
    lastActedAction: null,
    pipelineStatus: 'running',
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

const owner = {
  id: 'owner-1',
  projectId: 'personal',
  title: 'Add the merge switch',
  agentProjectId: 'agent-1',
  agentBranch: 'feat/auto-merge-signoff',
  parentTaskId: null,
  pickedVariantId: null,
} as unknown as Task;

/** Dispatches by method+URL: the pre-read GET that decides idempotency, and the GraphQL
 *  mutation itself — `initialAutoMerge` is the PR's `auto_merge` field the GET reports,
 *  which is what `enableAutoMerge`/`disableAutoMerge` both branch on before mutating. */
function stubFetch(
  initialAutoMerge: unknown,
): Array<{ url: string; method: string; body?: Record<string, unknown> }> {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const json = (body: unknown, status = 200) => ({
    ok: true,
    status,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  });
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url: u, method, body });

    if (method === 'GET' && /\/pulls\/\d+$/.test(u)) {
      return json({
        number: PR_NUMBER,
        state: 'open',
        node_id: 'PR_test123',
        auto_merge: initialAutoMerge,
      });
    }
    if (method === 'POST' && u.endsWith('/graphql')) {
      const query = String(body?.query ?? '');
      if (query.includes('enablePullRequestAutoMerge')) {
        return json({
          data: { enablePullRequestAutoMerge: { pullRequest: { number: PR_NUMBER } } },
        });
      }
      if (query.includes('disablePullRequestAutoMerge')) {
        return json({ data: { disablePullRequestAutoMerge: { clientMutationId: null } } });
      }
    }
    throw new Error(`unexpected fetch ${method} ${u}`);
  }) as unknown as typeof fetch;
  return calls;
}

function depsFor(opts: {
  repo: string;
  attachments?: TaskAttachment[];
  activity?: Array<{ kind: 'comment'; id: number; body: string; createdAt: number }>;
  notes: string[];
  mrs: MergeRequest[];
  autoMergeOnGreen?: boolean;
}): VisualSignOffDeps {
  const project = {
    id: 'agent-1',
    autoMergeOnGreen: opts.autoMergeOnGreen ?? true,
    autoMergeMethod: 'squash',
  } as unknown as Project;

  return {
    getTask: (id) => (id === owner.id ? owner : undefined),
    getProject: (id) => (id === project.id ? project : undefined),
    getSettings: () =>
      ({
        github: { enabled: true, baseUrl: 'https://api.github.com' },
      }) as unknown as AppSettings,
    listMergeRequests: () => opts.mrs,
    listAttachments: () => opts.attachments ?? [],
    listActivity: () => (opts.activity ?? []) as unknown as TaskActivityEntry[],
    inspect: async () => ({ cwd: opts.repo, branch: 'feat/auto-merge-signoff', base: 'main' }),
    tokenFor: () => TOKEN,
    note: (_projectId, _taskId, body) => {
      opts.notes.push(body);
    },
    appMergeAttempts: new Map(),
  };
}

describe('applyVisualSignOff — VisualSignOff Approve enables auto-merge', () => {
  it('(a) enables auto-merge on GitHub when a UI card is approved', async () => {
    const { work, repo } = setupRepo('approved');
    try {
      const calls = stubFetch(null);
      const notes: string[] = [];
      const attachments = [
        attachment({ id: 'att-1', name: 'board-light.png' }),
        attachment({ id: 'att-2', name: 'board-light-mockup.png' }),
      ];
      const activity = [
        { kind: 'comment' as const, id: 1, body: formatSignOff('approved'), createdAt: 1 },
      ];
      const deps = depsFor({
        repo,
        attachments,
        activity,
        notes,
        mrs: [mr({ taskId: owner.id, state: 'opened' })],
      });

      await applyVisualSignOff(deps, owner.id, 'approved');

      const graphqlCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/graphql'));
      expect(graphqlCall).toBeDefined();
      expect(String(graphqlCall?.body?.query)).toContain('enablePullRequestAutoMerge');
      expect(notes.some((n) => n.includes('Auto-merge enabled'))).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('(b) disables auto-merge on GitHub, and never enables it, when flagged needs-changes', async () => {
    const { work, repo } = setupRepo('needs-changes');
    try {
      const calls = stubFetch({ enabledBy: { login: 'someone' } });
      const notes: string[] = [];
      const deps = depsFor({ repo, notes, mrs: [mr({ taskId: owner.id, state: 'opened' })] });

      await applyVisualSignOff(deps, owner.id, 'needs-changes');

      const graphqlCalls = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/graphql'));
      expect(graphqlCalls).toHaveLength(1);
      expect(String(graphqlCalls[0]?.body?.query)).toContain('disablePullRequestAutoMerge');
      expect(
        graphqlCalls.some((c) => String(c.body?.query).includes('enablePullRequestAutoMerge')),
      ).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('(c) does nothing when the card has no open merge request', async () => {
    const { work, repo } = setupRepo('no-mr');
    try {
      const calls = stubFetch(null);
      const notes: string[] = [];
      const deps = depsFor({ repo, notes, mrs: [] });

      await applyVisualSignOff(deps, owner.id, 'approved');

      expect(calls).toHaveLength(0);
      expect(notes).toHaveLength(0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('(d) does nothing when the project\'s "merge on green" setting is off', async () => {
    const { work, repo } = setupRepo('setting-off');
    try {
      const calls = stubFetch(null);
      const notes: string[] = [];
      const deps = depsFor({
        repo,
        notes,
        mrs: [mr({ taskId: owner.id, state: 'opened' })],
        autoMergeOnGreen: false,
      });

      await applyVisualSignOff(deps, owner.id, 'approved');

      expect(calls).toHaveLength(0);
      expect(notes).toHaveLength(0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('(e) turns a forge failure into a note rather than throwing', async () => {
    const { work, repo } = setupRepo('no-token');
    try {
      const notes: string[] = [];
      const deps = depsFor({ repo, notes, mrs: [mr({ taskId: owner.id, state: 'opened' })] });
      deps.tokenFor = () => null;

      await expect(applyVisualSignOff(deps, owner.id, 'approved')).resolves.toBeUndefined();

      expect(notes.some((n) => n.toLowerCase().includes('token'))).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('requestAutoMerge — the AI reviewer hook', () => {
  const uiShots = [
    attachment({ id: 'att-1', name: 'board-light.png' }),
    attachment({ id: 'att-2', name: 'board-light-mockup.png' }),
  ];
  const target: Parameters<typeof requestAutoMerge>[1]['mr'] = {
    provider: 'github',
    projectPath: 'acme/checkout',
    number: PR_NUMBER,
  };
  const ref = `#${PR_NUMBER}`;

  async function run(opts: {
    autoVisualSignOff: boolean;
    activity?: string[];
    withHook?: boolean;
  }): Promise<{ notes: string[]; hooked: Array<[string, string]> }> {
    const notes: string[] = [];
    const hooked: Array<[string, string]> = [];
    const deps: AutoMergeDeps = {
      listAttachments: () => uiShots,
      listActivity: () =>
        (opts.activity ?? []).map((body, i) => ({
          kind: 'comment' as const,
          id: i + 1,
          body,
          createdAt: i + 1,
        })),
      note: (_projectId, _taskId, body) => {
        notes.push(body);
      },
      ...(opts.withHook === false
        ? {}
        : {
            onAwaitSignOff: (projectId: string, ownerId: string) => {
              hooked.push([projectId, ownerId]);
            },
          }),
    };
    await requestAutoMerge(deps, {
      project: {
        id: 'agent-1',
        autoMergeOnGreen: true,
        autoMergeMethod: 'squash',
        autoMergeBy: 'forge',
        autoVisualSignOff: opts.autoVisualSignOff,
        autoVisualSignOffMaxRounds: 2,
      },
      owner,
      mr: target,
      token: TOKEN,
      settings: {} as AppSettings,
    });
    return { notes, hooked };
  }

  it('hands an awaited sign-off to the AI reviewer and says it is checking', async () => {
    const calls = stubFetch(null);
    const { notes, hooked } = await run({ autoVisualSignOff: true });
    expect(hooked).toEqual([['agent-1', owner.id]]);
    expect(notes).toEqual([autoMergeAwaitAiReviewNote(ref)]);
    expect(calls).toHaveLength(0);
  });

  it('leaves the hold to the human, and never calls the hook, with the setting off', async () => {
    stubFetch(null);
    const { notes, hooked } = await run({ autoVisualSignOff: false });
    expect(hooked).toEqual([]);
    expect(notes).toEqual([autoMergeAwaitSignOffNote(ref)]);
  });

  it('names the human again once the reviewer has given up', async () => {
    stubFetch(null);
    const { notes, hooked } = await run({
      autoVisualSignOff: true,
      activity: [`${AI_REVIEW_GAVE_UP_PREFIX} 3 rounds — a human has to look.`],
    });
    expect(notes).toEqual([autoMergeAwaitSignOffNote(ref)]);
    // The reviewer is still told — it is the one that decides not to re-raise the Inbox.
    expect(hooked).toHaveLength(1);
  });

  it('names the human when no reviewer is wired', async () => {
    stubFetch(null);
    const { notes } = await run({ autoVisualSignOff: true, withHook: false });
    expect(notes).toEqual([autoMergeAwaitSignOffNote(ref)]);
  });
});

function prereqProject(
  over: Partial<AutoMergePrerequisiteProject> & { name: string },
): AutoMergePrerequisiteProject {
  return {
    path: '/repos/whatever',
    target: { kind: 'local' },
    baseBranch: 'main',
    autoMergeOnGreen: true,
    autoMergeRequiredChecks: [],
    ...over,
  } as unknown as AutoMergePrerequisiteProject;
}

function prereqDeps(
  projects: AutoMergePrerequisiteProject[],
  overrides: Partial<AutoMergePrerequisiteDeps> = {},
): AutoMergePrerequisiteDeps {
  return {
    listProjects: () => projects,
    settings: {
      github: { enabled: true, baseUrl: 'https://api.github.com' },
    } as unknown as AppSettings,
    provider: 'github',
    remoteUrl: async (cwd: string) =>
      cwd === '/repos/whatever' ? 'https://github.com/acme/checkout.git' : '',
    prerequisitesFor: async () => [],
    ...overrides,
  };
}

describe('collectAutoMergePrerequisites', () => {
  it('skips a project whose "merge on green" is off', async () => {
    const projects = [prereqProject({ name: 'Off', autoMergeOnGreen: false })];
    const deps = prereqDeps(projects, {
      prerequisitesFor: async () => ['should never be reached'],
    });

    expect(await collectAutoMergePrerequisites(deps)).toEqual([]);
  });

  it('skips a project whose origin does not belong to this provider', async () => {
    const projects = [prereqProject({ name: 'Elsewhere', path: '/repos/elsewhere' })];
    const deps = prereqDeps(projects, {
      // Both providers enabled so `pickForge` cannot fall back to "only one is on" and must
      // answer honestly off the host alone.
      settings: {
        github: { enabled: true, baseUrl: 'https://api.github.com' },
        gitlab: { enabled: true, baseUrl: 'https://gitlab.com' },
      } as unknown as AppSettings,
      remoteUrl: async () => 'https://gitlab.com/acme/checkout.git',
      prerequisitesFor: async () => ['should never be reached'],
    });

    expect(await collectAutoMergePrerequisites(deps)).toEqual([]);
  });

  it('skips a project with no origin remote at all', async () => {
    const projects = [prereqProject({ name: 'No origin', path: '/repos/none' })];
    const deps = prereqDeps(projects, {
      remoteUrl: async () => '',
      prerequisitesFor: async () => ['should never be reached'],
    });

    expect(await collectAutoMergePrerequisites(deps)).toEqual([]);
  });

  it('names the project and reports what is missing, passing owner/repo/base through', async () => {
    const projects = [prereqProject({ name: 'Task Manager', autoMergeRequiredChecks: ['gates'] })];
    const seen: Array<{ owner: string; repo: string; base: string }> = [];
    const deps = prereqDeps(projects, {
      prerequisitesFor: async (_project, owner, repo, base) => {
        seen.push({ owner, repo, base });
        return ["switch on 'Allow auto-merge'.", 'missing: docker, package.'];
      },
    });

    expect(await collectAutoMergePrerequisites(deps)).toEqual([
      {
        project: 'Task Manager',
        missing: ["switch on 'Allow auto-merge'.", 'missing: docker, package.'],
      },
    ]);
    expect(seen).toEqual([{ owner: 'acme', repo: 'checkout', base: 'main' }]);
  });

  it('leaves out a project with nothing missing', async () => {
    const projects = [prereqProject({ name: 'All good' })];
    const deps = prereqDeps(projects, { prerequisitesFor: async () => [] });

    expect(await collectAutoMergePrerequisites(deps)).toEqual([]);
  });

  it('turns a thrown prerequisite check into one generic entry, without dropping other projects', async () => {
    const projects = [
      prereqProject({ name: 'Admin only', path: '/repos/admin-only' }),
      prereqProject({ name: 'Fine' }),
    ];
    const deps = prereqDeps(projects, {
      remoteUrl: async (cwd: string) =>
        cwd === '/repos/whatever' || cwd === '/repos/admin-only'
          ? 'https://github.com/acme/checkout.git'
          : '',
      prerequisitesFor: async (project) => {
        if (project.name === 'Admin only') throw new Error('403 Forbidden');
        return [];
      },
    });

    const result = await collectAutoMergePrerequisites(deps);
    expect(result).toEqual([
      {
        project: 'Admin only',
        missing: ['Could not read branch protection — 403 Forbidden; check it by hand.'],
      },
    ]);
  });

  it('resolves a GitLab subgroup path as owner plus a multi-segment repo', async () => {
    const projects = [prereqProject({ name: 'Nested', path: '/repos/nested' })];
    const seen: Array<{ owner: string; repo: string }> = [];
    const deps = prereqDeps(projects, {
      provider: 'gitlab',
      settings: {
        gitlab: { enabled: true, baseUrl: 'https://gitlab.com' },
      } as unknown as AppSettings,
      remoteUrl: async () => 'https://gitlab.com/group/sub/proj.git',
      prerequisitesFor: async (_project, owner, repo) => {
        seen.push({ owner, repo });
        return [];
      },
    });

    await collectAutoMergePrerequisites(deps);
    expect(seen).toEqual([{ owner: 'group', repo: 'sub/proj' }]);
  });
});

describe('requestAutoMerge — falling back to the app', () => {
  /** A GitHub stub whose PR read succeeds and whose auto-merge mutation answers `status`
   *  with `message`. */
  function stubRefusal(status: number, message: string) {
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (url: unknown, init?: { method?: string }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      calls.push({ url: u, method });
      if (method === 'GET' && /\/pulls\/\d+$/.test(u)) {
        return new Response(
          JSON.stringify({ number: PR_NUMBER, state: 'open', node_id: 'PR_x', auto_merge: null }),
          { status: 200 },
        );
      }
      if (method === 'POST' && u.endsWith('/graphql')) {
        return new Response(JSON.stringify({ message }), {
          status,
          statusText: status === 403 ? 'Forbidden' : 'Unauthorized',
        });
      }
      throw new Error(`unexpected fetch ${method} ${u}`);
    }) as unknown as typeof fetch;
    return calls;
  }

  function run(project: Partial<Project>, notes: string[]) {
    const deps: AutoMergeDeps = {
      listAttachments: () => [],
      listActivity: () => [],
      note: (_p, _t, body) => {
        notes.push(body);
      },
    };
    return requestAutoMerge(deps, {
      project: {
        id: 'agent-1',
        autoMergeOnGreen: true,
        autoMergeMethod: 'squash',
        autoMergeBy: 'forge',
        autoVisualSignOff: false,
        autoVisualSignOffMaxRounds: 2,
        ...project,
      },
      owner: { id: 'owner-1' },
      mr: { provider: 'github', projectPath: 'acme/checkout', number: PR_NUMBER },
      token: TOKEN,
      settings: { github: { baseUrl: 'https://api.github.com' } } as unknown as AppSettings,
    });
  }

  it('writes the app-fallback note on a 403 "Upgrade to GitHub Pro" refusal', async () => {
    stubRefusal(
      403,
      'Upgrade to GitHub Pro or make this repository public to enable this feature.',
    );
    const notes: string[] = [];
    await run({}, notes);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^Auto-merge is not available on #42 — /);
    expect(notes[0]).toContain('Task Manager will merge it itself once it is green.');
  });

  it('keeps the generic failure note on a 401', async () => {
    stubRefusal(401, 'Bad credentials');
    const notes: string[] = [];
    await run({}, notes);
    expect(notes).toHaveLength(1);
    expect(notes[0]).not.toMatch(/^Auto-merge is not available/);
    expect(notes[0]).toContain('Bad credentials');
  });

  it('never calls enableAutoMerge in app mode, and notes the mode once', async () => {
    const calls = stubRefusal(403, 'unused');
    const notes: string[] = [];
    await run({ autoMergeBy: 'app' }, notes);
    expect(calls).toEqual([]);
    expect(notes).toEqual(['Task Manager will merge #42 itself once its checks pass.']);
  });
});
