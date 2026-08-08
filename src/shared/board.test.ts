import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from './model';
import type { MergeRequest } from './mergeRequest';
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
  isBoardCard,
  isAgentRunning,
  needsAgentInput,
  cardRunLabel,
  canStopWork,
  hasAgentWorked,
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

/**
 * The predicate behind the Merge button, both auto-merge/auto-release switches and the
 * `stacked` chain gate. Each of them used to ask `sessionId`, and each of them therefore
 * said "this card has never run" the moment its plan finished — see `Task.workedAt`.
 */
describe('hasAgentWorked', () => {
  const step = (id: string, over: Partial<Task> = {}): Task =>
    task({ id, parentTaskId: 't', status: 'done', ...over });

  it('is false for a card nothing has ever run', () => {
    expect(hasAgentWorked(task({ agentProjectId: 'p1' }))).toBe(false);
    expect(hasAgentWorked(task({ agentProjectId: 'p1' }), [step('s1')])).toBe(false);
  });

  it('is true while the card holds a session', () => {
    expect(hasAgentWorked(task({ sessionId: 'sess-1' }))).toBe(true);
  });

  it('survives the session being cleared when a chain lands', () => {
    // Exactly what `finishParentChain` leaves behind: no session, work on the branch.
    expect(hasAgentWorked(task({ sessionId: null, workedAt: 1 }))).toBe(true);
  });

  it('reads a card through its steps, which run on the card’s own branch', () => {
    const card = task({ sessionId: null, workedAt: null, agentProjectId: 'p1' });
    expect(hasAgentWorked(card, [step('s1'), step('s2', { sessionId: 'sess-2' })])).toBe(true);
    expect(hasAgentWorked(card, [step('s1', { workedAt: 9 })])).toBe(true);
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

  describe('a card the human has closed', () => {
    // The complaint this closes: a card dragged to DONE went on wearing the orange ring
    // and went on sorting to the top of the column, because the thing that raised it —
    // an old comment, a step that fell over on the way, an MR left open — was still true.
    // Marking the card done IS the answer to all of them.
    const closed = ['done', 'cancelled', 'stopped'] as const;
    const shoutingMr = {
      state: 'opened',
      latestNoteAt: 200,
      lastReadAt: 100,
      lastEventAt: null,
      lastEventSeenAt: null,
    } as unknown as MergeRequest;

    it('is silent about an unread ticket comment', () => {
      for (const status of closed) {
        const t = task({ id: 'c1', status, latestCommentAt: 200, lastReadCommentAt: null });
        expect(hasUnreadJira(t)).toBe(true); // the driver is still true…
        expect(chainNeedsAttention(t, [])).toBe(false); // …and deliberately overruled
      }
    });

    it('is silent about a step that failed on the way', () => {
      for (const status of closed) {
        const t = task({ id: 'c1', status });
        expect(chainNeedsAttention(t, [step('s1', 'failed')])).toBe(false);
        expect(chainNeedsAttention(t, [step('s1', 'waiting-input')])).toBe(false);
      }
    });

    it('is silent about an inbox item nobody ever answered', () => {
      for (const status of closed) {
        const t = task({ id: 'c1', status });
        expect(chainNeedsAttention(t, [], [], new Set(['c1']))).toBe(false);
        expect(chainNeedsAttention(t, [step('s1', 'done')], [], new Set(['s1']))).toBe(false);
      }
    });

    it('is silent about a merge request still shouting on its branch', () => {
      for (const status of closed) {
        const t = task({ id: 'c1', status });
        expect(chainNeedsAttention(t, [], [shoutingMr])).toBe(false);
      }
    });

    it('is silent while its own run is parked, having been closed under it', () => {
      // `waiting-input` with the human's choice parked in `preRunStatus`: the card RESTS
      // in Done, which is the state this override is about.
      const t = task({ id: 'c1', status: 'waiting-input', preRunStatus: 'done' });
      expect(needsAgentInput(t)).toBe(true);
      expect(chainNeedsAttention(t, [])).toBe(false);
    });

    it('still shouts when the card FAILED — nobody chose that', () => {
      // The one terminal status deliberately left out: a card that fell over is over, but
      // no human decided it was, and that is precisely when you want to be told.
      const t = task({ id: 'c1', status: 'failed', latestCommentAt: 200 });
      expect(chainNeedsAttention(t, [])).toBe(true);
      expect(
        chainNeedsAttention(task({ id: 'c1', status: 'failed' }), [], [], new Set(['c1'])),
      ).toBe(true);
    });

    it('still shouts while the card is merely in progress or in review', () => {
      for (const status of ['in-progress', 'in-review', 'blocked'] as const) {
        const t = task({ id: 'c1', status, latestCommentAt: 200 });
        expect(chainNeedsAttention(t, [])).toBe(true);
      }
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

  it('names the step a usage limit is holding, rather than calling it queued', () => {
    // A chain that stops for five hours and one waiting its turn are the same "Queued" to
    // a card that does not distinguish them — and the first is the one people ask about.
    const card = task({ id: 'c1', status: 'in-progress' });
    const steps = [step('s1', 'done'), step('s2', 'blocked-by-limit'), step('s3', 'pending')];
    expect(runPhase(card, steps)).toMatchObject({
      phase: 'blocked',
      label: 'Paused — usage limit (step 2 of 3)',
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

  it('does not call a card that ran and was dragged back to To Do "not started"', () => {
    // The session is gone (its plan finished — `finishParentChain`), but the card has
    // worked, and saying otherwise on a card with a branch full of commits is a lie.
    const t = task({ status: 'pending', agentProjectId: 'agent', workedAt: 5 });
    expect(runPhase(t)).toMatchObject({ phase: 'idle', label: '' });
  });

  it('says nothing about a card assigned somewhere other than TO DO', () => {
    // Assignment no longer drags the card into TO DO, so this state is now reachable:
    // agent assigned, never run, resting in IN REVIEW. "Not started" is a claim about the
    // queue, and this card is not in it — the column already says what it is.
    const t = task({ status: 'in-review', agentProjectId: 'agent', sessionId: null });
    expect(runPhase(t)).toMatchObject({ phase: 'idle', label: '' });
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

  /**
   * A merge is the one long job that changes nothing about the task while it runs, so
   * without the set the card is indistinguishable from one nobody has touched — which is
   * exactly what "I clicked Merge and nothing appeared" was.
   */
  it('spins a card whose branch is being merged, and says so', () => {
    const card = task({ id: 'c1', status: 'in-progress', agentProjectId: 'agent' });
    expect(runPhase(card, [], new Set(), new Set(['c1']))).toEqual({
      phase: 'merging',
      label: 'Merging branch…',
      spinner: true,
    });
    expect(runPhase(card, [], new Set(), new Set())).toMatchObject({ phase: 'idle' });
  });

  /**
   * A chain's branch is integrated under the id of the step that finished it — and that
   * step is `done` by then. Reading a settled task out of this set is therefore required,
   * not a slip: the opposite rule (correct for the lagging live-run snapshot) would hide
   * the merge on precisely the cards that have one.
   */
  it('claims its steps’ merges, terminal status and all', () => {
    const card = task({ id: 'c1', status: 'in-progress' });
    expect(runPhase(card, [step('s1', 'done')], new Set(), new Set(['s1']))).toMatchObject({
      phase: 'merging',
      spinner: true,
    });
    expect(runPhase(step('s1', 'done'), [], new Set(), new Set(['s1']))).toMatchObject({
      phase: 'merging',
    });
  });

  it('lets a live run outrank a merge — the agent moving is the louder fact', () => {
    const card = task({ id: 'c1', status: 'running' });
    expect(runPhase(card, [], new Set(), new Set(['c1']))).toMatchObject({ phase: 'running' });
  });

  // The words stay on the card for this one phase: the pulse would read as "the agent is
  // working", and during a merge the agent has finished — what is moving is git.
  it('keeps the merging words on a card whose glyph is already pulsing', () => {
    const card = task({ id: 'c1', status: 'in-progress', agentProjectId: 'agent' });
    const merging = runPhase(card, [], new Set(), new Set(['c1']));
    expect(cardRunLabel(merging, true)).toBe('Merging branch…');
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

describe('canStopWork', () => {
  const card = (over: Partial<Task> = {}): Task =>
    task({ id: 'c1', agentProjectId: 'a1', status: 'in-progress', ...over });
  const step = (id: string, status: Task['status']): Task =>
    task({ id, status, parentTaskId: 'c1' });

  it('is false for a card nobody has delegated', () => {
    expect(canStopWork(task({ status: 'pending' }))).toBe(false);
  });

  it.each(['running', 'waiting-input', 'blocked-by-limit'] as const)(
    'is true while the card itself is %s',
    (status) => {
      expect(canStopWork(card({ status }))).toBe(true);
    },
  );

  // The complaint this whole predicate exists for: the card stays `in-progress` while a
  // step holds the run, so asking its status alone offered no Stop on the one card that
  // most obviously had an agent working it.
  it('is true for a card whose STEP is running', () => {
    expect(canStopWork(card(), [step('s1', 'done'), step('s2', 'running')])).toBe(true);
  });

  it('is true for a chain between steps — the next one starts by itself', () => {
    expect(canStopWork(card(), [step('s1', 'done'), step('s2', 'pending')])).toBe(true);
  });

  it('is true while a step is parked on a failure, with siblings still to run', () => {
    expect(canStopWork(card(), [step('s1', 'failed'), step('s2', 'pending')])).toBe(true);
  });

  it('is false for steps written by hand on a card nobody has started', () => {
    expect(canStopWork(card({ status: 'pending' }), [step('s1', 'pending')])).toBe(false);
  });

  it('is false once the whole chain has settled', () => {
    expect(canStopWork(card(), [step('s1', 'done'), step('s2', 'stopped')])).toBe(false);
  });

  // The `starting` window: `task:assignAgent` persists `pending` and only then spawns.
  it('is true for a run that has spawned but is not persisted as running yet', () => {
    expect(canStopWork(card({ status: 'pending' }), [], new Set(['c1']))).toBe(true);
    expect(canStopWork(card({ status: 'pending' }), [step('s1', 'pending')], new Set(['s1']))).toBe(
      true,
    );
  });

  // The snapshot lags behind the task on purpose — reading a finished one out of it is
  // what left cards claiming to be starting long after their agent had stopped.
  it('never reads a settled task out of the live-run snapshot', () => {
    expect(canStopWork(card({ status: 'done' }), [], new Set(['c1']))).toBe(false);
    expect(canStopWork(card(), [step('s1', 'done')], new Set(['s1']))).toBe(false);
  });
});

describe('isBoardCard', () => {
  it('is true for a top-level card of the Personal board', () => {
    expect(isBoardCard(task({ projectId: PERSONAL_PROJECT_ID }))).toBe(true);
  });

  // Phase 24: the second kind of card whose column belongs to the human. Keyed on
  // `source`, so this stays a pure function of `Task` with no project to hand.
  it('is true for a native ticket, whatever project it lives in', () => {
    expect(isBoardCard(task({ projectId: 'tickets-1', source: 'ticket' }))).toBe(true);
  });

  it('is false for a plan project\u2019s task \u2014 that is a queue, not a board', () => {
    expect(isBoardCard(task({ projectId: 'p1', source: 'plan' }))).toBe(false);
    expect(isBoardCard(task({ projectId: 'p1', source: 'adhoc' }))).toBe(false);
  });

  // A step renders inside its parent and the chain reads its done/failed to advance, so it
  // must keep the lifecycle it has \u2014 on either kind of board.
  it('is false for a step, on the Personal board and on a ticket project alike', () => {
    expect(isBoardCard(task({ projectId: PERSONAL_PROJECT_ID, parentTaskId: 'c1' }))).toBe(false);
    expect(
      isBoardCard(task({ projectId: 'tickets-1', source: 'ticket', parentTaskId: 'c1' })),
    ).toBe(false);
  });
});
