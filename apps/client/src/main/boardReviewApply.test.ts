/**
 * `applyBoardReviewItem` against an in-memory fake store: tasks are one array, the review is
 * one row, and every other dep records its calls — so each case proves exactly what one
 * Apply button writes, and that it never reaches for the board-removal archive.
 */
import { describe, expect, it } from 'vitest';
import type { BoardReviewRecord, BoardReviewTicket } from '@shared/boardReview';
import type { Task, TicketInput } from '@shared/model';
import type { LinkResult, LinkRefusal } from '@shared/taskChain';
import type { ArchiveTarget } from '@shared/trackerArchive';
import {
  applyBoardReviewItem,
  DROPPED_EPIC_TITLE,
  type BoardReviewApplyDeps,
  type BoardReviewApplyStore,
} from './boardReviewApply';

const PROJECT = 'proj-1';

function ticket(id: string, fields: Partial<Task> = {}): Task {
  return {
    id,
    projectId: PROJECT,
    title: `Ticket ${id}`,
    status: 'pending',
    source: 'ticket',
    parentTaskId: null,
    variantOf: null,
    ticketKey: id.toUpperCase(),
    externalKey: null,
    externalDescription: `Do ${id}.`,
    epicTaskId: null,
    milestoneId: null,
    issueType: 'task',
    archivedAt: null,
    trackerArchivedAt: null,
    ...fields,
  } as unknown as Task;
}

type Row = Pick<BoardReviewTicket, 'ref' | 'verdict'> & Partial<BoardReviewTicket>;

function harness(rows: Row[], extra: Task[] = [], opts: { refuse?: LinkRefusal } = {}) {
  const tasks: Task[] = [
    ticket('tm-1', { epicTaskId: 'epic-1', milestoneId: 'ms-1' }),
    ticket('tm-2'),
    ticket('tm-3'),
    ticket('epic-1', { issueType: 'epic', title: 'The epic' }),
    ticket('jira-1', { source: 'jira', ticketKey: null, externalKey: 'EE-9' } as Partial<Task>),
    ...extra,
  ];
  let counter = 100;
  let review: BoardReviewRecord = {
    id: 'rev-1',
    projectId: PROJECT,
    status: 'done',
    startedAt: 1,
    finishedAt: 2,
    error: null,
    applied: {},
    report: {
      summary: '',
      hotFiles: [],
      waves: [],
      warnings: [],
      tickets: rows.map((r) => ({
        taskId: r.ref.toLowerCase(),
        reason: 'because',
        evidence: [],
        ...r,
      })),
    },
  };

  const archived: ArchiveTarget[] = [];
  const links: Array<[string, string, string | undefined]> = [];
  const decisions: Array<[string, string | null]> = [];
  const comments: Array<[string, string]> = [];
  const reviewPushes: BoardReviewRecord[] = [];
  const taskPushes: string[] = [];

  const store = {
    getBoardReview: (id: string) => (id === review.id ? review : undefined),
    setBoardReviewApplied: (
      id: string,
      recId: string,
      entry: BoardReviewRecord['applied'][string],
    ) => {
      if (id !== review.id) return undefined;
      review = { ...review, applied: { ...review.applied, [recId]: entry } };
      return review;
    },
    getTask: (id: string) => tasks.find((t) => t.id === id),
    getBoardTasks: (projectId: string) =>
      tasks.filter((t) => t.projectId === projectId && t.archivedAt == null),
    updateTask: (id: string, patch: Partial<Task>) => {
      const i = tasks.findIndex((t) => t.id === id);
      if (i < 0) return undefined;
      tasks[i] = { ...tasks[i], ...patch };
      return tasks[i];
    },
    createTicket: (projectId: string, input: TicketInput) => {
      const n = ++counter;
      const created = ticket(`tm-${n}`, {
        projectId,
        title: input.title,
        externalDescription: input.description ?? null,
        issueType: input.issueType ?? 'task',
        epicTaskId: input.epicTaskId ?? null,
        milestoneId: input.milestoneId ?? null,
      });
      tasks.push(created);
      return created;
    },
    listArchived: (projectId?: string) => ({
      projects: [],
      milestones: [],
      epics: tasks.filter(
        (t) =>
          t.issueType === 'epic' &&
          (projectId === undefined || t.projectId === projectId) &&
          (t as Task & { trackerArchivedAt?: number | null }).trackerArchivedAt != null,
      ),
    }),
    archiveTask: () => {
      throw new Error('archiveTask must never be called by a board review');
    },
  } as unknown as BoardReviewApplyStore;

  const deps: BoardReviewApplyDeps = {
    store,
    setDecision: (taskId, question) => decisions.push([taskId, question]),
    drawLink: (from, to, gate): LinkResult => {
      if (opts.refuse) return { status: 'refused', reason: opts.refuse };
      links.push([from, to, gate]);
      return { status: 'ok', links: [] };
    },
    archiveEpic: async (target) => {
      archived.push(target);
      store.updateTask(target.id, { trackerArchivedAt: 50 } as Partial<Task>);
      return {
        ok: true,
        projectId: PROJECT,
        changedTaskIds: [target.id],
        milestonesChanged: false,
      };
    },
    addComment: (taskId, body) => comments.push([taskId, body]),
    now: () => 99,
    emitReview: (_projectId, r) => reviewPushes.push(r),
    pushTasks: (projectId) => taskPushes.push(projectId),
  };

  const apply = (recId: string) => applyBoardReviewItem(deps, 'rev-1', recId);
  const task = (id: string) => tasks.find((t) => t.id === id)!;
  const dropped = () =>
    tasks.filter(
      (t) =>
        t.title === DROPPED_EPIC_TITLE &&
        (t as Task & { trackerArchivedAt?: number | null }).trackerArchivedAt != null,
    );
  return {
    apply,
    task,
    tasks,
    dropped,
    archived,
    links,
    decisions,
    comments,
    reviewPushes,
    taskPushes,
    review: () => review,
  };
}

