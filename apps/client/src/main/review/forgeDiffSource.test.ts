/**
 * `ForgeDiffSource` against recording fakes of `GitHubClient`/`GitLabClient` — modeled on
 * `diffService.prLocal.test.ts`'s fakes, counting calls per method rather than mocking
 * `fetch`. Reuses the F15.7 fixtures (`pullRequestFiles.ts`, `mergeRequestDiffs.ts`) where
 * their shape fits.
 */
import { describe, expect, it } from 'vitest';
import {
  DIFF_FILE_MAX_BYTES,
  DIFF_IMAGE_MAX_BYTES,
  DIFF_SUMMARY_MAX_FILES,
  FORGE_API_CAPABILITIES,
  parseHunks,
  type DiffFileResult,
  type DiffImageResult,
} from '@shared/review';
import {
  GitHubError,
  type GitHubClient,
  type GitHubPullRequest,
  type GitHubPullRequestFile,
} from '../github/githubClient';
import {
  GitLabError,
  type GitLabClient,
  type GitLabMergeRequest,
  type GitLabMergeRequestDiff,
} from '../gitlab/gitlabClient';
import {
  pullRequestFilesPage1,
  pullRequestFilesPage2,
} from '../github/__fixtures__/pullRequestFiles';
import {
  mergeRequestChangesBody,
  mergeRequestDiffsPage1,
} from '../gitlab/__fixtures__/mergeRequestDiffs';
import { computeDiffId } from './diffService';
import { ForgeDiffSource, type PrSubject } from './forgeDiffSource';

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const OTHER_HEAD_SHA = 'c'.repeat(40);

function githubSubject(over: Partial<PrSubject> = {}): PrSubject {
  return { kind: 'pr', provider: 'github', repoId: 1, repoPath: 'acme/web', number: 7, ...over };
}

function gitlabSubject(over: Partial<PrSubject> = {}): PrSubject {
  return { kind: 'pr', provider: 'gitlab', repoId: 1, repoPath: 'acme/web', number: 7, ...over };
}

function githubPr(over: Partial<GitHubPullRequest> = {}): GitHubPullRequest {
  return {
    id: 1,
    number: 7,
    title: 't',
    state: 'open',
    html_url: 'https://github.com/acme/web/pull/7',
    head: { sha: HEAD_SHA, ref: 'feature' },
    base: { sha: BASE_SHA, ref: 'main' },
    ...over,
  };
}

function gitlabMr(over: Partial<GitLabMergeRequest> = {}): GitLabMergeRequest {
  return {
    id: 1,
    iid: 7,
    project_id: 1,
    title: 't',
    state: 'opened',
    web_url: '',
    source_branch: 'feature',
    target_branch: 'main',
    updated_at: '',
    sha: HEAD_SHA,
    diff_refs: { base_sha: BASE_SHA, head_sha: HEAD_SHA },
    ...over,
  };
}

interface GitHubFakeState {
  pr: GitHubPullRequest;
  files: GitHubPullRequestFile[];
  truncated?: boolean;
  /** `ref:path` → bytes. */
  rawBytes: Map<string, Buffer>;
  prError?: unknown;
  filesError?: unknown;
  /** Overrides `pr`/`files` for one specific PR number, for tests with several subjects. */
  byNumber?: Map<number, { pr: GitHubPullRequest; files: GitHubPullRequestFile[] }>;
}

interface GitHubFakeCalls {
  pr: number;
  files: number;
  raw: number;
}

function fakeGitHubClient(state: GitHubFakeState): GitHubClient & { calls: GitHubFakeCalls } {
  const calls: GitHubFakeCalls = { pr: 0, files: 0, raw: 0 };
  return {
    calls,
    async getPullRequest(_owner: string, _repo: string, number: number) {
      calls.pr += 1;
      if (state.prError) throw state.prError;
      return state.byNumber?.get(number)?.pr ?? state.pr;
    },
    async listPullRequestFiles(_owner: string, _repo: string, number: number) {
      calls.files += 1;
      if (state.filesError) throw state.filesError;
      const files = state.byNumber?.get(number)?.files ?? state.files;
      return { files, truncated: state.truncated ?? false };
    },
    async getRawFileBytes(_owner: string, _repo: string, path: string, ref: string) {
      calls.raw += 1;
      const bytes = state.rawBytes.get(`${ref}:${path}`);
      if (!bytes) throw new Error(`no fixture bytes for ${ref}:${path}`);
      return bytes;
    },
  } as unknown as GitHubClient & { calls: GitHubFakeCalls };
}

