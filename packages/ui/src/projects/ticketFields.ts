/**
 * Pure helpers `TicketDrawer`'s form is built from: parsing what a human typed into a text
 * field back into a ticket's real column types, and diffing a draft against the ticket it
 * started from to produce the {@link TicketPatch} `ticket:update` actually wants.
 *
 * Kept apart from the drawer component for the same reason `backlogView.ts` is: none of it
 * needs a DOM, so the parsing edge cases and the diffing rule are testable without one.
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

/** The ticket drawer's form state — every editable ticket field, as the controls hold it. */
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

/** Seed a draft from a ticket's current fields — what the drawer opens showing. */
export function draftFromTicket(ticket: Task): TicketDraft {
  return {
    issueType: ticket.issueType ?? 'task',
    epicTaskId: ticket.epicTaskId ?? '',
    milestoneId: ticket.milestoneId ?? '',
    labelsText: normalizeLabels(ticket.labels).join(', '),
    storyPointsText: ticket.storyPoints == null ? '' : String(ticket.storyPoints),
    estimateDaysText: ticket.estimateDays == null ? '' : String(ticket.estimateDays),
    startAtInput: dateToInput(ticket.startAt ?? null),
    dueAtInput: dateToInput(ticket.dueAt ?? null),
    assigneeId: ticket.assigneeId ?? '',
    reporterId: ticket.reporterId ?? '',
  };
}

function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((label, i) => label === b[i]);
}

/**
 * The draft, diffed against the ticket it started from — only what actually changed, so
 * closing the drawer untouched sends `{}` and `ticket:update` has nothing to write.
 *
 * A field the human cleared comes back as an explicit `null`, never `undefined`: `TicketPatch`
 * is a `Partial`, so an absent key already means "leave it alone" — `undefined` here would be
 * read exactly that way and the clear would silently not happen.
 */
export function ticketPatchFrom(draft: TicketDraft, ticket: Task): TicketPatch {
  const patch: TicketPatch = {};

  if (draft.issueType !== (ticket.issueType ?? 'task')) patch.issueType = draft.issueType;

  const epicTaskId = draft.epicTaskId || null;
  if (epicTaskId !== (ticket.epicTaskId ?? null)) patch.epicTaskId = epicTaskId;

  const milestoneId = draft.milestoneId || null;
  if (milestoneId !== (ticket.milestoneId ?? null)) patch.milestoneId = milestoneId;

  const labels = splitLabels(draft.labelsText);
  if (!sameLabels(labels, normalizeLabels(ticket.labels))) patch.labels = labels;

  const storyPoints = parsePoints(draft.storyPointsText);
  if (storyPoints !== (ticket.storyPoints ?? null)) patch.storyPoints = storyPoints;

  const estimateDays = parseDays(draft.estimateDaysText);
  if (estimateDays !== (ticket.estimateDays ?? null)) patch.estimateDays = estimateDays;

  const startAt = inputToDate(draft.startAtInput);
  if (startAt !== (ticket.startAt ?? null)) patch.startAt = startAt;

  const dueAt = inputToDate(draft.dueAtInput);
  if (dueAt !== (ticket.dueAt ?? null)) patch.dueAt = dueAt;

  const assigneeId = draft.assigneeId || null;
  if (assigneeId !== (ticket.assigneeId ?? null)) patch.assigneeId = assigneeId;

  const reporterId = draft.reporterId || null;
  if (reporterId !== (ticket.reporterId ?? null)) patch.reporterId = reporterId;

  return patch;
}
