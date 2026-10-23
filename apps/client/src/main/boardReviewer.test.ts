/**
 * `createBoardReviewer` against fake deps: the store is a handful of arrays and one map of
 * review rows, and the session is a handle the test answers by hand — so each case proves
 * what the reviewer does with a result, not what a real CLI happens to say.
 */
import { describe, expect, it } from 'vitest';
import type { BoardReviewRecord } from '@shared/boardReview';
import type { Milestone, Project, Task, TicketLink } from '@shared/model';
import type { StartSessionRequest } from '@shared/session';
import type { TaskLink } from '@shared/taskChain';
import {
  BOARD_REVIEW_NO_PROJECT,
  BOARD_REVIEW_NO_REPO,
  BOARD_REVIEW_NO_RESULT,
  BOARD_REVIEW_NOT_STARTED,
  BOARD_REVIEW_STOPPED,
  createBoardReviewer,
  type BoardReviewerStore,
} from './boardReviewer';
import { AI_REVIEW_DISALLOWED_TOOLS } from './forge/aiVisualReviewer';

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
    ...fields,
  } as unknown as Task;
}

interface Session {
  projectId: string;
  request: StartSessionRequest;
  runId: string;
  onResult(text: string): void;
  onExit(): void;
}

function report(refs: Array<{ ref: string; verdict: string }>): string {
  return [
    'Read the code.',
    '',
    '```json',
    JSON.stringify({
      summary: 'Two tickets.',
      tickets: refs.map((r) => ({ ...r, reason: 'because', evidence: ['src/a.ts:1 — x'] })),
      hotFiles: [],
      waves: [{ refs: refs.map((r) => r.ref), note: '' }],
    }),
    '```',
  ].join('\n');
}

function harness(opts: { project?: Partial<Project> | null; runId?: string } = {}) {
  let clock = 1_000;
  const project =
    opts.project === null
      ? undefined
      : ({
          id: PROJECT,
          name: 'Fixture',
          path: 'C:/repo',
          defaultModel: 'sonnet',
          planningModel: 'opus',
          readyLanes: 2,
          ...opts.project,
        } as unknown as Project);

  const tasks: Task[] = [
    ticket('tm-1'),
    ticket('tm-2', { status: 'in-progress', epicTaskId: 'epic-1', milestoneId: 'ms-1' }),
    ticket('tm-3', { status: 'done', stoppedAt: 5 } as Partial<Task>),
    ticket('epic-1', { issueType: 'epic', title: 'The epic' }),
    ticket('step-1', { parentTaskId: 'tm-1' }),
  ];
  const milestones = [{ id: 'ms-1', name: 'M1', projectId: PROJECT }] as unknown as Milestone[];
  const taskLinks = [
    { id: 'l1', fromTaskId: 'tm-1', toTaskId: 'tm-2', gate: 'after-merge', createdAt: 0 },
    { id: 'l2', fromTaskId: 'other-a', toTaskId: 'other-b', gate: 'after-merge', createdAt: 0 },
  ] as unknown as TaskLink[];
  const ticketLinks = [
    { id: 't1', fromTaskId: 'tm-2', toTaskId: 'tm-1', type: 'relates', createdAt: 0 },
  ] as unknown as TicketLink[];

  const rows = new Map<string, BoardReviewRecord>();
  let nextId = 0;
  const store: BoardReviewerStore = {
    getProject: (id) => (id === PROJECT ? project : undefined),
    getBoardTasks: () => tasks,
    listMilestones: () => milestones,
    listTaskLinks: () => taskLinks,
    listTicketLinks: () => ticketLinks,
    startBoardReview: (projectId, at) => {
      const row: BoardReviewRecord = {
        id: `rev-${++nextId}`,
        projectId,
        status: 'running',
        startedAt: at,
        finishedAt: null,
        report: null,
        error: null,
        applied: {},
      };
      rows.set(row.id, row);
      return { ...row };
    },
    finishBoardReview: (id, outcome) => {
      const row = rows.get(id);
      if (!row) return undefined;
      if (row.status === 'running') {
        row.status = outcome.status;
        row.report = outcome.report ?? null;
        row.error = outcome.error ?? null;
        row.finishedAt = outcome.finishedAt;
      }
      return { ...row };
    },
  };

  const sessions: Session[] = [];
  const stopped: string[] = [];
  const emitted: Array<{ projectId: string; review: BoardReviewRecord }> = [];
  const reviewer = createBoardReviewer({
    store,
    startSession: (projectId, request, onResult, onExit) => {
      const runId = opts.runId ?? `run-${sessions.length + 1}`;
      sessions.push({ projectId, request, runId, onResult, onExit: () => onExit?.() });
      return { runId };
    },
    stopSession: (runId) => stopped.push(runId),
    now: () => ++clock,
    emit: (projectId, review) => emitted.push({ projectId, review }),
  });
  return { reviewer, sessions, stopped, emitted, rows };
}

