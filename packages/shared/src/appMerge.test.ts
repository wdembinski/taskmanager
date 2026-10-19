import { describe, expect, it } from 'vitest';
import type { TaskActivityEntry } from './model';
import { AUTO_MERGE_ENABLED_PREFIX, autoMergeFailedNote, autoMergeLanded } from './autoMerge';
import {
  AUTO_MERGE_APP_FALLBACK_PREFIX,
  appMergeDecision,
  appMergeModeNote,
  appMergeRefusedNote,
  appMergedNote,
  autoMergeAppFallbackNote,
  effectiveAutoMergeBy,
  isAutoMergeUnavailable,
  type AppMergeCheck,
  type AppMergeInput,
} from './appMerge';

const SHA = 'abc1234def5678';

function check(
  name: string,
  conclusion: AppMergeCheck['conclusion'] = 'success',
  completed = true,
): AppMergeCheck {
  return { name, completed, conclusion };
}

function input(overrides: Partial<AppMergeInput> = {}): AppMergeInput {
  return {
    state: 'open',
    draft: false,
    mergeable: true,
    behind: false,
    conflicted: false,
    liveHeadSha: SHA,
    expectedSha: SHA,
    checksSha: SHA,
    checks: [check('build'), check('test')],
    requiredChecks: ['build'],
    isUiCard: false,
    human: 'pending',
    ...overrides,
  };
}

function comment(body: string, createdAt: number): TaskActivityEntry {
  return { kind: 'comment', id: createdAt, body, createdAt };
}

describe('appMergeDecision', () => {
  it('merges the live head once every check passed and every required one is green', () => {
    expect(appMergeDecision(input())).toEqual({ kind: 'merge', sha: SHA });
  });

  // The row the mutation proof targets: a check still running must WAIT, never merge on the
  // strength of "nothing has failed yet".
  it('waits while any check is still running', () => {
    expect(
      appMergeDecision(input({ checks: [check('build'), check('test', 'unknown', false)] })),
    ).toEqual({ kind: 'wait', reason: 'pending' });
  });

  it('refuses a failed check, required or not', () => {
    const d = appMergeDecision(input({ checks: [check('build'), check('lint', 'failure')] }));
    expect(d).toMatchObject({ kind: 'refuse', reason: 'failed-check' });
    expect(d.kind === 'refuse' && d.detail).toContain('lint');
  });

  it('refuses a cancelled check', () => {
    expect(
      appMergeDecision(input({ checks: [check('build'), check('test', 'cancelled')] })),
    ).toMatchObject({ kind: 'refuse', reason: 'failed-check' });
  });

  it('refuses when a required check never ran', () => {
    const d = appMergeDecision(input({ requiredChecks: ['build', 'e2e'] }));
    expect(d).toMatchObject({ kind: 'refuse', reason: 'missing-required' });
    expect(d.kind === 'refuse' && d.detail).toContain('e2e');
  });

  it('refuses a required check that only came back neutral', () => {
    expect(
      appMergeDecision(input({ checks: [check('build', 'neutral'), check('test')] })),
    ).toMatchObject({ kind: 'refuse', reason: 'required-not-success' });
  });

  it('lets a non-required neutral or skipped check pass', () => {
    expect(
      appMergeDecision(
        input({ checks: [check('build'), check('docs', 'neutral'), check('deploy', 'skipped')] }),
      ),
    ).toEqual({ kind: 'merge', sha: SHA });
  });

  it('refuses when the live head moved past the sha the caller set out to merge', () => {
    expect(appMergeDecision(input({ liveHeadSha: 'fff0000', checksSha: 'fff0000' }))).toMatchObject(
      { kind: 'refuse', reason: 'stale-sha' },
    );
    expect(appMergeDecision(input({ liveHeadSha: null }))).toMatchObject({
      kind: 'refuse',
      reason: 'stale-sha',
    });
  });

  it('refuses when the checks were read for a different commit than the head', () => {
    expect(appMergeDecision(input({ checksSha: 'fff0000' }))).toMatchObject({
      kind: 'refuse',
      reason: 'stale-sha',
    });
  });

  it('refuses a draft, and anything no longer open', () => {
    expect(appMergeDecision(input({ draft: true }))).toMatchObject({
      kind: 'refuse',
      reason: 'draft',
    });
    expect(appMergeDecision(input({ state: 'merged' }))).toMatchObject({
      kind: 'refuse',
      reason: 'closed',
    });
    expect(appMergeDecision(input({ state: 'closed' }))).toMatchObject({
      kind: 'refuse',
      reason: 'closed',
    });
  });

  it('refuses a UI card whose sign-off is pending or flagged needs-changes', () => {
    expect(appMergeDecision(input({ isUiCard: true, human: 'pending' }))).toMatchObject({
      kind: 'refuse',
      reason: 'sign-off',
    });
    expect(appMergeDecision(input({ isUiCard: true, human: 'needs-changes' }))).toMatchObject({
      kind: 'refuse',
      reason: 'sign-off',
    });
  });

  it('merges a UI card once its sign-off is approved', () => {
    expect(appMergeDecision(input({ isUiCard: true, human: 'approved' }))).toEqual({
      kind: 'merge',
      sha: SHA,
    });
  });

  it('ignores the sign-off on a card that is not a UI card', () => {
    expect(appMergeDecision(input({ isUiCard: false, human: 'needs-changes' }))).toEqual({
      kind: 'merge',
      sha: SHA,
    });
  });

  it('waits while the forge is still computing mergeability', () => {
    expect(appMergeDecision(input({ mergeable: null }))).toEqual({
      kind: 'wait',
      reason: 'computing',
    });
  });

  it('refuses when the forge says it cannot merge', () => {
    expect(appMergeDecision(input({ mergeable: false }))).toMatchObject({
      kind: 'refuse',
      reason: 'not-mergeable',
    });
  });

  it('refuses a conflicted branch and one behind its base', () => {
    expect(appMergeDecision(input({ conflicted: true, mergeable: false }))).toMatchObject({
      kind: 'refuse',
      reason: 'conflict',
    });
    expect(appMergeDecision(input({ behind: true }))).toMatchObject({
      kind: 'refuse',
      reason: 'behind',
    });
  });

  it('refuses a pull request with no checks at all', () => {
    expect(appMergeDecision(input({ checks: [], requiredChecks: [] }))).toMatchObject({
      kind: 'refuse',
      reason: 'no-checks',
    });
  });
});

