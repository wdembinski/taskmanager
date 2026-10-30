/**
 * Unit tests for the scheduler's pure decision logic — no store, no processes.
 * The class that wires this to SQLite and the SessionManager is exercised by
 * hand / verify; here we prove the selection rule and prompt shape.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  type ForgeGit,
  type Schedulable,
} from './scheduler';
import {
  AGREE_SENTINEL,
  NEEDS_INPUT_SENTINEL,
  OBJECT_SENTINEL,
  PROPOSE_SENTINEL,
} from './attention';
import type { AttentionItem } from '@shared/attention';
import { MAX_PLAN_STEPS } from '@shared/board';
import type { TaskAttachment } from '@shared/attachments';
import type { PlanVerdict } from '@shared/planCheck';
import type { PermissionMode, StartSessionRequest } from '@shared/session';
import type { AppSettings } from '@shared/settings';
import type { Project, Task, TaskActivityEntry } from '@shared/model';
import type { LimitState } from '@shared/limit';
import type { MergeRequest } from '@shared/mergeRequest';
import type { ActivityRow } from '@shared/activity';
import { RUN_REFUSAL_MESSAGE } from '@shared/scheduler';
import { GATE_TRUST_ACTION } from '@shared/workflow';
import { createActivityRecorder } from './activityRecorder';
import { gateCommandHash } from './gateTrust';
import type { ReviewToolDenial } from './permissionPolicy';
import { BaseMovedConflictError } from './forge/createPr';
import type { PermissionGate } from './claudeSession';
import type { SessionManager } from './sessionManager';
import type { Store } from './store';
import type { WorktreeManager } from './worktreeManager';
import { changedSinceMergeBase } from './git';

// `landWork` reads a branch's three-dot file list before it merges (`recordLandedFiles`).
// Every other git helper stays real; this one answers `[]` — what git itself answers for a
// checkout that does not exist, which is every fake project here — without spawning git,
// so a landing's merge is never left waiting on a real process. Cases about the recorded
// files set their own answer.
vi.mock('./git', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./git')>()),
  changedSinceMergeBase: vi.fn(() => Promise.resolve([])),
}));

/**
 * An in-memory `appendActivity` that mimics `activity_log`'s partial unique index: a second
 * `run-started`/`run-finished` for the same `runId` is refused (returns `null`), exactly as
 * the real store's `INSERT OR IGNORE` is. Used to assert on what the recorder actually wrote.
 */
