/**
 * The gate row's view model (F8.10): every state the steps list can draw a gate in, the
 * attempt chip, where the output comes from, and that colour is decided by status alone.
 */
import { describe, expect, it } from 'vitest';
import type { AttentionItem } from '@tm/shared/attention';
import type { Task, TaskActivityEntry } from '@tm/shared/model';
import { GATE_TRUST_ACTION, type GateStep } from '@tm/shared/workflow';
import { gateStepView, latestGateNote } from './gateStepView';

const spec: GateStep = {
  id: 'g1',
  kind: 'gate',
  title: 'Tests',
  command: 'pnpm test',
  onFail: { retryFrom: 'a1', maxAttempts: 3 },
};

const step = (over: Partial<Task> = {}): Task =>
  ({
    id: 's2',
    parentTaskId: 'c1',
    title: 'Tests',
    status: 'pending',
    stepSpec: spec,
    gateAttempts: 0,
    ...over,
  }) as Task;

const item = (over: Partial<AttentionItem>): AttentionItem =>
  ({
    id: 'i1',
    runId: 'r1',
    taskId: 's2',
    projectId: 'p1',
    taskTitle: 'Tests',
    kind: 'task-failed',
    prompt: '',
    options: [],
    toolName: null,
    reason: null,
    createdAt: 1,
    ...over,
  }) as AttentionItem;

const note = (id: number, text: string, createdAt: number): TaskActivityEntry => ({
  kind: 'event',
  id,
  event: { kind: 'assistant', text },
  createdAt,
});

describe('gateStepView', () => {
  it('is null for an agent step and for a hand-written one', () => {
    expect(
      gateStepView({
        step: step({ stepSpec: { id: 'a1', kind: 'agent', title: 'x', brief: '' } }),
      }),
    ).toBeNull();
    expect(gateStepView({ step: step({ stepSpec: null }) })).toBeNull();
  });

  it('pending: names the command and says nothing it does not know yet', () => {
    expect(gateStepView({ step: step() })).toEqual({
      state: 'pending',
      label: 'Pending',
      tone: 'pending',
      command: 'pnpm test',
      attempt: null,
      output: null,
    });
  });

  it('running', () => {
    const v = gateStepView({ step: step({ status: 'running' }) })!;
    expect([v.state, v.label, v.tone]).toEqual(['running', 'Running', 'running']);
  });

  it('passed', () => {
    const v = gateStepView({ step: step({ status: 'done' }) })!;
    expect([v.state, v.label, v.tone]).toEqual(['passed', 'Passed', 'done']);
  });

  it('failed — both the raw status and the parked one a failure moves it to', () => {
    for (const status of ['failed', 'waiting-input'] as const) {
      const v = gateStepView({ step: step({ status }) })!;
      expect([v.state, v.label, v.tone]).toEqual(['failed', 'Failed', 'failed']);
    }
  });

  it('awaiting-trust: a trust prompt is not a failure, whatever status it parked in', () => {
    const trust = item({ kind: 'task-failed', options: [GATE_TRUST_ACTION, 'Decline'] });
    for (const status of ['pending', 'waiting-input'] as const) {
      const v = gateStepView({ step: step({ status }), attention: [trust] })!;
      expect([v.state, v.label, v.tone]).toEqual([
        'awaiting-trust',
        'Awaiting trust',
        'waiting-input',
      ]);
    }
  });

  it('stopped', () => {
    expect(gateStepView({ step: step({ status: 'stopped' }) })!.state).toBe('stopped');
  });

  it('the attempt chip appears once the gate has looped back, against its budget', () => {
    expect(gateStepView({ step: step({ gateAttempts: 0 }) })!.attempt).toBeNull();
    expect(gateStepView({ step: step({ gateAttempts: 2 }) })!.attempt).toBe('attempt 2/3');
  });

  it('no chip on a gate without a retry — there is no budget to count against', () => {
    const noRetry: GateStep = { ...spec, onFail: undefined };
    expect(
      gateStepView({ step: step({ stepSpec: noRetry, gateAttempts: 1 }) })!.attempt,
    ).toBeNull();
  });

  it('output: an open failure wins over the timeline', () => {
    const v = gateStepView({
      step: step({ status: 'waiting-input' }),
      attention: [item({ prompt: 'Exit code 2…\n\nFAIL a.test.ts' })],
      activity: [note(1, 'older note', 5)],
    })!;
    expect(v.output).toBe('Exit code 2…\n\nFAIL a.test.ts');
  });

  it('output: otherwise the newest engine note on the gate', () => {
    const v = gateStepView({
      step: step({ gateAttempts: 1 }),
      activity: [note(2, 'second', 20), note(1, 'first', 10)],
    })!;
    expect(v.output).toBe('second');
  });

  it('colour is status alone — the same step in two attempts tones the same', () => {
    const a = gateStepView({ step: step({ status: 'running', gateAttempts: 0 }) })!;
    const b = gateStepView({ step: step({ status: 'running', gateAttempts: 2 }) })!;
    expect(a.tone).toBe(b.tone);
  });
});

describe('latestGateNote', () => {
  it('ignores everything but assistant text', () => {
    const activity: TaskActivityEntry[] = [
      { kind: 'comment', id: 1, body: 'a comment', createdAt: 50 },
      { kind: 'status', id: 2, from: 'pending', to: 'running', createdAt: 60 },
      note(3, 'the note', 10),
    ];
    expect(latestGateNote(activity)).toBe('the note');
    expect(latestGateNote([])).toBeNull();
  });
});
