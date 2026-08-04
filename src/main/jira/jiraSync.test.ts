import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@shared/model';
import {
  guardRemovals,
  issueToBoardTask,
  reconcileJiraTasks,
  removalCandidateKeys,
  retainedKeys,
  type JiraRemoval,
} from './jiraSync';
import type { JiraIssue } from './jiraClient';

const issue = (
  id: string,
  key: string,
  categoryKey: string,
  summary = 'Do a thing',
): JiraIssue => ({
  id,
  key,
  fields: {
    summary,
    status: {
      name: categoryKey === 'indeterminate' ? 'In Progress' : 'To Do',
      statusCategory: { key: categoryKey, name: 'X' },
    },
    priority: { name: 'High' },
    project: { key: 'PROJ', name: 'proj-name' },
  },
});

const jiraTask = (over: Partial<Task>): Task => ({
  id: 'jira-1',
  projectId: PERSONAL_PROJECT_ID,
  phase: 'proj-name',
  title: 'Do a thing',
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'jira',
  isContract: false,
  isScaffold: false,
  externalSource: 'jira',
  externalKey: 'PROJ-1',
  externalId: '1',
  ...over,
});

const opts = { baseUrl: 'https://jira.co' };

/**
 * The confirm pass having asked about these keys and been told **none of them still match**
 * — the only thing that makes a card leaving the query removable at all.
 */
const asked = (...keys: string[]) => ({ queryChecked: keys, queryMatches: [] as string[] });

/** The ids a result would take off the board, in order. */
const removedIds = (r: { removals: JiraRemoval[] }): string[] => r.removals.map((x) => x.taskId);

describe('issueToBoardTask — a ticket raised for a card that already exists', () => {
  /** The card the Add-task dialog wrote locally a moment ago, before the ticket existed. */
  const localCard = (over: Partial<Task> = {}): Task =>
    ({
      id: 'local-1',
      projectId: PERSONAL_PROJECT_ID,
      phase: '',
      title: 'Do a thing',
      status: 'pending',
      sessionId: null,
      order: 7,
      dependsOn: [],
      source: 'adhoc',
      isContract: false,
      isScaffold: false,
      type: 'feature',
      projectTagId: 'p-billing',
      externalDescription: 'What it is about.',
      ...over,
    }) as Task;

  it('lands the issue on that card rather than making a second one', () => {
    const card = issueToBoardTask(issue('1', 'PROJ-1', 'new'), localCard(), opts);
    expect(card.id).toBe('local-1');
    expect(card.order).toBe(7);
    expect(card.source).toBe('jira');
    expect(card.externalKey).toBe('PROJ-1');
    expect(card.externalUrl).toBe('https://jira.co/browse/PROJ-1');
  });

  it('keeps the filing, which JIRA knows nothing about', () => {
    const card = issueToBoardTask(issue('1', 'PROJ-1', 'new'), localCard(), opts);
    expect(card.projectTagId).toBe('p-billing');
  });

  it('starts the card read, so raising a ticket does not light up its own border', () => {
    const card = issueToBoardTask(issue('1', 'PROJ-1', 'new'), localCard(), opts);
    expect(card.lastReadCommentAt).toBe(card.latestCommentAt);
  });

  it('brings a card of its own when nothing is adopted', () => {
    const card = issueToBoardTask(issue('1', 'PROJ-1', 'new'), undefined, opts);
    expect(card.id).toBe('jira-1');
    expect(card.projectTagId).toBeNull();
  });
});

