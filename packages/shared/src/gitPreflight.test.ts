import { describe, expect, it } from 'vitest';
import { describeGitPreflight } from './gitPreflight';

describe('describeGitPreflight', () => {
  it('says nothing at all until an answer has arrived', () => {
    expect(describeGitPreflight(null, true).severity).toBe('none');
  });

  it('warns about a missing folder even when git state is nobody’s business', () => {
    // Worktrees OFF, so no git state matters — but a folder that isn't there breaks any run.
    const note = describeGitPreflight({ state: 'missing' }, false);
    expect(note.severity).toBe('warning');
    expect(note.message).toMatch(/doesn't exist/i);
  });

  it('stays quiet about every git state when worktrees are off', () => {
    for (const state of ['not-a-repo', 'no-commits', 'ready', 'unknown'] as const) {
      expect(describeGitPreflight({ state }, false).severity).toBe('none');
    }
  });

  it('confirms a healthy repo and names the branch tasks will fork from', () => {
    const note = describeGitPreflight({ state: 'ready', branch: 'development' }, true);
    expect(note.severity).toBe('success');
    expect(note.message).toContain('development');
  });

  it('warns that an unborn repo will be given an empty first commit, naming the branch', () => {
    // The exact case that produced `fatal: not a valid object name: ''` at run time.
    const note = describeGitPreflight({ state: 'no-commits', branch: 'development' }, true);
    expect(note.severity).toBe('warning');
    expect(note.message).toMatch(/no commits yet/i);
    expect(note.message).toContain('development');
    // The write we are about to make in their repo has to be stated, not implied.
    expect(note.message).toMatch(/Initial commit/);
  });

  it('warns that a non-repo makes the worktree switch a no-op', () => {
    const note = describeGitPreflight({ state: 'not-a-repo' }, true);
    expect(note.severity).toBe('warning');
    expect(note.message).toMatch(/not engage/i);
  });

  it('stays quiet when git itself could not answer — a guess would cry wolf', () => {
    expect(describeGitPreflight({ state: 'unknown', detail: 'git not found' }, true).severity).toBe(
      'none',
    );
  });
});
