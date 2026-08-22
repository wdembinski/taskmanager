import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from './model';
import { resolveMove } from './moveResolve';

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
    expect(r).toMatchObject({
      localStatus: 'in-progress',
      jiraTransition: 'toInProgress',
      preBlockStatus: null,
    });
  });

  it('moving into Blocked blocks the ticket too, and still offers the pre-block status', () => {
    const r = resolveMove(task({ status: 'in-progress' }), 'blocked');
    expect(r).toMatchObject({
      localStatus: 'blocked',
      jiraTransition: 'toBlocked',
      preBlockStatus: 'in-progress',
    });
  });

  it('an internal card blocks locally — there is no ticket to block', () => {
    const r = resolveMove(task({ source: 'adhoc', externalSource: null }), 'blocked');
    expect(r).toMatchObject({
      localStatus: 'blocked',
      jiraTransition: null,
      preBlockStatus: 'pending',
    });
  });

  it('un-blocking into In Progress re-transitions JIRA and clears preBlockStatus', () => {
    const r = resolveMove(
      task({ status: 'blocked', preBlockStatus: 'in-progress' }),
      'in-progress',
    );
    expect(r).toMatchObject({
      localStatus: 'in-progress',
      jiraTransition: 'toInProgress',
      preBlockStatus: null,
    });
  });

  it('moving back to TO DO transitions JIRA too — the board is a view of the ticket', () => {
    const r = resolveMove(task({ status: 'in-progress' }), 'todo');
    expect(r).toMatchObject({ localStatus: 'pending', jiraTransition: 'toTodo' });
  });

  it('un-blocking to TO DO transitions JIRA, which is where the ticket has to come back to', () => {
    const r = resolveMove(task({ status: 'blocked', preBlockStatus: 'pending' }), 'todo');
    expect(r).toMatchObject({ localStatus: 'pending', jiraTransition: 'toTodo' });
  });

  it('moving into In Review transitions JIRA to In Review', () => {
    const r = resolveMove(task({ status: 'in-progress' }), 'in-review');
    expect(r).toMatchObject({
      localStatus: 'in-review',
      jiraTransition: 'toInReview',
      preBlockStatus: null,
    });
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
