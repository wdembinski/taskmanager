/**
 * Pure helpers `TicketFieldsSection`'s form is built from: parsing what a human typed into a
 * text field back into a ticket's real column types, and diffing ONE field's new value
 * against the ticket it started from to produce the single-field {@link TicketPatch}
 * `ticket:update` actually wants — each field saves itself the moment it changes, so there
 * is no whole-form draft to diff any more.
 *
 * Kept apart from the component for the same reason `backlogView.ts` is: none of it needs a
 * DOM, so the parsing edge cases and the diffing rule are testable without one.
 */
import type { IssueType, Task, TicketPatch } from '@tm/shared/model';
import { normalizeLabels } from '@tm/shared/tickets';

/**
 * A story-point field's text, read back as a number — or `null` for **not estimated**, a
 * real state distinct from an estimate of zero. `''` is the only text that means "not
 * estimated"; unparsable text (a stray letter mid-edit) reads the same way rather than
 * throwing, since a form is not the place to reject a keystroke.
 */
export function parsePoints(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Same rule as {@link parsePoints}, for the estimate-days field — fractional days included. */
export function parseDays(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** The labels text field, split on commas and cleaned through `normalizeLabels`. */
export function splitLabels(text: string): string[] {
  return normalizeLabels(text.split(','));
}

/** An epoch ms as a `<input type="date">` value — the LOCAL calendar day, never UTC's. */
export function dateToInput(epochMs: number | null | undefined): string {
  if (epochMs == null) return '';
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * The inverse of {@link dateToInput}: a `YYYY-MM-DD` value as the epoch ms of LOCAL midnight
 * on that day, or `null` for a blank field. This is the one place in the app a date input's
 * text is turned into an epoch — the Gantt (step 6) reads dates through this same function,
 * or it and the drawer would disagree by a timezone.
 */
export function inputToDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  return new Date(Number(y), Number(m) - 1, Number(d)).getTime();
}

/** `TicketFieldsSection`'s form state — every editable ticket field, named as the controls
 *  hold it, and the key space {@link ticketPatchFor} saves one of at a time. */
export interface TicketDraft {
  issueType: IssueType;
  /** `''` for none — a `Dropdown` cannot carry `null`. */
  epicTaskId: string;
  milestoneId: string;
  /** Comma-separated, as typed; run through {@link splitLabels} to get the real list. */
  labelsText: string;
  storyPointsText: string;
  estimateDaysText: string;
  /** `<input type="date">` values — see {@link dateToInput}. */
  startAtInput: string;
  dueAtInput: string;
  assigneeId: string;
  reporterId: string;
}

function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((label, i) => label === b[i]);
}

/**
 * One field's new value, diffed against the ticket it started from — `{}` when it matches
 * what is already saved, so a field nobody touched (or a picker closed without a real change)
 * sends `ticket:update` nothing to write.
 *
 * A field the human cleared comes back as an explicit `null`, never `undefined`: `TicketPatch`
 * is a `Partial`, so an absent key already means "leave it alone" — `undefined` here would be
 * read exactly that way and the clear would silently not happen.
 *
 * The `as` casts below are internal: the exported signature ties `value`'s type to `field` via
 * `TicketDraft[K]`, so every call site is checked — the switch itself just cannot carry that
 * narrowing through a generic `K` without one.
 */
export function ticketPatchFor<K extends keyof TicketDraft>(
  field: K,
  value: TicketDraft[K],
  ticket: Task,
): TicketPatch {
  switch (field) {
    case 'issueType': {
      const issueType = value as TicketDraft['issueType'];
      return issueType !== (ticket.issueType ?? 'task') ? { issueType } : {};
    }
    case 'epicTaskId': {
      const epicTaskId = (value as string) || null;
      return epicTaskId !== (ticket.epicTaskId ?? null) ? { epicTaskId } : {};
    }
    case 'milestoneId': {
      const milestoneId = (value as string) || null;
      return milestoneId !== (ticket.milestoneId ?? null) ? { milestoneId } : {};
    }
    case 'labelsText': {
      const labels = splitLabels(value as string);
      return sameLabels(labels, normalizeLabels(ticket.labels)) ? {} : { labels };
    }
    case 'storyPointsText': {
      const storyPoints = parsePoints(value as string);
      return storyPoints !== (ticket.storyPoints ?? null) ? { storyPoints } : {};
    }
    case 'estimateDaysText': {
      const estimateDays = parseDays(value as string);
      return estimateDays !== (ticket.estimateDays ?? null) ? { estimateDays } : {};
    }
    case 'startAtInput': {
      const startAt = inputToDate(value as string);
      return startAt !== (ticket.startAt ?? null) ? { startAt } : {};
    }
    case 'dueAtInput': {
      const dueAt = inputToDate(value as string);
      return dueAt !== (ticket.dueAt ?? null) ? { dueAt } : {};
    }
    case 'assigneeId': {
      const assigneeId = (value as string) || null;
      return assigneeId !== (ticket.assigneeId ?? null) ? { assigneeId } : {};
    }
    case 'reporterId': {
      const reporterId = (value as string) || null;
      return reporterId !== (ticket.reporterId ?? null) ? { reporterId } : {};
    }
    default:
      return {};
  }
}
