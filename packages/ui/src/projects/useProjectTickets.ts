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
import { useCallback, useEffect, useState } from 'react';
import type { Task } from '@tm/shared/model';
import { useTransport } from '../transport';
import { useInitialLoad, type InitialLoad } from '../useInitialLoad';

export interface ProjectTickets extends Pick<InitialLoad, 'error' | 'retry'> {
  /** This project's tickets, or `null` before the first load (or a project switch) has
   *  resolved. */
  tickets: Task[] | null;
}

export function useProjectTickets(projectId: string | null): ProjectTickets {
  const transport = useTransport();
  const [tickets, setTickets] = useState<Task[] | null>(null);

  const seed = useCallback(async () => {
    if (!projectId) return;
    setTickets(await transport.invoke('board:tasks', projectId));
  }, [transport, projectId]);
  const initial = useInitialLoad(seed);

  useEffect(() => {
    setTickets(null);
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    const offTask = transport.on('task:changed', ({ task }) => {
      if (task.projectId !== projectId) return;
      setTickets((prev) => (prev ? prev.map((t) => (t.id === task.id ? task : t)) : prev));
    });
    // The whole list, replaced — a ticket can also leave this way (deleted), which no
    // per-task patch would ever say.
    const offTasks = transport.on('project:tasksChanged', ({ projectId: changed, tasks }) => {
      if (changed !== projectId) return;
      setTickets(tasks);
    });
    return () => {
      offTask();
      offTasks();
    };
  }, [transport, projectId]);

  return { tickets, error: initial.error, retry: initial.retry };
}
