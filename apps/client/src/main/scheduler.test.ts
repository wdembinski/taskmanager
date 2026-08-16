/**
 * Unit tests for the scheduler's pure decision logic — no store, no processes.
 * The class that wires this to SQLite and the SessionManager is exercised by
 * hand / verify; here we prove the selection rule and prompt shape.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildTaskPrompt,
  failureActionsFor,
  FAILURE_ACTION,
  PROPOSAL_ACTION,
  Scheduler,
  selectNextPending,
  shouldAutoRetry,
  isRetryableFailure,
  describeEmptyOutcome,
  releaseMode,
  type Schedulable,
} from './scheduler';
import { AGREE_SENTINEL, OBJECT_SENTINEL, PROPOSE_SENTINEL } from './attention';
import { MAX_PLAN_STEPS } from '@shared/board';
import type { PermissionMode } from '@shared/session';
import type { Project, Task } from '@shared/model';
import type { LimitState } from '@shared/limit';
import { RUN_REFUSAL_MESSAGE } from '@shared/scheduler';
import type { SessionManager } from './sessionManager';
import type { Store } from './store';
import type { WorktreeManager } from './worktreeManager';

/**
 * Inbox persistence, stubbed inert.
 *
 * Every path that raises or resolves an Attention item also writes it to the DB so it
 * survives a restart, but none of these tests are about that — they assert on the
 * `emitAttention` / `emitAttentionResolved` callbacks instead. Spread into each store
 * stub so a test only has to say what it actually cares about.
 */
const INERT_ATTENTION_STORE = {
  saveAttention: () => undefined,
  deleteAttention: () => undefined,
  listAttention: () => [],
  // Read when a finished chain summarises itself; no test here asserts on the summary's
  // per-step outcomes, so an empty history is the honest stub.
  getTaskHistory: () => [],
};

// `title` defaults to `id` so dependencies (referenced by title) can name other
// rows by their id in these tests.
const t = (
  id: string,
  status: Schedulable['status'],
  order: number,
  dependsOn: string[] = [],
  opts: { phase?: string; isContract?: boolean; isScaffold?: boolean } = {},
): Schedulable => ({
  id,
  status,
  order,
  title: id,
  dependsOn,
  phase: opts.phase ?? '',
  isContract: opts.isContract ?? false,
  isScaffold: opts.isScaffold ?? false,
});

describe('selectNextPending', () => {
  it('picks the lowest-order pending task', () => {
    const tasks = [t('a', 'done', 0), t('b', 'pending', 1), t('c', 'pending', 2)];
    expect(selectNextPending(tasks, new Set())?.id).toBe('b');
  });

  it('ignores order in the array — order field wins', () => {
    const tasks = [t('late', 'pending', 5), t('early', 'pending', 1)];
    expect(selectNextPending(tasks, new Set())?.id).toBe('early');
  });

  it('skips tasks already in flight', () => {
    const tasks = [t('a', 'pending', 0), t('b', 'pending', 1)];
    expect(selectNextPending(tasks, new Set(['a']))?.id).toBe('b');
  });

  it('returns null when nothing is pending or all are in flight', () => {
    expect(selectNextPending([t('a', 'running', 0), t('b', 'done', 1)], new Set())).toBeNull();
    expect(selectNextPending([t('a', 'pending', 0)], new Set(['a']))).toBeNull();
  });

  it('never returns non-pending tasks (running/failed/stopped are not restarted)', () => {
    const tasks = [
      t('r', 'running', 0),
      t('f', 'failed', 1),
      t('s', 'stopped', 2),
      t('w', 'waiting-input', 3),
      t('go', 'pending', 4),
    ];
    expect(selectNextPending(tasks, new Set())?.id).toBe('go');
  });

  it('holds a task until its @needs dependency is done', () => {
    // 'b' needs 'a'; while 'a' is pending, only 'a' is eligible.
    const pending = [t('a', 'pending', 0), t('b', 'pending', 1, ['a'])];
    expect(selectNextPending(pending, new Set())?.id).toBe('a');

    // With 'a' in flight (not yet done), 'b' is still blocked → nothing eligible.
    expect(selectNextPending(pending, new Set(['a']))).toBeNull();

    // Once 'a' is done, 'b' becomes eligible.
    const aDone = [t('a', 'done', 0), t('b', 'pending', 1, ['a'])];
    expect(selectNextPending(aDone, new Set())?.id).toBe('b');
  });

  it('lets independent tasks run in parallel (both eligible; caller fills slots)', () => {
    // Neither depends on the other, so the lowest-order one is picked first; with
    // it in flight, the next is still eligible (concurrency is the caller's cap).
    const tasks = [t('x', 'pending', 0), t('y', 'pending', 1)];
    expect(selectNextPending(tasks, new Set())?.id).toBe('x');
    expect(selectNextPending(tasks, new Set(['x']))?.id).toBe('y');
  });

  it('never satisfies an unknown/misspelled dependency (task waits)', () => {
    const tasks = [t('a', 'done', 0), t('b', 'pending', 1, ['nope'])];
    expect(selectNextPending(tasks, new Set())).toBeNull();
  });

  it('requires ALL tasks sharing a needed title to be done', () => {
    // Two tasks titled 'a' (ids a1/a2); 'b' needs 'a'. Not satisfied until both done.
    const partial = [
      {
        id: 'a1',
        status: 'done' as const,
        order: 0,
        title: 'a',
        dependsOn: [],
        phase: '',
        isContract: false,
        isScaffold: false,
      },
      {
        id: 'a2',
        status: 'pending' as const,
        order: 1,
        title: 'a',
        dependsOn: [],
        phase: '',
        isContract: false,
        isScaffold: false,
      },
      {
        id: 'b',
        status: 'pending' as const,
        order: 2,
        title: 'b',
        dependsOn: ['a'],
        phase: '',
        isContract: false,
        isScaffold: false,
      },
    ];
    // a2 is eligible (independent), b is not.
    expect(selectNextPending(partial, new Set())?.id).toBe('a2');
    expect(selectNextPending(partial, new Set(['a2']))).toBeNull();
  });

  it('holds a phase’s siblings until its @contract task is done', () => {
    // 'c' is the contract task for phase M; x and y are siblings under M. While the
    // contract is unfinished, only it is eligible; once done, the siblings unblock.
    const running = [
      t('c', 'pending', 0, [], { phase: 'M', isContract: true }),
      t('x', 'pending', 1, [], { phase: 'M' }),
      t('y', 'pending', 2, [], { phase: 'M' }),
    ];
    expect(selectNextPending(running, new Set())?.id).toBe('c');
    // Contract in flight (not done) → siblings still held → nothing else eligible.
    expect(selectNextPending(running, new Set(['c']))).toBeNull();

    const done = [
      t('c', 'done', 0, [], { phase: 'M', isContract: true }),
      t('x', 'pending', 1, [], { phase: 'M' }),
      t('y', 'pending', 2, [], { phase: 'M' }),
    ];
    expect(selectNextPending(done, new Set())?.id).toBe('x');
  });

  it('a @contract task only gates its own phase, not other phases', () => {
    const tasks = [
      t('c', 'pending', 0, [], { phase: 'M', isContract: true }),
      t('other', 'pending', 1, [], { phase: 'N' }),
    ];
    // 'c' is lowest-order and eligible; with it in flight, a task in a different
    // phase is unaffected by the contract gate.
    expect(selectNextPending(tasks, new Set(['c']))?.id).toBe('other');
  });

  it('runs a phase’s @scaffold task first and alone, before even its @contract task', () => {
    // Order within a phase: scaffold → contract → siblings. 's' is scaffold, 'c' is the
    // contract task, x is an ordinary sibling — all under M, with 's' NOT lowest-order to
    // prove ordering comes from the gate, not just `order`.
    const pending = [
      t('c', 'pending', 0, [], { phase: 'M', isContract: true }),
      t('x', 'pending', 1, [], { phase: 'M' }),
      t('s', 'pending', 2, [], { phase: 'M', isScaffold: true }),
    ];
    // Scaffold wins despite its higher order; everything else in the phase is held.
    expect(selectNextPending(pending, new Set())?.id).toBe('s');
    expect(selectNextPending(pending, new Set(['s']))).toBeNull();

    // Scaffold done → the contract task becomes eligible (still ahead of the sibling).
    const scaffoldDone = [
      t('c', 'pending', 0, [], { phase: 'M', isContract: true }),
      t('x', 'pending', 1, [], { phase: 'M' }),
      t('s', 'done', 2, [], { phase: 'M', isScaffold: true }),
    ];
    expect(selectNextPending(scaffoldDone, new Set())?.id).toBe('c');
  });
});

describe('buildTaskPrompt', () => {
  const task: Task = {
    id: '1',
    projectId: 'p',
    phase: 'Phase 2 — Persistence',
    title: 'wire the local store',
    status: 'pending',
    sessionId: null,
    order: 0,
    source: 'plan',
    dependsOn: [],
    isContract: false,
    isScaffold: false,
  };

  it('includes the project name, task title, and phase', () => {
    const prompt = buildTaskPrompt('Orchestrator', task);
    expect(prompt).toContain('Orchestrator');
    expect(prompt).toContain('wire the local store');
    expect(prompt).toContain('Phase 2 — Persistence');
  });

  it('omits the phase note when a task has no phase', () => {
    const prompt = buildTaskPrompt('Orchestrator', { ...task, phase: '' });
    expect(prompt).not.toContain('This task is under');
    expect(prompt).not.toContain('\n\n\n'); // no triple blank from the dropped line
  });

  it('invites plan edits in shared-dir mode (planRelPath given)', () => {
    const prompt = buildTaskPrompt('Orchestrator', task, { planRelPath: 'plan.md' });
    expect(prompt).toContain('plan.md');
    expect(prompt).toContain('you may add them to the plan file');
  });

  it('isolates the agent on its branch in worktree mode (branch given)', () => {
    const prompt = buildTaskPrompt('Orchestrator', task, { branch: 'orch/abc123' });
    expect(prompt).toContain('orch/abc123');
    expect(prompt).toContain('Do NOT edit the plan file');
    // The plan-editing invitation from shared-dir mode must be absent.
    expect(prompt).not.toContain('you may add them to the plan file');
  });

  it('tells a @contract task to author CONTRACT.md for its siblings', () => {
    const prompt = buildTaskPrompt('Orchestrator', task, {
      branch: 'orch/abc123',
      contractSiblings: ['Build API', 'Build UI'],
    });
    expect(prompt).toContain('SHARED CONTRACT task');
    expect(prompt).toContain('CONTRACT.md');
    expect(prompt).toContain('File ownership');
    expect(prompt).toContain('Build API');
    expect(prompt).toContain('Build UI');
    // A contract task is not itself told to read a pre-existing contract.
    expect(prompt).not.toContain('Read it FIRST');
  });

  it('tells a sibling of a contract task to build against CONTRACT.md', () => {
    const prompt = buildTaskPrompt('Orchestrator', task, {
      branch: 'orch/abc123',
      hasContract: true,
    });
    expect(prompt).toContain('CONTRACT.md');
    expect(prompt).toContain('Read it FIRST');
    expect(prompt).not.toContain('SHARED CONTRACT task');
  });

  it('says nothing about a contract when there is none in the milestone', () => {
    const prompt = buildTaskPrompt('Orchestrator', task, { branch: 'orch/abc123' });
    expect(prompt).not.toContain('CONTRACT.md');
  });

  it('tells a contract sibling to raise a proposal instead of editing the contract', () => {
    const prompt = buildTaskPrompt('Orchestrator', task, {
      branch: 'orch/abc123',
      hasContract: true,
    });
    expect(prompt).toContain(PROPOSE_SENTINEL);
    expect(prompt).toContain('NOT change');
  });
});

describe('Scheduler.decidePermission — full auto (bypassPermissions)', () => {
  /**
   * Build a Scheduler wired to fake store/emitters, with one run pre-registered
   * (seeded directly into the private map — no process spawn). Enough to exercise
   * the permission-decision branch in isolation.
   */
  function makeScheduler(mode: PermissionMode) {
    const project = { id: 'p', defaultPermissionMode: mode } as Project;
    const task = { id: 'task', projectId: 'p', title: 'x' } as Task;
    const emitAttention = vi.fn();
    const store = {
      getProject: (id: string) => (id === 'p' ? project : undefined),
      getTask: (id: string) => (id === 'task' ? task : undefined),
      updateTask: (_id: string, patch: Partial<Task>) => ({ ...task, ...patch }),
      getSettings: () => ({ limitJitterMs: 0 }),
      // The event-stream tests below fire real `tool-use` events, and every surfaced event
      // is written to the task's history first thing in `onRunEvent`.
      appendTaskEvent: vi.fn(),
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    // Answering an item that holds no tool pushes the reply into the live session instead
    // (`deliverOrResume`), which the residual test below walks through.
    const send = vi.fn();
    const sessions = { send } as unknown as SessionManager;
    const scheduler = new Scheduler(
      store,
      sessions,
      vi.fn(),
      vi.fn(),
      emitAttention,
      vi.fn(),
      vi.fn(),
    );
    (scheduler as unknown as { runs: Map<string, unknown> }).runs.set('run1', {
      taskId: 'task',
      projectId: 'p',
      runId: 'run1',
      settled: false,
    });
    /** Feed the run's observer stream, as the SessionManager would. */
    const fire = (event: unknown): void =>
      (scheduler as unknown as { onRunEvent: (r: string, e: unknown) => void }).onRunEvent(
        'run1',
        event,
      );
    return { scheduler, emitAttention, fire, send };
  }

  const riskyPush = { runId: 'run1', toolName: 'Bash', input: { command: 'git push' } };

  it('auto-approves a risky tool without raising an inbox item', async () => {
    const { scheduler, emitAttention } = makeScheduler('bypassPermissions');
    const result = await scheduler.decidePermission(riskyPush);
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'git push' } });
    expect(emitAttention).not.toHaveBeenCalled();
  });

  it('still parks the same risky tool for a non-bypass project', () => {
    const { scheduler, emitAttention } = makeScheduler('acceptEdits');
    // Held for a human: the returned promise stays pending, but an inbox item is
    // raised synchronously. (We don't await — it never resolves without an answer.)
    void scheduler.decidePermission(riskyPush);
    expect(emitAttention).toHaveBeenCalledTimes(1);
  });

  describe('AskUserQuestion is never auto-answered (Phase 17)', () => {
    const ask = {
      runId: 'run1',
      toolName: 'AskUserQuestion',
      input: {
        questions: [
          {
            header: 'Database',
            question: 'Which database should this use?',
            multiSelect: false,
            options: [
              { label: 'SQLite', description: 'Embedded, zero-config.' },
              { label: 'Postgres', description: 'Needs a server.' },
            ],
          },
        ],
      },
    };

    it.each(['acceptEdits', 'bypassPermissions'] as const)(
      'holds it even under %s — that mode waives TOOL approvals, not your judgement',
      (mode) => {
        const { scheduler, emitAttention } = makeScheduler(mode);
        let settled = false;
        void scheduler.decidePermission(ask).then(() => {
          settled = true;
        });
        expect(settled).toBe(false);
        expect(emitAttention).toHaveBeenCalledTimes(1);
      },
    );

    it('carries the real options through to the item, descriptions and all', () => {
      const { scheduler, emitAttention } = makeScheduler('bypassPermissions');
      void scheduler.decidePermission(ask);
      const item = emitAttention.mock.calls[0][0] as {
        kind: string;
        prompt: string;
        questions?: Array<{ options: Array<{ label: string; description?: string }> }>;
      };
      expect(item.kind).toBe('agent-question');
      expect(item.prompt).toBe('Which database should this use?');
      expect(item.questions?.[0].options).toEqual([
        { label: 'SQLite', description: 'Embedded, zero-config.' },
        { label: 'Postgres', description: 'Needs a server.' },
      ]);
    });

    it('resolves the held tool as a DENY carrying the answer, never an allow', async () => {
      // `allow` would run the tool — and headless, the CLI would answer itself. `deny` is
      // the only channel that hands TEXT back as the tool's result.
      const { scheduler, emitAttention } = makeScheduler('acceptEdits');
      const decision = scheduler.decidePermission(ask);
      const item = emitAttention.mock.calls[0][0] as { id: string };

      scheduler.answerAttention(item.id, {
        decision: 'answers',
        selections: [['Postgres']],
        note: 'staging is on 14',
      });

      const result = (await decision) as { behavior: string; message: string };
      expect(result.behavior).toBe('deny');
      expect(result.message).toContain('Which database should this use?');
      expect(result.message).toContain('→ Postgres');
      expect(result.message).toContain('staging is on 14');
    });

    it('lets the human explicitly hand the choice back', async () => {
      const { scheduler, emitAttention } = makeScheduler('acceptEdits');
      const decision = scheduler.decidePermission(ask);
      const item = emitAttention.mock.calls[0][0] as { id: string };

      scheduler.answerAttention(item.id, { decision: 'deny' });

      const result = (await decision) as { behavior: string; message: string };
      // The agent still gets to decide — but only because a human said so, which is the
      // whole difference from the timeout this replaces.
      expect(result.message).toContain('chose not to pick an option');
    });

    /**
     * Both orders the same ask can arrive in.
     *
     * The CLI emits the `tool-use` event and calls the permission gate for the very same
     * tool, and nothing orders those two against each other. Each path raises an inbox item
     * when it finds none open, so when the EVENT won the race the human ended up with two
     * items for one question: answering the visible one left the other still holding the
     * tool, the CLI asked again, and you clicked accept twice. The gate now adopts whatever
     * is already open for this run instead of raising a rival.
     */
    describe('when the event stream raised the question first', () => {
      /** The same ask, as it also arrives on the observer stream. */
      const askEvent = { kind: 'tool-use', name: 'AskUserQuestion', id: 'tu-1', input: ask.input };

      it('adopts the item the event stream already raised', async () => {
        const { scheduler, emitAttention, fire } = makeScheduler('acceptEdits');
        fire(askEvent);
        expect(emitAttention).toHaveBeenCalledTimes(1);

        const decision = scheduler.decidePermission(ask);
        expect(emitAttention).toHaveBeenCalledTimes(1); // adopted — no second item

        // …and the one item on screen is the one that releases the held tool. Before the
        // fix this answer went to an item holding nothing, and the gate's own item was
        // still parked with the question unanswered.
        const item = emitAttention.mock.calls[0][0] as { id: string };
        scheduler.answerAttention(item.id, { decision: 'answers', selections: [['Postgres']] });

        const result = (await decision) as { behavior: string; message: string };
        expect(result.behavior).toBe('deny');
        expect(result.message).toContain('→ Postgres');
      });

      // Adoption must not swallow a SECOND real ask. One assistant message can carry
      // parallel `tool_use` blocks, and an adopted item whose `resolve` was overwritten
      // would strand the first tool call for the life of the process.
      it('still gives a genuinely concurrent ask its own item', async () => {
        const { scheduler, emitAttention } = makeScheduler('acceptEdits');
        let firstSettled = false;
        let secondSettled = false;
        const first = scheduler.decidePermission(ask).then(() => {
          firstSettled = true;
        });
        void scheduler.decidePermission(ask).then(() => {
          secondSettled = true;
        });

        const ids = emitAttention.mock.calls.map((c) => (c[0] as { id: string }).id);
        expect(ids).toHaveLength(2);
        expect(new Set(ids).size).toBe(2);

        scheduler.answerAttention(ids[0], { decision: 'deny' });
        await first;
        expect(firstSettled).toBe(true);
        expect(secondSettled).toBe(false); // the second tool is still held, correctly
      });

      // The prompt comparison earns its keep here: answering "which database" must never be
      // handed back as the result of the "which auth provider" tool call.
      it('does not adopt an item asking something else', () => {
        const { scheduler, emitAttention, fire } = makeScheduler('acceptEdits');
        const askOther = {
          runId: 'run1',
          toolName: 'AskUserQuestion',
          input: {
            questions: [
              {
                header: 'Auth',
                question: 'Which auth provider?',
                multiSelect: false,
                options: [{ label: 'OIDC' }, { label: 'SAML' }],
              },
            ],
          },
        };

        fire(askEvent); // question A, off the stream
        void scheduler.decidePermission(askOther); // question B, through the gate

        expect(emitAttention.mock.calls.map((c) => (c[0] as { prompt: string }).prompt)).toEqual([
          'Which database should this use?',
          'Which auth provider?',
        ]);
      });

      // The fallback's old guard was "is ANYTHING parked on this run?", so a risky Bash
      // command waiting for approval suppressed the question entirely — it was never asked,
      // which is the silent failure this whole path exists to end.
      it('raises the question even while an unrelated permission is parked', () => {
        const { scheduler, emitAttention, fire } = makeScheduler('acceptEdits');
        void scheduler.decidePermission(riskyPush);
        fire(askEvent);
        expect(emitAttention.mock.calls.map((c) => (c[0] as { kind: string }).kind)).toEqual([
          'permission',
          'agent-question',
        ]);
      });

      // The other order, and the other half of the same claim: when the GATE won, the
      // fallback must not raise a rival either. `plan-approval` has had this test since
      // Phase 18 ("does not double-raise when the gate already holds the plan"); the
      // question path never did, so nothing held the narrowed guard honest. It does now.
      it('does not double-raise when the gate already holds the question', async () => {
        const { scheduler, emitAttention, fire } = makeScheduler('acceptEdits');
        const decision = scheduler.decidePermission(ask);
        expect(emitAttention).toHaveBeenCalledTimes(1);

        fire(askEvent);
        expect(emitAttention).toHaveBeenCalledTimes(1); // suppressed — no second item

        // …and the survivor is still the one holding the tool, so one answer releases it.
        const item = emitAttention.mock.calls[0][0] as { id: string };
        scheduler.answerAttention(item.id, { decision: 'answers', selections: [['SQLite']] });

        const result = (await decision) as { behavior: string; message: string };
        expect(result.behavior).toBe('deny');
        expect(result.message).toContain('→ SQLite');
      });

      /**
       * THE RESIDUAL, ACCEPTED — a record of what this fix settled for, not a wish.
       *
       * Adoption can only find an item that is still OPEN, so a human who answers the
       * fallback item in the gap before the gate's loopback POST arrives leaves nothing to
       * adopt, and the question is asked once more. The gap is relay latency against human
       * reaction time; only `tool_use`-id correlation closes it, and that costs three files
       * (see the note in `decidePermission`).
       *
       * It is accepted because it degrades to the OLD behaviour rather than to a broken
       * one, which is what the assertions below pin: the first answer is not swallowed, the
       * second item is the one holding the tool, and answering it releases the CLI. If a
       * later change closes the race, this test fails — read the note, then delete it.
       */
      it('answers the same question twice when a human beats the gate', async () => {
        const { scheduler, emitAttention, fire, send } = makeScheduler('acceptEdits');
        fire(askEvent);
        const first = emitAttention.mock.calls[0][0] as { id: string };

        // Answered in the gap. No tool is held yet, so the reply goes into the input stream
        // — the answer reaches the agent, it is just not the tool's result.
        scheduler.answerAttention(first.id, { decision: 'answers', selections: [['SQLite']] });
        expect(send).toHaveBeenCalledWith('run1', expect.stringContaining('→ SQLite'));

        // …and now the POST lands with nothing open to adopt. Second item, second click.
        const decision = scheduler.decidePermission(ask);
        expect(emitAttention).toHaveBeenCalledTimes(2);

        // The cost is that click and nothing more: the new item holds the tool, so the run
        // is not stranded waiting on an item that was already answered.
        const second = emitAttention.mock.calls[1][0] as { id: string };
        scheduler.answerAttention(second.id, { decision: 'answers', selections: [['SQLite']] });
        const result = (await decision) as { behavior: string; message: string };
        expect(result.behavior).toBe('deny');
        expect(result.message).toContain('→ SQLite');
      });
    });
  });
});

/**
 * The CLI can emit a second `system/init` — which `mapRawEvent` turns into another
 * `started` — AFTER its `result`. Seen in the wild: a finished step was written `done` by
 * `settle`, a late `started` 30ms later put it back to `running`, and the `exited` 96ms
 * after that declined to fix it because that case is guarded on `!run.settled`. The step
 * spun on the board for hours with nothing executing.
 */
