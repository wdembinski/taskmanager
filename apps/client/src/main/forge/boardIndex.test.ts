/**
 * `buildBoardIndex` itself, pure and Electron-free. The regression this guards against —
 * a card off the Personal board being invisible to a PR/MR sync — is only provable end to
 * end through a real store (see `scripts/verify-create-pr.mjs`'s new scenario); what belongs
 * here is the loop's own contract, so a future edit to it fails fast under vitest instead of
 * only in that slower harness.
 */
import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@shared/model';
import { buildBoardIndex } from './boardIndex';

const card = (over: Partial<Task> = {}): Task =>
  ({
    id: 'task-1',
    projectId: 'board-1',
    phase: '',
    title: 'Do a thing',
    status: 'pending',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'adhoc',
    isContract: false,
    isScaffold: false,
    ...over,
  }) as Task;

describe('buildBoardIndex', () => {
  it('indexes a non-Personal board card by its id, native ticket key, and external key', () => {
    const ticket = card({ id: 'task-ticket', projectId: 'board-1', ticketKey: 'MKT-3' });
    const mirrored = card({
      id: 'task-mirrored',
      projectId: 'board-1',
      externalSource: 'github',
      externalKey: 'acme/web#7',
    });
    const index = buildBoardIndex([ticket, mirrored]);

    expect(index.knownTaskIds).toEqual(new Set(['task-ticket', 'task-mirrored']));
    expect(index.taskIdByKey.get('MKT-3')).toBe('task-ticket');
    expect(index.taskIdByKey.get('ACME/WEB#7')).toBe('task-mirrored');
  });

  it('still indexes a card on the Personal board the same way', () => {
    const personal = card({
      id: 'task-personal',
      projectId: PERSONAL_PROJECT_ID,
      ticketKey: 'TM-9',
    });
    const index = buildBoardIndex([personal]);

    expect(index.knownTaskIds.has('task-personal')).toBe(true);
    expect(index.taskIdByKey.get('TM-9')).toBe('task-personal');
  });

  // A tracker's own key is the mirrored issue's real name; a native ticket that happens to
  // spell the same key must never steal that mapping — see `boardIndex.ts` for why. Both
  // orderings are checked because `externalKey` overwrites unconditionally while `ticketKey`
  // only fills a gap, so the outcome must not depend on which task the loop sees first.
  it('keeps a colliding key pointed at the externalKey task, regardless of order', () => {
    const mirrored = card({
      id: 'task-mirrored',
      projectId: 'board-1',
      externalSource: 'github',
      externalKey: 'DUP-1',
    });
    const ticket = card({ id: 'task-ticket', projectId: 'board-1', ticketKey: 'DUP-1' });

    expect(buildBoardIndex([mirrored, ticket]).taskIdByKey.get('DUP-1')).toBe('task-mirrored');
    expect(buildBoardIndex([ticket, mirrored]).taskIdByKey.get('DUP-1')).toBe('task-mirrored');
  });

  describe('taskIdByBranch', () => {
    it('maps a top-level card’s agentBranch to the card', () => {
      const index = buildBoardIndex([card({ id: 'a', agentBranch: 'feat/a' })]);
      expect(index.taskIdByBranch.get('feat/a')).toBe('a');
    });

    it('falls back to the legacy orch/<id> branch when none was chosen', () => {
      const index = buildBoardIndex([card({ id: 'a', agentBranch: null })]);
      expect(index.taskIdByBranch.get('orch/a')).toBe('a');
    });

    it('never lets a step win its parent’s branch, whichever comes first', () => {
      const parent = card({ id: 'parent', agentBranch: 'feat/p' });
      const step = card({ id: 'step', parentTaskId: 'parent', agentBranch: 'feat/p' });
      expect(buildBoardIndex([step, parent]).taskIdByBranch.get('feat/p')).toBe('parent');
      expect(buildBoardIndex([parent, step]).taskIdByBranch.get('feat/p')).toBe('parent');
    });

    it('matches neither of two top-level cards on one branch', () => {
      const index = buildBoardIndex([
        card({ id: 'a', agentBranch: 'feat/shared' }),
        card({ id: 'b', agentBranch: 'feat/shared' }),
        card({ id: 'c', agentBranch: 'feat/shared' }),
      ]);
      expect(index.taskIdByBranch.has('feat/shared')).toBe(false);
    });

    it('is exact and case-sensitive, as git is', () => {
      const index = buildBoardIndex([card({ id: 'a', agentBranch: 'feat/Login' })]);
      expect(index.taskIdByBranch.get('feat/login')).toBeUndefined();
    });

    it('skips an archived card', () => {
      const index = buildBoardIndex([card({ id: 'a', agentBranch: 'feat/a', archivedAt: 5 })]);
      expect(index.taskIdByBranch.has('feat/a')).toBe(false);
    });
  });
});
