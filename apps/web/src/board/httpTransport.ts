/**
 * The `Transport` `packages/ui/src/transport.tsx` asks any host app for — apps/client's is
 * `window.api` (the preload bridge); this is apps/web's, an HTTP client over the mirror API.
 * `BoardScreen` and everything under `TaskDetail` reach it the same way any `@tm/ui`
 * component would, `useTransport().invoke('task:setStatus', …)`, so the write path this app
 * has is the same shape the desktop's IPC calls are — not a second, web-only vocabulary.
 *
 * IT IS A REAL RPC NOW
 * --------------------
 * This used to be three tiers: two relayed writes, a handful of stubbed reads that answered
 * the empty truth, and a refusal for everything else. The stub tier is gone. A stub is a
 * claim this app makes about the world ("there are no live runs"), and every one of them was
 * a lie the moment a desktop client was actually polling.
 *
 * `invoke` now posts an `ipc-invoke` command (`@tm/protocol/wire`), holds the promise, and
 * polls `GET /v1/results` until the desktop answers. The desktop runs its OWN handler for
 * that channel (`apps/client/src/main/ipcRegistry.ts`), so the answer is the real one.
 *
 * Two tiers are left:
 *  1. **Relayed** — anything `@tm/shared/ipcRelay` marks `'relay'`, which is most of `IpcApi`.
 *  2. **Host-only** — refused locally, with the reason from that same shared policy, so the
 *     sentence a human reads is written once and not once per side. The engine refuses these
 *     again if a command reaches it anyway; this refusal is the courtesy that makes the click
 *     fail immediately instead of after a round trip.
 *
 * `task:setStatus` keeps its own path as the older, narrower `set-status` command kind: its
 * effect is observed through the mirror and needs no result to come back at all, so it
 * resolves as soon as the command is queued rather than waiting on a desktop poll. That is
 * not a shortcut — it is the discipline this file already established, that an RPC's EFFECT
 * is observed through the mirror and not through its return value. `BoardScreen` owns the
 * optimistic overlay for the gap (`cloudBoardStore.ts`).
 *
 * `task:create` USED to have the same treatment and no longer does. The difference is what
 * the two calls' return values are worth. Nobody reads what a status change hands back; the
 * add-task dialog reads the created `Task` and keeps working on it — a JIRA ticket adopts its
 * id, a chain link is drawn to it, files are copied onto it — and the fabricated
 * `pending:<uuid>` row this returned could not be any of those things. Worse, `create-task`
 * carries four fields, so everything else the shared dialog asks for (type, filing, parent)
 * was dropped on the floor by the kind itself. Relayed, the desktop runs its own
 * `task:create` handler and answers with the real row.
 *
 * POLLING, NOT PUSHING
 * --------------------
 * There is no event feed (docs/plan/README.md's "No realtime service"), so a result is
 * fetched rather than delivered. The poll runs **only while something is pending** and
 * widens as it waits, so request volume is bounded by clicks rather than by wall time: a tab
 * left open with nothing in flight makes no results requests at all.
 */
import {
  PROTOCOL_VERSION,
  type CommandEnvelope,
  type CommandRequest,
  type ResultsResponse,
} from '@tm/protocol/wire';
import { hostOnlyMessage, isRelayable } from '@tm/shared/ipcRelay';
import type { IpcApi, IpcEvents } from '@tm/shared/ipc';
import type { ManualStatus, Task } from '@tm/shared/model';
import { BOARD_CLIENT_HEADER } from '@tm/protocol/wire';
import type { Transport } from '@tm/ui/transport';
import { PolledEventBus } from './polledEvents';

/**
 * How fast results are polled while a call is in flight, and how far that widens.
 *
 * Starts tight because the common relayed channel is a `Store` read that the desktop answers
 * in single-digit milliseconds — the latency a human feels is almost entirely the desktop's
 * own poll interval, so anything slower here would add to a wait that is already the longest
 * part. It widens because the calls that DON'T come back fast (`jira:sync`, `gitlab:sync`)
 * are minutes-scale, and hammering for two minutes to save a fraction of a second on the
 * last poll is the wrong trade.
 */
const RESULT_POLL_START_MS = 300;
const RESULT_POLL_MAX_MS = 2_500;
const RESULT_POLL_WIDEN = 1.5;

/**
 * How long a pending call waits before giving up.
 *
 * Longer than any relayed handler is expected to take, because timing out a call that WOULD
 * have answered is the worse failure: the command has already been applied on the desktop by
 * then, so the human sees an error beside an edit that actually landed. Three minutes covers
 * a full tracker sync with room to spare.
 */
