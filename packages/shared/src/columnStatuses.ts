/**
 * Which raw tracker names resolve into each board column — the reverse of
 * `resolveStatusColumn`/`resolveGitHubColumn`, grouped the way a column picker needs it:
 * "hiding BLOCKED hides these JIRA statuses" rather than "this JIRA status resolves to
 * BLOCKED". Built on the same resolvers the sync and the drag already call, so a column the
 * picker says is empty really is empty, and one it says holds three statuses can't disagree
 * with where a card bearing one of them actually lands.
 */
import { BOARD_COLUMNS } from './model';
import type { BoardColumn, JiraStatusCategory, TaskStatus } from './model';
import { MANUAL_STATUSES } from './model';
import { columnForStatus } from './board';
import { resolveGitHubColumn, resolveStatusColumn } from './statusResolve';

/** An empty column→[] map, in board order — the seed every grouper below starts from. */
function emptyGroups<T>(): Record<BoardColumn, T[]> {
  const groups = {} as Record<BoardColumn, T[]>;
  for (const column of BOARD_COLUMNS) groups[column] = [];
  return groups;
}

/**
 * Group a JIRA instance's workflow statuses by the board column each resolves to.
 *
 * Calls {@link resolveStatusColumn} per status, so an explicit `statusCategoryOverrides` entry
 * that moves a status into IN REVIEW shows up grouped under `in-review` here, exactly where it
 * would land on the board — the whole point of reusing the resolver rather than re-deriving
 * the category mapping.
 */
export function statusesByColumn(
  statuses: readonly { name: string; category: JiraStatusCategory }[],
  map?: Record<string, BoardColumn>,
  learned?: Record<string, BoardColumn>,
): Record<BoardColumn, string[]> {
  const groups = emptyGroups<string>();
  for (const { name, category } of statuses) {
    const { column } = resolveStatusColumn(name, category, map, learned);
    groups[column].push(name);
  }
  return groups;
}

/**
 * The same grouping for GitHub labels. Resolved as if the issue were OPEN — the only state in
 * which a label decides anything, since closed always means DONE (see
 * {@link resolveGitHubColumn}) — so every label lands under one of the three columns an
 * issue's own state cannot express.
 */
export function githubLabelsByColumn(
  labels: readonly string[],
  map?: Record<string, BoardColumn>,
  learned?: Record<string, BoardColumn>,
): Record<BoardColumn, string[]> {
  const groups = emptyGroups<string>();
  for (const label of labels) {
    const { column } = resolveGitHubColumn([label], 'open', map, learned);
    groups[column].push(label);
  }
  return groups;
}

/**
 * The same grouping for the app's own task statuses — a pure re-bucket of
 * {@link columnForStatus}, with no map to consult because an internal card's status already
 * says exactly where it sits. Defaults to {@link MANUAL_STATUSES}, the ones a human can
 * actually set; pass the full `TaskStatus` list to also see where the run-owned states land.
 */
export function nativeStatusesByColumn(
  statuses: readonly TaskStatus[] = MANUAL_STATUSES,
): Record<BoardColumn, TaskStatus[]> {
  const groups = emptyGroups<TaskStatus>();
  for (const status of statuses) groups[columnForStatus(status)].push(status);
  return groups;
}
