/**
 * Why a card the panel points at isn't on the board right now (F12.9) — the pure answer
 * "Show on board" needs before it can do anything: jumping to a card hidden by a filter
 * would only land on an empty column, so the jump has to name the filter and offer to
 * clear it instead.
 *
 * Kept apart from the board itself so the precedence between filters — which one a human
 * is told about when several apply at once — is a rule that is tested, not a side-effect
 * of whichever `if` happened to run first in a component.
 */
import type { BoardColumn, Task } from '@tm/shared/model';
import {
  archivedBanner,
  archivedBy,
  type ArchivedBy,
  type ArchivedByNames,
  type ArchiveIndex,
} from '@tm/shared/trackerArchive';
import { COLUMN_META, columnForTask } from './boardColumns';

export type BoardFilter =
  | { kind: 'archived'; by?: NonNullable<ArchivedBy> }
  | { kind: 'current-sprint'; sprint: string | null }
  | { kind: 'scope'; boardName: string }
  | { kind: 'focus' }
  | { kind: 'column'; column: BoardColumn };

/** Everything a board applies on top of its raw task list, for one scope's render. */
export interface BoardViewState {
  /** The scope's `board:tasks` ids — what is actually loaded for the board in view. */
  loadedIds: ReadonlySet<string>;
  /** The scope label, e.g. a `BoardScope.name` — Personal, or a project's own board. */
  scopeName: string;
  /** Chain focus's component, or null for "show everything" — see `focusCards`. */
  focusIds: ReadonlySet<string> | null;
  /** Whether the "Current sprint" filter is on. */
  currentSprintOnly: boolean;
  /** The sprint the board is showing — `currentSprintName(tasks)` — or null. */
  currentSprint: string | null;
  /** The columns folded shut by the column picker. */
  hiddenColumns: readonly BoardColumn[];
  /** The tracker's own archive (F14.9) — `card`'s project, milestone or epic archived
   *  through `archive:apply`, as opposed to `Task.archivedAt` below. Optional because not
   *  every caller of `hiddenBy` has it to hand (yet); omitting it just skips the check. */
  archiveIndex?: ArchiveIndex;
}

/**
 * Why `card` is off the board right now, or null when it would actually be showing.
 *
 * The checks run in a fixed order, most fundamental first: a card taken off the board
 * (`Task.archivedAt`) or hidden by the tracker's own archive (its project, milestone or
 * epic archived through `archive:apply`), or whose scope isn't even the one loaded, is
 * hidden for a reason no amount of toggling Chain focus or a column open would fix, so
 * those are asked first and whichever answers first wins — a card can only be hidden by
 * one filter at a time as far as the human is told, even when several would apply. The two
 * archives are asked in that order (board removal, then the tracker's) and never both at
 * once — `Task.archivedAt` already took the card off the board, so there is nothing left
 * for `archiveIndex` to add.
 *
 * `parent` resolves the same "step vs. its own chain" question {@link focusAnchorId} does,
 * but pre-resolved by the caller rather than re-derived here: null for an ordinary card AND
 * for an orphaned step (parent not on this board, promoted to a card of its own by
 * `groupSubtasks`), the parent task otherwise. Only the focus and column checks read it —
 * a step is never archived or sprinted on its own account, and `loadedIds` already answers
 * "is this row even in the scope" for the row actually passed in.
 */
export function hiddenBy(
  card: Task,
  parent: Task | null,
  state: BoardViewState,
): BoardFilter | null {
  if (card.archivedAt) return { kind: 'archived' };

  const by = state.archiveIndex && archivedBy(card, state.archiveIndex);
  if (by) return { kind: 'archived', by };

  if (state.currentSprintOnly && card.externalSource === 'jira') {
    const sprint = card.externalSprint?.trim() || null;
    if (sprint === null || sprint !== state.currentSprint) {
      return { kind: 'current-sprint', sprint: state.currentSprint };
    }
  }

  if (!state.loadedIds.has(card.id)) {
    return { kind: 'scope', boardName: state.scopeName };
  }

  const anchor = parent ?? card;

  if (state.focusIds && !state.focusIds.has(anchor.id)) {
    return { kind: 'focus' };
  }

  const column = columnForTask(anchor);
  if (state.hiddenColumns.includes(column)) {
    return { kind: 'column', column };
  }

  return null;
}

/** The key {@link hiddenByMessage} names the card by — whatever `TaskCard` itself shows. */
function cardKey(card: Task): string {
  return card.externalKey ?? card.ticketKey ?? card.title;
}

function columnLabel(column: BoardColumn): string {
  return COLUMN_META.find((c) => c.column === column)?.label ?? column;
}

/** Lower-cases a sentence's first letter, to embed {@link archivedBanner}'s capitalized
 *  text — "Archived with M2 · Review" — mid-clause, as "TM-5 is archived with M2 · Review". */
function lowerFirst(s: string): string {
  return s.length ? s[0].toLowerCase() + s.slice(1) : s;
}

/**
 * The sentence and the one-click fix for a filter {@link hiddenBy} named — the words
 * "Show on board" puts next to a card it could not jump straight to.
 *
 * `names` resolves `archived`'s `by.id` to a display name — see {@link archivedBanner} —
 * and is optional for the same reason `archiveIndex` is on {@link BoardViewState}: a caller
 * with no names handy still gets a correct, just less specific, sentence.
 */
export function hiddenByMessage(
  card: Task,
  f: BoardFilter,
  names?: ArchivedByNames,
): { text: string; action: string } {
  const key = cardKey(card);
  switch (f.kind) {
    case 'archived':
      return {
        text: f.by ? `${key} is ${lowerFirst(archivedBanner(f.by, names))}` : `${key} is archived`,
        action: 'Restore',
      };
    case 'current-sprint':
      return {
        text: f.sprint ? `${key} is not in ${f.sprint}` : `${key} is not in the current sprint`,
        action: 'Turn off Current sprint',
      };
    case 'scope':
      return { text: `${key} is on ${f.boardName}`, action: `Switch to ${f.boardName}` };
    case 'focus':
      return { text: `${key} is outside this chain`, action: 'Turn off Chain focus' };
    case 'column': {
      const label = columnLabel(f.column);
      return { text: `${key} is in ${label}`, action: `Show ${label}` };
    }
  }
}
