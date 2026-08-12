/**
 * Everything the board needs that the MIRROR does not carry — read over the relay instead.
 *
 * `GET /v1/board` mirrors `Task` and `Project` rows and nothing else. The desktop's board
 * gets eight more lists from its engine (agent projects, merge requests, attachments, chain
 * links, the attention inbox, live runs, integrating cards, settings) and `BoardScreen`
 * simply did not pass them, which is why the shared detail pane rendered as a stub: with no
 * merge requests, no attachments, no chain and no agent projects, `TaskDetail` skips those
 * sections entirely.
 *
 * Every one of them is a relayable `IpcApi` read now, so this hook is the whole fix: load
 * them at mount, keep them fresh through `Transport.on` — which the web satisfies with
 * `PolledEventBus`, the desktop with real pushed events — and hand them straight to the
 * components that were always ready for them.
 *
 * WHY A SEPARATE HOOK FROM `useCloudBoard`
 * ----------------------------------------
 * Different failure modes and different cadences. `useCloudBoard` owns the mirror: it works
 * with the desktop asleep, because the server holds the rows. This one works only while a
 * desktop is polling, because every read is relayed to it. Folding them together would put
 * the board's own liveness behind the relay's, and a mirror that still worked offline is one
 * of the few things this app has that the RPC does not.
 *
 * So every read here fails soft to what it started as. An empty list is what the pane was
 * being given before any of this existed, and it is the right answer while nobody is home.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTransport } from '@tm/ui/transport';
import type { Project, Task } from '@tm/shared/model';
import type { TaskAttachment } from '@tm/shared/attachments';
import type { MergeRequest } from '@tm/shared/mergeRequest';
import type { LinkGate, TaskLink } from '@tm/shared/taskChain';
import type { AttentionItem } from '@tm/shared/attention';
import { DEFAULT_SETTINGS, type AppSettings } from '@tm/shared/settings';
import { buildAttentionIndex, type AttentionIndex } from '@tm/ui/attentionIndex';

export interface BoardExtras {
  agentProjects: Project[];
  mergeRequests: MergeRequest[];
  attachments: TaskAttachment[];
  chainLinks: TaskLink[];
  attention: AttentionIndex;
  liveRunTaskIds: ReadonlySet<string>;
  mergingTaskIds: ReadonlySet<string>;
  settings: AppSettings;
  /** Persist a settings change and reflect it immediately — see {@link useBoardExtras}. */
  saveSettings: (next: AppSettings) => Promise<void>;
  drawLink: (fromTaskId: string, toTaskId: string) => Promise<string | null>;
  removeLink: (linkId: string) => Promise<void>;
  setLinkGate: (linkId: string, gate: LinkGate) => Promise<void>;
  stopTask: (taskId: string) => Promise<void>;
  restoreTask: (taskId: string) => Promise<void>;
  /** Re-read everything. The board calls this after an edit whose event it cannot wait for. */
  refresh: () => void;
}

