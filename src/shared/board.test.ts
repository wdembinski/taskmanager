import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from './model';
import {
  categoryFromKey,
  categoryToColumn,
  columnForStatus,
  lookupStatusColumn,
  statusForColumn,
  chainInFlight,
  chainNeedsAttention,
  chatTarget,
  parkedStep,
  hasUnreadJira,
  isAgentAssigned,
  isAgentRunning,
  needsAgentInput,
  cardRunLabel,
  runPhase,
  type RunState,
} from './board';

const task = (over: Partial<Task>): Task => ({
  id: 't',
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: 'x',
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'jira',
  isContract: false,
  isScaffold: false,
  externalSource: 'jira',
  ...over,
});

describe('categoryFromKey', () => {
  it('maps stable category keys', () => {
    expect(categoryFromKey('new')).toBe('To Do');
    expect(categoryFromKey('indeterminate')).toBe('In Progress');
    expect(categoryFromKey('done')).toBe('Done');
    expect(categoryFromKey('undefined')).toBe('To Do');
  });
});

describe('categoryToColumn', () => {
  it('maps categories to columns', () => {
    expect(categoryToColumn('To Do')).toBe('todo');
    expect(categoryToColumn('In Progress')).toBe('in-progress');
    expect(categoryToColumn('Done')).toBe('done');
  });
});

describe('in-review', () => {
  it('is its own column, round-tripping through status and back', () => {
    expect(columnForStatus('in-review')).toBe('in-review');
    expect(statusForColumn('in-review')).toBe('in-review');
  });

  it('does not disturb the neighbouring columns', () => {
    expect(columnForStatus('in-progress')).toBe('in-progress');
    expect(columnForStatus('running')).toBe('in-progress');
    expect(columnForStatus('blocked')).toBe('blocked');
  });
});

describe('lookupStatusColumn', () => {
  const map = { 'Code Review': 'in-review' as const, Backlog: 'todo' as const };

  it('is null with no map, an empty name, or an unmapped one', () => {
    expect(lookupStatusColumn('Code Review', undefined)).toBeNull();
    expect(lookupStatusColumn('   ', map)).toBeNull();
    expect(lookupStatusColumn('In Progress', map)).toBeNull();
  });

  it('matches ignoring case and surrounding space', () => {
    expect(lookupStatusColumn('code review', map)).toBe('in-review');
    expect(lookupStatusColumn('  CODE REVIEW  ', map)).toBe('in-review');
  });
});

describe('hasUnreadJira', () => {
  it('is false for internal (non-JIRA) tasks', () => {
    expect(hasUnreadJira(task({ externalSource: null, latestCommentAt: 100 }))).toBe(false);
  });
  it('is false when there are no comments', () => {
    expect(hasUnreadJira(task({ latestCommentAt: null }))).toBe(false);
  });
  it('is true when a newer comment exists than the last read', () => {
    expect(hasUnreadJira(task({ latestCommentAt: 200, lastReadCommentAt: 100 }))).toBe(true);
  });
  it('is true when nothing has been read yet but a comment exists', () => {
    expect(hasUnreadJira(task({ latestCommentAt: 200, lastReadCommentAt: null }))).toBe(true);
  });
  it('is false when the latest comment has already been read', () => {
    expect(hasUnreadJira(task({ latestCommentAt: 200, lastReadCommentAt: 200 }))).toBe(false);
  });
});

describe('needsAgentInput', () => {
  it('is true only while the run is parked on a question/permission', () => {
    expect(needsAgentInput(task({ status: 'waiting-input' }))).toBe(true);
  });
  it('is false for a run that is merely executing', () => {
    expect(needsAgentInput(task({ status: 'running' }))).toBe(false);
  });
  it('is false for an idle card', () => {
    expect(needsAgentInput(task({ status: 'pending' }))).toBe(false);
    expect(needsAgentInput(task({ status: 'blocked-by-limit' }))).toBe(false);
  });
});

