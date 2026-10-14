import { describe, expect, it } from 'vitest';
import { LOCAL_TARGET } from '@shared/execTarget';
import { PERSONAL_PROJECT_ID, type Project, type Task } from '@shared/model';
import {
  issueToTask,
  issuesToRecheck,
  linearTaskId,
  reconcileLinearIssues,
  type LinearIssueSyncOptions,
} from './linearSync';
import type { LinearComment, LinearIssue } from './linearClient';

const issue = (uuid: string, over: Partial<LinearIssue> = {}): LinearIssue => ({
  id: uuid,
  identifier: 'ENG-12',
  title: `Do thing ${uuid}`,
  description: null,
  url: `https://linear.app/acme/issue/ENG-12`,
  priority: 0,
  updatedAt: '2026-08-01T10:00:00Z',
  state: { id: 'state-unstarted', name: 'Todo', type: 'unstarted' },
  team: { id: 'team-eng', key: 'ENG' },
  labels: { nodes: [] },
  assignee: null,
  ...over,
});

const card = (over: Partial<Task> = {}): Task =>
  ({
    id: linearTaskId('uuid-1'),
    projectId: PERSONAL_PROJECT_ID,
    phase: 'ENG',
    title: 'Do thing uuid-1',
    status: 'pending',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'linear',
    isContract: false,
    isScaffold: false,
    externalSource: 'linear',
    externalKey: 'ENG-12',
    externalId: 'uuid-1',
    ...over,
  }) as Task;

const opts: LinearIssueSyncOptions = { now: 10_000, rechecked: new Map(), recheckedIds: [] };

const removedKeys = (r: { removals: { key: string }[] }): string[] => r.removals.map((x) => x.key);

