/**
 * The three live feeds an issue row's run pill and PR ref read, loaded through the transport
 * the same way the board does (`MyTasks.tsx`, `TaskDetailHostView.tsx`), so a list row and a
 * board card for the same ticket never disagree:
 *
 * - `scheduler:activeRuns`, re-read on `task:changed` — a task's own status changing is
 *   exactly what moves it into or out of a live run.
 * - `mr:mergeRequests`, replaced whole by `mergeRequests:changed`.
 * - `scheduler:integrating`, replaced whole by `task:integrating` (a merge changes nothing
 *   else while it runs; see `useIntegratingTasks.ts`).
 */
import { useEffect, useState } from 'react';
import type { MergeRequest } from '@tm/shared/mergeRequest';
import { useTransport } from '../transport';

export interface IssueRowFeeds {
  liveRunTaskIds: ReadonlySet<string>;
  mergeRequests: readonly MergeRequest[];
  mergingTaskIds: ReadonlySet<string>;
}

export function useIssueRowFeeds(): IssueRowFeeds {
  const transport = useTransport();
  const [liveRunTaskIds, setLiveRunTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const [mergeRequests, setMergeRequests] = useState<readonly MergeRequest[]>([]);
  const [mergingTaskIds, setMergingTaskIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    let live = true;
    const reload = (): void => {
      void transport
        .invoke('scheduler:activeRuns')
        .then((runs) => live && setLiveRunTaskIds(new Set(runs.map((r) => r.taskId))));
    };
    reload();
    const off = transport.on('task:changed', reload);
    return () => {
      live = false;
      off();
    };
  }, [transport]);

  useEffect(() => {
    let live = true;
    void transport.invoke('mr:mergeRequests').then((v) => live && setMergeRequests(v));
    const off = transport.on('mergeRequests:changed', setMergeRequests);
    return () => {
      live = false;
      off();
    };
  }, [transport]);

  useEffect(() => {
    let live = true;
    void transport
      .invoke('scheduler:integrating')
      .then((ids) => live && setMergingTaskIds(new Set(ids)));
    const off = transport.on('task:integrating', (ids) => setMergingTaskIds(new Set(ids)));
    return () => {
      live = false;
      off();
    };
  }, [transport]);

  return { liveRunTaskIds, mergeRequests, mergingTaskIds };
}
