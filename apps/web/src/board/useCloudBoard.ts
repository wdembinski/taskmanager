/**
 * Wires the pure pieces (`cloudBoardStore`, `BoardPoller`, `HttpTransport`) into React
 * state — the one hook `BoardScreen` reads from. Owns the poll loop's lifetime (started on
 * mount, disposed on unmount) and the optimistic overlay for a status change: queue it
 * locally the instant the drag lands, send the command, and either let the next board poll
 * reconcile it (`applyBoardResponse`) or roll it back if the send itself failed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CadenceDirective } from '@tm/protocol/cadence';
import type { ClientPresence } from '@tm/protocol/wire';
import type { ManualStatus, Project, Task } from '@tm/shared/model';
import type { CloudAuth } from '../auth/cloudAuth';
import type { WebConfig } from '../env';
import { createPresenceFocusSignal, PresenceHeartbeat } from '../presence';
import { BoardPoller } from './BoardPoller';
import { createBrowserFocusSignal } from './browserFocusSignal';
import { getOrCreateClientId } from './clientId';
import {
  EMPTY_BOARD_STATE,
  applyBoardResponse,
  clearPendingStatusChange,
  expirePendingStatusChanges,
  mergeProject,
  mergeTask,
  queuePendingStatusChange,
  type CloudBoardState,
} from './cloudBoardStore';
import { HttpTransport } from './httpTransport';
import { EMPTY_SYNC_PROGRESS, type SyncProgress } from './syncGate';
import { resolveTargetClientId, setPreferredClientId } from './targetClient';

/** How often the pending-overlay sweep runs — well under `PENDING_STATUS_TIMEOUT_MS`, so a
 *  timed-out change doesn't sit visibly stuck for most of its own timeout window. */
const EXPIRY_SWEEP_MS = 15_000;

export interface CloudBoardApi {
  state: CloudBoardState;
  cadence: CadenceDirective | null;
  /**
   * Epoch ms of the last poll that came *back*, or null before the first one lands.
   *
   * Held beside the board rather than inside `CloudBoardState` because it is a fact about
   * this tab's network, not about the mirror: a poll that returns no deltas at all still
   * proves the connection is alive, and the status bar's "synced Ns ago" is exactly that
   * claim. Folding it into the store would also churn a value four tests construct.
   */
  lastPolledAt: number | null;
  /** How far the board's own read loop has gotten — see `syncGate.ts`'s `boardIsReady` for
   *  the latch rule this drives. */
  syncProgress: SyncProgress;
  /**
   * Why the last board read failed, or null when the last one came back.
   *
   * Held beside the board for the same reason `lastPolledAt` is — it is a fact about this
   * tab's network rather than about the mirror — and it exists because its absence was a bug:
   * a failing read went to `console.warn` and the status bar went on saying "first sync
   * pending", which reads as "still loading" and never stops. A tab that has never once
   * reached the server must not present as a tab looking at an empty board. See
   * `UnreachableBanner`.
   */
  pollError: string | null;
  /** The desktop Client a command would be sent to, or null if none has ever synced. */
  targetClientId: string | null;
  /**
   * That same Client's presence entry, when it is one of the live ones — which is what
   * carries its `ClientInfo`, and so everything the status bar needs to NAME it.
   *
   * Null while the target is only a remembered id (`targetClientId` outlives presence by
   * design, so a queued edit still has an addressee): a Client that is not polling is not in
   * the list, so there is nothing current to say about it.
   */
  targetClient: ClientPresence | null;
  /** Point this browser at a specific desktop — the status bar's picker, persisted. */
  selectTargetClient: (clientId: string) => void;
  /** The `Transport` this session's `<TransportProvider>` wraps the tree in — see
   *  `packages/ui/src/transport.tsx`. */
  transport: HttpTransport;
  setStatus: (taskId: string, status: ManualStatus) => Promise<void>;
  /** Record a status change the detail pane already sent — see the implementation. */
  noteStatus: (taskId: string, status: ManualStatus) => void;
  // No `createTask` here any more: the shared add-task dialog calls `task:create` on the
  // transport itself, like every other write under `TaskDetail`, and a second path through
  // this hook could only ever be the narrower one (see `httpTransport.ts`).
  /** Drop a project the hub just created or edited straight into the mirror — see
   *  `cloudBoardStore.mergeProject`. */
  upsertProject: (project: Project) => void;
  /** Drop a ticket the backlog/epics/ticket-detail pages just created or edited straight
   *  into the mirror — see `cloudBoardStore.mergeTask`. */
  upsertTask: (task: Task) => void;
}

