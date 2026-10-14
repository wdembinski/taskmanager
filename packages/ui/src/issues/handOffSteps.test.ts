/**
 * The write order `handOffSteps` emits, the executor's "never roll back the imported card"
 * rule, and `handOffMessage`'s wording — proven over a fake transport rather than assumed. See
 * the module docstring for why each piece is pure and separate from `IssuesScreen` itself.
 */
import { describe, expect, it, vi } from 'vitest';
import type { IssueSummary } from '@tm/shared/issues';
import { RUN_REFUSAL_MESSAGE } from '@tm/shared/scheduler';
import type { AddTaskAssign } from '../AddTaskDialog';
import type { TransportInvoke } from '../addTaskSteps';
import {
  executeHandOffSteps,
  handOffMessage,
  handOffSteps,
  type HandOffRequest,
  type HandOffResult,
  type HandOffStep,
} from './handOffSteps';

const issue = (over: Partial<IssueSummary> = {}): IssueSummary => ({
  provider: 'jira',
  key: 'A-1',
  title: 'Title',
  url: 'https://example.test/A-1',
  state: 'Open',
  labels: [],
  updatedAt: 1,
  onBoardTaskId: null,
  ...over,
});

const assign = (over: Partial<AddTaskAssign> = {}): AddTaskAssign => ({
  agentProjectId: 'p-repo',
  model: null,
  mode: null,
  ...over,
});

const addRequest: HandOffRequest = { action: 'add' };
const handRequest = (
  over: Partial<Extract<HandOffRequest, { action: 'hand' }>> = {},
): HandOffRequest => ({
  action: 'hand',
  assign: assign(),
  prompt: '',
  ...over,
});

describe('handOffSteps', () => {
  it('skips the import for an issue already on the board and assigns the existing card', () => {
    const steps = handOffSteps(issue({ onBoardTaskId: 'task-1' }), handRequest());
    expect(steps.map((s) => s.kind)).toEqual(['assign']);
  });

  it('emits exactly one import and no assign for a plain add', () => {
    const steps = handOffSteps(issue(), addRequest);
    expect(steps).toEqual([{ kind: 'import', provider: 'jira', key: 'A-1' }]);
  });

  it('emits no steps at all for an add on an issue already on the board', () => {
    const steps = handOffSteps(issue({ onBoardTaskId: 'task-1' }), addRequest);
    expect(steps).toEqual([]);
  });

  it('trims the prompt box notes and omits them when blank', () => {
    const withNotes = handOffSteps(issue(), handRequest({ prompt: '  do the thing  ' }));
    const step = withNotes.find((s) => s.kind === 'assign') as Extract<
      HandOffStep,
      { kind: 'assign' }
    >;
    expect(step.assign.notes).toBe('do the thing');

    const blank = handOffSteps(issue(), handRequest({ prompt: '   ' }));
    const blankStep = blank.find((s) => s.kind === 'assign') as Extract<
      HandOffStep,
      { kind: 'assign' }
    >;
    expect(blankStep.assign.notes).toBe(null);
  });

  it('passes model and mode through to the assign step untouched', () => {
    const steps = handOffSteps(
      issue(),
      handRequest({ assign: assign({ model: 'opus', mode: 'plan' }) }),
    );
    const step = steps.find((s) => s.kind === 'assign') as Extract<HandOffStep, { kind: 'assign' }>;
    expect(step.assign).toMatchObject({ model: 'opus', mode: 'plan' });
    expect(step.start).toBe(true);
  });

  it('orders import before assign for a hand request on a new issue', () => {
    const steps = handOffSteps(issue(), handRequest());
    expect(steps.map((s) => s.kind)).toEqual(['import', 'assign']);
  });
});

