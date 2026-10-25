import { describe, expect, it } from 'vitest';
import type { ReviewQueueItem, ReviewQueuesSnapshot, ReviewSubject } from '@tm/shared/review';
import {
  QUEUE_LABELS,
  QUEUE_ORDER,
  forgeUrlFor,
  groupQueue,
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
  it('reads repo#N for a PR on either provider', () => {
    expect(subjectLabel(item({ subject: github }))).toBe('acme/uploader#412');
    expect(subjectLabel(item({ subject: gitlab }))).toBe('group/sub/uploader#412');
  });

  it("reads the row's ref for a task", () => {
    expect(subjectLabel(item({ subject: task, ref: 'orch/t1' }))).toBe('orch/t1');
  });
});

describe('viewedLabel', () => {
  it('reads "N / M viewed"', () => {
    expect(viewedLabel(2, 7)).toBe('2 / 7 viewed');
    expect(viewedLabel(0, 0)).toBe('0 / 0 viewed');
  });
});
