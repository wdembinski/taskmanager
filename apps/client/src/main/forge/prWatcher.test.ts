/**
 * `watchMergeRequests` — the dispatch and the dependency wiring, against fakes.
 *
 * `prWatchAction` (its decision) is pure and already covered by `mergeRequest.test.ts`. What
 * this file is about is everything AROUND that decision: which task a row resolves to, that
 * each row is handled independently, and that each action reaches the dependency it is
 * supposed to (a real `fetch` for the rebase action, stubbed the same way
 * `forge/linkPr.test.ts` stubs its own entry point). The end-to-end proof — a REAL scheduler
 * resuming a REAL session in a REAL worktree — is `scripts/verify-pr-watch.mjs`, which this
 * complements rather than duplicates.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatRefusal, ChatSendResult, Task } from '@shared/model';
import type { MergeRequest } from '@shared/mergeRequest';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settings';
import { watchMergeRequests, type PrWatcherDeps } from './prWatcher';

/** A full `MergeRequest` row. `pipelineStatus: 'running'` and no conflict/rebase by default,
 * so the baseline action is 'none' and each test opts into the action it is about. */
function mr(over: Partial<MergeRequest> = {}): MergeRequest {
  return {
    id: 'gl-9-1',
    taskId: null,
    openedForTaskId: 'task-1',
    provider: 'gitlab',
    repoId: 9,
    projectPath: 'acme/web',
    number: 1,
    title: 'Fix the thing',
    displayName: null,
    webUrl: 'https://gitlab.example.com/acme/web/-/merge_requests/1',
    sourceBranch: 'feature/x',
    targetBranch: 'main',
    state: 'opened',
    draft: false,
    headSha: 'sha0',
    lastActedSha: null,
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

/** Any id back as a task carrying that same id — enough for `watchOne`'s own lookup. */
function task(id: string, projectId = 'project-1'): Task {
  return {
    id,
    projectId,
    phase: 'proj',
    title: 'A card',
    status: 'pending',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'jira',
    isContract: false,
    isScaffold: false,
  } as Task;
}

function settings(prAutoResolve = true, over: Partial<AppSettings> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    features: { ...DEFAULT_SETTINGS.features, prAutoResolve },
    gitlab: { ...DEFAULT_SETTINGS.gitlab, baseUrl: 'https://gitlab.example.com' },
    github: { ...DEFAULT_SETTINGS.github, baseUrl: 'https://api.github.com' },
    ...over,
  };
}

interface Rig {
  deps: PrWatcherDeps;
  notes: Array<{ projectId: string; taskId: string; body: string }>;
  marked: Array<{ mrId: string; headSha: string }>;
  chatCalls: Array<{ taskId: string; message: string }>;
}

function rig(partial: Partial<PrWatcherDeps> = {}): Rig {
  const notes: Rig['notes'] = [];
  const marked: Rig['marked'] = [];
  const chatCalls: Rig['chatCalls'] = [];
  const deps: PrWatcherDeps = {
    getSettings: () => settings(),
    getTask: (id) => task(id),
    tokenFor: () => 'a-token',
    chatWithAgent: (taskId, message): ChatSendResult => {
      chatCalls.push({ taskId, message });
      return { status: 'resumed', taskId, runId: 'run-1' };
    },
    note: (projectId, taskId, body) => notes.push({ projectId, taskId, body }),
    markActed: (mrId, headSha) => marked.push({ mrId, headSha }),
    ...partial,
  };
  return { deps, notes, marked, chatCalls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('watchMergeRequests: the feature gate', () => {
  it('does nothing while the switch is off — never even looks up the card', async () => {
    const getTask = vi.fn();
    const { deps } = rig({ getSettings: () => settings(false), getTask });
    await watchMergeRequests([mr({ detailedMergeStatus: 'conflict', hasConflicts: true })], deps);
    expect(getTask).not.toHaveBeenCalled();
  });
});

describe('watchMergeRequests: which task a row resolves to', () => {
  it('prefers openedForTaskId over the guessed taskId', async () => {
    const getTask = vi.fn((id: string) => task(id));
    const { deps } = rig({ getTask });
    await watchMergeRequests([mr({ openedForTaskId: 'opened-1', taskId: 'guessed-1' })], deps);
    expect(getTask).toHaveBeenCalledWith('opened-1');
    expect(getTask).not.toHaveBeenCalledWith('guessed-1');
  });

  it('falls back to the guessed taskId when nothing opened it', async () => {
    const getTask = vi.fn((id: string) => task(id));
    const { deps } = rig({ getTask });
    await watchMergeRequests([mr({ openedForTaskId: null, taskId: 'guessed-1' })], deps);
    expect(getTask).toHaveBeenCalledWith('guessed-1');
  });

  it('does nothing when neither is known', async () => {
    const getTask = vi.fn();
    const { deps } = rig({ getTask });
    await watchMergeRequests([mr({ openedForTaskId: null, taskId: null })], deps);
    expect(getTask).not.toHaveBeenCalled();
  });

  it('does nothing when the card no longer exists', async () => {
    const { deps, notes } = rig({ getTask: () => undefined });
    await watchMergeRequests([mr({ detailedMergeStatus: 'conflict', hasConflicts: true })], deps);
    expect(notes).toEqual([]);
  });
});

describe('watchMergeRequests: a row with nothing to report', () => {
  it('calls neither note nor markActed', async () => {
    const { deps, notes, marked, chatCalls } = rig();
    await watchMergeRequests([mr()], deps); // pipelineStatus: 'running' — no verdict yet
    expect(notes).toEqual([]);
    expect(marked).toEqual([]);
    expect(chatCalls).toEqual([]);
  });
});

describe('watchMergeRequests: forge-rebase', () => {
  it('PUTs the GitLab rebase endpoint and notes it, naming the forge', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { deps, notes, marked } = rig();
    const row = mr({ detailedMergeStatus: 'need_rebase', headSha: 'sha-rebase' });

    await watchMergeRequests([row], deps);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://gitlab.example.com/api/v4/projects/9/merge_requests/1/rebase',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(notes).toEqual([
      {
        projectId: 'project-1',
        taskId: 'task-1',
        body: '!1 had fallen behind "main" — asked GitLab to rebase it.',
      },
    ]);
    expect(marked).toEqual([{ mrId: row.id, headSha: 'sha-rebase' }]);
  });

  it('PUTs the GitHub update-branch endpoint for a pull request that has fallen behind', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { deps, notes } = rig();
    const row = mr({
      id: 'gh-42-7',
      provider: 'github',
      projectPath: 'acme/web2',
      repoId: 42,
      number: 7,
      detailedMergeStatus: 'behind', // GitHub's own spelling of "needs a rebase"
      headSha: 'sha-rebase-gh',
    });

    await watchMergeRequests([row], deps);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/web2/pulls/7/update-branch',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(notes[0]?.body).toBe('#7 had fallen behind "main" — asked GitHub to rebase it.');
  });

  it('names a malformed GitHub repository path instead of crashing blind', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { deps, notes, marked } = rig();
    const row = mr({
      id: 'gh-42-7',
      provider: 'github',
      projectPath: 'not-a-valid-path',
      detailedMergeStatus: 'behind',
      headSha: 'sha-malformed',
    });

    await watchMergeRequests([row], deps);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(notes[0]?.body).toContain('Malformed GitHub repository path: not-a-valid-path');
    expect(marked).toEqual([]);
  });

  it('notes a failed attempt without marking the commit acted on, so the next sync retries', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { deps, notes, marked } = rig({ tokenFor: () => null });
    const row = mr({ detailedMergeStatus: 'need_rebase', headSha: 'sha-no-token' });

    await watchMergeRequests([row], deps);

    expect(fetchMock).not.toHaveBeenCalled(); // refused before ever reaching the forge
    expect(notes).toEqual([
      {
        projectId: 'project-1',
        taskId: 'task-1',
        body: 'Could not act on !1: No GitLab token is saved — add one in Settings.',
      },
    ]);
    expect(marked).toEqual([]);
  });
});

