/**
 * Documented relationships between two tickets — "TM-4 blocks TM-9" (Phase 24).
 *
 * `@shared/taskChain` is the **chain of execution**: an arrow there decides when a run may
 * start. A `TicketLink` decides nothing at all — it is a fact a human records, the way a
 * tracker's "Blocks" / "Duplicates" field is. Conflating the two would mean marking a ticket
 * "duplicates" another and having the scheduler refuse to start it.
 *
 * This module owns the one thing both ends of a link need to agree on: what the row READS AS
 * from each end, and when a new one may be drawn. Pure — no React, no DB — for the same
 * reason `taskChain.ts` is: the IPC handler and the renderer must answer from the same
 * function, or the phrasing on screen can disagree with what a drag was refused for.
 */
import { columnForTask } from './board';
import type { Task, TicketLink, TicketLinkType } from './model';

/** How one link type reads from each end, and whether the two ends read the same. */
export interface TicketLinkVocabularyEntry {
  /** The phrase read from the `from` end — "<this ticket> {outward} <other ticket>". */
  outward: string;
  /** The phrase read from the `to` end — "<this ticket> {inward} <other ticket>". */
  inward: string;
  /**
   * True when the relationship reads identically from either end — "relates to" needs no
   * inverse. A symmetric type's mirror row (`B relates A` when `A relates B` already exists)
   * states the same fact twice, so {@link canLinkTickets} refuses it as a duplicate.
   */
  symmetric: boolean;
}

/** Every ticket link type, and how it reads. See {@link TicketLinkVocabularyEntry}. */
export const TICKET_LINK_VOCABULARY: Record<TicketLinkType, TicketLinkVocabularyEntry> = {
  blocks: { outward: 'blocks', inward: 'is blocked by', symmetric: false },
  duplicates: { outward: 'duplicates', inward: 'is duplicated by', symmetric: false },
  relates: { outward: 'relates to', inward: 'relates to', symmetric: true },
  implements: { outward: 'implements', inward: 'is implemented by', symmetric: false },
  causes: { outward: 'causes', inward: 'is caused by', symmetric: false },
  clones: { outward: 'clones', inward: 'is cloned by', symmetric: false },
};

/** One link, read from `taskId`'s end — the phrase to show and the ticket it is about. */
export interface TicketLinkView {
  link: TicketLink;
  /** The ticket at the OTHER end of the row — what the phrase names. */
  otherTaskId: string;
  /** The phrase read from `taskId`'s own end. */
  phrase: string;
}

/**
 * Every link touching `taskId`, each read from ITS end.
 *
 * One row, two readings: "TM-4 blocks TM-9" read from TM-4 is `{ otherTaskId: 'TM-9',
 * phrase: 'blocks' }`; the SAME row read from TM-9 is `{ otherTaskId: 'TM-4', phrase: 'is
 * blocked by' }` — {@link TicketLinkVocabularyEntry.inward}. A link neither end of which is
 * `taskId` is not returned.
 */
export function linksFor(links: readonly TicketLink[], taskId: string): TicketLinkView[] {
  const views: TicketLinkView[] = [];
  for (const link of links) {
    const entry = TICKET_LINK_VOCABULARY[link.type];
    if (link.fromTaskId === taskId) {
      views.push({ link, otherTaskId: link.toTaskId, phrase: entry.outward });
    } else if (link.toTaskId === taskId) {
      views.push({ link, otherTaskId: link.fromTaskId, phrase: entry.inward });
    }
  }
  return views;
}

/**
 * Why a proposed ticket link was refused. `null` from {@link canLinkTickets} means it may be
 * drawn.
 */
export type TicketLinkRefusal = 'missing' | 'self' | 'duplicate';

/** The refusal in words — the picker's tooltip and the handler's rejection message. */
export const TICKET_LINK_REFUSAL_MESSAGE: Record<TicketLinkRefusal, string> = {
  missing: 'one of those tickets no longer exists',
  self: 'a ticket cannot link to itself',
  duplicate: 'that relationship is already recorded',
};

/**
 * What drawing a ticket link came to.
 *
 * A refusal comes back as DATA rather than a rejected promise — the same shape
 * `@shared/taskChain`'s `LinkResult` uses for the chain of execution, and for the same
 * reason: "those two already relate that way" is something to tell the human, not an error.
 */
export type TicketLinkResult =
  { status: 'ok'; links: TicketLink[] } | { status: 'refused'; reason: TicketLinkRefusal };

/**
 * Whether `from --type--> to` may be drawn, and why not when it may not.
 *
 * A **symmetric** type's mirror is a duplicate: "A relates B" and "B relates A" are one fact
 * stated twice, so the row already exists in the direction it happened to be drawn first. A
 * directed type's reverse (`B blocks A` when `A blocks B` already exists) is a different fact
 * and is not refused here — only the exact row, in either symmetric direction, is.
 */
export function canLinkTickets(
  links: readonly TicketLink[],
  from: Pick<Task, 'id'> | undefined,
  to: Pick<Task, 'id'> | undefined,
  type: TicketLinkType,
): TicketLinkRefusal | null {
  if (!from || !to) return 'missing';
  if (from.id === to.id) return 'self';
  const symmetric = TICKET_LINK_VOCABULARY[type].symmetric;
  const duplicate = links.some(
    (l) =>
      l.type === type &&
      ((l.fromTaskId === from.id && l.toTaskId === to.id) ||
        (symmetric && l.fromTaskId === to.id && l.toTaskId === from.id)),
  );
  return duplicate ? 'duplicate' : null;
}

/**
 * The tickets that **block** `taskId` — the `from` end of every `blocks` link that names it
 * as the `to` end. Direction matters: `taskId` blocking some other ticket does not appear
 * here, only what stands in `taskId`'s own way.
 */
export function blockersOf(links: readonly TicketLink[], taskId: string): string[] {
  return links
    .filter((l) => l.type === 'blocks' && l.toTaskId === taskId)
    .map((l) => l.fromTaskId);
}

/** Whether a ticket may be started, given what blocks it. See {@link startReadiness}. */
export type StartReadiness =
  | { kind: 'done' }
  | { kind: 'ready' }
  | { kind: 'waiting'; open: { id: string; task?: Task }[] };

/**
 * Whether `task` is free to start, blocked on other tickets, or already done.
 *
 * A finished ticket is reported `done` before its blockers are even read — there is nothing
 * left to be ready FOR. Otherwise every ticket named by a `blocks` link against `task` (see
 * {@link blockersOf}) must itself be in the DONE column, read via {@link columnForTask} so a
 * blocker's resting status — not a run's borrowed `running` — is what counts. A blocker id
 * {@link byId} cannot resolve is treated as still open rather than ignored: a dangling link
 * is a reason to wait, not a reason to proceed as if it said nothing.
 */
export function startReadiness(
  task: Task,
  links: readonly TicketLink[],
  byId: Map<string, Task>,
): StartReadiness {
  if (columnForTask(task) === 'done') return { kind: 'done' };
  const open = blockersOf(links, task.id)
    .filter((id) => {
      const blocker = byId.get(id);
      return !blocker || columnForTask(blocker) !== 'done';
    })
    .map((id) => ({ id, task: byId.get(id) }));
  return open.length === 0 ? { kind: 'ready' } : { kind: 'waiting', open };
}