export const RPC_TIMEOUT_MS = 180_000;

export interface HttpTransportDeps {
  apiBase: string;
  /** This browser session's own id — becomes `CommandEnvelope.issuedBy`, and the scope
   *  `GET /v1/results` reads back by. */
  clientId: string;
  getAccessToken: () => Promise<string | null>;
  /** The desktop Client to relay a command to, or null when none has ever synced this
   *  account — see `targetClient.ts`. */
  getTargetClientId: () => string | null;
  /**
   * Whether a desktop client is polling RIGHT NOW — `BoardResponse.clients`, which the board
   * hook already has. Used only to tell "nobody is listening" apart from "nobody has answered
   * yet" in a timeout message, which are two very different things to be told.
   */
  hasLiveClient?: () => boolean;
  fetchImpl?: typeof fetch;
  newCommandId?: () => string;
  now?: () => number;
  /** Injected so a test does not have to wait out a real interval. */
  setTimeoutImpl?: typeof setTimeout;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  channel: string;
  startedAt: number;
}

export class HttpTransport implements Transport {
  private readonly pending = new Map<string, Pending>();
  private polling = false;
  private resultCursor: string | null = null;
  private readonly events: PolledEventBus;

  constructor(private readonly deps: HttpTransportDeps) {
    this.events = new PolledEventBus({
      invoke: (channel, ...args) =>
        this.invoke(channel, ...args) as Promise<Awaited<ReturnType<IpcApi[typeof channel]>>>,
    });
  }

  invoke<K extends keyof IpcApi>(
    channel: K,
    ...args: Parameters<IpcApi[K]>
  ): ReturnType<IpcApi[K]> {
    // The one kind that predates the relay and still earns its place: its effect is observed
    // through the mirror, so waiting for a result would be waiting for nothing.
    if (channel === 'task:setStatus') {
      const [taskId, status] = args as Parameters<IpcApi['task:setStatus']>;
      return this.setStatus(taskId, status) as ReturnType<IpcApi[K]>;
    }
    if (!isRelayable(channel)) {
      return Promise.reject(new Error(hostOnlyMessage(channel))) as ReturnType<IpcApi[K]>;
    }
    return this.relay(channel, args) as ReturnType<IpcApi[K]>;
  }

  on<K extends keyof IpcEvents>(channel: K, callback: (payload: IpcEvents[K]) => void): () => void {
    return this.events.on(channel, callback);
  }

  pathForFile(_file: File): string {
    // No such thing as a filesystem path for a file picked in a browser — see Transport's
    // own docstring, and `attachmentUrl` below for the other half of the same problem.
    return '';
  }

  /**
   * Where a browser fetches an attachment's bytes from — and the honest answer today is
   * NOWHERE, so this returns `''`.
   *
   * The desktop answers `vipper-attachment://a/<id>`, a custom scheme registered only in
   * Electron. A browser cannot resolve it, so every `<img src>` in the shared attachment
   * strip was pointed at a URL that could never load. That is the bug this resolver exists
   * to end: the shared component asks the HOST where the bytes are instead of hardcoding
   * one host's answer.
   *
   * Making the web's answer a real URL needs the bytes to be on the server, and they are
   * not: the mirror carries `Task` and `Project` rows, and `attachment:add` takes paths by
   * explicit design (an attachment can be a 30 MB video). Building that — an upload route,
   * a desktop-side handler that writes the blob under `userData/attachments/`, and a
   * download that streams it back — is written up as owed in docs/plan/README.md Phase 26.
   *
   * Until then `''`, which the strip reads as "this host cannot show a preview" and answers
   * with the chip alone. Returning a plausible URL to a route that 404s would look exactly
   * the same on screen and be a claim that was not true.
   */
  attachmentUrl(): string {
    return '';
  }

  /** Stop the result poll and fail everything still waiting. Called when the tab tears down. */
  dispose(): void {
    this.events.dispose();
    for (const [, entry] of this.pending) {
      entry.reject(new Error('The page is closing.'));
    }
    this.pending.clear();
  }

