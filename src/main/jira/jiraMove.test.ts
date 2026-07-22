import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@shared/model';
import { pickTransition, resolveMove } from './jiraMove';
import type { JiraTransition } from './jiraClient';

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
  externalKey: 'AB-1',
  externalId: '1',
  ...over,
});

describe('resolveMove', () => {
  it('is a no-op when dropped into the same column', () => {
    const r = resolveMove(task({ status: 'pending' }), 'todo');
    expect(r.noop).toBe(true);
  });

  it('TO DO → IN PROGRESS transitions the JIRA issue', () => {
    const r = resolveMove(task({ status: 'pending' }), 'in-progress');
    expect(r).toMatchObject({ localStatus: 'in-progress', jiraTransition: 'toInProgress', preBlockStatus: null });
  });

  it('moving into Blocked never touches JIRA and remembers the pre-block status', () => {
    const r = resolveMove(task({ status: 'in-progress' }), 'blocked');
    expect(r).toMatchObject({ localStatus: 'blocked', jiraTransition: null, preBlockStatus: 'in-progress' });
  });

  it('un-blocking into In Progress re-transitions JIRA and clears preBlockStatus', () => {
    const r = resolveMove(task({ status: 'blocked', preBlockStatus: 'in-progress' }), 'in-progress');
    expect(r).toMatchObject({ localStatus: 'in-progress', jiraTransition: 'toInProgress', preBlockStatus: null });
  });

  it('moving back to TO DO does not transition JIRA', () => {
    const r = resolveMove(task({ status: 'blocked', preBlockStatus: 'pending' }), 'todo');
    expect(r).toMatchObject({ localStatus: 'pending', jiraTransition: null });
  });

  it('moving into Done transitions JIRA to Done', () => {
    const r = resolveMove(task({ status: 'in-progress' }), 'done');
    expect(r.jiraTransition).toBe('toDone');
  });

  it('internal (non-JIRA) tasks never transition anything', () => {
    const r = resolveMove(task({ source: 'adhoc', externalSource: null }), 'in-progress');
    expect(r.jiraTransition).toBeNull();
    expect(r.localStatus).toBe('in-progress');
  });
});

const T = (id: string, name: string, categoryKey: string): JiraTransition => ({
  id,
  name,
  to: { name, statusCategory: { key: categoryKey, name } },
});

describe('pickTransition', () => {
  const transitions = [T('11', 'Start Progress', 'indeterminate'), T('31', 'Resolve', 'done')];

  it('matches In Progress by destination category', () => {
    expect(pickTransition(transitions, 'toInProgress', {})?.id).toBe('11');
  });
  it('matches Done by destination category', () => {
    expect(pickTransition(transitions, 'toDone', {})?.id).toBe('31');
  });
  it('honors an exact-name override', () => {
    const withExtra = [...transitions, T('99', 'Kickoff', 'indeterminate')];
    expect(pickTransition(withExtra, 'toInProgress', { inProgressTransitionName: 'Kickoff' })?.id).toBe('99');
  });
  it('returns null when no transition fits', () => {
    expect(pickTransition([T('5', 'Close', 'done')], 'toInProgress', {})).toBeNull();
  });
});
