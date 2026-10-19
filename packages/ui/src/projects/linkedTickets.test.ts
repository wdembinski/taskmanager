import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@tm/shared/model';
import type { TaskLink } from '@tm/shared/taskChain';
import type { TicketLinkRefusal } from '@tm/shared/ticketLinks';
import { arrowAddRefusal, linkAddRefusal, linkedTicketRows } from './linkedTickets';

const task = (over: Partial<Task> & { id: string }): Task => ({
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: over.id,
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'adhoc',
  isContract: false,
  isScaffold: false,
  ...over,
});

const index = (...tasks: Task[]): Map<string, Task> => new Map(tasks.map((t) => [t.id, t]));

let nextLinkId = 0;
const ticketLink = (
  fromTaskId: string,
  toTaskId: string,
  type: 'blocks' | 'duplicates' | 'relates' | 'implements' | 'causes' | 'clones',
) => ({ id: `link-${++nextLinkId}`, fromTaskId, toTaskId, type, createdAt: 0 });

const chainLink = (fromTaskId: string, toTaskId: string): TaskLink => ({
  id: `chain-${fromTaskId}->${toTaskId}`,
  fromTaskId,
  toTaskId,
  gate: 'after-merge',
  createdAt: 0,
});

describe('linkedTicketRows', () => {
  it('builds "Blocked by" and "Blocks" from the arrows, both ends', () => {
    const a = task({ id: 'a', ticketKey: 'TM-1' });
    const b = task({ id: 'b', ticketKey: 'TM-2' });
    const chain = [chainLink('a', 'b')];
    const tasksById = index(a, b);

    const fromA = linkedTicketRows(a, [], tasksById, chain);
    expect(fromA?.blockedBy).toEqual([]);
    expect(fromA?.blocks).toEqual([expect.objectContaining({ key: 'TM-2', taskId: 'b' })]);

    const fromB = linkedTicketRows(b, [], tasksById, chain);
    expect(fromB?.blockedBy).toEqual([expect.objectContaining({ key: 'TM-1', taskId: 'a' })]);
    expect(fromB?.blocks).toEqual([]);
  });

  it('leaves a leftover "blocks" ticket link out — the arrows are the dependencies', () => {
    const a = task({ id: 'a', ticketKey: 'TM-1' });
    const b = task({ id: 'b', ticketKey: 'TM-2' });
    const links = [ticketLink('a', 'b', 'blocks')];

    expect(linkedTicketRows(a, links, index(a, b))).toBeNull();
    expect(linkedTicketRows(b, links, index(a, b))).toBeNull();
  });

  it('says whether each predecessor has merged', () => {
    const landed = task({ id: 'l', ticketKey: 'TM-1', status: 'done', landedAt: 5 });
    const open = task({ id: 'o', ticketKey: 'TM-2', status: 'in-progress' });
    const me = task({ id: 'me', ticketKey: 'TM-3' });
    const chain = [chainLink('o', 'me'), chainLink('l', 'me')];

    const section = linkedTicketRows(me, [], index(landed, open, me), chain);
    expect(section?.blockedBy.map((r) => [r.key, r.merged, r.satisfied])).toEqual([
      ['TM-1', true, true],
      ['TM-2', false, false],
    ]);
  });

  it('puts a duplicate pair in separate groups, outward before inward', () => {
    const a = task({ id: 'a', ticketKey: 'TM-1' });
    const b = task({ id: 'b', ticketKey: 'TM-2' });
    const c = task({ id: 'c', ticketKey: 'TM-3' });
    const links = [ticketLink('a', 'b', 'duplicates'), ticketLink('c', 'a', 'duplicates')];

    const section = linkedTicketRows(a, links, index(a, b, c));
    expect(section?.groups.map((g) => g.phrase)).toEqual(['duplicates', 'is duplicated by']);
    expect(section?.groups[0].rows).toEqual([
      expect.objectContaining({ key: 'TM-2', otherTaskId: 'b' }),
    ]);
    expect(section?.groups[1].rows).toEqual([
      expect.objectContaining({ key: 'TM-3', otherTaskId: 'c' }),
    ]);
  });

  it('marks a linked ticket from another project, with key and title still filled in', () => {
    const a = task({ id: 'a', ticketKey: 'TM-1', projectId: 'project-x' });
    const b = task({ id: 'b', ticketKey: 'TM-2', projectId: 'project-y', title: 'Other ticket' });
    const links = [ticketLink('a', 'b', 'relates')];

    const section = linkedTicketRows(a, links, index(a, b));
    expect(section?.groups[0].rows[0]).toMatchObject({
      key: 'TM-2',
      title: 'Other ticket',
      otherProject: true,
      missing: false,
    });
  });

  it('marks a deleted ticket missing, keyed by its id, with the link still removable', () => {
    const a = task({ id: 'a', ticketKey: 'TM-1' });
    const links = [ticketLink('a', 'gone', 'relates')];

    const section = linkedTicketRows(a, links, index(a));
    expect(section?.groups).toEqual([
      {
        phrase: 'relates to',
        rows: [
          {
            linkId: links[0].id,
            otherTaskId: 'gone',
            key: 'gone',
            title: null,
            issueType: null,
            column: null,
            otherProject: false,
            missing: true,
          },
        ],
      },
    ]);
  });

  it('returns null for a ticket with no links, and null when only unrelated links exist', () => {
    const a = task({ id: 'a' });
    expect(linkedTicketRows(a, [], index(a))).toBeNull();

    const b = task({ id: 'b' });
    const c = task({ id: 'c' });
    const unrelated = [ticketLink('b', 'c', 'relates')];
    expect(linkedTicketRows(a, unrelated, index(a, b, c), [chainLink('b', 'c')])).toBeNull();
  });

  it('lists only the arrows when there are no ticket links at all', () => {
    const a = task({ id: 'a', ticketKey: 'TM-1' });
    const b = task({ id: 'b', ticketKey: 'TM-2' });
    const c = task({ id: 'c', ticketKey: 'TM-3' });
    const d = task({ id: 'd', ticketKey: 'TM-4' });
    const chain = [chainLink('c', 'b'), chainLink('a', 'b'), chainLink('b', 'd')];

    const section = linkedTicketRows(b, [], index(a, b, c, d), chain);
    expect(section?.groups).toEqual([]);
    expect(section?.blockedBy.map((r) => r.key)).toEqual(['TM-1', 'TM-3']);
    expect(section?.blocks.map((r) => r.key)).toEqual(['TM-4']);
  });

  it('keeps an arrow to a card that is gone, marked missing', () => {
    const a = task({ id: 'a', ticketKey: 'TM-1' });
    const section = linkedTicketRows(a, [], index(a), [chainLink('gone', 'a')]);
    expect(section?.blockedBy).toEqual([
      expect.objectContaining({ taskId: 'gone', missing: true, merged: false }),
    ]);
  });

  it('sorts rows naturally — TM-9 before TM-31', () => {
    const a = task({ id: 'a' });
    const t31 = task({ id: 't31', ticketKey: 'TM-31' });
    const t9 = task({ id: 't9', ticketKey: 'TM-9' });
    const links = [ticketLink('a', 't31', 'relates'), ticketLink('a', 't9', 'relates')];

    const section = linkedTicketRows(a, links, index(a, t31, t9));
    expect(section?.groups[0].rows.map((r) => r.key)).toEqual(['TM-9', 'TM-31']);
  });

  it('reads the status from columnForTask — a running card reads as its preRunStatus column', () => {
    const a = task({ id: 'a' });
    const b = task({
      id: 'b',
      ticketKey: 'TM-2',
      status: 'running',
      preRunStatus: 'in-review',
    });
    const links = [ticketLink('a', 'b', 'relates')];

    const section = linkedTicketRows(a, links, index(a, b));
    expect(section?.groups[0].rows[0].column).toBe('in-review');
  });

  it('shows "relates to" from both ends, in one group', () => {
    const a = task({ id: 'a', ticketKey: 'TM-1' });
    const b = task({ id: 'b', ticketKey: 'TM-2' });
    const links = [ticketLink('a', 'b', 'relates')];

    expect(linkedTicketRows(a, links, index(a, b))?.groups).toEqual([
      { phrase: 'relates to', rows: [expect.objectContaining({ key: 'TM-2' })] },
    ]);
    expect(linkedTicketRows(b, links, index(a, b))?.groups).toEqual([
      { phrase: 'relates to', rows: [expect.objectContaining({ key: 'TM-1' })] },
    ]);
  });
});

describe('linkAddRefusal', () => {
  it('gives null on an ok result', () => {
    expect(linkAddRefusal({ status: 'ok', links: [] })).toBeNull();
  });

  const reasons: Array<[TicketLinkRefusal, string]> = [
    ['missing', 'one of those tickets no longer exists'],
    ['self', 'a ticket cannot link to itself'],
    ['duplicate', 'that relationship is already recorded'],
    ['cycle', 'that would make a loop, and a loop can never start'],
  ];

  it.each(reasons)('gives the message for a %s refusal', (reason, message) => {
    expect(linkAddRefusal({ status: 'refused', reason })).toBe(message);
  });
});

describe('arrowAddRefusal', () => {
  it("gives null on an ok result, and the arrow's own words on a refusal", () => {
    expect(arrowAddRefusal({ status: 'ok', links: [] })).toBeNull();
    expect(arrowAddRefusal({ status: 'refused', reason: 'step' })).toBe(
      'steps of a plan already run in order — chain their cards instead',
    );
  });
});
