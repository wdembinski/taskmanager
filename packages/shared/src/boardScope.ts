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
