/**
 * Wires the pure pieces (`cloudBoardStore`, `BoardPoller`, `HttpTransport`) into React
 * state — the one hook `BoardScreen` reads from. Owns the poll loop's lifetime (started on
 * mount, disposed on unmount) and the optimistic overlay for a status change: queue it
 * locally the instant the drag lands, send the command, and either let the next board poll
 * reconcile it (`applyBoardResponse`) or roll it back if the send itself failed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CadenceDirective } from '@tm/protocol/cadence';
import type { ManualStatus } from '@tm/shared/model';
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
  queuePendingStatusChange,
  type CloudBoardState,
} from './cloudBoardStore';
import { HttpTransport } from './httpTransport';
import { resolveTargetClientId } from './targetClient';

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
  /** The desktop Client a command would be sent to, or null if none has ever synced. */
  targetClientId: string | null;
  /** The `Transport` this session's `<TransportProvider>` wraps the tree in — see
   *  `packages/ui/src/transport.tsx`. */
  transport: HttpTransport;
  setStatus: (taskId: string, status: ManualStatus) => Promise<void>;
  /** Record a status change the detail pane already sent — see the implementation. */
  noteStatus: (taskId: string, status: ManualStatus) => void;
  createTask: (projectId: string, input: { title: string; phase?: string }) => Promise<void>;
}

export function useCloudBoard(auth: CloudAuth, config: WebConfig): CloudBoardApi {
  const clientId = useMemo(() => getOrCreateClientId(window.localStorage), []);
  const [state, setState] = useState<CloudBoardState>(EMPTY_BOARD_STATE);
  const [lastPolledAt, setLastPolledAt] = useState<number | null>(null);

  // The poller and the transport are each built once and live for the component's whole
  // lifetime; both need the LATEST state (the cursor to poll `since`, the freshest
  // `clients` list to target) without being torn down and rebuilt on every poll tick, which
  // is exactly what closing over `state` in their `useMemo`/`useEffect` deps would do. A
  // ref is the standard escape hatch: written on every render, read from callbacks that
  // don't themselves need to re-run when it changes.
  const stateRef = useRef(state);
  stateRef.current = state;

  const targetClientId = resolveTargetClientId(window.localStorage, state.clients);

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
      }),
    [auth, config.cloudApiBase, clientId],
  );

  // Everything still awaiting an answer fails loudly when the tab tears down, rather than
  // leaving a promise nobody will ever settle.
  useEffect(() => () => transport.dispose(), [transport]);

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
      },
      onError: (e) => console.warn('board poll failed', e),
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

  const createTask = useCallback(
    async (projectId: string, input: { title: string; phase?: string }) => {
      await transport.invoke('task:create', projectId, input);
    },
    [transport],
  );

  return {
    state,
    cadence: state.cadence,
    lastPolledAt,
    targetClientId,
    transport,
    setStatus,
    noteStatus,
    createTask,
  };
}
