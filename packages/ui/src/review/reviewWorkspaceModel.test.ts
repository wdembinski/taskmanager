import { describe, expect, it } from 'vitest';
import type {
  DiffFileEntry,
  ReviewQueueItem,
  ReviewQueuesSnapshot,
  ReviewSubject,
} from '@tm/shared/review';
import type { FileTreeNode } from './reviewView';
import {
  QUEUE_LABELS,
  QUEUE_ORDER,
  QUEUES_FRESH_MS,
  branchLine,
  buildDirGroups,
  forgeUrlFor,
  groupQueue,
  knownPipeline,
  providerName,
  queuesAsOfNotice,
  requestedCount,
  sourceBadge,
  subjectLabel,
  viewedLabel,
} from './reviewWorkspaceModel';

const github: ReviewSubject = {
  kind: 'pr',
  provider: 'github',
  repoId: 7,
  repoPath: 'acme/uploader',
  number: 412,
};
const gitlab: ReviewSubject = { ...github, provider: 'gitlab', repoPath: 'group/sub/uploader' };
const task: ReviewSubject = { kind: 'task', taskId: 't1' };

function item(over: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    subjectId: 'gh-7-412',
    queue: 'requested',
    subject: github,
    title: 'Retry uploads on a dropped link',
    author: 'Marta',
    repoPath: 'acme/uploader',
    ref: '!412',
    headSha: 'abc1234',
    draft: false,
    updatedAt: 1,
    projectId: null,
    taskId: null,
    draftCount: 0,
    viewedCount: 0,
    fileCount: 7,
    ...over,
  };
}

function snapshot(items: ReviewQueueItem[]): ReviewQueuesSnapshot {
  return { items, asOf: { requested: null, mine: null, agent: null }, partial: [] };
}

describe('QUEUE_ORDER / QUEUE_LABELS', () => {
  it('orders requested, mine, agent with the mockup labels', () => {
    expect(QUEUE_ORDER).toEqual(['requested', 'mine', 'agent']);
    expect(QUEUE_ORDER.map((q) => QUEUE_LABELS[q])).toEqual([
      'Requested from me',
      'My PRs / MRs',
      'Agent cards',
    ]);
  });
});

describe('groupQueue', () => {
  it('groups rows by queue in fixed order, keeping snapshot order inside a group', () => {
    const a = item({ subjectId: 'a', queue: 'agent' });
    const r1 = item({ subjectId: 'r1', queue: 'requested' });
    const m = item({ subjectId: 'm', queue: 'mine' });
    const r2 = item({ subjectId: 'r2', queue: 'requested' });
    const groups = groupQueue(snapshot([a, r1, m, r2]));
    expect(groups.map((g) => g.queue)).toEqual(['requested', 'mine', 'agent']);
    expect(groups.map((g) => g.label)).toEqual([
      'Requested from me',
      'My PRs / MRs',
      'Agent cards',
    ]);
    expect(groups[0].items.map((i) => i.subjectId)).toEqual(['r1', 'r2']);
    expect(groups[1].items.map((i) => i.subjectId)).toEqual(['m']);
    expect(groups[2].items.map((i) => i.subjectId)).toEqual(['a']);
  });

  it('keeps an empty group', () => {
    const groups = groupQueue(snapshot([]));
    expect(groups).toHaveLength(3);
    expect(groups.every((g) => g.items.length === 0)).toBe(true);
  });
});

describe('sourceBadge', () => {
  it('reads "local clone" for both local sources', () => {
    expect(sourceBadge({ source: 'worktree' })).toEqual({ text: 'local clone' });
    expect(sourceBadge({ source: 'local-ref' })).toEqual({ text: 'local clone' });
  });

  it('reads "forge API · read only" for the forge, titled with any fallback reason', () => {
    expect(sourceBadge({ source: 'forge-api' })).toEqual({ text: 'forge API · read only' });
    expect(sourceBadge({ source: 'forge-api', fallbackReason: 'fetch failed' })).toEqual({
      text: 'forge API · read only',
      title: 'fetch failed',
    });
  });

  it('draws nothing when the summary names no source', () => {
    expect(sourceBadge({ source: undefined })).toBeNull();
    expect(sourceBadge({})).toBeNull();
  });
});

describe('forgeUrlFor', () => {
  it('builds a GitHub pull URL', () => {
    expect(forgeUrlFor(item({ subject: github }))).toBe(
      'https://github.com/acme/uploader/pull/412',
    );
  });

  it('answers null for GitLab (no host on the row) and for a task', () => {
    expect(forgeUrlFor(item({ subject: gitlab }))).toBeNull();
    expect(forgeUrlFor(item({ subject: task }))).toBeNull();
  });
});

describe('subjectLabel', () => {
  it("reads the row's own ref", () => {
    expect(subjectLabel(item({ subject: gitlab, ref: '!412' }))).toBe('!412');
    expect(subjectLabel(item({ subject: github, ref: '#412' }))).toBe('#412');
  });

  it("falls back to the forge's spelling of a PR subject with no ref", () => {
    expect(subjectLabel(item({ subject: github, ref: '' }))).toBe('#412');
    expect(subjectLabel(item({ subject: gitlab, ref: '' }))).toBe('!412');
  });

  it('reads empty for a task with no ref', () => {
    expect(subjectLabel(item({ subject: task, ref: '' }))).toBe('');
  });
});