describe('issueToTask', () => {
  it('adopts a new issue: linear-<uuid> id, team-key phase, column from the state type', () => {
    const task = issueToTask(issue('uuid-99', { identifier: 'ENG-99' }), undefined, {}, 0);
    expect(task).toMatchObject({
      id: 'linear-uuid-99',
      externalKey: 'ENG-99',
      externalId: 'uuid-99',
      phase: 'ENG',
      source: 'linear',
      externalSource: 'linear',
      status: 'pending',
      lastReadCommentAt: null,
    });
  });

  it('updates the title and state on the same card, preserving order and filing', () => {
    const existing = card({ order: 7, title: 'Old title', projectTagId: 'proj-1' });
    const task = issueToTask(
      issue('uuid-1', {
        title: 'New title',
        state: { id: 's2', name: 'In Progress', type: 'started' },
      }),
      existing,
      {},
      3,
    );
    expect(task).toMatchObject({
      id: existing.id,
      title: 'New title',
      status: 'in-progress',
      order: 7,
      projectTagId: 'proj-1',
    });
  });

  it('keeps a block the APP applied, and follows the tracker out of one it did not', () => {
    const ours = card({ status: 'blocked', preBlockStatus: 'in-progress' });
    expect(issueToTask(issue('uuid-1'), ours, {}, 0)).toMatchObject({
      status: 'blocked',
      preBlockStatus: 'in-progress',
    });
    const theirs = card({ status: 'blocked', preBlockStatus: null });
    expect(issueToTask(issue('uuid-1'), theirs, {}, 0)).toMatchObject({
      status: 'pending',
      preBlockStatus: null,
    });
  });

  it('never evicts a live run from status — it parks the column instead', () => {
    const running = card({ status: 'running', preRunStatus: 'pending' });
    const task = issueToTask(
      issue('uuid-1', { state: { id: 's3', name: 'Done', type: 'completed' } }),
      running,
      {},
      0,
    );
    expect(task.status).toBe('running');
    expect(task.preRunStatus).toBe('done');
  });

  it('starts a brand-new card READ, and leaves an existing marker alone', () => {
    const comments = new Map<string, readonly LinearComment[]>([
      [
        'uuid-1',
        [
          {
            id: 'c1',
            body: 'hi',
            createdAt: '2026-08-02T09:00:00Z',
            url: 'https://linear.app/acme/issue/ENG-12#comment-c1',
            user: { id: 'u1', name: 'someone', displayName: 'Someone' },
          },
        ],
      ],
    ]);
    const fresh = issueToTask(issue('uuid-1'), undefined, { comments }, 0);
    expect(fresh.latestCommentAt).toBe(fresh.lastReadCommentAt);

    const seen = card({ lastReadCommentAt: 1 });
    expect(issueToTask(issue('uuid-1'), seen, { comments }, 0).lastReadCommentAt).toBe(1);
  });

  it('does not count your OWN comment towards the unread border', () => {
    const comments = new Map<string, readonly LinearComment[]>([
      [
        'uuid-1',
        [
          {
            id: 'c1',
            body: 'hi',
            createdAt: '2026-08-02T09:00:00Z',
            url: 'https://linear.app/acme/issue/ENG-12#comment-c1',
            user: { id: 'u2', name: 'me', displayName: 'Me' },
          },
        ],
      ],
    ]);
    const isMine = (c: LinearComment) => c.user?.name === 'me';
    expect(
      issueToTask(issue('uuid-1'), undefined, { comments, isMine }, 0).latestCommentAt,
    ).toBeNull();
  });

  it('reads priority 1-4 by name; 0 and anything unrecognised fall back to the prior value', () => {
    expect(issueToTask(issue('uuid-1', { priority: 1 }), undefined, {}, 0).externalPriority).toBe(
      'Urgent',
    );
    expect(issueToTask(issue('uuid-1', { priority: 4 }), undefined, {}, 0).externalPriority).toBe(
      'Low',
    );
    const known = card({ externalPriority: 'High' });
    expect(issueToTask(issue('uuid-1', { priority: 0 }), known, {}, 0).externalPriority).toBe(
      'High',
    );
    expect(issueToTask(issue('uuid-1', { priority: 9 }), known, {}, 0).externalPriority).toBe(
      'High',
    );
  });

  it('keeps what it knew for every field this sync did not answer', () => {
    const known = card({
      latestCommentAt: 500,
      externalPriority: 'High',
      externalDescription: 'old brief',
      externalEpicName: 'Checkout rework',
      externalSprint: 'Sprint 4',
      externalType: 'Bug',
      projectTagId: 'proj-1',
      agentProjectId: 'agent-1',
    });
    const task = issueToTask(issue('uuid-1', { description: null, priority: 0 }), known, {}, 0);
    expect(task).toMatchObject({
      latestCommentAt: 500,
      externalPriority: 'High',
      externalDescription: 'old brief',
      externalEpicName: 'Checkout rework',
      externalSprint: 'Sprint 4',
      externalType: 'Bug',
      projectTagId: 'proj-1',
      agentProjectId: 'agent-1',
    });
  });
});

describe('issueToTask — team move', () => {
  it('reads an existing card by UUID, so a team move updates it rather than adding a new one', () => {
    const existing = card({ order: 4, phase: 'ENG', externalKey: 'ENG-12', externalId: 'uuid-1' });
    const moved = issue('uuid-1', { identifier: 'OPS-40', team: { id: 'team-ops', key: 'OPS' } });
    const result = reconcileLinearIssues([existing], [moved], opts);
    expect(result.upserts).toHaveLength(1);
    expect(result.upserts[0]).toMatchObject({
      id: existing.id,
      externalKey: 'OPS-40',
      phase: 'OPS',
      order: 4,
    });
    expect(result.removals).toEqual([]);
  });

  it('falls back to stripping the linear- prefix off id when externalId is missing', () => {
    const existing = card({ externalId: undefined as unknown as string });
    const task = issueToTask(issue('uuid-1'), existing, {}, 0);
    expect(task.id).toBe(existing.id);
  });
});

