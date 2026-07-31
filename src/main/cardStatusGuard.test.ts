import { describe, expect, it } from 'vitest';
import { guardCardStatus } from './cardStatusGuard';
import { PERSONAL_PROJECT_ID, type Task, type TaskStatus } from '@shared/model';
import { columnForTask } from '@shared/board';

/** A top-level card of the Personal board — the thing a human drags between columns. */
function card(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    projectId: PERSONAL_PROJECT_ID,
    phase: '',
    title: 'Fix the export dialog',
    status: 'pending',
    sessionId: null,
    order: 0,
    source: 'jira',
    dependsOn: [],
    isContract: false,
    isScaffold: false,
    agentProjectId: 'agent-1',
    ...overrides,
  } as Task;
}

describe('guardCardStatus — a run borrows a card’s status, it never takes it', () => {
  it('parks the human’s status when a run starts', () => {
    expect(guardCardStatus(card({ status: 'in-review' }), { status: 'running' })).toEqual({
      status: 'running',
      preRunStatus: 'in-review',
    });
  });

  it('does not overwrite the parked status as the run changes phase', () => {
    const running = card({ status: 'running', preRunStatus: 'in-review' });
    // running → waiting-input → running must still remember IN REVIEW, not `running`.
    expect(guardCardStatus(running, { status: 'waiting-input' })).toEqual({
      status: 'waiting-input',
    });
    const waiting = card({ status: 'waiting-input', preRunStatus: 'in-review' });
    expect(guardCardStatus(waiting, { status: 'running' })).toEqual({ status: 'running' });
  });

  it('gives the card back exactly where it was when the run settles', () => {
    const running = card({ status: 'running', preRunStatus: 'pending' });
    // The scheduler asks for IN PROGRESS — the write that used to drag a TO DO card into
    // the next column and leave it there.
    expect(guardCardStatus(running, { status: 'in-progress' })).toEqual({
      status: 'pending',
      preRunStatus: null,
    });
  });

  it.each<[string, TaskStatus]>([
    ['a finished run', 'in-progress'],
    ['a completed one', 'done'],
    ['a failed one', 'failed'],
    ['a stopped one', 'stopped'],
    ['a retry re-queue', 'pending'],
  ])('%s cannot move a card out of IN REVIEW', (_why, proposed) => {
    const before = card({ status: 'running', preRunStatus: 'in-review' });
    const after = { ...before, ...guardCardStatus(before, { status: proposed }) };
    expect(after.status).toBe('in-review');
    expect(columnForTask(after)).toBe('in-review');
  });

  it('refuses a resting status even when no run borrowed anything', () => {
    // A card whose approved plan starts is pushed to `in-progress` with nothing in
    // flight on the card itself. It stays in TO DO: its steps are what is running.
    expect(guardCardStatus(card({ status: 'pending' }), { status: 'in-progress' })).toEqual({
      status: 'pending',
      preRunStatus: null,
    });
  });

  it('leaves non-status patches alone', () => {
    const patch = { sessionId: 's1', agentPlan: '# plan' };
    expect(guardCardStatus(card({ status: 'running' }), patch)).toBe(patch);
  });

  it('passes a plan project’s task straight through — its queue IS the lifecycle', () => {
    const planTask = card({ projectId: 'p1', source: 'plan', status: 'running' });
    expect(guardCardStatus(planTask, { status: 'done' })).toEqual({ status: 'done' });
  });

  it('passes a STEP straight through — its chain reads `done` to advance', () => {
    const step = card({ parentTaskId: 't1', id: 's1', status: 'running' });
    expect(guardCardStatus(step, { status: 'done' })).toEqual({ status: 'done' });
  });
});

describe('columnForTask — the board reads where a card rests', () => {
  it('keeps a running card in the column its human left it in', () => {
    expect(columnForTask(card({ status: 'running', preRunStatus: 'pending' }))).toBe('todo');
    expect(columnForTask(card({ status: 'waiting-input', preRunStatus: 'blocked' }))).toBe(
      'blocked',
    );
    expect(columnForTask(card({ status: 'blocked-by-limit', preRunStatus: 'in-review' }))).toBe(
      'in-review',
    );
  });

  it('falls back to `status` for everything else', () => {
    expect(columnForTask(card({ status: 'in-review' }))).toBe('in-review');
    // A plan project's task has nothing parked, so a run does show as IN PROGRESS there.
    expect(columnForTask(card({ projectId: 'p1', status: 'running' }))).toBe('in-progress');
  });
});