describe('executeHandOffSteps', () => {
  const task = (over: Record<string, unknown> = {}) => ({
    id: 'new-task',
    status: 'pending',
    ...over,
  });

  it('imports and returns taskId with run "none" and imported true for a plain add', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'issues:import') return task();
      throw new Error(`unexpected channel ${channel}`);
    }) as unknown as TransportInvoke;

    const steps: HandOffStep[] = [{ kind: 'import', provider: 'jira', key: 'A-1' }];
    const result = await executeHandOffSteps(steps, issue(), invoke);
    expect(result).toEqual({ taskId: 'new-task', imported: true, run: 'none' });
    expect(invoke).not.toHaveBeenCalledWith(
      'task:assignAgent',
      expect.anything(),
      expect.anything(),
    );
  });

  it('propagates a throw from import rather than catching it, and never calls assign', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'issues:import') throw new Error('tracker unreachable');
      throw new Error(`unexpected channel ${channel}`);
    }) as unknown as TransportInvoke;

    const steps: HandOffStep[] = [
      { kind: 'import', provider: 'jira', key: 'A-1' },
      { kind: 'assign', assign: { ...assign(), notes: null }, start: true },
    ];

    await expect(executeHandOffSteps(steps, issue(), invoke)).rejects.toThrow(
      'tracker unreachable',
    );
    expect(invoke).not.toHaveBeenCalledWith(
      'task:assignAgent',
      expect.anything(),
      expect.anything(),
    );
  });

  it('keeps the imported taskId and reports not-started when assign throws a known refusal', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'issues:import') return task();
      if (channel === 'task:assignAgent') throw new Error(RUN_REFUSAL_MESSAGE['no-project']);
      throw new Error(`unexpected channel ${channel}`);
    }) as unknown as TransportInvoke;

    const steps: HandOffStep[] = [
      { kind: 'import', provider: 'jira', key: 'A-1' },
      { kind: 'assign', assign: { ...assign(), notes: null }, start: true },
    ];

    const result = await executeHandOffSteps(steps, issue(), invoke);
    expect(result.taskId).toBe('new-task');
    expect(result.run).toMatchObject({ kind: 'not-started', refusal: 'no-project' });
    expect(invoke).not.toHaveBeenCalledWith('task:delete', expect.anything());
  });

  it('keeps the imported taskId and reports not-started with the verbatim message for an arbitrary refusal', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'issues:import') return task();
      if (channel === 'task:assignAgent') throw new Error('disk is full');
      throw new Error(`unexpected channel ${channel}`);
    }) as unknown as TransportInvoke;

    const steps: HandOffStep[] = [
      { kind: 'import', provider: 'jira', key: 'A-1' },
      { kind: 'assign', assign: { ...assign(), notes: null }, start: true },
    ];

    const result = await executeHandOffSteps(steps, issue(), invoke);
    expect(result.taskId).toBe('new-task');
    expect(result.run).toMatchObject({
      kind: 'not-started',
      reason: 'disk is full',
      refusal: null,
    });
    expect(invoke).not.toHaveBeenCalledWith('task:delete', expect.anything());
  });

  it('reports a limit park as parked, keeping the resolved task', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'issues:import') return task();
      if (channel === 'task:assignAgent') return task({ status: 'blocked-by-limit' });
      throw new Error(`unexpected channel ${channel}`);
    }) as unknown as TransportInvoke;

    const steps: HandOffStep[] = [
      { kind: 'import', provider: 'jira', key: 'A-1' },
      { kind: 'assign', assign: { ...assign(), notes: null }, start: true },
    ];

    const result = await executeHandOffSteps(steps, issue(), invoke);
    expect(result.run).toEqual({ kind: 'parked', refusal: 'limit' });
  });

  it('reports a sign-out park as parked even though assign threw', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'issues:import') return task();
      if (channel === 'task:assignAgent') throw new Error(RUN_REFUSAL_MESSAGE['signed-out']);
      throw new Error(`unexpected channel ${channel}`);
    }) as unknown as TransportInvoke;

    const steps: HandOffStep[] = [
      { kind: 'import', provider: 'jira', key: 'A-1' },
      { kind: 'assign', assign: { ...assign(), notes: null }, start: true },
    ];

    const result = await executeHandOffSteps(steps, issue(), invoke);
    expect(result.run).toEqual({ kind: 'parked', refusal: 'signed-out' });
  });

  it('targets the already-on-board taskId and never imports when the issue is already on the board', async () => {
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'task:assignAgent') {
        expect(args[0]).toBe('on-board-task');
        return task({ id: 'on-board-task' });
      }
      throw new Error(`unexpected channel ${channel}`);
    }) as unknown as TransportInvoke;

    const steps: HandOffStep[] = [
      { kind: 'assign', assign: { ...assign(), notes: null }, start: true },
    ];

    const result = await executeHandOffSteps(
      steps,
      issue({ onBoardTaskId: 'on-board-task' }),
      invoke,
    );
    expect(result.taskId).toBe('on-board-task');
    expect(result.imported).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith('issues:import', expect.anything(), expect.anything());
  });

  it('returns the on-board taskId untouched with run "none" when nothing was asked but add', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('no channel should be called');
    }) as unknown as TransportInvoke;

    const result = await executeHandOffSteps([], issue({ onBoardTaskId: 'on-board-task' }), invoke);
    expect(result).toEqual({ taskId: 'on-board-task', imported: false, run: 'none' });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('handOffMessage', () => {
  const result = (over: Partial<HandOffResult> = {}): HandOffResult => ({
    taskId: 't1',
    imported: true,
    run: 'none',
    ...over,
  });

  it('reads a plain add as success regardless of the result', () => {
    expect(handOffMessage(result(), addRequest)).toEqual({
      tone: 'success',
      text: 'Added to the board.',
    });
  });

  it('reads a started hand-off as success', () => {
    expect(handOffMessage(result({ run: 'started' }), handRequest())).toEqual({
      tone: 'success',
      text: 'Handed to the agent — the run has started.',
    });
  });

  it('reads a limit park as success, naming the park', () => {
    const message = handOffMessage(
      result({ run: { kind: 'parked', refusal: 'limit' } }),
      handRequest(),
    );
    expect(message.tone).toBe('success');
    expect(message.text).toBe(`On the board and queued — ${RUN_REFUSAL_MESSAGE.limit}`);
  });

  it('reads a sign-out park as success too', () => {
    const message = handOffMessage(
      result({ run: { kind: 'parked', refusal: 'signed-out' } }),
      handRequest(),
    );
    expect(message.tone).toBe('success');
    expect(message.text).toBe(`On the board and queued — ${RUN_REFUSAL_MESSAGE['signed-out']}`);
  });

  it('warns on a not-started run, containing the reason verbatim', () => {
    const message = handOffMessage(
      result({
        run: {
          kind: 'not-started',
          reason: RUN_REFUSAL_MESSAGE['no-project'],
          refusal: 'no-project',
        },
      }),
      handRequest(),
    );
    expect(message.tone).toBe('warning');
    expect(message.text).toContain(RUN_REFUSAL_MESSAGE['no-project']);
  });
});