export function useBoardExtras(): BoardExtras {
  const transport = useTransport();

  const [agentProjects, setAgentProjects] = useState<Project[]>([]);
  const [mergeRequests, setMergeRequests] = useState<MergeRequest[]>([]);
  const [attachments, setAttachments] = useState<TaskAttachment[]>([]);
  const [chainLinks, setChainLinks] = useState<TaskLink[]>([]);
  const [attentionItems, setAttentionItems] = useState<AttentionItem[]>([]);
  const [liveRunTaskIds, setLiveRuns] = useState<ReadonlySet<string>>(new Set());
  const [mergingTaskIds, setMerging] = useState<ReadonlySet<string>>(new Set());
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [generation, setGeneration] = useState(0);

  const refresh = useCallback(() => setGeneration((g) => g + 1), []);

  useEffect(() => {
    let live = true;
    /** Fail soft: an unreachable desktop leaves the pane exactly as empty as it used to be. */
    const load = async <T>(run: () => Promise<T>, apply: (value: T) => void): Promise<void> => {
      try {
        const value = await run();
        if (live) apply(value);
      } catch {
        // Deliberately silent: eight reads, and one banner per failure during a desktop
        // restart would bury the board. The status bar's dot already says nobody is home.
      }
    };

    void load(() => transport.invoke('agentProject:list'), setAgentProjects);
    void load(() => transport.invoke('gitlab:mergeRequests'), setMergeRequests);
    void load(() => transport.invoke('attachment:list'), setAttachments);
    void load(() => transport.invoke('chain:links'), setChainLinks);
    void load(() => transport.invoke('attention:list'), setAttentionItems);
    void load(
      () => transport.invoke('scheduler:activeRuns'),
      (runs) => setLiveRuns(new Set(runs.map((r) => r.taskId))),
    );
    void load(
      () => transport.invoke('scheduler:integrating'),
      (ids) => setMerging(new Set(ids)),
    );
    void load(() => transport.invoke('settings:get'), setSettings);

    return () => {
      live = false;
    };
  }, [transport, generation]);

  // The whole-list events, each replacing rather than patching — exactly as `MyTasks` does,
  // and for the reason those events give: the list is the payload.
  useEffect(() => {
    const offs = [
      transport.on('gitlab:mergeRequestsChanged', setMergeRequests),
      transport.on('attachment:changed', setAttachments),
      transport.on('chain:changed', setChainLinks),
      transport.on('settings:changed', setSettings),
      transport.on('task:integrating', (ids) => setMerging(new Set(ids))),
      transport.on('attention:new', (item) =>
        setAttentionItems((prev) => [...prev.filter((i) => i.id !== item.id), item]),
      ),
      transport.on('attention:resolved', ({ id }) =>
        setAttentionItems((prev) => prev.filter((i) => i.id !== id)),
      ),
    ];
    return () => offs.forEach((off) => off());
  }, [transport]);

  const attention = useMemo(() => buildAttentionIndex(attentionItems), [attentionItems]);

  /**
   * Save settings and show the change at once.
   *
   * Optimistic on purpose: `settings:save` resolves to nothing, and waiting for the next
   * `settings:changed` poll to move a switch would make every toggle feel broken for a
   * couple of seconds. The engine MERGES a relayed save rather than overwriting
   * (`cloudCommands.ts`), so this cannot clobber what it learned in the meantime.
   */
  const saveSettings = useCallback(
    async (next: AppSettings) => {
      setSettings(next);
      await transport.invoke('settings:save', next);
    },
    [transport],
  );

  const drawLink = useCallback(
    async (fromTaskId: string, toTaskId: string) => {
      // Refusals come back as DATA (`LinkResult`), not as a rejection — the same contract
      // `MyTasks` reads, so a cycle or a duplicate is reported rather than thrown.
      const result = await transport.invoke('chain:link', fromTaskId, toTaskId);
      if (result.status === 'ok') {
        setChainLinks(result.links);
        return null;
      }
      return result.reason;
    },
    [transport],
  );

  const removeLink = useCallback(
    async (linkId: string) => setChainLinks(await transport.invoke('chain:unlink', linkId)),
    [transport],
  );

  const setLinkGate = useCallback(
    async (linkId: string, gate: LinkGate) =>
      setChainLinks(await transport.invoke('chain:setGate', linkId, gate)),
    [transport],
  );

  const stopTask = useCallback(
    async (taskId: string) => {
      await transport.invoke('task:stopAgent', taskId);
      // No event carries "this run stopped" to a browser — `task:changed` is reconstructed
      // from the mirror, which the desktop only pushes on its own next sync. Re-reading the
      // live set is what takes the spinner off the card now rather than in a few seconds.
      setLiveRuns(new Set((await transport.invoke('scheduler:activeRuns')).map((r) => r.taskId)));
    },
    [transport],
  );

  const restoreTask = useCallback(
    async (taskId: string) => {
      await transport.invoke('task:restore', taskId);
      // The restored row reaches this app through the mirror (the desktop's outbox trigger
      // fires for the write), so there is nothing to patch locally.
    },
    [transport],
  );

  return {
    agentProjects,
    mergeRequests,
    attachments,
    chainLinks,
    attention,
    liveRunTaskIds,
    mergingTaskIds,
    settings,
    saveSettings,
    drawLink,
    removeLink,
    setLinkGate,
    stopTask,
    restoreTask,
    refresh,
  };
}

/** Index the attachments by the task they hang off — the shape both panes want. */
export function byTask<T extends { taskId: string }>(rows: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.taskId);
    if (list) list.push(row);
    else map.set(row.taskId, [row]);
  }
  return map;
}

/** The merge requests a card owns, keyed the way `MyTasks` keys them. */
export function mergeRequestsByTask(rows: readonly MergeRequest[]): Map<string, MergeRequest[]> {
  const map = new Map<string, MergeRequest[]>();
  for (const mr of rows) {
    if (!mr.taskId) continue;
    const list = map.get(mr.taskId);
    if (list) list.push(mr);
    else map.set(mr.taskId, [mr]);
  }
  return map;
}

/** Only used to keep `Task` in scope for the exported helpers' inference. */
export type BoardTask = Task;