describe('Scheduler.onRunEvent — a late `started` must not resurrect a settled run', () => {
  function makeScheduler(settled: boolean) {
    const task = { id: 'task', projectId: 'p', title: 'x' } as Task;
    const updateTask = vi.fn((_id: string, patch: Partial<Task>) => ({ ...task, ...patch }));
    const store = {
      getProject: () => undefined,
      getTask: () => task,
      updateTask,
      getSettings: () => ({ limitJitterMs: 0 }),
      appendTaskEvent: () => undefined,
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const scheduler = new Scheduler(
      store,
      {} as unknown as SessionManager,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    (scheduler as unknown as { runs: Map<string, unknown> }).runs.set('run1', {
      taskId: 'task',
      projectId: 'p',
      runId: 'run1',
      settled,
    });
    const fire = (
      scheduler as unknown as {
        onRunEvent(runId: string, event: unknown): void;
      }
    ).onRunEvent.bind(scheduler);
    return { fire, updateTask };
  }

  const started = { kind: 'started', sessionId: 's-1', model: '', cwd: '', permissionMode: '' };

  it('leaves the status alone once the run has settled', () => {
    const { fire, updateTask } = makeScheduler(true);
    fire('run1', started);
    expect(updateTask).toHaveBeenCalledTimes(1);
    const patch = updateTask.mock.calls[0][1];
    // The session id is still worth recording — it is a resume handle. The claim that
    // work is moving is the only part that is wrong. `workedAt` rides along for the same
    // reason: a settled run still ran, and that fact is what the Merge button reads.
    expect(patch).toMatchObject({ sessionId: 's-1' });
    expect(patch.workedAt).toBeTypeOf('number');
    expect(patch).not.toHaveProperty('status');
  });

  it('still marks a genuinely starting run as running', () => {
    const { fire, updateTask } = makeScheduler(false);
    fire('run1', started);
    const patch = updateTask.mock.calls[0][1];
    expect(patch).toMatchObject({ status: 'running', sessionId: 's-1' });
    // The durable "an agent ran here" fact (`Task.workedAt`), stamped the moment a session
    // starts — never cleared, unlike the session id beside it.
    expect(patch.workedAt).toBeTypeOf('number');
  });
});

describe('Scheduler.schedulerStates', () => {
  function bareScheduler() {
    const emitScheduler = vi.fn();
    // `getProject` is consulted so the run executes on the project's configured
    // machine; undefined (as here) means the local one, which is the old behavior.
    const store = {
      getSettings: () => ({ limitJitterMs: 0 }),
      getProject: () => undefined,
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const scheduler = new Scheduler(
      store,
      {} as unknown as SessionManager,
      vi.fn(),
      emitScheduler,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    return scheduler;
  }

  it('starts empty and records the latest state per project', () => {
    const scheduler = bareScheduler();
    expect(scheduler.schedulerStates()).toEqual([]);
    // stop() on an untracked project still announces idle via setState.
    scheduler.stop('p');
    expect(scheduler.schedulerStates()).toEqual([{ projectId: 'p', state: 'idle' }]);
  });
});

describe('Scheduler — a card delegated to an agent project', () => {
  /**
   * A My Tasks card assigned to an agent: it stays on the Personal board
   * (`projectId: 'personal'`) but every run must execute in the AGENT project's repo,
   * with the per-assignment model/mode. No worktree manager here, so the run launches
   * synchronously in the shared directory.
   */
  function makeAgentScheduler(
    overrides: Partial<Task> = {},
    projectOverrides: Partial<Project> = {},
  ) {
    const personal = { id: 'personal', name: 'Personal', path: '', planPath: '', kind: 'plan' };
    const agentProject = {
      id: 'agent-1',
      name: 'Checkout service',
      path: 'C:/repos/checkout',
      planPath: '',
      kind: 'agent',
      defaultModel: 'sonnet',
      // Null is the shipped default: "plan on whatever the work runs on".
      planningModel: null,
      defaultPermissionMode: 'acceptEdits',
      concurrency: 1,
      ...projectOverrides,
    };
    const task = {
      id: 't1',
      projectId: 'personal',
      phase: '',
      title: 'Fix the export dialog',
      status: 'pending',
      sessionId: null,
      order: 0,
      source: 'jira',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      externalSource: 'jira',
      externalKey: 'ABC-42',
      agentProjectId: 'agent-1',
      agentMode: 'plan',
      agentModel: 'opus',
      ...overrides,
    } as Task;
    const store = {
      getTask: (id: string) => (id === 't1' ? task : undefined),
      getProject: (id: string) =>
        id === 'agent-1' ? agentProject : id === 'personal' ? personal : undefined,
      getTasks: () => [task],
      getTaskActivity: () => [
        { kind: 'comment', id: 1, body: 'Start with the file-picker path.', createdAt: 1 },
      ],
      updateTask: (_id: string, patch: Partial<Task>) => Object.assign(task, patch),
      getSettings: () => ({ limitJitterMs: 0, concurrency: 1 }),
      appendTaskEvent: vi.fn(),
      getSubtasks: () => [], // an ordinary card: no plan-driven steps
      // …and no arrows either. The limit-resume case below ends by re-asking the chain,
      // which reads every link on the board.
      listTaskLinks: () => [],
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const start = vi.fn((_req: unknown, _opts: unknown) => ({ runId: 'r1' }));
    const stop = vi.fn();
    const sessions = { start, stop } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    return { scheduler, start, stop, task };
  }

  it('runs in the agent project’s repo with the assignment’s model and mode', () => {
    const { scheduler, start } = makeAgentScheduler();
    scheduler.runTask('t1');
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][0]).toMatchObject({
      cwd: 'C:/repos/checkout',
      model: 'opus', // the assignment's override, not the project default (sonnet)
      permissionMode: 'plan',
    });
  });

  it('uses the single-ticket agent prompt, with the human’s notes', () => {
    const { scheduler, start } = makeAgentScheduler();
    scheduler.runTask('t1');
    const { prompt } = start.mock.calls[0][0] as { prompt: string };
    expect(prompt).toContain('ABC-42');
    expect(prompt).toContain('ONE ticket');
    expect(prompt).toContain('Start with the file-picker path.');
  });

  it('falls back to the project defaults when the assignment has no overrides', () => {
    const { scheduler, start } = makeAgentScheduler({ agentMode: null, agentModel: null });
    scheduler.runTask('t1');
    expect(start.mock.calls[0][0]).toMatchObject({
      model: 'sonnet',
      permissionMode: 'acceptEdits',
    });
  });

  it('plans on the project’s planning model and works on its execution one', () => {
    // The whole point of the split, on ONE card: what changes the model is what the turn
    // is, not which card it is. Planning here is "assigned plan mode and asked for a plan".
    const planning = makeAgentScheduler({ agentModel: null }, { planningModel: 'opus' });
    planning.scheduler.runTask('t1');
    expect(planning.start.mock.calls[0][0]).toMatchObject({
      model: 'opus',
      permissionMode: 'plan',
    });

    const work = makeAgentScheduler(
      { agentModel: null, agentMode: 'bypassPermissions' },
      { planningModel: 'opus' },
    );
    work.scheduler.runTask('t1');
    expect(work.start.mock.calls[0][0]).toMatchObject({
      model: 'sonnet', // the steps-execution model, untouched by the planning one
      permissionMode: 'bypassPermissions',
    });
  });

  it('lets the card’s own model out-rank both of the project’s', () => {
    const { scheduler, start } = makeAgentScheduler(
      { agentModel: 'haiku' },
      { planningModel: 'opus' },
    );
    scheduler.runTask('t1');
    expect(start.mock.calls[0][0]).toMatchObject({ model: 'haiku' });
  });

  it('runs a step of an approved plan on the execution model, not the parent’s', () => {
    // A step carries no model of its own — `addSubtask` stopped copying the parent's, so a
    // card planned on the expensive model does not bill every step at it.
    const { scheduler, start } = makeAgentScheduler(
      { agentModel: null, agentMode: 'bypassPermissions', parentTaskId: 'card-1' },
      { planningModel: 'opus' },
    );
    scheduler.runTask('t1');
    expect(start.mock.calls[0][0]).toMatchObject({ model: 'sonnet' });
  });

  it('resumes an agent task in the agent project after a usage limit clears', () => {
    // The limit-park → auto-resume path can't be forced live, and it is the one that
    // would silently run the task in the wrong (Personal, path-less) project.
    const { scheduler, start, task } = makeAgentScheduler({
      status: 'blocked-by-limit',
      sessionId: 's1',
    });
    (scheduler as unknown as { resumeParked: (s: LimitState) => void }).resumeParked({
      limitType: 'rolling',
      resetsAt: null,
      resumeAt: 0,
      parkedTaskIds: [task.id],
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][0]).toMatchObject({ cwd: 'C:/repos/checkout' });
    // A resume continues the saved conversation rather than re-briefing the agent.
    expect(start.mock.calls[0][1]).toMatchObject({ resumeSessionId: 's1' });
  });

  it('tells a resumed retry only what is new — the failure note, not the ticket again', () => {
    // "AI fix & retry" on a card whose session survived. The conversation being rejoined
    // already contains the brief, so re-sending it bought nothing and re-paid for all of
    // it (token audit, S2).
    const { scheduler, start } = makeAgentScheduler({
      status: 'failed',
      sessionId: 's1',
      externalDescription: 'The export dialog closes before the file is written.',
    });
    (scheduler as unknown as { fixNotes: Map<string, string> }).fixNotes.set(
      't1',
      'the build broke',
    );
    scheduler.runTask('t1');
    const [request, opts] = start.mock.calls[0] as [
      { prompt: string },
      { resumeSessionId?: string },
    ];
    expect(opts.resumeSessionId).toBe('s1');
    // What is new travels…
    expect(request.prompt).toContain('the build broke');
    // …and what the conversation already holds does not.
    expect(request.prompt).not.toContain('The export dialog closes before the file is written.');
    expect(request.prompt).not.toContain('ONE ticket');
    expect(request.prompt).not.toContain('Start with the file-picker path.');
    // Consumed: the note applies to this retry only.
    expect((scheduler as unknown as { fixNotes: Map<string, string> }).fixNotes.has('t1')).toBe(
      false,
    );
  });

  it('still briefs a retry in full when there is no session to resume', () => {
    // "Retry fresh" discarded the session (as does a card that never started): nothing has
    // been said to this agent yet, so it needs the whole thing — note included.
    const { scheduler, start } = makeAgentScheduler({
      status: 'failed',
      sessionId: null,
      externalDescription: 'The export dialog closes before the file is written.',
    });
    (scheduler as unknown as { fixNotes: Map<string, string> }).fixNotes.set(
      't1',
      'the build broke',
    );
    scheduler.runTask('t1');
    const [request, opts] = start.mock.calls[0] as [
      { prompt: string },
      { resumeSessionId?: string },
    ];
    expect(opts.resumeSessionId).toBe(undefined);
    expect(request.prompt).toContain('ONE ticket');
    expect(request.prompt).toContain('ABC-42');
    expect(request.prompt).toContain('The export dialog closes before the file is written.');
    expect(request.prompt).toContain('the build broke');
  });

  it('stopTask ends that task’s run and leaves the card where its human left it', () => {
    const { scheduler, stop, task } = makeAgentScheduler();
    scheduler.runTask('t1');
    expect(scheduler.stopTask('t1')).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    // NOT `stopped`, which would have thrown the card into the DONE column. Stopping an
    // agent says nothing about whether the work is done — only the human moves a card.
    expect(task.status).toBe('pending');
    expect(task.preRunStatus).toBe(null);
    // …which is exactly why the stop has to leave something that is NOT a status behind:
    // from `status` alone this card is indistinguishable from one nobody ever started.
    expect(typeof task.stoppedAt).toBe('number');
    // A task with nothing running is a no-op, not an error (and never re-marked).
    expect(scheduler.stopTask('unknown')).toBe(false);
  });

  /**
   * Resume — the inverse of the Stop above. The claim under test is that "within the same
   * session" costs no new code: it falls out of `startTask` resuming by `task.sessionId`.
   */
  describe('Scheduler.resumeTask', () => {
    /** What `exited` does once a stopped process actually goes, so the slot is free again. */
    const exit = (scheduler: Scheduler, runId: string): void =>
      (scheduler as unknown as { onRunEvent: (r: string, e: unknown) => void }).onRunEvent(runId, {
        kind: 'exited',
        code: 0,
      });

    it('restarts a stopped card in the conversation it was stopped in', () => {
      const { scheduler, start, task } = makeAgentScheduler({ sessionId: 's1' });
      const first = scheduler.runTask('t1');
      scheduler.stopTask('t1');
      exit(scheduler, first!.runId);

      expect(scheduler.resumeTask('t1')).toHaveProperty('runId');
      expect(start).toHaveBeenCalledTimes(2);
      const [request, opts] = start.mock.calls[1] as [
        { prompt: string },
        { resumeSessionId?: string },
      ];
      // The whole point: the agent is rejoined mid-conversation, not re-briefed.
      expect(opts.resumeSessionId).toBe('s1');
      expect(request.prompt).not.toContain('ONE ticket');
      // …and told the truth about why it stopped. The default nudge opens by blaming a
      // usage limit, which is a lie about a human pressing Stop.
      expect(request.prompt).toBe('You were stopped. Continue the task where you left off.');
      expect(request.prompt).not.toContain('usage limit');
      // Nothing is stopped any more, so nothing offers to resume it again.
      expect(task.stoppedAt).toBe(null);
    });

    it('refuses to resume work that is already moving', () => {
      const { scheduler, start } = makeAgentScheduler({ sessionId: 's1' });
      scheduler.runTask('t1');
      // A stop that has been superseded by a fresh start is history; resuming here would
      // put a second agent in the same worktree.
      expect(scheduler.resumeTask('t1')).toEqual({ refused: 'already-running' });
      expect(scheduler.resumeTask('nope')).toEqual({ refused: 'unknown-task' });
      expect(start).toHaveBeenCalledTimes(1);
    });

    it('clears the stop mark whichever way the card starts again', () => {
      // Not just Resume: a plain Start un-stops the card as truly, and a card that ran
      // again would otherwise keep offering Resume for ever.
      const { scheduler, task } = makeAgentScheduler({ sessionId: 's1' });
      const first = scheduler.runTask('t1');
      scheduler.stopTask('t1');
      exit(scheduler, first!.runId);
      expect(typeof task.stoppedAt).toBe('number');

      scheduler.runTask('t1');
      expect(task.stoppedAt).toBe(null);
    });
  });
});

describe('Scheduler.start resumes stopped tasks', () => {
  it('re-queues a stopped task to pending and pumps it (resuming its session)', () => {
    const project = { id: 'p', path: 'C:/w', planPath: 'C:/w/plan.md', concurrency: 1 } as Project;
    const tasks: Task[] = [
      {
        id: 't1',
        projectId: 'p',
        phase: '',
        title: 'x',
        status: 'stopped',
        sessionId: 's1',
        order: 0,
        source: 'plan',
        dependsOn: [],
        isContract: false,
        isScaffold: false,
      } as Task,
    ];
    const store = {
      getTasks: () => tasks,
      getProject: () => project,
      getTask: (id: string) => tasks.find((t) => t.id === id),
      updateTask: (id: string, patch: Partial<Task>) => {
        const t = tasks.find((x) => x.id === id);
        if (t) Object.assign(t, patch);
        return t;
      },
      getSettings: () => ({ limitJitterMs: 0, concurrency: 1 }),
      appendTaskEvent: vi.fn(),
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const start = vi.fn((_req: unknown, _opts: unknown) => ({ runId: 'r1' }));
    const sessions = { start } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());

    scheduler.start('p');

    // The stopped task was re-queued (no longer 'stopped') and handed to a session.
    expect(tasks[0].status).not.toBe('stopped');
    expect(start).toHaveBeenCalledTimes(1);
    // It resumes the saved conversation rather than starting fresh.
    expect(start.mock.calls[0][1]).toMatchObject({ resumeSessionId: 's1' });
  });
});

describe('Scheduler.startAuxiliarySession (the AI "Align plan" run)', () => {
  it('registers the run so stop(projectId) terminates it', () => {
    // `getProject` is consulted so the run executes on the project's configured
    // machine; undefined (as here) means the local one, which is the old behavior.
    const store = {
      getSettings: () => ({ limitJitterMs: 0 }),
      getProject: () => undefined,
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const start = vi.fn((_req: unknown, _opts: unknown) => ({ runId: 'align1' }));
    const stop = vi.fn();
    const sessions = { start, stop } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());

    const { runId } = scheduler.startAuxiliarySession('p', {
      prompt: 'align',
      cwd: 'C:/w',
    } as never);
    expect(runId).toBe('align1');

    // Stopping the project must kill the standalone align session — the bug was that
    // it lived outside `runs`, so Stop never reached it and the agent kept editing.
    scheduler.stop('p');
    expect(stop).toHaveBeenCalledWith('align1');
  });

  it('closes the one-shot run and prunes it from the registry on result', () => {
    // `getProject` is consulted so the run executes on the project's configured
    // machine; undefined (as here) means the local one, which is the old behavior.
    const store = {
      getSettings: () => ({ limitJitterMs: 0 }),
      getProject: () => undefined,
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    let observer: ((event: { kind: string }) => void) | undefined;
    const start = vi.fn((_req: unknown, opts: { onEvent?: (e: { kind: string }) => void }) => {
      observer = opts.onEvent;
      return { runId: 'align1' };
    });
    const stop = vi.fn();
    const sessions = { start, stop } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());

    scheduler.startAuxiliarySession('p', { prompt: 'align', cwd: 'C:/w' } as never);
    // The run finished on its own: the observer closes it (a one-shot with an
    // observer won't auto-close) and drops it from the registry...
    observer?.({ kind: 'result' });
    expect(stop).toHaveBeenCalledWith('align1');
    stop.mockClear();
    // ...so a later stop(projectId) is a no-op for it (not double-stopped).
    scheduler.stop('p');
    expect(stop).not.toHaveBeenCalled();
  });
});

describe('failure decision helpers (pure)', () => {
  it('auto-retries only while spent attempts are under the cap', () => {
    expect(shouldAutoRetry(0, 1)).toBe(true);
    expect(shouldAutoRetry(1, 1)).toBe(false);
    expect(shouldAutoRetry(0, 0)).toBe(false); // cap 0 = park on first failure
    expect(shouldAutoRetry(2, 5)).toBe(true);
    expect(shouldAutoRetry(0, -3)).toBe(false); // negative cap clamps to 0
  });

  /**
   * Token audit, S3: a second identical attempt at a deterministic failure costs a whole
   * session (~$3) and parks anyway. The classifier reads the reason text `settle` built,
   * so these are the strings the app and the CLI actually produce.
   */
  it('refuses a retry for a cause the retry cannot change', () => {
    // The CLI could not be started at all.
    expect(isRetryableFailure('Failed to start Claude: spawn claude ENOENT')).toBe(false);
    expect(isRetryableFailure('claude: command not found')).toBe(false);
    expect(
      isRetryableFailure("'claude' is not recognized as an internal or external command"),
    ).toBe(false);
    // Nothing to authenticate with.
    expect(isRetryableFailure('Claude is installed but not logged in')).toBe(false);
    expect(isRetryableFailure('authentication_error: invalid API key')).toBe(false);
    expect(isRetryableFailure('401 Unauthorized')).toBe(false);
    // A closed usage window — the limit gate resumes this, not a retry.
    expect(isRetryableFailure('usage limit reached')).toBe(false);
    expect(isRetryableFailure('rate_limit_error')).toBe(false);
    // The directory the run needs is gone.
    expect(isRetryableFailure('ENOENT: no such file or directory, chdir C:/w/wt-t1')).toBe(false);
    expect(isRetryableFailure('Worktree preparation error: bad object HEAD')).toBe(false);
  });

  /**
   * The default is "retry". An unrecognised reason keeps the old behaviour, because being
   * wrong that way costs one attempt, while being wrong the other way silently stops
   * retrying work that would have succeeded.
   */
  it('still retries the transient and the unrecognised', () => {
    expect(isRetryableFailure('the process exited with code 1')).toBe(true);
    expect(isRetryableFailure('the session ended without success')).toBe(true);
    expect(isRetryableFailure('error')).toBe(true);
    // The most common failure in the audit window — and genuinely worth a second go.
    expect(
      isRetryableFailure('the planning session ended without presenting a plan. If it stopped…'),
    ).toBe(true);
    // `describeEmptyOutcome`'s dead start, verbatim: a process that spawned and died before
    // the model was called. Measured as transient (6 events on 4 cards), and it burned no
    // tokens, so refusing it would remove self-healing from a flaky spawn and save nothing.
    expect(
      isRetryableFailure(
        'the session ended without running a turn — nothing was sent to the model',
      ),
    ).toBe(true);
  });

  // `RegExp.test` with a `g` flag alternates between calls; the same reason must classify
  // the same way every time it is asked.
  it('is stable when asked repeatedly', () => {
    for (let i = 0; i < 3; i++) {
      expect(isRetryableFailure('spawn claude ENOENT')).toBe(false);
      expect(isRetryableFailure('the process exited with code 1')).toBe(true);
    }
  });

  it('offers retry/fix/cleanup actions for a run failure', () => {
    const actions = failureActionsFor('run');
    expect(actions).toEqual([
      FAILURE_ACTION.retry,
      FAILURE_ACTION.retryFresh,
      FAILURE_ACTION.aiFix,
      FAILURE_ACTION.cleanup,
      FAILURE_ACTION.markDone,
    ]);
  });

  it('offers integration-specific actions for a merge/integration failure', () => {
    const actions = failureActionsFor('integration');
    expect(actions).toEqual([
      FAILURE_ACTION.retryIntegration,
      // Phase 17: the way out of a retry loop. An integration failure usually has a cause
      // outside the app, so "Retry integration" alone meant failing and re-asking forever.
      FAILURE_ACTION.leaveBranch,
      FAILURE_ACTION.cleanup,
      FAILURE_ACTION.markDone,
    ]);
    // The agent-run-only actions must not appear here.
    expect(actions).not.toContain(FAILURE_ACTION.aiFix);
    expect(actions).not.toContain(FAILURE_ACTION.retryFresh);
  });
});

describe('Scheduler run-failure handling', () => {
  function setup(maxAutoRetries: number) {
    const project = {
      id: 'p',
      path: 'C:/w',
      planPath: 'C:/w/plan.md',
      name: 'P',
      concurrency: 1,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'acceptEdits',
    } as Project;
    const task: Task = {
      id: 't1',
      projectId: 'p',
      phase: '',
      title: 'x',
      status: 'running',
      sessionId: 's1',
      order: 0,
      source: 'plan',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
    } as Task;
    const store = {
      getTasks: () => [task],
      getProject: () => project,
      getTask: (id: string) => (id === 't1' ? task : undefined),
      updateTask: (id: string, patch: Partial<Task>) => {
        if (id === 't1') Object.assign(task, patch);
        return task;
      },
      appendTaskEvent: vi.fn(),
      getSubtasks: () => [],
      listTaskLinks: () => [],
      saveAuthGate: vi.fn(),
      loadAuthGate: () => null,
      // The limit gate persists itself on every change, and one of these cases now raises it.
      saveLimitGate: vi.fn(),
      getSettings: () => ({ maxAutoRetries, limitJitterMs: 0, concurrency: 1 }),
      ...INERT_ATTENTION_STORE,
      // Spied rather than inert: whether the parked failure's ROW survives its run's exit
      // is half of what the regression below is about (the map is the other half).
      saveAttention: vi.fn(),
      deleteAttention: vi.fn(),
    } as unknown as Store;
    const start = vi.fn((_req: unknown, _opts: unknown) => ({ runId: 'r2' }));
    const stop = vi.fn();
    const sessions = { start, stop } as unknown as SessionManager;
    const emitAttention = vi.fn();
    const emitResolved = vi.fn();
    const emitTask = vi.fn();
    const scheduler = new Scheduler(
      store,
      sessions,
      emitTask,
      vi.fn(),
      emitAttention,
      emitResolved,
      vi.fn(),
    );
    // Seed a live run for the task (as the scheduler would have on start).
    (scheduler as unknown as { runs: Map<string, unknown> }).runs.set('r1', {
      taskId: 't1',
      projectId: 'p',
      runId: 'r1',
      settled: false,
    });
    (scheduler as unknown as { inFlight: Set<string> }).inFlight.add('t1');
    // Awaitable: a `result` naming a usage limit is confirmed against a `/usage` reading
    // before it is believed, and that is the one branch of `onRunEvent` that yields. Every
    // other event still completes synchronously, so the cases below need no `await`.
    const fire = (event: unknown): Promise<void> =>
      (scheduler as unknown as { onRunEvent: (r: string, e: unknown) => Promise<void> }).onRunEvent(
        'r1',
        event,
      );
    return { scheduler, store, task, start, emitAttention, emitResolved, emitTask, fire };
  }

  const failResult = {
    kind: 'result',
    success: false,
    resultText: '',
    costUsd: null,
    durationMs: null,
    stopReason: 'error',
    terminalReason: null,
  };
  const exited = { kind: 'exited', code: 1 };

  it('auto-retries under the cap and relaunches when the run exits (no park)', () => {
    const { task, start, emitAttention, fire } = setup(1);
    fire(failResult);
    expect(task.status).toBe('pending'); // re-queued, not parked
    expect(emitAttention).not.toHaveBeenCalled();
    // The failed run exits; the idle-queue retry path relaunches it once.
    fire(exited);
    expect(start).toHaveBeenCalledTimes(1);
  });

  /**
   * Token audit, S3. `maxAutoRetries` is 1 here, so the old code re-launched a whole
   * session — the CLI is still missing, the second attempt dies the same way — and parked
   * afterwards. It now parks on attempt 1, with exactly the options it would have got.
   */
  it('parks an unretryable failure immediately instead of spending an attempt', () => {
    const { task, start, emitAttention, fire } = setup(1);

    fire({ ...failResult, terminalReason: 'Failed to start Claude: spawn claude ENOENT' });

    expect(emitAttention).toHaveBeenCalledTimes(1);
    const item = emitAttention.mock.calls[0][0] as { kind: string; options: string[] };
    expect(item.kind).toBe('task-failed');
    expect(item.options).toEqual(failureActionsFor('run')); // the same way out as before
    expect(task.status).toBe('waiting-input'); // parked, not re-queued
    fire(exited);
    expect(start).not.toHaveBeenCalled(); // and no second session was ever launched
  });

  /**
   * The other half of S3: the retry that IS worth making must not be the first attempt
   * again. The reason is queued as the task's fix note, which `launch` turns into the
   * "previous attempt failed / diagnose it" prompt (a short note on a resumed session).
   */
  it('hands the failure reason to the retry it queues', () => {
    const { scheduler, fire } = setup(1);

    fire({ ...failResult, terminalReason: 'the tests failed: 3 red in scheduler.test.ts' });

    const fixNotes = (scheduler as unknown as { fixNotes: Map<string, string> }).fixNotes;
    expect(fixNotes.get('t1')).toBe('the tests failed: 3 red in scheduler.test.ts');
  });

  it('parks for the human once auto-retries are exhausted', () => {
    const { emitAttention, fire } = setup(0);
    fire(failResult);
    expect(emitAttention).toHaveBeenCalledTimes(1);
    const item = emitAttention.mock.calls[0][0] as { kind: string; options: string[] };
    expect(item.kind).toBe('task-failed');
    expect(item.options).toEqual(failureActionsFor('run'));
  });

  /**
   * A dead sign-in is the account's problem, not the card's.
   *
   * The CLI reports it as `terminalReason: "api_error"` with the real sentence in
   * `resultText`, so before this it read as a transient blip: worth an auto-retry, then
   * parked against the card as an unexplained failure — and then the queue handed the same
   * wall to the next card, and the next.
   */
  it('holds all work behind the sign-in gate instead of blaming the card', () => {
    const { scheduler, task, start, emitAttention, fire } = setup(1);

    fire({
      ...failResult,
      resultText: 'Failed to authenticate: OAuth session expired and could not be refreshed',
      terminalReason: 'api_error',
      usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    });

    const gate = scheduler.currentAuth();
    expect(gate?.reason).toBe(
      'Failed to authenticate: OAuth session expired and could not be refreshed',
    );
    expect(gate?.parkedTaskIds).toEqual(['t1']);
    // Not an auto-retry (which would spend a launch on the same credential) and not an
    // inbox item (which would file an account outage as this one card's failure).
    expect(emitAttention).not.toHaveBeenCalled();
    expect(task.status).toBe('pending');
    fire(exited);
    expect(start).not.toHaveBeenCalled();
    // …and nothing else may start either, however it is asked.
    expect(scheduler.runTask('t1')).toBeNull();
  });

  /**
   * The limit's version of the same rule, and the same bug.
   *
   * A run that merely ENDS with "Claude AI usage limit reached|<epoch>" is the account out
   * of budget, not this card failing — but nothing read it, so it settled as the card's
   * `api_error`, spent an auto-retry against a wall that was still up, and left the gate
   * that exists for exactly this down while the queue fed the next card into it.
   *
   * `readUsage` is not wired here, which is the point: the epoch tier needs no
   * corroboration, so the park is decided synchronously and the probe is never asked.
   */
  it('holds all work behind the usage-limit gate instead of blaming the card', async () => {
    const { scheduler, task, start, emitAttention, fire } = setup(1);

    await fire({
      ...failResult,
      resultText: 'Claude AI usage limit reached|1754870400',
      terminalReason: 'api_error',
    });

    const gate = scheduler.currentLimit();
    expect(gate?.resetsAt).toBe(1754870400); // the CLI's own field, parsed, not guessed
    expect(gate?.parkedTaskIds).toEqual(['t1']);
    expect(task.status).toBe('blocked-by-limit');
    // Not an inbox item: an account-wide outage filed against one card tells the human
    // nothing about the one thing actually wrong, and there is nothing for them to answer.
    expect(emitAttention).not.toHaveBeenCalled();
    fire(exited);
    expect(start).not.toHaveBeenCalled(); // no auto-retry into the same wall
  });

  /**
   * …and the card is told. `engageLimit` wrote no timeline note at all, so a card parked
   * this way went completely silent — worse, for a human reading the card, than the
   * `api_error` it used to file.
   */
  it('says on the card that the account is limited and it resumes by itself', async () => {
    const { store, fire } = setup(1);

    await fire({ ...failResult, resultText: 'Claude AI usage limit reached|1754870400' });

    const notes = (store.appendTaskEvent as ReturnType<typeof vi.fn>).mock.calls
      .map(([, , , event]) => event as { kind: string; text?: string })
      .filter((e) => e.kind === 'assistant');
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toMatch(/usage limit/i);
    expect(notes[0].text).toMatch(/picks up by itself|nothing to press/i);
  });

  /**
   * The interleaving the other way round: the failure is filed FIRST.
   *
   * The CLI does not always name the limit in the turn it ends — the turn dies as an
   * ordinary `api_error`, `handleRunFailure` parks it for a human, and the
   * `rate_limit_event` lands a beat later. The card then said two contradictory things at
   * once: `blocked-by-limit` (waiting for a reset nobody has to do anything about) with an
   * inbox item asking a human to choose between Retry, AI-fix and Mark done for a failure
   * that never happened — and whose run is gone, so the ask is unanswerable anyway.
   */
  it('withdraws a failure it had already filed when the limit turns up after it', () => {
    const { scheduler, store, task, emitAttention, emitResolved, fire } = setup(0);
    fire(failResult);
    expect(emitAttention).toHaveBeenCalledTimes(1);
    const item = emitAttention.mock.calls[0][0] as { id: string };

    // The signal the CLI sends separately from the turn's own result.
    fire({ kind: 'rate-limit', status: 'rejected', rateLimitType: 'rolling', resetsAt: null });

    expect(emitResolved).toHaveBeenCalledWith(item.id);
    expect(store.deleteAttention).toHaveBeenCalledWith(item.id);
    expect(scheduler.listAttention()).toHaveLength(0);
    expect(task.status).toBe('blocked-by-limit');
    // Nothing about the failure is left to inherit — see the retry case below for why the
    // queue in particular matters.
    const privates = scheduler as unknown as {
      fixNotes: Map<string, string>;
      retryQueue: Set<string>;
      attempts: Map<string, number>;
    };
    expect(privates.fixNotes.size).toBe(0);
    expect(privates.retryQueue.size).toBe(0);
    expect(privates.attempts.size).toBe(0);
  });

  /**
   * The same interleaving one step earlier, where it is a live bug rather than a wrong
   * sentence: the failure was worth an auto-retry, so the task sits in `retryQueue` when
   * the limit arrives. `case 'exited'` reads that queue and calls `startTask` directly, and
   * `startTask` has no gate check of its own — so the card the gate had just parked
   * launched a fresh session straight into the wall.
   */
  it('does not relaunch a queued retry into the wall the limit just raised', () => {
    const { scheduler, start, fire } = setup(1);
    fire(failResult); // retryable, under the cap → queued for relaunch on `exited`
    const privates = scheduler as unknown as {
      fixNotes: Map<string, string>;
      retryQueue: Set<string>;
      attempts: Map<string, number>;
    };
    expect(privates.retryQueue.has('t1')).toBe(true);
    expect(privates.fixNotes.has('t1')).toBe(true);

    fire({ kind: 'rate-limit', status: 'rejected', rateLimitType: 'rolling', resetsAt: null });

    // Withdrawn: the retry is the gate's to make at reset time, the attempt was never the
    // card's to spend, and the note would brief the resumed run about its own good work.
    expect(privates.retryQueue.size).toBe(0);
    expect(privates.fixNotes.size).toBe(0);
    expect(privates.attempts.size).toBe(0);

    fire(exited); // the parked process dies, as it always does

    expect(start).not.toHaveBeenCalled();
  });

  /**
   * The other half of holding first: the hold has to come back off.
   *
   * With no epoch to believe, the sentence is checked against what the account actually
   * has left — and a probe reporting 20% of the session window used contradicts it. The
   * board must not be parked for five hours over that, so the failure falls through to
   * exactly the path it took before any of this existed.
   */
  it('lets a contradicted limit settle as an ordinary failure', async () => {
    const { scheduler, task, emitAttention, fire } = setup(1);
    scheduler.setUsageProbe(() => Promise.resolve({ sessionPct: 20, weeklyPct: 3 }));

    await fire({ ...failResult, resultText: 'Claude AI usage limit reached' });

    expect(scheduler.currentLimit()).toBeNull(); // nothing parked, no countdown raised
    expect(emitAttention).not.toHaveBeenCalled(); // an auto-retry is still available
    expect(task.status).toBe('pending'); // …and it took it, as it always did
    // The hold is off, so the queue can move again — this is the whole cost of a wrong
    // classification: the few seconds the probe took.
    const held = (scheduler as unknown as { probingLimit: Set<string> }).probingLimit;
    expect(held.size).toBe(0);
  });

  it('resumes what it held the moment the human signs in', () => {
    const { scheduler, start, fire } = setup(1);
    fire({ ...failResult, resultText: 'Failed to authenticate: token expired' });
    fire(exited);
    expect(start).not.toHaveBeenCalled();

    scheduler.signedIn();

    expect(scheduler.currentAuth()).toBeNull();
    expect(start).toHaveBeenCalledTimes(1); // the parked task, resumed by its session id
  });

  /**
   * The park has to survive the exit that always follows it.
   *
   * `result` → `settle` → `handleRunFailure` → `raiseTaskFailed` → `sessions.stop` →
   * `exited`, all inside one sequence: `clearRunAttention` was deleting the item its own
   * caller had raised ~100ms earlier, from the map AND the table. The task stayed
   * `waiting-input` with an empty inbox — unanswerable, and (as a step) holding its card's
   * whole chain, which is what a user sees as "the task is locked and I cannot resume it".
   */
  it('keeps the parked failure answerable after its run exits', () => {
    const { scheduler, store, task, emitResolved, fire } = setup(0);
    fire(failResult);
    const raised = scheduler.listAttention();
    expect(raised).toHaveLength(1);

    fire(exited); // the process the failure came from dies, as it always does

    const kept = scheduler.listAttention();
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe(raised[0].id);
    // Blanked, as `rehydrateAttention` blanks it: the correlator is dead, and leaving it
    // would let a live-session path think it can answer this in place.
    expect(kept[0].runId).toBe('');
    expect(store.deleteAttention).not.toHaveBeenCalled();
    expect(store.saveAttention).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: raised[0].id, runId: '' }),
      expect.objectContaining({ kind: 'run', taskId: 't1' }),
    );
    // Not re-announced — the UI counts `attention:new`, and the item never left the inbox.
    expect(emitResolved).not.toHaveBeenCalled();
    expect(task.status).toBe('waiting-input');

    // And the stored context is still there, so a choice actually applies.
    scheduler.answerAttention(raised[0].id, { decision: 'reply', text: FAILURE_ACTION.markDone });
    expect(scheduler.listAttention()).toHaveLength(0);
    expect(task.status).toBe('done');
  });

  /**
   * The UI re-reads `scheduler:activeRuns` when a `task:changed` arrives, and a run is
   * removed from that snapshot only here, on `exited` — which is AFTER the settling
   * `task:changed`. Without an announcement at removal time the UI's last snapshot forever
   * lists a run that has ended, and the card claims to be starting. The status is `pending`
   * in this case (an auto-retry re-queued it), which is exactly the state where the
   * snapshot, not the status, decides whether a spinner turns.
   */
  /**
   * The residual half of the "spinner over a finished agent" bug. `result` settles the run
   * but the process lingers (it holds stdin open, so it only dies when told to), and until
   * `exited` lands the run is still in the map. Reporting it as active made the UI show
   * "Starting…" underneath the chat line "The agent finished this turn."
   */
  it('drops a settled run from activeRuns before its process has exited', () => {
    const { scheduler, fire } = setup(0);
    expect(scheduler.activeRuns()).toEqual([{ taskId: 't1', runId: 'r1' }]);

    fire(failResult); // the outcome is decided; `exited` has not arrived yet

    expect(scheduler.activeRuns()).toEqual([]);
  });

  /**
   * A run leaves the map on `exited`, which is after the settling `task:changed` — so the
   * refresh that event triggers happens while the run is still there. Excluding settled runs
   * makes the snapshot right at that moment anyway; this announcement is the belt to that
   * braces, and the only signal for a run that leaves the map with no task change of its own.
   */
  it('announces the task again once the ended run has left the map', () => {
    // No auto-retry, so nothing relaunches and nothing re-enters the snapshot.
    const { scheduler, emitTask, fire } = setup(0);
    fire(failResult);
    emitTask.mockClear();

    fire(exited);

    expect(scheduler.activeRuns()).toEqual([]);
    // The UI was told to go and read it again, with no runId (the run is over).
    const announced = emitTask.mock.calls.map(([change]) => change as { task: Task; runId: null });
    expect(announced.some((c) => c.task.id === 't1' && c.runId === null)).toBe(true);
  });
});

