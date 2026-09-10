/**
 * The pure half of `AssigneeDisplay`: what to draw, decided once so the component itself
 * only draws it. Split out (the way `boardColumns.ts` sits beside `TaskCard.tsx`) so the
 * decision — nothing, a human, an agent, or both joined by " / " — is testable without a
 * renderer.
 */
import type { Person } from '@tm/shared/model';

export interface AssigneeDisplayParts {
  assignee?: Pick<Person, 'name' | 'initials' | 'color'>;
  agentName?: string;
  /** The tooltip, resolved the same way for every caller that does not override it. */
  title: string;
}

/**
 * `null` for neither an assignee nor an agent — the one case every caller draws nothing
 * for. Otherwise the parts to draw, with the tooltip title resolved (name-joined by " / "
 * when both are present) unless the caller supplied its own wording.
 */
export function assigneeDisplayParts(
  assignee: Pick<Person, 'name' | 'initials' | 'color'> | undefined,
  agentName: string | undefined,
  title?: string,
): AssigneeDisplayParts | null {
  if (!assignee && !agentName) return null;
  return {
    assignee,
    agentName,
    title: title ?? [assignee?.name, agentName].filter(Boolean).join(' / '),
  };
}