describe('reconcileJiraTasks — epic name', () => {
  /** An issue whose parent came back inline, the way Cloud team-managed projects send it. */
  const withParent = (summary?: string): JiraIssue => {
    const base = issue('1', 'PROJ-1', 'new');
    return {
      ...base,
      fields: {
        ...base.fields,
        parent: { key: 'PROJ-100', ...(summary ? { fields: { summary } } : {}) },
      },
    };
  };

  it('takes the epic name straight off an inline parent — no lookup needed', () => {
    const { upserts } = reconcileJiraTasks([], [withParent('Checkout rework')], opts);
    expect(upserts[0].externalEpicName).toBe('Checkout rework');
    expect(upserts[0].externalParentKey).toBe('PROJ-100');
  });

  it('falls back to the batch for an Epic Link field, which carries only a key', () => {
    const { upserts } = reconcileJiraTasks([], [withParent()], {
      ...opts,
      epicNames: new Map([['PROJ-100', 'Checkout rework']]),
    });
    expect(upserts[0].externalEpicName).toBe('Checkout rework');
  });

  it('leaves the name null when nothing supplies one, rather than echoing the key', () => {
    // The card decides what to show without a name; a key masquerading as one would be
    // worse than an absent one.
    const { upserts } = reconcileJiraTasks([], [withParent()], opts);
    expect(upserts[0].externalEpicName).toBeNull();
    expect(upserts[0].externalParentKey).toBe('PROJ-100');
  });

  it('keeps a known name when a sync could not resolve one', () => {
    // Same fall-back rule as every other field here: a sync that did not return the
    // information must not wipe what we already knew.
    const existing = jiraTask({ externalEpicName: 'Checkout rework' });
    const { upserts } = reconcileJiraTasks([existing], [withParent()], opts);
    expect(upserts[0].externalEpicName).toBe('Checkout rework');
  });
});

describe('reconcileJiraTasks — sprint', () => {
  const withSprint = (sprint: unknown): JiraIssue => {
    const i = issue('1', 'PROJ-1', 'new');
    (i.fields as Record<string, unknown>).customfield_7 = sprint;
    return i;
  };

  it('carries the running sprint name onto the card', () => {
    const { upserts } = reconcileJiraTasks(
      [],
      [withSprint([{ name: 'Sprint 5', state: 'active' }])],
      {
        ...opts,
        sprintFieldId: 'customfield_7',
      },
    );
    expect(upserts[0].externalSprint).toBe('Sprint 5');
  });

  it('leaves the sprint null when the instance has no such field', () => {
    const { upserts } = reconcileJiraTasks([], [issue('1', 'PROJ-1', 'new')], opts);
    expect(upserts[0].externalSprint ?? null).toBeNull();
  });

  // Same rule as the epic and description: a sync that didn't ask for the field must
  // not wipe a name we already knew.
  it('keeps a previously known sprint when this sync did not return one', () => {
    const existing = jiraTask({ externalSprint: 'Sprint 5' });
    const { upserts } = reconcileJiraTasks([existing], [issue('1', 'PROJ-1', 'new')], opts);
    expect(upserts[0].externalSprint).toBe('Sprint 5');
  });
});