function createFakeAppendActivity(): {
  rows: ActivityRow[];
  append: (row: Omit<ActivityRow, 'id'>) => ActivityRow | null;
} {
  const rows: ActivityRow[] = [];
  let nextId = 1;
  return {
    rows,
    append(row) {
      const deduped = row.kind === 'run-started' || row.kind === 'run-finished';
      if (deduped && rows.some((r) => r.runId === row.runId && r.kind === row.kind)) return null;
      const stored: ActivityRow = { id: nextId++, ...row };
      rows.push(stored);
      return stored;
    },
  };
}

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

  it('skips a task waiting on an owner decision, and takes it again once answered', () => {
    const flagged = { ...t('a', 'pending', 0), decisionQuestion: 'Which plan?' };
    const tasks = [flagged, t('b', 'pending', 1)];
    expect(selectNextPending(tasks, new Set())?.id).toBe('b');
    expect(selectNextPending([flagged], new Set())).toBeNull();
    expect(selectNextPending([{ ...flagged, decisionQuestion: null }], new Set())?.id).toBe('a');
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

    it('lets the human discuss the question instead of answering it', async () => {
      // Mirrors the CLI's own interactive prompt: prose that reacts to the question rather
      // than commits to one of its options. Still a `deny` (the held tool must resolve one
      // way or another) but phrased as NOT a decision, unlike `answers`/`reply`.
      const { scheduler, emitAttention } = makeScheduler('acceptEdits');
      const decision = scheduler.decidePermission(ask);
      const item = emitAttention.mock.calls[0][0] as { id: string };

      scheduler.answerAttention(item.id, {
        decision: 'discuss',
        text: 'What happens to existing rows if I pick Postgres?',
      });

      const result = (await decision) as { behavior: string; message: string };
      expect(result.behavior).toBe('deny');
      expect(result.message).toContain('has NOT answered your question yet');
      expect(result.message).toContain('What happens to existing rows if I pick Postgres?');
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

describe('Scheduler.decidePermission — AI review runs (F16.5)', () => {
  /**
   * Same shape as the full-auto block's `makeScheduler`, but `run1` is registered as a
   * REVIEW run, and the project is `bypassPermissions` — so an allow here could only come
   * from the review policy, never from the task shortcut. `task1` is an ordinary task run
   * beside it.
   */
  function makeScheduler() {
    const project = { id: 'p', defaultPermissionMode: 'bypassPermissions' } as Project;
    const task = { id: 'task', projectId: 'p', title: 'x' } as Task;
    const emitAttention = vi.fn();
    const store = {
      getProject: (id: string) => (id === 'p' ? project : undefined),
      getTask: (id: string) => (id === 'task' ? task : undefined),
      updateTask: (_id: string, patch: Partial<Task>) => ({ ...task, ...patch }),
      getSettings: () => ({ limitJitterMs: 0 }),
      appendTaskEvent: vi.fn(),
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const sessions = { send: vi.fn() } as unknown as SessionManager;
    const scheduler = new Scheduler(
      store,
      sessions,
      vi.fn(),
      vi.fn(),
      emitAttention,
      vi.fn(),
      vi.fn(),
    );
    (scheduler as unknown as { runs: Map<string, unknown> }).runs.set('task1', {
      taskId: 'task',
      projectId: 'p',
      runId: 'task1',
      settled: false,
    });
    const sink = { reviewId: 'review-1', onDenied: vi.fn() };
    scheduler.registerReviewRun('run1', sink);
    return { scheduler, emitAttention, sink };
  }

  it('allows a read-only git command, untouched, without recording anything', async () => {
    const { scheduler, emitAttention, sink } = makeScheduler();
    const input = { command: 'git log --oneline -5' };
    const result = await scheduler.decidePermission({ runId: 'run1', toolName: 'Bash', input });
    expect(result).toEqual({ behavior: 'allow', updatedInput: input });
    expect(sink.onDenied).not.toHaveBeenCalled();
    expect(emitAttention).not.toHaveBeenCalled();
  });

  it.each([
    ['Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, 'Edit'],
    ['WebFetch', { url: 'https://example.com' }, 'WebFetch'],
    ['Bash', { command: 'git checkout main' }, 'git checkout'],
    ['Bash', { command: 'git log; rm x' }, 'pipelines and chains'],
  ])(
    'denies %s at once, records it on the review and raises nothing',
    async (toolName, input, inReason) => {
      const { scheduler, emitAttention, sink } = makeScheduler();
      // Resolved immediately: awaiting would hang the test if the tool were held instead.
      const result = await scheduler.decidePermission({ runId: 'run1', toolName, input });
      expect(result.behavior).toBe('deny');
      if (result.behavior !== 'deny') return;
      expect(result.message).toMatch(/^AI review is read-only — /);
      expect(result.message).toContain(inReason);
      expect(emitAttention).not.toHaveBeenCalled();
      expect(sink.onDenied).toHaveBeenCalledTimes(1);
      const denial = sink.onDenied.mock.calls[0][0] as ReviewToolDenial;
      expect(denial.toolName).toBe(toolName);
      expect(denial.reason).toContain(inReason);
      expect(denial.detail.startsWith(toolName)).toBe(true);
      expect(Number.isNaN(Date.parse(denial.at))).toBe(false);
    },
  );

  it.each([
    ['ExitPlanMode', { plan: '# Plan\n- [ ] step' }],
    [
      'AskUserQuestion',
      { questions: [{ header: 'H', question: 'Q?', multiSelect: false, options: [] }] },
    ],
  ])('denies %s on a review run instead of raising an Attention item', async (toolName, input) => {
    const { scheduler, emitAttention, sink } = makeScheduler();
    const result = await scheduler.decidePermission({ runId: 'run1', toolName, input });
    expect(result.behavior).toBe('deny');
    expect(emitAttention).not.toHaveBeenCalled();
    expect(sink.onDenied).toHaveBeenCalledTimes(1);
  });

  it('still denies when the sink throws', async () => {
    const { scheduler, sink } = makeScheduler();
    sink.onDenied.mockImplementation(() => {
      throw new Error('disk full');
    });
    const result = await scheduler.decidePermission({
      runId: 'run1',
      toolName: 'Write',
      input: { file_path: 'x', content: 'y' },
    });
    expect(result.behavior).toBe('deny');
  });

  it('fails safe as an unknown session once the review run is unregistered', async () => {
    const { scheduler, sink } = makeScheduler();
    scheduler.unregisterReviewRun('run1');
    const result = await scheduler.decidePermission({
      runId: 'run1',
      toolName: 'Read',
      input: { file_path: 'src/a.ts' },
    });
    expect(result).toEqual({ behavior: 'deny', message: 'unknown session' });
    expect(sink.onDenied).not.toHaveBeenCalled();
  });

  it('leaves an ordinary task run on the task path (full auto still allows an Edit)', async () => {
    const { scheduler, sink } = makeScheduler();
    const input = { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' };
    const result = await scheduler.decidePermission({ runId: 'task1', toolName: 'Edit', input });
    expect(result).toEqual({ behavior: 'allow', updatedInput: input });
    expect(sink.onDenied).not.toHaveBeenCalled();
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

/**
 * A `result` that arrives while a human is still parked on the run.
 *
 * Seen in the wild (22 Aug 2026, "Cloud as a central control for projects", last step):
 * the agent called `AskUserQuestion`, the CLI waited 1800s for the permission relay to
 * answer, gave the tool call up as a timeout, wrote its closing message and emitted
 * `result` — success. `onRunEvent` refused to settle under the parked item, so the run
 * never reached `settle`; `exited` never came either, because the process is deliberately
 * kept alive on an open stdin. Two and a half minutes later the human answered the item,
 * `answerAttention` resolved a promise nobody was reading and wrote `status: 'running'`,
 * and the step spun on the board for hours with its work finished and committed.
 *
 * The rule these pin: **a `result` is the CLI's own statement that it is holding no
 * tool.** Everything the run was holding is abandoned at that moment, the answer has to
 * go down the one channel still connected (the input stream), and the outcome has to be
 * remembered so the run can still settle if nobody ever answers.
 */
describe('Scheduler.onRunEvent — a `result` under a parked question', () => {
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
      saveLimitGate: vi.fn(),
      addComment: vi.fn(),
      getSettings: () => ({ maxAutoRetries: 0, limitJitterMs: 0, concurrency: 1 }),
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const send = vi.fn();
    const stop = vi.fn();
    const sessions = { send, stop, start: vi.fn() } as unknown as SessionManager;
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
    (scheduler as unknown as { runs: Map<string, unknown> }).runs.set('r1', {
      taskId: 't1',
      projectId: 'p',
      runId: 'r1',
      settled: false,
    });
    (scheduler as unknown as { inFlight: Set<string> }).inFlight.add('t1');
    const fire = (event: unknown): Promise<void> =>
      (scheduler as unknown as { onRunEvent: (r: string, e: unknown) => Promise<void> }).onRunEvent(
        'r1',
        event,
      );
    return { scheduler, task, send, stop, emitAttention, fire };
  }

  const ask = {
    runId: 'r1',
    toolName: 'AskUserQuestion',
    input: {
      questions: [
        {
          header: 'Push',
          question: 'Should I push this merge to origin now?',
          multiSelect: false,
          options: [{ label: 'Push now' }, { label: "Don't push" }],
        },
      ],
    },
  };

  const okResult = {
    kind: 'result',
    success: true,
    resultText: 'The merge is committed locally but not pushed.',
    costUsd: null,
    durationMs: null,
    stopReason: 'end_turn',
    terminalReason: null,
  };

  it('releases the tool the CLI has already given up on', async () => {
    const { scheduler, fire } = setup();
    const decision = scheduler.decidePermission(ask);
    let released = false;
    void decision.then(() => {
      released = true;
    });
    await fire(okResult);
    await Promise.resolve();
    // The CLI cannot have ended its turn while still blocked on this call, so holding the
    // promise open past the `result` only keeps a dead request alive until the app exits.
    expect(released).toBe(true);
    const result = (await decision) as { behavior: string };
    expect(result.behavior).toBe('deny');
  });

  it('keeps the question on screen — the human’s answer is still wanted', async () => {
    const { scheduler, task, emitAttention, fire } = setup();
    void scheduler.decidePermission(ask);
    await fire(okResult);
    expect(emitAttention).toHaveBeenCalledTimes(1);
    expect(task.status).toBe('waiting-input'); // parked, not silently finished
  });

  it('delivers a late answer into the live session instead of the dead tool', async () => {
    const { scheduler, send, emitAttention, fire } = setup();
    void scheduler.decidePermission(ask);
    await fire(okResult);

    const item = emitAttention.mock.calls[0][0] as { id: string };
    scheduler.answerAttention(item.id, { decision: 'answers', selections: [['Push now']] });

    // The tool call is gone, so this is the only channel left that reaches the process —
    // and it does reach it: the CLI takes another turn and settles itself as usual.
    expect(send).toHaveBeenCalledWith('r1', expect.stringContaining('→ Push now'));
  });

  it('settles the run when the last parked item is dismissed instead', async () => {
    const { scheduler, task, stop, fire } = setup();
    void scheduler.decidePermission(ask);
    await fire(okResult);

    scheduler.dismissAttentionForCard('t1');

    // Nothing is left that could ever move this run, so the outcome the `result` carried
    // is the outcome — written, not left spinning. (`in-progress`: the orchestrator
    // finishes work, it does not close cards.)
    expect(task.status).toBe('in-progress');
    expect(stop).toHaveBeenCalledWith('r1');
  });

  it('settles rather than claims `running` when the answer can reach nothing', async () => {
    // A parked PERMISSION, abandoned the same way. Unlike a question there is no second
    // channel for it — an approve/deny only means anything to the tool call that asked,
    // and that call is gone — so answering it can start nothing. Before the fix this branch
    // returned early and left the item in the inbox for ever; the run had no terminal path
    // left either way.
    const { scheduler, task, stop, emitAttention, fire } = setup();
    void scheduler.decidePermission({
      runId: 'r1',
      toolName: 'Bash',
      input: { command: 'git push' },
    });
    await fire(okResult);

    const item = emitAttention.mock.calls[0][0] as { id: string };
    scheduler.answerAttention(item.id, { decision: 'approve' });

    expect(task.status).toBe('in-progress');
    expect(stop).toHaveBeenCalledWith('r1');
  });

  it('holds the deferred result open while a SIBLING item on the same run is still parked', async () => {
    // Two independent asks land on the one run — an agent question and, separately, a
    // risky tool wanting approval — the shape `dismissAttentionItem` exists for: a card can
    // hold more than one open item at once, and getting rid of one must not silently decide
    // the other.
    const { scheduler, task, stop, emitAttention, fire } = setup();
    void scheduler.decidePermission(ask);
    void scheduler.decidePermission({
      runId: 'r1',
      toolName: 'Bash',
      input: { command: 'git push' },
    });
    await fire(okResult);

    expect(emitAttention).toHaveBeenCalledTimes(2);
    const [first, second] = emitAttention.mock.calls.map((c) => (c[0] as { id: string }).id);

    scheduler.dismissAttentionItem(first);
    // The Bash approval is still open — the run's held verdict must not be written yet, or
    // the second item would be answering a task no longer waiting for it.
    expect(task.status).toBe('waiting-input');
    expect(stop).not.toHaveBeenCalled();

    scheduler.dismissAttentionItem(second);
    // Nothing is left that could ever move this run, so the `result` the CLI already sent
    // is the outcome now.
    expect(task.status).toBe('in-progress');
    expect(stop).toHaveBeenCalledWith('r1');
  });

  it('still lets a run whose turn is NOT over resume on an answer', () => {
    // The ordinary parked question: no `result` has arrived, the CLI is genuinely blocked
    // on the tool, and answering releases it and puts the task back to `running`.
    const { scheduler, task, emitAttention } = setup();
    void scheduler.decidePermission(ask);
    const item = emitAttention.mock.calls[0][0] as { id: string };
    scheduler.answerAttention(item.id, { decision: 'answers', selections: [['Push now']] });
    expect(task.status).toBe('running');
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
    settingsOverrides: Partial<AppSettings> = {},
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
      getSettings: () => ({ limitJitterMs: 0, concurrency: 1, ...settingsOverrides }),
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

  it('stamps a run with its start time once, and the stamp outlives the clock moving on', () => {
    const { scheduler } = makeAgentScheduler();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    scheduler.runTask('t1');
    now.mockReturnValue(9_000); // later reads must not re-stamp the run against the new time
    expect(scheduler.activeRuns()).toEqual([
      expect.objectContaining({ taskId: 't1', startedAt: 1_000 }),
    ]);
    expect(scheduler.activeRuns()[0]?.startedAt).toBe(1_000);
    now.mockRestore();
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

  describe('--effort (F28.1)', () => {
    const efforts: Partial<AppSettings> = {
      defaultEfforts: { lead: 'high', planner: 'max', workers: 'low', reviewer: 'xhigh' },
    };
    const effortOf = (start: ReturnType<typeof makeAgentScheduler>['start']) =>
      (start.mock.calls[0][0] as StartSessionRequest).effort;

    it('plans at the planner effort: card, else project, else the app default', () => {
      const app = makeAgentScheduler({ agentModel: null }, {}, efforts);
      app.scheduler.runTask('t1');
      expect(effortOf(app.start)).toBe('max');

      const project = makeAgentScheduler(
        { agentModel: null },
        { planningEffort: 'medium', workerEffort: 'high' },
        efforts,
      );
      project.scheduler.runTask('t1');
      expect(effortOf(project.start)).toBe('medium');

      const card = makeAgentScheduler(
        { agentModel: null, agentPlanningEffort: 'low', agentEffort: 'xhigh' },
        { planningEffort: 'medium' },
        efforts,
      );
      card.scheduler.runTask('t1');
      expect(effortOf(card.start)).toBe('low');
    });

    it('works at the workers effort: card, else project, else the app default', () => {
      const work = { agentModel: null, agentMode: 'bypassPermissions' } as const;
      const app = makeAgentScheduler(work, { planningEffort: 'medium' }, efforts);
      app.scheduler.runTask('t1');
      expect(effortOf(app.start)).toBe('low');

      const project = makeAgentScheduler(work, { workerEffort: 'xhigh' }, efforts);
      project.scheduler.runTask('t1');
      expect(effortOf(project.start)).toBe('xhigh');

      const card = makeAgentScheduler(
        { ...work, agentEffort: 'medium', agentPlanningEffort: 'max' },
        { workerEffort: 'xhigh' },
        efforts,
      );
      card.scheduler.runTask('t1');
      expect(effortOf(card.start)).toBe('medium');
    });

    it('runs a step at the workers effort', () => {
      const { scheduler, start } = makeAgentScheduler(
        { agentModel: null, agentMode: 'bypassPermissions', parentTaskId: 'card-1' },
        { workerEffort: 'medium', planningEffort: 'max' },
        efforts,
      );
      scheduler.runTask('t1');
      expect(effortOf(start)).toBe('medium');
    });

    it('sends high when no settings blob carries defaultEfforts', () => {
      const { scheduler, start } = makeAgentScheduler({ agentModel: null });
      scheduler.runTask('t1');
      expect(effortOf(start)).toBe('high');
    });
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

describe('Scheduler — the project queue holds cards that edit the same files', () => {
  const card = (id: string, order: number, plannedFiles: string[]): Task =>
    ({
      id,
      projectId: 'p',
      phase: '',
      title: id,
      status: 'pending',
      sessionId: null,
      order,
      source: 'plan',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      plannedFiles,
    }) as Task;

  function setup(tasks: Task[]) {
    const project = { id: 'p', path: 'C:/w', planPath: 'C:/w/plan.md', concurrency: 2 } as Project;
    const store = {
      getTasks: (projectId: string) => tasks.filter((t) => t.projectId === projectId),
      getProject: (id: string) => (id === 'p' ? project : undefined),
      getTask: (id: string) => tasks.find((t) => t.id === id),
      getSubtasks: () => [],
      updateTask: (id: string, patch: Partial<Task>) => {
        const found = tasks.find((x) => x.id === id);
        if (found) Object.assign(found, patch);
        return found;
      },
      getSettings: () => ({ limitJitterMs: 0, concurrency: 2 }),
      appendTaskEvent: vi.fn(),
      listTaskLinks: () => [],
      listMergeRequests: () => [],
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const start = vi.fn((_req: unknown, _opts: unknown) => ({ runId: 'ignored' }));
    const sessions = { start, stop: vi.fn() } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    const inFlight = (scheduler as unknown as { inFlight: Set<string> }).inFlight;
    return { scheduler, inFlight };
  }

  it('a second overlapping card is not auto-started', () => {
    const { scheduler, inFlight } = setup([
      card('first', 0, ['src/a.ts']),
      card('second', 1, ['src/*.ts']),
    ]);
    scheduler.start('p');
    // Concurrency 2 has room for both — the files are what keep the second back.
    expect([...inFlight]).toEqual(['first']);
  });

  it('starts a card whose files are disjoint from the running one', () => {
    const { scheduler, inFlight } = setup([
      card('first', 0, ['src/a.ts']),
      card('second', 1, ['src/*.ts']),
      card('third', 2, ['docs/readme.md']),
    ]);
    scheduler.start('p');
    expect([...inFlight].sort()).toEqual(['first', 'third']);
  });
});

describe('Scheduler — the global parallel-session cap (maxParallelSessions)', () => {
  const makeTask = (id: string, projectId: string, order: number): Task =>
    ({
      id,
      projectId,
      phase: '',
      title: id,
      status: 'pending',
      sessionId: null,
      order,
      source: 'plan',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
    }) as Task;

  /** Two projects, each with concurrency 2 and two pending tasks of their own. */
  function setup(maxParallelSessions: number) {
    const p1 = { id: 'p1', path: 'C:/w1', planPath: 'C:/w1/plan.md', concurrency: 2 } as Project;
    const p2 = { id: 'p2', path: 'C:/w2', planPath: 'C:/w2/plan.md', concurrency: 2 } as Project;
    const tasks: Task[] = [
      makeTask('p1-a', 'p1', 0),
      makeTask('p1-b', 'p1', 1),
      makeTask('p2-a', 'p2', 0),
      makeTask('p2-b', 'p2', 1),
    ];
    const store = {
      getTasks: (projectId: string) => tasks.filter((t) => t.projectId === projectId),
      getProject: (id: string) => (id === 'p1' ? p1 : id === 'p2' ? p2 : undefined),
      getTask: (id: string) => tasks.find((t) => t.id === id),
      getSubtasks: () => [],
      updateTask: (id: string, patch: Partial<Task>) => {
        const found = tasks.find((x) => x.id === id);
        if (found) Object.assign(found, patch);
        return found;
      },
      getSettings: () => ({ limitJitterMs: 0, concurrency: 2, maxParallelSessions }),
      appendTaskEvent: vi.fn(),
      // A run's exit re-asks the chain (a ready lane may have freed); no arrows here.
      listTaskLinks: () => [],
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const start = vi.fn((_req: unknown, _opts: unknown) => ({ runId: 'ignored' }));
    const stop = vi.fn();
    const sessions = { start, stop } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    return { scheduler, tasks, start, stop };
  }

  it('starts only up to the cap, across every project combined', () => {
    const { scheduler, start } = setup(2);
    scheduler.start('p1'); // fills both of p1's own concurrency slots — 2 runs, at the cap
    scheduler.start('p2'); // held entirely: the cap is already spent, not p2's own queue
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls.every((c) => (c[0] as { cwd: string }).cwd === 'C:/w1')).toBe(true);
  });

  it('does not mark a capped project idle — it still has work waiting on the cap', () => {
    const { scheduler } = setup(2);
    scheduler.start('p1');
    scheduler.start('p2');
    expect(scheduler.schedulerStates()).toEqual(
      expect.arrayContaining([{ projectId: 'p2', state: 'running' }]),
    );
  });

  it('settling a run in one project starts another project’s queued card', () => {
    const { scheduler, start } = setup(2);
    scheduler.start('p1');
    scheduler.start('p2'); // held at the cap — p2-a is queued behind p1's two runs
    expect(start).toHaveBeenCalledTimes(2);

    // Settle one of p1's runs exactly as a real process would: Stop marks it settled,
    // then its `exited` event does the bookkeeping and frees the slot.
    const runs = (scheduler as unknown as { runs: Map<string, { runId: string }> }).runs;
    const p1aRun = [...runs.values()].find(
      (r) => (r as unknown as { taskId: string }).taskId === 'p1-a',
    )!;
    scheduler.stopTask('p1-a');
    (scheduler as unknown as { onRunEvent(runId: string, event: unknown): void }).onRunEvent(
      p1aRun.runId,
      { kind: 'exited', code: 0 },
    );

    // The freed slot went to p2's queued card, not back into p1 (which has nothing left
    // to start — p1-b is already running).
    expect(start).toHaveBeenCalledTimes(3);
    expect((start.mock.calls[2][0] as { cwd: string }).cwd).toBe('C:/w2');
  });

  it('lets a manual start proceed even when the cap is already spent', () => {
    const { scheduler, start } = setup(2);
    scheduler.start('p1'); // spends the whole cap on p1 alone
    expect(start).toHaveBeenCalledTimes(2);

    const outcome = scheduler.startTaskNow('p2-a');
    expect(outcome).not.toHaveProperty('refused');
    expect(start).toHaveBeenCalledTimes(3);
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

describe('Scheduler.startReviewSession (the AI reviewer, F16.8)', () => {
  type Observer = (event: Record<string, unknown> & { kind: string }) => void;

  function makeScheduler(opts: { limit?: LimitState } = {}) {
    const store = {
      getSettings: () => ({ limitJitterMs: 0 }),
      getProject: () => undefined,
      appendTokenUsage: vi.fn(),
      loadLimitGate: () => opts.limit ?? null,
      saveLimitGate: vi.fn(),
      clearLimitGate: vi.fn(),
      listProjects: () => [],
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    let observer: Observer | undefined;
    let startOpts: { runId?: string; permission?: unknown } | undefined;
    const registeredAtStart: boolean[] = [];
    // Filled once the scheduler exists — the fake `start` asks it about the reserved runId.
    const ref: { scheduler?: Scheduler } = {};
    const start = vi.fn(
      (_req: unknown, o: { runId?: string; permission?: unknown; onEvent?: Observer }) => {
        observer = o.onEvent;
        startOpts = o;
        // Inside `start`, before any event: is the review policy already answering this run?
        // A Read allowed here can only come from the review sink — a task run would be unknown.
        void ref
          .scheduler!.decidePermission({
            runId: o.runId!,
            toolName: 'Read',
            input: { file_path: 'a.ts' },
          })
          .then((r) => registeredAtStart.push(r.behavior === 'allow'));
        return { runId: o.runId! };
      },
    );
    const stop = vi.fn();
    const send = vi.fn();
    const sessions = { start, stop, send } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    ref.scheduler = scheduler;
    const gate = { configPath: 'gate.json' } as unknown as PermissionGate;
    scheduler.setPermissionGate(gate);
    const handlers = { taskId: 'card', onDenied: vi.fn(), onResult: vi.fn(), onExit: vi.fn() };
    return {
      scheduler,
      store,
      gate,
      handlers,
      start,
      stop,
      send,
      registeredAtStart,
      emit: (event: Record<string, unknown> & { kind: string }) => observer?.(event),
      startOpts: () => startOpts,
    };
  }

  const request = { prompt: 'review', cwd: 'C:/rw/r1' } as never;

  it('registers the review sink before the session starts, and runs gated', async () => {
    const h = makeScheduler();
    const { runId } = h.scheduler.startReviewSession('p', 'r1', request, h.handlers);
    expect(runId).not.toBe('');
    expect(h.startOpts()?.runId).toBe(runId);
    expect(h.startOpts()?.permission).toBe(h.gate);
    await Promise.resolve();
    expect(h.registeredAtStart).toEqual([true]);
  });

  it('forwards a result without stopping the session, and records its cost', () => {
    const h = makeScheduler();
    h.scheduler.startReviewSession('p', 'r1', request, h.handlers);
    h.emit({ kind: 'result', success: true, resultText: 'x', costUsd: 0.5, usage: null });
    expect(h.handlers.onResult).toHaveBeenCalledTimes(1);
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.store.appendTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'review', projectId: 'p', taskId: 'card' }),
    );
  });

  it('sends the repair turn into the live session, and stops it on request', () => {
    const h = makeScheduler();
    const { runId } = h.scheduler.startReviewSession('p', 'r1', request, h.handlers);
    h.scheduler.sendToReviewSession(runId, 'fix your JSON');
    expect(h.send).toHaveBeenCalledWith(runId, 'fix your JSON');
    h.scheduler.stopReviewSession(runId);
    expect(h.stop).toHaveBeenCalledWith(runId);
    // Gone from the registry: neither a second stop nor a send reaches the session again.
    h.stop.mockClear();
    h.scheduler.stopReviewSession(runId);
    h.scheduler.sendToReviewSession(runId, 'again');
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('is stopped by stop(projectId)', () => {
    const h = makeScheduler();
    const { runId } = h.scheduler.startReviewSession('p', 'r1', request, h.handlers);
    h.scheduler.stop('p');
    expect(h.stop).toHaveBeenCalledWith(runId);
  });

  it('unregisters on exit, so a later tool use fails safe as an unknown session', async () => {
    const h = makeScheduler();
    const { runId } = h.scheduler.startReviewSession('p', 'r1', request, h.handlers);
    h.emit({ kind: 'exited', code: 0 });
    expect(h.handlers.onExit).toHaveBeenCalledTimes(1);
    const result = await h.scheduler.decidePermission({
      runId,
      toolName: 'Read',
      input: { file_path: 'a.ts' },
    });
    expect(result).toEqual({ behavior: 'deny', message: 'unknown session' });
  });

  it('parks itself in the limit gate on a blocking rate-limit event, once', () => {
    const h = makeScheduler();
    const onParked = vi.fn();
    h.scheduler.startReviewSession('p', 'r1', request, { ...h.handlers, onParked });
    h.emit({
      kind: 'rate-limit',
      status: 'allowed_warning',
      rateLimitType: 'five_hour',
      resetsAt: null,
    });
    expect(onParked).not.toHaveBeenCalled();
    expect(h.scheduler.currentLimit()).toBeNull();

    h.emit({ kind: 'rate-limit', status: 'rejected', rateLimitType: 'five_hour', resetsAt: null });
    h.emit({ kind: 'rate-limit', status: 'rejected', rateLimitType: 'five_hour', resetsAt: null });
    expect(onParked).toHaveBeenCalledTimes(1);
    expect(onParked).toHaveBeenCalledWith(expect.stringMatching(/^usage limit reached/));
    expect(h.scheduler.currentLimit()?.parkedReviewIds).toEqual(['r1']);
    h.scheduler.dispose();
  });

  it('reports no blockers with both gates down, and the limit once it is engaged', () => {
    expect(makeScheduler().scheduler.reviewBlockers()).toEqual({ limit: null, signin: null });
    const h = makeScheduler({
      limit: {
        limitType: 'rolling',
        resetsAt: null,
        resumeAt: Date.now() + 3_600_000,
        parkedTaskIds: [],
      },
    });
    h.scheduler.restoreLimitGate();
    const blockers = h.scheduler.reviewBlockers();
    expect(blockers.limit).toMatch(/usage limit/);
    expect(blockers.signin).toBeNull();
    h.scheduler.dispose();
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

  it('offers a pull-request-specific retry for a failed "open a PR when finished", plus an AI fix, never retry-integration', () => {
    const actions = failureActionsFor('pull-request');
    expect(actions).toEqual([
      FAILURE_ACTION.retryPullRequest,
      FAILURE_ACTION.aiFix,
      FAILURE_ACTION.leaveBranch,
      FAILURE_ACTION.cleanup,
      FAILURE_ACTION.markDone,
    ]);
    // The bug this kind exists to fix: a failed PR open must never offer the button that
    // merges locally instead of opening the pull request the card actually asked for — not
    // even as a fallback, since that is exactly what reintroduced the divergence this kind
    // was created to close.
    expect(actions).not.toContain(FAILURE_ACTION.retryIntegration);
    expect(actions).not.toContain(FAILURE_ACTION.retryFresh);
  });

  it('offers only the gate-specific actions for a failed gate — no worktree/PR actions', () => {
    const actions = failureActionsFor('gate');
    expect(actions).toEqual([
      FAILURE_ACTION.runGateAgain,
      FAILURE_ACTION.sendBackToAgent,
      FAILURE_ACTION.skipGate,
    ]);
    expect(actions).not.toContain(FAILURE_ACTION.retry);
    expect(actions).not.toContain(FAILURE_ACTION.retryIntegration);
    expect(actions).not.toContain(FAILURE_ACTION.retryPullRequest);
    expect(actions).not.toContain(FAILURE_ACTION.cleanup);
    expect(actions).not.toContain(FAILURE_ACTION.markDone);
  });

  it('offers only Trust and run / Decline for a gate awaiting trust (F8.8)', () => {
    const actions = failureActionsFor('gate-trust');
    expect(actions).toEqual([GATE_TRUST_ACTION.trust, GATE_TRUST_ACTION.decline]);
    expect(actions).not.toContain(FAILURE_ACTION.runGateAgain);
    expect(actions).not.toContain(FAILURE_ACTION.sendBackToAgent);
    expect(actions).not.toContain(FAILURE_ACTION.skipGate);
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
      startedAt: 1_000,
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
    expect(scheduler.activeRuns()).toEqual([
      { taskId: 't1', runId: 'r1', startedAt: expect.any(Number) },
    ]);

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

  /**
   * F16.9: an AI review's `result` is read for the same two account-wide walls, and a wall
   * parks the review in the gate — beside every task run, because the wall is the account's.
   */
  describe('an AI review behind a wall (F16.9)', () => {
    const reviewResult = (resultText: string, success = false) =>
      ({ ...failResult, success, resultText, usage: null }) as never;

    it('classifies a sign-in failure as the sign-in wall', async () => {
      const { scheduler } = setup(1);
      const wall = await scheduler.classifyReviewWall(
        'rv1',
        reviewResult('Failed to authenticate: token expired'),
      );
      expect(wall).toEqual({ gate: 'signin', reason: expect.any(String) });
    });

    it('classifies an epoch-stamped limit as the limit wall, with its reset', async () => {
      const { scheduler } = setup(1);
      const wall = await scheduler.classifyReviewWall(
        'rv1',
        reviewResult('Claude AI usage limit reached|1761400000'),
      );
      expect(wall).toMatchObject({ gate: 'limit', signal: { resetsAt: 1761400000 } });
    });

    it('believes a limit said only in prose when there is no probe to ask', async () => {
      const { scheduler } = setup(1);
      const wall = await scheduler.classifyReviewWall(
        'rv1',
        reviewResult('Claude AI usage limit reached'),
      );
      expect(wall?.gate).toBe('limit');
      // Nothing was engaged: the park is the caller's to make, after it re-checks `settled`.
      expect(scheduler.currentLimit()).toBeNull();
      const held = (scheduler as unknown as { probingLimit: Set<string> }).probingLimit;
      expect(held.size).toBe(0);
    });

    it('answers no gate for a prose limit /usage contradicts', async () => {
      const { scheduler } = setup(1);
      scheduler.setUsageProbe(() => Promise.resolve({ sessionPct: 20, weeklyPct: 3 }));
      const wall = await scheduler.classifyReviewWall(
        'rv1',
        reviewResult('Claude AI usage limit reached'),
      );
      expect(wall).toEqual({ gate: null, reason: expect.stringMatching(/usage/) });
    });

    it('finds no wall in a successful result', async () => {
      const { scheduler } = setup(1);
      expect(
        await scheduler.classifyReviewWall(
          'rv1',
          reviewResult('Claude AI usage limit reached', true),
        ),
      ).toBeNull();
    });

    it('parks the review in the limit gate and parks the live task run as well', async () => {
      const { scheduler, task } = setup(1);
      const wall = await scheduler.classifyReviewWall(
        'rv1',
        reviewResult('Claude AI usage limit reached|1761400000'),
      );
      const reason = scheduler.parkReview('rv1', wall as never);
      expect(reason).toMatch(/^usage limit reached — resumes at /);
      expect(scheduler.currentLimit()).toMatchObject({
        parkedTaskIds: ['t1'],
        parkedReviewIds: ['rv1'],
      });
      expect(task.status).toBe('blocked-by-limit');
      // A second review behind the standing gate just joins it.
      scheduler.parkReview('rv2', { gate: 'limit' });
      expect(scheduler.currentLimit()?.parkedReviewIds).toEqual(['rv1', 'rv2']);
      scheduler.unparkReview('rv1');
      expect(scheduler.currentLimit()?.parkedReviewIds).toEqual(['rv2']);
      scheduler.dispose();
    });

    it('parks the review in the sign-in gate and parks the live task run as well', () => {
      const { scheduler, task } = setup(1);
      const reason = scheduler.parkReview('rv1', { gate: 'signin', reason: 'token expired' });
      expect(reason).toBe('token expired');
      expect(scheduler.currentAuth()).toMatchObject({
        parkedTaskIds: ['t1'],
        parkedReviewIds: ['rv1'],
      });
      expect(task.status).toBe('pending');
    });

    it('hands the parked reviews to the resume handler as each gate lifts', () => {
      const { scheduler } = setup(1);
      const resume = vi.fn();
      scheduler.setReviewParkHandler({ resume });
      scheduler.parkReview('rv1', { gate: 'limit' });
      scheduler.resumeLimitNow();
      expect(resume).toHaveBeenCalledWith(['rv1']);

      resume.mockClear();
      scheduler.parkReview('rv2', { gate: 'signin', reason: 'token expired' });
      scheduler.signedIn();
      expect(resume).toHaveBeenCalledWith(['rv2']);
    });

    it('buffers the ids until a handler is set, and hands them over once', () => {
      const { scheduler } = setup(1);
      scheduler.parkReview('rv1', { gate: 'limit' });
      scheduler.resumeLimitNow(); // the gate forgets rv1 here — nothing is listening yet
      expect(scheduler.currentLimit()).toBeNull();

      const resume = vi.fn();
      scheduler.setReviewParkHandler({ resume });
      expect(resume).toHaveBeenCalledTimes(1);
      expect(resume).toHaveBeenCalledWith(['rv1']);
      scheduler.setReviewParkHandler({ resume });
      expect(resume).toHaveBeenCalledTimes(1);
    });

    it('hands limit-parked reviews to the runner even when the sign-in gate is still up', () => {
      const { scheduler } = setup(1);
      const resume = vi.fn();
      scheduler.setReviewParkHandler({ resume });
      scheduler.parkReview('rv1', { gate: 'limit' });
      scheduler.parkReview('rv2', { gate: 'signin', reason: 'token expired' });
      scheduler.resumeLimitNow();
      // The runner re-checks `reviewBlockers()` and re-parks rv1 behind sign-in itself.
      expect(resume).toHaveBeenCalledWith(['rv1']);
      expect(scheduler.currentAuth()?.parkedReviewIds).toEqual(['rv2']);
    });
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
      /** The setting that decides whether a failure is re-queued or parked for a human. */
      maxAutoRetries?: number;
      /** Hashes of gate commands already trusted on this desktop (F8.8) — defaults to none,
       *  so a gate step's `stepSpec.command` must be seeded here before it can really run. */
      trustedGateCommands?: string[];
      /** `addSubtask` behaves like the real store: it refuses a step as a parent and
       *  creates a findable `pending` row. Off by default — most cases only read `added`. */
      realSubtasks?: boolean;
      /** The project's "Approve clean plans automatically" switch (TM's auto-approve). */
      autoApprovePlans?: boolean;
      /** Clamp on how many steps an auto-approved plan may create; defaults to 6. */
      autoApproveMaxSteps?: number;
      /** What `store.listMergeRequests()` reports — the overlap check's "unmerged PR" feed. */
      mergeRequests?: MergeRequest[];
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
      autoApprovePlans: opts?.autoApprovePlans ?? false,
      autoApproveMaxSteps: opts?.autoApproveMaxSteps ?? 6,
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
    const replaced: Array<{
      round: number;
      steps: Array<{ title: string; description?: string | null }>;
    }> = [];
    const comments: string[] = [];
    /** F8.8: mutable so `saveSettings` → `getSettings` round-trips a granted trust, the way
     *  the real store does — `trustGateCommand`'s re-run depends on seeing it. */
    let trustedGateCommands = opts?.trustedGateCommands ?? [];
    const store = {
      getTask: (id: string) => byId.get(id),
      getProject: (id: string) => (id === 'agent-1' ? agentProject : undefined),
      listProjects: () => [agentProject],
      getTasks: () => [parent, ...children],
      getSubtasks: (parentId: string) => children.filter((c) => c.parentTaskId === parentId),
      getTaskActivity: () => [],
      addSubtask: (
        parentId: string,
        input: { title: string; description?: string | null; round?: number },
      ) => {
        if (!opts?.realSubtasks) {
          added.push(input);
          return undefined;
        }
        // The real store's two rules: steps are one level deep, and a step it creates is a
        // `pending` row that the chain can then find.
        if (byId.get(parentId)?.parentTaskId) return undefined;
        added.push(input);
        const step = {
          ...children[0],
          id: `new-${added.length}`,
          title: input.title,
          description: input.description ?? null,
          status: 'pending',
          sessionId: null,
          agentPlan: null,
          order: children.length,
          planRound: input.round ?? 1,
          parentTaskId: parentId,
        } as unknown as Task;
        children.push(step);
        byId.set(step.id, step);
        return step;
      },
      replaceSubtaskRound: (
        _p: string,
        round: number,
        steps: Array<{ title: string; description?: string | null }>,
      ) => {
        replaced.push({ round, steps });
        return [];
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
      // The one writer of `plannedFiles`; the real store also normalises and stores an
      // empty set as NULL, which these cases never depend on.
      setTaskPlannedFiles: (id: string, files: readonly string[]) => {
        const task = byId.get(id);
        if (task) task.plannedFiles = files.length ? [...files] : null;
        return task;
      },
      appendTaskEvent: vi.fn(),
      appendTokenUsage: vi.fn(),
      // `autoIntegrate` on: these cases are ABOUT the integration path, and Phase 17 made
      // merging manual by default. The manual case has its own test below.
      getSettings: () => ({
        maxAutoRetries: opts?.maxAutoRetries ?? 0,
        limitJitterMs: 0,
        concurrency: 1,
        autoIntegrate: opts?.autoIntegrate ?? true,
        // F8.8: untrusted by default — a gate's own trust tests seed this, or grant trust
        // through `saveSettings` below, which this reads back (unlike the other settings
        // here, a real `trustGateCommand` → `start()` round trip depends on seeing it).
        trustedGateCommands,
      }),
      saveSettings: vi.fn((next: { trustedGateCommands: string[] }) => {
        trustedGateCommands = next.trustedGateCommands;
      }),
      // The usage-limit gate persists itself on every change; these cases drive it, so the
      // two ends of that have to exist. `loadLimitGate` answering null is also the state
      // the restart case below is about: statuses left parked with no gate behind them.
      saveLimitGate: () => undefined,
      loadLimitGate: () => opts?.savedLimit ?? null,
      // The overlap check's "unmerged PR" feed (`planVerdictFor`) — every `plan-approval`
      // now computes a verdict, whether or not auto-approve is on, so every case here needs
      // this to exist even when it has nothing to report.
      listMergeRequests: () => opts?.mergeRequests ?? [],
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const prepared: Array<{ taskId: string; owner: string }> = [];
    /** Whether each `prepare` was told this run is resolving a rebase the app paused. */
    const resuming: boolean[] = [];
    /** Whether each `prepare` was told to hold the branch rebase off (a chat reply). */
    const skipSyncs: boolean[] = [];
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
        prepOpts?: { resumingRebase?: boolean; skipSync?: boolean },
      ) => {
        prepared.push({ taskId: task.id, owner });
        resuming.push(prepOpts?.resumingRebase === true);
        skipSyncs.push(prepOpts?.skipSync === true);
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
      skipSyncs,
      integrated,
      finished,
      added,
      replaced,
      comments,
      seedRun,
      fire,
      store,
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
   * F2.6: the first step is the human's own Start, and the chain's own advance into the
   * next step is `advanceSubtasks` calling `startTask` with `origin: 'chain'` — see
   * `docs/plan/feature-roadmap/F2-activity-dashboard.md`.
   */
  it('records a human origin for the first step and a chain origin for the one the chain advances to', async () => {
    const { scheduler, fire, start } = setup();
    const { rows, append } = createFakeAppendActivity();
    scheduler.setActivityRecorder(createActivityRecorder({ append }));

    scheduler.runTask('s1');
    await flush();
    const [, firstOpts] = start.mock.calls[0] as [unknown, { runId: string }];
    await fire(firstOpts.runId, okResult);
    await flush();

    const started = rows.filter((r) => r.kind === 'run-started');
    expect(started).toHaveLength(2);
    expect(started.find((r) => r.taskId === 's1')?.origin).toBe('human');
    expect(started.find((r) => r.taskId === 's2')?.origin).toBe('chain');

    const [, secondOpts] = start.mock.calls[1] as [unknown, { runId: string }];
    await fire(secondOpts.runId, okResult);

    const finished = rows.filter((r) => r.kind === 'run-finished');
    expect(finished.find((r) => r.taskId === 's2')?.origin).toBe('chain');
  });

  /**
   * A plan step is never a chat reply, so the pre-run sync must not be held off for it the
   * way it is for one — see `Scheduler.prepareAndLaunch — the pre-run sync’s scheduler-side
   * wiring` for the chat-reply case this contrasts with.
   */
  it('does not hold the branch rebase off for a plan step', async () => {
    const { scheduler, skipSyncs } = setup();
    scheduler.runTask('s2');
    await flush();
    expect(skipSyncs).toEqual([false]);
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

  it('landing widens the card’s file set by what its branch changed, read before it merges', async () => {
    const { parent, children, integrated, seedRun, fire } = setup();
    parent.plannedFiles = ['apps/client/src/main/*.ts', 'docs/plan.md'];
    const changed = vi.mocked(changedSinceMergeBase);
    changed.mockClear();
    changed.mockImplementationOnce(() => {
      // Read while the branch is still unmerged — after the merge the range is empty.
      expect(integrated).toEqual([]);
      return Promise.resolve(['apps/client/src/main/store.ts', 'Docs\\Plan.md', 'README.md']);
    });
    children[0].status = 'done';
    seedRun('r2', 's2');
    fire('r2', okResult);
    await flush();

    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0].slice(0, 3)).toEqual(['C:/repos/checkout', 'main', 'orch/t1']);
    // The union, normalised: the plan's glob is kept for work not written yet.
    expect(parent.plannedFiles).toEqual([
      'apps/client/src/main/*.ts',
      'docs/plan.md',
      'apps/client/src/main/store.ts',
      'readme.md',
    ]);
    // A step's files are its parent's — the step itself never gets a set.
    expect(children[1].plannedFiles).toBeUndefined();
    expect(integrated).toEqual([{ branch: 'orch/t1', base: 'main' }]);
  });

  it('landing without auto-merge still records the branch’s files on the card', async () => {
    const { parent, integrated, seedRun, fire } = setup([], { autoIntegrate: false });
    vi.mocked(changedSinceMergeBase).mockImplementationOnce(() =>
      Promise.resolve(['src/export.ts']),
    );
    seedRun('r1', 't1');
    fire('r1', okResult);
    await flush();

    expect(integrated).toEqual([]);
    expect(parent.plannedFiles).toEqual(['src/export.ts']);
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

    /**
     * The reported bug (22 Aug 2026), and the fourth hole in the same wall: **a step
     * parked by the gate and then settled over by its own `result` 13ms later.**
     *
     * The live trail, off `task_events` for "Port the Mongo-to-SQL migration tooling":
     * `rate_limit_event` (rejected, `resetsAt` 21:30) at `.697`, `engageLimit` parks the
     * step and notes "…picks up by itself then — nothing to press" at `.698`, and the
     * turn's own `result` lands at `.710`. That result names the wall only as *"You've hit
     * your session limit · resets 11:30pm (Europe/Warsaw)"* — a sentence
     * `detectLimitFailure` does not read (`LIMIT_PHRASE` wants "usage limit reached") —
     * over a bare `api_error` label it deliberately ignores. So `case 'result'` settled it
     * as this card's own failure: `handleRunFailure` wrote the step back to `pending` and
     * queued a retry, over the park written 13ms earlier.
     *
     * Five hours later the reset fired and `resumeParked` asked its one question — is this
     * task still `blocked-by-limit`? It was `pending`, so it was skipped in silence, and
     * the chain stopped for good at 8 of 17 with a gate that had held its id all along.
     */
    it('does not settle a step over the park its own gate has just written', async () => {
      // The live setting, and what makes this the destructive shape: a queued retry is what
      // rewrites the status. With retries off the same interleaving parks it for a human,
      // which is wrong in the same way and just as unresumable.
      const h = setup(undefined, { maxAutoRetries: 1 });
      h.seedRun('r1', 's1');

      h.fire('r1', limited); // the CLI's structured signal, first
      expect(h.children[0].status).toBe('blocked-by-limit');

      await h.fire('r1', {
        kind: 'result',
        success: false,
        resultText: "You've hit your session limit · resets 11:30pm (Europe/Warsaw)",
        costUsd: null,
        durationMs: null,
        stopReason: 'stop_sequence',
        terminalReason: 'api_error',
      });

      // The park stands: the run's outcome was decided by the gate, and a message already
      // in flight when that decision was made does not get to re-decide it.
      expect(h.children[0].status).toBe('blocked-by-limit');
      expect(h.emitAttention).not.toHaveBeenCalled();
      const privates = h.scheduler as unknown as {
        retryQueue: Set<string>;
        attempts: Map<string, number>;
      };
      expect(privates.retryQueue.size).toBe(0);
      expect(privates.attempts.size).toBe(0);

      h.fire('r1', { kind: 'exited', code: 1 });
      expect(h.prepared).toEqual([]); // nothing relaunched into the wall

      h.scheduler.resumeLimitNow(); // the reset, five hours later
      await flush();
      expect(h.prepared).toEqual([{ taskId: 's1', owner: 't1' }]);
    });

    /**
     * The cheap half of the same rule, read from the other end.
     *
     * The gate's id set is what remembers this work across the reset; a status is a much
     * weaker fact that a dozen paths write. `pending` on a task the gate is holding can
     * only mean the ENGINE re-queued it underneath the park — the board's own menu cannot
     * set or clear `blocked-by-limit` — so it is still ours to resume, not a reason to drop
     * it without a word.
     */
    it('still resumes a parked step whose status was re-queued underneath the gate', async () => {
      const h = setup();
      const gate = gateOf(h.scheduler);
      gate.engage(limited, ['s1']);
      h.children[0].status = 'pending'; // whatever wrote over the park

      h.scheduler.resumeLimitNow();
      await flush();
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
   * TM-444, from TM-227: a STEP's session found a hole in the plan, wrote a plan of its own
   * and the human approved it. Approval appended every step to the STEP, the store refused
   * each one (steps are one level deep), the step sat `in-progress` with no run, and the
   * chain start was queued under the card but drained under the step — so nothing moved
   * and nothing said why.
   */
  describe('a plan approved from inside a STEP', () => {
    const replanFromStep = [
      { id: 's1', title: 'Add the helpers', status: 'done' as const },
      { id: 's2', title: 'Verification', status: 'running' as const },
    ];
    const plan = '## Build the renderer\nfirst\n\n## Verify end to end\nsecond';

    async function approveFromStep(h: ReturnType<typeof setup>, text: string) {
      h.seedRun('r0', 's2');
      void h.scheduler.decidePermission({
        runId: 'r0',
        toolName: 'ExitPlanMode',
        input: { plan: text },
      } as never);
      await Promise.resolve();
      const item = h.emitAttention.mock.calls.at(-1)?.[0] as {
        id: string;
        steps: string[];
        prompt: string;
      };
      h.scheduler.answerAttention(item.id, { decision: 'approve' });
      await Promise.resolve();
      return item;
    }

    it("puts the step's plan on the CARD and closes the step that asked", async () => {
      const h = setup(replanFromStep, { realSubtasks: true });
      const item = await approveFromStep(h, plan);
      // The inbox previews what approval will really create, and says who asked.
      expect(item.steps).toEqual(['Build the renderer', 'Verify end to end']);
      expect(item.prompt).toContain('"Verification" re-planned the card');
      const created = h.children.filter((c) => c.id.startsWith('new-'));
      expect(created.map((c) => [c.title, c.parentTaskId, c.planRound])).toEqual([
        ['Build the renderer', 't1', 2],
        ['Verify end to end', 't1', 2],
      ]);
      expect(h.children.find((c) => c.id === 's2')?.status).toBe('done');
      expect(h.comments.join('\n')).toContain('"Verification" re-planned the card');
      expect(h.stop).toHaveBeenCalledWith('r0');
      expect(h.parent.status).toBe('in-progress');
    });

    it('starts the first new step once the step that planned it has exited', async () => {
      const h = setup(replanFromStep, { realSubtasks: true });
      await approveFromStep(h, plan);
      expect(h.prepared).toEqual([]); // still waiting for the planner to free the worktree
      await h.fire('r0', { kind: 'exited', code: 1 });
      await flush();
      expect(h.prepared).toEqual([{ taskId: 'new-1', owner: 't1' }]);
    });

    it('a plan that adds nothing leaves the asking step stopped, so Resume is offered', async () => {
      const h = setup(replanFromStep, { realSubtasks: true });
      await approveFromStep(h, '## Add the helpers\nx\n\n## Verification\ny');
      expect(h.children.filter((c) => c.id.startsWith('new-'))).toEqual([]);
      expect(h.children.find((c) => c.id === 's2')?.status).toBe('stopped');
      expect(h.comments.join('\n')).toContain('Resume runs it again');
    });
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

  /**
   * Re-planning a FUTURE phase in place (Phase 20): a run started with `replaceRound` set
   * asks for a plan that REPLACES one round rather than appending after it, and approval
   * has to re-check the round is still untouched — a human or the chain itself could have
   * started it in the time the plan sat waiting for a decision.
   */
  describe('approving a plan that replaces a round in place', () => {
    const setReplaceRound = (h: ReturnType<typeof setup>, round: number): void => {
      (h.scheduler as unknown as { runs: Map<string, { replaceRound?: number }> }).runs.get(
        'r0',
      )!.replaceRound = round;
    };

    async function approveReplacement(h: ReturnType<typeof setup>, plan: string): Promise<void> {
      h.seedRun('r0', 't1');
      setReplaceRound(h, 2);
      void h.scheduler.decidePermission({
        runId: 'r0',
        toolName: 'ExitPlanMode',
        input: { plan },
      } as never);
      await Promise.resolve();
      const item = h.emitAttention.mock.calls.at(-1)?.[0] as { id: string };
      h.scheduler.answerAttention(item.id, { decision: 'approve' });
      await Promise.resolve();
    }

    it('swaps the round via replaceSubtaskRound, not addSubtask, when the round is untouched', async () => {
      const h = setup([
        { id: 's1', title: 'Reproduce it', status: 'done', planRound: 1 },
        { id: 's2', title: 'Old A', status: 'pending', planRound: 2 },
        { id: 's3', title: 'Old B', status: 'stopped', planRound: 2 },
      ]);
      await approveReplacement(h, '## New A\nx\n\n## New B\ny');
      expect(h.replaced).toHaveLength(1);
      expect(h.replaced[0].round).toBe(2);
      expect(h.replaced[0].steps.map((s) => s.title)).toEqual(['New A', 'New B']);
      expect(h.added).toEqual([]);
      expect(h.comments.some((c) => c.includes('Approved plan (phase 2, re-planned)'))).toBe(true);
    });

    it('appends as a new round and comments, when the round already started', async () => {
      const h = setup([
        { id: 's1', title: 'Reproduce it', status: 'done', planRound: 1 },
        { id: 's2', title: 'Old A', status: 'running', planRound: 2 },
      ]);
      await approveReplacement(h, '## New A\nx');
      expect(h.replaced).toEqual([]);
      expect(h.added.map((s) => ({ title: s.title, round: s.round }))).toEqual([
        { title: 'New A', round: 3 },
      ]);
      expect(
        h.comments.some((c) => c.includes('Phase 2 had started') && c.includes('phase 3')),
      ).toBe(true);
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

  describe('auto-approving a clean plan (the project switch)', () => {
    const CLEAN_PLAN =
      '## Reproduce it\nfirst\nAcceptance: run the repro script and confirm it fails.\n\n' +
      '## Fix it\nsecond\nTests: add a unit test covering the fix.\n\n' +
      '## Critical files\n- apps/client/src/main/scheduler.ts\n';

    it('auto-approves a clean plan when the switch is on', async () => {
      const { scheduler, comments, added, emitAttention, seedRun } = setup([], {
        autoApprovePlans: true,
      });
      seedRun('r0', 't1');
      let decision: { behavior: string; message?: string } | undefined;
      void scheduler
        .decidePermission({
          runId: 'r0',
          toolName: 'ExitPlanMode',
          input: { plan: CLEAN_PLAN },
        } as never)
        .then((d) => {
          decision = d as { behavior: string; message?: string };
        });
      await Promise.resolve();

      expect(scheduler.listAttention()).toEqual([]);
      expect(emitAttention).not.toHaveBeenCalled();
      expect(added.map((s) => s.title)).toEqual(['Reproduce it', 'Fix it']);
      expect(decision?.behavior).toBe('deny');
      expect(decision?.message).toContain('do NOT implement it here');
      expect(comments.some((c) => c.startsWith('Plan approved automatically'))).toBe(true);
    });

    it('writes the plan’s Critical files to the card as its file set when it is approved', async () => {
      const { scheduler, parent, seedRun } = setup([], { autoApprovePlans: true });
      seedRun('r0', 't1');
      void scheduler.decidePermission({
        runId: 'r0',
        toolName: 'ExitPlanMode',
        input: { plan: CLEAN_PLAN },
      } as never);
      await Promise.resolve();

      expect(parent.plannedFiles).toEqual(['apps/client/src/main/scheduler.ts']);
    });

    it('writes a step’s approved plan to its PARENT, never to the step', async () => {
      const { scheduler, parent, children, seedRun } = setup([{ id: 's1' }], {
        autoApprovePlans: true,
      });
      seedRun('r0', 's1');
      void scheduler.decidePermission({
        runId: 'r0',
        toolName: 'ExitPlanMode',
        input: { plan: CLEAN_PLAN },
      } as never);
      await Promise.resolve();

      expect(parent.plannedFiles).toEqual(['apps/client/src/main/scheduler.ts']);
      expect(children[0].plannedFiles).toBeUndefined();
    });

    it('raises a plan-approval item, naming the failed check, when a check fails', async () => {
      const PLAN_WITH_OPEN_QUESTION =
        '## Reproduce it\nfirst\nAcceptance: run the repro script and confirm it fails.\n\n' +
        '## Fix it\nsecond\nTests: add a unit test covering the fix.\n\n' +
        '## Open questions\n- What format should the export use?\n\n' +
        '## Critical files\n- apps/client/src/main/scheduler.ts\n';
      const { scheduler, added, emitAttention, seedRun } = setup([], { autoApprovePlans: true });
      seedRun('r0', 't1');
      void scheduler.decidePermission({
        runId: 'r0',
        toolName: 'ExitPlanMode',
        input: { plan: PLAN_WITH_OPEN_QUESTION },
      } as never);
      await Promise.resolve();

      expect(emitAttention).toHaveBeenCalledTimes(1);
      const item = emitAttention.mock.calls[0][0] as {
        kind: string;
        prompt: string;
        planCheck?: { pass: boolean };
      };
      expect(item.kind).toBe('plan-approval');
      expect(item.prompt).toContain('Not approved automatically — No open question');
      expect(item.planCheck?.pass).toBe(false);
      expect(added).toEqual([]);
    });

    it('fails the critical-files check, naming the sibling card, when a running card shares a file', async () => {
      const { scheduler, store, added, emitAttention, seedRun } = setup([], {
        autoApprovePlans: true,
      });
      const otherCard = {
        id: 'other1',
        projectId: 'personal',
        title: 'Other card in flight',
        status: 'in-progress',
        parentTaskId: null,
        agentProjectId: 'agent-1',
        agentPlan: '## Critical files\n- apps/client/src/main/scheduler.ts\n',
      } as unknown as Task;
      const baseGetTask = store.getTask.bind(store);
      (store as unknown as { getTask: typeof store.getTask }).getTask = (id: string) =>
        id === 'other1' ? otherCard : baseGetTask(id);

      seedRun('r0', 't1');
      seedRun('r-other', 'other1', 'other1');
      void scheduler.decidePermission({
        runId: 'r0',
        toolName: 'ExitPlanMode',
        input: { plan: CLEAN_PLAN },
      } as never);
      await Promise.resolve();

      expect(emitAttention).toHaveBeenCalledTimes(1);
      const item = emitAttention.mock.calls[0][0] as {
        prompt: string;
        planCheck?: PlanVerdict;
      };
      expect(item.prompt).toContain('Other card in flight');
      expect(item.planCheck?.pass).toBe(false);
      // The Inbox's overlap warning reads this straight off the stored item.
      expect(item.planCheck?.overlaps).toEqual([
        {
          title: 'Other card in flight',
          why: 'running',
          files: ['apps/client/src/main/scheduler.ts'],
        },
      ]);
      expect(added).toEqual([]);
    });

    it('raises today’s item with a passing verdict and no prefix when the switch is off', async () => {
      const { scheduler, added, emitAttention, seedRun } = setup([]);
      seedRun('r0', 't1');
      void scheduler.decidePermission({
        runId: 'r0',
        toolName: 'ExitPlanMode',
        input: { plan: CLEAN_PLAN },
      } as never);
      await Promise.resolve();

      expect(emitAttention).toHaveBeenCalledTimes(1);
      const item = emitAttention.mock.calls[0][0] as {
        prompt: string;
        planCheck?: { pass: boolean };
      };
      expect(item.planCheck?.pass).toBe(true);
      expect(item.prompt).not.toContain('Not approved automatically');
      expect(added).toEqual([]); // nothing created yet — the human hasn't approved it
    });

    it('does not double-raise from the event-stream fallback after an auto-approval', async () => {
      const { scheduler, emitAttention, seedRun, fire } = setup([], { autoApprovePlans: true });
      seedRun('r0', 't1');
      void scheduler.decidePermission({
        runId: 'r0',
        toolName: 'ExitPlanMode',
        input: { plan: CLEAN_PLAN },
      } as never);
      await Promise.resolve();
      expect(emitAttention).not.toHaveBeenCalled(); // auto-approved; nothing was ever raised

      fire('r0', { kind: 'tool-use', name: 'ExitPlanMode', id: 'x', input: { plan: CLEAN_PLAN } });
      await Promise.resolve();
      expect(emitAttention).not.toHaveBeenCalled();
    });
  });

  /**
   * Phase 19 continued: the planner runs beside a live chain now, so its LAST step can
   * finish while a re-plan for the card is still being drafted. Landing right then would
   * risk merging (or offering to merge) a branch the human is about to hand more steps to —
   * so `settle` holds it (`heldLandings`) instead, and `landHeld` replays it, via the shared
   * `landWork`, once the plan actually resolves one way or another.
   */
  describe("holding a chain's landing behind a pending plan (Phase 19 continued)", () => {
    /** A live re-plan run on the CARD — on its own enough to make `replanPending` true. */
    const seedReplanRun = (h: ReturnType<typeof setup>, runId = 'r-plan'): void => {
      (h.scheduler as unknown as { runs: Map<string, unknown> }).runs.set(runId, {
        taskId: h.parent.id,
        projectId: 'agent-1',
        runId,
        settled: false,
        replan: true,
      });
    };

    /** A plan-approval item sitting in the inbox — the other thing `replanPending` reads. */
    const raiseApprovalItem = (h: ReturnType<typeof setup>, id = 'inbox-plan'): void => {
      (h.scheduler as unknown as { attention: Map<string, unknown> }).attention.set(id, {
        id,
        kind: 'plan-approval',
        runId: 'r-plan',
        taskId: h.parent.id,
        projectId: 'agent-1',
      });
    };

    /** Finish the chain's last step while a re-plan is pending on the card — the hold itself. */
    async function holdLastStep(h: ReturnType<typeof setup>): Promise<void> {
      h.children[0].status = 'done';
      seedReplanRun(h);
      h.seedRun('r2', 's2');
      h.fire('r2', okResult);
      await flush();
    }

    it('the last step finishing under a pending plan does not integrate and does not clear the card’s session', async () => {
      const h = setup();
      h.parent.sessionId = 'planner-session';
      await holdLastStep(h);

      expect(h.integrated).toEqual([]);
      expect(h.children[1].status).toBe('done');
      expect(h.parent.sessionId).toBe('planner-session');
      expect((h.parent as unknown as { chainLandedAt?: number }).chainLandedAt).toBeFalsy();
      // No chain hand-back yet — that only happens once the landing actually lands.
      expect(h.comments).toEqual([]);
      const noted = (
        h.store as unknown as { appendTaskEvent: ReturnType<typeof vi.fn> }
      ).appendTaskEvent.mock.calls.some((c) =>
        (c[3] as { text?: string } | undefined)?.text?.includes('waiting for the plan in progress'),
      );
      expect(noted).toBe(true);
    });

    it('approving a plan with new steps continues the chain into the new phase with no landing in between', async () => {
      const h = setup(undefined, { autoIntegrate: false });
      raiseApprovalItem(h);
      await holdLastStep(h);

      h.parent.agentPlan = '## Extra step\ndo more';
      h.scheduler.answerAttention('inbox-plan', { decision: 'approve' });
      await flush();

      expect(h.added.map((s) => s.title)).toEqual(['Extra step']);
      // The old held branch never landed — it just keeps growing under the new step instead.
      expect(h.integrated).toEqual([]);
      expect(h.comments.join(' ')).not.toContain('Plan complete');
      expect(
        (h.scheduler as unknown as { heldLandings: Map<string, unknown> }).heldLandings.size,
      ).toBe(0);
    });

    it('approving a plan that adds nothing lands the held chain (summary comment filed, readyToIntegrate set)', async () => {
      // Titled to match the card's default `agentPlan` (set by `setup`) verbatim, so
      // approving it proposes the same two steps the card already has — nothing fresh.
      const h = setup(
        [
          { id: 's1', title: 'Reproduce it' },
          { id: 's2', title: 'Fix it' },
        ],
        { autoIntegrate: false },
      );
      raiseApprovalItem(h);
      await holdLastStep(h);

      h.scheduler.answerAttention('inbox-plan', { decision: 'approve' });
      await flush();

      expect(h.added).toEqual([]);
      expect(
        (h.scheduler as unknown as { readyToIntegrate: Map<string, unknown> }).readyToIntegrate.has(
          's2',
        ),
      ).toBe(true);
      expect(
        (h.scheduler as unknown as { heldLandings: Map<string, unknown> }).heldLandings.size,
      ).toBe(0);
      const filed = h.comments.join(' ');
      expect(filed).toContain('no steps this card does not already have');
      expect(filed).toContain('Plan complete');
    });

    it('a planner that exits without a plan lands the held chain', async () => {
      const h = setup(); // default autoIntegrate: true
      await holdLastStep(h); // also seeds the live replan run 'r-plan'

      await (
        h.scheduler as unknown as { onRunEvent: (r: string, e: unknown) => Promise<void> }
      ).onRunEvent('r-plan', { kind: 'exited', code: 0 });
      await flush();

      expect(h.integrated).toEqual([{ branch: 'orch/t1', base: 'main' }]);
      expect(
        (h.scheduler as unknown as { heldLandings: Map<string, unknown> }).heldLandings.size,
      ).toBe(0);
    });

    it('Stop on the card converts the hold into a Merge offer', async () => {
      const h = setup();
      await holdLastStep(h);

      expect(h.scheduler.stopTask('t1')).toBe(true);

      // Stop does not land the branch itself — it only makes Merge possible.
      expect(h.integrated).toEqual([]);
      const ready = (
        h.scheduler as unknown as {
          readyToIntegrate: Map<string, { branch: string; base: string; worktree: string }>;
        }
      ).readyToIntegrate.get('s2');
      expect(ready).toMatchObject({ branch: 'orch/t1', base: 'main', worktree: 'C:/wt/t1' });
      expect(
        (h.scheduler as unknown as { heldLandings: Map<string, unknown> }).heldLandings.size,
      ).toBe(0);
    });
  });

  /**
   * A GATE step (F8.6) never owns a `Run` or reaches `startTask` — it runs through the
   * scheduler's own `gateSteps` (a {@link GateStepRunner}) instead. These prove the
   * SCHEDULER reaches it from every place that must: `advanceSubtasks` diverts a pending
   * gate ahead of the account-wide gates, `stopTask` and `dispose` stop it directly since
   * it owns no `Run` to stop the usual way, `reconcileInterruptedTasks` re-runs it rather
   * than parking it the way an interrupted agent step is, and `applyFailureChoice` reaches
   * `gateSteps.start`/`sendBack` for its own three actions. The runner's own decision logic
   * (pass/retry/fail) is `gateStep.test.ts`'s job, not this file's — a fake stands in for
   * it here so these stay fast unit tests instead of real command runs.
   */
  describe('gate steps dispatched into the chain (F8.6)', () => {
    /** A minimal gate `stepSpec` — just enough for `isGateTask`/`isGateStep` to see it. */
    const gateStep = () => ({
      id: 'g1',
      kind: 'gate' as const,
      title: 'Run tests',
      command: 'npm test',
    });

    type FakeGateSteps = {
      started: string[];
      stopped: string[];
      reconciled: string[];
      sentBack: string[];
      running: Set<string>;
      isRunning(id: string): boolean;
      runningIds(): string[];
      start(task: Task): Promise<void>;
      stop(id: string): void;
      reconcile(task: Task): void;
      sendBack(task: Task): void;
    };

    /** Swap the scheduler's real `gateSteps` for a fake that just records what it was
     *  asked to do — the same substitution `h.worktrees`/`h.store` already are in this
     *  file's harness, just reached through a cast since there is no constructor seam
     *  for it (a gate is wired up internally, the way `this.chain` is). */
    function installFakeGateSteps(scheduler: Scheduler, running: string[] = []): FakeGateSteps {
      const fake: FakeGateSteps = {
        started: [],
        stopped: [],
        reconciled: [],
        sentBack: [],
        running: new Set(running),
        isRunning(id) {
          return this.running.has(id);
        },
        runningIds() {
          return [...this.running];
        },
        async start(task) {
          this.started.push(task.id);
          this.running.add(task.id);
        },
        stop(id) {
          this.stopped.push(id);
          this.running.delete(id);
        },
        reconcile(task) {
          this.reconciled.push(task.id);
        },
        sendBack(task) {
          this.sentBack.push(task.id);
        },
      };
      (scheduler as unknown as { gateSteps: FakeGateSteps }).gateSteps = fake;
      return fake;
    }

    it('advanceSubtasks sends a pending GATE step straight to gateSteps.start, bypassing the usage-limit gate', () => {
      const h = setup([
        { id: 's1', status: 'done' },
        { id: 's2', status: 'pending', stepSpec: gateStep() },
      ]);
      const fake = installFakeGateSteps(h.scheduler);
      // A limit in force account-wide — a gate's command is never a Claude session, so
      // none of the account-wide gates below may hold it the way they would an agent step.
      (
        h.scheduler as unknown as {
          limitGate: { engage: (s: unknown, ids: string[]) => void };
        }
      ).limitGate.engage(
        { kind: 'rate-limit', status: 'rejected', rateLimitType: 'five_hour', resetsAt: null },
        [],
      );

      (h.scheduler as unknown as { advanceSubtasks: (id: string) => void }).advanceSubtasks('t1');

      expect(fake.started).toEqual(['s2']);
      expect(h.children[1].status).not.toBe('blocked-by-limit');
    });

    it('advanceSubtasks leaves a chain alone while its own gate step is still running', () => {
      const h = setup([
        { id: 's1', status: 'running', stepSpec: gateStep() },
        { id: 's2', status: 'pending' },
      ]);
      const fake = installFakeGateSteps(h.scheduler, ['s1']);

      (h.scheduler as unknown as { advanceSubtasks: (id: string) => void }).advanceSubtasks('t1');

      expect(fake.started).toEqual([]);
      expect(h.prepared).toEqual([]); // s2 never starts under a step still in flight
    });

    it('stopTask stops a running GATE step directly — it owns no Run object', () => {
      const h = setup([{ id: 's1', status: 'running', stepSpec: gateStep() }]);
      const fake = installFakeGateSteps(h.scheduler, ['s1']);

      expect(h.scheduler.stopTask('t1')).toBe(true);

      expect(fake.stopped).toEqual(['s1']);
      expect(h.children[0].status).toBe('stopped');
    });

    it('dispose stops every gate step still running when the app quits', () => {
      const h = setup([
        { id: 's1', status: 'running', stepSpec: gateStep() },
        { id: 's2', status: 'running', stepSpec: gateStep() },
      ]);
      const fake = installFakeGateSteps(h.scheduler, ['s1', 's2']);

      h.scheduler.dispose();

      expect([...fake.stopped].sort()).toEqual(['s1', 's2']);
    });

    it('reconcileInterruptedTasks re-runs a GATE step found running after a restart, rather than parking it for a human', () => {
      const h = setup([{ id: 's1', status: 'running', stepSpec: gateStep() }]);
      const fake = installFakeGateSteps(h.scheduler);

      h.scheduler.reconcileInterruptedTasks();

      expect(fake.reconciled).toEqual(['s1']);
      // Unlike an agent step, nothing here flips the status to `failed` — a gate is a
      // check with no state of its own to have lost, so re-running it is always safe.
      expect(h.children[0].status).toBe('running');
    });

    /** Park a GATE step's failure the way `raiseTaskFailed`/`raiseGateFailure` would,
     *  without going through a real command run. */
    function parkGateFailure(
      h: ReturnType<typeof setup>,
      taskId = 's1',
      landing?: { branch: string; base: string; worktree: string },
    ): string {
      const itemId = 'gate-item-1';
      (h.scheduler as unknown as { attention: Map<string, unknown> }).attention.set(itemId, {
        id: itemId,
        runId: 'r1',
        taskId,
        projectId: 'agent-1',
        taskTitle: 'Run tests',
        kind: 'task-failed',
        prompt: 'The command failed.',
        options: [],
        toolName: null,
        reason: null,
        worktreePath: null,
        branch: null,
        createdAt: Date.now(),
      });
      (h.scheduler as unknown as { pendingFailures: Map<string, unknown> }).pendingFailures.set(
        itemId,
        {
          kind: 'gate',
          projectId: 'agent-1',
          taskId,
          runId: 'r1',
          reason: 'The command failed.',
          ...landing,
        },
      );
      return itemId;
    }

    it('"Run gate again" re-queues the gate step and asks the chain to run it again', async () => {
      const h = setup([{ id: 's1', status: 'failed', stepSpec: gateStep() }]);
      const fake = installFakeGateSteps(h.scheduler);
      const itemId = parkGateFailure(h);

      h.scheduler.answerAttention(itemId, { decision: 'reply', text: FAILURE_ACTION.runGateAgain });
      await flush();

      expect(fake.started).toEqual(['s1']);
    });

    it('"Send back to agent" reaches the gate runner\'s own loop-back, not a fresh run of the gate', async () => {
      const h = setup([{ id: 's1', status: 'failed', stepSpec: gateStep() }]);
      const fake = installFakeGateSteps(h.scheduler);
      const itemId = parkGateFailure(h);

      h.scheduler.answerAttention(itemId, {
        decision: 'reply',
        text: FAILURE_ACTION.sendBackToAgent,
      });
      await flush();

      expect(fake.sentBack).toEqual(['s1']);
      expect(fake.started).toEqual([]); // the gate itself is not re-run — its agent step is
    });

    it('"Skip gate" lands the chain exactly as a passing gate would', async () => {
      const h = setup([{ id: 's1', status: 'failed', stepSpec: gateStep() }]);
      installFakeGateSteps(h.scheduler);
      const itemId = parkGateFailure(h, 's1', {
        branch: 'orch/t1',
        base: 'main',
        worktree: 'C:/wt/t1',
      });

      h.scheduler.answerAttention(itemId, { decision: 'reply', text: FAILURE_ACTION.skipGate });
      await flush();

      expect(h.integrated).toEqual([{ branch: 'orch/t1', base: 'main' }]);
    });

    /**
     * Gate command trust (F8.8): a gate step's command must be trusted on THIS desktop
     * before its first run. Unlike the cases above, the "parks because untrusted" and "an
     * edit re-parks it" cases below reach the REAL `gateSteps` (a `GateStepRunner`) —
     * safe to do because trust is checked before `prepare()`/`startGate`, so nothing spawns.
     * The cases that exercise what happens AFTER trust is granted install the same fake the
     * cases above use, exactly as "Run gate again"/"Send back to agent"/"Skip gate" do.
     */
    describe('gate command trust (F8.8)', () => {
      /** Park a gate-trust ask the way `raiseGateTrust` would, without going through a real
       *  `start()` — the same shortcut `parkGateFailure` takes for an ordinary gate failure. */
      function parkGateTrust(
        h: ReturnType<typeof setup>,
        taskId = 's1',
        commandHash = gateCommandHash('npm test'),
      ): string {
        const itemId = 'gate-trust-item-1';
        (h.scheduler as unknown as { attention: Map<string, unknown> }).attention.set(itemId, {
          id: itemId,
          runId: 'r1',
          taskId,
          projectId: 'agent-1',
          taskTitle: 'Run tests',
          kind: 'task-failed',
          prompt: 'Trust and run "npm test" on this desktop?',
          options: [GATE_TRUST_ACTION.trust, GATE_TRUST_ACTION.decline],
          toolName: null,
          reason: null,
          worktreePath: null,
          branch: null,
          createdAt: Date.now(),
        });
        (h.scheduler as unknown as { pendingFailures: Map<string, unknown> }).pendingFailures.set(
          itemId,
          {
            kind: 'gate-trust',
            projectId: 'agent-1',
            taskId,
            runId: 'r1',
            reason: 'Trust and run "npm test" on this desktop?',
            commandHash,
          },
        );
        return itemId;
      }

      it('parks an untrusted gate with Trust and run / Decline, and flips it to waiting-input', async () => {
        const h = setup([{ id: 's1', status: 'pending', stepSpec: gateStep() }]);
        const gateSteps = (
          h.scheduler as unknown as { gateSteps: { start(t: Task): Promise<void> } }
        ).gateSteps;

        await gateSteps.start(h.children[0]);

        const items = [
          ...(
            h.scheduler as unknown as { attention: Map<string, { options: string[] }> }
          ).attention.values(),
        ];
        expect(items).toHaveLength(1);
        expect(items[0].options).toEqual([GATE_TRUST_ACTION.trust, GATE_TRUST_ACTION.decline]);
        expect(h.children[0].status).toBe('waiting-input');
      });

      it('"Decline" fails the gate with the reason, leaving the next sibling pending', async () => {
        const h = setup([
          { id: 's1', status: 'waiting-input', stepSpec: gateStep() },
          { id: 's2', status: 'pending' },
        ]);
        const itemId = parkGateTrust(h);

        h.scheduler.answerAttention(itemId, { decision: 'reply', text: GATE_TRUST_ACTION.decline });
        await flush();

        expect(h.children[0].status).toBe('failed');
        expect(h.children[1].status).toBe('pending'); // the chain's existing failure contract
        expect(h.store.appendTaskEvent).toHaveBeenCalledWith(
          'agent-1',
          's1',
          'r1',
          expect.objectContaining({ text: expect.stringContaining('Declined to trust') }),
        );
      });

      it('"Trust and run" arriving through attention:answer is refused and re-parks the same ask', async () => {
        const h = setup([{ id: 's1', status: 'waiting-input', stepSpec: gateStep() }]);
        const fake = installFakeGateSteps(h.scheduler);
        const itemId = parkGateTrust(h);

        h.scheduler.answerAttention(itemId, { decision: 'reply', text: GATE_TRUST_ACTION.trust });
        await flush();

        // Never ran, and nothing was added to the trusted set — only `gate:trust` may do that.
        expect(fake.started).toEqual([]);
        expect(h.store.saveSettings).not.toHaveBeenCalled();
        const items = [
          ...(
            h.scheduler as unknown as { attention: Map<string, { options: string[] }> }
          ).attention.values(),
        ];
        expect(items).toHaveLength(1); // re-parked as a fresh item, same two options
        expect(items[0].options).toEqual([GATE_TRUST_ACTION.trust, GATE_TRUST_ACTION.decline]);
      });

      it('trustGateCommand adds the hash, resolves the item, and reruns the gate', async () => {
        const h = setup([{ id: 's1', status: 'waiting-input', stepSpec: gateStep() }]);
        const fake = installFakeGateSteps(h.scheduler);
        const hash = gateCommandHash('npm test');
        const itemId = parkGateTrust(h, 's1', hash);

        h.scheduler.trustGateCommand(itemId);
        await flush();

        const saved = (h.store.saveSettings as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
          trustedGateCommands: string[];
        };
        expect(saved.trustedGateCommands).toContain(hash);
        expect(h.children[0].status).toBe('pending');
        expect(fake.started).toEqual(['s1']);
        expect(
          (h.scheduler as unknown as { attention: Map<string, unknown> }).attention.has(itemId),
        ).toBe(false);
      });

      it('an edit to the command between park and trust parks it again instead of running', async () => {
        const h = setup([{ id: 's1', status: 'pending', stepSpec: gateStep() }]);
        const gateSteps = (
          h.scheduler as unknown as { gateSteps: { start(t: Task): Promise<void> } }
        ).gateSteps;
        await gateSteps.start(h.children[0]); // parks: untrusted

        const attention = (
          h.scheduler as unknown as { attention: Map<string, { id: string; prompt: string }> }
        ).attention;
        const firstItemId = [...attention.keys()][0];

        // The command is edited while the ask sits in the inbox.
        h.children[0].stepSpec = { ...gateStep(), command: 'npm test --changed' };

        h.scheduler.trustGateCommand(firstItemId);
        await flush();

        // Trust was granted for the OLD hash; `start()` re-checks the CURRENT command, which
        // no longer matches, so it parks again instead of running.
        const items = [...attention.values()];
        expect(items).toHaveLength(1);
        expect(items[0].prompt).toContain('npm test --changed');
        expect(h.children[0].status).toBe('waiting-input');
      });
    });
  });
});

describe('Scheduler.onRunEvent — a step’s attach outbox lands on its owner card', () => {
  /**
   * A card with one step, settling a successful run whose worktree dropped a shot in its
   * attach outbox. `run.branch`/`run.base` are left unset so `settle` never computes a
   * `landing` and never needs a real `WorktreeManager` — this is about where the outbox's
   * files land, not about merging anything.
   */
  function setup() {
    const project = {
      id: 'agent-1',
      path: 'C:/repo',
      planPath: '',
      name: 'P',
      concurrency: 1,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'acceptEdits',
    } as Project;
    const card: Task = {
      id: 'c1',
      projectId: 'agent-1',
      phase: '',
      title: 'Add the board screen',
      status: 'in-progress',
      sessionId: null,
      order: 0,
      source: 'plan',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      parentTaskId: null,
    } as unknown as Task;
    const step: Task = {
      id: 's1',
      projectId: 'agent-1',
      phase: '',
      title: 'Screenshot the board',
      status: 'running',
      sessionId: 's1',
      order: 0,
      source: 'adhoc',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      parentTaskId: 'c1',
    } as unknown as Task;
    const tasks = [card, step];
    const attachments: TaskAttachment[] = [];
    const comments: Array<{ projectId: string; taskId: string; body: string }> = [];
    let nextAttachmentId = 1;
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
      appendTokenUsage: vi.fn(),
      getSubtasks: () => [step],
      listTaskLinks: () => [],
      getSettings: () => ({ maxAutoRetries: 0, limitJitterMs: 0, concurrency: 1 }),
      attachmentsForTask: (taskId: string) => attachments.filter((a) => a.taskId === taskId),
      addAttachment: (input: Omit<TaskAttachment, 'id' | 'createdAt'>) => {
        const row: TaskAttachment = {
          ...input,
          id: `a${nextAttachmentId++}`,
          createdAt: Date.now(),
        };
        attachments.push(row);
        return row;
      },
      deleteAttachment: (id: string) => {
        const index = attachments.findIndex((a) => a.id === id);
        if (index === -1) return undefined;
        return attachments.splice(index, 1)[0];
      },
      addComment: (projectId: string, taskId: string, body: string) => {
        comments.push({ projectId, taskId, body });
        return undefined;
      },
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const sessions = {
      start: vi.fn(() => ({ runId: 'r1' })),
      stop: vi.fn(),
      send: vi.fn(),
    } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    scheduler.setAttachmentRoot(mkdtempSync(join(tmpdir(), 'attach-owner-root-')));
    const onAttachmentsChanged = vi.fn();
    scheduler.setAttachmentsChanged(onAttachmentsChanged);
    const worktree = mkdtempSync(join(tmpdir(), 'attach-owner-worktree-'));
    (scheduler as unknown as { runs: Map<string, unknown> }).runs.set('r1', {
      taskId: 's1',
      projectId: 'agent-1',
      runId: 'r1',
      settled: false,
      worktree,
    });
    (scheduler as unknown as { inFlight: Set<string> }).inFlight.add('s1');
    const fire = (event: unknown): Promise<void> =>
      (scheduler as unknown as { onRunEvent: (r: string, e: unknown) => Promise<void> }).onRunEvent(
        'r1',
        event,
      );
    return { card, step, attachments, comments, worktree, fire, onAttachmentsChanged, store };
  }

  const resultEvent = {
    kind: 'result',
    success: true,
    resultText: 'Screenshots attached, ready for sign-off.',
    costUsd: 0.01,
    durationMs: 500,
    stopReason: null,
    terminalReason: null,
  };

  it('attaches a step\u2019s dropped shot to the owner card, not the step', async () => {
    const h = setup();
    mkdirSync(join(h.worktree, '.vipper', 'attach'), { recursive: true });
    writeFileSync(join(h.worktree, '.vipper', 'attach', 'board-light.png'), 'bytes');

    await h.fire(resultEvent);

    expect(h.attachments).toHaveLength(1);
    expect(h.attachments[0]).toMatchObject({ taskId: 'c1', fileName: 'board-light.png' });
    expect(h.attachments.some((a) => a.taskId === 's1')).toBe(false);
    expect(h.onAttachmentsChanged).toHaveBeenCalledTimes(1);
  });

  /**
   * TM-442: "it doesn't make sense to ask the question about screenshots but show them
   * after I respond." A run that PARKS (an `AskUserQuestion`, a plan approval, a permission
   * ask, or a prose question) must have already ingested its attach outbox onto the owner
   * card by the time the attention item goes up — not only once the run later settles.
   * `raiseAttention` is the one chokepoint every one of those four kinds passes through
   * (`task-failed`/`merge-conflict`/`proposal` build their own item inline and never reach
   * it), so this exercises it through the `AskUserQuestion` fallback path `onRunEvent`
   * already has, the same way the settle-path suite above does for `result`.
   */
  it('ingests the attach outbox before raising an agent question, not after', async () => {
    const h = setup();
    mkdirSync(join(h.worktree, '.vipper', 'attach'), { recursive: true });
    writeFileSync(join(h.worktree, '.vipper', 'attach', 'board-light.png'), 'bytes');

    const order: string[] = [];
    const store = h.store;
    const originalAdd = store.addAttachment.bind(store);
    store.addAttachment = ((input: Parameters<Store['addAttachment']>[0]) => {
      order.push('attached');
      return originalAdd(input);
    }) as Store['addAttachment'];
    const originalSave = store.saveAttention.bind(store);
    store.saveAttention = ((...args: Parameters<Store['saveAttention']>) => {
      order.push('raised');
      return originalSave(...args);
    }) as Store['saveAttention'];

    await h.fire({
      kind: 'tool-use',
      name: 'AskUserQuestion',
      input: {
        questions: [{ question: 'Does the screenshot look right?', options: [{ label: 'Yes' }] }],
      },
    });

    expect(h.attachments).toHaveLength(1);
    expect(h.attachments[0]).toMatchObject({ taskId: 'c1', fileName: 'board-light.png' });
    expect(order).toEqual(['attached', 'raised']);
  });
});

describe('Scheduler.rehydrateAttention — a parked round-replacement survives a restart (Phase 20)', () => {
  it('restores { round } from the item’s saved context into pendingReplacements', () => {
    const parent = { id: 't1', projectId: 'personal', status: 'in-progress' } as unknown as Task;
    const item = {
      id: 'i1',
      runId: 'dead-run',
      taskId: 't1',
      projectId: 'personal',
      taskTitle: 'Ship the board',
      kind: 'plan-approval',
      prompt: 'p',
      options: [],
      toolName: null,
      reason: null,
      plan: 'the plan',
      steps: ['New A'],
      questions: [],
      createdAt: Date.now(),
    };
    const store = {
      getTask: (id: string) => (id === 't1' ? parent : undefined),
      listAttention: () => [{ item, context: { round: 2 } }],
      saveAttention: () => undefined,
      deleteAttention: () => undefined,
      getTaskHistory: () => [],
    } as unknown as Store;
    const sessions = { start: vi.fn(), stop: vi.fn(), send: vi.fn() } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    scheduler.rehydrateAttention();
    const pendingReplacements = (
      scheduler as unknown as { pendingReplacements: Map<string, { round: number }> }
    ).pendingReplacements;
    expect(pendingReplacements.get('i1')).toEqual({ round: 2 });
  });

  it('leaves pendingReplacements empty for an ordinary (appending) plan-approval', () => {
    const parent = { id: 't1', projectId: 'personal', status: 'in-progress' } as unknown as Task;
    const item = {
      id: 'i1',
      runId: 'dead-run',
      taskId: 't1',
      projectId: 'personal',
      taskTitle: 'Ship the board',
      kind: 'plan-approval',
      prompt: 'p',
      options: [],
      toolName: null,
      reason: null,
      plan: 'the plan',
      steps: ['New A'],
      questions: [],
      createdAt: Date.now(),
    };
    const store = {
      getTask: (id: string) => (id === 't1' ? parent : undefined),
      listAttention: () => [{ item, context: null }],
      saveAttention: () => undefined,
      deleteAttention: () => undefined,
      getTaskHistory: () => [],
    } as unknown as Store;
    const sessions = { start: vi.fn(), stop: vi.fn(), send: vi.fn() } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    scheduler.rehydrateAttention();
    const pendingReplacements = (
      scheduler as unknown as { pendingReplacements: Map<string, { round: number }> }
    ).pendingReplacements;
    expect(pendingReplacements.size).toBe(0);
  });
});

describe('Scheduler.rehydrateAttention — a parked GATE failure survives a restart (F8.6)', () => {
  it('restores a gate\'s PendingFailure (kind "gate") so Run again/Send back/Skip stay answerable', () => {
    const task = {
      id: 's1',
      projectId: 'personal',
      parentTaskId: 't1',
      status: 'waiting-input',
    } as unknown as Task;
    const item = {
      id: 'i1',
      runId: 'dead-run',
      taskId: 's1',
      projectId: 'personal',
      taskTitle: 'Run tests',
      kind: 'task-failed',
      prompt: 'The command failed.',
      options: [
        FAILURE_ACTION.runGateAgain,
        FAILURE_ACTION.sendBackToAgent,
        FAILURE_ACTION.skipGate,
      ],
      toolName: null,
      reason: null,
      createdAt: Date.now(),
    };
    const context = {
      kind: 'gate',
      projectId: 'personal',
      taskId: 's1',
      runId: 'dead-run',
      reason: 'The command failed.',
    };
    const store = {
      getTask: (id: string) => (id === 's1' ? task : undefined),
      listAttention: () => [{ item, context }],
      saveAttention: () => undefined,
      deleteAttention: () => undefined,
      getTaskHistory: () => [],
    } as unknown as Store;
    const sessions = { start: vi.fn(), stop: vi.fn(), send: vi.fn() } as unknown as SessionManager;
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

    scheduler.rehydrateAttention();

    const pendingFailures = (scheduler as unknown as { pendingFailures: Map<string, unknown> })
      .pendingFailures;
    expect(pendingFailures.get('i1')).toEqual(context);
    // The dead correlator is blanked exactly as every other rehydrated kind's is — a
    // restart's "Run gate again"/"Send back to agent"/"Skip gate" never reaches a live
    // session, so there is nothing for a stale runId to mislead into resuming one.
    expect(emitAttention).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1', runId: '' }));
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
      // A run's exit re-asks the chain (a ready lane may have freed); no arrows here.
      listTaskLinks: () => [],
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

  it('starts the planner beside a running step in plan mode, without stopping the step', () => {
    // Phase 19: a chain still executing its steps no longer holds up a re-plan — the
    // planner is its own turn in the card's own conversation, and the step it runs
    // beside is untouched.
    const h = setupReplan({
      steps: [
        { title: 'a', status: 'done' },
        { title: 'b', status: 'running' },
      ],
    });
    (h.scheduler as unknown as { runs: Map<string, unknown> }).runs.set('r-step', {
      taskId: 's2',
      projectId: 'agent-1',
      runId: 'r-step',
      settled: false,
    });
    (h.scheduler as unknown as { inFlight: Set<string> }).inFlight.add('s2');
    const result = h.scheduler.replanCard('c1');
    expect(result.status).toBe('resumed');
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.start).toHaveBeenCalledTimes(1);
    expect((h.start.mock.calls[0][0] as { permissionMode: string }).permissionMode).toBe('plan');
  });

  it('refuses a second re-plan while one is pending', () => {
    const h = setupReplan({ liveRun: true });
    // The first ask stops the live run and queues the planner behind its exit.
    expect(h.scheduler.replanCard('c1', 'first ask').status).toBe('resumed');
    expect(h.scheduler.replanCard('c1', 'second ask')).toMatchObject({ reason: 'planning' });
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

  /**
   * Re-planning a FUTURE phase in place (Phase 20): `opts.replaceRound` asks the agent to
   * replace one existing round's steps rather than append a new round after them.
   */
  describe('replacing a round in place (opts.replaceRound)', () => {
    it('refuses phase-started once any step of the round is not pending/stopped', () => {
      const h = setupReplan({
        steps: [
          { title: 'Round1 A', status: 'done', planRound: 1 },
          { title: 'Round2 A', status: 'done', planRound: 2 },
          { title: 'Round2 B', status: 'pending', planRound: 2 },
        ],
      });
      expect(h.scheduler.replanCard('c1', undefined, { replaceRound: 2 })).toMatchObject({
        reason: 'phase-started',
      });
    });

    it('refuses phase-started when the named round does not exist', () => {
      const h = setupReplan({ steps: [{ title: 'Round1 A', status: 'done', planRound: 1 }] });
      expect(h.scheduler.replanCard('c1', undefined, { replaceRound: 5 })).toMatchObject({
        reason: 'phase-started',
      });
    });

    it('starts the planner when every step of the round is still pending/stopped', () => {
      const h = setupReplan({
        steps: [
          { title: 'Round1 A', status: 'done', planRound: 1 },
          { title: 'Round2 A', status: 'pending', planRound: 2 },
          { title: 'Round2 B', status: 'stopped', planRound: 2 },
        ],
      });
      const result = h.scheduler.replanCard('c1', undefined, { replaceRound: 2 });
      expect(result.status).toBe('resumed');
      const { prompt } = h.start.mock.calls[0][0] as { prompt: string };
      // Round 1 is still "already on the card"; round 2 is what is being replaced, listed
      // separately so the agent proposes its successor rather than a round after it.
      expect(prompt).toContain('Round1 A');
      expect(prompt).toContain('Phase 2 is being re-planned');
      expect(prompt).toContain('Round2 A');
      expect(prompt).toContain('Round2 B');
    });

    it('threads replaceRound through a stopped live run into the deferred start', () => {
      const h = setupReplan({
        liveRun: true,
        steps: [{ title: 'Round1 A', status: 'pending', planRound: 1 }],
      });
      h.scheduler.replanCard('c1', undefined, { replaceRound: 1 });
      h.exit('r-live');
      expect(h.start).toHaveBeenCalledTimes(1);
      const { prompt } = h.start.mock.calls[0][0] as { prompt: string };
      expect(prompt).toContain('Phase 1 is being re-planned');
      expect(prompt).toContain('Round1 A');
    });
  });

  it('a re-plan run that settles done never integrates the branch', () => {
    // The planner's whole job was a plan for the human to approve — the branch/base/
    // worktree it carries belong to whatever chain it ran beside, not to this turn, so a
    // successful settle must not walk it into `chain.workWritten` or the merge machinery.
    const card = {
      id: 'c1',
      projectId: 'personal',
      status: 'in-progress',
    } as unknown as Task;
    const addComment = vi.fn();
    const store = {
      getTask: (id: string) => (id === 'c1' ? card : undefined),
      getSubtasks: () => [],
      getProject: () => ({ id: 'agent-1', path: 'C:/repo' }) as unknown as Project,
      updateTask: (id: string, patch: Partial<Task>) => {
        if (id === 'c1') Object.assign(card, patch);
        return card;
      },
      addComment,
      getTaskActivity: () => [],
      getSettings: () => ({ maxAutoRetries: 0, limitJitterMs: 0, concurrency: 1 }),
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const worktrees = {
      prepare: vi.fn(),
      integrate: vi.fn(),
      cleanup: vi.fn(),
    } as unknown as WorktreeManager;
    const sessions = { start: vi.fn(), stop: vi.fn(), send: vi.fn() } as unknown as SessionManager;
    const scheduler = new Scheduler(
      store,
      sessions,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      worktrees,
    );
    const run = {
      taskId: 'c1',
      projectId: 'agent-1',
      runId: 'r1',
      settled: false,
      replan: true,
      branch: 'orch/c1',
      base: 'main',
      worktree: 'C:/wt/c1',
    };
    (scheduler as unknown as { settle: (r: unknown, s: string) => void }).settle(run, 'done');
    expect(
      (scheduler as unknown as { readyToIntegrate: Map<string, unknown> }).readyToIntegrate.size,
    ).toBe(0);
    expect(addComment).not.toHaveBeenCalled();
    expect(worktrees.integrate).not.toHaveBeenCalled();
    expect(card.status).toBe('in-progress');
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
      {
        taskId: 'c1',
        runId: (result as { runId: string }).runId,
        startedAt: expect.any(Number),
      },
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

  it('tags the run with its purpose, resumed or live, so the card can say why it works', () => {
    const resumed = setupChat({ card: { status: 'in-progress' } });
    const result = resumed.scheduler.chatWithAgent('c1', 'CI failed', { purpose: 'fix-pipeline' });
    expect(result).toMatchObject({ status: 'resumed' });
    expect(resumed.scheduler.activeRuns()).toEqual([
      expect.objectContaining({ taskId: 'c1', purpose: 'fix-pipeline' }),
    ]);

    const live = setupChat({ liveFor: 'c1' });
    expect(live.scheduler.activeRuns()[0]?.purpose).toBeUndefined();
    live.scheduler.chatWithAgent('c1', 'CI failed', { purpose: 'fix-pipeline' });
    expect(live.scheduler.activeRuns()[0]?.purpose).toBe('fix-pipeline');
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
 * The scheduler's half of the pre-run base sync (step 2 of "a task does not start with
 * pulling"): `prepareAndLaunch` tells `WorktreeManager.prepare` to hold the branch rebase off
 * a chat reply, and `launch` puts any `agentNote` the sync came back with at the HEAD of the
 * prompt — fresh brief or resumed session alike.
 */
describe('Scheduler.prepareAndLaunch — the pre-run sync’s scheduler-side wiring', () => {
  function setup(prep: { agentNote?: string } = {}) {
    const project = {
      id: 'p1',
      path: 'C:/repo',
      planPath: 'C:/repo/plan.md',
      name: 'P',
      concurrency: 1,
      useWorktrees: true,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'acceptEdits',
    } as unknown as Project;
    const card = {
      id: 't1',
      projectId: 'p1',
      phase: '',
      title: 'Fix the export dialog',
      status: 'pending',
      sessionId: null as string | null,
      order: 0,
      source: 'board',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      agentProjectId: null,
      parentTaskId: null,
    } as unknown as Task;
    const store = {
      getTask: (id: string) => (id === 't1' ? card : undefined),
      getTasks: () => [card],
      getProject: (id: string) => (id === 'p1' ? project : undefined),
      getSubtasks: () => [],
      updateTask: (_id: string, patch: Partial<Task>) => {
        Object.assign(card, patch);
        return card;
      },
      listProjects: () => [project],
      listTaskLinks: () => [],
      appendTaskEvent: vi.fn(),
      addComment: vi.fn(),
      addChatMessage: vi.fn(),
      getTaskActivity: () => [],
      getSettings: () => ({ maxAutoRetries: 0, limitJitterMs: 0, concurrency: 1 }),
      saveLimitGate: vi.fn(),
      loadLimitGate: () => null,
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const calls: Array<{ opts: { resumingRebase?: boolean; skipSync?: boolean } }> = [];
    const worktrees = {
      prepare: vi.fn(
        (
          _p: Project,
          _task: Task,
          _owner?: string,
          _branch?: string,
          _startPoint?: string,
          opts?: { resumingRebase?: boolean; skipSync?: boolean },
        ) => {
          calls.push({ opts: opts ?? {} });
          return Promise.resolve({
            mode: 'worktree',
            cwd: 'C:/wt/t1',
            branch: 'orch/t1',
            base: 'main',
            ...prep,
          });
        },
      ),
      integrate: vi.fn(),
      cleanup: vi.fn(),
    } as unknown as WorktreeManager;
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
      worktrees,
    );
    return { scheduler, card, calls, start };
  }

  /** Let the fire-and-forgotten `prepareAndLaunch` chain settle before asserting. */
  const flush = async (): Promise<void> => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };

  const promptOf = (start: ReturnType<typeof vi.fn>): string =>
    (start.mock.calls[0]?.[0] as { prompt: string }).prompt;

  it('passes skipSync for a chat reply, not for an ordinary Start', async () => {
    const { scheduler, card, calls } = setup();

    scheduler.startTaskNow('t1');
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.skipSync).toBe(false);

    // Simulate that first run having finished (nobody is listening) so the next chat
    // message resumes the card rather than sending into a still-live session.
    (scheduler as unknown as { runs: Map<string, unknown> }).runs.clear();
    (scheduler as unknown as { inFlight: Set<string> }).inFlight.clear();
    card.sessionId = 'sess-1';
    scheduler.chatWithAgent('t1', 'keep going');
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1].opts.skipSync).toBe(true);
  });

  it('puts an agent note at the head of a FRESH brief', async () => {
    const { scheduler, start } = setup({ agentNote: 'Finish the paused rebase first.' });

    scheduler.startTaskNow('t1');
    await flush();

    expect(promptOf(start).startsWith('Finish the paused rebase first.')).toBe(true);
  });

  it('prepends an agent note to a RESUMED session’s prompt', async () => {
    const { scheduler, card, start } = setup({ agentNote: 'Finish the paused rebase first.' });
    card.sessionId = 'sess-1';

    scheduler.startTaskNow('t1');
    await flush();

    const prompt = promptOf(start);
    expect(prompt.startsWith('Finish the paused rebase first.')).toBe(true);
    // A resumed session gets the short nudge after the note, not the full brief again.
    expect(prompt).toContain('Continue the task where you left off');
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

  /** Two cards, `b` chained to start after `a` merges, and (unless told not to) a limit already in force. */
  function setup({ limit = true }: { limit?: boolean } = {}) {
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
      // The chain's lane count asks which cards hold an open PR.
      listMergeRequests: () => [],
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
    if (limit) {
      (
        scheduler as unknown as { limitGate: { engage: (s: unknown, ids: string[]) => void } }
      ).limitGate.engage(limited, []);
    }
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

  /**
   * The repeat poll: the GitHub sync now lands every stored merged row whose card has not
   * landed, and the same PR is reported by both passes of one sync and by the next poll.
   * The successor starts once, and the FIRST landing time — the PR's `merged_at` — stands.
   */
  it('starts an after-merge successor once across repeated landings, keeping the first landedAt', () => {
    const { scheduler, start, a } = setup({ limit: false });
    scheduler.noteWorkLanded('a', 400);
    scheduler.noteWorkLanded('a', 900);
    scheduler.noteWorkLanded('a');

    expect(a.landedAt).toBe(400);
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
      // Not a variant leader, so `variantWorkOwner` always resolves to the card itself.
      listVariantRows: () => [],
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
      // Not a variant leader, so `variantWorkOwner` always resolves to the card itself.
      listVariantRows: () => [],
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
 * F10.6: the Merge button on a variant leader routes through `variantWorkOwner` — refusing
 * with "pick a variant first" before a pick, and merging the picked ROW's branch afterwards
 * while leaving `ctx.taskId` (and so `landedAt`, and auto-release) on the LEADER, exactly as
 * a step's own merge already lands on its parent rather than on the step.
 */
describe('Scheduler.integrateNow — routed through a variant pick (F10.6)', () => {
  function setup(picked: boolean) {
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
    const leader = {
      id: 'leader-1',
      projectId: 'personal',
      phase: '',
      title: 'Fix the parser',
      status: 'in-progress',
      sessionId: 'sess-leader',
      order: 0,
      source: 'jira',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      agentProjectId: 'agent-1',
      agentBranch: null,
      parentTaskId: null,
      pickedVariantId: picked ? 'row-A' : null,
    } as unknown as Task;
    const row = {
      id: 'row-A',
      projectId: 'personal',
      phase: '',
      title: leader.title,
      status: 'done',
      sessionId: 'sess-row-a',
      order: 1,
      source: 'adhoc',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      agentProjectId: 'agent-1',
      agentBranch: 'orch/row-A',
      parentTaskId: null,
      variantOf: leader.id,
      variantLabel: 'A',
    } as unknown as Task;
    const byId = new Map<string, Task>([
      [leader.id, leader],
      [row.id, row],
    ]);
    const store = {
      getTask: (id: string) => byId.get(id),
      getProject: (id: string) => (id === 'agent-1' ? project : undefined),
      listProjects: () => [project],
      getTasks: () => [...byId.values()],
      getSubtasks: () => [],
      getTaskActivity: () => [],
      addComment: vi.fn(),
      listTaskLinks: () => [],
      listVariantRows: (leaderId?: string) =>
        [...byId.values()].filter(
          (task) => task.variantOf && (!leaderId || task.variantOf === leaderId),
        ),
      updateTask: (id: string, patch: Partial<Task>) => {
        const task = byId.get(id);
        if (!task) return undefined;
        Object.assign(task, patch);
        return task;
      },
      appendTaskEvent: vi.fn(),
      appendTokenUsage: vi.fn(),
      getSettings: () => ({ maxAutoRetries: 0, limitJitterMs: 0, concurrency: 1 }),
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const worktrees = {
      prepare: vi.fn(),
      inspect: vi.fn(async (_p: Project, owner: string, branch?: string) => ({
        cwd: `C:/wt/${owner}`,
        branch: branch ?? `orch/${owner}`,
        base: 'development',
      })),
      integrate: vi.fn(async () => ({ status: 'merged' })),
      cleanup: vi.fn(),
    };
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
    return { scheduler, leader, row, worktrees, store };
  }

  const settle = async (): Promise<void> => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };

  it('refuses an unpicked leader with "pick a variant first"', async () => {
    const { scheduler, worktrees } = setup(false);
    expect(await scheduler.integrateNow('leader-1')).toMatch(/pick a variant first/i);
    expect(worktrees.inspect).not.toHaveBeenCalled();
    expect(scheduler.integratingTaskIds()).toEqual([]);
  });

  it("integrates the picked row's branch, and landedAt lands on the leader", async () => {
    const { scheduler, worktrees, leader, row } = setup(true);

    expect(await scheduler.integrateNow('leader-1')).toBeNull();
    await settle();

    // Asked `inspect` through the ROW, not the leader — the leader never had a branch.
    expect(worktrees.inspect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agent-1' }),
      row.id,
      row.agentBranch,
    );
    expect(worktrees.integrate).toHaveBeenCalledTimes(1);

    // `ctx.taskId` stayed the leader throughout, so the landing is recorded on IT.
    expect(leader.landedAt).toBeTypeOf('number');
    expect(row.landedAt).toBeUndefined();
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
      getSettings: () => ({
        maxAutoRetries: 0,
        limitJitterMs: 0,
        concurrency: 1,
        defaultEfforts: { lead: 'high', planner: 'max', workers: 'low', reviewer: 'xhigh' },
      }),
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const sessions = {
      start: vi.fn((_req: StartSessionRequest, _opts: unknown) => ({ runId: 'r-new' })),
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
    return { scheduler, card, runFor, sessions };
  }

  it('starts a chat reply at the workers effort and a re-plan at the planner one', () => {
    const chat = setup();
    const sent = chat.scheduler.chatWithAgent('t1', 'how did the branch turn out?');
    if (sent.status === 'refused') throw new Error(sent.reason);
    expect(vi.mocked(chat.sessions.start).mock.calls[0][0].effort).toBe('low');

    const replan = setup();
    const again = replan.scheduler.replanCard('t1', 'plan me another round');
    if (again.status === 'refused') throw new Error(again.reason);
    expect(vi.mocked(replan.sessions.start).mock.calls[0][0].effort).toBe('max');
  });

  // On a plan-mode card, so a review, release or conflict fix that wrongly read the planner
  // rung would send `max` instead of the workers `low`.
  it('starts a review seed, a release seed and a conflict fix at the workers effort', () => {
    type StartTask = (p: Project, t: Task, o: { releaseSeed?: boolean }) => void;
    const startTask = (h: ReturnType<typeof setup>, o: { releaseSeed?: boolean }) =>
      (h.scheduler as unknown as { startTask: StartTask }).startTask.call(
        h.scheduler,
        h.scheduler['store'].getProject('agent-1') as Project,
        h.card,
        o,
      );
    const effortOf = (h: ReturnType<typeof setup>) =>
      vi.mocked(h.sessions.start).mock.calls[0][0].effort;

    const review = setup();
    review.card.sessionId = null as unknown as string;
    (review.card as unknown as { chainLandedAt: number }).chainLandedAt = 1700000000000;
    const sent = review.scheduler.chatWithAgent('t1', 'how did it go?');
    if (sent.status === 'refused') throw new Error(sent.reason);
    expect(effortOf(review)).toBe('low');

    const release = setup();
    startTask(release, { releaseSeed: true });
    expect(effortOf(release)).toBe('low');

    const fix = setup();
    (
      fix.scheduler as unknown as { pendingConflictFix: Map<string, unknown> }
    ).pendingConflictFix.set('t1', { projectId: 'agent-1', taskId: 't1' });
    startTask(fix, {});
    expect(effortOf(fix)).toBe('low');
  });

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
 * A single item, not a whole card — {@link Scheduler.dismissAttentionItem}.
 *
 * `dismissAttentionForCard` sweeps everything a card (and its steps) is asking at once,
 * which is right for closing the card and its detail pane's Dismiss. But the inbox can hold
 * more than one open ask on the same card at a time — two parked steps, or a chain that
 * asked twice before either was answered — and a per-item Dismiss in the inbox must drop
 * exactly the one the human clicked, leaving any sibling ask exactly as parked as it was.
 */
describe('dismissAttentionItem', () => {
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
    const all = [card, mkTask({ id: 'other', title: 'someone else' })];
    const store = {
      getTask: (id: string) => all.find((t) => t.id === id),
      getTasks: () => all,
      getSubtasks: () => [],
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

  it('drops exactly the one item, leaving a sibling ask on the same card parked', () => {
    const { scheduler, resolved, open } = setup([
      item({ id: 'i1', kind: 'permission' }),
      item({ id: 'i2', kind: 'question' }),
    ]);

    expect(scheduler.dismissAttentionItem('i1')).toBe(true);
    expect(open()).toEqual(['i2']);
    expect(resolved).toHaveBeenCalledWith('i1');
    expect(resolved).not.toHaveBeenCalledWith('i2');
  });

  it('releases the tool a held decision was blocking, denied', () => {
    const { scheduler } = setup([item({ id: 'i1', kind: 'permission' })]);
    const resolve = vi.fn();
    (scheduler as unknown as { pendingDecisions: Map<string, unknown> }).pendingDecisions.set(
      'i1',
      { runId: 'r1', input: {}, resolve },
    );

    expect(scheduler.dismissAttentionItem('i1')).toBe(true);

    // Dropping the item without this leaves the CLI process parked on its HTTP request until
    // the app exits. Denied, because nobody approved anything.
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0][0]).toMatchObject({ behavior: 'deny' });
    expect(
      (scheduler as unknown as { pendingDecisions: Map<string, unknown> }).pendingDecisions.size,
    ).toBe(0);
  });

  it('refuses to dismiss a merge conflict — its answer is what finishes the rebase', () => {
    const { scheduler, resolved, open } = setup([item({ id: 'i1', kind: 'merge-conflict' })]);

    expect(scheduler.dismissAttentionItem('i1')).toBe(false);
    // A rebase stopped halfway with markers in a worktree is not a card shouting; hiding it
    // would strand the repo with no control left that could finish the job.
    expect(open()).toEqual(['i1']);
    expect(resolved).not.toHaveBeenCalled();
  });

  it('is a no-op for an id the inbox no longer holds', () => {
    const { scheduler, resolved } = setup([item({ id: 'i4', taskId: 'other' })]);
    expect(scheduler.dismissAttentionItem('ghost')).toBe(false);
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

  /**
   * An open owner decision is a plain refusal, asked BEFORE the gates: a park would have a
   * gate's resume start the card behind the human's back, with the question unanswered.
   */
  it('refuses a card waiting on a decision, starts nothing and parks nothing', () => {
    const { scheduler, card, start } = setup({ authGate: true });
    card.decisionQuestion = 'Which hosting plan?';
    card.decisionAskedAt = 1;

    expect(scheduler.startTaskNow('t1')).toEqual({ refused: 'needs-decision' });
    expect(start).not.toHaveBeenCalled();
    expect(scheduler.currentAuth()?.parkedTaskIds).toEqual([]);
    expect(RUN_REFUSAL_MESSAGE['needs-decision']).toBe(
      'This card is waiting on a decision. Answer it on the card or in the Inbox, then start ' +
        'it again.',
    );
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

describe('Scheduler — an owner decision on a card', () => {
  function setup(): {
    scheduler: Scheduler;
    card: Task;
    comments: TaskActivityEntry[];
    emitTask: ReturnType<typeof vi.fn>;
    reconsider: ReturnType<typeof vi.spyOn>;
  } {
    const card = {
      id: 't1',
      projectId: 'p',
      phase: '',
      title: 'Move the API to the bigger hosting plan',
      status: 'pending',
      sessionId: null,
      order: 0,
      source: 'board',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      agentProjectId: null,
      decisionQuestion: null,
      decisionAskedAt: null,
    } as unknown as Task;
    const comments: TaskActivityEntry[] = [];
    const store = {
      getTask: (id: string) => (id === card.id ? card : undefined),
      getTasks: () => [card],
      getSubtasks: () => [],
      updateTask: (id: string, patch: Partial<Task>) => {
        if (id !== card.id) return undefined;
        Object.assign(card, patch);
        return card;
      },
      addComment: (_projectId: string, _taskId: string, body: string) => {
        const text = body.trim();
        if (!text) return undefined;
        const entry = { kind: 'comment', id: comments.length + 1, body: text, createdAt: 1 };
        comments.push(entry as TaskActivityEntry);
        return entry;
      },
      getTaskActivity: () => [...comments],
      listProjects: () => [],
      listTaskLinks: () => [],
      getSettings: () => ({ maxAutoRetries: 0, limitJitterMs: 0, concurrency: 1 }),
      saveLimitGate: vi.fn(),
      loadLimitGate: () => null,
      saveAuthGate: vi.fn(),
      loadAuthGate: () => null,
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const emitTask = vi.fn();
    const sessions = { start: vi.fn(), stop: vi.fn() } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, emitTask, vi.fn(), vi.fn(), vi.fn(), vi.fn());
    const reconsider = vi.spyOn(scheduler, 'reconsiderChains');
    return { scheduler, card, comments, emitTask, reconsider };
  }

  it('sets a decision, then an answer files it as a comment and clears both fields', () => {
    const { scheduler, card, comments, emitTask, reconsider } = setup();

    const flagged = scheduler.setDecision('t1', '  Which hosting plan do we pay for?  ');
    expect(flagged.decisionQuestion).toBe('Which hosting plan do we pay for?');
    expect(flagged.decisionAskedAt).toEqual(expect.any(Number));
    expect(emitTask).toHaveBeenLastCalledWith({ task: card, runId: null });
    expect(reconsider).not.toHaveBeenCalled();

    const { task, comment } = scheduler.answerDecision('t1', ' The 4 GB plan. ');
    expect(comment).toMatchObject({
      kind: 'comment',
      body: 'Decision needed: Which hosting plan do we pay for?\n\nAnswer: The 4 GB plan.',
    });
    expect(comments).toHaveLength(1);
    expect(task.decisionQuestion).toBeNull();
    expect(task.decisionAskedAt).toBeNull();
    expect(emitTask).toHaveBeenLastCalledWith({ task: card, runId: null });
    // The flag was the last thing a chained card might have been waiting on.
    expect(reconsider).toHaveBeenCalledWith('decision-cleared');
  });

  it('keeps the moment a decision was first asked when the question is rewritten', () => {
    const { scheduler } = setup();
    const first = scheduler.setDecision('t1', 'Which plan?').decisionAskedAt;
    expect(scheduler.setDecision('t1', 'Which plan, monthly or yearly?')).toMatchObject({
      decisionQuestion: 'Which plan, monthly or yearly?',
      decisionAskedAt: first,
    });
  });

  it('refuses an empty answer and leaves the decision open', () => {
    const { scheduler, card, comments, reconsider } = setup();
    scheduler.setDecision('t1', 'Which plan?');
    expect(() => scheduler.answerDecision('t1', '   ')).toThrow('An answer needs some text.');
    expect(card.decisionQuestion).toBe('Which plan?');
    expect(comments).toEqual([]);
    expect(reconsider).not.toHaveBeenCalled();
  });

  it('refuses to answer a card with no open decision', () => {
    const { scheduler, comments } = setup();
    expect(() => scheduler.answerDecision('t1', 'Yes')).toThrow(
      'This card has no open decision to answer.',
    );
    expect(() => scheduler.answerDecision('nope', 'Yes')).toThrow('Task not found.');
    expect(comments).toEqual([]);
  });

  it('withdraws with null — clears both fields and files no comment', () => {
    const { scheduler, card, comments, reconsider } = setup();
    scheduler.setDecision('t1', 'Which plan?');
    const cleared = scheduler.setDecision('t1', null);
    expect(cleared.decisionQuestion).toBeNull();
    expect(cleared.decisionAskedAt).toBeNull();
    expect(card.decisionQuestion).toBeNull();
    expect(comments).toEqual([]);
    expect(reconsider).toHaveBeenCalledWith('decision-cleared');
  });

  it('treats a blank question as a withdraw, and re-asks nothing when none was open', () => {
    const { scheduler, card, reconsider } = setup();
    expect(scheduler.setDecision('t1', '   ').decisionQuestion).toBeNull();
    expect(card.decisionAskedAt).toBeNull();
    expect(reconsider).not.toHaveBeenCalled();
  });

  it('hands the answer to the next run through taskNotes', () => {
    const { scheduler } = setup();
    scheduler.setDecision('t1', 'Which plan?');
    scheduler.answerDecision('t1', 'The yearly one.');
    const notes = (
      scheduler as unknown as { taskNotes: (id: string) => { kept: string[] } }
    ).taskNotes('t1');
    expect(notes.kept).toContain('Decision needed: Which plan?\n\nAnswer: The yearly one.');
  });
});

describe('Scheduler.questionToDecision — a planning question becomes a decision', () => {
  /**
   * One board card (a ticket) resting in IN PROGRESS with a live run on it, put in the private run map
   * directly (as the negotiation tests do) so the run's two planning flags are exactly
   * what each case says. The question then arrives the real way — an assistant message
   * carrying the sentinel, through `onRunEvent` — so `raiseAttention` is what marks it.
   */
  async function setup(planning: boolean) {
    const card = {
      id: 't1',
      projectId: 'p',
      phase: '',
      title: 'Move the API to the bigger hosting plan',
      status: 'running',
      preRunStatus: 'in-progress',
      sessionId: 's1',
      order: 0,
      source: 'ticket',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      agentProjectId: null,
      decisionQuestion: null,
      decisionAskedAt: null,
    } as unknown as Task;
    const store = {
      getTask: (id: string) => (id === card.id ? card : undefined),
      getTasks: () => [card],
      getSubtasks: () => [],
      updateTask: (id: string, patch: Partial<Task>) => {
        if (id !== card.id) return undefined;
        Object.assign(card, patch);
        return card;
      },
      appendTaskEvent: vi.fn(),
      getTaskActivity: () => [],
      listProjects: () => [],
      listTaskLinks: () => [],
      getSettings: () => ({ maxAutoRetries: 0, limitJitterMs: 0, concurrency: 1 }),
      saveLimitGate: vi.fn(),
      loadLimitGate: () => null,
      saveAuthGate: vi.fn(),
      loadAuthGate: () => null,
      ...INERT_ATTENTION_STORE,
      saveAttention: vi.fn(),
    } as unknown as Store;
    const stop = vi.fn();
    const sessions = { start: vi.fn(), stop, send: vi.fn() } as unknown as SessionManager;
    const emitAttention = vi.fn();
    const emitResolved = vi.fn();
    const scheduler = new Scheduler(
      store,
      sessions,
      vi.fn(),
      vi.fn(),
      emitAttention,
      emitResolved,
      vi.fn(),
    );
    const run = {
      taskId: 't1',
      projectId: 'p',
      runId: 'r1',
      origin: 'human',
      startedAt: 0,
      settled: false,
      permissionMode: planning ? 'plan' : 'acceptEdits',
      expectsPlan: true,
    };
    (scheduler as unknown as { runs: Map<string, unknown> }).runs.set('r1', run);
    await (
      scheduler as unknown as { onRunEvent: (r: string, e: unknown) => Promise<void> }
    ).onRunEvent('r1', {
      kind: 'assistant',
      text: `${NEEDS_INPUT_SENTINEL} Which hosting plan do we pay for?\n- Monthly\n- Yearly`,
    });
    const item = emitAttention.mock.calls[0]?.[0] as AttentionItem;
    return { scheduler, card, item, run, stop, emitResolved };
  }

  it('turns it into the decision, resolves the item and stops the planning run', async () => {
    const { scheduler, card, item, run, stop, emitResolved } = await setup(true);
    expect(item).toMatchObject({ kind: 'question', duringPlanning: true });
    expect(card.status).toBe('waiting-input');

    const task = scheduler.questionToDecision(item.id);

    expect(task.decisionQuestion).toBe(
      'Which hosting plan do we pay for?\n\nOptions:\n- Monthly\n- Yearly',
    );
    expect(task.decisionAskedAt).toEqual(expect.any(Number));
    expect(emitResolved).toHaveBeenCalledWith(item.id);
    expect(scheduler.listAttention()).toEqual([]);
    expect(stop).toHaveBeenCalledWith('r1');
    expect(run.settled).toBe(true);
    // Back in the column the human left it in — not `stopped`, and offering no Resume.
    expect(card.status).toBe('in-progress');
    expect(card.preRunStatus).toBeNull();
    expect(card.stoppedAt ?? null).toBeNull();
  });

  it('refuses a question a working (non-planning) run asked, and changes nothing', async () => {
    const { scheduler, card, item, stop, emitResolved } = await setup(false);
    expect(item.duringPlanning).toBeUndefined();

    expect(() => scheduler.questionToDecision(item.id)).toThrow(
      'Only a question asked while planning a card can become a decision on it.',
    );
    expect(card.decisionQuestion).toBeNull();
    expect(emitResolved).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(card.status).toBe('waiting-input');
  });

  it('refuses an item that is no longer open', () => {
    const scheduler = new Scheduler(
      { ...INERT_ATTENTION_STORE } as unknown as Store,
      {} as SessionManager,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    expect(() => scheduler.questionToDecision('gone')).toThrow('That question is no longer open.');
  });
});

describe('Scheduler.startVariantRows (F10)', () => {
  /**
   * Three variant rows already on the leader's board, each delegated to the same agent
   * project — the shape `task:startVariants` hands the scheduler once its own rows exist.
   * Modelled on `makeAgentScheduler` above (the agent-delegation store shape) plus the
   * worktree fake from the plan-driven-subtasks `setup()` (also above), since one of the
   * cases below asserts each row gets prepared its OWN worktree.
   */
  function makeVariantScheduler(
    projectOverrides: Partial<Project> = {},
    rowOverrides: Partial<Task>[] = [{}, {}, {}],
  ) {
    const personal = { id: 'personal', name: 'Personal', path: '', planPath: '', kind: 'plan' };
    const agentProject = {
      id: 'agent-1',
      name: 'Checkout service',
      path: 'C:/repos/checkout',
      planPath: '',
      kind: 'agent',
      defaultModel: 'sonnet',
      planningModel: null,
      defaultPermissionMode: 'acceptEdits',
      concurrency: 2,
      ...projectOverrides,
    };
    const leader = {
      id: 'leader-1',
      projectId: 'personal',
      phase: '',
      title: 'Fix the parser',
      status: 'pending',
      sessionId: null,
      order: 0,
      source: 'jira',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      agentProjectId: 'agent-1',
    } as unknown as Task;
    const labels = ['A', 'B', 'C'] as const;
    const rows = rowOverrides.map(
      (over, i) =>
        ({
          id: `row-${labels[i]}`,
          projectId: 'personal',
          phase: '',
          title: leader.title,
          status: 'pending',
          sessionId: null,
          order: i + 1,
          source: 'adhoc',
          dependsOn: [],
          isContract: false,
          isScaffold: false,
          agentProjectId: 'agent-1',
          variantOf: leader.id,
          variantLabel: labels[i],
          ...over,
        }) as unknown as Task,
    );
    const byId = new Map<string, Task>([
      [leader.id, leader],
      ...rows.map((r) => [r.id, r] as const),
    ]);
    const store = {
      getTask: (id: string) => byId.get(id),
      getProject: (id: string) =>
        id === 'agent-1' ? agentProject : id === 'personal' ? personal : undefined,
      getTasks: (projectId: string) =>
        [...byId.values()].filter((task) => task.projectId === projectId),
      getSubtasks: () => [],
      getTaskActivity: () => [],
      listTaskLinks: () => [],
      listVariantRows: (leaderId?: string) =>
        [...byId.values()].filter(
          (task) => task.variantOf && (!leaderId || task.variantOf === leaderId),
        ),
      updateTask: (id: string, patch: Partial<Task>) => {
        const task = byId.get(id);
        if (!task) return undefined;
        Object.assign(task, patch);
        return task;
      },
      appendTaskEvent: vi.fn(),
      appendTokenUsage: vi.fn(),
      saveParkedRuns: vi.fn(),
      getSettings: () => ({
        maxAutoRetries: 0,
        limitJitterMs: 0,
        concurrency: 1,
        maxParallelSessions: 0,
      }),
      saveLimitGate: vi.fn(),
      loadLimitGate: () => null,
      saveAuthGate: vi.fn(),
      loadAuthGate: () => null,
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;

    /** Every row `prepare` was called for, and the owner/cwd it was given. */
    const prepared: Array<{ taskId: string; owner: string; cwd: string }> = [];
    const worktrees = {
      prepare: (_p: Project, task: Task, owner: string = task.id) => {
        prepared.push({ taskId: task.id, owner, cwd: `C:/wt/${owner}` });
        return Promise.resolve({
          mode: 'worktree',
          cwd: `C:/wt/${owner}`,
          branch: `orch/${owner}`,
          base: 'main',
        });
      },
      integrate: vi.fn(),
      cleanup: vi.fn(),
    } as unknown as WorktreeManager;

    const start = vi.fn((_req: unknown, opts: { runId?: string }) => ({
      runId: opts?.runId ?? 'r-new',
    }));
    const stop = vi.fn();
    const sessions = { start, stop } as unknown as SessionManager;
    const scheduler = new Scheduler(
      store,
      sessions,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      worktrees,
    );
    return { scheduler, store, leader, rows, start, prepared };
  }

  /** Let `prepareAndLaunch`'s async worktree prep (and `onRunEvent`'s own pump) settle. */
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  /** Raise the usage-limit gate the way a `rate-limit` event from the CLI raises it. */
  function engageLimit(scheduler: Scheduler): void {
    (scheduler as unknown as { engageLimit: (e: unknown) => void }).engageLimit({
      kind: 'rate-limit',
      status: 'limited',
      rateLimitType: 'rolling',
      resetsAt: null,
    });
  }

  it('starts rows up to the project’s concurrency and queues the rest, starting the queued one when a slot frees', async () => {
    const { scheduler, rows, start } = makeVariantScheduler({ concurrency: 2 });

    const outcomes = scheduler.startVariantRows(rows.map((r) => r.id));
    await flush();

    expect(start).toHaveBeenCalledTimes(2); // ×3 against concurrency 2
    expect(outcomes[0]).toHaveProperty('runId');
    expect(outcomes[1]).toHaveProperty('runId');
    expect(outcomes[2]).toEqual({ queued: true });
    expect(rows[2].status).toBe('pending'); // queued, not refused

    // The first row's run exits — frees the slot the third row's queue entry was waiting on.
    const firstRunId = (outcomes[0] as { runId: string }).runId;
    await (
      scheduler as unknown as { onRunEvent: (r: string, e: unknown) => Promise<void> }
    ).onRunEvent(firstRunId, { kind: 'exited', code: 1 });
    await flush();

    expect(start).toHaveBeenCalledTimes(3);
  });

  it('prepares each row its own worktree, keyed on its own task id', async () => {
    const { scheduler, rows, prepared } = makeVariantScheduler({ concurrency: 3 });

    scheduler.startVariantRows(rows.map((r) => r.id));
    await flush();

    expect(prepared).toHaveLength(3);
    // Three distinct owners (= task ids, no `parentTaskId` to share one with) and three
    // distinct cwd paths — one worktree per row, never one shared between them.
    expect(new Set(prepared.map((p) => p.owner))).toEqual(new Set(rows.map((r) => r.id)));
    expect(new Set(prepared.map((p) => p.cwd)).size).toBe(3);
  });

  it('parks every row behind an active limit gate instead of starting any of them', () => {
    const { scheduler, rows, start } = makeVariantScheduler({ concurrency: 3 });
    engageLimit(scheduler);

    const outcomes = scheduler.startVariantRows(rows.map((r) => r.id));

    expect(outcomes).toEqual([{ refused: 'limit' }, { refused: 'limit' }, { refused: 'limit' }]);
    expect(start).not.toHaveBeenCalled();
    for (const row of rows) {
      expect(row.status).toBe('blocked-by-limit');
      expect(scheduler.currentLimit()?.parkedTaskIds).toContain(row.id);
    }
  });

  it('a limit that engages mid-run parks only the row that was actually running', async () => {
    const { scheduler, rows, start } = makeVariantScheduler({ concurrency: 1 });

    scheduler.startVariantRows(rows.map((r) => r.id));
    await flush();
    expect(start).toHaveBeenCalledTimes(1); // concurrency 1: only the first row started

    engageLimit(scheduler);

    expect(rows[0].status).toBe('blocked-by-limit');
    expect(scheduler.currentLimit()?.parkedTaskIds).toEqual([rows[0].id]);
    // The other two never started — they are sitting in `variantQueue`, not in a live run,
    // so the account-wide gate (which only parks what is actually RUNNING) leaves them be.
    expect(rows[1].status).toBe('pending');
    expect(rows[2].status).toBe('pending');
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

  /** F2.6: the gate's own resume carries `origin: 'resume'`, not the card's original origin. */
  it('records the run the limit resumes with origin "resume"', () => {
    const h = setup();
    const { rows, append } = createFakeAppendActivity();
    h.scheduler.setActivityRecorder(createActivityRecorder({ append }));

    startRun(h.scheduler, h.project, h.card, {});
    hitLimit(h.scheduler);
    h.scheduler.resumeLimitNow();

    const run = resumedRun(h.scheduler);
    const started = rows.filter((r) => r.kind === 'run-started' && r.runId === run?.runId);
    expect(started).toHaveLength(1);
    expect(started[0].origin).toBe('resume');
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

/**
 * F2.7: a gate park and its later resume each write their own row to the activity log — the
 * gate is the only thing that remembers work across the pause, and the feed needs to say so
 * too. The harness below is the same shape as `a parked release or chat run comes back as
 * what it was` and the `startTaskNow` gate-origin tests above, with an activity recorder
 * wired on top.
 */
describe('Scheduler — activity log (F2.7)', () => {
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
      status: 'pending',
      sessionId: null,
      order: 0,
      source: 'board',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      agentProjectId: null,
      parentTaskId: null,
    } as unknown as Task;
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
      appendTaskEvent: vi.fn(),
      getSettings: () => ({ maxAutoRetries: 0, limitJitterMs: 0, concurrency: 1 }),
      saveLimitGate: vi.fn(),
      loadLimitGate: () => null,
      saveAuthGate: vi.fn(),
      loadAuthGate: () => null,
      saveParkedRuns: vi.fn(),
      loadParkedRuns: () => [],
      // `planVerdictFor`'s overlap check reads this for every `plan-approval`, whether or
      // not auto-approve is on — nothing here is about the overlap feed, so an empty list.
      listMergeRequests: () => [],
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const start = vi.fn((_req: unknown, opts: { runId?: string }) => ({
      runId: opts?.runId ?? 'r-new',
    }));
    const sessions = { start, stop: vi.fn(), send: vi.fn() } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    const { rows, append } = createFakeAppendActivity();
    scheduler.setActivityRecorder(createActivityRecorder({ append }));
    return { scheduler, project, card, start, rows };
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
  const resumedRun = (scheduler: Scheduler): { runId: string } | undefined =>
    [
      ...(
        scheduler as unknown as { runs: Map<string, { runId: string; settled: boolean }> }
      ).runs.values(),
    ].find((r) => !r.settled);

  /** The credential is dead, reported by the run that proved it — raises the sign-in gate. */
  const hitSignedOut = (scheduler: Scheduler, runId: string): void => {
    const engine = scheduler as unknown as {
      runs: Map<string, { runId: string }>;
      engageAuthFailure: (failing: { runId: string }, reason: string) => void;
    };
    engine.engageAuthFailure(engine.runs.get(runId)!, 'OAuth session expired');
  };

  it('records a limit park then its resume, both reason "limit", the resume carrying the new run and origin "resume"', () => {
    const h = setup();
    startRun(h.scheduler, h.project, h.card, {});
    hitLimit(h.scheduler);

    const parked = h.rows.filter((r) => r.kind === 'parked');
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      taskId: 't1',
      runId: expect.any(String),
      origin: 'human',
      detail: { reason: 'limit' },
    });

    h.scheduler.resumeLimitNow();
    const run = resumedRun(h.scheduler);

    const resumed = h.rows.filter((r) => r.kind === 'resumed');
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({
      taskId: 't1',
      runId: run?.runId,
      origin: 'resume',
      detail: { reason: 'limit' },
    });
  });

  it('adds no second parked row while a second engageLimit drains into the standing gate', () => {
    const h = setup();
    startRun(h.scheduler, h.project, h.card, {});
    hitLimit(h.scheduler);
    hitLimit(h.scheduler); // the same account-wide wall, hit again before the reset

    expect(h.rows.filter((r) => r.kind === 'parked')).toHaveLength(1);
  });

  it('records one parked row with origin "human" when Start is pressed during a limit', () => {
    const h = setup();
    hitLimit(h.scheduler); // raises the gate with nothing in flight to park
    h.scheduler.startTaskNow('t1');

    const parked = h.rows.filter((r) => r.kind === 'parked');
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ taskId: 't1', runId: null, origin: 'human' });
  });

  it('records a sign-in park then a resume with reason "sign-in" once signedIn() fires', () => {
    const h = setup();
    const runId = startRun(h.scheduler, h.project, h.card, {});
    hitSignedOut(h.scheduler, runId);

    const parked = h.rows.filter((r) => r.kind === 'parked');
    expect(parked).toHaveLength(1);
    expect(parked[0].detail).toEqual({ reason: 'sign-in' });

    h.scheduler.signedIn();

    const resumed = h.rows.filter((r) => r.kind === 'resumed');
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ origin: 'resume', detail: { reason: 'sign-in' } });
  });

  it('a throwing append does not stop the park or the resume', () => {
    const h = setup();
    h.scheduler.setActivityRecorder(
      createActivityRecorder({
        append: () => {
          throw new Error('disk full');
        },
      }),
    );
    startRun(h.scheduler, h.project, h.card, {});

    expect(() => hitLimit(h.scheduler)).not.toThrow();
    expect(h.card.status).toBe('blocked-by-limit');

    expect(() => h.scheduler.resumeLimitNow()).not.toThrow();
    expect(resumedRun(h.scheduler)).toBeDefined();
  });

  describe('attention (raiseAttention)', () => {
    it('records "plan-presented", with the run\'s own id and origin, when a plan is raised for approval', () => {
      const h = setup();
      const runId = startRun(h.scheduler, h.project, h.card, {});
      void h.scheduler.decidePermission({
        runId,
        toolName: 'ExitPlanMode',
        input: { plan: '## Reproduce it\nfirst\n\n## Fix it\nsecond' },
      } as never);

      const rows = h.rows.filter((r) => r.kind === 'plan-presented');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ taskId: 't1', runId, origin: 'human' });
    });

    it('records "question-raised" when the CLI\'s own AskUserQuestion is held', () => {
      const h = setup();
      const runId = startRun(h.scheduler, h.project, h.card, {});
      void h.scheduler.decidePermission({
        runId,
        toolName: 'AskUserQuestion',
        input: {
          questions: [
            {
              header: 'Database',
              question: 'Which database should this use?',
              multiSelect: false,
              options: [{ label: 'SQLite', description: 'Embedded, zero-config.' }],
            },
          ],
        },
      } as never);

      const rows = h.rows.filter((r) => r.kind === 'question-raised');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ taskId: 't1', runId, origin: 'human' });
    });

    it('records nothing for an ordinary risky-tool permission prompt', () => {
      const h = setup();
      const runId = startRun(h.scheduler, h.project, h.card, {});
      void h.scheduler.decidePermission({
        runId,
        toolName: 'Bash',
        input: { command: 'git push' },
      } as never);

      expect(
        h.rows.filter((r) => r.kind === 'plan-presented' || r.kind === 'question-raised'),
      ).toEqual([]);
    });
  });

  /**
   * Merges, driven directly through `applyIntegrationResult` / `escalateConflict` the way
   * the auto-release `merge()` helper does — the store is the same minimal shape, proven by
   * that describe block not to trip any of the downstream chain/release machinery a
   * `'merged'` result also runs.
   */
  describe('merges (applyIntegrationResult / escalateConflict)', () => {
    function setup() {
      const project = {
        id: 'agent-1',
        name: 'Checkout service',
        path: 'C:/repo',
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
        title: 'Ship the export dialog',
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
      const start = vi.fn((_req: unknown, o: { runId?: string }) => ({
        runId: o?.runId ?? 'r-new',
      }));
      const sessions = { start, stop: vi.fn(), send: vi.fn() } as unknown as SessionManager;
      const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
      const { rows, append } = createFakeAppendActivity();
      scheduler.setActivityRecorder(createActivityRecorder({ append }));
      const ctx = {
        taskId: 't1',
        runId: 'r1',
        branch: 'feat/export',
        base: 'development',
        worktree: 'C:/wt/t1',
      };
      const engine = scheduler as unknown as {
        applyIntegrationResult: (p: Project, c: unknown, r: unknown) => void;
        escalateConflict: (p: Project, c: unknown) => void;
        conflictFixAttempts: Map<string, number>;
      };
      /** The merge/conflict/failure outcome, exactly as `integrateWorktree` reports it. */
      const apply = (result: Record<string, unknown>): void =>
        engine.applyIntegrationResult(project, ctx, result);
      return { scheduler, card, rows, engine, ctx, project, apply };
    }

    it('records "merge-landed" with the branch when a merge lands', () => {
      const h = setup();
      h.apply({ status: 'merged' });

      const rows = h.rows.filter((r) => r.kind === 'merge-landed');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        taskId: 't1',
        runId: 'r1',
        origin: null,
        detail: { branch: 'feat/export' },
      });
    });

    it('records "merge-failed" with the status as the reason for a dirty base', () => {
      const h = setup();
      h.apply({ status: 'dirty-base', base: 'development' });

      const rows = h.rows.filter((r) => r.kind === 'merge-failed');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        taskId: 't1',
        detail: { branch: 'feat/export', reason: 'dirty-base' },
      });
    });

    it('records "merge-failed" with the message as the reason for an error', () => {
      const h = setup();
      h.apply({ status: 'error', message: 'git blew up' });

      const rows = h.rows.filter((r) => r.kind === 'merge-failed');
      expect(rows).toHaveLength(1);
      expect(rows[0].detail).toEqual({ branch: 'feat/export', reason: 'git blew up' });
    });

    it('records nothing for a rebase or a no-op merge', () => {
      const h = setup();
      h.apply({
        status: 'rebased',
        branch: 'feat/export',
        base: 'development',
        worktree: 'C:/wt/t1',
      });
      h.apply({
        status: 'nothing-to-merge',
        branch: 'feat/export',
        base: 'development',
        reason: 'already merged',
      });

      expect(h.rows).toEqual([]);
    });

    it('records exactly one "merge-conflict" row, even after the AI fix hits a conflict again', () => {
      const h = setup();
      h.apply({
        status: 'conflict',
        worktree: h.ctx.worktree,
        branch: h.ctx.branch,
        base: h.ctx.base,
      });
      // The AI fix's own attempt came back conflicted too — `spent` is no longer 0 for this
      // task, whether or not a real Rung 2 dispatch ran, and that alone must suppress a
      // second row.
      h.engine.conflictFixAttempts.set(h.ctx.taskId, 1);
      h.engine.escalateConflict(h.project, h.ctx);

      const rows = h.rows.filter((r) => r.kind === 'merge-conflict');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        taskId: 't1',
        runId: 'r1',
        detail: { branch: 'feat/export' },
      });
    });
  });

  /**
   * Release runs settle through `settle`'s own `releaseSeed` branch, driven through the real
   * event path (`onRunEvent`'s `case 'result'`) so `releasedVersionFrom` is exercised on the
   * actual field it reads, `resultText`.
   */
  describe('release runs (settle)', () => {
    function setup() {
      const project = {
        id: 'agent-1',
        name: 'Checkout service',
        path: 'C:/repo',
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
      const start = vi.fn((_req: unknown, o: { runId?: string }) => ({
        runId: o?.runId ?? 'r-release',
      }));
      const sessions = { start, stop: vi.fn(), send: vi.fn() } as unknown as SessionManager;
      const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
      const { rows, append } = createFakeAppendActivity();
      scheduler.setActivityRecorder(createActivityRecorder({ append }));
      const runId = (
        scheduler as unknown as {
          startTask: (p: Project, t: Task, o: Record<string, unknown>) => string;
        }
      ).startTask(project, card, { releaseSeed: true, origin: 'auto-release' });
      const fire = (event: unknown): Promise<void> =>
        (
          scheduler as unknown as { onRunEvent: (r: string, e: unknown) => Promise<void> }
        ).onRunEvent(runId, event);
      return { scheduler, card, rows, runId, fire };
    }

    const resultEvent = (resultText: string, success = true) => ({
      kind: 'result',
      success,
      resultText,
      costUsd: null,
      durationMs: null,
      stopReason: null,
      terminalReason: null,
    });

    it('records "release-published", origin "auto-release", with the version named in the reply', async () => {
      const h = setup();
      await h.fire(resultEvent('Released v1.4.0, tagged and published on GitHub.'));

      const rows = h.rows.filter((r) => r.kind === 'release-published');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        taskId: 't1',
        runId: h.runId,
        origin: 'auto-release',
        detail: { version: 'v1.4.0' },
      });
    });

    it('records nothing for a failed release run', async () => {
      const h = setup();
      await h.fire(resultEvent('npm publish exited 1', false));

      expect(h.rows.filter((r) => r.kind === 'release-published')).toEqual([]);
    });
  });
});

/**
 * "Open a PR when finished" — the alternative to merging, taken at the moment the work is
 * written.
 *
 * Three things are worth pinning and nothing else here is: it wins over auto-merge (the two
 * are alternatives, and merging first would open a pull request for work base already has),
 * it is asked of the card that OWNS the branch so a plan opens one PR rather than one per
 * step, and a create that fails leaves the branch exactly where it was.
 */
describe('Scheduler.settle — opening a pull request instead of merging', () => {
  function setup(opts: {
    projectAutoCreatePr?: boolean;
    cardAutoCreatePr?: boolean | null;
    autoIntegrate?: boolean | null;
    /** Steps of an approved plan, if this card has any. */
    steps?: Array<{ id: string; status: string }>;
    /** What the wired opener does. Omitted = a happy `#12`. */
    open?: (taskId: string) => Promise<{ url: string; ref: string }>;
    /** Leave the opener unwired, as a scheduler nobody called `setPullRequestOpener` on. */
    unwired?: boolean;
  }) {
    const project = {
      id: 'agent-1',
      name: 'Checkout service',
      path: 'C:/repo',
      planPath: '',
      kind: 'agent',
      concurrency: 1,
      useWorktrees: true,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'acceptEdits',
      instructions: '',
      baseBranch: 'development',
      autoCreatePr: opts.projectAutoCreatePr ?? false,
      autoIntegrate: opts.autoIntegrate ?? null,
    } as unknown as Project;
    const card = {
      id: 't1',
      projectId: 'personal',
      phase: '',
      title: 'Fix the export dialog',
      status: 'running',
      order: 0,
      source: 'jira',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      agentProjectId: 'agent-1',
      parentTaskId: null,
      autoCreatePr: opts.cardAutoCreatePr ?? null,
    } as unknown as Task;
    const steps = (opts.steps ?? []).map(
      (s) =>
        ({
          ...s,
          projectId: 'personal',
          phase: '',
          title: s.id,
          order: 0,
          source: 'jira',
          dependsOn: [],
          isContract: false,
          isScaffold: false,
          agentProjectId: 'agent-1',
          parentTaskId: 't1',
        }) as unknown as Task,
    );
    const byId = new Map<string, Task>([['t1', card], ...steps.map((s) => [s.id, s] as const)]);
    const notes: string[] = [];
    const store = {
      getTask: (id: string) => byId.get(id),
      getProject: (id: string) => (id === 'agent-1' ? project : undefined),
      listProjects: () => [project],
      getTasks: () => [card, ...steps],
      getSubtasks: (parentId: string) => (parentId === 't1' ? steps : []),
      getTaskActivity: () => [],
      addComment: (_p: string, _t: string, body: string) => notes.push(body),
      listTaskLinks: () => [],
      updateTask: (id: string, patch: Partial<Task>) => {
        const found = byId.get(id);
        if (found) Object.assign(found, patch);
        return found;
      },
      appendTaskEvent: vi.fn(),
      appendTokenUsage: vi.fn(),
      saveAttention: vi.fn(),
      deleteAttention: () => undefined,
      listAttention: () => [],
      getTaskHistory: () => [],
      getSettings: () => ({
        maxAutoRetries: 0,
        limitJitterMs: 0,
        concurrency: 1,
        autoIntegrate: false,
      }),
    } as unknown as Store;
    const worktrees = {
      // Answers a real shape rather than `undefined`: finishing a step advances the chain,
      // which really does try to start the next one, and a bare `vi.fn()` there surfaces as
      // an unhandled rejection deep inside `prepareAndLaunch` that has nothing to do with
      // what is being tested. 'failed' is the cheapest honest answer — the next step parks
      // instead of launching a session none of these tests want.
      prepare: vi.fn(async () => ({ mode: 'failed', reason: 'no worktree in this test' })),
      integrate: vi.fn(),
      inspect: vi.fn(),
      cleanup: vi.fn(),
      changedFiles: vi.fn(async () => []),
    };
    const sessions = { start: vi.fn(), stop: vi.fn(), send: vi.fn() } as unknown as SessionManager;
    const emitAttention = vi.fn();
    const scheduler = new Scheduler(
      store,
      sessions,
      vi.fn(),
      vi.fn(),
      emitAttention,
      vi.fn(),
      vi.fn(),
      worktrees as unknown as WorktreeManager,
    );
    const open = vi.fn(
      opts.open ?? (async () => ({ url: 'https://github.com/o/r/pull/12', ref: '#12' })),
    );
    if (!opts.unwired) scheduler.setPullRequestOpener(open);

    /** Settle a finished run that owns the card's branch — the moment the work is written. */
    const finish = (taskId = 't1'): void =>
      (scheduler as unknown as { settle: (r: unknown, s: string) => void }).settle(
        {
          runId: 'r1',
          taskId,
          projectId: 'agent-1',
          branch: 'feat/export',
          base: 'development',
          worktree: 'C:/wt/t1',
        },
        'done',
      );

    const flush = async (): Promise<void> => {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    };

    return { scheduler, card, steps, notes, worktrees, open, store, finish, flush, emitAttention };
  }

  it('does nothing at all when nobody asked for a pull request', async () => {
    const { finish, flush, open } = setup({});
    finish();
    await flush();
    expect(open).not.toHaveBeenCalled();
  });

  it('opens one when the project prefers it, and merges NOTHING', async () => {
    const { finish, flush, open, worktrees, notes } = setup({ projectAutoCreatePr: true });
    finish();
    await flush();

    expect(open).toHaveBeenCalledWith('t1');
    expect(worktrees.integrate).not.toHaveBeenCalled();
    expect(notes.some((n) => n.includes('#12') && n.includes('NOT been merged'))).toBe(true);
  });

  it('wins over auto-merge — the two are alternatives, not a sequence', async () => {
    const { finish, flush, open, worktrees } = setup({
      projectAutoCreatePr: true,
      autoIntegrate: true,
    });
    finish();
    await flush();

    expect(open).toHaveBeenCalledTimes(1);
    // Merging first would have opened a pull request for work base already had.
    expect(worktrees.integrate).not.toHaveBeenCalled();
  });

  it('lets a card overrule its project in both directions', async () => {
    const off = setup({ projectAutoCreatePr: true, cardAutoCreatePr: false });
    off.finish();
    await off.flush();
    expect(off.open).not.toHaveBeenCalled();

    const on = setup({ cardAutoCreatePr: true });
    on.finish();
    await on.flush();
    expect(on.open).toHaveBeenCalledTimes(1);
  });

  it('does not fire for a step whose siblings are still queued', async () => {
    const { finish, flush, open } = setup({
      projectAutoCreatePr: true,
      steps: [
        { id: 's1', status: 'running' },
        { id: 's2', status: 'pending' },
      ],
    });

    // The chain's branch is not finished, so there is nothing to open a pull request for
    // yet — `hasPendingSibling` returns above the whole integration block.
    finish('s1');
    await flush();
    expect(open).not.toHaveBeenCalled();
  });

  it('opens it against the CARD when the last step of a plan lands', async () => {
    const { finish, flush, open } = setup({
      projectAutoCreatePr: true,
      steps: [
        { id: 's1', status: 'done' },
        { id: 's2', status: 'running' },
      ],
    });

    finish('s2');
    await flush();

    // 't1', not 's2': a plan's steps share one branch, so one pull request opens for the
    // card that owns it.
    expect(open).toHaveBeenCalledWith('t1');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('a failed create parks the card and leaves the branch exactly where it was', async () => {
    const { finish, flush, worktrees, store, scheduler } = setup({
      projectAutoCreatePr: true,
      open: async () => {
        throw new Error('No GitHub token is saved.');
      },
    });

    finish();
    await flush();

    // Nothing merged, nothing cleaned up: the branch is untouched and both buttons still work.
    expect(worktrees.integrate).not.toHaveBeenCalled();
    expect(worktrees.cleanup).not.toHaveBeenCalled();
    expect(
      (scheduler as unknown as { readyToIntegrate: Map<string, unknown> }).readyToIntegrate.has(
        't1',
      ),
    ).toBe(true);
    // And it parked, naming the wall rather than failing silently.
    const saved = (store.saveAttention as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String((saved?.[0] as { prompt: string })?.prompt)).toMatch(/No GitHub token is saved/);
  });

  it(
    'a parked PR failure offers "Retry the pull request", never "Retry integration" — and ' +
      'retrying it calls the opener again, not integrateWorktree',
    async () => {
      let attempt = 0;
      const { finish, flush, worktrees, scheduler, open, emitAttention, notes } = setup({
        projectAutoCreatePr: true,
        open: async () => {
          attempt++;
          if (attempt === 1) throw new Error('No GitHub token is saved.');
          return { url: 'https://github.com/o/r/pull/12', ref: '#12' };
        },
      });

      finish();
      await flush();
      expect(open).toHaveBeenCalledTimes(1);

      const item = emitAttention.mock.calls[0][0] as { id: string; options: string[] };
      expect(item.options).toEqual([
        FAILURE_ACTION.retryPullRequest,
        FAILURE_ACTION.aiFix,
        FAILURE_ACTION.leaveBranch,
        FAILURE_ACTION.cleanup,
        FAILURE_ACTION.markDone,
      ]);

      scheduler.answerAttention(item.id, {
        decision: 'reply',
        text: FAILURE_ACTION.retryPullRequest,
      });
      await flush();

      // The retry re-opened the pull request — not a local merge.
      expect(open).toHaveBeenCalledTimes(2);
      expect(worktrees.integrate).not.toHaveBeenCalled();
      expect(notes.some((n) => n.includes('#12') && n.includes('was opened for it'))).toBe(true);
    },
  );

  it(
    'a parked PR failure\'s "AI fix & retry" requeues the agent with the sync conflict as ' +
      'context, instead of reopening the PR directly or merging locally',
    async () => {
      const { finish, flush, worktrees, scheduler, open, emitAttention } = setup({
        projectAutoCreatePr: true,
        open: async () => {
          throw new Error(
            '"development" has moved on github.com since "feat/export" was built, and ' +
              'rebasing onto its current state conflicts on packages/shared/src/ipcRelay.test.ts.',
          );
        },
      });

      finish();
      await flush();
      expect(open).toHaveBeenCalledTimes(1);

      const item = emitAttention.mock.calls[0][0] as { id: string; options: string[] };
      expect(item.options).toContain(FAILURE_ACTION.aiFix);

      scheduler.answerAttention(item.id, { decision: 'reply', text: FAILURE_ACTION.aiFix });
      await flush();

      // Handed to the agent as fix context on the next run, not re-opened and not merged.
      const fixNotes = (scheduler as unknown as { fixNotes: Map<string, string> }).fixNotes;
      expect(fixNotes.get('t1')).toMatch(/conflicts on packages\/shared\/src\/ipcRelay\.test\.ts/);
      expect(open).toHaveBeenCalledTimes(1);
      expect(worktrees.integrate).not.toHaveBeenCalled();
      // requeue() re-attempts the task's own work, which goes through prepare again.
      expect(worktrees.prepare).toHaveBeenCalled();
    },
  );

  it('says the branch was PUSHED, not opened, when the request was already there', async () => {
    // The second settle of a card that goes on working. `openPullRequest` pushes into the
    // pull request that is already open and reports `existed`, so the note must not announce
    // a second one — there is only ever the one, and it now carries this work too.
    const { finish, flush, notes } = setup({
      projectAutoCreatePr: true,
      open: async () => ({
        url: 'https://github.com/o/r/pull/12',
        ref: '#12',
        existed: true,
      }),
    });

    finish();
    await flush();

    const note = notes.find((n) => n.includes('#12'));
    expect(note).toMatch(/already open/);
    expect(note).not.toMatch(/was opened for it/);
    // Still the thing a human most needs to read off this card: it did NOT merge.
    expect(note).toMatch(/NOT been merged/);
  });

  it('says so on the card when nothing is wired to reach a forge', async () => {
    const { finish, flush, notes, worktrees } = setup({
      projectAutoCreatePr: true,
      unwired: true,
    });
    finish();
    await flush();

    expect(notes.some((n) => n.includes('cannot reach a forge'))).toBe(true);
    expect(worktrees.integrate).not.toHaveBeenCalled();
  });
});

/**
 * TM-460: a base-moved conflict found while OPENING a pull request (`openPullRequestFor`'s
 * catch) is handed to the card's own agent instead of being parked outright — the same
 * Rung 2/Rung 3 ladder the PR/MR conflict suite above drives, reached from a different
 * door. `open` is wired to throw a `BaseMovedConflictError` on its first call (as the real
 * `openPullRequest` now does on a conflicted sync) and a plain `#12` on any call after.
 */
describe('Scheduler.settle — a base-moved conflict found while opening a pull request (TM-460)', () => {
  function setup(
    opts: {
      rebaseResult?: Record<string, unknown>;
      finishResult?: Record<string, unknown>;
    } = {},
  ) {
    const project = {
      id: 'agent-1',
      name: 'Checkout service',
      path: 'C:/repo',
      planPath: '',
      kind: 'agent',
      concurrency: 1,
      useWorktrees: true,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'acceptEdits',
      instructions: '',
      baseBranch: 'development',
      autoCreatePr: true,
    } as unknown as Project;
    const card = {
      id: 't1',
      projectId: 'personal',
      phase: '',
      title: 'Fix the export dialog',
      status: 'running',
      sessionId: 'sess-1',
      order: 0,
      source: 'jira',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      agentProjectId: 'agent-1',
      agentBranch: 'orch/t1',
      agentMode: 'acceptEdits',
      parentTaskId: null,
    } as unknown as Task;
    const tasks = [card];
    const notes: string[] = [];
    const store = {
      getTask: (id: string) => tasks.find((x) => x.id === id),
      getProject: (id: string) => (id === 'agent-1' ? project : undefined),
      listProjects: () => [project],
      getTasks: () => tasks,
      getSubtasks: (parentId: string) => tasks.filter((x) => x.parentTaskId === parentId),
      getTaskActivity: () => [],
      addComment: (_p: string, _t: string, body: string) => notes.push(body),
      listTaskLinks: () => [],
      updateTask: (id: string, patch: Partial<Task>) => {
        const found = tasks.find((x) => x.id === id);
        if (found) Object.assign(found, patch);
        return found;
      },
      appendTaskEvent: vi.fn((_p: string, _t: string, _r: string, e: { text?: string }) => {
        if (e?.text) notes.push(e.text);
      }),
      appendTokenUsage: vi.fn(),
      getSettings: () => ({
        maxAutoRetries: 0,
        limitJitterMs: 0,
        concurrency: 1,
        trustedGateCommands: [],
      }),
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;

    const rebaseCalls: Array<{ branch: string; target: string; upstream?: string }> = [];
    const finishCalls: Array<{ branch: string; target: string; upstream?: string }> = [];
    const worktrees = {
      // Succeeds, so the requeued conflict-fix run's own launch doesn't park a SECOND,
      // unrelated "run" failure on top of the one this suite is about.
      prepare: vi.fn(async () => ({
        mode: 'worktree',
        cwd: 'C:/wt/t1',
        branch: 'orch/t1',
        base: 'development',
      })),
      inspect: vi.fn(async () => ({ cwd: 'C:/wt/t1', branch: 'orch/t1', base: 'development' })),
      listConflicts: vi.fn(async () => ['src/app.ts']),
      rebaseForPullRequest: vi.fn(
        async (
          _p: Project,
          branch: string,
          target: string,
          worktree: string,
          _msg: string,
          ropts?: { upstream?: string },
        ) => {
          rebaseCalls.push({ branch, target, upstream: ropts?.upstream });
          return opts.rebaseResult ?? { status: 'rebased', branch, base: target, worktree };
        },
      ),
      finishPullRequestRebase: vi.fn(
        async (
          _p: Project,
          branch: string,
          target: string,
          worktree: string,
          fopts?: { upstream?: string },
        ) => {
          finishCalls.push({ branch, target, upstream: fopts?.upstream });
          return opts.finishResult ?? { status: 'rebased', branch, base: target, worktree };
        },
      ),
      integrate: vi.fn(),
      cleanup: vi.fn(),
      changedFiles: vi.fn(async () => []),
    };

    const start = vi.fn((_req: unknown, o: { runId?: string }) => ({ runId: o?.runId ?? 'r-new' }));
    const sessions = { start, stop: vi.fn(), send: vi.fn() } as unknown as SessionManager;
    const emitAttention = vi.fn();
    const scheduler = new Scheduler(
      store,
      sessions,
      vi.fn(),
      vi.fn(),
      emitAttention,
      vi.fn(),
      vi.fn(),
      worktrees as unknown as WorktreeManager,
    );

    const err = new BaseMovedConflictError(
      '"development" has moved on github.com since "orch/t1" was built, and rebasing onto ' +
        'its current state conflicts on src/app.ts. Pull the latest development into this ' +
        'project and resolve that there, then press this again.',
      {
        branch: 'orch/t1',
        base: 'development',
        worktree: 'C:/wt/t1',
        files: ['src/app.ts'],
        remoteBase: 'refs/orch/remote-base',
        forkPoint: 'deadbeef',
        baseSubjects: ['theirs: rework app.ts'],
        branchSubjects: ['mine: fix the export dialog'],
      },
    );
    let attempt = 0;
    const open = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw err;
      return { url: 'https://github.com/o/r/pull/12', ref: '#12', existed: false };
    });
    scheduler.setPullRequestOpener(open);

    /** Settle a finished run that owns the card's branch — the moment the work is written. */
    const finish = (): void =>
      (scheduler as unknown as { settle: (r: unknown, s: string) => void }).settle(
        {
          runId: 'r1',
          taskId: 't1',
          projectId: 'agent-1',
          branch: 'orch/t1',
          base: 'development',
          worktree: 'C:/wt/t1',
        },
        'done',
      );

    /** Seed a live run for the card, as the scheduler would have while it is still working. */
    const seedRun = (runId: string): void => {
      (scheduler as unknown as { runs: Map<string, unknown> }).runs.set(runId, {
        taskId: 't1',
        projectId: 'agent-1',
        runId,
        settled: false,
      });
    };

    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    return {
      scheduler,
      card,
      notes,
      worktrees,
      open,
      store,
      finish,
      flush,
      emitAttention,
      rebaseCalls,
      finishCalls,
      err,
      seedRun,
      start,
    };
  }

  it(
    'requests a conflict-fix run — pendingConflictFix set, the requeued run is ' +
      'conflictFix:true with a prompt naming the files and both sides\u2019 subjects — no ' +
      'attention item and no task-failed; once it settles, finishPullRequestRebase runs and ' +
      'the opener is called a second time',
    async () => {
      const { finish, flush, open, emitAttention, scheduler, start, finishCalls } = setup({
        rebaseResult: {
          status: 'conflict',
          worktree: 'C:/wt/t1',
          branch: 'orch/t1',
          base: 'refs/orch/remote-base',
        },
      });

      finish();
      await flush();

      expect(open).toHaveBeenCalledTimes(1);
      // No task-failed and no human-facing merge-conflict item — the agent gets it instead.
      expect(emitAttention).not.toHaveBeenCalled();

      const pendingConflictFix = (
        scheduler as unknown as { pendingConflictFix: Map<string, { openPr?: unknown }> }
      ).pendingConflictFix;
      expect(pendingConflictFix.has('t1')).toBe(true);
      expect(pendingConflictFix.get('t1')?.openPr).toBeTruthy();

      type FakeRun = { taskId: string; runId: string; conflictFix?: boolean };
      const runs = (scheduler as unknown as { runs: Map<string, FakeRun> }).runs;
      const requeuedRun = [...runs.values()].find((r) => r.conflictFix === true);
      expect(requeuedRun).toBeTruthy();

      expect(start).toHaveBeenCalledTimes(1);
      const prompt = String((start.mock.calls[0]?.[0] as { prompt?: string })?.prompt ?? '');
      expect(prompt).toContain('src/app.ts');
      expect(prompt).toContain('theirs: rework app.ts');
      expect(prompt).toContain('mine: fix the export dialog');

      // The fix "settles" — the orchestrator finishes the rebase, which this time comes back
      // clean, and the opener is tried again.
      (scheduler as unknown as { settle: (r: FakeRun, s: string) => void }).settle(
        requeuedRun as FakeRun,
        'done',
      );
      await flush();

      expect(finishCalls).toEqual([
        { branch: 'orch/t1', target: 'refs/orch/remote-base', upstream: 'deadbeef' },
      ]);
      expect(open).toHaveBeenCalledTimes(2);
    },
  );

  it('parks a merge-conflict item naming the files once the AI fix runs out of attempts', async () => {
    const { finish, flush, emitAttention, scheduler } = setup({
      rebaseResult: {
        status: 'conflict',
        worktree: 'C:/wt/t1',
        branch: 'orch/t1',
        base: 'refs/orch/remote-base',
      },
    });
    (scheduler as unknown as { conflictFixAttempts: Map<string, number> }).conflictFixAttempts.set(
      't1',
      2,
    );

    finish();
    await flush();

    expect(emitAttention).toHaveBeenCalled();
    const item = emitAttention.mock.calls[0]?.[0] as { kind: string; prompt: string };
    expect(item.kind).toBe('merge-conflict');
    expect(item.prompt).toContain('src/app.ts');

    const pendingConflictFix = (
      scheduler as unknown as { pendingConflictFix: Map<string, unknown> }
    ).pendingConflictFix;
    expect(pendingConflictFix.has('t1')).toBe(false);
  });

  it(
    'defers a conflict found while the owner\u2019s worktree is busy — no rebase, no ' +
      'attention item — and the redrive performs the hand-off once the run exits',
    async () => {
      const { finish, flush, seedRun, scheduler, worktrees, emitAttention } = setup();
      seedRun('r-live');

      finish();
      await flush();

      expect(worktrees.rebaseForPullRequest).not.toHaveBeenCalled();
      expect(emitAttention).not.toHaveBeenCalled();
      const deferred = (scheduler as unknown as { deferredPrConflicts: Map<string, unknown> })
        .deferredPrConflicts;
      expect(deferred.has('t1')).toBe(true);

      // The run exits — freeing the worktree — and the redrive performs the hand-off.
      (scheduler as unknown as { runs: Map<string, unknown> }).runs.delete('r-live');
      (
        scheduler as unknown as { redriveForgeConflicts: (id: string) => void }
      ).redriveForgeConflicts('t1');
      await flush();

      expect(worktrees.rebaseForPullRequest).toHaveBeenCalledTimes(1);
      expect(deferred.has('t1')).toBe(false);
    },
  );
});

/**
 * `Scheduler.resolveForgeConflict` — the PR/MR twin of the ordinary merge conflict ladder.
 * A sync hands it a conflicted, in-scope MR on every poll; these cases drive the ladder
 * through a fake `worktrees` (the same shape the Rung 2 suite above uses, extended with
 * `inspect`/`rebaseForPullRequest`/`finishPullRequestRebase`/`isAncestor`) and a fake
 * `forgeGit` (`setForgeGit`'s `{ fetch, push }` pair).
 */
describe('Scheduler — the PR/MR conflict ladder (resolveForgeConflict)', () => {
  const okResult = {
    kind: 'result',
    success: true,
    resultText: '',
    costUsd: null,
    durationMs: null,
    stopReason: null,
    terminalReason: null,
  };

  const mergeRequest = (over: Partial<MergeRequest> = {}): MergeRequest => ({
    id: 'gl-1-12',
    taskId: 't1',
    openedForTaskId: null,
    provider: 'gitlab',
    repoId: 1,
    projectPath: 'group/repo',
    number: 12,
    title: 'Fix the export dialog',
    displayName: null,
    webUrl: 'https://gitlab.example.com/group/repo/-/merge_requests/12',
    sourceBranch: 'orch/t1',
    targetBranch: 'main',
    state: 'opened',
    draft: false,
    pipelineStatus: 'unknown',
    pipelineUrl: null,
    pipelineStages: [],
    approvalsRequired: null,
    approvalsGiven: 0,
    changesRequested: false,
    detailedMergeStatus: null,
    hasConflicts: true,
    issueKeys: [],
    latestNoteAt: null,
    lastReadAt: null,
    lastEventAt: null,
    lastEventSeenAt: null,
    headSha: null,
    lastActedSha: null,
    lastActedAction: null,
    updatedAt: 0,
    syncedAt: 0,
    ...over,
  });

  function setup(opts?: {
    prAutoResolve?: boolean;
    rebaseResult?: Record<string, unknown>;
    finishResult?: Record<string, unknown>;
    isAncestorResult?: boolean;
    fetchResult?: (branch: string) => { ok: true; sha: string } | { ok: false; message: string };
    pushResult?: { ok: true } | { ok: false; message: string };
    inspectResult?: { cwd: string; branch: string; base: string } | null;
    /** Extra subtasks of `t1` (Phase: never auto-rebase a worktree a step is still using). */
    steps?: Array<{ id: string; status: Task['status'] }>;
    dirty?: boolean;
  }) {
    const project = {
      id: 'agent-1',
      name: 'Checkout service',
      path: 'C:/repo',
      planPath: '',
      kind: 'agent',
      concurrency: 1,
      useWorktrees: true,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'acceptEdits',
    } as unknown as Project;
    const card = {
      id: 't1',
      projectId: 'personal',
      phase: '',
      title: 'Fix the export dialog',
      status: 'in-progress',
      sessionId: 'sess-1',
      order: 0,
      source: 'adhoc',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      agentProjectId: 'agent-1',
      agentBranch: 'orch/t1',
      agentMode: 'acceptEdits',
      parentTaskId: null,
    } as unknown as Task;
    const steps: Task[] = (opts?.steps ?? []).map(
      (s) =>
        ({
          id: s.id,
          projectId: 'personal',
          phase: '',
          title: `Step ${s.id}`,
          status: s.status,
          order: 0,
          source: 'adhoc',
          dependsOn: [],
          isContract: false,
          isScaffold: false,
          agentProjectId: 'agent-1',
          parentTaskId: 't1',
        }) as unknown as Task,
    );
    const tasks = [card, ...steps];
    const notes: string[] = [];
    const store = {
      getTask: (id: string) => tasks.find((t) => t.id === id),
      getProject: (id: string) => (id === 'agent-1' ? project : undefined),
      listProjects: () => [project],
      getTasks: () => tasks,
      getSubtasks: (parentId: string) => tasks.filter((t) => t.parentTaskId === parentId),
      getTaskActivity: () => [],
      addComment: (_p: string, _t: string, body: string) => notes.push(body),
      listTaskLinks: () => [],
      listMergeRequests: () => [],
      updateTask: (id: string, patch: Partial<Task>) => {
        const t = tasks.find((x) => x.id === id);
        if (t) Object.assign(t, patch);
        return t;
      },
      appendTaskEvent: vi.fn((_p: string, _t: string, _r: string, e: { text?: string }) => {
        if (e?.text) notes.push(e.text);
      }),
      appendTokenUsage: vi.fn(),
      getSettings: () => ({
        maxAutoRetries: 0,
        limitJitterMs: 0,
        concurrency: 1,
        features: { prAutoResolve: opts?.prAutoResolve ?? true },
      }),
      saveLimitGate: () => undefined,
      loadLimitGate: () => null,
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;

    const rebaseCalls: Array<{ branch: string; target: string }> = [];
    const finishCalls: Array<{ branch: string; target: string }> = [];
    const worktrees = {
      prepare: vi.fn(async () => ({
        mode: 'worktree',
        cwd: 'C:/wt/t1',
        branch: 'orch/t1',
        base: 'main',
      })),
      inspect: vi.fn(async () =>
        opts && 'inspectResult' in opts
          ? opts.inspectResult
          : { cwd: 'C:/wt/t1', branch: 'orch/t1', base: 'main' },
      ),
      listConflicts: vi.fn(async () => ['src/app.ts']),
      isAncestor: vi.fn(async () => opts?.isAncestorResult ?? true),
      hasUncommittedWork: vi.fn(async () => opts?.dirty ?? false),
      rebaseForPullRequest: vi.fn(async (_p: Project, branch: string, target: string) => {
        rebaseCalls.push({ branch, target });
        return (
          opts?.rebaseResult ?? { status: 'rebased', branch, base: target, worktree: 'C:/wt/t1' }
        );
      }),
      finishPullRequestRebase: vi.fn(async (_p: Project, branch: string, target: string) => {
        finishCalls.push({ branch, target });
        return (
          opts?.finishResult ?? { status: 'rebased', branch, base: target, worktree: 'C:/wt/t1' }
        );
      }),
      integrate: vi.fn(),
      cleanup: vi.fn(),
    } as unknown as WorktreeManager;

    const fetchCalls: Array<{ branch: string; localRef: string }> = [];
    const pushCalls: Array<{ branch: string; expected: string }> = [];
    const forgeGit: ForgeGit = {
      fetch: vi.fn(
        async (
          _p: Project,
          _cwd: string,
          branch: string,
          localRef: string,
        ): Promise<{ ok: true; sha: string } | { ok: false; message: string }> => {
          fetchCalls.push({ branch, localRef });
          return opts?.fetchResult?.(branch) ?? { ok: true, sha: 'sha-remote-1' };
        },
      ),
      push: vi.fn(
        async (
          _p: Project,
          _cwd: string,
          branch: string,
          expected: string,
        ): Promise<{ ok: true } | { ok: false; message: string }> => {
          pushCalls.push({ branch, expected });
          return opts?.pushResult ?? { ok: true };
        },
      ),
    };

    const start = vi.fn((_req: unknown, o: { runId?: string }) => ({ runId: o?.runId ?? 'r-new' }));
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
    scheduler.setForgeGit(forgeGit);
    const marked: Array<{ mrId: string; sha: string; action: string }> = [];
    scheduler.setMarkMrActed((mrId, sha, action) => marked.push({ mrId, sha, action }));

    const fire = (runId: string, event: unknown): Promise<void> =>
      (scheduler as unknown as { onRunEvent: (r: string, e: unknown) => Promise<void> }).onRunEvent(
        runId,
        event,
      );

    /** Seed a live run for a step, as the scheduler would have after launching it. */
    const seedRun = (runId: string, taskId: string): void => {
      (scheduler as unknown as { runs: Map<string, unknown> }).runs.set(runId, {
        taskId,
        projectId: 'agent-1',
        runId,
        settled: false,
      });
      (scheduler as unknown as { inFlight: Set<string> }).inFlight.add(taskId);
    };

    return {
      scheduler,
      card,
      steps,
      store,
      worktrees,
      forgeGit,
      start,
      emitAttention,
      notes,
      rebaseCalls,
      finishCalls,
      fetchCalls,
      pushCalls,
      marked,
      fire,
      seedRun,
    };
  }

  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('a clean rebase pushes with the lease and stamps the episode once it settles', async () => {
    const { scheduler, rebaseCalls, pushCalls, notes, marked } = setup();
    scheduler.resolveForgeConflict('t1', mergeRequest({ headSha: 'sha-head-1' }));
    // Dispatch alone — the ladder is still a pending promise at this point — leaves the row
    // unstamped. Only the terminal it eventually reaches (the push below) stamps it.
    expect(marked).toEqual([]);
    await flush();

    expect(rebaseCalls).toEqual([{ branch: 'orch/t1', target: 'refs/remotes/origin/main' }]);
    expect(pushCalls).toEqual([{ branch: 'orch/t1', expected: 'sha-remote-1' }]);
    expect(notes.some((n) => n.includes('pushed it back'))).toBe(true);
    expect(marked).toEqual([{ mrId: 'gl-1-12', sha: 'sha-remote-1', action: 'resolve-conflicts' }]);
  });

  it('a push that is refused still stamps the episode, alongside the parked failure', async () => {
    const { scheduler, pushCalls, emitAttention, marked } = setup({
      pushResult: { ok: false, message: 'stale info' },
    });
    scheduler.resolveForgeConflict('t1', mergeRequest({ headSha: 'sha-head-1' }));
    await flush();

    expect(pushCalls).toEqual([{ branch: 'orch/t1', expected: 'sha-remote-1' }]);
    expect(emitAttention).toHaveBeenCalledTimes(1);
    expect(emitAttention.mock.calls[0][0]).toMatchObject({ kind: 'task-failed' });
    expect(marked).toEqual([{ mrId: 'gl-1-12', sha: 'sha-remote-1', action: 'resolve-conflicts' }]);
  });

  it('a card with no live worktree to rebase stamps the episode on its refusal note', async () => {
    const { scheduler, notes, rebaseCalls, marked } = setup({ inspectResult: null });
    scheduler.resolveForgeConflict('t1', mergeRequest({ headSha: 'sha-head-1' }));
    await flush();

    expect(rebaseCalls).toEqual([]);
    expect(notes.some((n) => n.includes('no live worktree to rebase it in'))).toBe(true);
    expect(marked).toEqual([{ mrId: 'gl-1-12', sha: 'sha-head-1', action: 'resolve-conflicts' }]);
  });

  it('an error rebasing stamps the episode, alongside the parked failure', async () => {
    const { scheduler, emitAttention, marked } = setup({
      rebaseResult: { status: 'error', message: 'git blew up' },
    });
    scheduler.resolveForgeConflict('t1', mergeRequest({ headSha: 'sha-head-1' }));
    await flush();

    expect(emitAttention).toHaveBeenCalledTimes(1);
    expect(emitAttention.mock.calls[0][0]).toMatchObject({ kind: 'task-failed' });
    expect(marked).toEqual([{ mrId: 'gl-1-12', sha: 'sha-remote-1', action: 'resolve-conflicts' }]);
  });

  it(
    'a restart that re-drives a worktree already paused mid-rebase, with resolutions ' +
      'already staged, still stamps the episode once the push lands — the exact state of ' +
      'a stranded worktree this app left behind before it could stamp its own row',
    async () => {
      // A brand-new Scheduler, exactly as a restart would build one: no in-memory
      // `forgeConflictHandled`/`forgeConflicts` state survives, and the MR row synced back
      // in is still unstamped (`lastActedSha`/`lastActedAction` both null, the default
      // `mergeRequest()` below). `rebaseForPullRequest` stands in for git continuing the
      // rebase this app had already paused in the worktree, with the agent's resolutions
      // already `git add`ed — from this call's point of view that is indistinguishable
      // from a fresh rebase landing clean, which is exactly why the real worktree needs
      // nothing special done to it on restart.
      const { scheduler, rebaseCalls, pushCalls, marked } = setup();
      const mr = mergeRequest({
        headSha: 'sha-stranded',
        lastActedSha: null,
        lastActedAction: null,
      });

      scheduler.resolveForgeConflict('t1', mr);
      await flush();

      expect(rebaseCalls).toEqual([{ branch: 'orch/t1', target: 'refs/remotes/origin/main' }]);
      expect(pushCalls).toEqual([{ branch: 'orch/t1', expected: 'sha-remote-1' }]);
      expect(marked).toEqual([
        { mrId: 'gl-1-12', sha: 'sha-remote-1', action: 'resolve-conflicts' },
      ]);
    },
  );

  it('a conflict dispatches the agent fix, and a successful settle pushes', async () => {
    const { scheduler, start, fire, finishCalls, pushCalls } = setup({
      rebaseResult: {
        status: 'conflict',
        worktree: 'C:/wt/t1',
        branch: 'orch/t1',
        base: 'refs/remotes/origin/main',
      },
    });
    scheduler.resolveForgeConflict('t1', mergeRequest());
    await flush();

    expect(start).toHaveBeenCalledTimes(1);
    const fixRunId = (start.mock.calls[0][1] as { runId: string }).runId;
    fire(fixRunId, okResult);
    await flush();

    expect(finishCalls).toEqual([{ branch: 'orch/t1', target: 'refs/remotes/origin/main' }]);
    expect(pushCalls).toEqual([{ branch: 'orch/t1', expected: 'sha-remote-1' }]);
  });

  // The card span "working" long after its PR/MR was mergeable: the fix run borrowed
  // `running`, `settle` handed straight to `finishConflict`, and the `rebased` outcome wrote
  // no status at all — so nothing ever gave it back. No process was behind the spinner.
  it('a conflict fix says what it is doing, and gives the status back once rebased', async () => {
    const { scheduler, card, start, fire, pushCalls } = setup({
      rebaseResult: {
        status: 'conflict',
        worktree: 'C:/wt/t1',
        branch: 'orch/t1',
        base: 'refs/remotes/origin/main',
      },
    });
    scheduler.resolveForgeConflict('t1', mergeRequest());
    await flush();

    const fixRunId = (start.mock.calls[0][1] as { runId: string }).runId;
    fire(fixRunId, {
      kind: 'started',
      sessionId: 'sess-1',
      model: '',
      cwd: '',
      permissionMode: '',
    });
    await flush();
    expect(card.status).toBe('running');
    expect(scheduler.activeRuns()).toEqual([
      expect.objectContaining({ taskId: 't1', purpose: 'resolve-conflicts' }),
    ]);

    fire(fixRunId, okResult);
    await flush();

    expect(pushCalls).toHaveLength(1);
    expect(card.status).toBe('in-progress');
    expect(scheduler.activeRuns()).toEqual([]);
  });

  it('a clean rebase with no agent leaves a resting card exactly where it was', async () => {
    const { scheduler, card } = setup();
    scheduler.resolveForgeConflict('t1', mergeRequest());
    await flush();

    expect(card.status).toBe('in-progress');
  });

  // `chainLandedAt` hijacked the Rung 2 run: a card whose chain had just landed carried the
  // one-shot review marker, the conflict fix inherited it as `reviewSeed`, and that sent the
  // fix through the shared project directory (where there is no paused rebase to resolve)
  // instead of the worktree, and let `settle`'s review-seed branch consume the run and the
  // marker before the redemption below it ever ran — stranding the rebase and burning the
  // review that was supposed to follow it.
  it('a conflict fix on a chain-landed card still runs in the worktree, redeems on settle, and leaves the review for later', async () => {
    const { scheduler, card, start, fire, finishCalls, pushCalls } = setup({
      rebaseResult: {
        status: 'conflict',
        worktree: 'C:/wt/t1',
        branch: 'orch/t1',
        base: 'refs/remotes/origin/main',
      },
    });
    (card as unknown as { chainLandedAt: number | null }).chainLandedAt = 1700000000000;

    scheduler.resolveForgeConflict('t1', mergeRequest());
    await flush();

    expect(start).toHaveBeenCalledTimes(1);
    // Not `project.path` ("C:/repo") — the fix must land in the worktree holding the
    // paused rebase, not the shared directory a review seed would have used.
    expect((start.mock.calls[0][0] as { cwd: string }).cwd).toBe('C:/wt/t1');
    // The marker must not be consumed by a run that is not the review.
    expect(card.chainLandedAt).toBe(1700000000000);

    const fixRunId = (start.mock.calls[0][1] as { runId: string }).runId;
    fire(fixRunId, okResult);
    await flush();

    expect(finishCalls).toEqual([{ branch: 'orch/t1', target: 'refs/remotes/origin/main' }]);
    expect(pushCalls).toEqual([{ branch: 'orch/t1', expected: 'sha-remote-1' }]);
    // Still there for whichever run actually reviews the card next.
    expect(card.chainLandedAt).toBe(1700000000000);
  });

  it('two failed fixes raise merge-conflict, which stamps the episode out of AI attempts', async () => {
    const { scheduler, start, fire, emitAttention, marked } = setup({
      rebaseResult: {
        status: 'conflict',
        worktree: 'C:/wt/t1',
        branch: 'orch/t1',
        base: 'refs/remotes/origin/main',
      },
      finishResult: {
        status: 'conflict',
        worktree: 'C:/wt/t1',
        branch: 'orch/t1',
        base: 'refs/remotes/origin/main',
      },
    });
    scheduler.resolveForgeConflict('t1', mergeRequest({ headSha: 'sha-head-1' }));
    await flush();
    let fixRunId = (start.mock.calls[0][1] as { runId: string }).runId;
    fire(fixRunId, okResult);
    await flush();

    expect(start).toHaveBeenCalledTimes(2);
    expect(marked).toEqual([]); // still mid-ladder — the agent fix attempts stamp nothing
    fixRunId = (start.mock.calls[1][1] as { runId: string }).runId;
    fire(fixRunId, okResult);
    await flush();

    expect(emitAttention).toHaveBeenCalledTimes(1);
    expect(emitAttention.mock.calls[0][0]).toMatchObject({ kind: 'merge-conflict' });
    expect(marked).toEqual([{ mrId: 'gl-1-12', sha: 'sha-remote-1', action: 'resolve-conflicts' }]);
  });

  it('a second call with the same SHA is a no-op', async () => {
    const { scheduler, rebaseCalls } = setup();
    const mr = mergeRequest();
    scheduler.resolveForgeConflict('t1', mr);
    await flush();
    scheduler.resolveForgeConflict('t1', mr);
    await flush();

    // The clean rebase/push settles fully inside the first `flush`, so by the second call
    // nothing is in flight — yet the repeated SHA alone must still stop it from pushing twice.
    expect(rebaseCalls.length).toBe(1);
  });

  it('an in-flight task is skipped', async () => {
    const { scheduler, seedRun, fetchCalls, rebaseCalls } = setup();
    seedRun('r-t1', 't1');
    scheduler.resolveForgeConflict('t1', mergeRequest());
    await flush();

    expect(fetchCalls).toEqual([]);
    expect(rebaseCalls).toEqual([]);
  });

  it('a diverged remote is noted, not pushed, and stamped so the next sync does not retry it', async () => {
    const { scheduler, notes, rebaseCalls, pushCalls, marked } = setup({
      isAncestorResult: false,
    });
    scheduler.resolveForgeConflict('t1', mergeRequest({ headSha: 'sha-head-1' }));
    await flush();

    expect(rebaseCalls).toEqual([]);
    expect(pushCalls).toEqual([]);
    expect(notes.some((n) => n.includes("has commits this card's branch does not"))).toBe(true);
    expect(marked).toEqual([{ mrId: 'gl-1-12', sha: 'sha-head-1', action: 'resolve-conflicts' }]);
  });

  it('the setting off means no call', async () => {
    const { scheduler, fetchCalls, rebaseCalls } = setup({ prAutoResolve: false });
    scheduler.resolveForgeConflict('t1', mergeRequest());
    await flush();

    expect(fetchCalls).toEqual([]);
    expect(rebaseCalls).toEqual([]);
  });

  // Never auto-rebase a PR's worktree while one of the card's own STEPS is running in it
  // (TM-460): the MR's `taskId` is the CARD, which reads idle while a step's live run is
  // the thing actually using the directory `driveForgeConflict` is about to rebase.
  it(
    'a card whose step is inFlight gets its conflict deferred — nothing is fetched or ' +
      'rebased — and driving it is picked back up once the step settles',
    async () => {
      const { scheduler, seedRun, fire, fetchCalls, rebaseCalls, pushCalls } = setup({
        steps: [{ id: 's1', status: 'running' }],
      });
      seedRun('r-step', 's1');

      scheduler.resolveForgeConflict('t1', mergeRequest({ headSha: 'sha-head-1' }));
      await flush();

      expect(fetchCalls).toEqual([]);
      expect(rebaseCalls).toEqual([]);

      await fire('r-step', { kind: 'exited', code: 0 });
      await flush();

      expect(rebaseCalls).toEqual([{ branch: 'orch/t1', target: 'refs/remotes/origin/main' }]);
      expect(pushCalls).toHaveLength(1);
    },
  );

  it('a pending step after a done one — the chain mid-advance between steps — defers too', async () => {
    const { scheduler, fetchCalls, rebaseCalls } = setup({
      steps: [
        { id: 's0', status: 'done' },
        { id: 's1', status: 'pending' },
      ],
    });

    scheduler.resolveForgeConflict('t1', mergeRequest());
    await flush();

    expect(fetchCalls).toEqual([]);
    expect(rebaseCalls).toEqual([]);
  });

  it('a dirty worktree is left alone, not stamped, and noted only once across repeat calls', async () => {
    const { scheduler, notes, rebaseCalls, marked } = setup({ dirty: true });
    const mr = mergeRequest({ headSha: 'sha-head-1' });

    scheduler.resolveForgeConflict('t1', mr);
    await flush();
    scheduler.resolveForgeConflict('t1', mr);
    await flush();

    expect(rebaseCalls).toEqual([]);
    expect(marked).toEqual([]);
    expect(notes.filter((n) => n.includes('uncommitted changes'))).toHaveLength(1);
  });

  it("integrateNow refuses while a step is live in the card's worktree, without integrating", async () => {
    const { scheduler, seedRun, worktrees } = setup({
      steps: [{ id: 's1', status: 'running' }],
    });
    seedRun('r-step', 's1');

    const result = await scheduler.integrateNow('t1');

    expect(result).toMatch(/still running/);
    expect(worktrees.integrate).not.toHaveBeenCalled();
  });
});

/**
 * F2.6: the scheduler records a run's start and outcome into the activity log at the
 * moments it actually decides them — see `docs/plan/feature-roadmap/F2-activity-dashboard.md`.
 */
describe('Scheduler — activity log (F2.6)', () => {
  function setup(permissionMode: PermissionMode = 'acceptEdits') {
    const project = {
      id: 'p',
      path: 'C:/w',
      planPath: 'C:/w/plan.md',
      name: 'P',
      concurrency: 1,
      defaultModel: 'sonnet',
      defaultPermissionMode: permissionMode,
    } as Project;
    const task: Task = {
      id: 't1',
      projectId: 'p',
      phase: '',
      title: 'Fix the export dialog',
      status: 'pending',
      sessionId: null,
      order: 0,
      source: 'board',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
    } as unknown as Task;
    const store = {
      getTasks: () => [task],
      getProject: () => project,
      getTask: (id: string) => (id === 't1' ? task : undefined),
      updateTask: (id: string, patch: Partial<Task>) => {
        if (id === 't1') Object.assign(task, patch);
        return task;
      },
      appendTaskEvent: vi.fn(),
      appendTokenUsage: vi.fn(),
      getSubtasks: () => [],
      listTaskLinks: () => [],
      saveAuthGate: vi.fn(),
      loadAuthGate: () => null,
      saveLimitGate: vi.fn(),
      addComment: vi.fn(),
      getSettings: () => ({ maxAutoRetries: 0, limitJitterMs: 0, concurrency: 1 }),
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    let captured: { runId: string; onEvent: (event: unknown) => Promise<void> } | undefined;
    const start = vi.fn(
      (_req: unknown, opts: { runId: string; onEvent: (event: unknown) => Promise<void> }) => {
        captured = opts;
        return { runId: opts.runId };
      },
    );
    const sessions = { start, stop: vi.fn(), send: vi.fn() } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    const { rows, append } = createFakeAppendActivity();
    scheduler.setActivityRecorder(createActivityRecorder({ append }));
    return {
      scheduler,
      task,
      rows,
      fire: (event: unknown): Promise<void> => captured!.onEvent(event),
    };
  }

  const okResult = {
    kind: 'result',
    success: true,
    resultText: 'Fixed it — see the diff.',
    costUsd: 0.42,
    durationMs: 1000,
    stopReason: 'end_turn',
    terminalReason: null,
    usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 },
  };

  it('records one run-started and one run-finished even when `result` arrives twice, and a trailing `exited` adds nothing', async () => {
    const { scheduler, rows, fire } = setup();
    scheduler.runTask('t1');
    await fire(okResult);
    await fire(okResult); // the run is already settled — this must not produce a second row
    await fire({ kind: 'exited', code: 0 });

    expect(rows.filter((r) => r.kind === 'run-started')).toHaveLength(1);
    const finished = rows.filter((r) => r.kind === 'run-finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ outcome: 'done', costUsd: 0.42, origin: 'human' });
  });

  it("records outcome 'empty' for a plan-mode run that never presented a plan", async () => {
    const { scheduler, rows, fire } = setup('plan');
    scheduler.runTask('t1');
    await fire(okResult);

    const finished = rows.filter((r) => r.kind === 'run-finished');
    expect(finished).toHaveLength(1);
    expect(finished[0].outcome).toBe('empty');
  });

  it('does not fail the run when a raw, throwing recorder is injected', async () => {
    const { scheduler, task, fire } = setup();
    scheduler.setActivityRecorder({
      record: () => {
        throw new Error('boom');
      },
      runStarted: () => {
        throw new Error('boom');
      },
      runFinished: () => {
        throw new Error('boom');
      },
    });

    scheduler.runTask('t1');
    await fire(okResult);

    expect(task.status).toBe('in-progress'); // settled normally despite the throwing recorder
  });

  it('does not fail the run when createActivityRecorder wraps a throwing append', async () => {
    const { scheduler, task, fire } = setup();
    scheduler.setActivityRecorder(
      createActivityRecorder({
        append: () => {
          throw new Error('disk full');
        },
      }),
    );

    scheduler.runTask('t1');
    await fire(okResult);

    expect(task.status).toBe('in-progress');
  });
});

describe('Scheduler: skills in force (F7.6)', () => {
  /** A library skill, shaped exactly as `store.getSkill` returns one. */
  const skill = (id: string, name: string, body: string) => ({
    id,
    name,
    description: `${name} description`,
    body,
    createdAt: 0,
    updatedAt: 0,
  });

  /**
   * A card (optionally with steps), wired to a fake library of skills by id — no worktree
   * manager, so every run lands on the synchronous shared-dir `launch` path and `start` can
   * be asserted on right after `runTask`/`chatWithAgent` returns.
   */
  function makeSkillsScheduler(
    cardOverrides: Partial<Task> = {},
    opts: {
      steps?: Array<Partial<Task>>;
      skills?: ReturnType<typeof skill>[];
    } = {},
  ) {
    const card = {
      id: 'c1',
      projectId: 'p',
      phase: '',
      title: 'Card',
      status: 'pending',
      sessionId: null,
      order: 0,
      source: 'adhoc',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      ...cardOverrides,
    } as Task;
    const steps = (opts.steps ?? []).map(
      (s, i) =>
        ({
          id: `s${i + 1}`,
          projectId: 'p',
          phase: '',
          title: `Step ${i + 1}`,
          status: 'pending',
          sessionId: null,
          order: i + 1,
          source: 'adhoc',
          dependsOn: [],
          isContract: false,
          isScaffold: false,
          parentTaskId: card.id,
          ...s,
        }) as Task,
    );
    const all = [card, ...steps];
    const project = {
      id: 'p',
      name: 'Project',
      path: 'C:/repo',
      planPath: '',
      kind: 'plan',
      concurrency: 1,
      useWorktrees: false,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'default',
    } as unknown as Project;
    const skillsById = new Map((opts.skills ?? []).map((s) => [s.id, s]));
    const notes: string[] = [];
    const store = {
      getTask: (id: string) => all.find((t) => t.id === id),
      getTasks: () => all,
      getProject: () => project,
      getSubtasks: (parentId: string) => steps.filter((s) => s.parentTaskId === parentId),
      updateTask: (id: string, patch: Partial<Task>) => {
        const t = all.find((x) => x.id === id);
        if (t) Object.assign(t, patch);
        return t;
      },
      addChatMessage: vi.fn(),
      getSettings: () => ({ limitJitterMs: 0, concurrency: 1 }),
      getTaskActivity: () => [],
      appendTaskEvent: (_p: string, _t: string, _r: string, event: { text?: string }) => {
        notes.push(event.text ?? '');
      },
      getSkill: (id: string) => skillsById.get(id),
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const start = vi.fn((_req: unknown, _opts: unknown) => ({ runId: 'r1' }));
    const sessions = { start, stop: vi.fn(), send: vi.fn() } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    return { scheduler, start, notes, card, steps, project };
  }

  it('carries a library skill’s body in the skillsSection and notes it in force', () => {
    const { scheduler, start, notes } = makeSkillsScheduler(
      { skillRefs: ['lib:tdd'] },
      { skills: [skill('tdd', 'TDD', 'Write the test first, then the code.')] },
    );
    scheduler.runTask('c1');

    const opts = start.mock.calls[0][1] as { skillsSection?: string };
    expect(opts.skillsSection).toContain('### TDD');
    expect(opts.skillsSection).toContain('Write the test first, then the code.');
    expect(notes.some((n) => n.includes('Skills in force for this run: TDD'))).toBe(true);
  });

  it('a step inherits the card’s skill and adds its own', () => {
    const { scheduler, start } = makeSkillsScheduler(
      { skillRefs: ['lib:tdd'] },
      {
        steps: [{ skillRefs: ['lib:security'] }],
        skills: [
          skill('tdd', 'TDD', 'Write the test first, then the code.'),
          skill('security', 'Security review', 'Check every input for injection.'),
        ],
      },
    );
    scheduler.runTask('s1');

    const opts = start.mock.calls[0][1] as { skillsSection?: string };
    expect(opts.skillsSection).toContain('Write the test first, then the code.');
    expect(opts.skillsSection).toContain('Check every input for injection.');
  });

  it('notes a dangling ref and still starts the run', () => {
    const { scheduler, start, notes } = makeSkillsScheduler({ skillRefs: ['lib:gone'] });
    scheduler.runTask('c1');

    expect(start).toHaveBeenCalledTimes(1);
    expect(notes.some((n) => n.includes('`lib:gone` no longer exists'))).toBe(true);
  });

  it('a chatWithAgent resume also carries the section and writes the note', () => {
    const { scheduler, start, notes } = makeSkillsScheduler(
      { status: 'in-progress', sessionId: 'sess-1', skillRefs: ['lib:tdd'] },
      { skills: [skill('tdd', 'TDD', 'Write the test first, then the code.')] },
    );
    const result = scheduler.chatWithAgent('c1', 'still there?');

    expect(result.status).toBe('resumed');
    const opts = start.mock.calls[0][1] as { skillsSection?: string };
    expect(opts.skillsSection).toContain('Write the test first, then the code.');
    expect(notes.some((n) => n.includes('Skills in force for this run: TDD'))).toBe(true);
  });

  it('a release run carries no skills section', () => {
    const { scheduler, start, notes, project, card } = makeSkillsScheduler(
      { skillRefs: ['lib:tdd'] },
      { skills: [skill('tdd', 'TDD', 'Write the test first, then the code.')] },
    );
    (
      scheduler as unknown as {
        startTask: (
          p: Project,
          t: Task,
          o: { releaseSeed?: boolean; chatPrompt?: string },
        ) => string;
      }
    ).startTask(project, card, { releaseSeed: true, chatPrompt: 'Release now.' });

    const opts = start.mock.calls[0][1] as { skillsSection?: string };
    expect(opts.skillsSection).toBeUndefined();
    expect(notes).toEqual([]);
  });

  it('no refs means no skillsSection and no note', () => {
    const { scheduler, start, notes } = makeSkillsScheduler();
    scheduler.runTask('c1');

    const opts = start.mock.calls[0][1] as { skillsSection?: string };
    expect(opts.skillsSection).toBeFalsy();
    expect(notes).toEqual([]);
  });
});