describe('isAgentRunning', () => {
  it('is true only for a delegated card with a live session', () => {
    expect(isAgentRunning(task({ agentProjectId: 'p1', status: 'running' }))).toBe(true);
  });
  it('is false for a card a human merely moved to In Progress', () => {
    expect(isAgentRunning(task({ agentProjectId: 'p1', status: 'in-progress' }))).toBe(false);
  });
  it('is false while parked — nothing is moving to spin about', () => {
    expect(isAgentRunning(task({ agentProjectId: 'p1', status: 'waiting-input' }))).toBe(false);
    expect(isAgentRunning(task({ agentProjectId: 'p1', status: 'blocked-by-limit' }))).toBe(false);
  });
  it('is false when the task was never delegated', () => {
    expect(isAgentRunning(task({ status: 'running' }))).toBe(false);
  });
});

describe('isAgentAssigned', () => {
  it('is true once a card names an agent project', () => {
    expect(isAgentAssigned(task({ agentProjectId: 'p1' }))).toBe(true);
  });
  it('is false when unassigned', () => {
    expect(isAgentAssigned(task({}))).toBe(false);
    expect(isAgentAssigned(task({ agentProjectId: null }))).toBe(false);
  });
});

describe('chatTarget', () => {
  const parent = task({ id: 'c1', status: 'in-progress' });
  const step = (id: string, status: Task['status']): Task =>
    task({ id, status, parentTaskId: 'c1' });

  it('is the card itself when no step is live', () => {
    expect(chatTarget(parent, [step('s1', 'done'), step('s2', 'pending')]).id).toBe('c1');
  });
  it('is the running step — the card holds no session while a step works', () => {
    expect(chatTarget(parent, [step('s1', 'done'), step('s2', 'running')]).id).toBe('s2');
  });
  it('is a step parked on a question, which is still the live session', () => {
    expect(chatTarget(parent, [step('s1', 'waiting-input')]).id).toBe('s1');
  });
  it('is the step itself when a step is what you selected', () => {
    const s = step('s2', 'running');
    expect(chatTarget(s, []).id).toBe('s2');
  });
  it('is the card when it has no steps at all', () => {
    expect(chatTarget(parent, []).id).toBe('c1');
  });
});

describe('parkedStep / chainNeedsAttention', () => {
  const step = (id: string, status: Task['status']): Task =>
    task({ id, status, parentTaskId: 'c1' });
  const card = task({ id: 'c1', status: 'in-progress' });

  it('finds the step that stopped the chain', () => {
    expect(parkedStep([step('s1', 'done'), step('s2', 'failed')])?.id).toBe('s2');
    expect(parkedStep([step('s1', 'waiting-input')])?.id).toBe('s1');
  });

  it('is null while the chain is healthy', () => {
    expect(parkedStep([step('s1', 'done'), step('s2', 'running')])).toBeNull();
    expect(parkedStep([])).toBeNull();
  });

  it('frames a card whose STEP is parked, not just one asking itself', () => {
    // The regression this exists for: a failed step used to leave the board silent.
    expect(chainNeedsAttention(card, [step('s1', 'failed')])).toBe(true);
    expect(chainNeedsAttention(card, [step('s1', 'waiting-input')])).toBe(true);
    expect(chainNeedsAttention(task({ status: 'waiting-input' }), [])).toBe(true);
  });

  it('leaves a healthy card alone', () => {
    expect(chainNeedsAttention(card, [step('s1', 'done'), step('s2', 'running')])).toBe(false);
    expect(chainNeedsAttention(card, [])).toBe(false);
  });

  describe('the inbox as the authoritative signal', () => {
    // The bug this closes: an item could be parked on a card whose status the engine had
    // not (or no longer) flipped to `waiting-input` — a restored item after a restart, or
    // one raised on a step mid-run — and the board drew nothing at all.
    it('frames a card the inbox is holding an item for, whatever its status says', () => {
      const quiet = task({ id: 'c1', status: 'running' });
      expect(chainNeedsAttention(quiet, [], [], new Set())).toBe(false);
      expect(chainNeedsAttention(quiet, [], [], new Set(['c1']))).toBe(true);
    });

    it('frames a card whose STEP the inbox is holding an item for', () => {
      const running = step('s1', 'running');
      expect(chainNeedsAttention(card, [running], [], new Set(['s1']))).toBe(true);
    });

    it('ignores an item parked on some unrelated card', () => {
      expect(chainNeedsAttention(card, [step('s1', 'running')], [], new Set(['other']))).toBe(
        false,
      );
    });

    it('still falls back to the inferred signals when no set is given', () => {
      // Main-process callers have no inbox to consult; they must behave as before.
      expect(chainNeedsAttention(card, [step('s1', 'failed')])).toBe(true);
    });
  });
});

