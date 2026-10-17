/**
 * The archive-milestone dialog's own model (F14.7): whether archiving a milestone needs a
 * confirmation step at all, and — when it does — what the dialog has to show. Pure, no
 * React, same discipline as `ticketRegistries.ts`.
 */
import type { Milestone, Task } from '@tm/shared/model';
import { pickableMilestones } from '@tm/shared/trackerArchive';
import { isOpenTicketStatus } from '@tm/shared/tickets';

/** How many open-ticket keys the dialog lists by name before falling back to "N more". */
export const ARCHIVE_SAMPLE_KEYS = 5;

export interface ArchiveDialogModel {
  /** Open tickets on this milestone — the store's own count, archiving moves exactly these. */
  openCount: number;
  /** `openCount > 0` — `false` means the milestone can be archived in one click. */
  needsDialog: boolean;
  /** The first `ARCHIVE_SAMPLE_KEYS` open tickets' keys, in ticket order. */
  sampleKeys: string[];
  /** How many open tickets are not named in `sampleKeys`. */
  moreCount: number;
  /** Every open ticket's key — what "Archive them too" will hide. */
  archiveTooKeys: string[];
  /**
   * Other milestones, in this project, open and not archived — the "move to" picks.
   *
   * Also drops **closed** milestones (`!m.closed`), beyond `pickableMilestones`'s own
   * self/archived/other-project rule — a decision taken without asking, since the spec
   * only named those three. A closed milestone reads as "done"; sending open tickets
   * there would reopen a question about a milestone nobody meant to touch. Closed
   * milestones already drop out of `offeredMilestones` everywhere else a human assigns
   * a ticket to one (`ticketRegistries.ts`), so this keeps the dialog consistent with
   * every other milestone picker in the app rather than carving out an exception.
   */
  targets: Milestone[];
}

function ticketKeyOf(ticket: Pick<Task, 'ticketKey' | 'title'>): string {
  return ticket.ticketKey ?? ticket.title;
}

export function archiveDialogModel(
  milestone: Milestone,
  tickets: readonly Task[],
  milestones: readonly Milestone[],
): ArchiveDialogModel {
  const open = tickets.filter(
    (t) => t.milestoneId === milestone.id && isOpenTicketStatus(t.status),
  );
  const openKeys = open.map(ticketKeyOf);
  const sampleKeys = openKeys.slice(0, ARCHIVE_SAMPLE_KEYS);

  // `!m.closed`: a decision taken without asking — see the `targets` field doc above.
  const targets = pickableMilestones(milestones, undefined).filter(
    (m) => m.projectId === milestone.projectId && m.id !== milestone.id && !m.closed,
  );

  return {
    openCount: open.length,
    needsDialog: open.length > 0,
    sampleKeys,
    moreCount: openKeys.length - sampleKeys.length,
    archiveTooKeys: openKeys,
    targets,
  };
}

export function archiveDialogTitle(milestone: Milestone, model: ArchiveDialogModel): string {
  const noun = model.openCount === 1 ? 'open ticket' : 'open tickets';
  return `${milestone.name} has ${model.openCount} ${noun}`;
}
