/**
 * The JIRA status → board column map, as the Settings form edits it.
 *
 * Stored as a `Record<statusName, BoardColumn>` (that is what the sync and the move
 * path read), but a record is the wrong shape for a form: renaming a key means
 * delete-then-insert, which reorders the rows under the cursor while you are still
 * typing. So the editor holds an ordered LIST and serialises to the record on every
 * change. These two functions are that translation, kept pure so the round trip is
 * testable without a DOM.
 */
import type { BoardColumn } from '@shared/model';

/** One row of the editor: a JIRA status name and the column it means. */
export interface StatusMapRow {
  name: string;
  column: BoardColumn;
}

/**
 * The columns a JIRA status may be mapped to — every column the board has, in board
 * order.
 *
 * `blocked` used to be absent, on the grounds that it was an internal-only state no
 * tracker knew about. That was never true of the workflows people actually run: a
 * scheme with a `Blocked` status says "this is stuck" as plainly as the board does,
 * and the resolver now reads it that way. Leaving it out of this list would be the
 * worse of the two failures — the engine would resolve a status to BLOCKED while the
 * editor offered no way to see it, confirm it, or overrule it.
 */
export const MAPPABLE_COLUMNS: readonly BoardColumn[] = [
  'todo',
  'in-progress',
  'in-review',
  'blocked',
  'done',
];

/** The stored record as an ordered list of rows (insertion order, which is the user's). */
export function statusMapToRows(map: Record<string, BoardColumn> | undefined): StatusMapRow[] {
  return Object.entries(map ?? {}).map(([name, column]) => ({ name, column }));
}

/**
 * The rows back as a record. Blank names are dropped (an empty row is one the user
 * has added but not filled in yet, not a mapping), names are trimmed, and on a
 * duplicate the LAST row wins — matching what the row order shows.
 */
export function rowsToStatusMap(rows: readonly StatusMapRow[]): Record<string, BoardColumn> {
  const map: Record<string, BoardColumn> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    // Case-insensitive duplicates would both survive here but only the first would
    // ever match at lookup time, so drop the earlier spelling and keep the latest.
    for (const existing of Object.keys(map)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete map[existing];
    }
    map[name] = row.column;
  }
  return map;
}