describe('cardRunLabel', () => {
  const state = (over: Partial<RunState>): RunState => ({
    phase: 'idle',
    label: '',
    spinner: false,
    ...over,
  });

  // The pulse on the card's agent glyph says "moving"; the 2/5 counter says how far; the step
  // rows say which step. A fourth telling in words is what this removes.
  it.each(['running', 'starting'] as const)('says nothing while %s on an agent card', (phase) => {
    expect(cardRunLabel(state({ phase, label: 'Running step 2 of 5' }), true)).toBeNull();
  });

  it.each([
    ['waiting', 'Waiting for you'],
    ['blocked', 'Paused — usage limit'],
    ['queued', 'Queued'],
    ['idle', 'Assigned — not started'],
  ] as const)('keeps the words for %s, which no animation can express', (phase, label) => {
    expect(cardRunLabel(state({ phase, label }), true)).toBe(label);
  });

  // The exception: no agent means no glyph to pulse, so the words are all there is.
  it('keeps a running label on a card with no agent assigned', () => {
    const running = state({ phase: 'running', label: 'Running step 2 of 5' });
    expect(cardRunLabel(running, false)).toBe('Running step 2 of 5');
  });

  it('has nothing to say when the phase carries no label', () => {
    expect(cardRunLabel(state({ phase: 'done' }), true)).toBeNull();
    expect(cardRunLabel(state({ phase: 'idle' }), false)).toBeNull();
  });
});