describe('reconcileJiraTasks', () => {
  it('creates a new task for a fetched issue with a stable id and deep link', () => {
    const { upserts, removals } = reconcileJiraTasks([], [issue('1', 'PROJ-1', 'new')], opts);
    expect(removals).toEqual([]);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      id: 'jira-1',
      source: 'jira',
      externalKey: 'PROJ-1',
      externalUrl: 'https://jira.co/browse/PROJ-1',
      externalStatusCategory: 'To Do',
      status: 'pending',
      phase: 'proj-name',
    });
  });

  it('maps In Progress category to in-progress status', () => {
    const { upserts } = reconcileJiraTasks([], [issue('1', 'PROJ-1', 'indeterminate')], opts);
    expect(upserts[0].status).toBe('in-progress');
    expect(upserts[0].externalStatusCategory).toBe('In Progress');
  });

  it('preserves the blocked state and preBlockStatus across a re-sync', () => {
    const existing = jiraTask({ status: 'blocked', preBlockStatus: 'in-progress' });
    // JIRA now reports the issue as In Progress, but the user blocked it locally.
    const { upserts } = reconcileJiraTasks(
      existing ? [existing] : [],
      [issue('1', 'PROJ-1', 'indeterminate')],
      opts,
    );
    expect(upserts[0].status).toBe('blocked');
    expect(upserts[0].preBlockStatus).toBe('in-progress');
    // The raw external status is still refreshed for display.
    expect(upserts[0].externalStatusCategory).toBe('In Progress');
  });

  it('does not evict a live run from `status` — it re-aims where the run will land', () => {
    // A poll landing mid-session used to overwrite `running` with the tracker's status,
    // which dropped the card out of the run: no spinner, no drag guard, no chat target.
    const existing = jiraTask({ status: 'running', preRunStatus: 'pending' });
    const { upserts } = reconcileJiraTasks(
      [existing],
      [issue('1', 'PROJ-1', 'indeterminate')],
      opts,
    );
    expect(upserts[0].status).toBe('running');
    // JIRA still owns the COLUMN: someone moved the ticket to In Progress while the agent
    // worked, so that is where the card comes to rest when the run ends.
    expect(upserts[0].preRunStatus).toBe('in-progress');
  });

  it('keeps a blocked card blocked while its agent runs', () => {
    const existing = jiraTask({
      status: 'running',
      preRunStatus: 'blocked',
      preBlockStatus: 'pending',
    });
    const { upserts } = reconcileJiraTasks(
      [existing],
      [issue('1', 'PROJ-1', 'indeterminate')],
      opts,
    );
    expect(upserts[0].status).toBe('running');
    expect(upserts[0].preRunStatus).toBe('blocked');
    expect(upserts[0].preBlockStatus).toBe('pending');
  });

  it('does NOT delete a blocked task whose agent is running when it leaves the JQL', () => {
    const existing = jiraTask({ status: 'running', preRunStatus: 'blocked' });
    const result = reconcileJiraTasks([existing], [], { ...opts, ...asked('PROJ-1') });
    expect(result.removals).toEqual([]);
  });

  it('keeps the task id (and thus history) stable for an existing issue', () => {
    const existing = jiraTask({ id: 'jira-1', lastReadCommentAt: 555 });
    const { upserts } = reconcileJiraTasks([existing], [issue('1', 'PROJ-1', 'new')], opts);
    expect(upserts[0].id).toBe('jira-1');
    expect(upserts[0].lastReadCommentAt).toBe(555);
  });

  it('removes a JIRA task JIRA has confirmed no longer matches the query', () => {
    const existing = jiraTask({ status: 'in-progress' });
    const result = reconcileJiraTasks([existing], [], { ...opts, ...asked('PROJ-1') });
    expect(result.upserts).toEqual([]);
    expect(result.removals).toEqual([
      { taskId: 'jira-1', key: 'PROJ-1', title: 'Do a thing', reason: 'left-query' },
    ]);
  });

  it('does NOT delete a blocked task missing from the JQL result', () => {
    const existing = jiraTask({ status: 'blocked' });
    const result = reconcileJiraTasks([existing], [], { ...opts, ...asked('PROJ-1') });
    expect(result.removals).toEqual([]);
  });

  it('maps the epic custom field and description onto the task', () => {
    const withEpic = issue('1', 'PROJ-1', 'new');
    (withEpic.fields as Record<string, unknown>).customfield_7 = 'abc-100';
    withEpic.fields.description = 'Reproduce, then fix.';

    const { upserts } = reconcileJiraTasks([], [withEpic], {
      ...opts,
      epicFieldId: 'customfield_7',
    });
    expect(upserts[0]).toMatchObject({
      externalParentKey: 'ABC-100',
      externalDescription: 'Reproduce, then fix.',
    });
  });

  it('falls back to `parent` and flattens a v3 ADF description', () => {
    const cloudIssue = issue('1', 'PROJ-1', 'new');
    cloudIssue.fields.parent = { key: 'ABC-9' };
    cloudIssue.fields.description = {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ship it.' }] }],
    };

    const { upserts } = reconcileJiraTasks([], [cloudIssue], opts);
    expect(upserts[0].externalParentKey).toBe('ABC-9');
    expect(upserts[0].externalDescription).toBe('Ship it.');
  });

  it('keeps a known epic key/description when a sync returns neither', () => {
    const existing = jiraTask({
      externalParentKey: 'ABC-100',
      externalDescription: 'Old brief.',
    });
    const { upserts } = reconcileJiraTasks([existing], [issue('1', 'PROJ-1', 'new')], opts);
    expect(upserts[0].externalParentKey).toBe('ABC-100');
    expect(upserts[0].externalDescription).toBe('Old brief.');
  });

  it('carries an agent assignment through a re-sync (JIRA knows nothing about it)', () => {
    const existing = jiraTask({ agentProjectId: 'agent-1' });
    const { upserts } = reconcileJiraTasks(
      [existing],
      [issue('1', 'PROJ-1', 'indeterminate')],
      opts,
    );
    expect(upserts[0].agentProjectId).toBe('agent-1');
  });

  // JIRA files every review-ish status under `indeterminate` alongside the one that
  // means "being written", so the status-name map is the only route to IN REVIEW.
  it('lands a mapped status in In Review', () => {
    const review = issue('1', 'PROJ-1', 'indeterminate');
    review.fields.status.name = 'Code Review';
    const { upserts } = reconcileJiraTasks([], [review], {
      ...opts,
      overrides: { 'code review': 'in-review' },
    });
    expect(upserts[0].status).toBe('in-review');
    expect(upserts[0].externalStatus).toBe('Code Review');
  });

  // The regression that made a drag into IN REVIEW pointless: the outgoing transition
  // was picked by the status NAME while the incoming sync read the same status by its
  // CATEGORY, so the card came straight back to IN PROGRESS. Both sides now resolve
  // through `resolveStatusColumn`, so no configuration is needed for this to hold.
  it('lands an unmapped review-ish status in In Review', () => {
    const review = issue('1', 'PROJ-1', 'indeterminate');
    review.fields.status.name = 'Code Review';
    const { upserts } = reconcileJiraTasks([], [review], opts);
    expect(upserts[0].status).toBe('in-review');
  });

  it('lands a learned status in the column the user dragged it to', () => {
    const qa = issue('1', 'PROJ-1', 'indeterminate');
    qa.fields.status.name = 'QA';
    const { upserts } = reconcileJiraTasks([], [qa], {
      ...opts,
      learned: { QA: 'in-review' },
    });
    expect(upserts[0].status).toBe('in-review');
  });

  it('lets the user map beat what was learned', () => {
    const qa = issue('1', 'PROJ-1', 'indeterminate');
    qa.fields.status.name = 'QA';
    const { upserts } = reconcileJiraTasks([], [qa], {
      ...opts,
      overrides: { QA: 'in-progress' },
      learned: { QA: 'in-review' },
    });
    expect(upserts[0].status).toBe('in-progress');
  });

  it('still lands a plain in-progress status by category', () => {
    const { upserts } = reconcileJiraTasks([], [issue('1', 'PROJ-1', 'indeterminate')], opts);
    expect(upserts[0].status).toBe('in-progress');
  });

  it('never touches ad-hoc internal tasks', () => {
    const adhoc: Task = jiraTask({
      id: 'adhoc-1',
      source: 'adhoc',
      externalSource: null,
      externalKey: null,
      externalId: null,
    });
    const { upserts, removals } = reconcileJiraTasks([adhoc], [], opts);
    expect(upserts).toEqual([]);
    expect(removals).toEqual([]);
  });
});

