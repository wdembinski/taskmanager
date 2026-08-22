/**
 * The tickets-or-personal choice every project form makes, and the pure logic behind it —
 * `ProjectForm.tsx` draws the choice itself (`ProjectBasicsFields.tsx`) in place of its own
 * "Ticket key prefix" field for any plan-less project, the one shape the store's guaranteed
 * a prefix applies to (`store.addProject`/`updateProject`, gated on `AddProjectInput.personal`
 * / `ProjectPatch.personal`).
 *
 * A project's mode is never stored directly — it is read off `ownsTickets` (a non-empty
 * `ticketPrefix`), the same fact the rest of the app already keys off. This module is only
 * the UI's way of asking for that fact as a single choice instead of an implicit one.
 *
 * No React, no Electron — see `ProjectBasicsFields.tsx` for the form this drives.
 */
import type { Project } from '@tm/shared/model';
import { ownsTickets } from '@tm/shared/model';
import { normalizeTicketPrefix } from '@tm/shared/ticketKey';

export type TicketMode = 'personal' | 'tickets';

/** A project's mode, read off the one fact that actually decides it. */
export function ticketModeOf(project: Project): TicketMode {
  return ownsTickets(project) ? 'tickets' : 'personal';
}

export interface TicketPrefixErrorArgs {
  mode: TicketMode;
  prefix: string;
  /** Every other project, so a chosen prefix can be checked against theirs. */
  projects: Project[];
  /** The project being edited, excluded from the collision check against itself. */
  editingId?: string;
}

/**
 * Why `prefix` can't be saved for a project in `mode`, or `null` if it can.
 *
 * A `'personal'` project never owns a prefix, so nothing here can be wrong about it. A
 * `'tickets'` project's prefix is genuinely optional too — the store guarantees one for a
 * plan-less project regardless (`suggestTicketPrefix` + `uniqueTicketPrefix`), so an empty
 * field is left for the store to fill in rather than blocked here. What IS checked is that a
 * prefix the human DID type is usable and unclaimed.
 */
export function ticketPrefixError({
  mode,
  prefix,
  projects,
  editingId,
}: TicketPrefixErrorArgs): string | null {
  if (mode === 'personal' || !prefix.trim()) return null;

  const normalized = normalizeTicketPrefix(prefix);
  if (!normalized) {
    return 'Not a usable prefix — needs at least one letter, and cannot be just digits.';
  }

  const takenBy = projects.find(
    (p) => p.id !== editingId && p.ticketPrefix && p.ticketPrefix.toUpperCase() === normalized,
  );
  return takenBy ? `Already used by ${takenBy.name}.` : null;
}
