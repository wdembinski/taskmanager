/**
 * Loads whatever `TaskDetail` needs for one task id that the caller does not already hold,
 * and renders the pane with the result.
 *
 * Every board already carries most of this (its own tasks, merge requests, attachments,
 * chain, attention, live runs) — passing it through costs nothing and skips a fetch the host
 * would otherwise redo. A host with nothing of its own, or a caller that has not wired a
 * particular prop through yet, gets it fetched here instead. See `./taskDetailHost.ts` for
 * the pure rules (`neededLoads`, `assembleTaskDetailProps`) this only wires up to a
 * `Transport`.
 *
 * The ticket registries (`people`/`milestones`/`labels`/`ticketLinks`) are deliberately NOT
 * loaded here — both boards already pass them from `useTicketRegistries` (F12.6), and
 * `TaskDetail` itself falls back to empty pickers and its own `useTicketLinks` when they are
 * absent, so a future caller with none of its own degrades exactly as it does today.
 *
 * Filed as `TaskDetailHostView.tsx`, not `TaskDetailHost.tsx`: the exported component is
 * still `TaskDetailHost`, but that filename would differ from `./taskDetailHost.ts`'s only
 * in the first letter's case, and an extension-less `./TaskDetailHost` import resolves to
 * whichever of the two a case-insensitive filesystem (Windows' default) or `tsc`'s
 * `forceConsistentCasingInFileNames` happens to match first — silently handing a caller the
 * pure module instead of this component.
 */
import { useEffect, useState } from 'react';
import type { Task } from '@tm/shared/model';
import type { MergeRequest } from '@tm/shared/mergeRequest';
import type { TaskAttachment } from '@tm/shared/attachments';
import type { TaskLink } from '@tm/shared/taskChain';
import type { AttentionItem } from '@tm/shared/attention';
import { TaskDetail } from './TaskDetail';
import {
  assembleTaskDetailProps,
  neededLoads,
  type LoadedTaskDetailData,
  type TaskDetailHostProps,
} from './taskDetailHost';
import { useTransport } from './transport';

export function TaskDetailHost(props: TaskDetailHostProps): JSX.Element {
  const { taskId } = props;
  const transport = useTransport();
  const loads = neededLoads(props);

  const needTasks = loads.has('tasks');
  const needLiveRuns = loads.has('liveRuns');
  const needMergeRequests = loads.has('mergeRequests');
  const needAttachments = loads.has('attachments');
  const needChainLinks = loads.has('chainLinks');
  const needAttention = loads.has('attention');
  const needMerging = loads.has('merging');

  const [tasks, setTasks] = useState<readonly Task[] | undefined>(undefined);
  const [liveRunTaskIds, setLiveRunTaskIds] = useState<ReadonlySet<string> | undefined>(undefined);
  const [mergeRequests, setMergeRequests] = useState<readonly MergeRequest[] | undefined>(
    undefined,
  );
  const [attachments, setAttachments] = useState<readonly TaskAttachment[] | undefined>(undefined);
  const [chainLinks, setChainLinks] = useState<readonly TaskLink[] | undefined>(undefined);
  const [attentionItems, setAttentionItems] = useState<readonly AttentionItem[] | undefined>(
    undefined,
  );
  const [mergingTaskIds, setMergingTaskIds] = useState<ReadonlySet<string> | undefined>(undefined);

  // `board:tasks` and `scheduler:activeRuns`, together: a task's own status changing is
  // exactly what moves it into or out of a live run, so one `task:changed` reloads both.
  useEffect(() => {
    if (!needTasks && !needLiveRuns) return;
    let live = true;
    const reload = (): void => {
      if (needTasks) void transport.invoke('board:tasks', 'all').then((v) => live && setTasks(v));
      if (needLiveRuns) {
        void transport
          .invoke('scheduler:activeRuns')
          .then((runs) => live && setLiveRunTaskIds(new Set(runs.map((r) => r.taskId))));
      }
    };
    reload();
    const off = transport.on('task:changed', reload);
    return () => {
      live = false;
      off();
    };
  }, [transport, needTasks, needLiveRuns]);

  useEffect(() => {
    if (!needMergeRequests) return;
    let live = true;
    void transport.invoke('mr:mergeRequests').then((v) => live && setMergeRequests(v));
    const off = transport.on('mergeRequests:changed', setMergeRequests);
    return () => {
      live = false;
      off();
    };
  }, [transport, needMergeRequests]);

  useEffect(() => {
    if (!needAttachments) return;
    let live = true;
    void transport.invoke('attachment:list').then((v) => live && setAttachments(v));
    const off = transport.on('attachment:changed', setAttachments);
    return () => {
      live = false;
      off();
    };
  }, [transport, needAttachments]);

  useEffect(() => {
    if (!needChainLinks) return;
    let live = true;
    void transport.invoke('chain:links').then((v) => live && setChainLinks(v));
    const off = transport.on('chain:changed', setChainLinks);
    return () => {
      live = false;
      off();
    };
  }, [transport, needChainLinks]);

  // Patches the flat item list rather than replacing it outright on every push — the same
  // rule `useBoardExtras` applies, so a card's ring does not flicker through "no items" on
  // every unrelated question arriving elsewhere on the board.
  useEffect(() => {
    if (!needAttention) return;
    let live = true;
    void transport.invoke('attention:list').then((v) => live && setAttentionItems(v));
    const offs = [
      transport.on('attention:new', (item) =>
        setAttentionItems((prev) => [...(prev ?? []).filter((i) => i.id !== item.id), item]),
      ),
      transport.on('attention:resolved', ({ id }) =>
        setAttentionItems((prev) => prev?.filter((i) => i.id !== id)),
      ),
    ];
    return () => {
      live = false;
      offs.forEach((off) => off());
    };
  }, [transport, needAttention]);

  useEffect(() => {
    if (!needMerging) return;
    let live = true;
    void transport
      .invoke('scheduler:integrating')
      .then((ids) => live && setMergingTaskIds(new Set(ids)));
    const off = transport.on('task:integrating', (ids) => setMergingTaskIds(new Set(ids)));
    return () => {
      live = false;
      off();
    };
  }, [transport, needMerging]);

  const loaded: LoadedTaskDetailData = {
    tasks,
    mergeRequests,
    attachments,
    chainLinks,
    attentionItems,
    liveRunTaskIds,
    mergingTaskIds,
  };

  return <TaskDetail {...assembleTaskDetailProps(taskId, props, loaded)} />;
}
