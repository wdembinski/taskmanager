/**
 * `AiReviewSubjects.resolve` against fake services: what a review is pinned to at start, and
 * every way a subject is refused before anything is spent.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Project, Task } from '@shared/model';
import {
  FORGE_API_CAPABILITIES,
  LOCAL_REF_CAPABILITIES,
  WORKTREE_CAPABILITIES,
  type DiffFile,
  type DiffFileEntry,
  type DiffFileResult,
  type DiffSummary,
  type DiffSummaryResult,
} from '@shared/review';
import type { ExecHost } from '../exec';
import {
  AiReviewSubjects,
  isRefusal,
  parsePorcelainPaths,
  type AiReviewSubjectDeps,
  type ReviewTarget,
} from './aiReviewSubjects';

const PROJECT = { id: 'p', path: '/repo', instructions: 'source env.sh first' } as Project;
const TASK = {
  id: 't1',
  projectId: 'p',
  title: 'Fix the parser',
  description: 'Handle CRLF',
  externalKey: 'TM-7',
  externalDescription: 'The parser chokes on CRLF.',
} as Task;

function entry(path: string, over: Partial<DiffFileEntry> = {}): DiffFileEntry {
  return {
    path,
    status: 'modified',
    additions: 3,
    deletions: 1,
    binary: false,
    image: false,
    bytes: 10,
    ...over,
  };
}

function summary(over: Partial<DiffSummary> = {}): DiffSummary {
  return {
    diffId: 'd1',
    baseRef: 'main',
    baseSha: 'base',
    headSha: 'head',
    includesWorkingTree: false,
    files: [entry('a.ts'), entry('logo.png', { binary: true })],
    truncated: false,
    subjectId: 'task:t1',
    source: 'worktree',
    capabilities: WORKTREE_CAPABILITIES,
    ...over,
  };
}

const file = (path: string, diffId = 'd1'): DiffFile => ({ diffId, path, hunks: [] });

function host(over: { reviewDoc?: string | null; porcelain?: string } = {}) {
  const exec = vi.fn(async (_cwd: string, _file: string, args: string[]) => {
    if (args[0] === 'show') {
      return over.reviewDoc == null
        ? { code: 128, stdout: '', stderr: 'fatal: path does not exist' }
        : { code: 0, stdout: over.reviewDoc, stderr: '' };
    }
    return { code: 0, stdout: over.porcelain ?? '', stderr: '' };
  });
  return { exec } as unknown as ExecHost & { exec: typeof exec };
}

function deps(
  over: {
    taskSummary?: DiffSummaryResult[];
    filesDiffId?: string;
    prSummary?: DiffSummaryResult;
    localProject?: Project | null;
    prFile?: (path: string) => DiffFileResult;
    host?: ExecHost;
    cardWorktree?: string | null;
  } = {},
) {
  const taskSummaries = [...(over.taskSummary ?? [{ status: 'ok', summary: summary() }])];
  const d = {
    store: {
      getTask: (id: string) => (id === 't1' ? TASK : undefined),
      getProject: (id: string) => (id === 'p' ? PROJECT : undefined),
      listReviewQueue: () => [],
      listMergeRequests: () => [
        { id: 'gh-1-7', provider: 'github', number: 7, title: 'Add caching', taskId: 't1' },
      ],
    },
    diffs: {
      summary: vi.fn(async () => taskSummaries.shift() ?? taskSummaries[0]),
      filesFor: vi.fn(async (_taskId: string, paths: readonly string[]) => ({
        diffId: over.filesDiffId ?? 'd1',
        files: new Map(paths.map((p) => [p, { file: file(p) }])),
      })),
    },
    subjects: {
      summary: vi.fn(async () => over.prSummary ?? { status: 'ok', summary: summary() }),
      file: vi.fn(
        async (_id: string, diffId: string, path: string): Promise<DiffFileResult> =>
          over.prFile?.(path) ?? { status: 'ok', file: file(path, diffId) },
      ),
      localProject: vi.fn(() => (over.localProject === undefined ? PROJECT : over.localProject)),
    },
    hostFor: () => over.host ?? host(),
    cardWorktree: vi.fn(async () =>
      over.cardWorktree === undefined ? '/wt/t1' : over.cardWorktree,
    ),
  };
  return d as unknown as AiReviewSubjectDeps & typeof d;
}

async function resolved(d: AiReviewSubjectDeps, id = 'task:t1'): Promise<ReviewTarget> {
  const result = await new AiReviewSubjects(d).resolve(id);
  if (isRefusal(result)) throw new Error(`refused: ${result.reason}`);
  return result;
}

describe('a card subject', () => {
  it('pins every non-binary file and the prompt context at start', async () => {
    const d = deps();
    const target = await resolved(d);
    expect(target.project).toBe(PROJECT);
    expect(target.taskId).toBe('t1');
    expect(target.summary.diffId).toBe('d1');
    expect([...target.files.keys()]).toEqual(['a.ts']);
    expect(d.diffs.filesFor).toHaveBeenCalledWith('t1', ['a.ts']);
    expect(target.prompt).toMatchObject({
      subject: { kind: 'task', title: 'Fix the parser', description: 'Handle CRLF' },
      ticket: { key: 'TM-7', body: 'The parser chokes on CRLF.' },
      baseRef: 'main',
      baseSha: 'base',
      headSha: 'head',
      instructions: 'source env.sh first',
    });
    expect(target.prompt.uncommittedFiles).toBeUndefined();
  });

  it('lists the uncommitted files of a live worktree as not reviewed', async () => {
    const h = host({ porcelain: ' M src/a.ts\n?? notes.txt\nR  old.ts -> new.ts\n' });
    const d = deps({
      taskSummary: [{ status: 'ok', summary: summary({ includesWorkingTree: true }) }],
      host: h,
    });
    const target = await resolved(d);
    expect(target.prompt.uncommittedFiles).toEqual(['src/a.ts', 'notes.txt', 'new.ts']);
    expect(h.exec).toHaveBeenCalledWith('/wt/t1', 'git', ['status', '--porcelain']);
  });

  it('re-reads once when the diff moves between the summary and the files', async () => {
    const d = deps({
      taskSummary: [
        { status: 'ok', summary: summary({ diffId: 'd0' }) },
        { status: 'ok', summary: summary() },
      ],
    });
    const target = await resolved(d);
    expect(target.summary.diffId).toBe('d1');
    expect(d.diffs.summary).toHaveBeenCalledTimes(2);
  });

  it('refuses a landed card, an unknown card and a non-subject', async () => {
    const landed = await new AiReviewSubjects(
      deps({ taskSummary: [{ status: 'landed', forgeUrl: null }] }),
    ).resolve('task:t1');
    expect(landed).toMatchObject({ refused: 'unknown-subject' });
    expect(await new AiReviewSubjects(deps()).resolve('task:nope')).toMatchObject({
      refused: 'unknown-subject',
    });
    expect(await new AiReviewSubjects(deps()).resolve('banana')).toMatchObject({
      refused: 'unknown-subject',
    });
  });

  it('refuses a diff over the caps before reading a single file', async () => {
    const d = deps({
      taskSummary: [
        { status: 'ok', summary: summary({ files: [entry('big.ts', { additions: 4001 })] }) },
      ],
    });
    const result = await new AiReviewSubjects(d).resolve('task:t1');
    expect(result).toEqual({
      refused: 'too-large',
      reason: 'too large to review — 4,002 changed lines, cap 4,000',
    });
    expect(d.diffs.filesFor).not.toHaveBeenCalled();
  });
});

describe('a PR subject', () => {
  const prSummary = (over: Partial<DiffSummary> = {}): DiffSummaryResult => ({
    status: 'ok',
    summary: summary({
      subjectId: 'gh-1-7',
      source: 'local-ref',
      capabilities: LOCAL_REF_CAPABILITIES,
      ...over,
    }),
  });

  it('runs in the project its local-ref clone resolved to', async () => {
    const d = deps({ prSummary: prSummary() });
    const target = await resolved(d, 'gh-1-7');
    expect(target.project).toBe(PROJECT);
    expect(target.taskId).toBe('t1');
    expect([...target.files.keys()]).toEqual(['a.ts']);
    expect(d.subjects.file).toHaveBeenCalledWith('gh-1-7', 'd1', 'a.ts');
    expect(target.prompt.subject).toEqual({ kind: 'pr', title: 'Add caching', ref: '#7' });
  });

  it('refuses a forge-api subject: there is no clone to review in', async () => {
    const d = deps({
      prSummary: prSummary({ source: 'forge-api', capabilities: FORGE_API_CAPABILITIES }),
      localProject: null,
    });
    expect(await new AiReviewSubjects(d).resolve('gh-1-7')).toEqual({
      refused: 'no-capability',
      reason: 'add the repo as a project to let the AI review it',
    });
    expect(d.subjects.file).not.toHaveBeenCalled();
  });
});

describe('REVIEW.md', () => {
  it('is read from the base commit when it exists', async () => {
    const h = host({ reviewDoc: '# Review rules' });
    const target = await resolved(deps({ host: h }));
    expect(target.prompt.reviewDoc).toBe('# Review rules');
    expect(h.exec).toHaveBeenCalledWith('/repo', 'git', ['show', 'base:REVIEW.md']);
  });

  it('is null — the default checklist — when git show fails', async () => {
    const target = await resolved(deps({ host: host({ reviewDoc: null }) }));
    expect(target.prompt.reviewDoc).toBeNull();
  });
});

describe('parsePorcelainPaths', () => {
  it('reads plain, renamed and quoted entries and skips blank lines', () => {
    expect(parsePorcelainPaths(' M a.ts\r\n\nR  x.ts -> y.ts\n?? "with space.ts"\n')).toEqual([
      'a.ts',
      'y.ts',
      'with space.ts',
    ]);
  });
});
