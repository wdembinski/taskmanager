import { describe, expect, it } from 'vitest';
import {
  PERSONAL_PROJECT_ID,
  type Task,
  type TicketLink,
  type TicketLinkType,
} from '@shared/model';
import type { TaskLink } from '@shared/taskChain';
import { planBlocksMigration, type BlocksMigrationPlan } from './blocksLinkMigration';

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  projectId: PERSONAL_PROJECT_ID,
  phase: 'proj',
  title: `card ${id}`,
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'jira',
  isContract: false,
  isScaffold: false,
  ...over,
});

const byId = (...tasks: Task[]) => new Map(tasks.map((t) => [t.id, t]));

let seq = 0;
const ticketLink = (
  fromTaskId: string,
  toTaskId: string,
  type: TicketLinkType = 'blocks',
  createdAt = ++seq,
): TicketLink => ({
  id: `tl-${fromTaskId}-${toTaskId}-${type}`,
  fromTaskId,
  toTaskId,
  type,
  createdAt,
});

const arrow = (fromTaskId: string, toTaskId: string): TaskLink => ({
  id: `ar-${fromTaskId}-${toTaskId}`,
  fromTaskId,
  toTaskId,
  gate: 'after-merge',
  createdAt: 0,
});

const counts = (over: Partial<BlocksMigrationPlan['counts']> = {}) => ({
  converted: 0,
  duplicate: 0,
  missing: 0,
  step: 0,
  cycle: 0,
  unlanded: 0,
  ...over,
});

/** The plan applied the way the store applies it, so a second plan can be run over it. */
function apply(
  ticketLinks: TicketLink[],
  taskLinks: TaskLink[],
  plan: BlocksMigrationPlan,
): { ticketLinks: TicketLink[]; taskLinks: TaskLink[] } {
  return {
    ticketLinks: ticketLinks
      .filter((l) => !plan.deleteTicketLinks.includes(l.id))
      .map((l) => (plan.toRelates.includes(l.id) ? { ...l, type: 'relates' as const } : l)),
    taskLinks: [
      ...taskLinks,
      ...plan.insertArrows.map((a) => ({ ...arrow(a.fromTaskId, a.toTaskId) })),
    ],
  };
}

