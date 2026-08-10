import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@shared/model';
import { splitProjectTag, wasDelegated } from './projectTagMigration';

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  projectId: PERSONAL_PROJECT_ID,
  phase: 'proj',
  title: 'Do a thing',
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'adhoc',
  isContract: false,
  isScaffold: false,
  ...over,
});

describe('wasDelegated', () => {
  it('is true for each trace only a real run leaves', () => {
    expect(wasDelegated(task({ sessionId: 'sess-1' }))).toBe(true);
    expect(wasDelegated(task({ agentMode: 'plan' }))).toBe(true);
    expect(wasDelegated(task({ agentModel: 'opus' }))).toBe(true);
    expect(wasDelegated(task({ agentPlan: '# Plan' }))).toBe(true);
  });

  it('is false for a card that was only filed under a project', () => {
    expect(wasDelegated(task({ agentProjectId: 'proj-billing' }))).toBe(false);
    expect(wasDelegated(task())).toBe(false);
  });
});

describe('splitProjectTag', () => {
  it('files a merely-tagged card and drops the delegation', () => {
    expect(splitProjectTag(task({ agentProjectId: 'proj-billing' }))).toEqual({
      projectTagId: 'proj-billing',
      agentProjectId: null,
    });
  });

  it('keeps the delegation where a run really happened, and files it too', () => {
    expect(splitProjectTag(task({ agentProjectId: 'proj-billing', sessionId: 's1' }))).toEqual({
      projectTagId: 'proj-billing',
      agentProjectId: 'proj-billing',
    });
  });

  it('never overwrites a tag that already exists', () => {
    const split = splitProjectTag(
      task({ agentProjectId: 'proj-billing', projectTagId: 'proj-web', sessionId: 's1' }),
    );
    expect(split).toEqual({ projectTagId: 'proj-web', agentProjectId: 'proj-billing' });
  });

  it('leaves a card with no agent project untouched', () => {
    expect(splitProjectTag(task())).toEqual({ projectTagId: null, agentProjectId: null });
    expect(splitProjectTag(task({ projectTagId: 'proj-web' }))).toEqual({
      projectTagId: 'proj-web',
      agentProjectId: null,
    });
  });

  it('is idempotent — a second pass over its own output changes nothing', () => {
    // The guard in the store is what stops a rerun, but the predicate must not make the
    // rerun destructive either: a card delegated AFTER the migration has no trace yet.
    for (const original of [
      task({ agentProjectId: 'proj-billing' }),
      task({ agentProjectId: 'proj-billing', sessionId: 's1' }),
    ]) {
      const once = splitProjectTag(original);
      const twice = splitProjectTag({ ...original, ...once });
      expect(twice).toEqual(once);
    }
  });
});