describe('reconcileJiraTasks — whose comment raises the unread border', () => {
  const ME = { accountId: 'acc-me', displayName: 'Wojciech', baseUrl: 'https://jira.co' };

  /** An issue carrying comments, newest last. */
  const withComments = (
    comments: Array<{ created: string; accountId?: string; displayName?: string }>,
  ): JiraIssue => {
    const i = issue('1', 'PROJ-1', 'indeterminate');
    i.fields.comment = {
      comments: comments.map((c, n) => ({
        id: String(n),
        created: c.created,
        author: { accountId: c.accountId, displayName: c.displayName },
        body: 'hi',
      })),
    };
    return i;
  };

  /**
   * An existing card with nothing unread on it. `latestCommentAt` is null because no
   * foreign comment has ever landed — which is the state the fix has to preserve.
   */
  const read = (): Task => jiraTask({ lastReadCommentAt: 1, latestCommentAt: null });

  it('ignores my own comment — answering in the JIRA web UI must not light my card', () => {
    const issues = [withComments([{ created: '2026-07-20T10:00:00.000Z', accountId: 'acc-me' }])];
    const { upserts } = reconcileJiraTasks([read()], issues, { ...opts, identity: ME });
    expect(upserts[0].latestCommentAt).toBeNull();
  });

  it('raises it for someone else, even with a newer comment of mine on top', () => {
    const issues = [
      withComments([
        { created: '2026-07-20T10:00:00.000Z', accountId: 'acc-them', displayName: 'Ada' },
        { created: '2026-07-20T11:00:00.000Z', accountId: 'acc-me' },
      ]),
    ];
    const { upserts } = reconcileJiraTasks([read()], issues, { ...opts, identity: ME });
    expect(upserts[0].latestCommentAt).toBe(Date.parse('2026-07-20T10:00:00.000Z'));
  });

  it('matches on display name when the instance has no accountIds (Server/DC)', () => {
    const server = { accountId: null, displayName: 'Wojciech', baseUrl: 'https://jira.co' };
    const issues = [
      withComments([{ created: '2026-07-20T10:00:00.000Z', displayName: 'Wojciech' }]),
    ];
    const { upserts } = reconcileJiraTasks([read()], issues, { ...opts, identity: server });
    expect(upserts[0].latestCommentAt).toBeNull();
  });

  it('counts every comment when the identity is unknown (legacy behaviour)', () => {
    const issues = [withComments([{ created: '2026-07-20T10:00:00.000Z', accountId: 'acc-me' }])];
    const { upserts } = reconcileJiraTasks([read()], issues, opts);
    expect(upserts[0].latestCommentAt).toBe(Date.parse('2026-07-20T10:00:00.000Z'));
  });

  it('starts a brand-new card read, however many comments it arrives with', () => {
    const issues = [withComments([{ created: '2026-07-20T10:00:00.000Z', accountId: 'acc-them' }])];
    const { upserts } = reconcileJiraTasks([], issues, { ...opts, identity: ME });
    expect(upserts[0].lastReadCommentAt).toBe(upserts[0].latestCommentAt);
  });
});

