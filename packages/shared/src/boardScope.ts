/**
 * Which project a My Tasks board may be scoped to (Phase 24: native tickets).
 *
 * A board is a QUERY over one project's cards — the built-in Personal board, or a native
 * ticket project's own. Pure so `board:scopes` and, later, the scope picker answer from the
 * same list rather than each re-deriving which projects count as boards.
 *
 * No React, no DB. See `ProjectKind` in `@shared/model`.
 */
import { PERSONAL_PROJECT_ID, type Project } from './model';

/** One board a project makes available. */
export interface BoardScope {
  projectId: string;
  name: string;
  /** `''` for the Personal board, or a ticket project with no prefix set yet. */
  ticketPrefix: string;
}

/** The Personal board's own scope — always present, and always first. */
const PERSONAL_SCOPE: BoardScope = {
  projectId: PERSONAL_PROJECT_ID,
  name: 'Personal',
  ticketPrefix: '',
};

/**
 * Every board a project list makes available, Personal first.
 *
 * The Personal scope is SYNTHESIZED rather than read out of `projects`: the caller may hand
 * over every project row, only the ticket ones, or none at all, and the Personal board exists
 * regardless of whether its own seeded row is among them.
 *
 * Only `kind: 'ticket'` projects become scopes of their own — a plan project is a queue and
 * an agent project is a delegation target, neither a board a human arranges cards on. A
 * ticket project with no prefix yet (it cannot allocate a key until one is set) is still a
 * real scope: the Projects screen is exactly where that gets fixed.
 */
export function boardScopes(
  projects: readonly Pick<Project, 'id' | 'kind' | 'name' | 'ticketPrefix'>[],
): BoardScope[] {
  const scopes = [PERSONAL_SCOPE];
  for (const project of projects) {
    if (project.kind !== 'ticket' || project.id === PERSONAL_PROJECT_ID) continue;
    scopes.push({
      projectId: project.id,
      name: project.name,
      ticketPrefix: project.ticketPrefix,
    });
  }
  return scopes;
}

/**
 * The scope `AppSettings.boardScopeId` names, or Personal when that id is `null`,
 * `undefined`, or no longer among `scopes` — a ticket project removed out from under a
 * saved scope must resolve the board back to Personal rather than to nothing.
 *
 * Falls back to `scopes[0]` rather than the module's own `PERSONAL_SCOPE` constant: the
 * caller's list is the one actually on screen, and `boardScopes` guarantees Personal is
 * first in it — so this stays correct even if a caller ever seeds the picker from something
 * other than a live `projects` table.
 */
export function resolveBoardScope(
  scopes: readonly BoardScope[],
  scopeId: string | null | undefined,
): BoardScope {
  return scopes.find((scope) => scope.projectId === scopeId) ?? scopes[0] ?? PERSONAL_SCOPE;
}

/**
 * A scope's label in the board's scope picker — its ticket prefix in parentheses when it has
 * one, since the name alone repeats what the Projects screen already showed and drops the
 * one fact (its key) a picker exists to distinguish. Personal, and a ticket project with no
 * prefix set yet, show the bare name.
 */
export function scopeLabel(scope: BoardScope): string {
  return scope.ticketPrefix ? `${scope.name} (${scope.ticketPrefix})` : scope.name;
}