describe('watchMergeRequests: resolve-conflicts', () => {
  it('asks the agent to resolve it, naming the MR, its URL and both branches', async () => {
    const { deps, notes, chatCalls, marked } = rig();
    const row = mr({
      detailedMergeStatus: 'conflict',
      hasConflicts: true,
      headSha: 'sha-conflict',
      sourceBranch: 'feature/thing',
      targetBranch: 'develop',
    });

    await watchMergeRequests([row], deps);

    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]?.taskId).toBe('task-1');
    expect(chatCalls[0]?.message).toContain('!1');
    expect(chatCalls[0]?.message).toContain(row.webUrl);
    expect(chatCalls[0]?.message).toContain('feature/thing');
    expect(chatCalls[0]?.message).toContain('develop');
    expect(notes).toEqual([
      {
        projectId: 'project-1',
        taskId: 'task-1',
        body: '!1 has a merge conflict — asked the agent to resolve it.',
      },
    ]);
    expect(marked).toEqual([{ mrId: row.id, headSha: 'sha-conflict' }]);
  });

  it('wins over a stale branch — nothing can be fixed until the conflict is', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { deps, chatCalls } = rig();
    // Both conditions at once: the row's own conflict flag AND a forge status that would,
    // on its own, call for a rebase.
    const row = mr({
      hasConflicts: true,
      detailedMergeStatus: 'need_rebase',
      headSha: 'sha-both',
    });
    await watchMergeRequests([row], deps);
    expect(chatCalls).toHaveLength(1); // asked the agent, not the forge
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const refusals: ReadonlyArray<readonly [ChatRefusal, string]> = [
    ['never-ran', 'this card has never run, so there is no conversation to continue'],
    ['limit', 'a usage limit is holding all work right now'],
    ['signed-out', 'claude is signed out'],
    ['awaiting-decision', 'the card is already waiting on a decision'],
    ['chain-busy', 'the card is mid-chain'],
    ['not-running', 'the app is shutting down'],
    ['unknown-task', 'unknown-task'], // the default branch: the raw reason, verbatim
  ];

  it.each(refusals)(
    'explains a %s refusal in words a human can act on',
    async (reason, explanation) => {
      const { deps, notes, marked } = rig({
        chatWithAgent: (taskId): ChatSendResult => ({ status: 'refused', taskId, reason }),
      });
      const row = mr({
        detailedMergeStatus: 'conflict',
        hasConflicts: true,
        headSha: 'sha-refused',
      });

      await watchMergeRequests([row], deps);

      expect(notes[0]?.body).toBe(
        `!1 has a merge conflict, but it could not be handed to the agent (${explanation}). ` +
          'Resolve it by hand, or ask again from the card.',
      );
      // A refusal is not a thrown error — the attempt succeeded in asking, it just could not
      // be delivered, so the commit is still considered "looked at" for this head SHA.
      expect(marked).toEqual([{ mrId: row.id, headSha: 'sha-refused' }]);
    },
  );
});