describe('retainedKeys / reconcileJiraTasks — a finished card outlives the query', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.parse('2026-07-31T12:00:00.000Z');
  /** Two weeks, the shipped default. */
  const KEEP = { now: NOW, retentionMs: 14 * DAY };

  /** A card the human has finished, which is why its issue no longer matches the JQL. */
  const doneCard = (over: Partial<Task> = {}): Task =>
    jiraTask({ status: 'done', externalKey: 'PROJ-1', ...over });

  /** The same issue, read back BY KEY — the only way the board can still see it. */
  const doneIssue = issue('1', 'PROJ-1', 'done');
  const reopened = issue('1', 'PROJ-1', 'indeterminate');

  it('asks for the finished cards the query dropped, and for nothing else', () => {
    const stale = jiraTask({ id: 'jira-2', status: 'pending', externalKey: 'PROJ-2' });
    expect(retainedKeys([doneCard(), stale], [])).toEqual(['PROJ-1']);
  });

  it('never asks about a card the query still returns', () => {
    expect(retainedKeys([doneCard()], [doneIssue])).toEqual([]);
  });

  it('keeps asking once a retained card has been reopened — the clock, not the status', () => {
    // Without this the very sync that discovered the ticket was alive again would stop
    // looking at it, and the card would be retired by the next one.
    const card = doneCard({ status: 'in-progress', retainedSince: NOW - DAY });
    expect(retainedKeys([card], [])).toEqual(['PROJ-1']);
  });

  it('leaves a blocked card alone, however finished it looks', () => {
    expect(retainedKeys([doneCard({ status: 'blocked' })], [])).toEqual([]);
  });

  it('keeps the card in DONE instead of deleting it out of the column it was dropped in', () => {
    const result = reconcileJiraTasks([doneCard()], [], {
      ...opts,
      ...KEEP,
      rechecked: [doneIssue],
    });
    expect(result.removals).toEqual([]);
    expect(result.upserts[0].status).toBe('done');
    expect(result.upserts[0].retainedSince).toBe(NOW);
  });

  it('follows the ticket back OUT of Done when JIRA moves it, query or no query', () => {
    // The whole point of the by-key re-read: `resolution = Unresolved` never matches this
    // issue again if the workflow did not clear the resolution, so the query alone would
    // leave the card frozen in DONE for ever.
    const result = reconcileJiraTasks([doneCard({ retainedSince: NOW - DAY })], [], {
      ...opts,
      ...KEEP,
      rechecked: [reopened],
    });
    expect(result.removals).toEqual([]);
    expect(result.upserts[0].status).toBe('in-progress');
    // The clock keeps running from when it started, not from this sync.
    expect(result.upserts[0].retainedSince).toBe(NOW - DAY);
  });

  it('retires a card JIRA no longer returns at all', () => {
    const result = reconcileJiraTasks([doneCard()], [], {
      ...opts,
      ...KEEP,
      rechecked: [],
    });
    expect(removedIds(result)).toEqual(['jira-1']);
    expect(result.removals[0].reason).toBe('gone-from-jira');
    expect(result.upserts).toEqual([]);
  });

  it('retires a card that has been retained longer than the window', () => {
    const result = reconcileJiraTasks([doneCard({ retainedSince: NOW - 15 * DAY })], [], {
      ...opts,
      ...KEEP,
      rechecked: [doneIssue],
    });
    expect(removedIds(result)).toEqual(['jira-1']);
    expect(result.removals[0].reason).toBe('retention-expired');
  });

  it('keeps every retained card when the re-read could not run', () => {
    // A network blip must not empty the Done column: `rechecked: null` is "nobody asked",
    // which is a different answer from "JIRA says it is gone".
    const result = reconcileJiraTasks([doneCard({ retainedSince: NOW })], [], {
      ...opts,
      ...KEEP,
      rechecked: null,
    });
    expect(result.removals).toEqual([]);
    expect(result.upserts).toEqual([]);
  });

  it('still removes an unfinished card, once JIRA has confirmed it left the query', () => {
    const result = reconcileJiraTasks([jiraTask({ status: 'pending' })], [], {
      ...opts,
      ...KEEP,
      ...asked('PROJ-1'),
      rechecked: [],
    });
    expect(removedIds(result)).toEqual(['jira-1']);
    expect(result.removals[0].reason).toBe('left-query');
  });

  it('clears the retention marker the moment the query returns the issue again', () => {
    const { upserts } = reconcileJiraTasks([doneCard({ retainedSince: NOW - DAY })], [reopened], {
      ...opts,
      ...KEEP,
    });
    expect(upserts[0].retainedSince).toBeNull();
  });

  it('with a retention of zero, behaves exactly as it did before retention existed', () => {
    const result = reconcileJiraTasks([doneCard()], [], { ...opts, rechecked: [doneIssue] });
    expect(removedIds(result)).toEqual(['jira-1']);
  });
});