describe('Scheduler cross-agent negotiation (Phase D)', () => {
  // Two in-flight tasks under the same milestone: a proposer and one sibling. There
  // is no CONTRACT.md on disk, so ownership is unparseable and the sibling is treated
  // as affected (fallback = all in-flight siblings).
  function setupNegotiation() {
    const project = {
      id: 'p',
      path: 'C:/does-not-exist',
      planPath: 'C:/does-not-exist/plan.md',
      name: 'P',
      concurrency: 2,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'acceptEdits',
    } as Project;
    const proposer: Task = {
      id: 'prop',
      projectId: 'p',
      phase: 'M',
      title: 'Build API',
      status: 'running',
      sessionId: 's1',
      order: 0,
      source: 'plan',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
    } as Task;
    const sibling: Task = {
      id: 'sib',
      projectId: 'p',
      phase: 'M',
      title: 'Build UI',
      status: 'running',
      sessionId: 's2',
      order: 1,
      source: 'plan',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
    } as Task;
    const tasks = [proposer, sibling];
    const store = {
      getTasks: () => tasks,
      getProject: () => project,
      getTask: (id: string) => tasks.find((t) => t.id === id),
      updateTask: (id: string, patch: Partial<Task>) => {
        const t = tasks.find((x) => x.id === id);
        if (t) Object.assign(t, patch);
        return t;
      },
      appendTaskEvent: vi.fn(),
      getSettings: () => ({ maxAutoRetries: 0, limitJitterMs: 0, concurrency: 2 }),
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const send = vi.fn();
    const sessions = { send, stop: vi.fn() } as unknown as SessionManager;
    const emitAttention = vi.fn();
    const scheduler = new Scheduler(
      store,
      sessions,
      vi.fn(),
      vi.fn(),
      emitAttention,
      vi.fn(),
      vi.fn(),
    );
    const runs = (scheduler as unknown as { runs: Map<string, unknown> }).runs;
    runs.set('rprop', { taskId: 'prop', projectId: 'p', runId: 'rprop', settled: false });
    runs.set('rsib', { taskId: 'sib', projectId: 'p', runId: 'rsib', settled: false });
    const fire = (runId: string, event: unknown): void =>
      (scheduler as unknown as { onRunEvent: (r: string, e: unknown) => void }).onRunEvent(
        runId,
        event,
      );
    return { scheduler, proposer, sibling, send, emitAttention, fire };
  }

  const propose = { kind: 'assistant', text: `${PROPOSE_SENTINEL} Rename the User type.` };
  // The proposer stops and waits after `@@PROPOSE@@`, so its turn ends with a result.
  const proposerDone = {
    kind: 'result',
    success: true,
    resultText: '',
    costUsd: null,
    durationMs: null,
    stopReason: null,
    terminalReason: null,
  };

  it('opens a round: parks the proposer and messages the affected sibling', () => {
    const { proposer, send, emitAttention, fire } = setupNegotiation();
    fire('rprop', propose);
    expect(proposer.status).toBe('waiting-input'); // proposer parked, not settled
    expect(emitAttention).not.toHaveBeenCalled(); // no human item during the round
    // The sibling was asked to vote.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe('rsib');
    expect(send.mock.calls[0][1]).toContain(AGREE_SENTINEL);
  });

  it('does not settle the proposer when its @@PROPOSE@@ turn ends mid-round', () => {
    const { proposer, fire } = setupNegotiation();
    fire('rprop', propose);
    fire('rprop', proposerDone); // the trailing result must NOT mark the task done
    expect(proposer.status).toBe('waiting-input');
  });

  it('unanimous agreement resumes the proposer and notifies teammates (no human item)', () => {
    const { proposer, send, emitAttention, fire } = setupNegotiation();
    fire('rprop', propose);
    fire('rprop', proposerDone); // proposer now idle, waiting on the vote
    send.mockClear();
    fire('rsib', { kind: 'assistant', text: `${AGREE_SENTINEL}` });
    expect(proposer.status).toBe('running'); // proposer un-parked
    expect(emitAttention).not.toHaveBeenCalled(); // consensus — never bothered the human
    // Proposer told to update the contract; sibling told to re-read it.
    const targets = send.mock.calls.map((c) => c[0]);
    expect(targets).toContain('rprop');
    expect(targets).toContain('rsib');
    const toProposer = send.mock.calls.find((c) => c[0] === 'rprop')?.[1] as string;
    expect(toProposer).toContain('CONTRACT.md');
  });

  it('a decision reached before the proposer stops is delivered when its turn ends', () => {
    // Vote lands FIRST (proposer still mid-turn) — the resume must wait for the result.
    const { proposer, send, fire } = setupNegotiation();
    fire('rprop', propose);
    send.mockClear();
    fire('rsib', { kind: 'assistant', text: `${AGREE_SENTINEL}` });
    expect(proposer.status).toBe('waiting-input'); // not resumed yet — proposer not idle
    expect(send.mock.calls.find((c) => c[0] === 'rprop')).toBeUndefined();
    fire('rprop', proposerDone); // NOW it's idle — the queued decision flushes
    expect(proposer.status).toBe('running');
    expect(send.mock.calls.find((c) => c[0] === 'rprop')?.[1]).toContain('CONTRACT.md');
  });

  it('an objection escalates a `proposal` item to the human, listing the reason', () => {
    const { emitAttention, fire } = setupNegotiation();
    fire('rprop', propose);
    fire('rprop', proposerDone);
    fire('rsib', { kind: 'assistant', text: `${OBJECT_SENTINEL} that breaks my migration` });
    expect(emitAttention).toHaveBeenCalledTimes(1);
    const item = emitAttention.mock.calls[0][0] as {
      kind: string;
      options: string[];
      prompt: string;
    };
    expect(item.kind).toBe('proposal');
    expect(item.options).toEqual([PROPOSAL_ACTION.accept, PROPOSAL_ACTION.keep]);
    expect(item.prompt).toContain('that breaks my migration');
  });

  it('human "Accept proposal" applies it: proposer resumes and updates the contract', () => {
    const { scheduler, proposer, send, emitAttention, fire } = setupNegotiation();
    fire('rprop', propose);
    fire('rprop', proposerDone);
    fire('rsib', { kind: 'assistant', text: `${OBJECT_SENTINEL} no` });
    const item = emitAttention.mock.calls[0][0] as { id: string };
    send.mockClear();
    scheduler.answerAttention(item.id, { decision: 'reply', text: PROPOSAL_ACTION.accept });
    expect(proposer.status).toBe('running');
    const toProposer = send.mock.calls.find((c) => c[0] === 'rprop')?.[1] as string;
    expect(toProposer).toContain('CONTRACT.md');
  });

  it('a proposal with no affected teammate is vacuously agreed after the proposer stops', () => {
    const { scheduler, proposer, send, fire } = setupNegotiation();
    // Remove the sibling run so there is no one to consult.
    (scheduler as unknown as { runs: Map<string, unknown> }).runs.delete('rsib');
    fire('rprop', propose);
    expect(proposer.status).toBe('waiting-input'); // parked awaiting its own turn-end
    fire('rprop', proposerDone);
    expect(proposer.status).toBe('running');
    expect(send.mock.calls.find((c) => c[0] === 'rprop')?.[1]).toContain('CONTRACT.md');
  });
});

describe('Scheduler — a plan approved into subtasks (Phase 11)', () => {
  /**
   * A delegated card with two steps, running in worktree mode. The fake worktree
   * manager records what it was asked to prepare/integrate, which is where the two
   * rules of the chain show up: every step prepares the PARENT's worktree, and only
   * the LAST step integrates.
   */
  function setup(
    steps: Array<Partial<Task>> = [{ id: 's1' }, { id: 's2' }],
    opts?: {
      autoIntegrate?: boolean;
      /** The repo's own auto-merge preference; `undefined` = it has not ruled. */
      projectAutoIntegrate?: boolean | null;
      /** The CARD's override; `undefined` = it has not ruled either. */
      cardAutoIntegrate?: boolean | null;
      savedLimit?: LimitState | null;
      /** What the merge reports back; `undefined` = it merged. */
      integrateResult?: Record<string, unknown>;
      /** What continuing the paused rebase reports back; `undefined` = it merged. */
      finishResult?: Record<string, unknown>;
    },
  ) {
    const agentProject = {
      id: 'agent-1',
      name: 'Checkout service',
      path: 'C:/repos/checkout',
      planPath: '',
      kind: 'agent',
      concurrency: 1,
      useWorktrees: true,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'acceptEdits',
      autoIntegrate: opts?.projectAutoIntegrate ?? null,
    } as unknown as Project;
    const parent = {
      id: 't1',
      projectId: 'personal',
      phase: '',
      title: 'Fix the export dialog',
      status: 'in-progress',
      sessionId: null,
      order: 0,
      source: 'jira',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      externalKey: 'ABC-42',
      agentProjectId: 'agent-1',
      agentMode: 'plan',
      agentPlan: '## Reproduce it\nfirst\n\n## Fix it\nsecond',
      parentTaskId: null,
      autoIntegrate: opts?.cardAutoIntegrate ?? null,
    } as unknown as Task;
    const children = steps.map(
      (s, i) =>
        ({
          projectId: 'personal',
          phase: '',
          title: `Step ${i + 1}`,
          status: 'pending',
          sessionId: null,
          order: i,
          source: 'adhoc',
          dependsOn: [],
          isContract: false,
          isScaffold: false,
          parentTaskId: 't1',
          agentProjectId: 'agent-1',
          agentMode: 'bypassPermissions',
          ...s,
        }) as unknown as Task,
    );
    const byId = new Map<string, Task>([
      [parent.id, parent],
      ...children.map((c) => [c.id, c] as const),
    ]);
    const added: Array<{ title: string; description?: string | null; round?: number }> = [];
    const comments: string[] = [];
    const store = {
      getTask: (id: string) => byId.get(id),
      getProject: (id: string) => (id === 'agent-1' ? agentProject : undefined),
      listProjects: () => [agentProject],
      getTasks: () => [parent, ...children],
      getSubtasks: (parentId: string) => children.filter((c) => c.parentTaskId === parentId),
      getTaskActivity: () => [],
      addSubtask: (
        _p: string,
        input: { title: string; description?: string | null; round?: number },
      ) => {
        added.push(input);
        return undefined;
      },
      maxSubtaskRound: (parentId: string) =>
        children
          .filter((c) => c.parentTaskId === parentId)
          .reduce((max, c) => Math.max(max, c.planRound ?? 1), 0),
      addComment: (_p: string, _t: string, body: string) => comments.push(body),
      // A board with no arrows on it: these cases run a plan's steps through settle and
      // integration, both of which now ask the chain runner what to release next.
      listTaskLinks: () => [],
      updateTask: (id: string, patch: Partial<Task>) => {
        const task = byId.get(id);
        if (task) Object.assign(task, patch);
        return task;
      },
      appendTaskEvent: vi.fn(),
      appendTokenUsage: vi.fn(),
      // `autoIntegrate` on: these cases are ABOUT the integration path, and Phase 17 made
      // merging manual by default. The manual case has its own test below.
      getSettings: () => ({
        maxAutoRetries: 0,
        limitJitterMs: 0,
        concurrency: 1,
        autoIntegrate: opts?.autoIntegrate ?? true,
      }),
      // The usage-limit gate persists itself on every change; these cases drive it, so the
      // two ends of that have to exist. `loadLimitGate` answering null is also the state
      // the restart case below is about: statuses left parked with no gate behind them.
      saveLimitGate: () => undefined,
      loadLimitGate: () => opts?.savedLimit ?? null,
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const prepared: Array<{ taskId: string; owner: string }> = [];
    /** Whether each `prepare` was told this run is resolving a rebase the app paused. */
    const resuming: boolean[] = [];
    const integrated: Array<{ branch: string; base: string }> = [];
    /** Every paused rebase the scheduler went back and finished (Rung 2's redemption). */
    const finished: Array<{ branch: string; base: string }> = [];
    const worktrees = {
      prepare: (
        _p: Project,
        task: Task,
        owner: string = task.id,
        _branch?: string,
        _startPoint?: string,
        prepOpts?: { resumingRebase?: boolean },
      ) => {
        prepared.push({ taskId: task.id, owner });
        resuming.push(prepOpts?.resumingRebase === true);
        return Promise.resolve({
          mode: 'worktree',
          cwd: `C:/wt/${owner}`,
          branch: `orch/${owner}`,
          base: 'main',
        });
      },
      integrate: (_p: Project, branch: string, base: string) => {
        integrated.push({ branch, base });
        return Promise.resolve(opts?.integrateResult ?? { status: 'merged' });
      },
      // Rung 2's two ends: what it tells the agent is conflicted, and what continues the
      // paused rebase once the agent's run is over. `finished` is the fact those cases are
      // really about — a rebase left paused with nobody to continue it is the stranded
      // worktree that blocks every later button on the card.
      listConflicts: () => Promise.resolve(['src/app.ts']),
      finishAfterConflict: (_p: Project, branch: string, base: string) => {
        finished.push({ branch, base });
        return Promise.resolve(opts?.finishResult ?? { status: 'merged' });
      },
      cleanup: vi.fn(),
    } as unknown as WorktreeManager;
    const start = vi.fn((_req: unknown, opts: { runId?: string }) => ({
      runId: opts?.runId ?? 'r-new',
    }));
    const stop = vi.fn();
    const send = vi.fn();
    const sessions = { start, stop, send } as unknown as SessionManager;
    const emitAttention = vi.fn();
    const scheduler = new Scheduler(
      store,
      sessions,
      vi.fn(),
      vi.fn(),
      emitAttention,
      vi.fn(),
      vi.fn(),
      worktrees,
    );
    /** Seed a live run for one task, as the scheduler would have after launching it. */
    const seedRun = (runId: string, taskId: string, owner = 't1'): void => {
      (scheduler as unknown as { runs: Map<string, unknown> }).runs.set(runId, {
        taskId,
        projectId: 'agent-1',
        runId,
        settled: false,
        branch: `orch/${owner}`,
        base: 'main',
        worktree: `C:/wt/${owner}`,
      });
      (scheduler as unknown as { inFlight: Set<string> }).inFlight.add(taskId);
    };
    // Awaitable for the one branch of `onRunEvent` that yields — a `result` naming a usage
    // limit, which is confirmed against a `/usage` reading before it is believed. Every
    // other event still completes synchronously, so the cases below need no `await`.
    const fire = (runId: string, event: unknown): Promise<void> =>
      (scheduler as unknown as { onRunEvent: (r: string, e: unknown) => Promise<void> }).onRunEvent(
        runId,
        event,
      );
    return {
      scheduler,
      parent,
      children,
      start,
      stop,
      emitAttention,
      prepared,
      resuming,
      integrated,
      finished,
      added,
      comments,
      seedRun,
      fire,
    };
  }

  const okResult = {
    kind: 'result',
    success: true,
    resultText: '',
    costUsd: null,
    durationMs: null,
    stopReason: null,
    terminalReason: null,
  };

  /** Let the async chains settle (prepare → launch, and integrate → apply outcome). */
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('runs every step in the PARENT’s worktree, on the parent’s branch', async () => {
    const { scheduler, prepared } = setup();
    scheduler.runTask('s2');
    await flush();
    expect(prepared).toEqual([{ taskId: 's2', owner: 't1' }]);
  });

  /**
   * A rebase paused in the worktree is debris for an ordinary run — it detaches HEAD, which
   * blocks every button on the card — and is the whole job of a conflict-resolution run.
   * Only the scheduler can tell the two apart, so it has to SAY which one this is; preparing
   * without an answer is how a card either stays stuck or has its conflict fix thrown away.
   */
  describe('a rebase paused in the worktree', () => {
    /** Park a merge conflict against `taskId`, as Rung 3 does when the AI rung runs out. */
    const parkConflict = (scheduler: Scheduler, taskId: string): void => {
      (scheduler as unknown as { attention: Map<string, unknown> }).attention.set('inbox-1', {
        id: 'inbox-1',
        kind: 'merge-conflict',
        taskId,
        projectId: 'agent-1',
      });
    };

    it('is cleared before an ordinary step', async () => {
      const { scheduler, resuming } = setup();
      scheduler.runTask('s2');
      await flush();
      expect(resuming).toEqual([false]);
    });

    it('is handed over when a conflict is parked against a step of the same card', async () => {
      const { scheduler, resuming } = setup();
      // Parked against s1; the run being started is s2 — one worktree, one branch, so the
      // conflict is just as much s2's as s1's.
      parkConflict(scheduler, 's1');
      scheduler.runTask('s2');
      await flush();
      expect(resuming).toEqual([true]);
    });

    it('is not handed over for a conflict parked on an unrelated card', async () => {
      const { scheduler, resuming } = setup();
      parkConflict(scheduler, 'someone-elses-card');
      scheduler.runTask('s2');
      await flush();
      expect(resuming).toEqual([false]);
    });
  });

  /**
   * Rung 2 — the agent asked to resolve a rebase this app paused.
   *
   * All three of these are one failure, seen from three sides. On a card assigned `plan`, the
   * conflict fix was launched in `plan` mode, so the run that existed to WRITE resolutions was
   * the one mode that may not; it sat at the approval gate, raised a plan-approval nobody had
   * asked for, staged the resolutions anyway, and then — because that approval was still open
   * — never settled. Never settling meant the paused rebase was never continued, and a
   * detached `HEAD` in the worktree then refused every button on the card. Nothing about any
   * of it appeared on the card.
   */
  describe('conflict ladder Rung 2 (the agent fix)', () => {
    /** Drive a card's run to a rebase conflict, which dispatches the AI fix. */
    const toConflict = (harness: ReturnType<typeof setup>): void => {
      harness.seedRun('r-work', 't1');
      harness.fire('r-work', okResult);
    };

    const conflicted = {
      integrateResult: {
        status: 'conflict',
        worktree: 'C:/wt/t1',
        branch: 'orch/t1',
        base: 'main',
      },
    };

    it('runs in a mode that can WRITE, not the `plan` the card is assigned', async () => {
      const harness = setup(undefined, conflicted);
      const { start, parent } = harness;
      expect(parent.agentMode).toBe('plan'); // the state the real card was in
      toConflict(harness);
      await flush();
      // The project's own default, because an install that has decided how much its agents
      // may do unattended keeps deciding it — only `plan` is refused.
      expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0][0]).toMatchObject({ permissionMode: 'acceptEdits' });
    });

    it('finishes the paused rebase even with an inbox item still open for its run', async () => {
      const harness = setup(undefined, conflicted);
      const { scheduler, start, fire, finished } = harness;
      toConflict(harness);
      await flush();
      const fixRunId = (start.mock.calls[0][1] as { runId: string }).runId;
      // What plan mode left behind: an approval for a plan the agent had already abandoned,
      // open against the very run whose `result` is about to arrive.
      (scheduler as unknown as { attention: Map<string, unknown> }).attention.set('inbox-plan', {
        id: 'inbox-plan',
        kind: 'plan-approval',
        runId: fixRunId,
        taskId: 't1',
        projectId: 'agent-1',
      });
      fire(fixRunId, okResult);
      await flush();
      expect(finished).toEqual([{ branch: 'orch/t1', base: 'main' }]);
    });

    it('finishes the paused rebase even when the fix run FAILED', async () => {
      // A usage limit, a dead sign-in, an api_error: the run is over and the rebase is still
      // paused. `finishAfterConflict` re-reads the tree, so an unresolved fix comes back as a
      // conflict and climbs the ladder — what must never happen is nobody looking at all.
      const harness = setup(undefined, conflicted);
      const { start, fire, finished } = harness;
      toConflict(harness);
      await flush();
      const fixRunId = (start.mock.calls[0][1] as { runId: string }).runId;
      fire(fixRunId, { ...okResult, success: false, terminalReason: 'api_error' });
      await flush();
      expect(finished).toEqual([{ branch: 'orch/t1', base: 'main' }]);
    });
  });

  describe('starting a CARD that has steps', () => {
    // The bug: steps written by hand were ignored by `runTask`, so starting the card ran the
    // card's own session with the whole ticket as its brief. One agent did all the work in
    // one go while the board sat at 0/2 — the steps had been typed out and then quietly
    // bypassed. An approved plan handed over correctly, so who wrote the steps down decided
    // whether they were honoured.
    it('starts the first pending STEP, not the card’s own session', async () => {
      const { scheduler, prepared } = setup();
      scheduler.runTask('t1');
      await flush();
      expect(prepared).toEqual([{ taskId: 's1', owner: 't1' }]);
    });

    it('skips a step that is already done and starts the next one waiting', async () => {
      const { scheduler, children, prepared } = setup();
      children[0].status = 'done';
      scheduler.runTask('t1');
      await flush();
      expect(prepared).toEqual([{ taskId: 's2', owner: 't1' }]);
    });

    // The fall-through, and it matters as much as the hand-over: once the chain is over the
    // card holds the review conversation, and running it must reach the card again.
    it('runs the CARD once no step is left pending', async () => {
      const { scheduler, children, prepared } = setup();
      children[0].status = 'done';
      children[1].status = 'done';
      scheduler.runTask('t1');
      await flush();
      expect(prepared).toEqual([{ taskId: 't1', owner: 't1' }]);
    });

    // A parked chain is the human's to resolve — `advanceSubtasks` will not step over a
    // failure, and neither may this.
    it('runs the CARD when the chain is parked at a failed step', async () => {
      const { scheduler, children, prepared } = setup();
      children[0].status = 'failed';
      children[1].status = 'pending';
      scheduler.runTask('t1');
      await flush();
      // Step 2 is pending, but step 1 failed — the first PENDING step is still what starts,
      // which is the same rule `advanceSubtasks` applies. The card is not run behind it.
      expect(prepared).toEqual([{ taskId: 's2', owner: 't1' }]);
    });

    it('leaves a card with no steps at all exactly as it was', async () => {
      const { scheduler, prepared } = setup([]);
      scheduler.runTask('t1');
      await flush();
      expect(prepared).toEqual([{ taskId: 't1', owner: 't1' }]);
    });
  });

  it('a non-final step settles WITHOUT integrating, and starts its sibling', async () => {
    const { children, integrated, start, seedRun, fire } = setup();
    seedRun('r1', 's1');
    fire('r1', okResult);
    await flush();
    expect(children[0].status).toBe('done');
    expect(integrated).toEqual([]); // the chain's branch is not finished yet
    expect(start).toHaveBeenCalledTimes(1); // …step 2 is on its way instead
  });

  it('the FINAL step integrates the shared branch and hands the card back for review', async () => {
    const { parent, children, integrated, comments, seedRun, fire } = setup();
    children[0].status = 'done';
    seedRun('r2', 's2');
    fire('r2', okResult);
    await flush();
    expect(integrated).toEqual([{ branch: 'orch/t1', base: 'main' }]);
    // The final STEP still reaches `done` — the chain machinery reads that as "over", and
    // a step is not a board column entry.
    expect(children[1].status).toBe('done');
    // The parent is NEVER auto-completed: it waits in progress for a human.
    expect(parent.status).toBe('in-progress');
    // Phase 17: a summary of what every step did, not a one-line "ready for review" note —
    // the card's Details Panel should read as one story.
    const filed = comments.join(' ');
    expect(filed).toContain('Plan complete');
    expect(filed).toContain('2 of 2 steps finished');
    expect(filed).toContain('1. Step 1');
    expect(filed).toContain('2. Step 2');
    expect(filed).toContain('Merged `orch/t1` into `main`');
    expect(filed).toContain('move it to Done yourself');
  });

  /**
   * The reported bug: **a step that says "Running" for ever, with its own session visibly
   * exited in the panel underneath it.**
   *
   * The final step finished, `settle` handed its branch to the merge, and the merge came
   * back `nothing-to-merge` — that branch had already landed, or (as in the incident) the
   * worktree was mid-rebase so its "branch" was the literal `HEAD` and no such ref exists.
   * That outcome was written for the Merge button, where the card is resting and touching
   * nothing is right; arriving from a run it left the step holding the `running` the run had
   * borrowed, and nothing writes that field again — the `exited` a fraction of a second
   * later is guarded on `!run.settled`, so it declined to.
   *
   * The spinner was the visible half. The costly half is `chainInFlight`, which reads
   * `running` as "this plan is still going": the card could not be chatted to, re-planned or
   * advanced, and stayed that way for 33 minutes until a human went looking.
   */
  it('gives a step its status back when the merge finds nothing to merge', async () => {
    const { parent, children, comments, emitAttention, seedRun, fire } = setup(undefined, {
      integrateResult: {
        status: 'nothing-to-merge',
        branch: 'orch/t1',
        base: 'main',
        reason: 'branch "orch/t1" no longer exists in C:/repos/checkout',
      },
    });
    children[0].status = 'done';
    children[1].status = 'running'; // what a live run always looks like when it settles
    seedRun('r2', 's2');
    fire('r2', okResult);
    await flush();

    // The whole bug in one line: the step is over, so it must not still claim to be working.
    expect(children[1].status).toBe('done');
    // …which is what lets the card be talked to again — `chainInFlight` is now false.
    expect(children.some((c) => c.status === 'running')).toBe(false);
    // Nothing is wrong, so nobody is interrupted.
    expect(emitAttention).not.toHaveBeenCalled();
    // The chain still hands back: the summary, and the marker the next run reads.
    const filed = comments.join(' ');
    expect(filed).toContain('Plan complete');
    // But it must not claim a merge that did not happen, nor point at a Merge button that
    // could only repeat this refusal — the timeline note above carries git's own reason.
    expect(filed).not.toContain('Merged `orch/t1`');
    expect(filed).not.toContain('NOT been merged');
    expect((parent as unknown as { chainLandedAt: number | null }).chainLandedAt).not.toBeNull();
  });

  // Token audit S5: a chain landing used to spawn a whole fresh session just to comment on
  // its own summary. Now it only files the comment and leaves a one-shot marker — the
  // review session starts (if ever) on the human's own first chat message.
  it('clears the session and marks the chain landed, without starting a review run', async () => {
    const { parent, children, comments, seedRun, fire, start } = setup();
    // The stopped planner's session — must not be left resumable.
    parent.sessionId = 'planner-session';
    children[0].status = 'done';
    seedRun('r2', 's2');
    fire('r2', okResult);
    await flush();

    expect(comments.join(' ')).toContain('Plan complete');
    expect(parent.sessionId).toBeNull();
    expect((parent as unknown as { chainLandedAt: number | null }).chainLandedAt).not.toBeNull();
    // Nothing was started to seed a review — `start` only ever fires from `startTask`, and
    // this whole flow never called it (the step's own run was seeded directly, above).
    expect(start).not.toHaveBeenCalled();
  });

  it('holds the finished branch for a human when autoIntegrate is off (Phase 17)', async () => {
    const { parent, children, integrated, comments, seedRun, fire } = setup(undefined, {
      autoIntegrate: false,
    });
    children[0].status = 'done';
    seedRun('r2', 's2');
    fire('r2', okResult);
    await flush();
    // The whole point: nothing was merged. Merging at the instant the agent stops is
    // merging at the moment the work has been reviewed least.
    expect(integrated).toEqual([]);
    // Everything else still happens — the step is over, the card waits for a human, and
    // the branch is named so it can be found and reviewed.
    expect(children[1].status).toBe('done');
    expect(parent.status).toBe('in-progress');
    const filed = comments.join(' ');
    expect(filed).toContain('orch/t1');
    expect(filed).toContain('NOT been merged');
  });

  /**
   * Auto-merge is asked of the CARD, not of the app (`@shared/integrate`): the card's own
   * answer, else its project's, else the app-wide setting. Each of these drives a real
   * chain to its last step and asks the only question that matters — was it merged.
   */
  describe('whose auto-merge answer counts', () => {
    /** Run the chain to the end and report whether the branch was merged. */
    const finish = async (opts: Parameters<typeof setup>[1]): Promise<boolean> => {
      const { children, integrated, seedRun, fire } = setup(undefined, opts);
      children[0].status = 'done';
      seedRun('r2', 's2');
      fire('r2', okResult);
      await flush();
      return integrated.length > 0;
    };

    it('lets a repo refuse what the app turned on for everyone', async () => {
      expect(await finish({ autoIntegrate: true, projectAutoIntegrate: false })).toBe(false);
    });

    it('lets a repo merge by itself while the app leaves it to the human', async () => {
      expect(await finish({ autoIntegrate: false, projectAutoIntegrate: true })).toBe(true);
    });

    it('lets one card opt out of a repo that merges everything', async () => {
      expect(
        await finish({
          autoIntegrate: false,
          projectAutoIntegrate: true,
          cardAutoIntegrate: false,
        }),
      ).toBe(false);
    });

    it('lets one card opt in where nothing else does', async () => {
      expect(
        await finish({
          autoIntegrate: false,
          projectAutoIntegrate: false,
          cardAutoIntegrate: true,
        }),
      ).toBe(true);
    });

    it('falls all the way through to the app when neither has ruled', async () => {
      expect(await finish({ autoIntegrate: true })).toBe(true);
      expect(await finish({ autoIntegrate: false })).toBe(false);
    });

    // The step that finishes a chain is the one holding the run, but the branch is the
    // PARENT's and the whole plan merges once — so a step's own field is never consulted.
    it('asks the parent card, not the step that happened to finish', async () => {
      const { children, integrated, seedRun, fire } = setup(undefined, {
        autoIntegrate: false,
        cardAutoIntegrate: true,
      });
      children[0].status = 'done';
      (children[1] as { autoIntegrate?: boolean | null }).autoIntegrate = false;
      seedRun('r2', 's2');
      fire('r2', okResult);
      await flush();
      expect(integrated).toEqual([{ branch: 'orch/t1', base: 'main' }]);
    });
  });

  it('a failed step stops the chain — its siblings stay pending', async () => {
    const { children, start, emitAttention, seedRun, fire } = setup();
    seedRun('r1', 's1');
    fire('r1', { ...okResult, success: false, stopReason: 'error' });
    await Promise.resolve();
    expect(emitAttention).toHaveBeenCalledTimes(1);
    expect((emitAttention.mock.calls[0][0] as { kind: string }).kind).toBe('task-failed');
    expect(children[1].status).toBe('pending'); // never started
    expect(start).not.toHaveBeenCalled();
  });

  // ---- Phase 12/4: resolving a parked step re-enters the chain ------------------

  /** Fail step 1 and return the inbox item the human would be answering. */
  async function park(h: ReturnType<typeof setup>): Promise<{ id: string }> {
    h.seedRun('r1', 's1');
    h.fire('r1', { ...okResult, success: false, stopReason: 'error' });
    await Promise.resolve();
    return h.emitAttention.mock.calls[0][0] as { id: string };
  }

  it('waving a parked step through with Mark done starts the NEXT step', async () => {
    const h = setup();
    const item = await park(h);
    h.scheduler.answerAttention(item.id, { decision: 'reply', text: FAILURE_ACTION.markDone });
    await flush();
    expect(h.children[0].status).toBe('done');
    // The chain moved on — the whole point of resolving from the parent's pane.
    expect(h.prepared).toEqual([{ taskId: 's2', owner: 't1' }]);
  });

  it('retrying a parked step re-runs THAT step in the chain’s shared worktree', async () => {
    const h = setup();
    const item = await park(h);
    h.scheduler.answerAttention(item.id, { decision: 'reply', text: FAILURE_ACTION.retry });
    await flush();
    expect(h.prepared).toEqual([{ taskId: 's1', owner: 't1' }]);
    expect(h.children[1].status).toBe('pending'); // step 2 still waits its turn
  });

  it('parks an interrupted STEP as failed on restart, so the chain says it stopped', () => {
    const h = setup([{ id: 's1', status: 'running' }, { id: 's2' }]);
    h.scheduler.reconcileInterruptedTasks();
    // `pending` would leave the card at 1/2 with nothing on screen and nothing to click:
    // no queue re-enters a chain, so the step has to be visibly parked instead.
    expect(h.children[0].status).toBe('failed');
    expect(h.children[1].status).toBe('pending'); // untouched
    expect(h.parent.status).toBe('in-progress');
  });

  it('still re-queues an interrupted CARD, which its project’s queue can pick up', () => {
    const h = setup();
    h.parent.status = 'running';
    h.scheduler.reconcileInterruptedTasks();
    expect(h.parent.status).toBe('pending');
  });

  // ---- Stop, then Resume, on a card executing a plan ---------------------------
  //
  // Stop marks every queued step `stopped`, which leaves the chain with nothing runnable in
  // it. Putting those steps back to `pending` is therefore not housekeeping — it IS the
  // resume: it is the only thing that makes `nextRunnableStep` divert the start to the step
  // that was interrupted instead of opening the card's own session beside its chain.
  it('re-queues the stopped steps and restarts the chain at the stopped one', async () => {
    const h = setup();
    h.seedRun('r1', 's1');
    expect(h.scheduler.stopTask('t1')).toBe(true);
    expect(h.children.map((c) => c.status)).toEqual(['stopped', 'stopped']);
    expect(typeof h.parent.stoppedAt).toBe('number');

    // The stopped process goes, freeing the slot — as `exited` would have.
    (h.scheduler as unknown as { runs: Map<string, unknown> }).runs.delete('r1');
    (h.scheduler as unknown as { inFlight: Set<string> }).inFlight.delete('s1');

    expect(h.scheduler.resumeTask('t1')).toHaveProperty('runId');
    await flush();
    expect(h.children[1].status).toBe('pending'); // re-queued, waiting its turn as before
    // Step 1, in the parent's worktree — not the card, which would be a second agent on the
    // same branch answering the whole ticket at once.
    expect(h.prepared).toEqual([{ taskId: 's1', owner: 't1' }]);
    expect(h.parent.stoppedAt).toBe(null);
  });

  it('leaves a chain nobody stopped exactly where it is', async () => {
    // Resume only ever un-does a stop: a step that ran to completion must not be dragged
    // back into the queue by a button pressed on the card above it.
    const h = setup([{ id: 's1', status: 'done' }, { id: 's2' }]);
    expect(h.scheduler.resumeTask('t1')).toHaveProperty('runId');
    await flush();
    expect(h.children[0].status).toBe('done');
    expect(h.prepared).toEqual([{ taskId: 's2', owner: 't1' }]);
  });

  // ---- a usage limit in the middle of a chain ----------------------------------
  //
  // The bug: a card stopped mid-plan when the account hit its limit and never started
  // again. Three separate holes, each of which alone was enough to strand it:
  //
  //  1. `advanceSubtasks` returned early under a limit and left the next step `pending`
  //     — but nothing re-enters a chain, so the reset had nothing to resume;
  //  2. `resumeParked` skipped any task with no `sessionId`, which is every run the
  //     limit caught before its process had started;
  //  3. a restart with no gate left in the DB left the parked statuses there for ever.
  describe('a usage limit interrupting a chain', () => {
    const limited = {
      kind: 'rate-limit' as const,
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: null,
    };

    /** The scheduler's private gate, so a limit can be put in force without a run. */
    const gateOf = (scheduler: Scheduler) =>
      (
        scheduler as unknown as {
          limitGate: { engage: (s: unknown, ids: string[]) => void; dispose: () => void };
        }
      ).limitGate;

    it('parks the next step instead of dropping the chain, and starts it at the reset', async () => {
      const h = setup();
      const gate = gateOf(h.scheduler);
      // A limit is in force account-wide (some other run hit the wall) as step 1 finishes.
      gate.engage(limited, []);
      h.seedRun('r1', 's1');
      h.fire('r1', okResult);
      await flush();

      expect(h.children[0].status).toBe('done');
      // Not `pending`: nothing would ever have looked at it again. Parked is a state the
      // reset walks and the board reads as "paused — usage limit".
      expect(h.children[1].status).toBe('blocked-by-limit');
      expect(h.prepared).toEqual([]); // and nothing ran under the limit

      h.scheduler.resumeLimitNow(); // the reset (or the banner's "Resume now")
      await flush();
      expect(h.prepared).toEqual([{ taskId: 's2', owner: 't1' }]);
    });

    it('resumes a step the limit caught before its session ever started', async () => {
      const h = setup();
      h.seedRun('r1', 's1'); // reserved and launching; no `started` event yet, so no session id
      h.fire('r1', limited);
      expect(h.children[0].status).toBe('blocked-by-limit');
      expect(h.children[0].sessionId).toBeNull();

      h.scheduler.resumeLimitNow();
      await flush();
      // Nothing to resume, so it starts from its brief — which is still the whole point:
      // skipping it left the step parked behind a gate that no longer existed.
      expect(h.prepared).toEqual([{ taskId: 's1', owner: 't1' }]);
    });

    it('hands a parked CARD back to its chain rather than running it beside its steps', async () => {
      const h = setup();
      h.seedRun('r0', 't1'); // the planner, parked mid-run by the limit
      h.fire('r0', limited);
      expect(h.parent.status).toBe('blocked-by-limit');

      h.scheduler.resumeLimitNow();
      await flush();
      // The card's own session is the planner's, and its steps are its work: two agents in
      // one worktree is what running the card here would mean.
      expect(h.prepared).toEqual([{ taskId: 's1', owner: 't1' }]);
    });

    it('does not step over a failed step when it hands a card back to its chain', async () => {
      const h = setup([{ id: 's1', status: 'failed' }, { id: 's2' }]);
      h.seedRun('r0', 't1');
      h.fire('r0', limited);
      expect(h.parent.status).toBe('blocked-by-limit');

      h.scheduler.resumeLimitNow();
      await flush();
      // The chain is stopped on a step the human owns; a limit resetting is not them
      // resolving it. Nothing runs — not the card's own session, not step 2.
      expect(h.prepared).toEqual([]);
      expect(h.children[1].status).toBe('pending');
    });

    it('stopping the card releases a step the gate is holding', async () => {
      const h = setup();
      const gate = gateOf(h.scheduler);
      gate.engage(limited, []);
      h.seedRun('r1', 's1');
      h.fire('r1', okResult);
      await flush();
      expect(h.children[1].status).toBe('blocked-by-limit');

      expect(h.scheduler.stopTask('t1')).toBe(true);
      expect(h.children[1].status).toBe('stopped');
      h.scheduler.resumeLimitNow();
      await flush();
      expect(h.prepared).toEqual([]); // it must not come back to life at the reset
      gate.dispose();
    });

    it('parks a resume behind the gate instead of dropping it', async () => {
      // The rule the gate exists for (`the-gate-is-the-only-memory`): a Resume refused by a
      // limit must be REMEMBERED, or the human is left pressing a button that says nothing
      // happened and nothing ever will.
      const h = setup([
        { id: 's1', status: 'stopped' },
        { id: 's2', status: 'stopped' },
      ]);
      const gate = gateOf(h.scheduler);
      gate.engage(limited, []);

      expect(h.scheduler.resumeTask('t1')).toEqual({ refused: 'limit' });
      expect(h.children[0].status).toBe('blocked-by-limit'); // parked, not left `pending`
      expect(h.prepared).toEqual([]);

      h.scheduler.resumeLimitNow();
      await flush();
      expect(h.prepared).toEqual([{ taskId: 's1', owner: 't1' }]);
      gate.dispose();
    });

    /**
     * The third way the wall arrives, end to end: no `rate_limit_event` at all, just a step
     * whose run ENDED saying the account is out of budget.
     *
     * Every case above starts from the CLI's structured signal. This one starts from the
     * symptom the human actually reported — a chain that stopped, one step marked failed
     * for something it did not do, and no banner, no countdown and nothing that would ever
     * pick it back up. It now ends where the other two do.
     */
    it('parks a step whose run merely ENDED on a usage limit, and resumes it at the reset', async () => {
      const h = setup();
      h.seedRun('r1', 's1');

      await h.fire('r1', {
        kind: 'result',
        success: false,
        resultText: 'Claude AI usage limit reached|1754870400',
        costUsd: null,
        durationMs: null,
        stopReason: null,
        terminalReason: 'api_error',
      });

      // The step is parked, not failed; the card is untouched — its work is the chain's.
      expect(h.children[0].status).toBe('blocked-by-limit');
      expect(h.parent.status).toBe('in-progress');
      expect(h.scheduler.currentLimit()?.resetsAt).toBe(1754870400);
      // Nothing is asked of the human: there is nothing for them to decide, and this is not
      // this card's failure to answer for.
      expect(h.emitAttention).not.toHaveBeenCalled();
      expect(h.prepared).toEqual([]);

      h.scheduler.resumeLimitNow();
      await flush();
      // Exactly the step the wall stopped — not the card beside it, and not step 2.
      expect(h.prepared).toEqual([{ taskId: 's1', owner: 't1' }]);
    });

    it('un-strands a step left blocked-by-limit with no gate behind it (restart)', async () => {
      const h = setup([{ id: 's1', status: 'blocked-by-limit' }, { id: 's2' }]);
      h.scheduler.restoreLimitGate(); // nothing saved: the limit it waited for is long gone
      await flush();
      expect(h.prepared).toEqual([{ taskId: 's1', owner: 't1' }]);
    });

    it('adopts a parked task the saved gate never knew about', async () => {
      const h = setup([{ id: 's1', status: 'blocked-by-limit' }, { id: 's2' }], {
        savedLimit: {
          limitType: 'rolling',
          resetsAt: null,
          resumeAt: Date.now() - 1, // already due, so restore() fires at once
          parkedTaskIds: [], // …and the gate has no memory of s1
        },
      });
      h.scheduler.restoreLimitGate();
      await new Promise((resolve) => setTimeout(resolve, 5)); // the 0ms resume timer
      await flush();
      expect(h.prepared).toEqual([{ taskId: 's1', owner: 't1' }]);
    });
  });

  it('holds ExitPlanMode as a plan-approval item listing the steps it would create', async () => {
    const { scheduler, emitAttention, seedRun } = setup([]);
    seedRun('r0', 't1');
    let released = false;
    void scheduler
      .decidePermission({
        runId: 'r0',
        toolName: 'ExitPlanMode',
        input: { plan: '## Reproduce it\nfirst\n\n## Fix it\nsecond' },
      } as never)
      .then(() => {
        released = true;
      });
    await Promise.resolve();
    expect(released).toBe(false); // the tool is BLOCKED until a human answers
    const item = emitAttention.mock.calls[0][0] as { kind: string; steps: string[]; plan: string };
    expect(item.kind).toBe('plan-approval');
    expect(item.steps).toEqual(['Reproduce it', 'Fix it']);
    expect(item.plan).toContain('## Fix it');
  });

  it('approving creates the steps, stops the planner, and leaves the card in progress', async () => {
    const { scheduler, parent, added, stop, emitAttention, seedRun } = setup([]);
    seedRun('r0', 't1');
    let decision: { behavior: string; message?: string } | undefined;
    void scheduler
      .decidePermission({
        runId: 'r0',
        toolName: 'ExitPlanMode',
        input: { plan: parent.agentPlan },
      } as never)
      .then((d) => {
        decision = d as { behavior: string; message?: string };
      });
    await Promise.resolve();
    const item = emitAttention.mock.calls[0][0] as { id: string };
    scheduler.answerAttention(item.id, { decision: 'approve' });
    await Promise.resolve();
    expect(added.map((s) => s.title)).toEqual(['Reproduce it', 'Fix it']);
    // The planning session is denied and killed — it must not implement its own plan.
    expect(decision?.behavior).toBe('deny');
    expect(decision?.message).toContain('do NOT implement it here');
    expect(stop).toHaveBeenCalledWith('r0');
    expect(parent.status).toBe('in-progress');
  });

  it('rejecting hands the reason back and keeps the planning session alive', async () => {
    const { scheduler, parent, added, stop, emitAttention, seedRun } = setup([]);
    seedRun('r0', 't1');
    let decision: { behavior: string; message?: string } | undefined;
    void scheduler
      .decidePermission({
        runId: 'r0',
        toolName: 'ExitPlanMode',
        input: { plan: parent.agentPlan },
      } as never)
      .then((d) => {
        decision = d as { behavior: string; message?: string };
      });
    await Promise.resolve();
    const item = emitAttention.mock.calls[0][0] as { id: string };
    scheduler.answerAttention(item.id, { decision: 'deny', note: 'Split the migration out.' });
    await Promise.resolve();
    expect(decision).toEqual({ behavior: 'deny', message: 'Split the migration out.' });
    expect(added).toEqual([]);
    expect(stop).not.toHaveBeenCalled();
    expect(parent.status).toBe('running');
  });

  /**
   * Re-planning a card whose chain has finished (Phase 18). The bug this closes: approval
   * used to skip creation entirely when the card already had steps, so a card's first plan
   * was its only one — the human watched an agent plan work that never appeared anywhere.
   */
  describe('a SECOND plan approved onto a card that already has steps', () => {
    /** A finished chain, so `chainInFlight` is false and the card is free to re-plan. */
    const finished = [
      { id: 's1', title: 'Reproduce it', status: 'done' as const },
      { id: 's2', title: 'Fix it', status: 'done' as const },
    ];

    async function approve(
      h: ReturnType<typeof setup>,
      plan: string,
    ): Promise<{ behavior: string; message?: string } | undefined> {
      h.seedRun('r0', 't1');
      let decision: { behavior: string; message?: string } | undefined;
      void scheduleDecision(h, plan).then((d) => {
        decision = d as { behavior: string; message?: string };
      });
      await Promise.resolve();
      const item = h.emitAttention.mock.calls.at(-1)?.[0] as { id: string };
      h.scheduler.answerAttention(item.id, { decision: 'approve' });
      await Promise.resolve();
      return decision;
    }

    const scheduleDecision = (h: ReturnType<typeof setup>, plan: string): Promise<unknown> =>
      h.scheduler.decidePermission({
        runId: 'r0',
        toolName: 'ExitPlanMode',
        input: { plan },
      } as never);

    it('APPENDS the new steps instead of creating nothing', async () => {
      const h = setup(finished);
      h.parent.agentPlan = '## Add JIRA sync\na\n\n## Map the columns\nb';
      await approve(h, h.parent.agentPlan);
      expect(h.added.map((s) => s.title)).toEqual(['Add JIRA sync', 'Map the columns']);
      expect(h.parent.status).toBe('in-progress');
    });

    it('files the appended steps under the next round, so the panel can fold round 1', async () => {
      const h = setup(finished);
      h.parent.agentPlan = '## Add JIRA sync\na\n\n## Map the columns\nb';
      await approve(h, h.parent.agentPlan);
      expect(h.added.map((s) => s.round)).toEqual([2, 2]);
    });

    it('drops the steps the card already carries, keeping only what is new', async () => {
      const h = setup(finished);
      h.parent.agentPlan = '## Fix it\nagain\n\n## Add JIRA sync\nnew';
      await approve(h, h.parent.agentPlan);
      expect(h.added.map((s) => s.title)).toEqual(['Add JIRA sync']);
    });

    it('lists ONLY the steps approval will create, so the inbox cannot over-promise', async () => {
      const h = setup(finished);
      h.parent.agentPlan = '## Fix it\nagain\n\n## Add JIRA sync\nnew';
      h.seedRun('r0', 't1');
      void scheduleDecision(h, h.parent.agentPlan);
      await Promise.resolve();
      const item = h.emitAttention.mock.calls.at(-1)?.[0] as { steps: string[]; prompt: string };
      expect(item.steps).toEqual(['Add JIRA sync']);
      expect(item.prompt).toContain('2 already on this card');
    });

    /**
     * The failure mode that reads EXACTLY like the original bug: approval resolves, the card
     * flips to `in-progress` and nothing appears. It has to say so instead.
     */
    it('adds nothing and does no hand-over when every step is a duplicate', async () => {
      const h = setup(finished);
      h.parent.agentPlan = '## Reproduce it\nx\n\n## Fix it\ny';
      h.parent.status = 'pending';
      await approve(h, h.parent.agentPlan);
      expect(h.added).toEqual([]);
      // Released from the `waiting-input` the approval item borrowed, back to the status the
      // human left it in — not left wearing a "wants you" ring over an answered item.
      expect(h.parent.status).toBe('pending');
      expect(h.comments.some((c) => c.includes('no steps this card does not already have'))).toBe(
        true,
      );
    });

    it('caps on the card’s total, not on the round', async () => {
      const many = Array.from({ length: MAX_PLAN_STEPS - 1 }, (_, i) => ({
        id: `s${i}`,
        title: `Old ${i + 1}`,
        status: 'done' as const,
      }));
      const h = setup(many);
      h.parent.agentPlan = '## New one\na\n\n## New two\nb\n\n## New three\nc';
      await approve(h, h.parent.agentPlan);
      expect(h.added.map((s) => s.title)).toEqual(['New one']);
    });
  });

  it('raises the plan for approval even under bypassPermissions', async () => {
    // "Never ask me to approve tools" is not "silently discard the plan": `capturePlan` used
    // to store the markdown and the bypass shortcut then allowed the call with nothing
    // raised, leaving a full-auto card unable to gain a single step.
    const { scheduler, emitAttention, seedRun } = setup([]);
    seedRun('r0', 't1');
    (scheduler as unknown as { runs: Map<string, { permissionMode?: string }> }).runs.get(
      'r0',
    )!.permissionMode = 'bypassPermissions';
    let released = false;
    void scheduler
      .decidePermission({
        runId: 'r0',
        toolName: 'ExitPlanMode',
        input: { plan: '## Reproduce it\nfirst\n\n## Fix it\nsecond' },
      } as never)
      .then(() => {
        released = true;
      });
    await Promise.resolve();
    expect(released).toBe(false);
    expect(emitAttention.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'plan-approval' });
  });

  it('raises the plan from the event stream when the gate never saw the tool', async () => {
    // The observational fallback used to capture the markdown and raise nothing, so an
    // ungated run's plan landed where no step could ever come of it.
    const { emitAttention, seedRun, fire, parent } = setup([]);
    seedRun('r0', 't1');
    fire('r0', {
      kind: 'tool-use',
      name: 'ExitPlanMode',
      id: 'x',
      input: { plan: '## Reproduce it\nfirst\n\n## Fix it\nsecond' },
    });
    await Promise.resolve();
    expect(parent.agentPlan).toContain('## Fix it');
    const raised = emitAttention.mock.calls.filter(
      (c) => (c[0] as { kind: string }).kind === 'plan-approval',
    );
    expect(raised).toHaveLength(1);
    expect((raised[0][0] as { steps: string[] }).steps).toEqual(['Reproduce it', 'Fix it']);
  });

  it('does not double-raise when the gate already holds the plan', async () => {
    const { scheduler, emitAttention, seedRun, fire } = setup([]);
    seedRun('r0', 't1');
    const plan = '## Reproduce it\nfirst\n\n## Fix it\nsecond';
    void scheduler.decidePermission({
      runId: 'r0',
      toolName: 'ExitPlanMode',
      input: { plan },
    } as never);
    await Promise.resolve();
    fire('r0', { kind: 'tool-use', name: 'ExitPlanMode', id: 'x', input: { plan } });
    await Promise.resolve();
    expect(
      emitAttention.mock.calls.filter((c) => (c[0] as { kind: string }).kind === 'plan-approval'),
    ).toHaveLength(1);
  });

  /**
   * The other order — the one that produced two Approve buttons for one plan. The test above
   * covers gate-first (the fallback stands down); this covers event-first, where the gate has
   * to adopt what the fallback already raised. Neither path can claim to be "the" raiser,
   * because nothing orders the CLI's `tool-use` event against its permission request.
   */
  describe('when the event stream raised the plan first', () => {
    const plan = '## Reproduce it\nfirst\n\n## Fix it\nsecond';

    it('adopts the plan the event stream already raised', async () => {
      const { scheduler, emitAttention, seedRun, fire } = setup([]);
      seedRun('r0', 't1');
      fire('r0', { kind: 'tool-use', name: 'ExitPlanMode', id: 'x', input: { plan } });
      await Promise.resolve();

      let decision: { behavior: string; message?: string } | undefined;
      void scheduler
        .decidePermission({ runId: 'r0', toolName: 'ExitPlanMode', input: { plan } } as never)
        .then((d) => {
          decision = d as { behavior: string; message?: string };
        });
      await Promise.resolve();

      const raised = emitAttention.mock.calls.filter(
        (c) => (c[0] as { kind: string }).kind === 'plan-approval',
      );
      expect(raised).toHaveLength(1);

      // Answering the single item releases the held ExitPlanMode. Before the fix the gate's
      // rival item still held it, so the plan came back for a second decision.
      const item = raised[0][0] as { id: string };
      scheduler.answerAttention(item.id, { decision: 'deny', note: 'Split the migration out.' });
      await Promise.resolve();
      expect(decision).toEqual({ behavior: 'deny', message: 'Split the migration out.' });
    });

    /**
     * `describeEmptyOutcome` grades a plan-mode run on `run.planPresented`, so a run that
     * loses the flag is reported as having achieved nothing. The raiser sets it and so does
     * the adopt branch; clearing it between the two is what isolates the adopt branch's own
     * line, which is otherwise invisible from outside.
     */
    it('keeps `planPresented` on the adopt path', async () => {
      const { scheduler, seedRun, fire } = setup([]);
      seedRun('r0', 't1');
      const run = (
        scheduler as unknown as { runs: Map<string, { planPresented?: boolean }> }
      ).runs.get('r0')!;

      fire('r0', { kind: 'tool-use', name: 'ExitPlanMode', id: 'x', input: { plan } });
      await Promise.resolve();
      expect(run.planPresented).toBe(true);

      run.planPresented = false;
      void scheduler.decidePermission({
        runId: 'r0',
        toolName: 'ExitPlanMode',
        input: { plan },
      } as never);
      await Promise.resolve();
      expect(run.planPresented).toBe(true);
    });
  });
});