describe('runPhase', () => {
  const step = (id: string, status: Task['status']): Task =>
    task({ id, status, parentTaskId: 'c1', agentProjectId: 'agent' });

  it('reads a running task straight off its own status', () => {
    expect(runPhase(task({ status: 'running' }))).toMatchObject({
      phase: 'running',
      spinner: true,
    });
  });

  it.each([
    ['waiting-input', 'waiting'],
    ['blocked-by-limit', 'blocked'],
  ] as const)('parks a %s task without a spinner', (status, phase) => {
    const state = runPhase(task({ status }));
    expect(state.phase).toBe(phase);
    expect(state.spinner).toBe(false);
    expect(state.label).not.toBe('');
  });

  // The window the whole `liveRunTaskIds` parameter exists for: `task:assignAgent`
  // persists `pending` and only then calls `runTask`, so the task that patches the card
  // says `pending` while a session is already spawning.
  it('shows "starting" for a pending task the engine already has a run for', () => {
    const t = task({ id: 'c1', status: 'pending', agentProjectId: 'agent' });
    expect(runPhase(t, [], new Set(['c1']))).toMatchObject({ phase: 'starting', spinner: true });
    expect(runPhase(t, [], new Set())).toMatchObject({ phase: 'idle', spinner: false });
  });

  // The bug this guards: the engine removes a run from `activeRuns` only when the process
  // reports `exited`, which is AFTER the settling `task:changed` — so every snapshot the UI
  // takes in response to a run finishing still lists that run. Reading "starting" out of it
  // left a card spinning "Starting…" for a run that was over.
  it.each(['done', 'failed', 'stopped', 'cancelled'] as const)(
    'never calls a %s task "starting", however stale the live-run snapshot is',
    (status) => {
      const t = task({ id: 'c1', status, agentProjectId: 'agent' });
      expect(runPhase(t, [], new Set(['c1']))).toEqual({
        phase: 'done',
        label: '',
        spinner: false,
      });
    },
  );

  it('still reports a genuinely running step under a card that was marked done by hand', () => {
    // The lagging snapshot must not silence the chain either: a step that really is running
    // is reported even though the parent carries a terminal status.
    const card = task({ id: 'c1', status: 'done' });
    expect(runPhase(card, [step('s1', 'running')], new Set(['c1']))).toMatchObject({
      phase: 'running',
      label: 'Running step 1 of 1',
      spinner: true,
    });
  });

  it('names the step a chain is on', () => {
    const card = task({ id: 'c1', status: 'in-progress' });
    const steps = [step('s1', 'done'), step('s2', 'running'), step('s3', 'pending')];
    expect(runPhase(card, steps)).toMatchObject({
      phase: 'running',
      label: 'Running step 2 of 3',
      spinner: true,
    });
  });

  it('names the step a chain has stopped at, and does not spin', () => {
    const card = task({ id: 'c1', status: 'in-progress' });
    const steps = [step('s1', 'done'), step('s2', 'failed'), step('s3', 'pending')];
    expect(runPhase(card, steps)).toMatchObject({
      phase: 'waiting',
      label: 'Stopped at step 2 of 3',
      spinner: false,
    });
  });

  it('queues a chain whose next step has not been picked up yet', () => {
    const card = task({ id: 'c1', status: 'in-progress' });
    expect(runPhase(card, [step('s1', 'done'), step('s2', 'pending')])).toMatchObject({
      phase: 'queued',
      spinner: false,
    });
  });

  it('rests once every step is done', () => {
    const card = task({ id: 'c1', status: 'in-progress' });
    expect(runPhase(card, [step('s1', 'done'), step('s2', 'done')])).toMatchObject({
      phase: 'idle',
      spinner: false,
    });
  });

  /**
   * The snapshot legitimately lags: a step is still listed by `scheduler:activeRuns` between
   * settling and its process exiting. Its recorded status is the fact, so a finished step is
   * never read out of the snapshot — the same rule the card's own check already followed.
   */
  it('still rests when a finished step lingers in the live-run snapshot', () => {
    const card = task({ id: 'c1', status: 'in-progress' });
    const phase = runPhase(card, [step('s1', 'done'), step('s2', 'done')], new Set(['s2']));
    expect(phase).toMatchObject({ phase: 'idle', spinner: false });
  });

  it('does not read a stopped or failed step out of the snapshot either', () => {
    const card = task({ id: 'c1', status: 'in-progress' });
    // `failed` is a park, not a start — the card must say so rather than spin.
    expect(runPhase(card, [step('s1', 'failed')], new Set(['s1']))).toMatchObject({
      phase: 'waiting',
      spinner: false,
    });
    expect(runPhase(card, [step('s1', 'stopped')], new Set(['s1']))).toMatchObject({
      spinner: false,
    });
  });

  it('still spins a step the snapshot has picked up before it reports running', () => {
    const card = task({ id: 'c1', status: 'in-progress' });
    expect(
      runPhase(card, [step('s1', 'done'), step('s2', 'pending')], new Set(['s2'])),
    ).toMatchObject({ phase: 'starting', label: 'Starting step 2 of 2', spinner: true });
  });

  it('says an assigned card was never started', () => {
    const t = task({ status: 'pending', agentProjectId: 'agent' });
    expect(runPhase(t)).toMatchObject({ phase: 'idle', label: 'Assigned — not started' });
  });

  it('spins a hand-added step that carries no agent project', () => {
    // `isAgentRunning` gates on assignment, which is why a step added by hand could never
    // show a spinner however hard it ran. `runPhase` deliberately does not.
    expect(runPhase(task({ status: 'running', agentProjectId: null }))).toMatchObject({
      phase: 'running',
      spinner: true,
    });
  });

  it.each(['done', 'failed', 'stopped', 'cancelled'] as const)('rests a %s task', (status) => {
    expect(runPhase(task({ status }))).toMatchObject({ phase: 'done', spinner: false });
  });

  it('lets the task’s own status outrank its finished chain', () => {
    // A parent running a review-seed turn after its chain merged is running, whatever the
    // steps say.
    const card = task({ id: 'c1', status: 'running' });
    expect(runPhase(card, [step('s1', 'done')])).toMatchObject({ phase: 'running' });
  });
});

describe('chainInFlight', () => {
  const step = (status: Task['status']): Task => task({ id: status, status, parentTaskId: 'c1' });

  it('is false for a card with no plan', () => {
    expect(chainInFlight([])).toBe(false);
  });

  it('is false once every step is inert', () => {
    expect(chainInFlight([step('done'), step('cancelled'), step('stopped')])).toBe(false);
  });

  it.each(['pending', 'running', 'waiting-input', 'blocked-by-limit', 'failed'] as const)(
    'is true while a step is %s — it can still move',
    (status) => {
      expect(chainInFlight([step('done'), step(status)])).toBe(true);
    },
  );
});
