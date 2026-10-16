/**
 * Pure helpers over the app-wide milestone/label registries `useTicketRegistries` loads once —
 * kept apart from the hook for the same reason `backlogView.ts` is: neither needs a DOM.
 */
import type { Milestone, TicketLabel } from '@tm/shared/model';

export interface ScopedTicketRegistries {
  milestones: Milestone[];
  labels: TicketLabel[];
}

/**
 * `milestones`/`labels`, narrowed to `projectId` — empty for `null` (nothing selected yet).
 *
 * Closed milestones stay in: a project's timeline still plots their markers, a closed
 * milestone's chip still needs its colour, and a ticket already pointed at one still needs
 * its name. Only the PICKER — {@link offeredMilestones} — drops them.
 */
export function scopeTicketRegistries(
  projectId: string | null,
  milestones: readonly Milestone[],
  labels: readonly TicketLabel[],
): ScopedTicketRegistries {
  if (!projectId) return { milestones: [], labels: [] };
  return {
    milestones: milestones.filter((m) => m.projectId === projectId),
    labels: labels.filter((l) => l.projectId === projectId),
  };
}

/**
 * The milestone picker's own rule, lifted from `TicketDrawer`: open milestones, plus
 * `currentId`'s even when closed — a ticket already on a closed milestone keeps showing it
 * selected rather than silently falling back to "None".
 */
export function offeredMilestones(
  milestones: readonly Milestone[],
  currentId?: string | null,
): Milestone[] {
  return milestones.filter((m) => !m.closed || m.id === currentId);
}