interface GitLabFakeState {
  mr: GitLabMergeRequest;
  diffs: GitLabMergeRequestDiff[];
  truncated?: boolean;
  rawBytes: Map<string, Buffer>;
  mrError?: unknown;
  diffsError?: unknown;
}

interface GitLabFakeCalls {
  mr: number;
  diffs: number;
  raw: number;
}

function fakeGitLabClient(state: GitLabFakeState): GitLabClient & { calls: GitLabFakeCalls } {
  const calls: GitLabFakeCalls = { mr: 0, diffs: 0, raw: 0 };
  return {
    calls,
    async getMergeRequestByPath() {
      calls.mr += 1;
      if (state.mrError) throw state.mrError;
      return state.mr;
    },
    async listMergeRequestDiffs() {
      calls.diffs += 1;
      if (state.diffsError) throw state.diffsError;
      return {
        diffs: state.diffs,
        truncated: state.truncated ?? false,
        endpoint: 'diffs' as const,
      };
    },
    async getRawFileBytes(_projectId: number | string, path: string, ref: string) {
      calls.raw += 1;
      const bytes = state.rawBytes.get(`${ref}:${path}`);
      if (!bytes) throw new Error(`no fixture bytes for ${ref}:${path}`);
      return bytes;
    },
  } as unknown as GitLabClient & { calls: GitLabFakeCalls };
}

function source(
  opts: { github?: GitHubClient | null; gitlab?: GitLabClient | null } = {},
): ForgeDiffSource {
  return new ForgeDiffSource({
    githubClient: () => opts.github ?? null,
    gitlabClient: () => opts.gitlab ?? null,
  });
}

