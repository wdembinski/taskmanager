import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@shared/model';
import {
  issueToTask,
  issuesToRecheck,
  parseIssueKey,
  reconcileGitHubIssues,
  type GitHubIssueSyncOptions,
} from './githubIssueSync';
import type { GitHubSearchIssueItem } from './githubClient';

const issue = (
  number: number,
  over: Partial<GitHubSearchIssueItem> = {},
): GitHubSearchIssueItem => ({
  id: 1000 + number,
  node_id: `I_kw${number}`,
  number,
  title: `Do thing ${number}`,
  state: 'open',
  html_url: `https://github.com/acme/web/issues/${number}`,
  repository_url: 'https://api.github.com/repos/acme/web',
  updated_at: '2026-08-01T10:00:00Z',
  labels: [],
  ...over,
});

const card = (over: Partial<Task> = {}): Task =>
  ({
    id: 'gh-acme-web-1',
    projectId: PERSONAL_PROJECT_ID,
    phase: 'acme/web',
    title: 'Do thing 1',
    status: 'pending',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'github',
    isContract: false,
    isScaffold: false,
    externalSource: 'github',
    externalKey: 'acme/web#1',
    ...over,
  }) as Task;

const opts: GitHubIssueSyncOptions = { now: 10_000, rechecked: new Map(), recheckedKeys: [] };

const removedKeys = (r: { removals: { key: string }[] }): string[] => r.removals.map((x) => x.key);

describe('issueToTask', () => {
  it('files a card under its repo-scoped key, id and repository', () => {
    const task = issueToTask(issue(12), undefined, {}, 0);
    expect(task).toMatchObject({
      id: 'gh-acme-web-12',
      externalKey: 'acme/web#12',
      externalId: 'I_kw12',
      externalUrl: 'https://github.com/acme/web/issues/12',
      phase: 'acme/web',
      source: 'github',
      externalSource: 'github',
      status: 'pending',
    });
  });

  it('shows the deciding LABEL as the status, and the state when nothing decided', () => {
    const map = { 'in review': 'in-review' } as const;
    expect(
      issueToTask(issue(1, { labels: [{ name: 'in review' }] }), undefined, { overrides: map }, 0),
    ).toMatchObject({ externalStatus: 'in review', externalStatusCategory: 'In Progress' });
    expect(issueToTask(issue(1), undefined, {}, 0)).toMatchObject({
      externalStatus: 'open',
      externalStatusCategory: 'To Do',
    });
    expect(issueToTask(issue(1, { state: 'closed' }), undefined, {}, 0)).toMatchObject({
      externalStatus: 'closed',
      externalStatusCategory: 'Done',
      status: 'done',
    });
  });

  it('chips the first label the maps say nothing about, not the one deciding the column', () => {
    const task = issueToTask(
      issue(1, { labels: [{ name: 'in review' }, { name: 'backend' }] }),
      undefined,
      { overrides: { 'in review': 'in-review' } },
      0,
    );
    expect(task.externalLabel).toBe('backend');
  });

  it('reads the type off the two labels every repository is created with', () => {
    expect(
      issueToTask(issue(1, { labels: [{ name: 'bug' }] }), undefined, {}, 0).externalType,
    ).toBe('Bug');
    expect(
      issueToTask(issue(1, { labels: [{ name: 'enhancement' }] }), undefined, {}, 0).externalType,
    ).toBe('Enhancement');
    // A repository's own taxonomy is what the label map and the chip are for.
    expect(
      issueToTask(issue(1, { labels: [{ name: 'kind/feature' }] }), undefined, {}, 0).externalType,
    ).toBeNull();
  });

  // Every one of these is a rule `jiraSync.issueToTask` learned the hard way, and none of
  // them was about JIRA.
  it('keeps a block the APP applied, and follows the tracker out of one it did not', () => {
    const ours = card({ status: 'blocked', preBlockStatus: 'in-progress' });
    expect(issueToTask(issue(1), ours, {}, 0)).toMatchObject({
      status: 'blocked',
      preBlockStatus: 'in-progress',
    });
    // A card blocked by a mapped LABEL carries no `preBlockStatus`; removing the label in
    // GitHub is what should pull it out, and this is the sync that does it.
    const theirs = card({ status: 'blocked', preBlockStatus: null });
    expect(issueToTask(issue(1), theirs, {}, 0)).toMatchObject({
      status: 'pending',
      preBlockStatus: null,
    });
  });

  it('never evicts a live run from status — it parks the column instead', () => {
    const running = card({ status: 'running', preRunStatus: 'pending' });
    const task = issueToTask(issue(1, { state: 'closed' }), running, {}, 0);
    expect(task.status).toBe('running');
    expect(task.preRunStatus).toBe('done');
  });

  it('starts a brand-new card READ, and leaves an existing marker alone', () => {
    const comments = new Map([
      ['acme/web#1', [{ id: 1, created_at: '2026-08-02T09:00:00Z', user: { id: 9 } }]],
    ]);
    const fresh = issueToTask(issue(1), undefined, { comments }, 0);
    expect(fresh.latestCommentAt).toBe(fresh.lastReadCommentAt);

    const seen = card({ lastReadCommentAt: 1 });
    expect(issueToTask(issue(1), seen, { comments }, 0).lastReadCommentAt).toBe(1);
  });

  it('does not count your OWN comment towards the unread border', () => {
    const comments = new Map([
      ['acme/web#1', [{ id: 1, created_at: '2026-08-02T09:00:00Z', user: { id: 9 } }]],
    ]);
    const identity = { id: 9, login: 'wd', baseUrl: 'https://api.github.com' };
    expect(issueToTask(issue(1), undefined, { comments, identity }, 0).latestCommentAt).toBeNull();
  });

  it('keeps what it knew for every field this sync did not answer', () => {
    const known = card({
      latestCommentAt: 500,
      externalPriority: 'High',
      externalDescription: 'old brief',
      projectTagId: 'proj-1',
      agentProjectId: 'agent-1',
    });
    // No comments fetched, no body returned: a sync that did not ask must not blank them.
    const task = issueToTask(issue(1, { body: null }), known, {}, 0);
    expect(task).toMatchObject({
      latestCommentAt: 500,
      externalPriority: 'High',
      externalDescription: 'old brief',
      projectTagId: 'proj-1',
      agentProjectId: 'agent-1',
    });
  });
});

