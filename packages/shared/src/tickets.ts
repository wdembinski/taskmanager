/**
 * The vocabulary of native tickets (Phase 24): what kinds there are, how the three
 * competing "type" fields resolve to one icon, and how a label list is cleaned up.
 *
 * Pure — no React, no Electron, no DB — because both sides need the same answers: the store
 * validates what it reads out of a column with the same predicates the renderer draws with.
 * Key formatting lives next door in `@shared/ticketKey`.
 */
import type { IssueType, Task, TicketLinkType } from './model';

/**
 * Every issue type, in the order a picker should offer them: the container first, then the
 * three ordinary kinds, then the one that hangs off another.
 */
export const ISSUE_TYPES: readonly IssueType[] = ['epic', 'story', 'task', 'bug', 'subtask'];

/** Whether a stored string is a known issue type — how a column is validated on read. */
export function isIssueType(value: string): value is IssueType {
  return (ISSUE_TYPES as readonly string[]).includes(value);
}

/** Every relationship two tickets can be in. See `TicketLinkType` for what they are NOT. */
export const TICKET_LINK_TYPES: readonly TicketLinkType[] = [
  'blocks',
  'duplicates',
  'relates',
  'implements',
  'causes',
  'clones',
];

/**
 * Whether a stored string is a known link type. An unknown one degrades to `relates` at the
 * call site rather than dropping the link — the same discipline `rowToTaskLink` applies to
 * an unknown gate: a row written by a newer build should read as the weakest true thing,
 * not vanish.
 */
export function isTicketLinkType(value: string): value is TicketLinkType {
  return (TICKET_LINK_TYPES as readonly string[]).includes(value);
}

/** Whether this row is a ticket **this app owns** — as opposed to a JIRA mirror or an
 *  ad-hoc card. The one test every ticket-only surface should be gated on. */
export function isNativeTicket(task: Pick<Task, 'source'>): boolean {
  return task.source === 'ticket';
}

/** Whether this ticket is an epic — the one issue type that has children (`epicTaskId`). */
export function isEpic(task: Pick<Task, 'issueType'>): boolean {
  return task.issueType === 'epic';
}

/**
 * Which icon a card's type should be drawn with — the resolved answer over all three type
 * fields, so the board, the detail pane and the backlog cannot disagree.
 *
 * A KEY rather than an icon, because this module is pure and the icons are JSX: the
 * renderer maps one to the other in one place. `feature` and `note` have no `IssueType` of
 * their own — they are the legacy ad-hoc `TaskType` and the fallback — which is exactly why
 * the return type is its own union rather than `IssueType | null`.
 *
 * Precedence, most specific owner first:
 *
 *  1. `issueType` — a native ticket's own closed vocabulary. Only this app writes it.
 *  2. `externalType` — the TRACKER's, a free string, so matched loosely the way the board
 *     already matches it ("Sub-task", "Technical Story", "New Feature" all have to land
 *     somewhere). Read for any tracker-sourced row: JIRA writes an issue type there and
 *     GitHub writes `Bug`/`Enhancement` off the two labels every repository is created with,
 *     and both are the same kind of fact. NOT read for a native ticket, which may carry a
 *     stale one from before it was adopted and whose own `issueType` is the truth.
 *  3. `type` — the legacy ad-hoc `bug|feature` a human picked in the Add-task dialog.
 *  4. `note` — a card nobody has typed at all.
 */
export type TypeIconKey = IssueType | 'feature' | 'note';

export function typeIconKeyFor(
  task: Pick<Task, 'issueType' | 'externalSource' | 'externalType' | 'type'>,
): TypeIconKey {
  if (task.issueType && isIssueType(task.issueType)) return task.issueType;

  if (task.externalSource != null) {
    const external = (task.externalType ?? '').toLowerCase();
    // Ordered by specificity, not alphabetically: "Sub-task" contains "task", and "Epic
    // Story" would match both — the first test that hits is the narrower reading.
    if (external.includes('sub')) return 'subtask';
    if (external.includes('bug') || external.includes('defect')) return 'bug';
    if (external.includes('epic')) return 'epic';
    if (external.includes('story')) return 'story';
    // `enhancement` is GitHub's half of this arm and the only word it contributes: the sync
    // writes `Bug` or `Enhancement` and nothing else (`githubIssueSync.issueTypeFrom`), and
    // `Bug` was already covered by JIRA's, so without this a GitHub feature request fell all
    // the way through to a neutral note.
    if (
      external.includes('feature') ||
      external.includes('improvement') ||
      external.includes('enhancement')
    ) {
      return 'feature';
    }
    if (external.includes('task')) return 'task';
    return 'note';
  }

  if (task.type === 'bug') return 'bug';
  if (task.type === 'feature') return 'feature';
  return 'note';
}

/**
 * Clean a label list on its way onto a ticket: trim, drop blanks, and de-duplicate
 * **case-blind** while keeping the first spelling seen.
 *
 * Case-blind because that is what the `ticket_labels` registry enforces (`COLLATE NOCASE`),
 * and a ticket wearing both `Backend` and `backend` would draw two chips for one label and
 * survive exactly one of the two deletes. First spelling wins rather than the registry's,
 * because this function is pure and has never seen the registry — the store reconciles the
 * spelling when it writes.
 *
 * Order is preserved: the chips read in the order somebody added them, not alphabetically.
 * The same shape as `normalizeEpicKeys` in the store, one layer up.
 */
export function normalizeLabels(labels: readonly string[] | undefined): string[] {
  if (!labels) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const label of labels) {
    const trimmed = label.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Initials for a person who was given none — two letters from the first two words, or the
 * first two of a single word.
 *
 * A *seed*, never a derivation: `Person.initials` is stored precisely because two people
 * can share initials and only a human can settle which gets what. This is what the field
 * starts as, and it is editable from the moment the row exists.
 */
export function seedInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