describe('watchMergeRequests: pipeline notes', () => {
  it('notes a failed pipeline, with its URL', async () => {
    const { deps, notes, marked } = rig();
    const row = mr({
      pipelineStatus: 'failed',
      pipelineUrl: 'https://gitlab.example.com/acme/web/-/pipelines/999',
      headSha: 'sha-pipeline-failed',
    });
    await watchMergeRequests([row], deps);
    expect(notes).toEqual([
      {
        projectId: 'project-1',
        taskId: 'task-1',
        body: "!1's pipeline failed: https://gitlab.example.com/acme/web/-/pipelines/999",
      },
    ]);
    expect(marked).toEqual([{ mrId: row.id, headSha: 'sha-pipeline-failed' }]);
  });

  it('notes a passed pipeline, distinctly', async () => {
    const { deps, notes } = rig();
    const row = mr({ pipelineStatus: 'success', headSha: 'sha-pipeline-passed' });
    await watchMergeRequests([row], deps);
    expect(notes).toEqual([
      { projectId: 'project-1', taskId: 'task-1', body: "!1's pipeline passed." },
    ]);
  });
});

describe('watchMergeRequests: each row is independent', () => {
  it('a failing row does not stop the rest of the batch from being handled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { deps, notes } = rig({ tokenFor: () => null, getTask: (id) => task(id) });

    const failing = mr({
      id: 'gl-9-1',
      openedForTaskId: 'task-a',
      detailedMergeStatus: 'need_rebase',
      headSha: 'sha-a',
    });
    const passing = mr({
      id: 'gl-9-2',
      number: 2,
      openedForTaskId: 'task-b',
      pipelineStatus: 'success',
      headSha: 'sha-b',
    });

    await watchMergeRequests([failing, passing], deps);

    expect(notes.find((n) => n.taskId === 'task-a')?.body).toContain('Could not act on');
    expect(notes.find((n) => n.taskId === 'task-b')?.body).toBe("!2's pipeline passed.");
  });
});
