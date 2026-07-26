import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from './model';
import {
  categoryFromKey,
  categoryToColumn,
  chatTarget,
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