  private relay(channel: string, args: readonly unknown[]): Promise<unknown> {
    const id = this.mintId();
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, channel, startedAt: this.clock() });
      void this.sendCommand('ipc-invoke', { channel, args }, id).catch((e: unknown) => {
        // The command never made it onto the queue, so no result will ever come back for it.
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
      this.startPolling();
    });
  }

  /**
   * Poll `GET /v1/results` for as long as anything is pending, widening as it goes.
   *
   * Self-rescheduling rather than an interval, for the reason `cloudPoller.ts` gives about
   * its own timer: the delay changes on every pass. It stops on its own the moment the map
   * empties — a tab sitting idle costs nothing.
   */
  private startPolling(): void {
    if (this.polling) return;
    this.polling = true;

    let delay = RESULT_POLL_START_MS;
    const schedule = (): void => {
      if (this.pending.size === 0) {
        this.polling = false;
        return;
      }
      const timer = this.deps.setTimeoutImpl ?? setTimeout;
      timer(() => {
        void this.pollOnce()
          .catch(() => {
            // A failed results read is not a failed call: the answer is still on the server,
            // and the next pass will get it. Only the timeout below gives up.
          })
          .finally(() => {
            this.expire();
            delay = Math.min(RESULT_POLL_MAX_MS, Math.round(delay * RESULT_POLL_WIDEN));
            schedule();
          });
      }, delay);
    };
    schedule();
  }

  private async pollOnce(): Promise<void> {
    const token = await this.deps.getAccessToken();
    if (!token) throw new Error('Not signed in to vipper.iam.');

    const url = new URL(`${this.deps.apiBase}/v1/results`);
    if (this.resultCursor) url.searchParams.set('since', this.resultCursor);

    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const res = await fetchImpl(url.toString(), {
      headers: { authorization: `Bearer ${token}`, [BOARD_CLIENT_HEADER]: this.deps.clientId },
    });
    if (!res.ok) throw new Error(`results poll failed (${res.status} ${res.statusText})`);

    const body = (await res.json()) as ResultsResponse;
    this.resultCursor = body.cursor || this.resultCursor;
    for (const result of body.results) {
      const entry = this.pending.get(result.commandId);
      // A result for something this tab is not awaiting is normal after a reload: the tab
      // kept its client id, so the answer to a call the previous page made comes back to a
      // page with no promise for it. Dropped, not an error.
      if (!entry) continue;
      this.pending.delete(result.commandId);
      if (result.ok) entry.resolve(result.value);
      else entry.reject(new Error(result.error || 'The desktop app refused this.'));
    }
  }

  /**
   * Fail anything that has waited past {@link RPC_TIMEOUT_MS}, saying WHICH of the two
   * silences it was.
   *
   * "No desktop client is polling" and "the desktop has not answered yet" look identical
   * from a browser and have completely different fixes — start the app, versus wait or look
   * at what it is stuck on. `BoardResponse.clients` already knows which, so the message says.
   */
  private expire(): void {
    const now = this.clock();
    for (const [id, entry] of [...this.pending]) {
      if (now - entry.startedAt < RPC_TIMEOUT_MS) continue;
      this.pending.delete(id);
      const live = this.deps.hasLiveClient?.() ?? true;
      entry.reject(
        new Error(
          live
            ? `The desktop app has not answered "${entry.channel}" yet. It may still be working on it.`
            : `No desktop app is polling this account, so "${entry.channel}" had nobody to run it.`,
        ),
      );
    }
  }

  private async setStatus(taskId: string, status: ManualStatus): Promise<Task> {
    await this.sendCommand('set-status', { taskId, status });
    // Never read: `BoardScreen` computes and owns its own optimistic overlay
    // (`cloudBoardStore.queuePendingStatusChange`) rather than trust this call's return
    // value, which cannot know the task's real other fields.
    return { id: taskId, status } as Task;
  }

  private async sendCommand(
    kind: CommandEnvelope['kind'],
    payload: unknown,
    id = this.mintId(),
  ): Promise<void> {
    const targetClientId = this.deps.getTargetClientId();
    if (!targetClientId) {
      throw new Error(
        'No desktop Client has ever synced this account — sign in from the desktop app first.',
      );
    }
    const token = await this.deps.getAccessToken();
    if (!token) throw new Error('Not signed in to vipper.iam.');

    const command = {
      id,
      issuedAt: this.clock(),
      issuedBy: this.deps.clientId,
      kind,
      payload,
    } as CommandEnvelope;
    const request: CommandRequest = { targetClientId, command };

    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.deps.apiBase}/v1/commands`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-tm-protocol': String(PROTOCOL_VERSION),
      },
      body: JSON.stringify(request),
    });
    if (!res.ok) throw new Error(`command failed (${res.status} ${res.statusText})`);
  }

  private mintId(): string {
    return this.deps.newCommandId?.() ?? crypto.randomUUID();
  }

  private clock(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
