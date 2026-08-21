/**
 * The tickets-or-personal choice every project form makes, and the pure logic behind it —
 * shared by the desktop's agent-project drawer (`Projects.tsx`) and the browser's ticket-only
 * one (`ProjectAdmin.tsx`), which otherwise agree on nothing about a project's shape.
 *
 * A project's mode is never stored directly — it is read off `ownsTickets` (a non-empty
 * `ticketPrefix`), the same fact the rest of the app already keys off. This module is only
 * the UI's way of asking for that fact as a single choice instead of an implicit one.
 *
 * No React, no Electron — see `ProjectBasicsFields.tsx` for the form these drive.
 */
import type { Project } from '@tm/shared/model';
import { ownsTickets } from '@tm/shared/model';
import { normalizeTicketPrefix } from '@tm/shared/ticketKey';

export type TicketMode = 'personal' | 'tickets';

/** A project's mode, read off the one fact that actually decides it. */
export function ticketModeOf(project: Project): TicketMode {
  return ownsTickets(project) ? 'tickets' : 'personal';
}

/**
 * A starting guess for a ticket prefix, from the project's name — initials for a multi-word
 * name ("Task Manager" → "TM"), the first few letters otherwise. Purely a convenience: the
 * field stays freely editable, and `normalizeTicketPrefix` is what actually decides whether
 * the result is usable.
 */
export function suggestTicketPrefix(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const raw =
    words.length > 1
      ? words
          .map((w) => w[0])
          .join('')
          .slice(0, 4)
      : words[0].slice(0, 4);
  return normalizeTicketPrefix(raw) ?? '';
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
 * `'tickets'` project needs one usable and unclaimed — including an empty one, which reads as
 * "not filled in yet" rather than "no prefix wanted", since only a personal project can mean
 * that.
 */
export function ticketPrefixError({
  mode,
  prefix,
  projects,
  editingId,
}: TicketPrefixErrorArgs): string | null {
  if (mode === 'personal') return null;

  if (!prefix.trim()) return 'A ticket board needs a key prefix.';

  const normalized = normalizeTicketPrefix(prefix);
  if (!normalized) {
    return 'Not a usable prefix — needs at least one letter, and cannot be just digits.';
  }

  const takenBy = projects.find(
    (p) => p.id !== editingId && p.ticketPrefix && p.ticketPrefix.toUpperCase() === normalized,
  );
  return takenBy ? `Already used by ${takenBy.name}.` : null;
}
