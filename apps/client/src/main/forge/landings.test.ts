import { describe, expect, it } from 'vitest';
import type { MergeRequest } from '@shared/mergeRequest';
import type { Task } from '@shared/model';
import { MERGED_SEARCH_MAX_DAYS, mergedRowsToLand, unlandedBranchCandidates } from './landings';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-25T09:00:00Z');

const card = (over: Partial<Task> & { id: string }): Task =>
  ({
    projectId: 'board',
    phase: '',
    title: over.id,
    status: 'in-progress',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'ticket',
    isContract: false,
    isScaffold: false,
    parentTaskId: null,
    landedAt: null,
    workedAt: NOW - DAY,
    agentBranch: `feat/${over.id}`,
    ...over,
  }) as Task;

const row = (over: Partial<MergeRequest> = {}): MergeRequest =>
  ({
    id: 'gh-1-1',
    taskId: 'a',
    openedForTaskId: null,
    provider: 'github',
    projectPath: 'acme/web',
    number: 1,
    sourceBranch: 'feat/a',
    targetBranch: 'main',
    state: 'merged',
    mergedAt: 500,
    ...over,
  }) as MergeRequest;

const board = (tasks: Task[]) => {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return (id: string) => byId.get(id);
};

describe('mergedRowsToLand', () => {
  it('lands a merged row in this sync’s upserts, as before', () => {
    const merged = row();
    expect(mergedRowsToLand([merged], [merged], board([card({ id: 'a' })]))).toEqual([
      { taskId: 'a', mr: merged },
    ]);
  });

  it('lands a row a later re-match filed — it is in no upsert at all', () => {
    // The sync that read it as merged saw `taskId: null`; the re-match filed it afterwards.
    const refiled = row({ taskId: 'a' });
    expect(mergedRowsToLand([], [refiled], board([card({ id: 'a' })]))).toEqual([
      { taskId: 'a', mr: refiled },
    ]);
  });

  it('lands a row merged on an earlier sync while it had no card, once the card is filed', () => {
    const earlier = row({ taskId: null });
    const getTask = board([card({ id: 'a' })]);
    // First sync: merged, nobody's — nothing to land.
    expect(mergedRowsToLand([earlier], [earlier], getTask)).toEqual([]);
    // A later sync files it (branch match, link, board change) without re-upserting it merged.
    const filed = { ...earlier, taskId: 'a' };
    expect(mergedRowsToLand([], [filed], getTask)).toEqual([{ taskId: 'a', mr: filed }]);
  });

  it('does not return a card that already landed, from the stored half', () => {
    const merged = row();
    expect(mergedRowsToLand([], [merged], board([card({ id: 'a', landedAt: 123 })]))).toEqual([]);
  });

  it('returns one entry per card, preferring the upserted row', () => {
    const upserted = row({ id: 'gh-1-2', number: 2 });
    const stored = [row(), upserted];
    expect(mergedRowsToLand([upserted], stored, board([card({ id: 'a' })]))).toEqual([
      { taskId: 'a', mr: upserted },
    ]);
  });

  it('ignores open and closed rows, GitLab rows, and rows whose card is gone', () => {
    const getTask = board([card({ id: 'a' })]);
    expect(
      mergedRowsToLand(
        [],
        [
          row({ state: 'opened' }),
          row({ state: 'closed' }),
          row({ provider: 'gitlab' }),
          row({ taskId: 'gone' }),
        ],
        getTask,
      ),
    ).toEqual([]);
  });
});

describe('unlandedBranchCandidates', () => {
  it('names a worked, unlanded top-level card whose branch no stored row explains', () => {
    const result = unlandedBranchCandidates([card({ id: 'a' })], [], NOW);
    expect(result.byBranch).toEqual(new Map([['feat/a', 'a']]));
    expect(result.since).toBe(new Date(NOW - DAY).toISOString().slice(0, 10));
  });

  it('has no candidate — and no search date — when every branch has a stored row', () => {
    const result = unlandedBranchCandidates([card({ id: 'a' })], [row()], NOW);
    expect(result.byBranch.size).toBe(0);
    expect(result.since).toBeNull();
  });

  it('skips steps, landed, unworked, done, cancelled and archived cards', () => {
    const result = unlandedBranchCandidates(
      [
        card({ id: 'step', parentTaskId: 'p' }),
        card({ id: 'landed', landedAt: 1 }),
        card({ id: 'idle', workedAt: null }),
        card({ id: 'done', status: 'done' }),
        card({ id: 'cancelled', status: 'cancelled' }),
        card({ id: 'archived', archivedAt: 1 }),
      ],
      [],
      NOW,
    );
    expect(result.byBranch.size).toBe(0);
    expect(result.since).toBeNull();
  });

  it('reads where a running card RESTS, not the status the run borrowed', () => {
    const resting = card({ id: 'a', status: 'running', preRunStatus: 'done' });
    expect(unlandedBranchCandidates([resting], [], NOW).byBranch.size).toBe(0);
  });

  it('drops a branch two cards share', () => {
    const result = unlandedBranchCandidates(
      [card({ id: 'a', agentBranch: 'feat/x' }), card({ id: 'b', agentBranch: 'feat/x' })],
      [],
      NOW,
    );
    expect(result.byBranch.size).toBe(0);
  });

  it('uses the legacy orch/<id> branch for a card with no chosen name', () => {
    const result = unlandedBranchCandidates([card({ id: 'a', agentBranch: null })], [], NOW);
    expect(result.byBranch.get('orch/a')).toBe('a');
  });

  it('searches from the oldest candidate, but never further back than the cap', () => {
    const result = unlandedBranchCandidates(
      [card({ id: 'new', workedAt: NOW - 2 * DAY }), card({ id: 'ancient', workedAt: 0 })],
      [],
      NOW,
    );
    expect(result.since).toBe(
      new Date(NOW - MERGED_SEARCH_MAX_DAYS * DAY).toISOString().slice(0, 10),
    );
  });
});