describe('a card the human closed without finishing it', () => {
  // The DONE column holds four statuses, and the retention rule only ever knew one of them.
  // So the poll deleted the card you had just decided not to do — out of the column you had
  // just dropped it in. Read off the column now, so the two cannot drift apart again.
  for (const status of ['cancelled', 'stopped', 'failed'] as const) {
    it(`survives the query dropping a ${status} card, and is asked about by key`, () => {
      const card = jiraTask({ status });
      expect(retainedKeys([card], [])).toEqual(['PROJ-1']);
      // ...and it is NOT a removal candidate: retention, not the confirm pass, holds it.
      expect(removalCandidateKeys([card], [])).toEqual([]);
      const result = reconcileJiraTasks([card], [], {
        ...opts,
        ...asked('PROJ-1'),
        now: 1_000,
        retentionMs: 14 * 24 * 60 * 60 * 1000,
        rechecked: [issue('1', 'PROJ-1', 'done')],
      });
      expect(result.removals).toEqual([]);
      expect(result.upserts[0].id).toBe('jira-1');
    });
  }
});

describe('removalCandidateKeys — what the confirm pass has to ask about', () => {
  it('asks about the cards the query dropped, and nothing else', () => {
    const dropped = jiraTask({ id: 'jira-2', externalKey: 'PROJ-2', externalId: '2' });
    const returned = jiraTask({ externalKey: 'PROJ-1' });
    const keys = removalCandidateKeys([returned, dropped], [issue('1', 'PROJ-1', 'new')]);
    expect(keys).toEqual(['PROJ-2']);
  });

  it('never asks about a blocked, archived or ad-hoc card', () => {
    const blocked = jiraTask({ id: 'jira-2', externalKey: 'PROJ-2', status: 'blocked' });
    const archived = jiraTask({ id: 'jira-3', externalKey: 'PROJ-3', archivedAt: 5 });
    const adhoc = jiraTask({ id: 'a-1', source: 'adhoc', externalKey: null, externalSource: null });
    expect(removalCandidateKeys([blocked, archived, adhoc], [])).toEqual([]);
  });
});

