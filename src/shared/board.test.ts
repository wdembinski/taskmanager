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
