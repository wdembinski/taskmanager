/**
 * The rule behind "Review in the background when I open a PR": only a pull request NEW to the
 * queues starts a paid review. Each wrong answer here spends money — the first snapshot
 * reviewing the whole backlog, a card's own subject starting one, or the same PR twice.
 */
import { describe, expect, it } from 'vitest';
import type { ReviewQueueItem, ReviewSubject } from '@tm/shared/review';
import { subjectId } from '@tm/shared/review';
import { newPrSubjects, prSubjectIds } from './backgroundReview';

function row(subject: ReviewSubject): ReviewQueueItem {
  return {
    subjectId: subjectId(subject),
    queue: subject.kind === 'task' ? 'agent' : 'requested',
    subject,
    title: 't',
    author: 'a',
    repoPath: 'x/y',
    ref: '#1',
    headSha: null,
    draft: false,
    updatedAt: 0,
    projectId: null,
    taskId: subject.kind === 'task' ? subject.taskId : null,
    draftCount: 0,
    viewedCount: 0,
    fileCount: null,
  };
}

const pr = (number: number): ReviewQueueItem =>
  row({ kind: 'pr', provider: 'github', repoId: 5, repoPath: 'x/y', number });
const card = (taskId: string): ReviewQueueItem => row({ kind: 'task', taskId });

describe('newPrSubjects', () => {
  it('reviews nothing on the first snapshot — it only seeds what is already there', () => {
    expect(newPrSubjects(null, { items: [pr(1), pr(2)] })).toEqual([]);
  });

  it('returns a PR the previous snapshot did not have', () => {
    const seen = new Set(prSubjectIds({ items: [pr(1)] }));
    expect(newPrSubjects(seen, { items: [pr(1), pr(2)] })).toEqual(['gh-5-2']);
  });

  it('ignores a new card subject — only pull requests count', () => {
    const seen = new Set(prSubjectIds({ items: [pr(1)] }));
    expect(newPrSubjects(seen, { items: [pr(1), card('t1')] })).toEqual([]);
  });

  it('does not return the same PR again', () => {
    const seen = new Set(prSubjectIds({ items: [pr(1), pr(2)] }));
    expect(newPrSubjects(seen, { items: [pr(1), pr(2)] })).toEqual([]);
  });

  it('names a PR listed in two queues once', () => {
    const twice = { ...pr(3), queue: 'mine' as const };
    expect(newPrSubjects(new Set(), { items: [pr(3), twice] })).toEqual(['gh-5-3']);
  });
});
