/**
 * `DiffService.resolvePrLocal` and `pruneReviewRefs` against a fake `ReviewRefGit` and a fake
 * `DiffGit`: matching a pull request to a project already cloned on this machine through its
 * remotes, the one `fetchRefspecs` call, the stale/fetch-failed/no-project walls, and pruning
 * scratch refs nothing still wants.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '@shared/model';
import { LOCAL_REF_CAPABILITIES, type ReviewSubject } from '@shared/review';
import { REVIEW_REF_PREFIX, reviewRef } from '../git';
import {
  computeDiffId,
  DiffService,
  type DiffGit,
  type DiffServiceDeps,
  type PrLocalRequest,
  type ReviewRefGit,
} from './diffService';

const HOST = 'github.com';
const REPO_PATH = 'acme/widgets';
const FORGE_HEAD_SHA = 'f'.repeat(40);
const BASE_SHA = 'b'.repeat(40);

function prSubject(
  over: Partial<Extract<ReviewSubject, { kind: 'pr' }>> = {},
): Extract<ReviewSubject, { kind: 'pr' }> {
  return { kind: 'pr', provider: 'github', repoId: 1, repoPath: REPO_PATH, number: 7, ...over };
}

function prRequest(over: Partial<PrLocalRequest> = {}): PrLocalRequest {
  return { subject: prSubject(), host: HOST, headSha: FORGE_HEAD_SHA, baseBranch: 'main', ...over };
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    path: '/repo',
    useWorktrees: true,
    baseBranch: 'main',
    target: { kind: 'local' },
    ...over,
  } as unknown as Project;
}

interface RefGitState {
  remotes: { name: string; fetchUrl: string; pushUrl: string }[];
  fetchQueue: Array<{ code: number; stderr: string }>;
  refs: string[];
}

/** A recording fake: `fetchCalls`/`deleteCalls` say exactly what each ticket case checks for. */
function fakeRefGit(s: RefGitState): ReviewRefGit & {
  fetchCalls: Array<{ remoteOrUrl: string; specs: readonly string[] }>;
  deleteCalls: string[];
} {
  const fetchCalls: Array<{ remoteOrUrl: string; specs: readonly string[] }> = [];
  const deleteCalls: string[] = [];
  return {
    fetchCalls,
    deleteCalls,
    async listRemotes() {
      return s.remotes;
    },
    async fetchRefspecs(_dir, remoteOrUrl, specs) {
      fetchCalls.push({ remoteOrUrl, specs });
      const next = s.fetchQueue.shift() ?? { code: 0, stderr: '' };
      return { code: next.code, stdout: '', stderr: next.stderr };
    },
    async listRefs(_dir, prefix) {
      return s.refs.filter((r) => r.startsWith(prefix));
    },
    async deleteRefs(_dir, prefix) {
      deleteCalls.push(prefix);
      s.refs = s.refs.filter((r) => !r.startsWith(prefix));
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

interface DiffGitState {
  revParseQueue: string[];
  mergeBaseSha: string;
}

function fakeDiffGit(s: DiffGitState): DiffGit & { revParseCalls: string[] } {
  const revParseCalls: string[] = [];
  return {
    revParseCalls,
    async revParse(_dir, ref) {
      revParseCalls.push(ref);
      return s.revParseQueue.shift() ?? '';
    },
    branchExists: async () => true,
    currentBranch: async () => 'main',
    async mergeBase() {
      return s.mergeBaseSha;
    },
    rebaseInProgress: async () => false,
    conflictedFiles: async () => [],
    workingTreeFingerprint: async () => '',
    nameStatus: async () => [],
    workingTree: async () => [],
    filePatch: async () => null,
    fileSizes: async () => new Map(),
    fileSize: async () => -1,
    readFile: async () => null,
  };
}

function service(opts: {
  projects: Project[];
  refGit: ReviewRefGit;
  diffGit: DiffGit;
}): DiffService {
  const deps: DiffServiceDeps = {
    getTask: () => undefined,
    getProject: () => undefined,
    inspect: async () => null,
    gitFor: () => opts.diffGit,
    listMergeRequests: () => [],
    listProjects: () => opts.projects,
    refGitFor: () => opts.refGit,
  };
  return new DiffService(deps);
}

describe('resolvePrLocal', () => {
  it('matches a fork PR through upstream, fetches, and resolves ok', async () => {
    const refState: RefGitState = {
      remotes: [
        { name: 'origin', fetchUrl: 'https://github.com/me/widgets.git', pushUrl: '' },
        { name: 'upstream', fetchUrl: 'https://github.com/acme/widgets.git', pushUrl: '' },
      ],
      fetchQueue: [{ code: 0, stderr: '' }],
      refs: [],
    };
    const diffState: DiffGitState = { revParseQueue: [FORGE_HEAD_SHA], mergeBaseSha: BASE_SHA };
    const refGit = fakeRefGit(refState);
    const diffGit = fakeDiffGit(diffState);
    const svc = service({ projects: [project()], refGit, diffGit });

    const result = await svc.resolvePrLocal(prRequest());

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.resolved).toMatchObject({
      dir: '/repo',
      baseRef: 'main',
      baseSha: BASE_SHA,
      headSha: FORGE_HEAD_SHA,
      to: FORGE_HEAD_SHA,
      includesWorkingTree: false,
      source: 'local-ref',
      subjectId: 'gh-1-7',
      capabilities: LOCAL_REF_CAPABILITIES,
      diffId: computeDiffId(BASE_SHA, FORGE_HEAD_SHA, 'local-ref'),
    });
    expect(refGit.fetchCalls).toEqual([
      {
        remoteOrUrl: 'upstream',
        specs: [
          `+refs/pull/7/head:${reviewRef('gh-1-7', 'head')}`,
          `+refs/heads/main:${reviewRef('gh-1-7', 'base')}`,
        ],
      },
    ]);
  });

  it('returns stale after exactly two fetches when the head keeps moving', async () => {
    const refState: RefGitState = {
      remotes: [{ name: 'origin', fetchUrl: 'https://github.com/acme/widgets.git', pushUrl: '' }],
      fetchQueue: [
        { code: 0, stderr: '' },
        { code: 0, stderr: '' },
      ],
      refs: [],
    };
    const diffState: DiffGitState = {
      revParseQueue: ['a'.repeat(40), 'c'.repeat(40)],
      mergeBaseSha: BASE_SHA,
    };
    const refGit = fakeRefGit(refState);
    const diffGit = fakeDiffGit(diffState);
    const svc = service({ projects: [project()], refGit, diffGit });

    const result = await svc.resolvePrLocal(prRequest());

    expect(result).toEqual({
      status: 'stale',
      headSha: 'c'.repeat(40),
      forgeHeadSha: FORGE_HEAD_SHA,
    });
    expect(refGit.fetchCalls).toHaveLength(2);
  });

  it('resolves ok when the second revParse matches after the retry fetch', async () => {
    const refState: RefGitState = {
      remotes: [{ name: 'origin', fetchUrl: 'https://github.com/acme/widgets.git', pushUrl: '' }],
      fetchQueue: [
        { code: 0, stderr: '' },
        { code: 0, stderr: '' },
      ],
      refs: [],
    };
    const diffState: DiffGitState = {
      revParseQueue: ['a'.repeat(40), FORGE_HEAD_SHA],
      mergeBaseSha: BASE_SHA,
    };
    const refGit = fakeRefGit(refState);
    const diffGit = fakeDiffGit(diffState);
    const svc = service({ projects: [project()], refGit, diffGit });

    const result = await svc.resolvePrLocal(prRequest());

    expect(result.status).toBe('ok');
    expect(refGit.fetchCalls).toHaveLength(2);
  });

  it('returns no-project with no fetch made when no remote matches', async () => {
    const refState: RefGitState = {
      remotes: [{ name: 'origin', fetchUrl: 'https://github.com/other/repo.git', pushUrl: '' }],
      fetchQueue: [],
      refs: [],
    };
    const refGit = fakeRefGit(refState);
    const diffGit = fakeDiffGit({ revParseQueue: [], mergeBaseSha: BASE_SHA });
    const svc = service({ projects: [project()], refGit, diffGit });

    const result = await svc.resolvePrLocal(prRequest());

    expect(result).toEqual({ status: 'no-project' });
    expect(refGit.fetchCalls).toHaveLength(0);
  });

  it('returns fetch-failed with the reason, records it, and clears it on a later success', async () => {
    const refState: RefGitState = {
      remotes: [{ name: 'origin', fetchUrl: 'https://github.com/acme/widgets.git', pushUrl: '' }],
      fetchQueue: [{ code: 128, stderr: '\nfatal: Authentication failed\nmore detail\n' }],
      refs: [],
    };
    const diffState: DiffGitState = { revParseQueue: [], mergeBaseSha: BASE_SHA };
    const refGit = fakeRefGit(refState);
    const diffGit = fakeDiffGit(diffState);
    const svc = service({ projects: [project()], refGit, diffGit });

    const failed = await svc.resolvePrLocal(prRequest());
    expect(failed).toEqual({ status: 'fetch-failed', reason: 'fatal: Authentication failed' });
    expect(svc.fetchFailureFor('gh-1-7')).toBe('fatal: Authentication failed');

    // A later success clears the recorded failure.
    refState.fetchQueue.push({ code: 0, stderr: '' });
    diffState.revParseQueue.push(FORGE_HEAD_SHA);
    const ok = await svc.resolvePrLocal(prRequest());
    expect(ok.status).toBe('ok');
    expect(svc.fetchFailureFor('gh-1-7')).toBeNull();
  });

  it('builds the GitLab merge-request refspec', async () => {
    const refState: RefGitState = {
      remotes: [{ name: 'origin', fetchUrl: 'https://gitlab.com/acme/widgets.git', pushUrl: '' }],
      fetchQueue: [{ code: 0, stderr: '' }],
      refs: [],
    };
    const diffState: DiffGitState = { revParseQueue: [FORGE_HEAD_SHA], mergeBaseSha: BASE_SHA };
    const refGit = fakeRefGit(refState);
    const diffGit = fakeDiffGit(diffState);
    const svc = service({ projects: [project()], refGit, diffGit });

    const req = prRequest({
      subject: prSubject({ provider: 'gitlab', repoId: 1, number: 8 }),
      host: 'gitlab.com',
    });
    const result = await svc.resolvePrLocal(req);

    expect(result.status).toBe('ok');
    expect(refGit.fetchCalls).toEqual([
      {
        remoteOrUrl: 'origin',
        specs: [
          `+refs/merge-requests/8/head:${reviewRef('gl-1-8', 'head')}`,
          `+refs/heads/main:${reviewRef('gl-1-8', 'base')}`,
        ],
      },
    ]);
  });
});

describe('pruneReviewRefs', () => {
  it('deletes only the refs for subject ids not in keep', async () => {
    const refState: RefGitState = {
      remotes: [],
      fetchQueue: [],
      refs: [
        reviewRef('gh-1-7', 'head'),
        reviewRef('gh-1-7', 'base'),
        reviewRef('gh-1-8', 'head'),
        reviewRef('gh-1-8', 'base'),
      ],
    };
    const refGit = fakeRefGit(refState);
    const diffGit = fakeDiffGit({ revParseQueue: [], mergeBaseSha: '' });
    const svc = service({ projects: [project()], refGit, diffGit });

    await svc.pruneReviewRefs(new Set(['gh-1-8']));

    expect(refGit.deleteCalls).toEqual([`${REVIEW_REF_PREFIX}gh-1-7`]);
    expect(refState.refs).toEqual([reviewRef('gh-1-8', 'head'), reviewRef('gh-1-8', 'base')]);
  });
});
