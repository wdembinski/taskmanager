import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type IssueType, type Task } from '@tm/shared/model';
import type { MergeRequest } from '@tm/shared/mergeRequest';
import { issueRowParts, type IssueRowContext } from './issueRowParts';

const NOW = new Date(2026, 9, 16, 12, 0, 0).getTime();

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: 'Fix the thing',
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'ticket',
  isContract: false,
  isScaffold: false,
  ticketKey: 'TM-71',
  ...over,
});

const mr = (over: Partial<MergeRequest> = {}): MergeRequest => ({
  id: 'gl-9-1',
  taskId: 't1',
  openedForTaskId: null,
  provider: 'gitlab',
  repoId: 9,
  projectPath: 'acme/web',
  number: 71,
  title: 'TM-71 fix the thing',
  displayName: null,
  webUrl: 'https://gitlab.com/acme/web/-/merge_requests/71',
  sourceBranch: 'feature/TM-71',
  targetBranch: 'main',
  state: 'opened',
  draft: false,
  headSha: null,
  lastActedSha: null,
  lastActedAction: null,
  pipelineStatus: 'success',
  pipelineStages: [],
  pipelineUrl: null,
  approvalsRequired: null,
  approvalsGiven: 0,
  changesRequested: false,
  detailedMergeStatus: 'mergeable',
  hasConflicts: false,
  issueKeys: ['TM-71'],
  latestNoteAt: null,
  lastReadAt: null,
  lastEventAt: null,
  lastEventSeenAt: null,
  updatedAt: 100,
  syncedAt: 100,
  ...over,
});

const ctx = (over: Partial<IssueRowContext> = {}): IssueRowContext => ({
  now: NOW,
  ...over,
});

describe('issueRowParts', () => {
  it('shows only key, column and title for an idle ticket with nothing else', () => {
    expect(issueRowParts(task(), ctx())).toEqual({
      key: 'TM-71',
      column: 'todo',
      title: 'Fix the thing',
      run: undefined,
      mr: undefined,
      due: undefined,
      avatar: undefined,
    });
  });

  describe('run', () => {
    it('has a run part for a running ticket', () => {
      const parts = issueRowParts(task({ status: 'running' }), ctx());
      expect(parts.run).toEqual({ label: 'Running' });
    });

    it('labels the running step out of 4 subtasks "Step 2 of 4"', () => {
      const card = task({ id: 'c1', status: 'in-progress' });
      const subtasks = [
        task({ id: 's1', parentTaskId: 'c1', status: 'done' }),
        task({ id: 's2', parentTaskId: 'c1', status: 'running' }),
        task({ id: 's3', parentTaskId: 'c1', status: 'pending' }),
        task({ id: 's4', parentTaskId: 'c1', status: 'pending' }),
      ];
      const parts = issueRowParts(card, ctx({ subtasks }));
      expect(parts.run).toEqual({ label: 'Step 2 of 4' });
    });

    it('gives a pending task with a live-run id a pill', () => {
      const card = task({ id: 'c1', status: 'pending' });
      const parts = issueRowParts(card, ctx({ liveRunTaskIds: new Set(['c1']) }));
      expect(parts.run).toEqual({ label: 'Starting' });
    });
  });

  describe('due', () => {
    it('flags an overdue date, labelled with the calendar date', () => {
      const dueAt = new Date(2026, 9, 15).getTime();
      const parts = issueRowParts(task({ dueAt }), ctx());
      expect(parts.due).toEqual({ label: 'Oct 15', flagged: true });
    });

    it('flags a same-day date, labelled "Today"', () => {
      const dueAt = new Date(2026, 9, 16, 9, 0, 0).getTime();
      const parts = issueRowParts(task({ dueAt }), ctx());
      expect(parts.due).toEqual({ label: 'Today', flagged: true });
    });

    it('does not flag a future date', () => {
      const dueAt = new Date(2026, 9, 17).getTime();
      const parts = issueRowParts(task({ dueAt }), ctx());
      expect(parts.due).toEqual({ label: 'Oct 17', flagged: false });
    });

    it('does not flag an overdue date once the ticket is done', () => {
      const dueAt = new Date(2026, 9, 15).getTime();
      const parts = issueRowParts(task({ status: 'done', dueAt }), ctx());
      expect(parts.due).toEqual({ label: 'Oct 15', flagged: false });
    });
  });

  describe('mr', () => {
    it("gives an opened MR's ref", () => {
      const parts = issueRowParts(task(), ctx({ mergeRequests: [mr({ state: 'opened' })] }));
      expect(parts.mr).toEqual({
        ref: '!71',
        url: 'https://gitlab.com/acme/web/-/merge_requests/71',
      });
    });

    it('gives none for a closed MR', () => {
      const parts = issueRowParts(task(), ctx({ mergeRequests: [mr({ state: 'closed' })] }));
      expect(parts.mr).toBeUndefined();
    });
  });

  describe('avatar', () => {
    it('shows an avatar for an assignee', () => {
      const assignee = { name: 'Ada Lovelace', initials: 'AL', color: '#123456' };
      const parts = issueRowParts(task(), ctx({ assignee }));
      expect(parts.avatar).toEqual({ assignee, agentName: undefined, title: 'Ada Lovelace' });
    });

    it('shows an avatar for a delegated agent', () => {
      const parts = issueRowParts(task(), ctx({ agentName: 'Bot Repo' }));
      expect(parts.avatar).toEqual({
        assignee: undefined,
        agentName: 'Bot Repo',
        title: 'Bot Repo',
      });
    });

    it('shows an avatar for both an assignee and a delegated agent', () => {
      const assignee = { name: 'Ada Lovelace', initials: 'AL', color: '#123456' };
      const parts = issueRowParts(task(), ctx({ assignee, agentName: 'Bot Repo' }));
      expect(parts.avatar).toEqual({
        assignee,
        agentName: 'Bot Repo',
        title: 'Ada Lovelace / Bot Repo',
      });
    });
  });

  it('is unchanged by priority and every issueType value on an idle ticket', () => {
    const bare = task();
    const bareResult = issueRowParts(bare, ctx());
    const issueTypes: IssueType[] = ['epic', 'story', 'task', 'bug', 'subtask'];
    for (const issueType of issueTypes) {
      const withType = task({ issueType, externalPriority: 'High' });
      expect(issueRowParts(withType, ctx())).toEqual(bareResult);
    }
  });
});