describe('reconcileJiraTasks — no card leaves without JIRA answering about it', () => {
  /** `n` ordinary TO DO cards, `PROJ-1`…`PROJ-n`. */
  const board = (n: number): Task[] =>
    Array.from({ length: n }, (_, i) =>
      jiraTask({
        id: `jira-${i + 1}`,
        externalId: String(i + 1),
        externalKey: `PROJ-${i + 1}`,
        status: 'pending',
      }),
    );

  /** The query's answer, for the given keys. */
  const returned = (keys: string[]): JiraIssue[] =>
    keys.map((k) => issue(k.split('-')[1], k, 'new'));

  it('removes nothing when the confirm pass never ran, however many left the query', () => {
    // The whole defect in one assertion: absence from a paged search is not evidence.
    const result = reconcileJiraTasks(board(10), returned(['PROJ-1']), {
      ...opts,
      queryChecked: null,
    });
    expect(result.removals).toEqual([]);
    expect(result.refused).toEqual([]);
  });

  it('removes a card the confirm pass asked about and JIRA said no longer matches', () => {
    const result = reconcileJiraTasks(board(4), returned(['PROJ-1', 'PROJ-2', 'PROJ-3']), {
      ...opts,
      queryChecked: ['PROJ-4'],
      queryMatches: [],
    });
    expect(result.removals).toEqual([
      { taskId: 'jira-4', key: 'PROJ-4', title: 'Do a thing', reason: 'left-query' },
    ]);
  });

  it('KEEPS a card the search left out that the query still returns — the paging artifact', () => {
    // The case that was eating the board: the card never stopped matching, the answer was
    // just short. Counted in the warning, because that count is what names the cause.
    const result = reconcileJiraTasks(board(4), returned(['PROJ-1', 'PROJ-2']), {
      ...opts,
      queryChecked: ['PROJ-3', 'PROJ-4'],
      queryMatches: ['PROJ-3', 'PROJ-4'],
    });
    expect(result.removals).toEqual([]);
    expect(result.warning).toMatch(/2 cards missing from the search still match the query/);
    expect(result.warning).toMatch(/paging artifact/);
  });

  it('keeps a candidate whose confirm batch failed — one dead key 400s the fifty with it', () => {
    const result = reconcileJiraTasks(board(3), returned(['PROJ-1']), {
      ...opts,
      // Only PROJ-2's batch came back. PROJ-3 was never answered for.
      queryChecked: ['PROJ-2'],
      queryMatches: [],
    });
    expect(removedIds(result)).toEqual(['jira-2']);
  });

  it('removes nothing at all when the search was truncated', () => {
    const result = reconcileJiraTasks(board(4), returned(['PROJ-1']), {
      ...opts,
      queryChecked: ['PROJ-2', 'PROJ-3', 'PROJ-4'],
      queryMatches: [],
      truncated: true,
    });
    expect(result.removals).toEqual([]);
    expect(result.warning).toMatch(/did not return the whole query/);
  });

  it('keeps a retained card whose by-key batch failed, even though `rechecked` came back', () => {
    // Regression lock: `rechecked` is per-batch, so a key whose chunk errored is missing
    // from it for a reason that has nothing to do with JIRA having lost the issue.
    const done = jiraTask({ status: 'done', externalKey: 'PROJ-9', id: 'jira-9' });
    const result = reconcileJiraTasks([done], [], {
      ...opts,
      now: 1_000,
      retentionMs: 14 * 24 * 60 * 60 * 1000,
      rechecked: [], // the other chunk answered; PROJ-9's did not
      recheckedKeys: [],
    });
    expect(result.removals).toEqual([]);

    // ...and with the key actually asked for, the same empty answer DOES retire it.
    const answered = reconcileJiraTasks([done], [], {
      ...opts,
      now: 1_000,
      retentionMs: 14 * 24 * 60 * 60 * 1000,
      rechecked: [],
      recheckedKeys: ['PROJ-9'],
    });
    expect(answered.removals[0]).toMatchObject({ taskId: 'jira-9', reason: 'gone-from-jira' });
  });
});

