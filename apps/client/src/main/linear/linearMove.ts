/**
 * Pure resolution of a drag-to-move for a card mirrored from a Linear issue: which workflow
 * state the issue has to be made to say, so the next sync agrees with the column the human
 * just dropped the card in.
 *
 * `jira/jiraMove.ts` and `github/githubMove.ts`, a third tracker over, split the same way for
 * the same reason: the local half — where a card rests, what un-blocking restores, which drop
 * is a no-op — is board rules, not Linear's, so it is delegated to `@shared/moveResolve` rather
 * than re-decided here. Only "which state does this issue need" is new.
 *
 * **BLOCKED is local only** (memory `jira-transitions-on-every-move`, and the F4 spec's own
 * line 89): unlike JIRA, a Linear drag into BLOCKED never transitions the issue even when the
 * team has a state that reads as blocked — nothing here looks for one.
 *
 * **Per team, not per workspace.** Every Linear team owns its own set of workflow states with
 * its own names, so `resolveLinearMove` takes one team's states (`LinearTeamStates`) rather
 * than a shared vocabulary the way JIRA's single workflow lets `pickTransition` get away with.
 *
 * **The tiers, first hit wins:** a state the user configured for this team and column; then,
 * tried tier by tier, a state whose own name/type resolves to this column (`resolveLinearColumn`,
 * the same explicit → learned → heuristic precedence the sync uses); then, when nothing
 * resolved, the first state of the column's own type by ascending position — only for TO DO,
 * IN PROGRESS and DONE, since IN REVIEW has no `LinearStateType` of its own to fall back to and
 * must refuse instead. DONE never settles on a `canceled` state in any tier, configured
 * included: a drag into DONE always wants `completed`.
 */
import type { BoardColumn, Task, TaskStatus } from '@shared/model';
import { resolveMove as resolveLocalMove } from '@shared/moveResolve';
import {
  STATUS_REASONS,
  isBlockedishStatus,
  linearCategory,
  resolveLinearColumn,
  type StatusReason,
} from '@shared/statusResolve';
import type { LinearSettings, LinearStateType } from '@shared/settings';
import { COLUMN_LABEL } from '../jira/jiraMove';

/** One Linear workflow state, as read off a team during sync. */
export interface LinearWorkflowState {
  id: string;
  name: string;
  type: LinearStateType;
  position: number;
}

/** The states one Linear team's workflow has — the unit `resolveLinearMove` addresses by. */
export interface LinearTeamStates {
  teamKey: string;
  states: readonly LinearWorkflowState[];
}

/** The settings a move consults — the per-team configured map plus both column maps. */
export type LinearMoveSettings = Pick<
  LinearSettings,
  'stateColumnOverrides' | 'learnedStateColumns' | 'columnTargetStates'
>;

export interface LinearMoveResolution {
  /** The task's new local status. */
  localStatus: TaskStatus;
  /**
   * The column to restore on un-block (set only when moving into Blocked), else null.
   *
   * A *candidate*, exactly as in `jiraMove.MoveResolution`: the caller keeps it only when the
   * block stayed local.
   */
  preBlockStatus: TaskStatus | null;
  /** True when nothing changes (dropped back into the same column). */
  noop: boolean;
  /** The state to transition the issue to, and which tier picked it, or null when none should be touched. */
  target: { state: LinearWorkflowState; via: 'configured' | StatusReason } | null;
  /** Set when the move cannot be expressed on this team ⇒ the caller throws and the optimistic move rolls back. */
  refusal: string | null;
}

/** Case-insensitive, trimmed equality — the same matching every map in this app uses. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The `LinearStateType`s that answer for each column when nothing else has, in the order to
 * prefer them, e.g. an `unstarted` state over a `backlog` one for TO DO. Empty for IN REVIEW
 * (no Linear type means that) and for BLOCKED (never reached — the move is local only).
 */
const TYPE_PREFERENCE: Record<BoardColumn, readonly LinearStateType[]> = {
  todo: ['unstarted', 'backlog', 'triage'],
  'in-progress': ['started'],
  'in-review': [],
  blocked: [],
  done: ['completed'],
};

/**
 * Pick one state out of a same-tier candidate set: the one named literally after `column` (as
 * `pickTransition` prefers), else the lowest `position`. Declaration order never decides, which
 * is the point — a team's states come back in whatever order the workflow lists them in.
 */
function pickNamedOrLowestPosition(
  candidates: readonly LinearWorkflowState[],
  column: BoardColumn,
): LinearWorkflowState | null {
  if (candidates.length === 0) return null;
  const wantName = COLUMN_LABEL[column].trim().toLowerCase();
  const named = candidates.find((s) => sameName(s.name, wantName));
  if (named) return named;
  return [...candidates].sort((a, b) => a.position - b.position)[0];
}

