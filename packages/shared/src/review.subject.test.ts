import { describe, expect, it } from 'vitest';
import { parseSubjectId, subjectId, taskSubjectId, type ReviewSubject } from './review';

describe('subjectId / parseSubjectId', () => {
  it('round-trips a task subject, including an id containing : and -', () => {
    const subject: ReviewSubject = { kind: 'task', taskId: 'proj-1:task-2' };
    const id = subjectId(subject);
    expect(id).toBe('task:proj-1:task-2');
    expect(id).toBe(taskSubjectId('proj-1:task-2'));
    expect(parseSubjectId(id)).toEqual({ kind: 'task', taskId: 'proj-1:task-2' });
  });

  it('round-trips a github PR subject in the gh-<repoId>-<number> form', () => {
    const subject: ReviewSubject = {
      kind: 'pr',
      provider: 'github',
      repoId: 42,
      repoPath: 'acme/web',
      number: 7,
    };
    const id = subjectId(subject);
    expect(id).toBe('gh-42-7');
    expect(parseSubjectId(id)).toEqual({ kind: 'pr', provider: 'github', repoId: 42, number: 7 });
  });

  it('round-trips a gitlab PR subject in the gl-<repoId>-<number> form', () => {
    const subject: ReviewSubject = {
      kind: 'pr',
      provider: 'gitlab',
      repoId: 42,
      repoPath: 'acme/web',
      number: 7,
    };
    const id = subjectId(subject);
    expect(id).toBe('gl-42-7');
    expect(parseSubjectId(id)).toEqual({ kind: 'pr', provider: 'gitlab', repoId: 42, number: 7 });
  });

  it.each(['task:', 'xx-1-2', 'gh-acme-web-1', ''])('rejects %s', (id) => {
    expect(parseSubjectId(id)).toBeNull();
  });
});