function expectOkFile(result: DiffFileResult): Extract<DiffFileResult, { status: 'ok' }> {
  if (result.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result;
}

function expectOkImage(result: DiffImageResult): Extract<DiffImageResult, { status: 'ok' }> {
  if (result.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result;
}

describe('ForgeDiffSource.summary', () => {
  it('builds an ok GitHub summary: statuses mapped, renames carry oldPath, source/capabilities/diffId', async () => {
    const github = fakeGitHubClient({
      pr: githubPr(),
      files: [...pullRequestFilesPage1, ...pullRequestFilesPage2],
      rawBytes: new Map(),
    });
    const svc = source({ github });

    const summary = await svc.summary(githubSubject());

    expect(summary.diffId).toBe(computeDiffId(BASE_SHA, HEAD_SHA, 'forge'));
    expect(summary.source).toBe('forge-api');
    expect(summary.capabilities).toEqual(FORGE_API_CAPABILITIES);
    expect(summary.subjectId).toBe('gh-1-7');
    expect(summary.includesWorkingTree).toBe(false);
    expect(summary.baseSha).toBe(BASE_SHA);
    expect(summary.headSha).toBe(HEAD_SHA);

    const renamed = summary.files.find((f) => f.path === 'src/utils/format.ts');
    expect(renamed).toMatchObject({ status: 'renamed', oldPath: 'src/format.ts' });
    const removed = summary.files.find((f) => f.path === 'docs/old-notes.md');
    expect(removed?.status).toBe('deleted');
    const modified = summary.files.find((f) => f.path === 'src/app.ts');
    expect(modified).toMatchObject({
      status: 'modified',
      newBlobSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f901234567',
    });
  });

  it('builds an ok GitLab summary: statuses mapped, renames carry oldPath, source/capabilities/diffId', async () => {
    const gitlab = fakeGitLabClient({
      mr: gitlabMr(),
      diffs: mergeRequestDiffsPage1,
      rawBytes: new Map(),
    });
    const svc = source({ gitlab });

    const summary = await svc.summary(gitlabSubject());

    expect(summary.diffId).toBe(computeDiffId(BASE_SHA, HEAD_SHA, 'forge'));
    expect(summary.source).toBe('forge-api');
    expect(summary.capabilities).toEqual(FORGE_API_CAPABILITIES);
    expect(summary.subjectId).toBe('gl-1-7');

    const renamed = summary.files.find((f) => f.path === 'src/utils/format.ts');
    expect(renamed).toMatchObject({ status: 'renamed', oldPath: 'src/format.ts' });
    const modified = summary.files.find((f) => f.path === 'src/app.ts');
    expect(modified?.status).toBe('modified');
  });

  it('truncates when the client says so, with no file-count overflow', async () => {
    const github = fakeGitHubClient({
      pr: githubPr(),
      files: [pullRequestFilesPage1[0]],
      truncated: true,
      rawBytes: new Map(),
    });
    const svc = source({ github });

    const summary = await svc.summary(githubSubject());

    expect(summary.truncated).toBe(true);
    expect(summary.files).toHaveLength(1);
  });

  it('truncates when more than DIFF_SUMMARY_MAX_FILES rows come back, even if the client did not say so', async () => {
    const files: GitHubPullRequestFile[] = Array.from(
      { length: DIFF_SUMMARY_MAX_FILES + 5 },
      (_v, i) => ({
        sha: `${i}`.padStart(40, '0'),
        filename: `src/file-${i}.ts`,
        status: 'modified',
        additions: 1,
        deletions: 0,
      }),
    );
    const github = fakeGitHubClient({
      pr: githubPr(),
      files,
      truncated: false,
      rawBytes: new Map(),
    });
    const svc = source({ github });

    const summary = await svc.summary(githubSubject());

    expect(summary.truncated).toBe(true);
    expect(summary.files).toHaveLength(DIFF_SUMMARY_MAX_FILES);
  });
});

describe('ForgeDiffSource.file', () => {
  it('returns hunks equal to parseHunks(patch) for an ok file', async () => {
    const github = fakeGitHubClient({
      pr: githubPr(),
      files: [pullRequestFilesPage1[0]],
      rawBytes: new Map(),
    });
    const svc = source({ github });

    const summary = await svc.summary(githubSubject());
    const result = await svc.file(githubSubject(), summary.diffId, 'src/app.ts');

    const ok = expectOkFile(result);
    expect(ok.file.hunks).toEqual(parseHunks(pullRequestFilesPage1[0].patch ?? ''));
  });

  it('a GitHub file missing patch reads as tooLarge with an unknown byte count', async () => {
    const github = fakeGitHubClient({
      pr: githubPr(),
      files: [pullRequestFilesPage2[0]], // assets/logo.png, no patch
      rawBytes: new Map(),
    });
    const svc = source({ github });

    const summary = await svc.summary(githubSubject());
    const result = await svc.file(githubSubject(), summary.diffId, 'assets/logo.png');

    const ok = expectOkFile(result);
    expect(ok.file.hunks).toEqual([]);
    expect(ok.file.tooLarge).toEqual({ bytes: 0 });
  });

  it('a GitLab too_large file reads as tooLarge with an unknown byte count', async () => {
    const gitlab = fakeGitLabClient({
      mr: gitlabMr(),
      diffs: [mergeRequestChangesBody.changes[0]], // assets/logo.png, too_large: true
      rawBytes: new Map(),
    });
    const svc = source({ gitlab });

    const summary = await svc.summary(gitlabSubject());
    const result = await svc.file(gitlabSubject(), summary.diffId, 'assets/logo.png');

    const ok = expectOkFile(result);
    expect(ok.file.hunks).toEqual([]);
    expect(ok.file.tooLarge).toEqual({ bytes: 0 });
  });

  it('a patch over DIFF_FILE_MAX_BYTES reads as tooLarge with its real byte length', async () => {
    const hugePatch = `@@ -1,1 +1,1 @@\n-${'x'.repeat(DIFF_FILE_MAX_BYTES + 10)}\n`;
    const huge: GitHubPullRequestFile = {
      sha: 'f'.repeat(40),
      filename: 'src/huge.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      patch: hugePatch,
    };
    const github = fakeGitHubClient({ pr: githubPr(), files: [huge], rawBytes: new Map() });
    const svc = source({ github });

    const summary = await svc.summary(githubSubject());
    const result = await svc.file(githubSubject(), summary.diffId, 'src/huge.ts');

    const ok = expectOkFile(result);
    expect(ok.file.hunks).toEqual([]);
    expect(ok.file.tooLarge).toEqual({ bytes: Buffer.byteLength(hugePatch, 'utf8') });
  });

  it('throws for a path that is not part of the pull request', async () => {
    const github = fakeGitHubClient({
      pr: githubPr(),
      files: [pullRequestFilesPage1[0]],
      rawBytes: new Map(),
    });
    const svc = source({ github });

    const summary = await svc.summary(githubSubject());

    await expect(svc.file(githubSubject(), summary.diffId, 'nope.ts')).rejects.toThrow(
      "nope.ts is not part of this pull request's changes.",
    );
  });
});

describe('ForgeDiffSource staleness', () => {
  it('reports stale once summary gives a new id after the head moves, with the current id attached', async () => {
    const state: GitHubFakeState = {
      pr: githubPr(),
      files: [pullRequestFilesPage1[0]],
      rawBytes: new Map(),
    };
    const github = fakeGitHubClient(state);
    const svc = source({ github });

    const first = await svc.summary(githubSubject());
    state.pr = githubPr({ head: { sha: OTHER_HEAD_SHA, ref: 'feature' } });
    const second = await svc.summary(githubSubject());
    expect(second.diffId).not.toBe(first.diffId);

    const result = await svc.file(githubSubject(), first.diffId, 'src/app.ts');
    expect(result).toEqual({ status: 'stale', diffId: first.diffId, currentDiffId: second.diffId });
  });

  it('a fresh source asked for an id it has never seen answers stale, not ok', async () => {
    const github = fakeGitHubClient({
      pr: githubPr(),
      files: [pullRequestFilesPage1[0]],
      rawBytes: new Map(),
    });
    const svc = source({ github });

    const bogusDiffId = 'bogus-diff-id';
    const result = await svc.file(githubSubject(), bogusDiffId, 'src/app.ts');

    expect(result).toEqual({
      status: 'stale',
      diffId: bogusDiffId,
      currentDiffId: computeDiffId(BASE_SHA, HEAD_SHA, 'forge'),
    });
  });
});

describe('ForgeDiffSource LRU', () => {
  it('a hit after summary makes zero further detail or file-list calls for file/image/context', async () => {
    const logo = pullRequestFilesPage2[0]; // assets/logo.png
    const state: GitHubFakeState = {
      pr: githubPr(),
      files: [pullRequestFilesPage1[0], logo],
      rawBytes: new Map([
        [`${BASE_SHA}:assets/logo.png`, Buffer.from([1, 2, 3])],
        [`${HEAD_SHA}:assets/logo.png`, Buffer.from([1, 2, 3, 4])],
        [`${BASE_SHA}:src/app.ts`, Buffer.from('line1\nline2\nline3\n')],
        [`${HEAD_SHA}:src/app.ts`, Buffer.from('line1\nline2\nline3\n')],
      ]),
    };
    const github = fakeGitHubClient(state);
    const svc = source({ github });

    const summary = await svc.summary(githubSubject());
    expect(github.calls).toEqual({ pr: 1, files: 1, raw: 0 });

    await svc.file(githubSubject(), summary.diffId, 'src/app.ts');
    await svc.image(githubSubject(), summary.diffId, 'assets/logo.png');
    await svc.context(githubSubject(), summary.diffId, 'src/app.ts', 'new', 1, 2);

    expect(github.calls.pr).toBe(1);
    expect(github.calls.files).toBe(1);
  });

  it('evicts the oldest of 8 entries, and a later ask for it re-fetches the file list only', async () => {
    // Nine distinct subjects, each its own head SHA — nine distinct `diffId`s, so the LRU
    // (capped at 8) actually has something to evict.
    const byNumber = new Map<number, { pr: GitHubPullRequest; files: GitHubPullRequestFile[] }>(
      Array.from({ length: 9 }, (_v, i) => [
        i + 1,
        {
          pr: githubPr({ head: { sha: `${i}`.repeat(40), ref: 'feature' } }),
          files: [pullRequestFilesPage1[0]],
        },
      ]),
    );
    const state: GitHubFakeState = {
      pr: githubPr(),
      files: [pullRequestFilesPage1[0]],
      rawBytes: new Map(),
      byNumber,
    };
    const github = fakeGitHubClient(state);
    const svc = source({ github });

    const subjects: PrSubject[] = Array.from({ length: 9 }, (_v, i) =>
      githubSubject({ number: i + 1 }),
    );
    const diffIds: string[] = [];
    for (const subject of subjects) {
      const summary = await svc.summary(subject);
      diffIds.push(summary.diffId);
    }
    expect(new Set(diffIds).size).toBe(9); // sanity: nine subjects, nine distinct revisions
    expect(github.calls.files).toBe(9);

    // The first subject's entry has been evicted (8-entry cap, 9 summaries) but subject #1 is
    // still its own latest revision, so re-asking for it costs a file-list call, no detail call.
    const prCallsBefore = github.calls.pr;
    const filesCallsBefore = github.calls.files;
    const result = await svc.file(subjects[0], diffIds[0], 'src/app.ts');

    expect(result.status).toBe('ok');
    expect(github.calls.pr).toBe(prCallsBefore);
    expect(github.calls.files).toBe(filesCallsBefore + 1);
  });
});

describe('ForgeDiffSource.image', () => {
  it('reads both sides ok', async () => {
    const logo = pullRequestFilesPage2[0];
    const github = fakeGitHubClient({
      pr: githubPr(),
      files: [logo],
      rawBytes: new Map([
        [`${BASE_SHA}:assets/logo.png`, Buffer.from([1, 2, 3])],
        [`${HEAD_SHA}:assets/logo.png`, Buffer.from([1, 2, 3, 4])],
      ]),
    });
    const svc = source({ github });

    const summary = await svc.summary(githubSubject());
    const result = await svc.image(githubSubject(), summary.diffId, 'assets/logo.png');

    const ok = expectOkImage(result);
    expect(ok.image.old).toMatchObject({ bytes: 3 });
    expect(ok.image.new).toMatchObject({ bytes: 4 });
  });

  it('an added image has a null old side', async () => {
    const added: GitHubPullRequestFile = {
      sha: 'f'.repeat(40),
      filename: 'assets/new.png',
      status: 'added',
      additions: 0,
      deletions: 0,
    };
    const github = fakeGitHubClient({
      pr: githubPr(),
      files: [added],
      rawBytes: new Map([[`${HEAD_SHA}:assets/new.png`, Buffer.from([9, 9])]]),
    });
    const svc = source({ github });

    const summary = await svc.summary(githubSubject());
    const result = await svc.image(githubSubject(), summary.diffId, 'assets/new.png');

    const ok = expectOkImage(result);
    expect(ok.image.old).toBeNull();
    expect(ok.image.new).toMatchObject({ bytes: 2 });
  });

  it('a deleted image has a null new side', async () => {
    const deleted: GitHubPullRequestFile = {
      sha: 'f'.repeat(40),
      filename: 'assets/old.png',
      status: 'removed',
      additions: 0,
      deletions: 0,
    };
    const github = fakeGitHubClient({
      pr: githubPr(),
      files: [deleted],
      rawBytes: new Map([[`${BASE_SHA}:assets/old.png`, Buffer.from([9, 9])]]),
    });
    const svc = source({ github });

    const summary = await svc.summary(githubSubject());
    const result = await svc.image(githubSubject(), summary.diffId, 'assets/old.png');

    const ok = expectOkImage(result);
    expect(ok.image.new).toBeNull();
    expect(ok.image.old).toMatchObject({ bytes: 2 });
  });

  it('a side over DIFF_IMAGE_MAX_BYTES reads as tooLarge', async () => {
    const logo = pullRequestFilesPage2[0];
    const huge = Buffer.alloc(DIFF_IMAGE_MAX_BYTES + 10);
    const github = fakeGitHubClient({
      pr: githubPr(),
      files: [logo],
      rawBytes: new Map([
        [`${BASE_SHA}:assets/logo.png`, huge],
        [`${HEAD_SHA}:assets/logo.png`, Buffer.from([1])],
      ]),
    });
    const svc = source({ github });

    const summary = await svc.summary(githubSubject());
    const result = await svc.image(githubSubject(), summary.diffId, 'assets/logo.png');

    const ok = expectOkImage(result);
    expect(ok.image.old).toEqual({ bytes: huge.length, tooLarge: true });
  });

  it('throws for a non-image path', async () => {
    const github = fakeGitHubClient({
      pr: githubPr(),
      files: [pullRequestFilesPage1[0]],
      rawBytes: new Map(),
    });
    const svc = source({ github });

    const summary = await svc.summary(githubSubject());

    await expect(svc.image(githubSubject(), summary.diffId, 'src/app.ts')).rejects.toThrow(
      'is not an image this pane can preview',
    );
  });
});

describe('ForgeDiffSource.context', () => {
  const FILE_TEXT = Array.from({ length: 10 }, (_v, i) => `line ${i + 1}`).join('\n');

  it('reads a clipped range ok', async () => {
    const github = fakeGitHubClient({
      pr: githubPr(),
      files: [pullRequestFilesPage1[0]],
      rawBytes: new Map([[`${HEAD_SHA}:src/app.ts`, Buffer.from(FILE_TEXT)]]),
    });
    const svc = source({ github });

    const summary = await svc.summary(githubSubject());
    const result = await svc.context(githubSubject(), summary.diffId, 'src/app.ts', 'new', 2, 4);

    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.context).toMatchObject({
      start: 2,
      text: ['line 2', 'line 3', 'line 4'],
      truncated: false,
    });
  });

  it('clips a range that reaches past the end of the file', async () => {
    const github = fakeGitHubClient({
      pr: githubPr(),
      files: [pullRequestFilesPage1[0]],
      rawBytes: new Map([[`${HEAD_SHA}:src/app.ts`, Buffer.from(FILE_TEXT)]]),
    });
    const svc = source({ github });

    const summary = await svc.summary(githubSubject());
    const result = await svc.context(githubSubject(), summary.diffId, 'src/app.ts', 'new', 8, 50);

    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.context.text).toEqual(['line 8', 'line 9', 'line 10']);
    expect(result.context.truncated).toBe(true);
  });

  it('caps a request over DIFF_CONTEXT_MAX_LINES', async () => {
    const longText = Array.from({ length: 3000 }, (_v, i) => `l${i}`).join('\n');
    const github = fakeGitHubClient({
      pr: githubPr(),
      files: [pullRequestFilesPage1[0]],
      rawBytes: new Map([[`${HEAD_SHA}:src/app.ts`, Buffer.from(longText)]]),
    });
    const svc = source({ github });

    const summary = await svc.summary(githubSubject());
    const result = await svc.context(githubSubject(), summary.diffId, 'src/app.ts', 'new', 1, 3000);

    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.context.text).toHaveLength(2000);
    expect(result.context.truncated).toBe(true);
  });

  it('a blob over DIFF_FILE_MAX_BYTES reads as tooLarge', async () => {
    const huge = Buffer.alloc(DIFF_FILE_MAX_BYTES + 10, 'a');
    const github = fakeGitHubClient({
      pr: githubPr(),
      files: [pullRequestFilesPage1[0]],
      rawBytes: new Map([[`${HEAD_SHA}:src/app.ts`, huge]]),
    });
    const svc = source({ github });

    const summary = await svc.summary(githubSubject());
    const result = await svc.context(githubSubject(), summary.diffId, 'src/app.ts', 'new', 1, 10);

    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.context.tooLarge).toEqual({ bytes: huge.length });
  });

  it('reads the old side at oldPath and the base SHA', async () => {
    const github = fakeGitHubClient({
      pr: githubPr(),
      files: [pullRequestFilesPage1[1]], // src/utils/format.ts, renamed from src/format.ts
      rawBytes: new Map([[`${BASE_SHA}:src/format.ts`, Buffer.from(FILE_TEXT)]]),
    });
    const svc = source({ github });

    const summary = await svc.summary(githubSubject());
    const result = await svc.context(
      githubSubject(),
      summary.diffId,
      'src/utils/format.ts',
      'old',
      1,
      3,
    );

    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.context.text).toEqual(['line 1', 'line 2', 'line 3']);
  });

  it('reports stale for an id the subject has moved on from', async () => {
    const state: GitHubFakeState = {
      pr: githubPr(),
      files: [pullRequestFilesPage1[0]],
      rawBytes: new Map(),
    };
    const github = fakeGitHubClient(state);
    const svc = source({ github });

    const first = await svc.summary(githubSubject());
    state.pr = githubPr({ head: { sha: OTHER_HEAD_SHA, ref: 'feature' } });
    const second = await svc.summary(githubSubject());

    const result = await svc.context(githubSubject(), first.diffId, 'src/app.ts', 'new', 1, 3);
    expect(result).toEqual({ status: 'stale', diffId: first.diffId, currentDiffId: second.diffId });
  });
});

describe('ForgeDiffSource errors', () => {
  it("throws when no client is configured for the subject's forge", async () => {
    const svc = source({ github: null });

    await expect(svc.summary(githubSubject())).rejects.toThrow(/No GitHub client is configured/);
  });

  it('a GitLab 404 on both the diffs and the changes endpoint names the missing diff endpoint', async () => {
    const gitlab = fakeGitLabClient({
      mr: gitlabMr(),
      diffs: [],
      diffsError: new GitLabError('GitLab 404 Not Found', 404),
      rawBytes: new Map(),
    });
    const svc = source({ gitlab });

    await expect(svc.summary(gitlabSubject())).rejects.toThrow(/no merge request diff endpoint/);
  });

  it('a 404 on the detail read is caught and rethrown as a readable error', async () => {
    const github = fakeGitHubClient({
      pr: githubPr(),
      files: [],
      prError: new GitHubError('GitHub 404 Not Found', 404),
      rawBytes: new Map(),
    });
    const svc = source({ github });

    await expect(svc.summary(githubSubject())).rejects.toThrow(/could not be found on GitHub/);
  });
});
