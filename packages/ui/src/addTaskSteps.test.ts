/**
 * The write order `addTaskSteps` emits, the one banner `outcomeMessage` reduces an
 * `AddTaskResult` to, and the executor's "never roll back the card" rule — proven over a
 * fake transport rather than assumed. See the module docstring for why each of these three
 * pieces is pure and separate from `AddTaskDialog` itself.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AddTaskPlan } from './AddTaskDialog';
import {
  addTaskSteps,
  executeAddTaskSteps,
  outcomeMessage,
  refusalFromMessage,
  type AddTaskResult,
  type AddTaskStep,
  type TransportInvoke,
} from './addTaskSteps';
import type { BoardColumn } from '@tm/shared/model';
import { RUN_REFUSAL_MESSAGE, type RunRefusal } from '@tm/shared/scheduler';

const cardPlan = (over: Partial<Extract<AddTaskPlan, { kind: 'card' }>> = {}) =>
  ({
    kind: 'card',
    board: 'p-repo',
    card: { title: 'Ship it', type: 'feature', projectTagId: 'p-repo' },
    ticket: null,
    assign: null,
    startNow: false,
    trigger: null,
    ...over,
  }) satisfies Extract<AddTaskPlan, { kind: 'card' }>;

const ticketPlan = (over: Partial<Extract<AddTaskPlan, { kind: 'ticket' }>> = {}) =>
  ({
    kind: 'ticket',
    board: 'p-billing',
    ticket: {
      title: 'Ship it',
      issueType: 'task',
      epicTaskId: null,
      projectTagId: 'p-billing',
    },
    assign: null,
    startNow: false,
    trigger: null,
    ...over,
  }) satisfies Extract<AddTaskPlan, { kind: 'ticket' }>;

const stepPlan = (over: Partial<Extract<AddTaskPlan, { kind: 'step' }>> = {}) =>
  ({
    kind: 'step',
    parentId: 'c1',
    step: { title: 'Do the thing', description: null },
    ...over,
  }) satisfies Extract<AddTaskPlan, { kind: 'step' }>;

const extras = (
  over: Partial<{
    attachments: readonly string[];
    runsAfterId: string | null;
    timeZone: string;
    column: BoardColumn;
  }> = {},
) => ({
  attachments: [],
  runsAfterId: null,
  timeZone: 'UTC',
  ...over,
});

describe('addTaskSteps', () => {
  it('orders a card with a ticket, files, a chain and an assign exactly as the dialog wrote them', () => {
    const plan = cardPlan({
      ticket: { projectKey: 'ABC', issueTypeId: '10001', summary: 'Ship it' },
      assign: { agentProjectId: 'p-repo', model: 'opus', mode: 'plan' },
      startNow: true,
    });
    const steps = addTaskSteps(plan, extras({ attachments: ['/a.png'], runsAfterId: 'c0' }));
    expect(steps.map((s) => s.kind)).toEqual([
      'create-card',
      'link-jira',
      'attach',
      'chain-after',
      'assign',
    ]);
    expect(steps[4]).toEqual({
      kind: 'assign',
      assign: { agentProjectId: 'p-repo', model: 'opus', mode: 'plan' },
      start: true,
    });
  });

  it('emits only the create step (plus attach) for a step plan', () => {
    const steps = addTaskSteps(stepPlan(), extras({ attachments: ['/a.png'] }));
    expect(steps).toEqual([
      { kind: 'create-step', parentId: 'c1', step: { title: 'Do the thing', description: null } },
      { kind: 'attach', paths: ['/a.png'] },
    ]);
  });

  it('never emits chain or assign steps for a step plan, whatever extras say', () => {
    const steps = addTaskSteps(stepPlan(), extras({ runsAfterId: 'c0' }));
    expect(steps.map((s) => s.kind)).toEqual(['create-step']);
  });

  it('emits exactly one step for a card with no ticket, files, chain or assign', () => {
    const steps = addTaskSteps(cardPlan(), extras());
    expect(steps).toEqual([{ kind: 'create-card', board: 'p-repo', card: cardPlan().card }]);
  });

  it('emits no attach step when nothing was staged', () => {
    const steps = addTaskSteps(cardPlan(), extras({ attachments: [] }));
    expect(steps.some((s) => s.kind === 'attach')).toBe(false);
  });

  it('never emits link-jira for a ticket-board plan', () => {
    const steps = addTaskSteps(
      ticketPlan({ assign: { agentProjectId: 'p-billing', model: null, mode: null } }),
      extras(),
    );
    expect(steps.map((s) => s.kind)).toEqual(['create-ticket', 'assign']);
  });

  it('carries startNow into the assign step for a ticket-board plan', () => {
    const steps = addTaskSteps(
      ticketPlan({
        assign: { agentProjectId: 'p-billing', model: null, mode: null },
        startNow: true,
      }),
      extras(),
    );
    const assign = steps.find((s) => s.kind === 'assign');
    expect(assign).toMatchObject({ start: true });
  });

  it('puts the trigger schedule after the chain and before assign, honouring startNow too', () => {
    const trigger = { kind: 'schedule', schedule: { type: 'daily', hour: 9, minute: 0 } } as const;
    const assign = { agentProjectId: 'p-repo', model: null, mode: 'plan' } as const;
    const steps = addTaskSteps(
      cardPlan({ assign, startNow: true, trigger }),
      extras({ runsAfterId: 'c0', timeZone: 'Europe/Warsaw' }),
    );
    expect(steps.map((s) => s.kind)).toEqual(['create-card', 'chain-after', 'schedule', 'assign']);
    expect(steps[2]).toEqual({ kind: 'schedule', trigger, assign, timeZone: 'Europe/Warsaw' });
    expect(steps[3]).toMatchObject({ kind: 'assign', start: true });
  });

  it('emits a schedule step for a ticket-board plan too', () => {
    const steps = addTaskSteps(
      ticketPlan({
        assign: { agentProjectId: 'p-billing', model: null, mode: null },
        trigger: { kind: 'schedule', schedule: { type: 'hours', every: 4 } },
      }),
      extras(),
    );
    expect(steps.map((s) => s.kind)).toEqual(['create-ticket', 'schedule', 'assign']);
  });

  it('emits no schedule step without a trigger', () => {
    const steps = addTaskSteps(
      cardPlan({ assign: { agentProjectId: 'p-repo', model: null, mode: null } }),
      extras(),
    );
    expect(steps.some((s) => s.kind === 'schedule')).toBe(false);
  });

  it('moves a card added from a column header into that column, after create and the JIRA link', () => {
    const steps = addTaskSteps(
      cardPlan({
        ticket: { projectKey: 'ABC', issueTypeId: '10001', summary: 'Ship it' },
        assign: { agentProjectId: 'p-repo', model: null, mode: null },
      }),
      extras({ attachments: ['/a.png'], runsAfterId: 'c0', column: 'in-review' }),
    );
    expect(steps.map((s) => s.kind)).toEqual([
      'create-card',
      'link-jira',
      'move',
      'attach',
      'chain-after',
      'assign',
    ]);
    expect(steps[2]).toEqual({ kind: 'move', column: 'in-review' });
  });

  it('moves a native ticket too, before its assign', () => {
    const steps = addTaskSteps(
      ticketPlan({ assign: { agentProjectId: 'p-billing', model: null, mode: null } }),
      extras({ column: 'blocked' }),
    );
    expect(steps.map((s) => s.kind)).toEqual(['create-ticket', 'move', 'assign']);
  });

  it('emits no move for To Do, where a new card lands anyway, or with no column', () => {
    expect(addTaskSteps(cardPlan(), extras({ column: 'todo' })).map((s) => s.kind)).toEqual([
      'create-card',
    ]);
    expect(addTaskSteps(cardPlan(), extras()).some((s) => s.kind === 'move')).toBe(false);
  });

  it('never moves a step, whatever column the dialog was opened from', () => {
    const steps = addTaskSteps(stepPlan(), extras({ column: 'in-review' }));
    expect(steps.map((s) => s.kind)).toEqual(['create-step']);
  });
});

describe('refusalFromMessage', () => {
  it('round-trips every RUN_REFUSAL_MESSAGE entry', () => {
    for (const refusal of Object.keys(RUN_REFUSAL_MESSAGE) as RunRefusal[]) {
      expect(refusalFromMessage(RUN_REFUSAL_MESSAGE[refusal])).toBe(refusal);
    }
  });

  it('answers null for an arbitrary string', () => {
    expect(refusalFromMessage('a network error, say')).toBe(null);
  });
});

describe('outcomeMessage', () => {
  const result = (over: Partial<AddTaskResult> = {}): AddTaskResult => ({
    created: 'card',
    problems: [],
    run: 'started',
    ...over,
  });

  it('reads a limit park as success', () => {
    const outcome = outcomeMessage(result({ run: { kind: 'parked', refusal: 'limit' } }));
    expect(outcome?.tone).toBe('success');
    expect(outcome?.text).toBe(`Created and queued — ${RUN_REFUSAL_MESSAGE.limit}`);
  });

  it('reads a signed-out park as success too', () => {
    const outcome = outcomeMessage(result({ run: { kind: 'parked', refusal: 'signed-out' } }));
    expect(outcome?.tone).toBe('success');
    expect(outcome?.text).toBe(`Created and queued — ${RUN_REFUSAL_MESSAGE['signed-out']}`);
  });

  it('warns on a no-project refusal, naming the fix', () => {
    const outcome = outcomeMessage(
      result({
        run: {
          kind: 'not-started',
          reason: RUN_REFUSAL_MESSAGE['no-project'],
          refusal: 'no-project',
        },
      }),
    );
    expect(outcome?.tone).toBe('warning');
    expect(outcome?.text.startsWith('Created, not started:')).toBe(true);
    expect(outcome?.text).toContain(RUN_REFUSAL_MESSAGE['no-project']);
  });

  it('is null for a started run with no problems', () => {
    expect(outcomeMessage(result({ run: 'started' }))).toBe(null);
    expect(outcomeMessage(result({ run: 'assigned' }))).toBe(null);
    expect(outcomeMessage(result({ run: 'none' }))).toBe(null);
  });

  it('forces a warning even over a started run when there are problems', () => {
    const outcome = outcomeMessage(
      result({
        run: 'started',
        problems: ['The card was created, but its files were not attached — nope'],
      }),
    );
    expect(outcome?.tone).toBe('warning');
    expect(outcome?.text).toBe('The card was created, but its files were not attached — nope');
  });

  it('combines a ticket-creation problem and an assign refusal into one message', () => {
    const outcome = outcomeMessage(
      result({
        run: {
          kind: 'not-started',
          reason: RUN_REFUSAL_MESSAGE['no-project'],
          refusal: 'no-project',
        },
        problems: ['The card was created, but its JIRA ticket was not — unreachable'],
      }),
    );
    expect(outcome?.tone).toBe('warning');
    expect(outcome?.text).toBe(
      `Created, not started: ${RUN_REFUSAL_MESSAGE['no-project']} The card was created, but its JIRA ticket was not — unreachable`,
    );
  });
});

describe('executeAddTaskSteps', () => {
  const task = (over: Record<string, unknown> = {}) => ({ id: 't1', status: 'pending', ...over });

  it('keeps the created card and reports a not-started run when assign throws no-project', async () => {
    const invoke = vi.fn(async (channel: string, ..._args: unknown[]) => {
      if (channel === 'task:create') return task();
      if (channel === 'task:assignAgent') throw new Error(RUN_REFUSAL_MESSAGE['no-project']);
      throw new Error(`unexpected channel ${channel}`);
    }) as unknown as TransportInvoke;

    const steps: AddTaskStep[] = [
      {
        kind: 'create-card',
        board: 'p-repo',
        card: { title: 'Ship it', type: 'feature', projectTagId: 'p-repo' },
      },
      {
        kind: 'assign',
        assign: { agentProjectId: 'p-repo', model: null, mode: null },
        start: true,
      },
    ];

    const result = await executeAddTaskSteps(steps, invoke);
    expect(result.created).toBe('card');
    expect(result.run).toMatchObject({ kind: 'not-started', refusal: 'no-project' });
    expect(invoke).not.toHaveBeenCalledWith('task:delete', expect.anything());
  });

  it('propagates a throw from the create step rather than catching it', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('disk is full');
    }) as unknown as TransportInvoke;

    const steps: AddTaskStep[] = [
      {
        kind: 'create-card',
        board: 'p-repo',
        card: { title: 'Ship it', type: 'feature', projectTagId: 'p-repo' },
      },
    ];

    await expect(executeAddTaskSteps(steps, invoke)).rejects.toThrow('disk is full');
  });

  it('settles started once assign resolves with a non-limit task', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'task:create') return task();
      if (channel === 'task:assignAgent') return task();
      throw new Error(`unexpected channel ${channel}`);
    }) as unknown as TransportInvoke;

    const steps: AddTaskStep[] = [
      {
        kind: 'create-card',
        board: 'p-repo',
        card: { title: 'Ship it', type: 'feature', projectTagId: 'p-repo' },
      },
      {
        kind: 'assign',
        assign: { agentProjectId: 'p-repo', model: null, mode: null },
        start: true,
      },
    ];

    const result = await executeAddTaskSteps(steps, invoke);
    expect(result.run).toBe('started');
    expect(result.problems).toEqual([]);
  });

  const scheduled: AddTaskStep[] = [
    {
      kind: 'create-card',
      board: 'p-repo',
      card: { title: 'Ship it', type: 'feature', projectTagId: 'p-repo' },
    },
    {
      kind: 'schedule',
      trigger: { kind: 'schedule', schedule: { type: 'daily', hour: 9, minute: 0 } },
      assign: { agentProjectId: 'p-repo', model: 'opus', mode: null },
      timeZone: 'Europe/Warsaw',
    },
  ];

  it('saves an automation pointed at the id the create step returned', async () => {
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'task:create') return task({ id: 'new-card', title: 'Ship it' });
      if (channel === 'automation:save') return args[0];
      throw new Error(`unexpected channel ${channel}`);
    }) as unknown as TransportInvoke;

    const result = await executeAddTaskSteps(scheduled, invoke);
    expect(result.problems).toEqual([]);
    expect(invoke).toHaveBeenCalledWith(
      'automation:save',
      expect.objectContaining({
        timeZone: 'Europe/Warsaw',
        trigger: { kind: 'schedule', schedule: { type: 'daily', hour: 9, minute: 0 } },
        action: expect.objectContaining({
          taskId: 'new-card',
          agentProjectId: 'p-repo',
          model: 'opus',
          mode: 'acceptEdits',
        }),
      }),
    );
  });

  it('keeps the card and words a problem when the schedule will not save', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'task:create') return task({ title: 'Ship it' });
      if (channel === 'automation:save') throw new Error('engine offline');
      throw new Error(`unexpected channel ${channel}`);
    }) as unknown as TransportInvoke;

    const result = await executeAddTaskSteps(scheduled, invoke);
    expect(result.created).toBe('card');
    expect(result.problems).toEqual([
      'The card was created, but its schedule was not saved — engine offline',
    ]);
    expect(invoke).not.toHaveBeenCalledWith('task:delete', expect.anything());
  });

  const moved: AddTaskStep[] = [
    {
      kind: 'create-card',
      board: 'p-repo',
      card: { title: 'Ship it', type: 'feature', projectTagId: 'p-repo' },
    },
    { kind: 'move', column: 'in-review' },
    {
      kind: 'assign',
      assign: { agentProjectId: 'p-repo', model: null, mode: null },
      start: false,
    },
  ];

  it('moves the created card with task:move before assigning it', async () => {
    const calls: string[] = [];
    const invoke = vi.fn(async (channel: string) => {
      calls.push(channel);
      if (channel === 'task:create') return task({ id: 'new-card' });
      if (channel === 'task:move') return task({ id: 'new-card', status: 'in-review' });
      if (channel === 'task:assignAgent') return task({ id: 'new-card' });
      throw new Error(`unexpected channel ${channel}`);
    }) as unknown as TransportInvoke;

    const result = await executeAddTaskSteps(moved, invoke);
    expect(result.problems).toEqual([]);
    expect(invoke).toHaveBeenCalledWith('task:move', 'new-card', 'in-review');
    expect(calls).toEqual(['task:create', 'task:move', 'task:assignAgent']);
  });

  it('keeps the card, warns, and still assigns when the move is refused', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'task:create') return task();
      if (channel === 'task:move') throw new Error('desktop offline');
      if (channel === 'task:assignAgent') return task();
      throw new Error(`unexpected channel ${channel}`);
    }) as unknown as TransportInvoke;

    const result = await executeAddTaskSteps(moved, invoke);
    expect(result.created).toBe('card');
    expect(result.problems).toEqual([
      'The card was created, but it could not be moved to In Review — desktop offline',
    ]);
    expect(result.run).toBe('assigned');
    expect(invoke).not.toHaveBeenCalledWith('task:delete', expect.anything());
  });
});
