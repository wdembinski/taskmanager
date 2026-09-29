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
});
