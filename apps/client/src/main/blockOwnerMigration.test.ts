import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@shared/model';
import { CLAIMED_BLOCK_RESTORES_TO, blockOwnerFor, needsBlockOwner } from './blockOwnerMigration';

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  projectId: PERSONAL_PROJECT_ID,
  phase: 'proj',
  title: 'Do a thing',
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'jira',
  isContract: false,
  isScaffold: false,
  ...over,
});

describe('needsBlockOwner', () => {
  it('claims a blocked card whose marker predates the rule', () => {
    expect(needsBlockOwner(task({ status: 'blocked' }))).toBe(true);
  });

  it('claims a blocked card whose agent has borrowed `status`', () => {
    // The block lives in `preRunStatus` while a run owns the field. Missing these is the
    // one way the back-fill could still let a sync unblock a card.
    expect(needsBlockOwner(task({ status: 'running', preRunStatus: 'blocked' }))).toBe(true);
  });

  it('leaves a card that already says who owns its block', () => {
    expect(needsBlockOwner(task({ status: 'blocked', preBlockStatus: 'in-progress' }))).toBe(false);
  });

  it('leaves a card that is not blocked at all', () => {
    expect(needsBlockOwner(task())).toBe(false);
    expect(needsBlockOwner(task({ status: 'in-progress' }))).toBe(false);
    // A stale `preRunStatus` on a card no run owns says nothing — `restingStatus` reads
    // `status`, and that is what the sync will read too.
    expect(needsBlockOwner(task({ status: 'pending', preRunStatus: 'blocked' }))).toBe(false);
  });
});

describe('blockOwnerFor', () => {
  it('restores an un-blocked claimed card to TO DO, the only column always true of it', () => {
    expect(blockOwnerFor(task({ status: 'blocked' }))).toBe(CLAIMED_BLOCK_RESTORES_TO);
    expect(CLAIMED_BLOCK_RESTORES_TO).toBe('pending');
  });

  it('never overwrites a marker a drag already wrote', () => {
    expect(blockOwnerFor(task({ status: 'blocked', preBlockStatus: 'in-review' }))).toBe(
      'in-review',
    );
  });

  it('leaves an unblocked card null', () => {
    expect(blockOwnerFor(task())).toBeNull();
  });

  it('is idempotent — a second pass over its own output changes nothing', () => {
    // The `app_state` guard is what stops a rerun, but a rerun must not be destructive
    // either: after the first pass every claimed card already carries its marker.
    for (const original of [
      task({ status: 'blocked' }),
      task({ status: 'running', preRunStatus: 'blocked' }),
      task({ status: 'blocked', preBlockStatus: 'in-review' }),
    ]) {
      const once = blockOwnerFor(original);
      expect(blockOwnerFor({ ...original, preBlockStatus: once })).toBe(once);
    }
  });
});