describe('parseIssueKey / issuesToRecheck', () => {
  it('round-trips a repo-scoped key and refuses anything else', () => {
    expect(parseIssueKey('acme/web#12')).toEqual({
      owner: 'acme',
      repo: 'web',
      number: 12,
      key: 'acme/web#12',
    });
    expect(parseIssueKey('#12')).toBeNull();
    expect(parseIssueKey('PROJ-12')).toBeNull();
  });

  it('asks about every card the search left out — and nothing else', () => {
    const board = [
      card({ id: 'a', externalKey: 'acme/web#1' }),
      card({ id: 'b', externalKey: 'acme/web#2' }),
      card({ id: 'c', externalKey: 'acme/web#3', archivedAt: 5 }),
      card({ id: 'd', externalKey: 'acme/web#4', status: 'blocked' }),
      // Another tracker's card, and an internal one: neither is this sync's business.
      { ...card({ id: 'e' }), source: 'jira', externalSource: 'jira', externalKey: 'AB-1' } as Task,
    ];
    expect(issuesToRecheck(board, [issue(1)]).map((r) => r.key)).toEqual(['acme/web#2']);
  });
});

describe('reconcileGitHubIssues', () => {
  it('never touches a card from another source', () => {
    const jira = { ...card({ id: 'j' }), source: 'jira', externalSource: 'jira' } as Task;
    const adhoc = { ...card({ id: 'a' }), source: 'adhoc', externalSource: null } as Task;
    const result = reconcileGitHubIssues([jira, adhoc], [], opts);
    expect(result).toMatchObject({ upserts: [], removals: [], restoreIds: [] });
  });

  it('brings an archived card back when its issue returns to the query', () => {
    const gone = card({ archivedAt: 5, archivedReason: 'left-query' });
    const result = reconcileGitHubIssues([gone], [issue(1)], opts);
    expect(result.restoreIds).toEqual(['gh-acme-web-1']);
    // The same ROW comes back — the id is the card's, not a new one.
    expect(result.upserts[0].id).toBe('gh-acme-web-1');
  });

  it('archives a card GitHub was asked about and still has, but the query dropped', () => {
    const board = [card()];
    const result = reconcileGitHubIssues(board, [], {
      ...opts,
      rechecked: new Map([['acme/web#1', issue(1)]]),
      recheckedKeys: ['acme/web#1'],
    });
    expect(removedKeys(result)).toEqual(['acme/web#1']);
    expect(result.removals[0].reason).toBe('left-query');
  });

  /** The rule the whole module exists to enforce, in its three shapes. */
  it('removes nothing on a question nobody put', () => {
    const board = [card()];
    // The re-read pass never ran.
    expect(reconcileGitHubIssues(board, [], { ...opts, rechecked: null }).removals).toEqual([]);
    // It ran, but this issue's own call errored — so its key is not among the answered.
    expect(
      reconcileGitHubIssues(board, [], { ...opts, rechecked: new Map(), recheckedKeys: [] })
        .removals,
    ).toEqual([]);
    // The search itself came back short.
    expect(
      reconcileGitHubIssues(board, [], {
        ...opts,
        truncated: true,
        rechecked: new Map([['acme/web#1', issue(1)]]),
        recheckedKeys: ['acme/web#1'],
      }).removals,
    ).toEqual([]);
  });

  it('says so out loud when a truncated search kept everything', () => {
    const result = reconcileGitHubIssues([card()], [], { ...opts, truncated: true });
    expect(result.warning).toMatch(/did not return the whole issue query/);
  });

  it('archives a card GitHub answered for and does not have', () => {
    const result = reconcileGitHubIssues([card()], [], {
      ...opts,
      rechecked: new Map(),
      recheckedKeys: ['acme/web#1'],
    });
    expect(result.removals[0]).toMatchObject({ key: 'acme/web#1', reason: 'gone-from-jira' });
  });

  /**
   * The `is:open` trap, and the one place this reconciler is cleverer than JIRA's: the
   * re-read is already in hand and it says the issue is closed, so the card the human just
   * finished is KEPT rather than archived out of the column they dropped it in.
   */
  it('keeps a card whose issue GitHub says is closed, and starts its clock', () => {
    const result = reconcileGitHubIssues([card()], [], {
      ...opts,
      retentionMs: 86_400_000,
      rechecked: new Map([['acme/web#1', issue(1, { state: 'closed' })]]),
      recheckedKeys: ['acme/web#1'],
    });
    expect(result.removals).toEqual([]);
    expect(result.upserts[0]).toMatchObject({ status: 'done', retainedSince: 10_000 });
  });

  it('retires a retained card once its window runs out', () => {
    const retained = card({ status: 'done', retainedSince: 1_000 });
    const withWindow = {
      ...opts,
      rechecked: new Map([['acme/web#1', issue(1, { state: 'closed' })]]),
      recheckedKeys: ['acme/web#1'],
    };
    expect(
      reconcileGitHubIssues([retained], [], { ...withWindow, retentionMs: 20_000 }).removals,
    ).toEqual([]);
    expect(
      reconcileGitHubIssues([retained], [], { ...withWindow, retentionMs: 5_000 }).removals[0],
    ).toMatchObject({ reason: 'retention-expired' });
  });

  it('keeps a blocked card whatever the query says, without asking about it', () => {
    const blocked = card({ status: 'blocked', preBlockStatus: 'pending' });
    const result = reconcileGitHubIssues([blocked], [], {
      ...opts,
      rechecked: new Map(),
      recheckedKeys: ['acme/web#1'],
    });
    expect(result.removals).toEqual([]);
  });

  it('applies the removal guard here, where the caller cannot forget it', () => {
    const board = Array.from({ length: 30 }, (_, i) =>
      card({ id: `gh-acme-web-${i + 1}`, externalKey: `acme/web#${i + 1}` }),
    );
    // The query returns 18 of the 30; the other 12 are re-read and all still exist.
    const returned = board.slice(0, 18).map((_t, i) => issue(i + 1));
    const missing = board.slice(18);
    const result = reconcileGitHubIssues(board, returned, {
      ...opts,
      rechecked: new Map(missing.map((t, i) => [t.externalKey as string, issue(19 + i)])),
      recheckedKeys: missing.map((t) => t.externalKey as string),
    });
    expect(result.removals).toEqual([]);
    expect(result.refused).toHaveLength(12);
    expect(result.warning).toMatch(/GitHub cards that GitHub says/);
    expect(result.warning).toMatch(/issue query/);
  });

  it('stands the guard down when the question itself changed', () => {
    const board = Array.from({ length: 30 }, (_, i) =>
      card({ id: `gh-acme-web-${i + 1}`, externalKey: `acme/web#${i + 1}` }),
    );
    const missing = board.slice(18);
    const result = reconcileGitHubIssues(
      board,
      board.slice(0, 18).map((_t, i) => issue(i + 1)),
      {
        ...opts,
        queryChanged: true,
        rechecked: new Map(missing.map((t, i) => [t.externalKey as string, issue(19 + i)])),
        recheckedKeys: missing.map((t) => t.externalKey as string),
      },
    );
    expect(result.removals).toHaveLength(12);
    expect(result.refused).toEqual([]);
  });
});