describe('Scheduler.replanCard (Phase 18)', () => {
  /**
   * A delegated card with a FINISHED chain — the state the bug report is about: the steps
   * are done, the human asks for more work, and nothing they can type produces any.
   */
  function setupReplan(
    opts: { card?: Partial<Task>; steps?: Array<Partial<Task>>; liveRun?: boolean } = {},
  ) {
    const agentProject = {
      id: 'agent-1',
      name: 'repo',
      path: 'C:/repo',
      planPath: 'C:/repo/plan.md',
      defaultModel: 'sonnet',
      defaultPermissionMode: 'bypassPermissions',
      kind: 'agent',
    } as unknown as Project;
    const card = {
      id: 'c1',
      projectId: 'personal',
      phase: 'JIRA',
      title: 'Ship the board',
      status: 'in-progress',
      sessionId: 's-old',
      order: 0,
      source: 'jira',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      parentTaskId: null,
      agentProjectId: 'agent-1',
      agentMode: 'bypassPermissions',
      ...opts.card,
    } as unknown as Task;
    const steps = (opts.steps ?? [{ title: 'Scaffold it' }, { title: 'Wire it' }]).map(
      (s, i) =>
        ({
          id: `s${i + 1}`,
          projectId: 'personal',
          phase: 'JIRA',
          title: `Step ${i + 1}`,
          status: 'done',
          sessionId: null,
          order: i,
          source: 'adhoc',
          dependsOn: [],
          isContract: false,
          isScaffold: false,
          parentTaskId: 'c1',
          planRound: 1,
          ...s,
        }) as unknown as Task,
    );
    const all = [card, ...steps];
    const chats: string[] = [];
    const store = {
      getTask: (id: string) => all.find((t) => t.id === id),
      getTasks: () => all,
      getProject: (id: string) => (id === 'agent-1' ? agentProject : undefined),
      getSubtasks: (parentId: string) => steps.filter((s) => s.parentTaskId === parentId),
      getTaskActivity: () => [],
      addChatMessage: (_p: string, _t: string, body: string) => {
        chats.push(body);
        return undefined;
      },
      updateTask: (id: string, patch: Partial<Task>) => {
        const t = all.find((x) => x.id === id);
        if (t) Object.assign(t, patch);
        return t;
      },
      appendTaskEvent: vi.fn(),
      appendTokenUsage: vi.fn(),
      getSettings: () => ({ maxAutoRetries: 0, limitJitterMs: 0, concurrency: 1 }),
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const start = vi.fn((_req: unknown, o: { runId?: string }) => ({ runId: o?.runId ?? 'r-new' }));
    const stop = vi.fn();
    const sessions = { start, stop, send: vi.fn() } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    if (opts.liveRun) {
      (scheduler as unknown as { runs: Map<string, unknown> }).runs.set('r-live', {
        taskId: 'c1',
        projectId: 'agent-1',
        runId: 'r-live',
        settled: false,
      });
      (scheduler as unknown as { inFlight: Set<string> }).inFlight.add('c1');
    }
    const exit = (runId: string): void =>
      (scheduler as unknown as { onRunEvent: (r: string, e: unknown) => void }).onRunEvent(runId, {
        kind: 'exited',
        code: 0,
      });
    return { scheduler, card, steps, start, stop, chats, exit };
  }

  it('runs the turn in PLAN mode, whatever the card is assigned', () => {
    // The heart of the bug: a chat resume inherits `bypassPermissions`, `buildClaudeArgs`
    // rewrites that to `default`, and the agent then has no ExitPlanMode tool at all — so it
    // writes its plan as prose and nothing can ever become a step.
    const h = setupReplan();
    const result = h.scheduler.replanCard('c1', 'Add the JIRA sync');
    expect(result.status).toBe('resumed');
    expect(h.start).toHaveBeenCalledTimes(1);
    const request = h.start.mock.calls[0][0] as { permissionMode: string; prompt: string };
    expect(request.permissionMode).toBe('plan');
    expect(request.prompt).toContain('ExitPlanMode');
  });

  it('tells the agent which steps are already on the card', () => {
    const h = setupReplan({ steps: [{ title: 'Scaffold the store' }, { title: 'Wire the IPC' }] });
    h.scheduler.replanCard('c1', 'Now add the sync');
    const { prompt } = h.start.mock.calls[0][0] as { prompt: string };
    expect(prompt).toContain('Scaffold the store');
    expect(prompt).toContain('Wire the IPC');
    expect(prompt).toContain('Now add the sync');
    // The bound is a runaway guard, not a budget: with 198 slots left, quoting the number
    // would read as permission to write a hundred more steps.
    expect(prompt).not.toMatch(/step\(s\)/);
  });

  it('quotes the room left only once the card is genuinely close to the bound', () => {
    const h = setupReplan({
      steps: Array.from({ length: MAX_PLAN_STEPS - 3 }, (_, i) => ({ title: `Old ${i + 1}` })),
    });
    h.scheduler.replanCard('c1');
    const { prompt } = h.start.mock.calls[0][0] as { prompt: string };
    expect(prompt).toContain('At most 3 step(s)');
  });

  it('does NOT write the plan mode back to the card, so later runs are unaffected', () => {
    const h = setupReplan();
    h.scheduler.replanCard('c1');
    expect(h.card.agentMode).toBe('bypassPermissions');
  });

  it('files the human’s brief on the timeline before anything starts', () => {
    const h = setupReplan();
    h.scheduler.replanCard('c1', 'Add the JIRA sync');
    expect(h.chats).toEqual(['Add the JIRA sync']);
  });

  it('stops a live turn first and waits for its process to exit', () => {
    // The card's review session (seeded when the chain finished) is the very conversation
    // the human is typing into. Both runs share the card's worktree, so the planner must not
    // resume into it while the old process is still shutting down.
    const h = setupReplan({ liveRun: true });
    h.scheduler.replanCard('c1', 'more work');
    expect(h.stop).toHaveBeenCalledWith('r-live');
    expect(h.start).not.toHaveBeenCalled();
    h.exit('r-live');
    expect(h.start).toHaveBeenCalledTimes(1);
    expect((h.start.mock.calls[0][0] as { permissionMode: string }).permissionMode).toBe('plan');
  });

  it('refuses a step: a step cannot own a plan', () => {
    const h = setupReplan();
    expect(h.scheduler.replanCard('s1')).toMatchObject({ reason: 'not-a-card' });
  });

  it('refuses while the chain is still running', () => {
    const h = setupReplan({
      steps: [
        { title: 'a', status: 'done' },
        { title: 'b', status: 'pending' },
      ],
    });
    expect(h.scheduler.replanCard('c1')).toMatchObject({ reason: 'chain-busy' });
  });

  it('refuses a card with no agent, and an unknown card', () => {
    const h = setupReplan({ card: { agentProjectId: null } });
    expect(h.scheduler.replanCard('c1')).toMatchObject({ reason: 'never-ran' });
    expect(h.scheduler.replanCard('nope')).toMatchObject({ reason: 'unknown-task' });
  });

  it('refuses once the card is full', () => {
    const h = setupReplan({
      steps: Array.from({ length: MAX_PLAN_STEPS }, (_, i) => ({
        id: `s${i}`,
        title: `Step ${i}`,
      })),
    });
    expect(h.scheduler.replanCard('c1')).toMatchObject({ reason: 'chain-full' });
  });
});

describe('Scheduler.chatWithAgent (Phase 12)', () => {
  /**
   * A delegated card, optionally with steps, and optionally with a live run + a parked
   * inbox item — the four situations a typed message can land in.
   */
  function setupChat(
    opts: {
      card?: Partial<Task>;
      steps?: Array<Partial<Task>>;
      /** Seed a live run for this task id. */
      liveFor?: string;
      /** Seed an inbox item on the live run. */
      parked?: 'question' | 'permission' | 'plan-approval' | 'agent-question';
      /** What the CLI's own `AskUserQuestion` asked, for an `agent-question` item. */
      questions?: Array<{ header: string; question: string; multiSelect: boolean; options: [] }>;
    } = {},
  ) {
    const card = {
      id: 'c1',
      projectId: 'personal',
      phase: 'JIRA',
      title: 'Card',
      status: 'running',
      sessionId: 'sess-1',
      order: 0,
      source: 'jira',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      agentProjectId: 'agent-p',
      ...opts.card,
    } as Task;
    const steps = (opts.steps ?? []).map(
      (s, i) =>
        ({
          id: `s${i + 1}`,
          projectId: 'personal',
          phase: 'JIRA',
          title: `Step ${i + 1}`,
          status: 'pending',
          sessionId: null,
          order: i + 1,
          source: 'adhoc',
          dependsOn: [],
          isContract: false,
          isScaffold: false,
          parentTaskId: 'c1',
          agentProjectId: 'agent-p',
          ...s,
        }) as Task,
    );
    const all = [card, ...steps];
    const chats: Array<{ taskId: string; body: string }> = [];
    const comments: Array<{ taskId: string; body: string }> = [];
    const agentProject = {
      id: 'agent-p',
      name: 'Agent repo',
      path: '/repo',
      planPath: '/repo/PLAN.md',
      kind: 'agent',
      concurrency: 1,
      useWorktrees: false,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'default',
    } as unknown as Project;
    const store = {
      getTask: (id: string) => all.find((t) => t.id === id),
      getTasks: () => all,
      getProject: (id: string) => (id === 'agent-p' ? agentProject : undefined),
      getSubtasks: (parentId: string) => steps.filter((s) => s.parentTaskId === parentId),
      updateTask: (id: string, patch: Partial<Task>) => {
        const t = all.find((x) => x.id === id);
        if (t) Object.assign(t, patch);
        return t;
      },
      addChatMessage: (_projectId: string, taskId: string, body: string) => {
        chats.push({ taskId, body });
        return undefined;
      },
      // A first message to an assigned-but-not-started card is filed as a COMMENT, because
      // there is no session to resume and the fresh run's prompt is built from the timeline.
      addComment: (_projectId: string, taskId: string, body: string) => {
        comments.push({ taskId, body });
        return undefined;
      },
      getSettings: () => ({ limitJitterMs: 0, concurrency: 1, maxAutoRetries: 0 }),
      saveLimitGate: () => undefined,
      // Read by `buildPrompt` when a staged card starts from its timeline rather than
      // resuming a session.
      getTaskActivity: () => [],
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const send = vi.fn();
    const start = vi.fn();
    const sessions = { start, stop: vi.fn(), send } as unknown as SessionManager;
    const resolved = vi.fn();
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), resolved, vi.fn());
    if (opts.liveFor) {
      (scheduler as unknown as { runs: Map<string, unknown> }).runs.set('r1', {
        taskId: opts.liveFor,
        projectId: 'agent-p',
        runId: 'r1',
        settled: false,
      });
    }
    if (opts.parked) {
      (scheduler as unknown as { attention: Map<string, unknown> }).attention.set('i1', {
        id: 'i1',
        runId: 'r1',
        taskId: opts.liveFor,
        projectId: 'agent-p',
        kind: opts.parked,
        title: 'parked',
        detail: '',
        createdAt: 0,
        ...(opts.questions ? { questions: opts.questions } : {}),
      });
    }
    return { scheduler, card, steps, send, start, chats, comments, resolved };
  }

  it('sends into the live session and records the message on the timeline', () => {
    const { scheduler, send, chats } = setupChat({ liveFor: 'c1' });
    const result = scheduler.chatWithAgent('c1', '  use the cache  ');
    expect(result).toEqual({ status: 'sent', taskId: 'c1', runId: 'r1' });
    expect(send).toHaveBeenCalledWith('r1', 'use the cache');
    // Trimmed, and recorded against the task that received it.
    expect(chats).toEqual([{ taskId: 'c1', body: 'use the cache' }]);
  });

  it('talks to the running STEP of a card, not the card itself', () => {
    const { scheduler, send, chats } = setupChat({
      card: { status: 'in-progress' },
      steps: [{ status: 'done' }, { status: 'running', sessionId: 'sess-2' }],
      liveFor: 's2',
    });
    const result = scheduler.chatWithAgent('c1', 'skip the migration');
    expect(result).toEqual({ status: 'sent', taskId: 's2', runId: 'r1' });
    expect(send).toHaveBeenCalledWith('r1', 'skip the migration');
    // The step heard it, so the step's timeline is where it belongs.
    expect(chats).toEqual([{ taskId: 's2', body: 'skip the migration' }]);
  });

  it('answers a parked question instead of stacking a second turn behind it', () => {
    const { scheduler, card, send, resolved } = setupChat({
      card: { status: 'waiting-input' },
      liveFor: 'c1',
      parked: 'question',
    });
    const result = scheduler.chatWithAgent('c1', 'use postgres');
    expect(result.status).toBe('sent');
    expect(send).toHaveBeenCalledWith('r1', 'use postgres');
    // The inbox item cleared and the task is live again — not left parked on a
    // question the human has in fact just answered.
    expect(resolved).toHaveBeenCalledWith('i1');
    expect(card.status).toBe('running');
  });

  it('answers the CLI’s own AskUserQuestion with what the human typed', () => {
    // The composer stays open under an `agent-question` and has always promised the message
    // would be delivered; before this it was pushed into the input stream behind a held tool
    // that nobody had answered, so it sat there unread.
    const { scheduler, card, send, resolved } = setupChat({
      card: { status: 'waiting-input' },
      liveFor: 'c1',
      parked: 'agent-question',
      questions: [{ header: 'DB', question: 'Which database?', multiSelect: false, options: [] }],
    });
    const result = scheduler.chatWithAgent('c1', 'use postgres');
    expect(result).toEqual({ status: 'sent', taskId: 'c1', runId: 'r1' });
    expect(resolved).toHaveBeenCalledWith('i1');
    expect(card.status).toBe('running');

    // Unlike the sentinel `question` above, the agent is blocked on a TOOL: it gets the
    // formatted answer, which names the question it answers and tells the model to treat
    // it as the tool's result — raw prose would read as an unprompted aside.
    const [runId, message] = send.mock.calls[0] as [string, string];
    expect(runId).toBe('r1');
    expect(message).not.toBe('use postgres');
    expect(message).toContain('do NOT ask the same question again');
    expect(message).toContain('1. Which database?');
    expect(message).toContain('→ use postgres');
  });

  it('spends a typed answer on the first question and leaves the rest unanswered', () => {
    // Accepted: one line of prose cannot answer three questions. The structured form is
    // the good path — this is the fallback, and it must not silently invent the others.
    const { scheduler, send } = setupChat({
      card: { status: 'waiting-input' },
      liveFor: 'c1',
      parked: 'agent-question',
      questions: [
        { header: 'DB', question: 'Which database?', multiSelect: false, options: [] },
        { header: 'Cache', question: 'Which cache?', multiSelect: false, options: [] },
      ],
    });
    expect(scheduler.chatWithAgent('c1', 'use postgres').status).toBe('sent');
    const message = send.mock.calls[0][1] as string;
    expect(message).toContain('1. Which database?\n   → use postgres');
    expect(message).toContain('2. Which cache?\n   → (no preference given)');
  });

  it('refuses while a permission request or a plan approval holds a tool', () => {
    for (const parked of ['permission', 'plan-approval'] as const) {
      const { scheduler, send, chats } = setupChat({
        card: { status: 'waiting-input' },
        liveFor: 'c1',
        parked,
      });
      expect(scheduler.chatWithAgent('c1', 'go ahead')).toEqual({
        status: 'refused',
        taskId: 'c1',
        reason: 'awaiting-decision',
      });
      expect(send).not.toHaveBeenCalled();
      expect(chats).toEqual([]); // nothing said, nothing recorded
    }
  });

  it('resumes an idle card by session id, with the message as the prompt', () => {
    const { scheduler, start, chats } = setupChat({ card: { status: 'in-progress' } });
    const result = scheduler.chatWithAgent('c1', '  still there?  ');
    expect(result.status).toBe('resumed');
    expect(result).toMatchObject({ taskId: 'c1' });
    expect(chats).toEqual([{ taskId: 'c1', body: 'still there?' }]);
    // The user's words are the prompt — NOT the resume nudge — and the conversation is
    // continued rather than started over.
    const [request, opts] = start.mock.calls[0];
    expect(request.prompt).toBe('still there?');
    expect(opts.resumeSessionId).toBe('sess-1');
    // A real run: reserved, counted, and reported to the Board like any other.
    expect(scheduler.activeRuns()).toEqual([
      { taskId: 'c1', runId: (result as { runId: string }).runId },
    ]);
  });

  it('resumes the step you selected, not its parent', () => {
    const { scheduler, start, chats } = setupChat({
      card: { status: 'in-progress' },
      steps: [
        { status: 'done', sessionId: 'sess-a' },
        { status: 'done', sessionId: 'sess-b' },
      ],
    });
    expect(scheduler.chatWithAgent('s2', 'why did you drop the index?')).toMatchObject({
      status: 'resumed',
      taskId: 's2',
    });
    expect(start.mock.calls[0][1].resumeSessionId).toBe('sess-b');
    expect(chats).toEqual([{ taskId: 's2', body: 'why did you drop the index?' }]);
  });

  it('resumes the card once its chain has finished', () => {
    const { scheduler, start } = setupChat({
      card: { status: 'in-progress' },
      steps: [{ status: 'done' }, { status: 'cancelled' }],
    });
    expect(scheduler.chatWithAgent('c1', 'how did that go?')).toMatchObject({ status: 'resumed' });
    expect(start.mock.calls[0][1].resumeSessionId).toBe('sess-1');
  });

  it('refuses to resume a card mid-chain — its steps hold the conversation', () => {
    for (const status of ['pending', 'failed', 'blocked-by-limit'] as const) {
      const { scheduler, start, chats } = setupChat({
        card: { status: 'in-progress' },
        steps: [{ status: 'done' }, { status }],
      });
      expect(scheduler.chatWithAgent('c1', 'what now?')).toEqual({
        status: 'refused',
        taskId: 'c1',
        reason: 'chain-busy',
      });
      expect(start).not.toHaveBeenCalled();
      expect(chats).toEqual([]);
    }
  });

  it('leaves a queued fix note for the retry it was written for', () => {
    const { scheduler, start } = setupChat({ card: { status: 'failed' } });
    const fixNotes = (scheduler as unknown as { fixNotes: Map<string, string> }).fixNotes;
    fixNotes.set('c1', 'the build broke');
    scheduler.chatWithAgent('c1', 'what failed?');
    // The chat prompt wins, and the note is still there for the real retry.
    expect(start.mock.calls[0][0].prompt).toBe('what failed?');
    expect(fixNotes.get('c1')).toBe('the build broke');
  });

  it('starts an assigned-but-not-started card on the first message (Phase 17)', () => {
    const { scheduler, start, comments, chats } = setupChat({
      card: { status: 'pending', sessionId: null },
    });
    expect(scheduler.chatWithAgent('c1', 'hello?')).toMatchObject({
      status: 'resumed',
      taskId: 'c1',
    });
    expect(start).toHaveBeenCalled();
    // Filed as a comment, not a chat line: there is no session to resume, so the message
    // has to reach the agent through the brief its FIRST run is built from.
    expect(comments).toEqual([{ taskId: 'c1', body: 'hello?' }]);
    expect(chats).toEqual([]);
  });

  it('refuses with never-ran when the card has no session AND no agent to start', () => {
    const { scheduler, start } = setupChat({
      card: { status: 'pending', sessionId: null, agentProjectId: null },
    });
    expect(scheduler.chatWithAgent('c1', 'hello?')).toEqual({
      status: 'refused',
      taskId: 'c1',
      reason: 'never-ran',
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('refuses a limit-parked card with the limit reason, not a resume', () => {
    const { scheduler, start } = setupChat({ card: { status: 'blocked-by-limit' } });
    expect(scheduler.chatWithAgent('c1', 'any progress?')).toEqual({
      status: 'refused',
      taskId: 'c1',
      reason: 'limit',
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('refuses while the usage-limit gate is up — a resume would be killed at once', () => {
    const { scheduler, start } = setupChat({ card: { status: 'in-progress' } });
    const gate = (
      scheduler as unknown as {
        limitGate: { engage: (s: unknown, ids: string[]) => void; dispose: () => void };
      }
    ).limitGate;
    gate.engage({ status: 'rejected', rateLimitType: 'rolling', resetsAt: null }, []);
    expect(scheduler.chatWithAgent('c1', 'are you back?')).toEqual({
      status: 'refused',
      taskId: 'c1',
      reason: 'limit',
    });
    expect(start).not.toHaveBeenCalled();
    gate.dispose(); // don't leave the reset timer armed for the rest of the suite
  });

  it('refuses an empty message and an unknown task', () => {
    const { scheduler, send } = setupChat({ liveFor: 'c1' });
    expect(scheduler.chatWithAgent('c1', '   ')).toEqual({
      status: 'refused',
      taskId: 'c1',
      reason: 'empty-message',
    });
    expect(scheduler.chatWithAgent('nope', 'hi')).toEqual({
      status: 'refused',
      taskId: 'nope',
      reason: 'unknown-task',
    });
    expect(send).not.toHaveBeenCalled();
  });
});

/**
 * The two ways the CLI reports "success" about a run that produced nothing (Phase 18).
 * The shapes below are taken verbatim from the runs that exposed this: two cards that
 * spent ~$1.70 and 50 tool calls each and were filed as wins.
 */
describe('describeEmptyOutcome', () => {
  const zero = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const spent = { inputTokens: 11, outputTokens: 3680, cacheCreationTokens: 0, cacheReadTokens: 0 };

  const healthy = {
    resultText: 'Done — committed on the branch.',
    stopReason: 'end_turn',
    terminalReason: 'completed',
    usage: spent,
  };

  it('passes a real outcome through', () => {
    expect(describeEmptyOutcome('bypassPermissions', undefined, healthy)).toBeNull();
  });

  // The chat resume that looked like it had worked: 102ms, no reasons, nothing billed.
  it('catches a session that never ran a turn', () => {
    const dead = { resultText: '', stopReason: null, terminalReason: null, usage: zero };
    expect(describeEmptyOutcome('manual', undefined, dead)).toMatch(/without running a turn/);
  });

  // An omission is not evidence. The CLI leaves `usage` out in some shapes, and reading
  // that as "nothing happened" would misfile perfectly good runs as dead.
  it('does NOT call a run dead merely because usage was not reported', () => {
    const noUsage = { resultText: '', stopReason: null, terminalReason: null, usage: null };
    expect(describeEmptyOutcome('manual', undefined, noUsage)).toBeNull();
  });

  it('leaves a quiet but real turn alone', () => {
    const quiet = { resultText: '', stopReason: 'end_turn', terminalReason: null, usage: spent };
    expect(describeEmptyOutcome('manual', undefined, quiet)).toBeNull();
  });

  // THE bug: 50 tool calls, end_turn/completed, and no plan — because the agent stopped to
  // wait for background subagents that headless mode will never deliver.
  it('fails a plan-mode run that never presented a plan', () => {
    const reason = describeEmptyOutcome('plan', undefined, {
      resultText: "I'll continue once those return.",
      stopReason: 'end_turn',
      terminalReason: 'completed',
      usage: spent,
    });
    expect(reason).toMatch(/without presenting a plan/);
    expect(reason).toMatch(/background subagents/); // says what to do about it
  });

  it('accepts a plan-mode run that did present one', () => {
    expect(describeEmptyOutcome('plan', true, healthy)).toBeNull();
  });

  // The rule is scoped to plan mode: an ordinary run owes no plan.
  it('does not demand a plan from a run that was not planning', () => {
    expect(describeEmptyOutcome('bypassPermissions', undefined, healthy)).toBeNull();
    expect(describeEmptyOutcome(undefined, undefined, healthy)).toBeNull();
  });

  // A dead session in plan mode gets the more precise of the two messages.
  it('prefers "never ran a turn" over the plan rule', () => {
    const dead = { resultText: '', stopReason: null, terminalReason: null, usage: zero };
    expect(describeEmptyOutcome('plan', undefined, dead)).toMatch(/without running a turn/);
  });

  // A card assigned `plan` hands that mode to EVERY run it starts, including conversations.
  // A conversation ends with an answer; grading it by the planning rule failed it whatever
  // it said. A real card's post-chain review was parked this way — twice — while its work
  // sat finished and unmerged.
  it('does not demand a plan from a conversation that merely inherited plan mode', () => {
    const review = {
      resultText: 'Reviewed the branch: 8 commits, tests green, I would merge it.',
      stopReason: 'end_turn',
      terminalReason: 'completed',
      usage: spent,
    };
    expect(describeEmptyOutcome('plan', undefined, review, false)).toBeNull();
  });

  // ...but the run whose JOB is a plan is still held to it, in the same mode.
  it('still fails a planning run that owed a plan', () => {
    const stalled = {
      resultText: "I'll continue once those return.",
      stopReason: 'end_turn',
      terminalReason: 'completed',
      usage: spent,
    };
    expect(describeEmptyOutcome('plan', undefined, stalled, true)).toMatch(/presenting a plan/);
    // Omitted means "a plan was expected" — the safe default for an ordinary work run.
    expect(describeEmptyOutcome('plan', undefined, stalled)).toMatch(/presenting a plan/);
  });
});

/**
 * "The limit lifted and the next card in the chain never started."
 *
 * A card released while a usage limit is up is the one thing the gate cannot park: nothing
 * is running on it, so there is nothing to park. It sits `pending` with its predecessor
 * long landed, and until this the only thing that ever asked again was the next boot. So
 * the resume ends by re-asking the chain — LAST, after everything the gate parked has
 * re-reserved its slot and every queue has been pumped, which is what makes a second start
 * impossible rather than merely unlikely.
 */
describe('Scheduler — a lifting usage limit restarts a card chain', () => {
  const limited = {
    kind: 'rate-limit' as const,
    status: 'rejected',
    rateLimitType: 'five_hour',
    resetsAt: null,
  };

  /** Two cards, `b` chained to start after `a` merges, and a limit already in force. */
  function setup() {
    const project = {
      id: 'agent-1',
      name: 'Checkout service',
      path: 'C:/repos/checkout',
      planPath: '',
      kind: 'agent',
      concurrency: 1,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'acceptEdits',
    } as unknown as Project;
    const card = (id: string, order: number, extra: Partial<Task> = {}): Task =>
      ({
        id,
        projectId: 'agent-1',
        phase: '',
        title: id === 'a' ? 'Extract the parser' : 'Rewire the importer',
        status: 'pending',
        sessionId: null,
        order,
        source: 'adhoc',
        dependsOn: [],
        isContract: false,
        isScaffold: false,
        agentProjectId: 'agent-1',
        parentTaskId: null,
        ...extra,
      }) as unknown as Task;
    // `a` has finished writing and is waiting for review; `b` waits for it to MERGE.
    const a = card('a', 0, { status: 'in-review', sessionId: 's-a', agentBranch: 'orch/a' });
    const b = card('b', 1);
    const byId = new Map([a, b].map((task) => [task.id, task]));
    const links = [
      { id: 'l1', fromTaskId: 'a', toTaskId: 'b', gate: 'after-merge' as const, createdAt: 1 },
    ];
    const comments: string[] = [];
    const store = {
      getTask: (id: string) => byId.get(id),
      getProject: (id: string) => (id === 'agent-1' ? project : undefined),
      listProjects: () => [project],
      getTasks: () => [a, b],
      getSubtasks: () => [],
      getTaskActivity: () => [],
      addComment: (_p: string, _t: string, body: string) => comments.push(body),
      listTaskLinks: () => links,
      updateTask: (id: string, patch: Partial<Task>) => {
        const task = byId.get(id);
        if (task) Object.assign(task, patch);
        return task;
      },
      appendTaskEvent: vi.fn(),
      appendTokenUsage: vi.fn(),
      getSettings: () => ({ maxAutoRetries: 0, limitJitterMs: 0, concurrency: 1 }),
      saveLimitGate: () => undefined,
      loadLimitGate: () => null,
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const start = vi.fn((_req: unknown, o: { runId?: string }) => ({ runId: o?.runId ?? 'r-new' }));
    const sessions = { start, stop: vi.fn(), send: vi.fn() } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    // A limit is in force account-wide — some other run hit the wall — with nothing parked:
    // neither of these cards was running when it did.
    (
      scheduler as unknown as { limitGate: { engage: (s: unknown, ids: string[]) => void } }
    ).limitGate.engage(limited, []);
    return { scheduler, start, a, b, comments };
  }

  /** The task behind every run the scheduler has reserved — who actually got started. */
  const runTaskIds = (scheduler: Scheduler): string[] =>
    [...(scheduler as unknown as { runs: Map<string, { taskId: string }> }).runs.values()].map(
      (run) => run.taskId,
    );

  it('records the landing under the limit, and starts nothing', () => {
    const { scheduler, start, a, comments } = setup();
    scheduler.noteWorkLanded('a');
    // The landing is the durable half and is written whatever the limit says — it is what
    // the re-ask will read once the gate lifts.
    expect(a.landedAt).toEqual(expect.any(Number));
    expect(start).not.toHaveBeenCalled();
    expect(comments).toEqual([]);
  });

  it('starts the successor exactly once when the limit lifts', () => {
    const { scheduler, start, comments } = setup();
    scheduler.noteWorkLanded('a');
    scheduler.resumeLimitNow(); // the reset, or the banner's "Resume now"

    expect(start).toHaveBeenCalledTimes(1);
    expect(runTaskIds(scheduler)).toEqual(['b']);
    // …and the card says what started it, rather than "started automatically" with no
    // subject, which is the entry that sends a human hunting through other cards' logs.
    expect(comments.some((body) => body.includes('usage limit lifted'))).toBe(true);
  });

  it('does not start again a card the pump has already taken', () => {
    const { scheduler, start } = setup();
    scheduler.noteWorkLanded('a');
    scheduler.start('agent-1'); // the project's queue is running; the limit holds its pump
    expect(start).not.toHaveBeenCalled();

    scheduler.resumeLimitNow();
    // `b` is both the queue's next pending task and a released chain card. The re-ask runs
    // after the pump, by which time `b` is in flight — so it is started once, not twice.
    expect(start).toHaveBeenCalledTimes(1);
    expect(runTaskIds(scheduler)).toEqual(['b']);
  });
});

describe('Scheduler — auto-release after a merge', () => {
  /**
   * A delegated card, in worktree mode, whose branch is about to merge.
   *
   * The project path is a REAL temp directory so the `RELEASE.md` check is the real
   * `existsSync` the engine runs — the whole feature turns on that file being there, and
   * a stubbed answer would prove nothing about the only question being asked.
   */
  function setup(opts: {
    /** Write a RELEASE.md into the repo. */
    releaseDoc?: boolean;
    /** The project's preference. */
    projectAutoRelease?: boolean;
    /** The card's override, or undefined for "it has not ruled". */
    cardAutoRelease?: boolean | null;
  }) {
    const path = mkdtempSync(join(tmpdir(), 'orch-release-'));
    if (opts.releaseDoc) writeFileSync(join(path, 'RELEASE.md'), '# How to release\n');
    const project = {
      id: 'agent-1',
      name: 'Checkout service',
      path,
      planPath: '',
      kind: 'agent',
      concurrency: 1,
      useWorktrees: true,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'acceptEdits',
      instructions: '',
      autoRelease: opts.projectAutoRelease ?? false,
    } as unknown as Project;
    const card = {
      id: 't1',
      projectId: 'personal',
      phase: '',
      title: 'Fix the export dialog',
      status: 'in-progress',
      sessionId: 'sess-1',
      order: 0,
      source: 'jira',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      agentProjectId: 'agent-1',
      parentTaskId: null,
      autoRelease: opts.cardAutoRelease ?? null,
    } as unknown as Task;
    const comments: string[] = [];
    const store = {
      getTask: (id: string) => (id === 't1' ? card : undefined),
      getProject: (id: string) => (id === 'agent-1' ? project : undefined),
      listProjects: () => [project],
      getTasks: () => [card],
      getSubtasks: () => [],
      getTaskActivity: () => [],
      addComment: (_p: string, _t: string, body: string) => comments.push(body),
      listTaskLinks: () => [],
      updateTask: (id: string, patch: Partial<Task>) => {
        if (id === 't1') Object.assign(card, patch);
        return card;
      },
      appendTaskEvent: vi.fn(),
      appendTokenUsage: vi.fn(),
      getSettings: () => ({ maxAutoRetries: 0, limitJitterMs: 0, concurrency: 1 }),
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const worktrees = { prepare: vi.fn(), integrate: vi.fn(), cleanup: vi.fn() };
    const start = vi.fn((_req: unknown, o: { runId?: string }) => ({ runId: o?.runId ?? 'r-new' }));
    const sessions = { start, stop: vi.fn(), send: vi.fn() } as unknown as SessionManager;
    const scheduler = new Scheduler(
      store,
      sessions,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      worktrees as unknown as WorktreeManager,
    );
    /** The merge landing, exactly as `integrateWorktree` reports it. */
    const merge = (result: { status: 'merged'; refMoveOnly?: boolean } = { status: 'merged' }) =>
      (
        scheduler as unknown as {
          applyIntegrationResult: (p: Project, ctx: unknown, r: unknown) => void;
        }
      ).applyIntegrationResult(
        project,
        {
          taskId: 't1',
          runId: 'r1',
          branch: 'feat/export',
          base: 'development',
          worktree: 'C:/wt/t1',
        },
        result,
      );
    return { scheduler, card, comments, start, merge, path };
  }

  /** The prompt a started run was launched with. */
  const promptOf = (start: ReturnType<typeof vi.fn>): string =>
    (start.mock.calls[0]?.[0] as { prompt: string }).prompt;

  it('releases the card when the project prefers it and the repo says how', () => {
    const { start, merge, comments } = setup({ releaseDoc: true, projectAutoRelease: true });
    merge();
    expect(start).toHaveBeenCalledTimes(1);
    expect(promptOf(start)).toContain('RELEASE.md');
    expect(promptOf(start)).toContain('development');
    expect(comments.some((c) => c.includes('releasing it now'))).toBe(true);
  });

  it('says so, and runs nothing, when the repo has no RELEASE.md', () => {
    const { start, merge, comments } = setup({ projectAutoRelease: true });
    merge();
    expect(start).not.toHaveBeenCalled();
    expect(comments.some((c) => c.includes('no `RELEASE.md`'))).toBe(true);
  });

  it('does nothing at all when nobody asked for a release', () => {
    const { start, merge, comments } = setup({ releaseDoc: true });
    merge();
    expect(start).not.toHaveBeenCalled();
    expect(comments.some((c) => c.toLowerCase().includes('release'))).toBe(false);
  });

  it('lets a card opt out of a project that releases by default', () => {
    const { start, merge } = setup({
      releaseDoc: true,
      projectAutoRelease: true,
      cardAutoRelease: false,
    });
    merge();
    expect(start).not.toHaveBeenCalled();
  });

  it('lets a card opt IN on a project that does not release by default', () => {
    const { start, merge } = setup({ releaseDoc: true, cardAutoRelease: true });
    merge();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('starts a FRESH session — the card’s was recorded against a deleted worktree', () => {
    const { start, merge } = setup({ releaseDoc: true, projectAutoRelease: true });
    merge();
    expect((start.mock.calls[0]?.[1] as { resumeSessionId?: string }).resumeSessionId).toBe(
      undefined,
    );
  });

  it('warns the agent to check out base when the merge only moved the ref', () => {
    const { start, merge } = setup({ releaseDoc: true, projectAutoRelease: true });
    merge({ status: 'merged', refMoveOnly: true });
    expect(promptOf(start)).toMatch(/only moved the `development` ref/);
  });

  it('leaves the card where the human left it, and never marks the release a failure', () => {
    const { scheduler, card, merge, start } = setup({
      releaseDoc: true,
      projectAutoRelease: true,
    });
    merge();
    const runId = (start.mock.calls[0]?.[1] as { runId: string }).runId;
    const run = (scheduler as unknown as { runs: Map<string, unknown> }).runs.get(runId);
    (scheduler as unknown as { settle: (r: unknown, s: string, why?: string) => void }).settle(
      run,
      'failed',
      'the release blew up',
    );
    // Still In Progress — a release that failed says so on the timeline; it does not
    // move the card, retry the work, or park a failed task.
    expect(card.status).toBe('in-progress');
  });
});

/**
 * "I clicked Merge branch and nothing appeared."
 *
 * A merge is the one long job in the app that changes NOTHING while it runs: no session,
 * no status, no streamed line, and `task:integrate` resolves the moment the work is handed
 * to git rather than when it lands. So the engine has to say it is happening — that is the
 * whole of this set, and these tests pin the two ends nobody notices until they break: it
 * is raised before the git call, and it is given back on EVERY way out, refusals included.
 */
describe('Scheduler.integrateNow — saying that a merge is under way', () => {
  function setup() {
    const project = {
      id: 'agent-1',
      name: 'Checkout service',
      path: mkdtempSync(join(tmpdir(), 'orch-merging-')),
      planPath: '',
      kind: 'agent',
      concurrency: 1,
      useWorktrees: true,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'acceptEdits',
      instructions: '',
    } as unknown as Project;
    const card = {
      id: 't1',
      projectId: 'personal',
      phase: '',
      title: 'Fix the export dialog',
      status: 'in-progress',
      sessionId: 'sess-1',
      order: 0,
      source: 'jira',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      agentProjectId: 'agent-1',
      parentTaskId: null,
    } as unknown as Task;
    const store = {
      getTask: (id: string) => (id === 't1' ? card : undefined),
      getProject: (id: string) => (id === 'agent-1' ? project : undefined),
      listProjects: () => [project],
      getTasks: () => [card],
      getSubtasks: () => [],
      getTaskActivity: () => [],
      addComment: vi.fn(),
      listTaskLinks: () => [],
      updateTask: (id: string, patch: Partial<Task>) => {
        if (id === 't1') Object.assign(card, patch);
        return card;
      },
      appendTaskEvent: vi.fn(),
      appendTokenUsage: vi.fn(),
      getSettings: () => ({ maxAutoRetries: 0, limitJitterMs: 0, concurrency: 1 }),
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    // The merge is held open so the test can look at the world MID-MERGE, which is the
    // only moment any of this is about.
    let land = (): void => undefined;
    const integrate = vi.fn(
      () => new Promise((resolve) => (land = () => resolve({ status: 'merged' }))),
    );
    const worktrees = { prepare: vi.fn(), integrate, cleanup: vi.fn() };
    const sessions = { start: vi.fn(), stop: vi.fn(), send: vi.fn() } as unknown as SessionManager;
    const scheduler = new Scheduler(
      store,
      sessions,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      worktrees as unknown as WorktreeManager,
    );
    const pushes: string[][] = [];
    scheduler.setIntegratingNotifier((ids) => pushes.push(ids));
    // The offer the UI's Merge button consumes, as a finished run would have left it.
    (scheduler as unknown as { readyToIntegrate: Map<string, unknown> }).readyToIntegrate.set(
      't1',
      {
        projectId: 'agent-1',
        taskId: 't1',
        runId: 'r1',
        branch: 'feat/export',
        base: 'development',
        worktree: 'C:/wt/t1',
      },
    );
    return { scheduler, card, worktrees, pushes, land: () => land(), store };
  }

  /** Let the fired-and-forgotten `integrateWorktree` chain settle. */
  const settle = async (): Promise<void> => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };

  it('says the card is merging before git is called, and stops once it lands', async () => {
    const { scheduler, worktrees, pushes, land } = setup();
    expect(await scheduler.integrateNow('t1')).toBeNull();
    await settle();

    expect(worktrees.integrate).toHaveBeenCalledTimes(1);
    expect(scheduler.integratingTaskIds()).toEqual(['t1']);
    expect(pushes[0]).toEqual(['t1']);

    land();
    await settle();
    expect(scheduler.integratingTaskIds()).toEqual([]);
    expect(pushes.at(-1)).toEqual([]);
  });

  it('files the attempt on the timeline, not just its outcome', async () => {
    const { scheduler, store } = setup();
    await scheduler.integrateNow('t1');
    await settle();
    const note = (store.appendTaskEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((note?.[3] as { text: string }).text).toContain('Merging branch "feat/export"');
  });

  it('gives the card back when it refuses — a refusal must not spin forever', async () => {
    const { scheduler, card } = setup();
    card.status = 'running';
    expect(await scheduler.integrateNow('t1')).toMatch(/still working/);
    expect(scheduler.integratingTaskIds()).toEqual([]);
  });

  it('gives the card back when the project it merges into is gone', async () => {
    const { scheduler, card } = setup();
    card.agentProjectId = 'deleted';
    (scheduler as unknown as { readyToIntegrate: Map<string, unknown> }).readyToIntegrate.clear();
    expect(await scheduler.integrateNow('t1')).toMatch(/has been removed/);
    expect(scheduler.integratingTaskIds()).toEqual([]);
  });

  it('ignores a second press while the first merge is still running', async () => {
    const { scheduler, worktrees } = setup();
    await scheduler.integrateNow('t1');
    await settle();
    expect(await scheduler.integrateNow('t1')).toBeNull();
    await settle();
    // One rebase in that worktree, not two.
    expect(worktrees.integrate).toHaveBeenCalledTimes(1);
  });

  it('gives the card back — and parks the failure — when git throws', async () => {
    const { scheduler, worktrees, store } = setup();
    worktrees.integrate.mockImplementation(() => Promise.reject(new Error('git exploded')));
    await scheduler.integrateNow('t1');
    await settle();
    expect(scheduler.integratingTaskIds()).toEqual([]);
    // Nobody awaits the merge, so a throw used to be an unhandled rejection and the card
    // just stopped merging. It has to land somewhere a human will read it.
    const notes = (store.appendTaskEvent as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[3] as { text: string }).text,
    );
    expect(notes.some((n) => n.includes('git exploded'))).toBe(true);
  });
});

describe('releaseMode', () => {
  const project = (defaultPermissionMode: string): { defaultPermissionMode: PermissionMode } => ({
    defaultPermissionMode: defaultPermissionMode as PermissionMode,
  });

  it('keeps the card’s own mode when it can actually do the work', () => {
    expect(releaseMode({ agentMode: 'bypassPermissions' }, project('acceptEdits'))).toBe(
      'bypassPermissions',
    );
  });

  it('never releases in plan mode — that card could only read the instructions', () => {
    expect(releaseMode({ agentMode: 'plan' }, project('acceptEdits'))).toBe('acceptEdits');
    // …and when the project is a planning project too, something has to be able to run.
    expect(releaseMode({ agentMode: 'plan' }, project('plan'))).toBe('acceptEdits');
  });

  it('falls back to the project default for a card with no override', () => {
    expect(releaseMode({ agentMode: null }, project('manual'))).toBe('manual');
  });
});

/**
 * A merge that has nothing to do must not park the card.
 *
 * The bug: a card merged successfully, its branch and worktree were deleted, and then a chat
 * reply on that same card settled through the identical auto-integration path in `settle`.
 * The second merge failed ("not a git repository"), which arrived as `error` — so the card
 * went to `waiting-input` with an inbox item whose only real option, "Retry integration",
 * re-ran the same impossible merge. Work that had shipped an hour earlier looked broken.
 */
describe('Scheduler — an integration with nothing to merge', () => {
  function setup() {
    const project = {
      id: 'agent-1',
      name: 'Checkout service',
      path: 'C:/repo',
      planPath: '',
      kind: 'agent',
      concurrency: 1,
      useWorktrees: true,
      instructions: '',
    } as unknown as Project;
    const card = {
      id: 't1',
      projectId: 'personal',
      phase: '',
      title: 'Some task cards have white and bold title',
      status: 'in-progress',
      sessionId: 'sess-1',
      order: 0,
      source: 'adhoc',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      agentProjectId: 'agent-1',
      agentBranch: 'feat/whitening',
      parentTaskId: null,
      landedAt: 1_700_000_000_000,
    } as unknown as Task;
    const notes: string[] = [];
    const store = {
      getTask: (id: string) => (id === 't1' ? card : undefined),
      getProject: (id: string) => (id === 'agent-1' ? project : undefined),
      listProjects: () => [project],
      getTasks: () => [card],
      getSubtasks: () => [],
      getTaskActivity: () => [],
      addComment: vi.fn(),
      listTaskLinks: () => [],
      updateTask: (id: string, patch: Partial<Task>) => {
        if (id === 't1') Object.assign(card, patch);
        return card;
      },
      appendTaskEvent: vi.fn((_p: string, _t: string, _r: string, e: { text?: string }) => {
        if (e?.text) notes.push(e.text);
      }),
      appendTokenUsage: vi.fn(),
      getSettings: () => ({ maxAutoRetries: 0, limitJitterMs: 0, concurrency: 1 }),
      ...INERT_ATTENTION_STORE,
      // Overrides the inert stub: parking a failure persists its inbox item through here,
      // so "was the human interrupted?" is exactly "was this called?".
      saveAttention: vi.fn(),
    } as unknown as Store;
    const worktrees = {
      prepare: vi.fn(),
      inspect: vi.fn(async () => null),
      integrate: vi.fn(async () => ({
        status: 'nothing-to-merge',
        branch: 'feat/whitening',
        base: 'development',
        reason: 'branch "feat/whitening" no longer exists in C:/repo',
      })),
      cleanup: vi.fn(),
    };
    const start = vi.fn(() => ({ runId: 'r-new' }));
    const sessions = { start, stop: vi.fn(), send: vi.fn() } as unknown as SessionManager;
    const scheduler = new Scheduler(
      store,
      sessions,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      worktrees as unknown as WorktreeManager,
    );
    return { scheduler, card, notes, worktrees, start, store };
  }

  const settle = async (): Promise<void> => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };

  it('notes it and leaves the card exactly where it was — no inbox item', async () => {
    const { scheduler, card, notes, store } = setup();
    (
      scheduler as unknown as {
        applyIntegrationResult: (p: Project, c: unknown, r: unknown) => void;
      }
    ).applyIntegrationResult(
      { id: 'agent-1', path: 'C:/repo' } as unknown as Project,
      {
        taskId: 't1',
        runId: 'r1',
        branch: 'feat/whitening',
        base: 'development',
        worktree: 'C:/wt/t1',
      },
      {
        status: 'nothing-to-merge',
        branch: 'feat/whitening',
        base: 'development',
        reason: 'branch "feat/whitening" no longer exists in C:/repo',
      },
    );
    await settle();

    // The card is untouched — this is the whole fix. It must NOT reach `waiting-input`.
    expect(card.status).toBe('in-progress');
    expect(store.saveAttention).not.toHaveBeenCalled();
    // And the timeline says why, so the human is not left guessing at a button that did nothing.
    expect(notes.some((n) => n.includes('No merge was needed'))).toBe(true);
    expect(notes.some((n) => n.includes('no longer exists'))).toBe(true);
  });

  /**
   * The same outcome arriving from a RUN rather than from the Merge button, where "leave the
   * card exactly as it was" meant leaving it `running` — the field a run borrows and this
   * branch never gave back. Nothing writes it again afterwards: the run's `exited` is guarded
   * on `!run.settled` and declines to touch a settled run's status.
   */
  it('releases a card the run had borrowed, back to the column the human left it in', async () => {
    const { scheduler, card, store } = setup();
    // What a card looks like the instant its run settles: `running`, with the human's own
    // column parked behind it by `guardCardStatus`.
    card.status = 'running';
    (card as unknown as { preRunStatus: string }).preRunStatus = 'pending';

    (
      scheduler as unknown as {
        applyIntegrationResult: (p: Project, c: unknown, r: unknown) => void;
      }
    ).applyIntegrationResult(
      { id: 'agent-1', path: 'C:/repo' } as unknown as Project,
      {
        taskId: 't1',
        runId: 'r1',
        branch: 'feat/whitening',
        base: 'development',
        worktree: 'C:/wt/t1',
      },
      {
        status: 'nothing-to-merge',
        branch: 'feat/whitening',
        base: 'development',
        reason: 'branch "feat/whitening" no longer exists in C:/repo',
      },
    );
    await settle();

    // Back where the human put it — not spinning, and not moved for them either.
    expect(card.status).toBe('pending');
    // Still nothing wrong, so still no inbox item.
    expect(store.saveAttention).not.toHaveBeenCalled();
  });

  it('refuses the Merge button without resurrecting the branch, when nothing is left to merge', async () => {
    const { scheduler, worktrees } = setup();

    const why = await scheduler.integrateNow('t1');

    expect(why).toMatch(/no branch left to merge/i);
    // `inspect` READS; `prepare` would have rebuilt the worktree and re-created the branch.
    expect(worktrees.inspect).toHaveBeenCalledTimes(1);
    expect(worktrees.prepare).not.toHaveBeenCalled();
    expect(worktrees.integrate).not.toHaveBeenCalled();
    // A refusal must give the card back rather than leaving it spinning on a merge.
    expect(scheduler.integratingTaskIds()).toEqual([]);
  });
});

/**
 * A card assigned `plan` mode passes that mode to every run it ever starts. Only the runs
 * whose JOB is a plan may be graded on producing one.
 *
 * The card that exposed this had all eight steps done and eight commits on its branch. Its
 * post-chain review session delivered a complete, verified branch review — and was parked as
 * "the planning session ended without presenting a plan", then auto-retried into the same
 * verdict, because a conversation cannot present a plan and was never going to.
 */
describe('Scheduler — which runs owe a plan', () => {
  function setup() {
    const project = {
      id: 'agent-1',
      name: 'Travelbook',
      path: 'C:/repo',
      planPath: '',
      kind: 'agent',
      concurrency: 1,
      useWorktrees: false,
      defaultPermissionMode: 'bypassPermissions',
      defaultModel: 'sonnet',
      // The same distinction decides the model, so these runs are the ones that prove a
      // conversation is not billed as planning.
      planningModel: 'opus',
      instructions: '',
    } as unknown as Project;
    // Assigned `plan` in the assign dialog — the setting that leaks into every later run.
    const card = {
      id: 't1',
      projectId: 'personal',
      phase: '',
      title: 'Backend processing may require more time',
      status: 'in-progress',
      sessionId: 'sess-1',
      order: 0,
      source: 'adhoc',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      agentProjectId: 'agent-1',
      agentMode: 'plan',
      agentPlan: '# An approved plan from round 1',
      parentTaskId: null,
    } as unknown as Task;
    const store = {
      getTask: (id: string) => (id === 't1' ? card : undefined),
      getProject: (id: string) => (id === 'agent-1' ? project : undefined),
      listProjects: () => [project],
      getTasks: () => [card],
      getSubtasks: () => [],
      getTaskActivity: () => [],
      listTaskLinks: () => [],
      addComment: vi.fn(),
      addChatMessage: vi.fn(),
      updateTask: (id: string, patch: Partial<Task>) => {
        if (id === 't1') Object.assign(card, patch);
        return card;
      },
      appendTaskEvent: vi.fn(),
      appendTokenUsage: vi.fn(),
      getSettings: () => ({ maxAutoRetries: 0, limitJitterMs: 0, concurrency: 1 }),
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const sessions = {
      start: vi.fn(() => ({ runId: 'r-new' })),
      stop: vi.fn(),
      send: vi.fn(),
    } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    /** The run object the scheduler just created, straight off its private map. */
    const runFor = (runId: string) =>
      (
        scheduler as unknown as {
          runs: Map<string, { permissionMode?: string; expectsPlan?: boolean; model?: string }>;
        }
      ).runs.get(runId);
    return { scheduler, card, runFor };
  }

  it('does not make a chat reply owe a plan, though it inherits plan mode', () => {
    const { scheduler, runFor } = setup();

    const sent = scheduler.chatWithAgent('t1', 'how did the branch turn out?');

    expect(sent.status).toBe('resumed');
    if (sent.status === 'refused') throw new Error(sent.reason);
    const run = runFor(sent.runId);
    // The mode is still inherited — a card restricted to read-only stays read-only. It is
    // the VERDICT that changes, not the permissions.
    expect(run?.permissionMode).toBe('plan');
    expect(run?.expectsPlan).toBe(false);
    // …and not the price either: answering a question is not planning.
    expect(run?.model).toBe('sonnet');
  });

  it('still makes a re-plan owe a plan — that turn asked for one', () => {
    const { scheduler, runFor } = setup();

    const sent = scheduler.replanCard('t1', 'plan me another round');

    expect(sent.status).toBe('resumed');
    if (sent.status === 'refused') throw new Error(sent.reason);
    const run = runFor(sent.runId);
    expect(run?.permissionMode).toBe('plan');
    expect(run?.expectsPlan).toBe(true);
    // A turn that asks for a plan switches model as well as mode.
    expect(run?.model).toBe('opus');
  });

  // The exact run that was parked twice: the review conversation a chat reply starts once a
  // finished chain's `chainLandedAt` marker flags the next run on the card as one.
  it('does not make the post-chain review owe a plan', () => {
    const { scheduler, card, runFor } = setup();
    // What `finishParentChain` leaves behind once the chain lands: no session to resume,
    // and the one-shot marker `startTask` reads as "the next run is a review".
    card.sessionId = null as unknown as string;
    (card as unknown as { chainLandedAt: number }).chainLandedAt = 1700000000000;

    const sent = scheduler.chatWithAgent('t1', 'how did it go?');

    expect(sent.status).toBe('resumed');
    if (sent.status === 'refused') throw new Error(sent.reason);
    const run = runFor(sent.runId) as unknown as {
      reviewSeed?: boolean;
      expectsPlan?: boolean;
      model?: string;
    };
    expect(run.reviewSeed).toBe(true);
    expect(run.expectsPlan).toBe(false);
    expect(run.model).toBe('sonnet'); // a review reads code; it does not plan
    // Consumed, not left behind — a second run on this card must not also read as a review.
    expect(card.chainLandedAt).toBeNull();
  });

  it('still makes an ordinary run on a plan-mode card owe a plan', () => {
    const { scheduler, card, runFor } = setup();
    // No session yet: the first message to an assigned card starts it as a real work run,
    // and on a `plan` card planning IS that work.
    card.sessionId = null as unknown as string;

    const sent = scheduler.chatWithAgent('t1', 'off you go');

    expect(sent.status).toBe('resumed');
    if (sent.status === 'refused') throw new Error(sent.reason);
    const run = runFor(sent.runId);
    expect(run?.expectsPlan).toBe(true);
  });
});

/**
 * Closing a card clears what it was asking.
 *
 * The engine half of "a done card does not demand attention": the ring goes quiet by
 * itself (`chainNeedsAttention` overrides a closed card), but the INBOX is a list of its
 * own — an item left behind outlives the ring, cannot be acted on any more, and keeps
 * counting in the nav rail's badge. `task:setStatus` / `task:move` call this the moment a
 * card comes to rest in `done`; the detail pane's **Dismiss** calls the same method for a
 * card that is shouting and is NOT done.
 */
describe('dismissAttentionForCard', () => {
  const mkTask = (over: Partial<Task>): Task =>
    ({
      id: 'c1',
      projectId: 'agent-p',
      phase: '',
      title: 'card',
      status: 'done',
      sessionId: null,
      order: 0,
      source: 'adhoc',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      ...over,
    }) as Task;

  const item = (over: Record<string, unknown>): Record<string, unknown> => ({
    id: 'i1',
    runId: 'r1',
    taskId: 'c1',
    projectId: 'agent-p',
    taskTitle: 'card',
    kind: 'question',
    prompt: 'which one?',
    options: [],
    toolName: null,
    reason: null,
    createdAt: 0,
    ...over,
  });

  function setup(items: Array<Record<string, unknown>>): {
    scheduler: Scheduler;
    resolved: ReturnType<typeof vi.fn>;
    open: () => string[];
  } {
    const card = mkTask({ id: 'c1' });
    const steps = [
      mkTask({ id: 's1', parentTaskId: 'c1', title: 'step 1' }),
      mkTask({ id: 's2', parentTaskId: 'c1', title: 'step 2' }),
    ];
    const all = [card, ...steps, mkTask({ id: 'other', title: 'someone else' })];
    const store = {
      getTask: (id: string) => all.find((t) => t.id === id),
      getTasks: () => all,
      getSubtasks: (parentId: string) => steps.filter((s) => s.parentTaskId === parentId),
      updateTask: (id: string, patch: Partial<Task>) => {
        const t = all.find((x) => x.id === id);
        if (t) Object.assign(t, patch);
        return t;
      },
      getSettings: () => ({ limitJitterMs: 0, concurrency: 1, maxAutoRetries: 0 }),
      saveLimitGate: () => undefined,
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const resolved = vi.fn();
    const scheduler = new Scheduler(
      store,
      { start: vi.fn(), stop: vi.fn(), send: vi.fn() } as unknown as SessionManager,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      resolved,
      vi.fn(),
    );
    const map = (scheduler as unknown as { attention: Map<string, unknown> }).attention;
    for (const i of items) map.set(i.id as string, i);
    return { scheduler, resolved, open: () => [...map.keys()] };
  }

  it('clears the card AND its steps, and leaves other cards alone', () => {
    const { scheduler, resolved, open } = setup([
      item({ id: 'i1', taskId: 'c1' }),
      item({ id: 'i2', taskId: 's1', kind: 'permission' }),
      item({ id: 'i3', taskId: 's2', kind: 'plan-approval' }),
      item({ id: 'i4', taskId: 'other' }),
    ]);

    expect(scheduler.dismissAttentionForCard('c1')).toBe(3);
    // A chain's asks are filed against its STEPS — a card running a plan holds no session
    // of its own — so sweeping only the card id would clear almost nothing.
    expect(open()).toEqual(['i4']);
    for (const id of ['i1', 'i2', 'i3']) expect(resolved).toHaveBeenCalledWith(id);
    expect(resolved).not.toHaveBeenCalledWith('i4');
  });

  it('releases the tool a held decision was blocking, denied', () => {
    const { scheduler } = setup([item({ id: 'i1', kind: 'permission' })]);
    const resolve = vi.fn();
    (scheduler as unknown as { pendingDecisions: Map<string, unknown> }).pendingDecisions.set(
      'i1',
      { runId: 'r1', input: {}, resolve },
    );

    scheduler.dismissAttentionForCard('c1');

    // Dropping the item without this leaves the CLI process parked on its HTTP request
    // until the app exits. Denied, because nobody approved anything.
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0][0]).toMatchObject({ behavior: 'deny' });
    expect(
      (scheduler as unknown as { pendingDecisions: Map<string, unknown> }).pendingDecisions.size,
    ).toBe(0);
  });

  it('refuses to dismiss a merge conflict — its answer is what finishes the rebase', () => {
    const { scheduler, resolved, open } = setup([
      item({ id: 'i1', kind: 'merge-conflict' }),
      item({ id: 'i2', taskId: 's1' }),
    ]);

    expect(scheduler.dismissAttentionForCard('c1')).toBe(1);
    // A rebase stopped halfway with markers in a worktree is not a card shouting; hiding
    // it would strand the repo with no control left that could finish the job.
    expect(open()).toEqual(['i1']);
    expect(resolved).toHaveBeenCalledWith('i2');
    expect(resolved).not.toHaveBeenCalledWith('i1');
  });

  it('is a no-op for a card with nothing parked on it', () => {
    const { scheduler, resolved } = setup([item({ id: 'i4', taskId: 'other' })]);
    expect(scheduler.dismissAttentionForCard('c1')).toBe(0);
    expect(resolved).not.toHaveBeenCalled();
  });
});

/**
 * Why a Start did nothing — {@link Scheduler.startTaskNow}.
 *
 * The reported bug: two cards were unblocked, Start was pressed, and each answered
 * "Cannot start this task now — it is already running, or a usage limit is holding all
 * work." Neither half was true. `runTask` collapsed six distinct refusals into one `null`
 * and `task:run` guessed at the two it thought likeliest, so the one that had actually
 * happened — a dead sign-in — was never named and the action that fixes it never offered.
 *
 * The second half of the same bug is that a gate's refusal used to be the end of it: the
 * card stayed `pending` OUTSIDE the gate, so signing in resumed everything except the
 * cards a human had asked for by hand.
 */
describe('Scheduler.startTaskNow — the reason a Start was refused', () => {
  function setup(opts: { steps?: Task[]; authGate?: boolean } = {}): {
    scheduler: Scheduler;
    card: Task;
    start: ReturnType<typeof vi.fn>;
    notes: { taskId: string; body: string }[];
  } {
    const project = {
      id: 'p',
      path: 'C:/w',
      planPath: 'C:/w/plan.md',
      name: 'P',
      concurrency: 1,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'acceptEdits',
    } as Project;
    const card = {
      id: 't1',
      projectId: 'p',
      phase: '',
      title: 'Switching from Python to NestJS/TypeScript in the backend',
      status: 'pending',
      sessionId: null,
      order: 0,
      source: 'board',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      agentProjectId: null,
    } as unknown as Task;
    const steps = opts.steps ?? [];
    const byId = new Map<string, Task>([[card.id, card], ...steps.map((s) => [s.id, s] as const)]);
    const notes: { taskId: string; body: string }[] = [];
    const store = {
      getTask: (id: string) => byId.get(id),
      getTasks: () => [card, ...steps],
      getProject: (id: string) => (id === 'p' ? project : undefined),
      getSubtasks: (id: string) => (id === 't1' ? steps : []),
      updateTask: (id: string, patch: Partial<Task>) => {
        const found = byId.get(id);
        if (found) Object.assign(found, patch);
        return found;
      },
      listProjects: () => [project],
      listTaskLinks: () => [],
      appendTaskEvent: vi.fn(
        (_p: string, taskId: string, _runId: string, event: { text?: string }) => {
          notes.push({ taskId, body: event.text ?? '' });
        },
      ),
      getSettings: () => ({ maxAutoRetries: 0, limitJitterMs: 0, concurrency: 1 }),
      saveLimitGate: vi.fn(),
      loadLimitGate: () => null,
      saveAuthGate: vi.fn(),
      loadAuthGate: () =>
        opts.authGate
          ? {
              since: 1,
              reason: 'Failed to authenticate: OAuth session expired',
              source: 'run',
              parkedTaskIds: [],
            }
          : null,
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const start = vi.fn(() => ({ runId: 'r1' }));
    const sessions = { start, stop: vi.fn() } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    // Through the public restore path, so the gate is raised the way a relaunch raises it.
    if (opts.authGate) scheduler.restoreAuthGate();
    return { scheduler, card, start, notes };
  }

  /** Raise the usage-limit gate the way a `rate-limit` event from the CLI raises it. */
  function engageLimit(scheduler: Scheduler): void {
    (scheduler as unknown as { engageLimit: (e: unknown) => void }).engageLimit({
      kind: 'rate-limit',
      status: 'limited',
      rateLimitType: 'rolling',
      resetsAt: null,
    });
  }

  it('starts the card and reports the run when nothing is in the way', () => {
    const { scheduler, start } = setup();
    const outcome = scheduler.startTaskNow('t1');
    expect(outcome).toEqual({ runId: expect.any(String) });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('names the SIGN-IN gate instead of blaming a usage limit', () => {
    const { scheduler, start } = setup({ authGate: true });

    expect(scheduler.startTaskNow('t1')).toEqual({ refused: 'signed-out' });
    expect(start).not.toHaveBeenCalled();
    // The sentence a human reads has to carry the one action that fixes this, and must not
    // send them off to wait for a reset that is never coming.
    expect(RUN_REFUSAL_MESSAGE['signed-out']).toContain('Sign in');
    expect(RUN_REFUSAL_MESSAGE['signed-out']).not.toContain('usage limit');
  });

  /**
   * A gate is the only thing that remembers work across the pause, so a Start it swallowed
   * has to be parked IN it. Without this the two cards in the report would still have been
   * sitting there untouched after signing in.
   */
  it('parks the card in the sign-in gate so it starts by itself on the way back', () => {
    const { scheduler, card, start, notes } = setup({ authGate: true });

    scheduler.startTaskNow('t1');

    expect(scheduler.currentAuth()?.parkedTaskIds).toEqual(['t1']);
    // Plain `pending`, not a status of its own — the note is what makes the wait legible.
    expect(card.status).toBe('pending');
    expect(notes.at(-1)?.body).toContain('sign in');

    scheduler.signedIn();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('names the usage limit when THAT is the gate, and parks behind it', () => {
    const { scheduler, card } = setup();
    engageLimit(scheduler);

    expect(scheduler.startTaskNow('t1')).toEqual({ refused: 'limit' });
    expect(scheduler.currentLimit()?.parkedTaskIds).toContain('t1');
    expect(card.status).toBe('blocked-by-limit');
  });

  it('says "already running" only when the task really is in flight', () => {
    const { scheduler } = setup();
    (scheduler as unknown as { inFlight: Set<string> }).inFlight.add('t1');
    expect(scheduler.startTaskNow('t1')).toEqual({ refused: 'already-running' });
  });

  it('says the card is gone rather than blaming a gate for it', () => {
    const { scheduler } = setup();
    expect(scheduler.startTaskNow('nope')).toEqual({ refused: 'unknown-task' });
  });

  /**
   * A card with no project behind it resolves no directory to run in. It used to get the
   * usage-limit sentence too, which sent people off to wait for a reset that would change
   * nothing — and it is asked BEFORE the gates for exactly that reason: a gate must not
   * answer for a card that could never have run anyway.
   */
  it('says there is no repository when no project resolves', () => {
    const { scheduler } = setup({ authGate: true });
    (scheduler as unknown as { store: { getProject: () => undefined } }).store.getProject = () =>
      undefined;
    expect(scheduler.startTaskNow('t1')).toEqual({ refused: 'no-project' });
    expect(scheduler.currentAuth()?.parkedTaskIds).toEqual([]);
  });

  it('refuses everything once the engine is shutting down', () => {
    const { scheduler } = setup();
    scheduler.dispose();
    expect(scheduler.startTaskNow('t1')).toEqual({ refused: 'shutting-down' });
  });

  /**
   * A gate parks the task that WOULD have run, which for a card executing a plan is its
   * step. Parking the card instead would resume the card's own session beside its chain —
   * two agents in one worktree, the thing the reservation scheme exists to prevent.
   */
  it('parks the STEP, not the card, when the card hands over to its chain', () => {
    const step = {
      id: 's1',
      parentTaskId: 't1',
      projectId: 'p',
      phase: '',
      title: 'step one',
      status: 'pending',
      sessionId: null,
      order: 0,
      source: 'plan',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
    } as unknown as Task;
    const { scheduler } = setup({ steps: [step], authGate: true });

    expect(scheduler.startTaskNow('t1')).toEqual({ refused: 'signed-out' });
    expect(scheduler.currentAuth()?.parkedTaskIds).toEqual(['s1']);
  });

  /** `runTask` keeps its old shape, for the chain of execution and every other caller. */
  it('still answers runTask with a plain null', () => {
    const { scheduler } = setup({ authGate: true });
    expect(scheduler.runTask('t1')).toBeNull();
  });
});

/**
 * What a gate remembers about the run it parked — see `parkedRun.ts`.
 *
 * A gate parks TASKS, and both resume paths used to start each one with a bare
 * `startTask(project, task)`. That is right for ordinary work and wrong for the only two
 * runs that are not the card's work at all:
 *
 *  - a **release** run came back as ordinary work on the card, so instead of publishing the
 *    merged branch it re-opened the card's session and started implementing something; and
 *  - a **chat** reply came back with no prompt, so the agent was woken with nothing to
 *    answer and the human's message was simply lost.
 *
 * Nothing else needs remembering: `reviewSeed` rebuilds itself inside `startTask` from
 * `task.chainLandedAt`, and an ordinary work run is exactly what a bare `startTask`
 * produces — which is why a missing recipe degrades to yesterday's behaviour rather than to
 * a wrong kind of run.
 */
describe('a parked release or chat run comes back as what it was', () => {
  /** The persisted recipe, restated here so the test names the shape it asserts on. */
  interface Recipe {
    taskId: string;
    chatPrompt?: string;
    releaseSeed?: boolean;
    permissionMode?: PermissionMode;
  }
  /** The scheduler's own run bookkeeping, as much of it as these cases read. */
  interface LiveRun {
    taskId: string;
    runId: string;
    settled: boolean;
    chatPrompt?: string;
    releaseSeed?: boolean;
    permissionMode?: PermissionMode;
  }

  const RELEASE_PROMPT = 'Release `main` by following RELEASE.md.';
  const CHAT_PROMPT = 'Did you touch the auth code?';

  function setup() {
    const project = {
      id: 'p',
      path: 'C:/w',
      planPath: 'C:/w/plan.md',
      name: 'P',
      concurrency: 1,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'acceptEdits',
    } as Project;
    const card = {
      id: 't1',
      projectId: 'p',
      phase: '',
      title: 'Ship the export dialog',
      status: 'in-progress',
      // A card that has already worked and merged — which is the only card either of the two
      // interesting runs ever happens on.
      sessionId: 'sess-1',
      order: 0,
      source: 'board',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      agentProjectId: null,
      parentTaskId: null,
    } as unknown as Task;
    const notes: string[] = [];
    /** The `app_state` side table as a variable — what a relaunch would read back. */
    let savedRuns: Recipe[] = [];
    const store = {
      getTask: (id: string) => (id === 't1' ? card : undefined),
      getTasks: () => [card],
      getProject: (id: string) => (id === 'p' ? project : undefined),
      getSubtasks: () => [],
      listProjects: () => [project],
      listTaskLinks: () => [],
      updateTask: (id: string, patch: Partial<Task>) => {
        if (id === card.id) Object.assign(card, patch);
        return card;
      },
      appendTaskEvent: vi.fn(
        (_p: string, _taskId: string, _runId: string, event: { text?: string }) => {
          notes.push(event.text ?? '');
        },
      ),
      getSettings: () => ({ maxAutoRetries: 0, limitJitterMs: 0, concurrency: 1 }),
      saveLimitGate: vi.fn(),
      loadLimitGate: () => null,
      saveAuthGate: vi.fn(),
      loadAuthGate: () => null,
      saveParkedRuns: (runs: readonly Recipe[]) => {
        savedRuns = [...runs];
      },
      loadParkedRuns: () => savedRuns,
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const start = vi.fn((_req: unknown, opts: { runId?: string }) => ({
      runId: opts?.runId ?? 'r-new',
    }));
    const sessions = { start, stop: vi.fn(), send: vi.fn() } as unknown as SessionManager;
    const emitAttention = vi.fn();
    /** A second engine over the SAME store — a relaunch, for the persistence case. */
    const relaunch = (): Scheduler =>
      new Scheduler(store, sessions, vi.fn(), vi.fn(), emitAttention, vi.fn(), vi.fn());
    return {
      scheduler: relaunch(),
      relaunch,
      project,
      card,
      start,
      emitAttention,
      notes,
      saved: () => savedRuns,
    };
  }

  /** Start a run the way each caller does, with the opts that make it what it is. */
  const startRun = (
    scheduler: Scheduler,
    project: Project,
    task: Task,
    opts: { chatPrompt?: string; releaseSeed?: boolean; permissionMode?: PermissionMode },
  ): string =>
    (
      scheduler as unknown as {
        startTask: (p: Project, t: Task, o: typeof opts) => string;
      }
    ).startTask(project, task, opts);

  /** The account hits its usage limit, parking everything in flight. */
  const hitLimit = (scheduler: Scheduler): void =>
    (scheduler as unknown as { engageLimit: (s: unknown) => void }).engageLimit({
      kind: 'rate-limit',
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: null,
    });

  /** The run the reset started: the only one that has not settled. */
  const resumedRun = (scheduler: Scheduler): LiveRun | undefined =>
    [...(scheduler as unknown as { runs: Map<string, LiveRun> }).runs.values()].find(
      (r) => !r.settled,
    );

  /** Deliver an event to a run, as the session manager would. */
  const fire = (scheduler: Scheduler, runId: string, event: unknown): Promise<void> =>
    (scheduler as unknown as { onRunEvent: (r: string, e: unknown) => Promise<void> }).onRunEvent(
      runId,
      event,
    );

  /** The parked process finally goes away — which is what frees the card for a new Start. */
  const exit = (scheduler: Scheduler, runId: string): Promise<void> =>
    fire(scheduler, runId, { kind: 'exited', code: 0 });

  /** The credential is dead, reported by the run that proved it — raises the sign-in gate. */
  const hitSignedOut = (scheduler: Scheduler, runId: string): void => {
    const engine = scheduler as unknown as {
      runs: Map<string, LiveRun>;
      engageAuthFailure: (failing: LiveRun, reason: string) => void;
    };
    engine.engageAuthFailure(engine.runs.get(runId)!, 'OAuth session expired');
  };

  it('starts a parked release run as a release run again', () => {
    const h = setup();
    startRun(h.scheduler, h.project, h.card, {
      releaseSeed: true,
      permissionMode: 'acceptEdits',
      chatPrompt: RELEASE_PROMPT,
    });
    hitLimit(h.scheduler);
    expect(h.card.status).toBe('blocked-by-limit');

    h.scheduler.resumeLimitNow();

    const run = resumedRun(h.scheduler);
    expect(run?.releaseSeed).toBe(true);
    // …and it is briefed to release, in the project directory rather than a worktree —
    // there is no branch left to cut one from once the work has merged.
    const [request] = h.start.mock.calls.at(-1) as [{ prompt: string; cwd: string }, unknown];
    expect(request.prompt).toBe(RELEASE_PROMPT);
    expect(request.cwd).toBe('C:/w');
  });

  /**
   * The flag is not decoration: `settle` reads it to decide whose failure this is. A
   * release that came back as ordinary work would park the CARD in the inbox for something
   * its own work had nothing to do with, and auto-retry half a publish on the way.
   */
  it('so a failure settles as the release’s, not as the card’s', async () => {
    const h = setup();
    startRun(h.scheduler, h.project, h.card, {
      releaseSeed: true,
      permissionMode: 'acceptEdits',
      chatPrompt: RELEASE_PROMPT,
    });
    hitLimit(h.scheduler);
    h.scheduler.resumeLimitNow();
    const run = resumedRun(h.scheduler);

    await fire(h.scheduler, run!.runId, {
      kind: 'result',
      success: false,
      resultText: 'npm publish exited 1',
      costUsd: null,
      durationMs: null,
      stopReason: null,
      terminalReason: 'error',
    });

    expect(h.notes.at(-1)).toContain('The release did not finish');
    expect(h.card.status).toBe('in-progress'); // left where the human had it
    expect(h.emitAttention).not.toHaveBeenCalled(); // and never parked against the card
  });

  it('gives a parked chat reply its prompt back', () => {
    const h = setup();
    startRun(h.scheduler, h.project, h.card, { chatPrompt: CHAT_PROMPT });
    hitLimit(h.scheduler);

    h.scheduler.resumeLimitNow();

    expect(resumedRun(h.scheduler)?.chatPrompt).toBe(CHAT_PROMPT);
    const [request, opts] = h.start.mock.calls.at(-1) as [
      { prompt: string },
      { resumeSessionId?: string },
    ];
    // The human's own words, into the conversation they were typed at.
    expect(request.prompt).toBe(CHAT_PROMPT);
    expect(opts.resumeSessionId).toBe('sess-1');
  });

  /**
   * The regression guard. Ordinary work is every other run there is, and it must resume the
   * way it always has: no recipe written, none read, and a plain resume of the card's own
   * session.
   */
  it('leaves an ordinary work run resuming exactly as before', () => {
    const h = setup();
    startRun(h.scheduler, h.project, h.card, {});
    hitLimit(h.scheduler);
    expect(h.saved()).toEqual([]); // nothing about a work run is worth remembering

    h.scheduler.resumeLimitNow();

    const run = resumedRun(h.scheduler);
    expect(run?.chatPrompt).toBeUndefined();
    expect(run?.releaseSeed).toBeFalsy();
    const [, opts] = h.start.mock.calls.at(-1) as [unknown, { resumeSessionId?: string }];
    expect(opts.resumeSessionId).toBe('sess-1');
  });

  it('drops the recipe once its park is over', () => {
    const h = setup();
    startRun(h.scheduler, h.project, h.card, { releaseSeed: true, chatPrompt: RELEASE_PROMPT });
    hitLimit(h.scheduler);
    expect(h.saved()).toEqual([
      {
        taskId: 't1',
        chatPrompt: RELEASE_PROMPT,
        releaseSeed: true,
        permissionMode: 'acceptEdits',
      },
    ]);

    h.scheduler.resumeLimitNow();

    // A recipe describes ONE park. Left behind, it would rebuild a release the next time
    // anything at all parked this card.
    expect(h.saved()).toEqual([]);
  });

  /** A stop is the human saying no — the recipe must not outlive it either. */
  it('drops the recipe when the human stops the card instead', () => {
    const h = setup();
    startRun(h.scheduler, h.project, h.card, { releaseSeed: true, chatPrompt: RELEASE_PROMPT });
    hitLimit(h.scheduler);

    expect(h.scheduler.stopTask('t1')).toBe(true);

    expect(h.saved()).toEqual([]);
  });

  /**
   * A second park over the first, which the gate answers with "already parked".
   *
   * The recipe describes the run being HELD, and the run being held here is the one the
   * human just asked for: an ordinary work run that has not started. Clearing it only when
   * the gate reports a fresh park read the answer as permission to keep yesterday's recipe,
   * so the reset re-sent a chat message the human had long moved on from — and never did
   * the work they pressed Start for.
   */
  it('drops a stale recipe when the same card is parked a second time', async () => {
    const h = setup();
    const runId = startRun(h.scheduler, h.project, h.card, { chatPrompt: CHAT_PROMPT });
    hitLimit(h.scheduler);
    expect(h.saved().map((r) => r.chatPrompt)).toEqual([CHAT_PROMPT]);
    await exit(h.scheduler, runId); // the parked process goes away, freeing the card

    // The human presses Start against the standing gate: parked again, this time as work.
    expect(h.scheduler.startTaskNow('t1')).toEqual({ refused: 'limit' });

    expect(h.saved()).toEqual([]); // the chat recipe did not survive its own park
    h.scheduler.resumeLimitNow();
    const run = resumedRun(h.scheduler);
    expect(run?.chatPrompt).toBeUndefined();
    expect(run?.releaseSeed).toBeFalsy();
    const [request, opts] = h.start.mock.calls.at(-1) as [
      { prompt: string },
      { resumeSessionId?: string },
    ];
    expect(request.prompt).not.toBe(CHAT_PROMPT); // ordinary work, on the card's own session
    expect(opts.resumeSessionId).toBe('sess-1');
  });

  /** The identical shape behind the other gate — same park, same stale recipe. */
  it('drops a stale recipe when the sign-in gate parks the card again', async () => {
    const h = setup();
    const runId = startRun(h.scheduler, h.project, h.card, { chatPrompt: CHAT_PROMPT });
    hitSignedOut(h.scheduler, runId);
    expect(h.saved().map((r) => r.chatPrompt)).toEqual([CHAT_PROMPT]);
    await exit(h.scheduler, runId);

    expect(h.scheduler.startTaskNow('t1')).toEqual({ refused: 'signed-out' });

    expect(h.saved()).toEqual([]);
    h.scheduler.signedIn();
    expect(resumedRun(h.scheduler)?.chatPrompt).toBeUndefined();
    const [request] = h.start.mock.calls.at(-1) as [{ prompt: string }, unknown];
    expect(request.prompt).not.toBe(CHAT_PROMPT);
  });

  /**
   * Why the table is persisted at all: a five-hour gate very often outlives a restart, and
   * a relaunch that resumes with an empty table is the original bug with extra steps.
   */
  it('survives a restart, so the relaunch still releases', () => {
    const h = setup();
    startRun(h.scheduler, h.project, h.card, {
      releaseSeed: true,
      permissionMode: 'acceptEdits',
      chatPrompt: RELEASE_PROMPT,
    });
    hitLimit(h.scheduler);
    h.scheduler.dispose(); // the app closes with the card still parked

    const next = h.relaunch();
    next.restoreParkedRuns();
    // Nothing was saved, so the gate is long gone: `restoreLimitGate` resumes what the DB
    // still says is parked — the branch a relaunch after a five-hour window actually takes.
    next.restoreLimitGate();

    expect(resumedRun(next)?.releaseSeed).toBe(true);
    expect(h.saved()).toEqual([]); // …and the recipe was consumed on the way
  });
});