describe('reconcileJiraTasks — a card comes back', () => {
  it('restores an archived card whose issue is in the query again, on the same row', () => {
    const archived = jiraTask({
      archivedAt: 1_700,
      projectTagId: 'p-billing',
      agentProjectId: 'agent-1',
      lastReadCommentAt: 555,
    });
    const result = reconcileJiraTasks([archived], [issue('1', 'PROJ-1', 'indeterminate')], opts);
    expect(result.restoreIds).toEqual(['jira-1']);
    expect(result.upserts).toHaveLength(1);
    // The same row, with everything JIRA has never heard of still on it.
    expect(result.upserts[0]).toMatchObject({
      id: 'jira-1',
      projectTagId: 'p-billing',
      agentProjectId: 'agent-1',
      lastReadCommentAt: 555,
      status: 'in-progress',
    });
  });

  it('says nothing about an archived card the query still does not return', () => {
    const archived = jiraTask({ archivedAt: 1_700 });
    const result = reconcileJiraTasks([archived], [], { ...opts, ...asked('PROJ-1') });
    expect(result).toMatchObject({ upserts: [], removals: [], restoreIds: [], refused: [] });
  });
});

describe('guardRemovals — a bound on how wrong one sync may be', () => {
  const removal = (n: number): JiraRemoval => ({
    taskId: `jira-${n}`,
    key: `PROJ-${n}`,
    title: 'Do a thing',
    reason: 'left-query',
  });
  const many = (n: number): JiraRemoval[] => Array.from({ length: n }, (_, i) => removal(i + 1));

  it('refuses 12 removals off a 30-card board — all of them, not some', () => {
    const guarded = guardRemovals(many(12), 30);
    expect(guarded.removals).toEqual([]);
    expect(guarded.refused).toHaveLength(12);
    expect(guarded.warning).toMatch(/more than 25% of the board/);
  });

  it('stands down when the question itself changed — a sprint roll is meant to empty it', () => {
    const guarded = guardRemovals(many(12), 30, { queryChanged: true });
    expect(guarded.removals).toHaveLength(12);
    expect(guarded.refused).toEqual([]);
    expect(guarded.warning).toBeNull();
  });

  it('lets 2 off a 4-card board through — on a small board every removal is a big share', () => {
    const guarded = guardRemovals(many(2), 4);
    expect(guarded.removals).toHaveLength(2);
    expect(guarded.warning).toBeNull();
  });

  it('is applied inside the reconciler, where the caller cannot forget it', () => {
    const board = Array.from({ length: 30 }, (_, i) =>
      jiraTask({
        id: `jira-${i + 1}`,
        externalId: String(i + 1),
        externalKey: `PROJ-${i + 1}`,
        status: 'pending',
      }),
    );
    const issues = board
      .slice(0, 18)
      .map((t) => issue(t.externalId as string, t.externalKey as string, 'new'));
    const dropped = board.slice(18).map((t) => t.externalKey as string);

    const refused = reconcileJiraTasks(board, issues, {
      ...opts,
      queryChecked: dropped,
      queryMatches: [],
    });
    expect(refused.removals).toEqual([]);
    expect(refused.refused).toHaveLength(12);
    expect(refused.warning).toMatch(/Nothing was removed/);

    // The same sync, after the human changed the JQL: the turnover is the point.
    const allowed = reconcileJiraTasks(board, issues, {
      ...opts,
      queryChecked: dropped,
      queryMatches: [],
      queryChanged: true,
    });
    expect(allowed.removals).toHaveLength(12);
    expect(allowed.refused).toEqual([]);
  });
});