describe('issuesToRecheck', () => {
  it('asks about every card the fetch left out — and nothing else', () => {
    const board = [
      card({ id: 'a', externalId: 'uuid-a' }),
      card({ id: 'b', externalId: 'uuid-b' }),
      card({ id: 'c', externalId: 'uuid-c', archivedAt: 5 }),
      card({ id: 'd', externalId: 'uuid-d', status: 'blocked' }),
      { ...card({ id: 'e' }), source: 'jira', externalSource: 'jira', externalKey: 'AB-1' } as Task,
    ];
    expect(issuesToRecheck(board, [issue('uuid-a')])).toEqual(['uuid-b']);
  });
});

describe('reconcileLinearIssues', () => {
  it('never touches a card from another source', () => {
    const jira = { ...card({ id: 'j' }), source: 'jira', externalSource: 'jira' } as Task;
    const gh = { ...card({ id: 'g' }), source: 'github', externalSource: 'github' } as Task;
    const ticket = { ...card({ id: 't' }), source: 'ticket', externalSource: null } as Task;
    const adhoc = { ...card({ id: 'a' }), source: 'adhoc', externalSource: null } as Task;
    const result = reconcileLinearIssues([jira, gh, ticket, adhoc], [], opts);
    expect(result).toMatchObject({ upserts: [], removals: [] });
  });

  it('never touches a non-Linear row whose id/externalId collides with a UUID', () => {
    const collider = {
      ...card({ id: linearTaskId('uuid-1'), externalId: 'uuid-1' }),
      source: 'jira',
      externalSource: 'jira',
    } as Task;
    const result = reconcileLinearIssues([collider], [], {
      ...opts,
      rechecked: new Map(),
      recheckedIds: ['uuid-1'],
    });
    expect(result.upserts).toEqual([]);
    expect(result.removals).toEqual([]);
    expect(result.refused).toEqual([]);
  });

  it('leaves an archived card alone even when its issue returns to the query', () => {
    const gone = card({ archivedAt: 5, archivedReason: 'left-query' });
    const result = reconcileLinearIssues([gone], [issue('uuid-1')], opts);
    expect(result.upserts).toEqual([]);
    expect(result.removals).toEqual([]);
  });

  it('archives a card Linear was asked about and still has, but the query dropped', () => {
    const board = [card()];
    const result = reconcileLinearIssues(board, [], {
      ...opts,
      rechecked: new Map([['uuid-1', issue('uuid-1')]]),
      recheckedIds: ['uuid-1'],
    });
    expect(removedKeys(result)).toEqual(['ENG-12']);
    expect(result.removals[0].reason).toBe('left-query');
  });

  it('removes nothing on a question nobody put', () => {
    const board = [card()];
    expect(reconcileLinearIssues(board, [], { ...opts, rechecked: null }).removals).toEqual([]);
    expect(
      reconcileLinearIssues(board, [], { ...opts, rechecked: new Map(), recheckedIds: [] })
        .removals,
    ).toEqual([]);
    expect(
      reconcileLinearIssues(board, [], {
        ...opts,
        truncated: true,
        rechecked: new Map([['uuid-1', issue('uuid-1')]]),
        recheckedIds: ['uuid-1'],
      }).removals,
    ).toEqual([]);
  });

  it('says so out loud when a truncated fetch kept everything, and warns nothing was removed', () => {
    const result = reconcileLinearIssues([card()], [], { ...opts, truncated: true });
    expect(result.warning).toMatch(/did not return the whole issue filter/);
  });

  it('archives a card Linear answered for and does not have', () => {
    const result = reconcileLinearIssues([card()], [], {
      ...opts,
      rechecked: new Map(),
      recheckedIds: ['uuid-1'],
    });
    expect(result.removals[0]).toMatchObject({ key: 'ENG-12', reason: 'gone-from-jira' });
  });

  it('keeps a card whose re-read is completed, and starts its clock', () => {
    const result = reconcileLinearIssues([card()], [], {
      ...opts,
      retentionMs: 86_400_000,
      rechecked: new Map([
        ['uuid-1', issue('uuid-1', { state: { id: 's3', name: 'Done', type: 'completed' } })],
      ]),
      recheckedIds: ['uuid-1'],
    });
    expect(result.removals).toEqual([]);
    expect(result.upserts[0]).toMatchObject({ status: 'done', retainedSince: 10_000 });
  });

  it('lands a canceled issue in DONE', () => {
    const result = reconcileLinearIssues([card()], [], {
      ...opts,
      retentionMs: 86_400_000,
      rechecked: new Map([
        ['uuid-1', issue('uuid-1', { state: { id: 's4', name: 'Canceled', type: 'canceled' } })],
      ]),
      recheckedIds: ['uuid-1'],
    });
    expect(result.removals).toEqual([]);
    expect(result.upserts[0]).toMatchObject({ status: 'done', retainedSince: 10_000 });
  });

  it('retires a retained card once its window runs out', () => {
    const retained = card({ status: 'done', retainedSince: 1_000 });
    const withWindow = {
      ...opts,
      rechecked: new Map([
        ['uuid-1', issue('uuid-1', { state: { id: 's3', name: 'Done', type: 'completed' } })],
      ]),
      recheckedIds: ['uuid-1'],
    };
    expect(
      reconcileLinearIssues([retained], [], { ...withWindow, retentionMs: 20_000 }).removals,
    ).toEqual([]);
    expect(
      reconcileLinearIssues([retained], [], { ...withWindow, retentionMs: 5_000 }).removals[0],
    ).toMatchObject({ reason: 'retention-expired' });
  });

  it('keeps a blocked card whatever the query says, without asking about it', () => {
    const blocked = card({ status: 'blocked', preBlockStatus: 'pending' });
    const result = reconcileLinearIssues([blocked], [], {
      ...opts,
      rechecked: new Map(),
      recheckedIds: ['uuid-1'],
    });
    expect(result.removals).toEqual([]);
  });

  it('never resurrects an archived card even when the re-read still finds it', () => {
    const gone = card({ archivedAt: 5, archivedReason: 'gone-from-jira' });
    const result = reconcileLinearIssues([gone], [], {
      ...opts,
      rechecked: new Map([['uuid-1', issue('uuid-1')]]),
      recheckedIds: ['uuid-1'],
    });
    expect(result.upserts).toEqual([]);
    expect(result.removals).toEqual([]);
  });

  describe('rechecked: null keeps, new Map() retires, a missing id keeps', () => {
    it('keeps every missing card when the re-read pass did not run (rechecked: null)', () => {
      const board = [
        card({ id: 'a', externalId: 'uuid-a' }),
        card({ id: 'b', externalId: 'uuid-b' }),
      ];
      // recheckedIds is null too — nobody was asked, full stop.
      const result = reconcileLinearIssues(board, [], {
        ...opts,
        rechecked: null,
        recheckedIds: null,
      });
      expect(result.removals).toEqual([]);
      expect(result.upserts).toEqual([]);
    });

    it('retires every missing card as gone-from-jira when rechecked is an empty Map and all were asked', () => {
      const board = [
        card({ id: 'a', externalId: 'uuid-a' }),
        card({ id: 'b', externalId: 'uuid-b' }),
      ];
      const result = reconcileLinearIssues(board, [], {
        ...opts,
        rechecked: new Map(),
        recheckedIds: ['uuid-a', 'uuid-b'],
      });
      expect(result.removals.map((r) => r.reason)).toEqual(['gone-from-jira', 'gone-from-jira']);
    });

    it('keeps a UUID missing from recheckedIds — its own call never answered', () => {
      const board = [
        card({ id: 'a', externalId: 'uuid-a' }),
        card({ id: 'b', externalId: 'uuid-b' }),
      ];
      const result = reconcileLinearIssues(board, [], {
        ...opts,
        // uuid-a was actually asked and answered "still open" — gets left-queried.
        // uuid-b was never asked (absent from recheckedIds) — must be left untouched.
        rechecked: new Map([['uuid-a', issue('uuid-a')]]),
        recheckedIds: ['uuid-a'],
      });
      expect(result.removals).toEqual([
        { taskId: 'a', key: 'ENG-12', title: 'Do thing uuid-1', reason: 'left-query' },
      ]);
      expect(result.upserts).toEqual([]);
    });
  });

  it('a large query-unchanged shortfall is kept as an incomplete answer, never reaching the guard', () => {
    const board = Array.from({ length: 30 }, (_, i) =>
      card({ id: `linear-uuid-${i + 1}`, externalId: `uuid-${i + 1}` }),
    );
    const returned = board.slice(0, 18).map((_t, i) => issue(`uuid-${i + 1}`));
    const missing = board.slice(18);
    const result = reconcileLinearIssues(board, returned, {
      ...opts,
      rechecked: new Map(missing.map((t, i) => [t.externalId as string, issue(`uuid-${19 + i}`)])),
      recheckedIds: missing.map((t) => t.externalId as string),
    });
    expect(result.removals).toEqual([]);
    expect(result.refused).toEqual([]);
    expect(result.warning).toMatch(/left out 12 of 30 board cards/);
    expect(result.warning).not.toMatch(/issue filter/);
  });

  it('stands the guard down when the question itself changed', () => {
    const board = Array.from({ length: 30 }, (_, i) =>
      card({ id: `linear-uuid-${i + 1}`, externalId: `uuid-${i + 1}` }),
    );
    const missing = board.slice(18);
    const result = reconcileLinearIssues(
      board,
      board.slice(0, 18).map((_t, i) => issue(`uuid-${i + 1}`)),
      {
        ...opts,
        queryChanged: true,
        rechecked: new Map(
          missing.map((t, i) => [t.externalId as string, issue(`uuid-${19 + i}`)]),
        ),
        recheckedIds: missing.map((t) => t.externalId as string),
      },
    );
    expect(result.removals).toHaveLength(12);
    expect(result.refused).toEqual([]);
  });
});

