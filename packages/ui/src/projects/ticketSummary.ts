/**
 * The Ticket section's one-line summary — type, milestone, points, due date — kept apart
 * from the component for the same reason `ticketFields.ts` is: none of it needs a DOM, and
 * the "which parts show, in what order, joined how" rule is worth testing on its own.
 */
import type { Milestone, Task } from '@tm/shared/model';

export interface TicketSummaryOptions {
  milestones: readonly Milestone[];
  locale?: string;
  /** Epoch ms "today" is read against — injectable so the year-boundary rule is testable. */
  now?: number;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function milestoneName(
  milestoneId: string | null | undefined,
  milestones: readonly Milestone[],
): string {
  if (!milestoneId) return '';
  return milestones.find((m) => m.id === milestoneId)?.name ?? '';
}

function pointsLabel(storyPoints: number | null | undefined): string {
  if (storyPoints == null) return '';
  return storyPoints === 1 ? '1 pt' : `${storyPoints} pts`;
}

function dueLabel(
  dueAt: number | null | undefined,
  locale: string | undefined,
  now: number,
): string {
  if (dueAt == null) return '';
  const due = new Date(dueAt);
  const sameYear = due.getFullYear() === new Date(now).getFullYear();
  const date = due.toLocaleDateString(
    locale,
    sameYear
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' },
  );
  return `due ${date}`;
}

/**
 * The Ticket section's summary line: type · milestone · points · due date, each part
 * dropped when it has nothing to say. See the individual `*Label`/`milestoneName` helpers
 * above for what makes a part empty.
 */
export function ticketSummaryLine(
  ticket: Pick<Task, 'issueType' | 'milestoneId' | 'storyPoints' | 'dueAt'>,
  { milestones, locale, now = Date.now() }: TicketSummaryOptions,
): string {
  const parts = [
    capitalize(ticket.issueType ?? 'task'),
    milestoneName(ticket.milestoneId, milestones),
    pointsLabel(ticket.storyPoints),
    dueLabel(ticket.dueAt, locale, now),
  ];
  return parts.filter((part) => part !== '').join(' · ');
}
