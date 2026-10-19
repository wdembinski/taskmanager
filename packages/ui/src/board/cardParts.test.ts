import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@tm/shared/model';
import type { MergeRequest } from '@tm/shared/mergeRequest';
import { cardParts, type CardPartsContext } from './cardParts';

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

const ctx = (over: Partial<CardPartsContext> = {}): CardPartsContext => ({
  now: NOW,
  ...over,
});

describe('cardParts', () => {
  it('shows only the key for an idle backlog card with nothing else', () => {
    expect(cardParts(task(), ctx())).toEqual({
      key: 'TM-71',
      owner: undefined,
      statusLine: undefined,
      progress: undefined,
      epic: undefined,
      trailing: undefined,
    });
  });

  it('falls back to externalKey, then to the empty string', () => {
    expect(cardParts(task({ ticketKey: undefined, externalKey: 'LIN-203' }), ctx()).key).toBe(
      'LIN-203',
    );
    expect(cardParts(task({ ticketKey: undefined }), ctx()).key).toBe('');
  });

  describe('owner', () => {
    it('is absent for neither an assignee nor a delegated agent', () => {
      expect(cardParts(task(), ctx()).owner).toBeUndefined();
    });

    it('carries a human assignee, never running', () => {
      const assignee = { name: 'Ada Lovelace', initials: 'AL', color: '#123456' };
      const parts = cardParts(task(), ctx({ assignee }));
      expect(parts.owner).toEqual({
        avatar: { assignee, agentName: undefined, title: 'Ada Lovelace' },
        running: false,
      });
    });

    it('carries a delegated agent, idle', () => {
      const parts = cardParts(task({ agentProjectId: 'proj-1' }), ctx({ agentName: 'Bot Repo' }));
      expect(parts.owner).toEqual({
        avatar: { assignee: undefined, agentName: 'Bot Repo', title: 'Bot Repo' },
        running: false,
      });
    });

    it('is running while its agent actively works the card', () => {
      const parts = cardParts(
        task({ status: 'running', agentProjectId: 'proj-1' }),
        ctx({ agentName: 'Bot Repo' }),
      );
      expect(parts.owner?.running).toBe(true);
    });

    it('is never running for a human assignee, even on a running card', () => {
      const assignee = { name: 'Ada Lovelace', initials: 'AL', color: '#123456' };
      const parts = cardParts(task({ status: 'running' }), ctx({ assignee }));
      expect(parts.owner?.running).toBe(false);
    });
  });

  describe('statusLine — a live run outranks everything', () => {
    it('labels the running step out of 4 subtasks "Step 2 of 4", cyan', () => {
      const card = task({ id: 'c1', status: 'in-progress', agentProjectId: 'proj-1' });
      const subtasks = [
        task({ id: 's1', parentTaskId: 'c1', status: 'done' }),
        task({ id: 's2', parentTaskId: 'c1', status: 'running' }),
        task({ id: 's3', parentTaskId: 'c1', status: 'pending' }),
        task({ id: 's4', parentTaskId: 'c1', status: 'pending' }),
      ];
      const parts = cardParts(card, ctx({ subtasks }));
      expect(parts.statusLine).toEqual({ kind: 'running', label: 'Step 2 of 4', ink: 'cyan' });
    });

    it('says "Starting" for a run that has spawned but is not yet persisted', () => {
      const card = task({ id: 'c1', status: 'pending', agentProjectId: 'proj-1' });
      const parts = cardParts(card, ctx({ liveRunTaskIds: new Set(['c1']) }));
      expect(parts.statusLine).toEqual({ kind: 'running', label: 'Starting', ink: 'cyan' });
    });

    it('says "Merging" for a card whose branch is being merged — nothing about the task moves', () => {
      const card = task({ id: 'c1', status: 'done' });
      const parts = cardParts(card, ctx({ mergingTaskIds: new Set(['c1']) }));
      expect(parts.statusLine).toEqual({ kind: 'running', label: 'Merging', ink: 'cyan' });
    });

    it("swaps the step label for the run's purpose on a remediation errand", () => {
      const card = task({ id: 'c1', status: 'running', agentProjectId: 'proj-1' });
      const parts = cardParts(card, ctx({ runPurposes: new Map([['c1', 'fix-pipeline']]) }));
      expect(parts.statusLine).toEqual({ kind: 'running', label: 'fixing CI', ink: 'cyan' });
    });

    it('swaps a re-run STEP\'s label for its purpose, not "Running step 4 of 4" — the old card\'s confusion', () => {
      const card = task({ id: 'c1', status: 'in-progress', agentProjectId: 'proj-1' });
      const subtasks = [
        task({ id: 's1', parentTaskId: 'c1', status: 'done' }),
        task({ id: 's2', parentTaskId: 'c1', status: 'done' }),
        task({ id: 's3', parentTaskId: 'c1', status: 'done' }),
        // A finished chain's last step, re-run by the engine to resolve a rebase conflict —
        // its own status goes back to `running`, which `runPhase` alone would read as
        // ordinary chain progress ("Running step 4 of 4"). The purpose is what says this is
        // actually a remediation, not the chain moving forward again.
        task({ id: 's4', parentTaskId: 'c1', status: 'running' }),
      ];
      const parts = cardParts(
        card,
        ctx({ subtasks, runPurposes: new Map([['s4', 'resolve-conflicts']]) }),
      );
      expect(parts.statusLine).toEqual({
        kind: 'running',
        label: 'resolving conflicts',
        ink: 'cyan',
      });
    });
  });

  describe('statusLine — a non-moving run phase, when nothing is spinning', () => {
    it('says "Waiting for you", attention, for a card parked on its own question', () => {
      const card = task({ status: 'waiting-input', agentProjectId: 'proj-1' });
      expect(cardParts(card, ctx()).statusLine).toEqual({
        kind: 'status',
        label: 'Waiting for you',
        ink: 'attention',
      });
    });

    it('reports a stopped CHAIN the parent itself does not see — a step parked on a question', () => {
      const card = task({ id: 'c1', status: 'in-progress', agentProjectId: 'proj-1' });
      const subtasks = [
        task({ id: 's1', parentTaskId: 'c1', status: 'done' }),
        task({ id: 's2', parentTaskId: 'c1', status: 'waiting-input' }),
        task({ id: 's3', parentTaskId: 'c1', status: 'pending' }),
      ];
      const parts = cardParts(card, ctx({ subtasks }));
      // `cardBadgeStatus` alone sees nothing here — the PARENT is resting exactly where its
      // own column already says it is — so this line only exists because `cardRunLabel`'s
      // non-moving run phase is checked too.
      expect(parts.statusLine).toEqual({
        kind: 'status',
        label: 'Stopped at step 2 of 3',
        ink: 'attention',
      });
    });

    it('marks a chain stopped on a FAILED step as danger, not attention', () => {
      const card = task({ id: 'c1', status: 'in-progress', agentProjectId: 'proj-1' });
      const subtasks = [
        task({ id: 's1', parentTaskId: 'c1', status: 'done' }),
        task({ id: 's2', parentTaskId: 'c1', status: 'failed' }),
      ];
      const parts = cardParts(card, ctx({ subtasks }));
      expect(parts.statusLine).toEqual({
        kind: 'status',
        label: 'Stopped at step 2 of 2',
        ink: 'danger',
      });
    });

    it('says "Paused — usage limit", danger (severe), for a step held behind the gate', () => {
      const card = task({ id: 'c1', status: 'in-progress', agentProjectId: 'proj-1' });
      const subtasks = [task({ id: 's1', parentTaskId: 'c1', status: 'blocked-by-limit' })];
      const parts = cardParts(card, ctx({ subtasks }));
      expect(parts.statusLine).toEqual({
        kind: 'status',
        label: 'Paused — usage limit (step 1 of 1)',
        ink: 'danger',
      });
    });

    it('says "Assigned — not started", faint, for an agent assigned but never run', () => {
      const card = task({ status: 'pending', agentProjectId: 'proj-1' });
      expect(cardParts(card, ctx()).statusLine).toEqual({
        kind: 'status',
        label: 'Assigned — not started',
        ink: 'faint',
      });
    });
  });

  describe('statusLine — a terminal status the column does not already say', () => {
    it('says "Failed", danger, for a failed card resting in Done', () => {
      expect(cardParts(task({ status: 'failed' }), ctx()).statusLine).toEqual({
        kind: 'status',
        label: 'Failed',
        ink: 'danger',
      });
    });

    it('says "Stopped", faint, for a manually stopped card resting in Done', () => {
      const card = task({ status: 'stopped', stoppedAt: NOW - 1000, agentProjectId: 'proj-1' });
      expect(cardParts(card, ctx()).statusLine).toEqual({
        kind: 'status',
        label: 'Stopped',
        ink: 'faint',
      });
    });

    it('says "Cancelled", faint, for a cancelled card', () => {
      expect(cardParts(task({ status: 'cancelled' }), ctx()).statusLine).toEqual({
        kind: 'status',
        label: 'Cancelled',
        ink: 'faint',
      });
    });
  });

  describe('statusLine — the one MR verdict worth a line', () => {
    it('says "Changes requested", attention, never danger', () => {
      const parts = cardParts(
        task({ status: 'in-review' }),
        ctx({ mergeRequests: [mr({ changesRequested: true, approvalsGiven: 0 })] }),
      );
      expect(parts.statusLine).toEqual({
        kind: 'verdict',
        label: 'Changes requested',
        ink: 'attention',
      });
    });

    it('says "1/1 approved", success, for an approved MR', () => {
      const parts = cardParts(
        task({ status: 'in-review' }),
        ctx({
          mergeRequests: [mr({ approvalsRequired: 1, approvalsGiven: 1, changesRequested: false })],
        }),
      );
      expect(parts.statusLine).toEqual({ kind: 'verdict', label: '1/1 approved', ink: 'success' });
    });

    it('says "No approval required", success, for an unopposed MR', () => {
      const parts = cardParts(
        task({ status: 'in-review' }),
        ctx({
          mergeRequests: [mr({ approvalsRequired: 0, approvalsGiven: 0, changesRequested: false })],
        }),
      );
      expect(parts.statusLine).toEqual({
        kind: 'verdict',
        label: 'No approval required',
        ink: 'success',
      });
    });

    it('says the merge is blocked, danger, for conflicts', () => {
      const parts = cardParts(
        task({ status: 'in-review' }),
        ctx({
          mergeRequests: [mr({ hasConflicts: true, approvalsRequired: 1, approvalsGiven: 1 })],
        }),
      );
      expect(parts.statusLine).toEqual({
        kind: 'verdict',
        label: "Can't merge — merge conflicts",
        ink: 'danger',
      });
    });

    it("is silent for a merged MR — the footer's own ref already says it landed", () => {
      const parts = cardParts(
        task({ status: 'done' }),
        ctx({ mergeRequests: [mr({ state: 'merged' })] }),
      );
      expect(parts.statusLine).toBeUndefined();
    });

    it("is silent for an untouched, awaiting MR — every open MR's resting state", () => {
      const parts = cardParts(
        task({ status: 'in-review' }),
        ctx({ mergeRequests: [mr({ approvalsRequired: 1, approvalsGiven: 0 })] }),
      );
      expect(parts.statusLine).toBeUndefined();
    });
  });

  describe('statusLine — the chain position, last and quietest', () => {
    it('shows "2 of 3", faint, for a card with nothing else to say but a chain', () => {
      const parts = cardParts(task(), ctx({ chainPosition: { n: 2, m: 3 } }));
      expect(parts.statusLine).toEqual({ kind: 'chain', label: '2 of 3', ink: 'faint' });
    });

    it('never shows once a live run has something to say instead', () => {
      const parts = cardParts(
        task({ status: 'running', agentProjectId: 'proj-1' }),
        ctx({ chainPosition: { n: 2, m: 3 } }),
      );
      expect(parts.statusLine).toEqual({ kind: 'running', label: 'Running', ink: 'cyan' });
    });
  });

  describe('progress', () => {
    it('is absent for a card with no steps', () => {
      expect(cardParts(task(), ctx()).progress).toBeUndefined();
    });

    it('is done/total once the card has steps', () => {
      const card = task({ id: 'c1' });
      const subtasks = [
        task({ id: 's1', parentTaskId: 'c1', status: 'done' }),
        task({ id: 's2', parentTaskId: 'c1', status: 'pending' }),
      ];
      expect(cardParts(card, ctx({ subtasks })).progress).toEqual({ done: 1, total: 2 });
    });
  });

  describe('epic', () => {
    it('is absent with no epic at all', () => {
      expect(cardParts(task(), ctx()).epic).toBeUndefined();
    });

    it('prefers the resolved epicName', () => {
      const card = task({ externalEpicName: 'From tracker', externalParentKey: 'TM-1' });
      expect(cardParts(card, ctx({ epicName: 'Resolved epic' })).epic).toBe('Resolved epic');
    });

    it('falls back to externalEpicName, then externalParentKey', () => {
      expect(cardParts(task({ externalEpicName: 'Tracker epic' }), ctx()).epic).toBe(
        'Tracker epic',
      );
      expect(cardParts(task({ externalParentKey: 'TM-1' }), ctx()).epic).toBe('TM-1');
    });

    it('truncates a long label', () => {
      const long = 'A very long epic name that will not fit the footer chip';
      const epic = cardParts(task(), ctx({ epicName: long })).epic;
      expect(epic).toBe('A very long epic name t…');
      expect(epic?.length).toBe(24);
    });
  });

  describe('trailing — the MR ref, else the due date, never both', () => {
    it('is absent with neither', () => {
      expect(cardParts(task(), ctx()).trailing).toBeUndefined();
    });

    it('is the MR ref when both an MR and a due date exist', () => {
      const dueAt = new Date(2026, 9, 20).getTime();
      const parts = cardParts(task({ dueAt }), ctx({ mergeRequests: [mr()] }));
      expect(parts.trailing).toEqual({
        kind: 'mr',
        ref: '!71',
        url: 'https://gitlab.com/acme/web/-/merge_requests/71',
      });
    });

    it('falls back to the due date with no MR', () => {
      const dueAt = new Date(2026, 9, 15).getTime();
      const parts = cardParts(task({ dueAt }), ctx());
      expect(parts.trailing).toEqual({ kind: 'due', label: 'Oct 15', flagged: true });
    });

    it('does not fall back to a closed MR, which issueRowParts.pickMergeRequest never chooses', () => {
      const dueAt = new Date(2026, 9, 17).getTime();
      const parts = cardParts(task({ dueAt }), ctx({ mergeRequests: [mr({ state: 'closed' })] }));
      expect(parts.trailing).toEqual({ kind: 'due', label: 'Oct 17', flagged: false });
    });
  });
  describe('decision', () => {
    it('is absent for a card with no open decision', () => {
      expect(cardParts(task(), ctx()).decision).toBeUndefined();
      expect(cardParts(task({ decisionQuestion: null }), ctx()).decision).toBeUndefined();
    });

    it('carries the question while a decision is open', () => {
      const parts = cardParts(
        task({ decisionQuestion: 'Which hosting plan do we pay for?', decisionAskedAt: NOW }),
        ctx(),
      );
      expect(parts.decision).toEqual({ question: 'Which hosting plan do we pay for?' });
    });
  });
});