describe('issueToTask — assigning tickets to their own board', () => {
  const project = (over: Partial<Project>): Project => ({
    id: 'p1',
    name: 'Repo',
    path: 'C:/repos/repo',
    planPath: '',
    defaultModel: 'sonnet',
    planningModel: null,
    defaultPermissionMode: 'acceptEdits',
    concurrency: 1,
    useWorktrees: true,
    baseBranch: '',
    writeBackPlan: false,
    autoRelease: false,
    autoCreatePr: false,
    autoIntegrate: null,
    planAligned: true,
    jiraEpicKeys: [],
    ticketPrefix: '',
    target: LOCAL_TARGET,
    instructions: '',
    color: '',
    createdAt: 0,
    ...over,
  });

  const board = project({ id: 'board', path: '', ticketPrefix: 'BRD' });
  const filedCard = (): Task => card({ projectTagId: 'board' });

  it('files the card on the project board when it is filed under one that owns a board', () => {
    const task = issueToTask(
      issue('uuid-1'),
      filedCard(),
      { assignOwnBoard: true, projects: [board] },
      0,
    );
    expect(task.projectId).toBe('board');
  });

  it('leaves the card on Personal when the feature is off', () => {
    const task = issueToTask(issue('uuid-1'), filedCard(), { projects: [board] }, 0);
    expect(task.projectId).toBe(PERSONAL_PROJECT_ID);
  });

  it('leaves the card on Personal when the filed project does not own a board', () => {
    const repoOnly = project({ id: 'repo' });
    const task = issueToTask(
      issue('uuid-1'),
      card({ projectTagId: 'repo' }),
      { assignOwnBoard: true, projects: [repoOnly] },
      0,
    );
    expect(task.projectId).toBe(PERSONAL_PROJECT_ID);
  });

  it('leaves a brand-new card (no filing yet) on Personal', () => {
    const task = issueToTask(
      issue('uuid-1'),
      undefined,
      { assignOwnBoard: true, projects: [board] },
      0,
    );
    expect(task.projectId).toBe(PERSONAL_PROJECT_ID);
  });
});