describe('effectiveAutoMergeBy', () => {
  it('follows the project setting when the card has no fallback note', () => {
    expect(effectiveAutoMergeBy('forge', [])).toBe('forge');
    expect(effectiveAutoMergeBy('app', [])).toBe('app');
    expect(effectiveAutoMergeBy('forge', [comment(autoMergeFailedNote('#7', 'boom'), 1)])).toBe(
      'forge',
    );
  });

  it("reads 'app' once the fallback note is on the card's timeline", () => {
    const note = autoMergeAppFallbackNote('#7', 'Upgrade to GitHub Pro.');
    expect(note.startsWith(AUTO_MERGE_APP_FALLBACK_PREFIX)).toBe(true);
    expect(effectiveAutoMergeBy('forge', [comment(note, 1)])).toBe('app');
  });
});

describe('isAutoMergeUnavailable', () => {
  it("is true for GitHub Free's private-repo refusal", () => {
    expect(
      isAutoMergeUnavailable(
        403,
        'Upgrade to GitHub Pro or make this repository public to enable this feature.',
      ),
    ).toBe(true);
    expect(
      isAutoMergeUnavailable(422, 'Pull request Auto merge is not allowed for this repository'),
    ).toBe(true);
  });

  it('is false for a 401, whatever its message', () => {
    expect(isAutoMergeUnavailable(401, 'Bad credentials')).toBe(false);
    expect(isAutoMergeUnavailable(401, 'not allowed')).toBe(false);
  });

  it('is false for a network error with no status', () => {
    expect(isAutoMergeUnavailable(undefined, 'fetch failed')).toBe(false);
  });

  it("is true for GitLab's merge-when-pipeline-succeeds refusal", () => {
    expect(isAutoMergeUnavailable(405, '405 Method Not Allowed')).toBe(true);
    expect(
      isAutoMergeUnavailable(422, 'Cannot set merge when pipeline succeeds on this merge request'),
    ).toBe(true);
  });
});

describe('app-merge notes', () => {
  const notes = [
    appMergedNote('#7', 'development'),
    appMergeRefusedNote('#7', 'failed-check', 'check lint (failure) did not pass'),
    autoMergeAppFallbackNote('#7', 'Upgrade to GitHub Pro'),
    appMergeModeNote('#7'),
  ];

  it('never reads as an armed auto-merge, so autoMergeLanded never credits one', () => {
    for (const note of notes) {
      expect(note.startsWith(AUTO_MERGE_ENABLED_PREFIX)).toBe(false);
      expect(autoMergeLanded([comment(note, 1)])).toBe(false);
    }
  });

  it('says what happened in plain words', () => {
    expect(appMergeModeNote('#7')).toBe('Task Manager will merge #7 itself once its checks pass.');
    expect(appMergedNote('#7', 'development')).toBe(
      'Merged by Task Manager: #7 into development — every check passed.',
    );
    expect(autoMergeAppFallbackNote('#7', 'Upgrade to GitHub Pro.')).toBe(
      'Auto-merge is not available on #7 — Upgrade to GitHub Pro; Task Manager will merge it ' +
        'itself once it is green.',
    );
  });
});
