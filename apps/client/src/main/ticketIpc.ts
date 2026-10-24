/**
 * The native-ticket write path — `ticket:update`, the plain half of `ticketLink:add`, and
 * `ticketLink:remove` — pulled out of `ipc.ts` the same way `archiveHandlers.ts` pulls its
 * three out, so a vitest suite and a headless `scripts/verify-*.mjs` scenario can both run
 * the REAL bodies against a store of their own. No import here reaches `electron` or a
 * runtime `store`; `ipc.ts` still does the `handle()` wiring, and keeps the `blocks` branch of
 * `ticketLink:add` (`drawChainLink`) to itself, since that one touches the release engine.
 *
 * A ticket is a `Task` row with `source: 'ticket'`; the twelve ticket-only fields
 * (`TicketPatch`) are what this module guards, since `createTicketTx`/`updateTask` write them
 * blindly and neither can afford a query per field on every card save. Every guard below is
 * its own sentence for exactly that reason — a thrown `UNIQUE constraint failed` or a silent
 * `undefined` teaches a human nothing.
 */
import type { IpcEvents } from '@shared/ipc';
import type { Task, TicketInput, TicketLink, TicketLinkType, TicketPatch } from '@shared/model';
import { isEpic, isNativeTicket } from '@shared/tickets';
import { canLinkTickets, type TicketLinkResult } from '@shared/ticketLinks';
import type { Store } from './store';

export interface TicketIpcDeps {
  store: Pick<
    Store,
    | 'getTask'
    | 'getTasks'
    | 'updateTask'
    | 'listMilestones'
    | 'listPeople'
    | 'listTicketLinks'
    | 'addTicketLink'
    | 'deleteTicketLink'
  >;
  /** `ipc.ts`'s own `send` — the window plus the cloud mirror. */
  send: <K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]) => void;
}

export interface TicketIpc {
  assertTicketRefs(
    projectId: string,
    ticketId: string | null,
    issueType: NonNullable<TicketInput['issueType']>,
    fields: Pick<TicketInput, 'epicTaskId' | 'milestoneId' | 'assigneeId' | 'reporterId'>,
  ): void;
  updateTicket(taskId: string, patch: TicketPatch): Task;
  pushTicketLinks(): TicketLink[];
  addPlainTicketLink(
    fromTaskId: string,
    toTaskId: string,
    type: Exclude<TicketLinkType, 'blocks'>,
  ): TicketLinkResult;
  removeTicketLink(id: string): void;
}

export function createTicketIpc({ store, send }: TicketIpcDeps): TicketIpc {
  /**
   * Validate the cross-references a ticket create/update carries: `epicTaskId` must name an
   * EPIC in the SAME project and not itself; an epic may not itself hang under another epic;
   * `milestoneId`/`assigneeId`/`reporterId` must resolve. Throws the first refusal found.
   */
  function assertTicketRefs(
    projectId: string,
    ticketId: string | null,
    issueType: NonNullable<TicketInput['issueType']>,
    fields: Pick<TicketInput, 'epicTaskId' | 'milestoneId' | 'assigneeId' | 'reporterId'>,
  ): void {
    if (fields.epicTaskId != null) {
      if (issueType === 'epic') throw new Error('An epic cannot itself hang under another epic.');
      if (fields.epicTaskId === ticketId) throw new Error('A ticket cannot be its own epic.');
      const epic = store.getTask(fields.epicTaskId);
      if (!epic) throw new Error('That epic no longer exists.');
      if (epic.projectId !== projectId) {
        throw new Error("The epic must belong to the ticket's own project.");
      }
      if (!isEpic(epic)) throw new Error('That ticket is not an epic.');
    }
    if (fields.milestoneId != null) {
      if (!store.listMilestones(projectId).some((m) => m.id === fields.milestoneId)) {
        throw new Error('That milestone no longer exists.');
      }
    }
    if (fields.assigneeId != null && !store.listPeople().some((p) => p.id === fields.assigneeId)) {
      throw new Error('That assignee no longer exists.');
    }
    if (fields.reporterId != null && !store.listPeople().some((p) => p.id === fields.reporterId)) {
      throw new Error('That reporter no longer exists.');
    }
  }

  function updateTicket(taskId: string, patch: TicketPatch): Task {
    const existing = store.getTask(taskId);
    if (!existing) throw new Error('Unknown ticket.');
    if (!isNativeTicket(existing)) throw new Error('That card is not a native ticket.');
    const issueType =
      patch.issueType !== undefined ? (patch.issueType ?? 'task') : (existing.issueType ?? 'task');
    assertTicketRefs(existing.projectId, taskId, issueType, patch);
    const updated = store.updateTask(taskId, patch);
    if (!updated) throw new Error('Could not update that ticket.');
    send('project:tasksChanged', {
      projectId: existing.projectId,
      tasks: store.getTasks(existing.projectId),
    });
    return updated;
  }

  // --- Ticket links (documentation, not the chain of execution) --------------
  function pushTicketLinks(): TicketLink[] {
    const links = store.listTicketLinks();
    send('ticketLink:changed', links);
    return links;
  }

  function addPlainTicketLink(
    fromTaskId: string,
    toTaskId: string,
    type: Exclude<TicketLinkType, 'blocks'>,
  ): TicketLinkResult {
    const links = store.listTicketLinks();
    const refusal = canLinkTickets(links, store.getTask(fromTaskId), store.getTask(toTaskId), type);
    if (refusal) return { status: 'refused', reason: refusal };
    const created = store.addTicketLink(fromTaskId, toTaskId, type);
    // `canLinkTickets` already passed, so a miss here is a race with another writer rather
    // than a refusal we can explain — report it as the duplicate the unique index caught,
    // exactly as `chain:link` does for its own race.
    if (!created) return { status: 'refused', reason: 'duplicate' };
    return { status: 'ok', links: pushTicketLinks() };
  }

  function removeTicketLink(id: string): void {
    store.deleteTicketLink(id);
    pushTicketLinks();
  }

  return { assertTicketRefs, updateTicket, pushTicketLinks, addPlainTicketLink, removeTicketLink };
}
