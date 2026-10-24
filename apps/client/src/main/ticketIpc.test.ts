/**
 * Proves the native-ticket write path `ipc.ts` delegates to — `ticket:update` and the plain
 * half of `ticketLink:add` — against a hand-written fake store and a recording `send`. No
 * Electron, no real `Store`: the store's own writes are `store.ts`'s concern; this is the
 * refusal order, the exact patch written, and the one push each success makes.
 */
import { describe, expect, it, vi } from 'vitest';
import type { IpcEvents } from '@shared/ipc';
import type { Milestone, Person, Task, TicketLink, TicketLinkType } from '@shared/model';
import { createTicketIpc, type TicketIpcDeps } from './ticketIpc';

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    phase: '',
    title: 'A ticket',
    status: 'pending',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'ticket',
    isContract: false,
    isScaffold: false,
    ...overrides,
  };
}

function milestone(id: string, projectId: string): Milestone {
  return {
    id,
    projectId,
    name: id,
    description: '',
    dueAt: null,
    color: '',
    closed: false,
    archivedAt: null,
    createdAt: 0,
  };
}

interface Sent {
  channel: keyof IpcEvents;
  payload: unknown;
}

function harness(tasks: Task[], milestones: Milestone[] = [], people: Person[] = []) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let links: TicketLink[] = [];
  let nextLink = 1;
  const sent: Sent[] = [];
  const updateTask = vi.fn((id: string, patch: Partial<Task>) => {
    const existing = byId.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    byId.set(id, updated);
    return updated;
  });
  const addTicketLink = vi.fn((fromTaskId: string, toTaskId: string, type: TicketLinkType) => {
    const link: TicketLink = { id: `link-${nextLink++}`, fromTaskId, toTaskId, type, createdAt: 0 };
    links = [...links, link];
    return link;
  });
  const store: TicketIpcDeps['store'] = {
    getTask: (id) => byId.get(id),
    getTasks: (projectId) => [...byId.values()].filter((t) => t.projectId === projectId),
    updateTask: updateTask as unknown as TicketIpcDeps['store']['updateTask'],
    listMilestones: (projectId) => milestones.filter((m) => m.projectId === projectId),
    listPeople: () => people,
    listTicketLinks: () => links,
    addTicketLink,
    deleteTicketLink: (id) => {
      links = links.filter((l) => l.id !== id);
    },
  };
  const send: TicketIpcDeps['send'] = (channel, payload) => {
    sent.push({ channel, payload });
  };
  return { ticketIpc: createTicketIpc({ store, send }), store, sent, updateTask, addTicketLink };
}

describe('updateTicket', () => {
  it('refuses an unknown ticket', () => {
    const h = harness([]);
    expect(() => h.ticketIpc.updateTicket('nope', { milestoneId: null })).toThrow(
      'Unknown ticket.',
    );
    expect(h.updateTask).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
  });

  it('refuses a card that is not a native ticket', () => {
    const h = harness([baseTask({ source: 'adhoc' })]);
    expect(() => h.ticketIpc.updateTicket('task-1', { milestoneId: null })).toThrow(
      'That card is not a native ticket.',
    );
    expect(h.updateTask).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
  });

  it("refuses a milestone that is not in the project's own list", () => {
    const h = harness([baseTask()], [milestone('m-other', 'project-2')]);
    expect(() => h.ticketIpc.updateTicket('task-1', { milestoneId: 'm-other' })).toThrow(
      'That milestone no longer exists.',
    );
    expect(h.updateTask).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
  });

  it('writes exactly the patch given and pushes the project once', () => {
    const other = baseTask({ id: 'task-2', projectId: 'project-1' });
    const h = harness([baseTask(), other], [milestone('m-1', 'project-1')]);
    const patch = { milestoneId: 'm-1' };

    const updated = h.ticketIpc.updateTicket('task-1', patch);

    expect(h.updateTask).toHaveBeenCalledTimes(1);
    expect(h.updateTask).toHaveBeenCalledWith('task-1', patch);
    expect(h.updateTask.mock.calls[0][1]).toStrictEqual({ milestoneId: 'm-1' });
    expect(updated.milestoneId).toBe('m-1');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toEqual({
      channel: 'project:tasksChanged',
      payload: { projectId: 'project-1', tasks: h.store.getTasks('project-1') },
    });
  });
});

describe('addPlainTicketLink', () => {
  it("returns 'self' as data and sends nothing", () => {
    const h = harness([baseTask()]);
    expect(h.ticketIpc.addPlainTicketLink('task-1', 'task-1', 'relates')).toEqual({
      status: 'refused',
      reason: 'self',
    });
    expect(h.addTicketLink).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
  });

  it("returns 'duplicate' as data and sends nothing", () => {
    const h = harness([baseTask(), baseTask({ id: 'task-2' })]);
    h.store.addTicketLink('task-2', 'task-1', 'relates');
    h.addTicketLink.mockClear();

    // `relates` is symmetric, so the mirror of an existing row is the same fact.
    expect(h.ticketIpc.addPlainTicketLink('task-1', 'task-2', 'relates')).toEqual({
      status: 'refused',
      reason: 'duplicate',
    });
    expect(h.addTicketLink).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
  });

  it('on success sends one ticketLink:changed carrying the very links it returns', () => {
    const h = harness([baseTask(), baseTask({ id: 'task-2' })]);

    const result = h.ticketIpc.addPlainTicketLink('task-1', 'task-2', 'duplicates');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.links).toHaveLength(1);
    expect(result.links[0]).toMatchObject({
      fromTaskId: 'task-1',
      toTaskId: 'task-2',
      type: 'duplicates',
    });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].channel).toBe('ticketLink:changed');
    expect(h.sent[0].payload).toBe(result.links);
  });
});

describe('removeTicketLink', () => {
  it('deletes the row and pushes the remaining links', () => {
    const h = harness([baseTask(), baseTask({ id: 'task-2' })]);
    const link = h.store.addTicketLink('task-1', 'task-2', 'relates');

    h.ticketIpc.removeTicketLink(link!.id);

    expect(h.store.listTicketLinks()).toEqual([]);
    expect(h.sent).toEqual([{ channel: 'ticketLink:changed', payload: [] }]);
  });
});
