import { describe, expect, it } from 'vitest';
import type { TaskActivityEntry } from './model';
import {
  autoMergeDecision,
  autoMergeLanded,
  autoMergePrerequisites,
  mergedByAutoMergeNote,
} from './autoMerge';

function comment(body: string, createdAt: number): TaskActivityEntry {
  return { kind: 'comment', id: createdAt, body, createdAt };
}

describe('autoMergeDecision', () => {
  it('is off when the project setting is off, regardless of the card or the sign-off', () => {
    expect(autoMergeDecision({ enabled: false, isUiCard: false, human: 'pending' })).toBe('off');
    expect(autoMergeDecision({ enabled: false, isUiCard: true, human: 'approved' })).toBe('off');
  });

  it('enables a non-UI card once the setting is on, with no sign-off to wait for', () => {
    expect(autoMergeDecision({ enabled: true, isUiCard: false, human: 'pending' })).toBe('enable');
    expect(autoMergeDecision({ enabled: true, isUiCard: false, human: 'needs-changes' })).toBe(
      'enable',
    );
  });

  it('holds a UI card whose sign-off is still pending', () => {
    expect(autoMergeDecision({ enabled: true, isUiCard: true, human: 'pending' })).toBe(
      'await-sign-off',
    );
  });

  it('enables a UI card once its sign-off is approved', () => {
    expect(autoMergeDecision({ enabled: true, isUiCard: true, human: 'approved' })).toBe('enable');
  });

  // The row the ticket calls out by name: needs-changes must never enable, even with the
  // project setting on — this is the row the mutation proof targets.
  it('never enables a UI card flagged needs-changes, even with the setting on', () => {
    expect(autoMergeDecision({ enabled: true, isUiCard: true, human: 'needs-changes' })).toBe(
      'needs-changes',
    );
  });
});

describe('autoMergeLanded', () => {
  it('is false when auto-merge was never armed', () => {
    expect(autoMergeLanded([])).toBe(false);
    expect(autoMergeLanded([comment('Pushed the branch.', 1)])).toBe(false);
  });

  it('is true once an "Auto-merge enabled" note has landed with nothing newer crediting it', () => {
    const activity = [comment('Auto-merge enabled for #12 — waiting for checks to pass.', 1)];
    expect(autoMergeLanded(activity)).toBe(true);
  });

  it('is false once the merge has already been credited by a later note', () => {
    const activity = [
      comment('Auto-merge enabled for #12 — waiting for checks to pass.', 1),
      comment(mergedByAutoMergeNote('#12'), 2),
    ];
    expect(autoMergeLanded(activity)).toBe(false);
  });

  it('is true again after a later push re-armed it, even though an older merge note exists', () => {
    const activity = [
      comment('Auto-merge enabled for #12 — waiting for checks to pass.', 1),
      comment(mergedByAutoMergeNote('#11'), 2),
      comment('Auto-merge enabled for #12 — waiting for checks to pass.', 3),
    ];
    expect(autoMergeLanded(activity)).toBe(true);
  });
});

describe('autoMergePrerequisites', () => {
  const project = { autoMergeOnGreen: true, autoMergeRequiredChecks: ['gates', 'package'] };

  it('reports nothing when the setting is off', () => {
    expect(
      autoMergePrerequisites(
        { ...project, autoMergeOnGreen: false },
        { allowAutoMerge: false, requiredChecks: [] },
      ),
    ).toEqual([]);
  });

  it('reports nothing when the repo allows auto-merge and every required check is named', () => {
    expect(
      autoMergePrerequisites(project, {
        allowAutoMerge: true,
        requiredChecks: ['gates', 'package'],
      }),
    ).toEqual([]);
  });

  it('flags a repository that does not allow auto-merge at all', () => {
    const problems = autoMergePrerequisites(project, {
      allowAutoMerge: false,
      requiredChecks: ['gates'],
    });
    expect(problems.some((p) => p.includes('does not allow auto-merge'))).toBe(true);
  });

  it('flags a base branch whose required checks could not be read', () => {
    const problems = autoMergePrerequisites(project, {
      allowAutoMerge: true,
      requiredChecks: null,
    });
    expect(problems.some((p) => p.includes('Could not read'))).toBe(true);
  });

  it('flags a base branch that requires a check nobody named', () => {
    const problems = autoMergePrerequisites(project, {
      allowAutoMerge: true,
      requiredChecks: ['gates', 'package', 'docker'],
    });
    expect(problems.some((p) => p.includes('docker'))).toBe(true);
  });
});