describe('collectInput', () => {
  it('splits board cards into open, done and epics, and keeps only links on this board', () => {
    const { reviewer } = harness();
    const input = reviewer.collectInput(PROJECT)!;
    expect(input.projectName).toBe('Fixture');
    expect(input.cap).toBe(2);
    expect(input.openTickets.map((t) => t.id)).toEqual(['tm-1', 'tm-2']);
    expect(input.doneTickets.map((t) => t.id)).toEqual(['tm-3']);
    expect(input.epics.map((t) => t.id)).toEqual(['epic-1']);
    expect(input.milestones.map((m) => m.name)).toEqual(['M1']);
    expect(input.taskLinks.map((l) => l.fromTaskId)).toEqual(['tm-1']);
    expect(input.ticketLinks).toHaveLength(1);
  });

  it('is null for an unknown project', () => {
    expect(harness().reviewer.collectInput('nope')).toBeNull();
  });
});

describe('start', () => {
  it('starts one read-only session in the repo on the planning model, capped by readyLanes', async () => {
    const { reviewer, sessions, emitted } = harness();
    const started = await reviewer.start(PROJECT);
    expect(started).toEqual({ reviewId: 'rev-1' });
    expect(sessions).toHaveLength(1);
    const { request, projectId } = sessions[0];
    expect(projectId).toBe(PROJECT);
    expect(request.permissionMode).toBe('plan');
    expect(request.disallowedTools).toEqual(AI_REVIEW_DISALLOWED_TOOLS);
    expect(request.cwd).toBe('C:/repo');
    expect(request.model).toBe('opus');
    expect(request.prompt).toContain('at most 2 ready cards at once');
    expect(request.prompt).toContain('TM-1');
    expect(emitted).toEqual([
      { projectId: PROJECT, review: expect.objectContaining({ id: 'rev-1', status: 'running' }) },
    ]);
    expect(reviewer.isRunning(PROJECT)).toBe(true);
  });

  it('falls back to the default model, and an unlimited cap reads as no cap', async () => {
    const { reviewer, sessions } = harness({ project: { planningModel: null, readyLanes: 0 } });
    await reviewer.start(PROJECT);
    expect(sessions[0].request.model).toBe('sonnet');
    expect(sessions[0].request.prompt).toContain('no cap');
  });

  it('reuses the running review on a second start', async () => {
    const { reviewer, sessions, emitted } = harness();
    const [a, b] = await Promise.all([reviewer.start(PROJECT), reviewer.start(PROJECT)]);
    expect(a.reviewId).toBe('rev-1');
    expect(b).toEqual({ reviewId: 'rev-1' });
    expect(sessions).toHaveLength(1);
    expect(emitted).toHaveLength(1);
  });

  it('refuses without a project or a repo', async () => {
    expect(await harness({ project: null }).reviewer.start(PROJECT)).toEqual({
      reviewId: null,
      error: BOARD_REVIEW_NO_PROJECT,
    });
    const noRepo = harness({ project: { path: '' } });
    expect(await noRepo.reviewer.start(PROJECT)).toEqual({
      reviewId: null,
      error: BOARD_REVIEW_NO_REPO,
    });
    expect(noRepo.sessions).toHaveLength(0);
    expect(noRepo.emitted).toHaveLength(0);
  });

  it('fails the row when the session never started', async () => {
    const { reviewer, emitted, rows } = harness({ runId: '' });
    expect(await reviewer.start(PROJECT)).toEqual({
      reviewId: 'rev-1',
      error: BOARD_REVIEW_NOT_STARTED,
    });
    expect(rows.get('rev-1')?.status).toBe('failed');
    expect(emitted.map((e) => e.review.status)).toEqual(['running', 'failed']);
    expect(reviewer.isRunning(PROJECT)).toBe(false);
  });
});

