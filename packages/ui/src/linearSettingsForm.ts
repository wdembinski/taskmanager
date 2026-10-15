/**
 * Pure helpers behind Settings' Linear tab, next to `statusMap.ts`/`statusMapView.ts` which
 * the GitHub/JIRA sections already lean on the same way.
 *
 * `patchLinear` is `patchGitHub`'s shape (`Settings.tsx:349`) made pure and testable:
 * `AppSettings` in, `AppSettings` out, no `setState` closure. `toggleTeamKey`/`toggleStateType`
 * back the two chip pickers (`teamKeys`, `includeStateTypes`). `validateAdvancedFilter` guards
 * the one free-text escape hatch. `setColumnTargetState` and `buildLinearTargetRows` are the
 * column -> state table: what a drag into each column should transition an issue to, per team
 * (`LinearSettings.columnTargetStates`), and what the table shows when nothing is configured yet.
 */
import { BOARD_COLUMNS, type BoardColumn } from '@tm/shared/model';
import { lookupStatusColumn } from '@tm/shared/board';
import type { LinearStateOption } from '@tm/shared/ipc';
import type { AppSettings, LinearSettings, LinearStateType } from '@tm/shared/settings';

/** `patchGitHub`'s merge, made pure: `AppSettings` in, `AppSettings` out. */
export function patchLinear(settings: AppSettings, change: Partial<LinearSettings>): AppSettings {
  return { ...settings, linear: { ...settings.linear, ...change } };
}

/** Toggle a team key, deduped and case-normalised to upper — `teamKeys` has no canonical order. */
export function toggleTeamKey(keys: readonly string[], key: string): string[] {
  const target = key.trim().toUpperCase();
  const seen = new Set<string>();
  for (const existing of keys) {
    const normalized = existing.trim().toUpperCase();
    if (normalized) seen.add(normalized);
  }
  if (!target) return [...seen];
  if (seen.has(target)) seen.delete(target);
  else seen.add(target);
  return [...seen];
}

/**
 * Every {@link LinearStateType}, in the order {@link toggleStateType} sorts its result by —
 * the same order `DEFAULT_LINEAR_SETTINGS.includeStateTypes` already lists a prefix of.
 */
export const LINEAR_STATE_TYPE_ORDER: readonly LinearStateType[] = [
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
];

/** Toggle a state type, deduped and sorted back into {@link LINEAR_STATE_TYPE_ORDER}. */
export function toggleStateType(
  types: readonly LinearStateType[],
  type: LinearStateType,
): LinearStateType[] {
  const set = new Set(types);
  if (set.has(type)) set.delete(type);
  else set.add(type);
  return LINEAR_STATE_TYPE_ORDER.filter((candidate) => set.has(candidate));
}

/**
 * Validate a `LinearSettings.advancedFilter` draft before it is stored.
 *
 * Mirrors `apps/client/src/main/linear/linearQueries.ts`'s `parseAdvancedFilter` rule for rule
 * (blank means "nothing extra", otherwise it must `JSON.parse` to a plain object) rather than
 * importing it: that module lives under `apps/client/src/main`, which `@tm/ui` cannot depend on
 * without the renderer package reaching back into the app that consumes it. Keep the two in
 * step by hand if either one's rule changes.
 *
 * Returns the trimmed text to store (`value`), not the parsed filter — the settings field is a
 * string; parsing it into a GraphQL filter is `parseAdvancedFilter`'s job, at sync time.
 */
export function validateAdvancedFilter(
  text: string,
): { ok: true; value: string | undefined } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: undefined };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Linear advanced filter is not valid JSON: ${message}` };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: 'Linear advanced filter must be a JSON object.' };
  }

  return { ok: true, value: trimmed };
}

/** `Math.max(0, Math.round(n))` — the same clamp GitHub's `doneRetentionDays` field inlines. */
export function clampRetentionDays(n: number): number {
  return Math.max(0, Math.round(n));
}

/**
 * Set (or, with `stateName` blank, clear) one team's target state for one column — never
 * mutates `map`. Clearing the last column a team has drops the team's own entry, so an empty
 * `{}` never lingers in `columnTargetStates`.
 */
export function setColumnTargetState(
  map: LinearSettings['columnTargetStates'],
  teamKey: string,
  column: BoardColumn,
  stateName: string,
): LinearSettings['columnTargetStates'] {
  const name = stateName.trim();
  const team = { ...map[teamKey] };
  if (name) team[column] = name;
  else delete team[column];

  const next = { ...map };
  if (Object.keys(team).length === 0) delete next[teamKey];
  else next[teamKey] = team;
  return next;
}

/** One row of the column -> state table: what a drag into `column` sets, for one team. */
export interface LinearTargetRow {
  column: BoardColumn;
  /** True only for `blocked` — a drag into Blocked never transitions the Linear issue, so the
   *  table shows it but offers no picker; see `linearMove.ts`'s own header comment. */
  localOnly: boolean;
  /** The team's own workflow states, to populate the picker. */
  options: readonly LinearStateOption[];
  /** The state name the picker should show selected, or '' when none applies. */
  selected: string;
  /** True when `selected` came from `learnedStateColumns` rather than explicit configuration. */
  fromLearned: boolean;
}

/**
 * One row per {@link BoardColumn}, in board order, for one team's column -> state table.
 *
 * Tier 1: the state explicitly configured for this team and column
 * (`columnTargetStates[teamKey][column]`). Tier 2, when nothing is configured: the team's own
 * state — lowest `position` if more than one — that a prior drag taught `learnedStateColumns`
 * means this column, surfaced so the user can see (and override) what the app would otherwise
 * pick silently. Blocked never reaches either tier: the move stays local, so its row is marked
 * `localOnly` and carries no selection.
 */
export function buildLinearTargetRows(
  teamKey: string,
  states: readonly LinearStateOption[],
  columnTargetStates: LinearSettings['columnTargetStates'],
  learnedStateColumns: LinearSettings['learnedStateColumns'],
): LinearTargetRow[] {
  const configured = columnTargetStates[teamKey] ?? {};

  return BOARD_COLUMNS.map((column) => {
    if (column === 'blocked') {
      return { column, localOnly: true, options: states, selected: '', fromLearned: false };
    }

    const explicit = configured[column]?.trim();
    if (explicit) {
      return { column, localOnly: false, options: states, selected: explicit, fromLearned: false };
    }

    const learned = [...states]
      .sort((a, b) => a.position - b.position)
      .find((state) => lookupStatusColumn(state.name, learnedStateColumns) === column);

    return {
      column,
      localOnly: false,
      options: states,
      selected: learned?.name ?? '',
      fromLearned: !!learned,
    };
  });
}
