import { describe, expect, it } from 'vitest';
import type { TaskDelta, TaskSummary } from '@shared/taskSummary';
import { createTaskDeltaPusher } from './taskDelta';

function card(id: string, patch: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id,
    projectId: 'p1',
    title: id.toUpperCase(),
    status: 'pending',
    phase: null,
    type: 'task',
    source: 'adhoc',
    order: 0,
    dependsOn: [],
    parentTaskId: null,
    ...patch,
  } as TaskSummary;
}

/** A pusher over an in-memory board per project, recording every delta it sends. */
function harness(initial: Record<string, TaskSummary[]> = {}) {
  const boards = new Map(Object.entries(initial));
  const sent: TaskDelta[] = [];
  const pusher = createTaskDeltaPusher({
    readBoard: (projectId) => boards.get(projectId) ?? [],
    send: (delta) => sent.push(delta),
  });
  return { boards, sent, pusher };
}

describe('createTaskDeltaPusher', () => {
  it('sends nothing when nothing changed', () => {
    const rows = [card('a'), card('b')];
    const { sent, pusher } = harness({ p1: rows });
    pusher.seed('p1', rows);
    pusher.push('p1');
    expect(sent).toEqual([]);
  });

  it('sends one upsert for one changed card', () => {
    const { boards, sent, pusher } = harness({ p1: [card('a'), card('b')] });
    pusher.seed('p1', boards.get('p1')!);
    boards.set('p1', [card('a'), card('b', { status: 'done' })]);
    pusher.push('p1');
    expect(sent).toEqual([
      { projectId: 'p1', upserted: [card('b', { status: 'done' })], removed: [] },
    ]);
  });

  it('sends a removal for a deleted card', () => {
    const { boards, sent, pusher } = harness({ p1: [card('a'), card('b')] });
    pusher.seed('p1', boards.get('p1')!);
    boards.set('p1', [card('a')]);
    pusher.push('p1');
    expect(sent).toEqual([{ projectId: 'p1', upserted: [], removed: ['b'] }]);
  });

  it('sends an upsert for a new step', () => {
    const { boards, sent, pusher } = harness({ p1: [card('a')] });
    pusher.seed('p1', boards.get('p1')!);
    const step = card('a-1', { parentTaskId: 'a', planRound: 1 });
    boards.set('p1', [card('a'), step]);
    pusher.push('p1');
    expect(sent).toEqual([{ projectId: 'p1', upserted: [step], removed: [] }]);
  });

  it('upserts every row of a board it holds no snapshot for', () => {
    const { sent, pusher } = harness({ p1: [card('a'), card('b')] });
    pusher.push('p1');
    expect(sent).toEqual([{ projectId: 'p1', upserted: [card('a'), card('b')], removed: [] }]);
    // …and that push is now the snapshot, so a second push has nothing to say.
    pusher.push('p1');
    expect(sent).toHaveLength(1);
  });

  it('does not send a card again that task:changed already carried', () => {
    const { boards, sent, pusher } = harness({ p1: [card('a')] });
    pusher.seed('p1', boards.get('p1')!);
    const renamed = card('a', { title: 'Renamed' });
    boards.set('p1', [renamed]);
    pusher.noteChanged(renamed);
    pusher.push('p1');
    expect(sent).toEqual([]);
  });

  it('still moves a card between boards after task:changed announced the move', () => {
    const a = card('a');
    const { boards, sent, pusher } = harness({ p1: [a], p2: [] });
    pusher.seed('p1', [a]);
    pusher.seed('p2', []);
    const moved = card('a', { projectId: 'p2' });
    boards.set('p1', []);
    boards.set('p2', [moved]);
    pusher.noteChanged(moved);
    pusher.push('p1');
    pusher.push('p2');
    expect(sent).toEqual([
      { projectId: 'p1', upserted: [], removed: ['a'] },
      { projectId: 'p2', upserted: [moved], removed: [] },
    ]);
  });

  it('sends summaries only, whatever the board read returned', () => {
    const full = { ...card('a'), agentPlan: 'x'.repeat(5000), description: 'long' };
    const { sent, pusher } = harness({ p1: [full as TaskSummary] });
    pusher.push('p1');
    expect(sent[0]!.upserted[0]).not.toHaveProperty('agentPlan');
    expect(sent[0]!.upserted[0]).not.toHaveProperty('description');
  });
});