describe('settling', () => {
  it('a result settles the row as done with the parsed report', async () => {
    const { reviewer, sessions, emitted, rows } = harness();
    await reviewer.start(PROJECT);
    sessions[0].onResult(
      report([
        { ref: 'TM-1', verdict: 'OK' },
        { ref: 'TM-2', verdict: 'DROP' },
      ]),
    );
    const row = rows.get('rev-1')!;
    expect(row.status).toBe('done');
    expect(row.error).toBeNull();
    expect(row.report?.summary).toBe('Two tickets.');
    expect(row.report?.tickets.map((t) => [t.taskId, t.verdict])).toEqual([
      ['tm-1', 'OK'],
      ['tm-2', 'DROP'],
    ]);
    expect(emitted.map((e) => e.review.status)).toEqual(['running', 'done']);
    expect(emitted[1].review.report?.tickets).toHaveLength(2);
    expect(reviewer.isRunning(PROJECT)).toBe(false);

    // The exit that always follows a result changes nothing.
    sessions[0].onExit();
    expect(rows.get('rev-1')?.status).toBe('done');
    expect(emitted).toHaveLength(2);
  });

  it('a malformed result fails the row with the parser error', async () => {
    const { reviewer, sessions, emitted, rows } = harness();
    await reviewer.start(PROJECT);
    sessions[0].onResult('No report, sorry.');
    expect(rows.get('rev-1')).toMatchObject({
      status: 'failed',
      report: null,
      error: 'The review ended without a fenced json report.',
    });
    expect(emitted.map((e) => e.review.status)).toEqual(['running', 'failed']);
  });

  it('an exit without a result fails the row', async () => {
    const { reviewer, sessions, emitted, rows } = harness();
    await reviewer.start(PROJECT);
    sessions[0].onExit();
    expect(rows.get('rev-1')).toMatchObject({ status: 'failed', error: BOARD_REVIEW_NO_RESULT });
    expect(emitted.map((e) => e.review.status)).toEqual(['running', 'failed']);
    expect(reviewer.isRunning(PROJECT)).toBe(false);
  });

  it('a new start after a review settled starts a fresh run', async () => {
    const { reviewer, sessions } = harness();
    await reviewer.start(PROJECT);
    sessions[0].onExit();
    expect(await reviewer.start(PROJECT)).toEqual({ reviewId: 'rev-2' });
    expect(sessions).toHaveLength(2);
  });
});

describe('stop', () => {
  it('kills the session, fails the row and ignores the late result', async () => {
    const { reviewer, sessions, stopped, emitted, rows } = harness();
    await reviewer.start(PROJECT);
    reviewer.stop(PROJECT);
    expect(stopped).toEqual(['run-1']);
    expect(rows.get('rev-1')).toMatchObject({ status: 'failed', error: BOARD_REVIEW_STOPPED });
    expect(emitted.map((e) => e.review.status)).toEqual(['running', 'failed']);

    sessions[0].onResult(report([{ ref: 'TM-1', verdict: 'OK' }]));
    sessions[0].onExit();
    expect(rows.get('rev-1')?.status).toBe('failed');
    expect(emitted).toHaveLength(2);
  });

  it('does nothing when no review is running', () => {
    const { reviewer, stopped, emitted } = harness();
    reviewer.stop(PROJECT);
    expect(stopped).toEqual([]);
    expect(emitted).toEqual([]);
  });
});
