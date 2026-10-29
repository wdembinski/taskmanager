/**
 * One ticket project's tickets — the seed and the two live subscriptions `BacklogTable.tsx`
 * used to own itself, lifted out so `Projects.tsx` can feed the same list into both
 * `BacklogTable` (F13.15) and the issue view reducer's `tickets` action (F13.13), without
 * either one re-fetching what the other already has.
 *
 * `BacklogTable` stays keyed by `projectId` at the call site, so a project switch still gets
 * it a clean remount; this hook is not keyed, so it resets `tickets` to `null` itself on a
 * `projectId` change, otherwise the freshly remounted table would flash the OUTGOING
 * project's tickets until this hook's own seed for the new one resolves.
 */
import type { TaskSummary } from '@tm/shared/taskSummary';
import type { InitialLoad } from '../useInitialLoad';
import { useTaskSummaries } from '../useTaskSummaries';

export interface ProjectTickets extends Pick<InitialLoad, 'error' | 'retry'> {
  /** This project's tickets, or `null` before the first load (or a project switch) has
   *  resolved. Card summaries (F29.2): the open ticket reads its heavy half itself. */
  tickets: TaskSummary[] | null;
}

/** Seeded and kept current by `useTaskSummaries` — a ticket leaving the project (deleted)
 *  arrives as a delta's `removed`, which no per-task patch would ever say. */
export function useProjectTickets(projectId: string | null): ProjectTickets {
  const { tasks, error, retry } = useTaskSummaries(projectId, { clearOnScopeChange: true });
  return { tickets: tasks, error, retry };
}