/** DONE never settles on a `canceled` state, in any tier. A no-op filter for every other column. */
function excludeCanceledForDone(
  states: readonly LinearWorkflowState[],
  column: BoardColumn,
): readonly LinearWorkflowState[] {
  return column === 'done' ? states.filter((s) => s.type !== 'canceled') : states;
}

/** Tier 1: the state the user configured for this team and column, or null — stale names fall through. */
function configuredState(
  team: LinearTeamStates,
  toColumn: BoardColumn,
  settings: LinearMoveSettings,
): LinearWorkflowState | null {
  const configuredName = settings.columnTargetStates[team.teamKey]?.[toColumn];
  if (!configuredName) return null;
  const match = team.states.find((s) => sameName(s.name, configuredName));
  if (!match) return null;
  if (toColumn === 'done' && match.type === 'canceled') return null;
  return match;
}

/** Tiers 2–4: the first state whose own name/type resolves to `toColumn` with reason `tier`. */
function mappedTierState(
  team: LinearTeamStates,
  toColumn: BoardColumn,
  tier: StatusReason,
  settings: LinearMoveSettings,
): LinearWorkflowState | null {
  const candidates = excludeCanceledForDone(
    team.states.filter((s) => {
      const resolved = resolveLinearColumn(
        s.name,
        s.type,
        settings.stateColumnOverrides,
        settings.learnedStateColumns,
      );
      return resolved.reason === tier && resolved.column === toColumn;
    }),
    toColumn,
  );
  return pickNamedOrLowestPosition(candidates, toColumn);
}

/** Tier 5: the first state of the column's own type, by preference then position. */
function positionState(team: LinearTeamStates, toColumn: BoardColumn): LinearWorkflowState | null {
  for (const type of TYPE_PREFERENCE[toColumn]) {
    const picked = pickNamedOrLowestPosition(
      team.states.filter((s) => s.type === type),
      toColumn,
    );
    if (picked) return picked;
  }
  return null;
}

/** Decide the effect of dropping `task` into `toColumn` on `team`'s workflow. Pure. */
export function resolveLinearMove(
  task: Task,
  toColumn: BoardColumn,
  team: LinearTeamStates,
  settings: LinearMoveSettings,
): LinearMoveResolution {
  const local = resolveLocalMove(task, toColumn);
  const mirrored = task.externalSource === 'linear' && !!task.externalKey;
  const base = { localStatus: local.localStatus, preBlockStatus: local.preBlockStatus };

  // A no-op, an internal card, or BLOCKED: nothing to write to Linear. BLOCKED stays local even
  // when the team has a state that reads as blocked — see this file's header.
  if (local.noop || !mirrored || toColumn === 'blocked') {
    return { ...base, noop: local.noop, target: null, refusal: null };
  }

  const configured = configuredState(team, toColumn, settings);
  if (configured) {
    return { ...base, noop: false, target: { state: configured, via: 'configured' }, refusal: null };
  }

  for (const tier of STATUS_REASONS) {
    if (tier === 'category') continue; // tier 5 (position) takes this slot instead, below.
    const state = mappedTierState(team, toColumn, tier, settings);
    if (state) return { ...base, noop: false, target: { state, via: tier }, refusal: null };
  }

  const positioned = positionState(team, toColumn);
  if (positioned) {
    return { ...base, noop: false, target: { state: positioned, via: 'category' }, refusal: null };
  }

  return {
    ...base,
    noop: false,
    target: null,
    refusal: `Linear team ${team.teamKey} has no state for ${COLUMN_LABEL[toColumn]} — pick one in Settings → Linear.`,
  };
}

/**
 * Whether a drag has taught us something worth writing into `learnedStateColumns` — mirrors
 * `jiraMove.shouldLearnStatus`: a blank name says nothing, a blocked-ish name is never learned
 * (the map is shown to the user as facts the app believes), and a name already explicitly
 * mapped or already resolving to this column needs no entry.
 */
export function shouldLearnState(
  stateName: string,
  stateType: LinearStateType,
  column: BoardColumn,
  settings: LinearMoveSettings,
): boolean {
  const name = stateName.trim();
  if (!name) return false;
  if (isBlockedishStatus(name, linearCategory(stateType))) return false;
  const current = resolveLinearColumn(
    name,
    stateType,
    settings.stateColumnOverrides,
    settings.learnedStateColumns,
  );
  return current.reason !== 'explicit' && current.column !== column;
}