describe('planBlocksMigration', () => {
  it('converts a blocks link into an after-merge arrow and deletes the link', () => {
    const link = ticketLink('a', 'b');
    const plan = planBlocksMigration([link], [], byId(task('a'), task('b')));
    expect(plan.insertArrows).toEqual([{ fromTaskId: 'a', toTaskId: 'b' }]);
    expect(plan.deleteTicketLinks).toEqual([link.id]);
    expect(plan.toRelates).toEqual([]);
    expect(plan.counts).toEqual(counts({ converted: 1 }));
  });

  it('deletes a blocks link the arrows already state', () => {
    const link = ticketLink('a', 'b');
    const plan = planBlocksMigration([link], [arrow('a', 'b')], byId(task('a'), task('b')));
    expect(plan.insertArrows).toEqual([]);
    expect(plan.deleteTicketLinks).toEqual([link.id]);
    expect(plan.counts).toEqual(counts({ duplicate: 1 }));
  });

  it('demotes a link that would close a loop with an existing arrow to relates', () => {
    const link = ticketLink('a', 'b');
    const plan = planBlocksMigration([link], [arrow('b', 'a')], byId(task('a'), task('b')));
    expect(plan.insertArrows).toEqual([]);
    expect(plan.toRelates).toEqual([link.id]);
    expect(plan.deleteTicketLinks).toEqual([]);
    expect(plan.counts).toEqual(counts({ cycle: 1 }));
  });

  it('converts the older of two links that loop between them and demotes the newer', () => {
    // The planned arrow is fed back into what canLink sees — without that, both would
    // convert and the two cards would wait for each other forever.
    const older = ticketLink('a', 'b', 'blocks', 1);
    const newer = ticketLink('b', 'a', 'blocks', 2);
    const plan = planBlocksMigration([newer, older], [], byId(task('a'), task('b')));
    expect(plan.insertArrows).toEqual([{ fromTaskId: 'a', toTaskId: 'b' }]);
    expect(plan.deleteTicketLinks).toEqual([older.id]);
    expect(plan.toRelates).toEqual([newer.id]);
    expect(plan.counts).toEqual(counts({ converted: 1, cycle: 1 }));
  });

  it('demotes a link from or to a step to relates', () => {
    const fromStep = ticketLink('s', 'b');
    const toStep = ticketLink('a', 's');
    const plan = planBlocksMigration(
      [fromStep, toStep],
      [],
      byId(task('a'), task('b'), task('p'), task('s', { parentTaskId: 'p' })),
    );
    expect(plan.insertArrows).toEqual([]);
    expect(plan.toRelates).toEqual([fromStep.id, toStep.id]);
    expect(plan.counts).toEqual(counts({ step: 2 }));
  });

  it('demotes a link whose blocker is done but never landed', () => {
    // An after-merge arrow from it could never be met: it would hold b forever.
    const link = ticketLink('a', 'b');
    const plan = planBlocksMigration([link], [], byId(task('a', { status: 'done' }), task('b')));
    expect(plan.insertArrows).toEqual([]);
    expect(plan.toRelates).toEqual([link.id]);
    expect(plan.counts).toEqual(counts({ unlanded: 1 }));
  });

  it('converts a link whose blocker has landed — the arrow arrives already met', () => {
    const link = ticketLink('a', 'b');
    const plan = planBlocksMigration(
      [link],
      [],
      byId(task('a', { status: 'done', landedAt: 1_000 }), task('b')),
    );
    expect(plan.insertArrows).toEqual([{ fromTaskId: 'a', toTaskId: 'b' }]);
    expect(plan.counts).toEqual(counts({ converted: 1 }));
  });

  it('converts a link whose blocker is still open, done-ness aside', () => {
    const link = ticketLink('a', 'b');
    const plan = planBlocksMigration(
      [link],
      [],
      byId(task('a', { status: 'in-progress' }), task('b')),
    );
    expect(plan.counts).toEqual(counts({ converted: 1 }));
  });

  it('deletes a link whose end is gone', () => {
    const link = ticketLink('a', 'gone');
    const plan = planBlocksMigration([link], [], byId(task('a')));
    expect(plan.deleteTicketLinks).toEqual([link.id]);
    expect(plan.counts).toEqual(counts({ missing: 1 }));
  });

  it('deletes rather than rewrites when the pair already relates, either way round', () => {
    // ticket_links is unique on (from, to, type): an UPDATE onto an existing relates
    // would throw, and the fact is already recorded anyway.
    const link = ticketLink('a', 'b');
    const relates = ticketLink('b', 'a', 'relates');
    const plan = planBlocksMigration(
      [link, relates],
      [arrow('b', 'a')],
      byId(task('a'), task('b')),
    );
    expect(plan.toRelates).toEqual([]);
    expect(plan.deleteTicketLinks).toEqual([link.id]);
    expect(plan.counts).toEqual(counts({ cycle: 1 }));
  });

  it('leaves relates and every other non-blocking type untouched', () => {
    const others = (['relates', 'duplicates', 'implements', 'causes', 'clones'] as const).map(
      (type) => ticketLink('a', 'b', type),
    );
    const plan = planBlocksMigration(others, [], byId(task('a'), task('b')));
    expect(plan).toEqual({
      insertArrows: [],
      deleteTicketLinks: [],
      toRelates: [],
      counts: counts(),
    });
  });

  it('plans nothing when run again over its own result', () => {
    const tasks = byId(
      task('a'),
      task('b'),
      task('c', { status: 'done' }),
      task('p'),
      task('s', { parentTaskId: 'p' }),
    );
    const ticketLinks = [
      ticketLink('a', 'b'),
      ticketLink('b', 'a'),
      ticketLink('c', 'b'),
      ticketLink('s', 'a'),
      ticketLink('a', 'c', 'relates'),
    ];
    const taskLinks = [arrow('a', 'c')];
    const first = planBlocksMigration(ticketLinks, taskLinks, tasks);
    expect(first.counts).toEqual(counts({ converted: 1, cycle: 1, unlanded: 1, step: 1 }));
    const after = apply(ticketLinks, taskLinks, first);
    expect(after.ticketLinks.some((l) => l.type === 'blocks')).toBe(false);
    expect(planBlocksMigration(after.ticketLinks, after.taskLinks, tasks)).toEqual({
      insertArrows: [],
      deleteTicketLinks: [],
      toRelates: [],
      counts: counts(),
    });
  });
});