export function useCloudBoard(auth: CloudAuth, config: WebConfig): CloudBoardApi {
  const clientId = useMemo(() => getOrCreateClientId(window.localStorage), []);
  const [state, setState] = useState<CloudBoardState>(EMPTY_BOARD_STATE);
  const [lastPolledAt, setLastPolledAt] = useState<number | null>(null);
  const [syncProgress, setSyncProgress] = useState<SyncProgress>(EMPTY_SYNC_PROGRESS);
  const [pollError, setPollError] = useState<string | null>(null);

  // The poller and the transport are each built once and live for the component's whole
  // lifetime; both need the LATEST state (the cursor to poll `since`, the freshest
  // `clients` list to target) without being torn down and rebuilt on every poll tick, which
  // is exactly what closing over `state` in their `useMemo`/`useEffect` deps would do. A
  // ref is the standard escape hatch: written on every render, read from callbacks that
  // don't themselves need to re-run when it changes.
  const stateRef = useRef(state);
  stateRef.current = state;

  // The picked target lives in `localStorage`, not in state: the transport reads it through
  // a ref, outside React, on a call that may happen between renders. This counter exists only
  // to make a pick re-render the tree that displays it — nothing reads its value.
  const [, notePreferenceChanged] = useState(0);
  const targetClientId = resolveTargetClientId(window.localStorage, state.clients);
  const targetClient = state.clients.find((client) => client.id === targetClientId) ?? null;

  const selectTargetClient = useCallback((id: string) => {
    setPreferredClientId(window.localStorage, id);
    notePreferenceChanged((n) => n + 1);
  }, []);

  const transport = useMemo(
    () =>
      new HttpTransport({
        apiBase: config.cloudApiBase,
        clientId,
        getAccessToken: () => auth.getAccessToken(),
        getTargetClientId: () =>
          resolveTargetClientId(window.localStorage, stateRef.current.clients),
        // Read through the ref for the same reason the target is: the transport outlives
        // every poll, and this has to be the freshest answer at the moment a call times out
        // rather than the one that was true when it was built.
        hasLiveClient: () => stateRef.current.clients.length > 0,
        // Its own signal rather than the poller's below: both are the same `visibilitychange`
        // reading, and the transport outlives the effect that builds the poller.
        focus: createBrowserFocusSignal(),
      }),
    [auth, config.cloudApiBase, clientId],
  );

  // Everything still awaiting an answer fails loudly when the tab tears down, rather than
  // leaving a promise nobody will ever settle.
  useEffect(() => () => transport.dispose(), [transport]);

  // The media token lives outside React (it is read synchronously while rendering an
  // `<img src>` — see `mediaToken.ts`), so its arrival changes no state on its own. This is
  // the one hop that turns it into a render, exactly as `notePreferenceChanged` above does
  // for the picked target: nothing reads the counter's value.
  const [, noteMediaToken] = useState(0);
  useEffect(() => transport.onMediaTokenChange(() => noteMediaToken((n) => n + 1)), [transport]);

  useEffect(() => {
    const focus = createBrowserFocusSignal();
    const poller = new BoardPoller({
      apiBase: config.cloudApiBase,
      clientId,
      focus,
      getAccessToken: () => auth.getAccessToken(),
      getCursor: () => stateRef.current.cursor,
      onResponse: (response) => {
        setState((s) => applyBoardResponse(s, response));
        setLastPolledAt(Date.now());
        setSyncProgress((p) => ({
          ...p,
          draining: response.hasMore === true,
          initialSyncComplete: p.initialSyncComplete || response.hasMore !== true,
          failures: 0,
          lastError: null,
        }));
        // Cleared on the way back up, not on the way out: a read that succeeds is the only
        // thing that ends an outage, and clearing optimistically would flicker the banner off
        // and on for every tick of one.
        setPollError(null);
      },
      onError: (e) => {
        console.warn('board poll failed', e);
        setSyncProgress((p) => ({
          ...p,
          failures: p.failures + 1,
          lastError: e instanceof Error ? e.message : String(e),
        }));
        setPollError(e instanceof Error ? e.message : String(e));
      },
      onPollingChange: (polling) => setSyncProgress((p) => ({ ...p, polling })),
    });
    void poller.tick(); // load immediately rather than waiting a full cadence interval
    return () => poller.dispose();
  }, [auth, config.cloudApiBase, clientId]);

  useEffect(() => {
    const heartbeat = new PresenceHeartbeat({
      apiBase: config.cloudApiBase,
      clientId,
      focus: createPresenceFocusSignal(),
      getAccessToken: () => auth.getAccessToken(),
    });
    return () => heartbeat.dispose();
  }, [auth, config.cloudApiBase, clientId]);

  useEffect(() => {
    const id = setInterval(
      () => setState((s) => expirePendingStatusChanges(s, Date.now())),
      EXPIRY_SWEEP_MS,
    );
    return () => clearInterval(id);
  }, []);

  const setStatus = useCallback(
    async (taskId: string, status: ManualStatus) => {
      const commandId = crypto.randomUUID();
      setState((s) =>
        queuePendingStatusChange(s, { commandId, taskId, status, issuedAt: Date.now() }),
      );
      try {
        await transport.invoke('task:setStatus', taskId, status);
      } catch (e) {
        setState((s) => clearPendingStatusChange(s, commandId));
        throw e;
      }
    },
    [transport],
  );

  /**
   * The same optimistic overlay {@link setStatus} queues, for a change that has ALREADY been
   * sent by someone else — the shared `TaskDetail`, whose State dropdown calls
   * `task:setStatus` on the transport itself and then reports what came back. Sending a
   * second, identical command from here would be the only other way to get the card to move
   * before the next poll, and this is the honest half of that.
   */
  const noteStatus = useCallback((taskId: string, status: ManualStatus) => {
    setState((s) =>
      queuePendingStatusChange(s, {
        commandId: crypto.randomUUID(),
        taskId,
        status,
        issuedAt: Date.now(),
      }),
    );
  }, []);

  const upsertProject = useCallback((project: Project) => {
    setState((s) => mergeProject(s, project));
  }, []);

  const upsertTask = useCallback((task: Task) => {
    setState((s) => mergeTask(s, task));
  }, []);

  return {
    state,
    cadence: state.cadence,
    lastPolledAt,
    syncProgress,
    pollError,
    targetClientId,
    targetClient,
    selectTargetClient,
    transport,
    setStatus,
    noteStatus,
    upsertProject,
    upsertTask,
  };
}