describe('applyBoardReviewItem', () => {
  it('REWRITE replaces a native ticket’s title and description', async () => {
    const h = harness([
      { ref: 'TM-2', verdict: 'REWRITE', rewrite: { title: 'Clear', description: 'Better.' } },
    ]);
    const result = await h.apply('TM-2');
    expect(result.ok).toBe(true);
    expect(h.task('tm-2').title).toBe('Clear');
    expect(h.task('tm-2').externalDescription).toBe('Better.');
  });

  it('REWRITE is refused on a non-native card', async () => {
    const h = harness([
      {
        ref: 'EE-9',
        taskId: 'jira-1',
        verdict: 'REWRITE',
        rewrite: { title: 'Clear', description: '' },
      },
    ]);
    const result = await h.apply('EE-9');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not a native ticket/);
    expect(h.task('jira-1').title).toBe('Ticket jira-1');
  });

  it('SPLIT creates the parts under the epic and milestone, chains them, drops the original', async () => {
    const h = harness([
      {
        ref: 'TM-1',
        verdict: 'SPLIT',
        parts: [
          { title: 'A', description: 'a' },
          { title: 'B', description: 'b' },
          { title: 'C', description: 'c' },
        ],
      },
    ]);
    const result = await h.apply('TM-1');
    expect(result.ok).toBe(true);
    const parts = h.tasks.filter((t) => ['A', 'B', 'C'].includes(t.title));
    expect(parts).toHaveLength(3);
    for (const p of parts) {
      expect(p.epicTaskId).toBe('epic-1');
      expect(p.milestoneId).toBe('ms-1');
    }
    expect(h.links).toEqual([
      [parts[0].id, parts[1].id, 'after-merge'],
      [parts[1].id, parts[2].id, 'after-merge'],
    ]);
    expect(h.task('tm-1').epicTaskId).toBe(h.dropped()[0].id);
    expect(h.task('tm-1').archivedAt).toBeNull();
  });

  it('MERGE moves the ticket into Dropped and comments on both', async () => {
    const h = harness([{ ref: 'TM-2', verdict: 'MERGE', mergeInto: 'TM-3' }]);
    const result = await h.apply('TM-2');
    expect(result.ok).toBe(true);
    expect(h.task('tm-2').epicTaskId).toBe(h.dropped()[0].id);
    expect(h.comments.map(([id]) => id)).toEqual(['tm-2', 'tm-3']);
    expect(h.comments[0][1]).toMatch(/Merged by the board review into TM-3/);
  });

  it('DROP creates and archives the Dropped epic once, then reuses the archived one', async () => {
    const h = harness([
      { ref: 'TM-2', verdict: 'DROP' },
      { ref: 'TM-3', verdict: 'DROP' },
    ]);
    expect((await h.apply('TM-2')).ok).toBe(true);
    expect((await h.apply('TM-3')).ok).toBe(true);
    expect(h.archived).toHaveLength(1);
    expect(h.dropped()).toHaveLength(1);
    const epicId = h.dropped()[0].id;
    expect(h.archived[0]).toEqual({ kind: 'epic', id: epicId });
    for (const id of ['tm-2', 'tm-3']) {
      expect(h.task(id).epicTaskId).toBe(epicId);
      expect(h.task(id).archivedAt).toBeNull();
    }
    expect(h.comments).toEqual([
      ['tm-2', 'Dropped by the board review. because'],
      ['tm-3', 'Dropped by the board review. because'],
    ]);
  });

  it('DROP ignores an ACTIVE epic titled Dropped', async () => {
    const active = ticket('active-dropped', { issueType: 'epic', title: DROPPED_EPIC_TITLE });
    const h = harness([{ ref: 'TM-2', verdict: 'DROP' }], [active]);
    expect((await h.apply('TM-2')).ok).toBe(true);
    expect(h.task('tm-2').epicTaskId).not.toBe('active-dropped');
    expect(h.archived).toHaveLength(1);
    expect(h.archived[0].id).not.toBe('active-dropped');
  });

  it('DROP is refused on a non-native card', async () => {
    const h = harness([{ ref: 'EE-9', taskId: 'jira-1', verdict: 'DROP' }]);
    const result = await h.apply('EE-9');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not a native ticket/);
    expect(h.archived).toHaveLength(0);
    expect(h.task('jira-1').epicTaskId).toBeNull();
  });

  it('REORDER draws an arrow from each ticket it runs after', async () => {
    const h = harness([
      { ref: 'TM-3', verdict: 'REORDER', after: ['TM-1', 'TM-2'] },
      { ref: 'TM-1', verdict: 'OK' },
      { ref: 'TM-2', verdict: 'OK' },
    ]);
    const result = await h.apply('TM-3');
    expect(result.ok).toBe(true);
    expect(h.links).toEqual([
      ['tm-1', 'tm-3', 'after-merge'],
      ['tm-2', 'tm-3', 'after-merge'],
    ]);
  });

  it('REORDER reports a cycle refusal', async () => {
    const h = harness([{ ref: 'TM-3', verdict: 'REORDER', after: ['TM-1'] }], [], {
      refuse: 'cycle',
    });
    const result = await h.apply('TM-3');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Refused: TM-1: .*loop/i);
  });

  it('DECIDE marks the ticket with the question', async () => {
    const h = harness([{ ref: 'TM-2', verdict: 'DECIDE', question: 'Which store?' }]);
    expect((await h.apply('TM-2')).ok).toBe(true);
    expect(h.decisions).toEqual([['tm-2', 'Which store?']]);
  });

  it('records the outcome, pushes both events, and refuses a repeat', async () => {
    const h = harness([{ ref: 'TM-2', verdict: 'DECIDE', question: 'Which store?' }]);
    await h.apply('TM-2');
    expect(h.review().applied['TM-2']).toMatchObject({ at: 99, ok: true });
    expect(h.reviewPushes).toHaveLength(1);
    expect(h.taskPushes).toEqual([PROJECT]);
    const again = await h.apply('TM-2');
    expect(again).toEqual({ ok: false, message: 'TM-2 was already applied.' });
    expect(h.decisions).toHaveLength(1);
  });

  it('refuses a ticket that is no longer on the board', async () => {
    const h = harness([{ ref: 'TM-9', verdict: 'DROP' }]);
    const result = await h.apply('TM-9');
    expect(result).toEqual({ ok: false, message: 'TM-9 is no longer on the board.' });
    expect(h.archived).toHaveLength(0);
  });

  it('refuses an OK ticket and an unknown review', async () => {
    const h = harness([{ ref: 'TM-2', verdict: 'OK' }]);
    expect((await h.apply('TM-2')).ok).toBe(false);
    const deps = { store: { getBoardReview: () => undefined } } as unknown as BoardReviewApplyDeps;
    expect(await applyBoardReviewItem(deps, 'nope', 'TM-2')).toEqual({
      ok: false,
      message: 'That review no longer exists.',
    });
  });
});
