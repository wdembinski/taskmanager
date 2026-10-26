import { describe, expect, it } from 'vitest';
import type { Task, TaskStatus } from '@tm/shared/model';
import { BACKLOG_TAB_LABEL, parseBacklogTab, ticketsForTab } from './backlogTabs';

/** A minimal native-ticket fixture — only the fields this module reads are worth naming. */
function ticket(id: string, status: TaskStatus, overrides: Partial<Task> = {}): Task {
  return {
    id,
    projectId: 'proj',
    phase: '',
    title: id,
    status,
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'ticket',
    isContract: false,
    isScaffold: false,
    ...overrides,
  };
}

const todo = ticket('todo', 'pending');
const working = ticket('working', 'in-progress');
const review = ticket('review', 'in-review');
const blocked = ticket('blocked', 'blocked');
const done = ticket('done', 'done');
const tickets = [todo, working, review, blocked, done];

const ids = (list: readonly Task[]): string[] => list.map((t) => t.id);

describe('ticketsForTab', () => {
  it('Active shows every column but Done', () => {
    expect(ids(ticketsForTab(tickets, 'active'))).toEqual(['todo', 'working', 'review', 'blocked']);
  });

  it('Active excludes every status that lands in Done', () => {
    const closed = (['done', 'failed', 'stopped', 'cancelled'] as const).map((s) => ticket(s, s));
    expect(ticketsForTab(closed, 'active')).toEqual([]);
  });

  it('Active keeps a blocked ticket', () => {
    expect(ids(ticketsForTab([blocked], 'active'))).toEqual(['blocked']);
  });

  it('Active reads where a running card rests, not where its agent pulled it', () => {
    const running = ticket('running', 'running', { preRunStatus: 'done' });
    expect(ticketsForTab([running], 'active')).toEqual([]);
  });

  it('Backlog shows only the To Do column', () => {
    expect(ids(ticketsForTab(tickets, 'backlog'))).toEqual(['todo']);
  });

  it('All shows every ticket, Done included', () => {
    expect(ids(ticketsForTab(tickets, 'all'))).toEqual(ids(tickets));
  });

  it('keeps an epic whatever its column, so its open children still have a header', () => {
    const epic = ticket('epic', 'done', { issueType: 'epic' });
    expect(ids(ticketsForTab([epic, todo], 'active'))).toEqual(['epic', 'todo']);
    expect(ids(ticketsForTab([epic, todo], 'backlog'))).toEqual(['epic', 'todo']);
  });
});

describe('parseBacklogTab', () => {
  it('reads back every tab it stores', () => {
    for (const tab of Object.keys(BACKLOG_TAB_LABEL)) expect(parseBacklogTab(tab)).toBe(tab);
  });

  it("falls back to 'active' for an unknown or missing value", () => {
    expect(parseBacklogTab('done')).toBe('active');
    expect(parseBacklogTab('')).toBe('active');
    expect(parseBacklogTab(null)).toBe('active');
    expect(parseBacklogTab(undefined)).toBe('active');
  });
});
