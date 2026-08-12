/**
 * statusMapView — the rows behind Settings' "how your statuses land" table.
 *
 * The surface that would have made the IN REVIEW bug obvious. That bug was not a wrong
 * rule, it was an INVISIBLE one: the sync resolved a status by its JIRA category while
 * the drag resolved it by name, and nothing in the app ever said which had decided. So
 * this table's real content is the `reason` column.
 *
 * It calls the same `resolveStatusColumn` the engine calls, deliberately — a viewer with
 * its own copy of the rules is a viewer that can lie, which is the failure we are fixing.
 * Pure, so the ordering and grouping are testable without a DOM.
 */
import type { BoardColumn } from '@tm/shared/model';
import type { JiraStatusOption } from '@tm/shared/ipc';
import {
  resolveGitHubColumn,
  resolveStatusColumn,
  type StatusReason,
} from '@tm/shared/statusResolve';
import { visibleColumns } from './board/boardColumns';

export interface StatusMapViewRow {
  name: string;
  /**
   * The tracker's own classification of this name — JIRA's status category. A string rather
   * than `JiraStatusCategory` because GitHub has no such thing to report and its rows leave
   * the cell out; see {@link buildGitHubLabelRows}.
   */
  category: string;
  column: BoardColumn;
  reason: StatusReason;
  /**
   * The "Why" badge's text, when the default {@link reasonLabel} would say something untrue
   * for this tracker — GitHub's bottom tier is the issue's open/closed state, not a category.
   */
  why?: string;
}

/**
 * Group order: the board's own left-to-right column order, so the table reads like the
 * board rather than like the alphabet. `visibleColumns(true)` includes Done, which is a
 * column a status can absolutely resolve to even when the board hides it.
 */
const COLUMN_ORDER: readonly BoardColumn[] = visibleColumns(true);

function columnRank(column: BoardColumn): number {
  const at = COLUMN_ORDER.indexOf(column);
  return at === -1 ? COLUMN_ORDER.length : at;
}

/**
 * One row per status the instance reports, resolved and explained.
 *
 * Sorted by resolved column (board order) then name, so every status that lands in a
 * given column sits together — which is how you spot the one that shouldn't.
 */
export function buildStatusMapRows(
  statuses: readonly JiraStatusOption[],
  map?: Record<string, BoardColumn>,
  learned?: Record<string, BoardColumn>,
): StatusMapViewRow[] {
  return statuses
    .map(({ name, category }) => {
      const { column, reason } = resolveStatusColumn(name, category, map, learned);
      return { name, category, column, reason };
    })
    .sort((a, b) => columnRank(a.column) - columnRank(b.column) || a.name.localeCompare(b.name));
}

/**
 * One row per LABEL either map mentions, resolved by `resolveGitHubColumn` and explained.
 *
 * The two maps' own keys are the whole population, and that is not a shortcut — it is the
 * honest answer to "which labels does this app have an opinion about". GitHub has no
 * instance-wide list of statuses to enumerate the way JIRA does (labels are per repository,
 * and a board can span dozens), and a card only stores the ONE label it is showing as a chip,
 * so there is nothing else to read. What matters is on the list either way: every label the
 * user mapped, and — the reason this table exists at all — every label the app taught itself,
 * which is the set nobody would otherwise ever see.
 *
 * Resolved as if the issue were OPEN, because that is the only state in which a label decides
 * anything: closed always means DONE. The Field's own hint says so; a row per label per state
 * would double the table to say it twice.
 */
export function buildGitHubLabelRows(
  map?: Record<string, BoardColumn>,
  learned?: Record<string, BoardColumn>,
): StatusMapViewRow[] {
  const names = new Map<string, string>();
  for (const name of [...Object.keys(map ?? {}), ...Object.keys(learned ?? {})]) {
    const trimmed = name.trim();
    // Case-blind, keeping the first spelling seen — the same rule `lookupStatusColumn`
    // matches by, so the table cannot list two rows that are one entry to the engine.
    if (trimmed && !names.has(trimmed.toLowerCase())) names.set(trimmed.toLowerCase(), trimmed);
  }
  return [...names.values()]
    .map((name) => {
      const { column, reason } = resolveGitHubColumn([name], 'open', map, learned);
      return {
        name,
        category: '',
        column,
        reason,
        // `category` is GitHub's bottom tier and it means "no label spoke", not "GitHub filed
        // it there" — a row badged "JIRA category" would be nonsense on this screen.
        why: reason === 'category' ? 'Not mapped — open means TO DO' : undefined,
      };
    })
    .sort((a, b) => columnRank(a.column) - columnRank(b.column) || a.name.localeCompare(b.name));
}

/**
 * The badge text for a row's tier. Sentence-shaped, because it answers "why?".
 *
 * Takes the resolved COLUMN as well, because `heuristic` is one tier that says two
 * different things: the name read as review, or the name read as blocked. They stayed
 * one tier on purpose — `STATUS_REASONS` is iterated as precedence by the transition
 * picker, so a fifth reason would silently reorder that loop — which makes the label
 * the place the difference has to show. A row badged "Name says review" when the app
 * actually guessed BLOCKED is the same kind of lie this whole table exists to end.
 */
export function reasonLabel(reason: StatusReason, column: BoardColumn): string {
  switch (reason) {
    case 'explicit':
      return 'Mapped by you';
    case 'learned':
      return 'Learned from a move';
    case 'heuristic':
      return column === 'blocked' ? 'Name says blocked' : 'Name says review';
    case 'category':
      return 'JIRA category';
  }
}