describe('branchLine', () => {
  const summary = { baseRef: 'development', headSha: 'abc1234def567' };

  it('reads head → base with the branch names when the row knows its head', () => {
    expect(branchLine(item({ headRef: 'marta/retry-uploads' }), summary)).toBe(
      'marta/retry-uploads → development',
    );
  });

  it("falls back to the head's 7-char SHA only when the head branch is unknown", () => {
    expect(branchLine(item({ headRef: null }), summary)).toBe('abc1234 → development');
    expect(branchLine(item({ headRef: '' }), summary)).toBe('abc1234 → development');
    expect(branchLine(item(), summary)).toBe('abc1234 → development');
  });
});

describe('providerName', () => {
  it('names the forge for a PR and nothing for a task', () => {
    expect(providerName(item({ subject: gitlab }))).toBe('GitLab');
    expect(providerName(item({ subject: github }))).toBe('GitHub');
    expect(providerName(item({ subject: task }))).toBeNull();
  });
});

describe('knownPipeline', () => {
  it('keeps a status worth naming and drops unknown, none and absent', () => {
    expect(knownPipeline(item({ pipeline: 'success' }))).toBe('success');
    expect(knownPipeline(item({ pipeline: 'unknown' }))).toBeNull();
    expect(knownPipeline(item({ pipeline: 'none' }))).toBeNull();
    expect(knownPipeline(item({ pipeline: null }))).toBeNull();
    expect(knownPipeline(item())).toBeNull();
  });
});

function file(path: string): DiffFileEntry {
  return {
    path,
    status: 'modified',
    additions: 1,
    deletions: 0,
    binary: false,
    image: false,
    bytes: 10,
  };
}

/** Each node as `dir: [paths]` or a bare path, so a whole grouping reads in one assertion. */
function shape(nodes: readonly FileTreeNode[]): unknown[] {
  return nodes.map((n) =>
    n.kind === 'file'
      ? n.entry.path
      : { [n.name]: n.children.map((c) => (c.kind === 'file' ? c.entry.path : c.name)) },
  );
}

describe('buildDirGroups', () => {
  it("groups the fixture's seven files by their own directory, full path as the label", () => {
    const groups = buildDirGroups(
      [
        'src/upload/retry.ts',
        'src/upload/send.ts',
        'src/upload/backoff.ts',
        'src/upload/index.ts',
        'src/net/link.ts',
        'test/retry.test.ts',
        'test/send.test.ts',
      ].map(file),
    );
    expect(shape(groups)).toEqual([
      { 'src/net': ['src/net/link.ts'] },
      {
        'src/upload': [
          'src/upload/backoff.ts',
          'src/upload/index.ts',
          'src/upload/retry.ts',
          'src/upload/send.ts',
        ],
      },
      { test: ['test/retry.test.ts', 'test/send.test.ts'] },
    ]);
    for (const g of groups) if (g.kind === 'dir') expect(g.path).toBe(g.name);
  });

  it('puts root files first, sorted, and never nests a parent and child directory', () => {
    const groups = buildDirGroups(
      ['src/a.ts', 'package.json', 'src/deep/b.ts', 'README.md'].map(file),
    );
    expect(shape(groups)).toEqual([
      'package.json',
      'README.md',
      { src: ['src/a.ts'] },
      { 'src/deep': ['src/deep/b.ts'] },
    ]);
  });

  it('answers an empty list for no files', () => {
    expect(buildDirGroups([])).toEqual([]);
  });
});

describe('viewedLabel', () => {
  it('reads "N / M viewed"', () => {
    expect(viewedLabel(2, 7)).toBe('2 / 7 viewed');
    expect(viewedLabel(0, 0)).toBe('0 / 0 viewed');
  });
});

describe('queuesAsOfNotice', () => {
  // A local-time clock reading, so the expected HH:MM holds in every time zone.
  const at1402 = new Date(2026, 9, 26, 14, 2, 30).getTime();
  const synced = (
    asOf: ReviewQueuesSnapshot['asOf'],
    partial: ReviewQueuesSnapshot['partial'] = [],
  ): ReviewQueuesSnapshot => ({ items: [], asOf, partial });

  it('says nothing while every queue is fresh and whole', () => {
    const fresh = synced({ requested: at1402, mine: at1402 + 1000, agent: null });
    expect(queuesAsOfNotice(fresh, at1402 + QUEUES_FRESH_MS)).toBeNull();
  });

  it('names the oldest queue’s time once it misses a refresh', () => {
    const stale = synced({ requested: at1402 + 60_000, mine: at1402, agent: null });
    expect(queuesAsOfNotice(stale, at1402 + QUEUES_FRESH_MS + 1)).toBe('Queues as of 14:02');
  });

  it('names the time even while fresh when a queue came back incomplete', () => {
    const partial = synced({ requested: at1402, mine: null, agent: at1402 }, ['mine']);
    expect(queuesAsOfNotice(partial, at1402)).toBe(
      'Queues as of 14:02 — some queues are incomplete',
    );
  });

  it('says nothing when no queue has ever synced and none is incomplete', () => {
    expect(
      queuesAsOfNotice(synced({ requested: null, mine: null, agent: null }), at1402),
    ).toBeNull();
  });

  it('still flags an incomplete refresh with no time to name', () => {
    const none = synced({ requested: null, mine: null, agent: null }, ['agent']);
    expect(queuesAsOfNotice(none, at1402)).toBe('Some queues are incomplete');
  });
});

describe('requestedCount', () => {
  it('counts only the Requested from me rows', () => {
    const snap = snapshot([
      item({ subjectId: 'a', queue: 'requested' }),
      item({ subjectId: 'b', queue: 'mine' }),
      item({ subjectId: 'c', queue: 'requested' }),
      item({ subjectId: 'd', queue: 'agent', subject: task }),
    ]);
    expect(requestedCount(snap)).toBe(2);
    expect(requestedCount(snapshot([]))).toBe(0);
  });
});
