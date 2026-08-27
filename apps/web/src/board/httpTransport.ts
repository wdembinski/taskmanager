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
 * Three tiers now:
 *  1. **Direct** — `task:create`, `task:setStatus`, `task:move`, `task:setDescription`,
 *     `project:add`, `project:update`, `project:remove`, `settings:get` and `settings:save`
 *     post straight to the write/read endpoints (`POST`/`PATCH`/`DELETE /v1/tasks` and
 *     `/v1/projects`, `GET`/`PUT /v1/settings`) instead of relaying at all. These are the
 *     edits a browser with no desktop Client ever synced still has to be able to make —
 *     creating and working a card, filing it under a project of its own, and reading and
 *     changing the account's global settings is the whole reason cloud web has to stand on its
 *     own — and the server applies each write to the mirror itself and replays it to every
 *     desktop Client on record (`mirror.service.ts`), so a Client that is offline right now
 *     still catches up later instead of the edit never having happened at all.
 *  2. **Relayed** — anything else `@tm/shared/ipcRelay` marks `'relay'`, still an `ipc-invoke`
 *     command held open and polled for through `GET /v1/results`, answered by the desktop's
 *     own handler.
 *  3. **Host-only** — refused locally, with the reason from that same shared policy, so the
 *     sentence a human reads is written once and not once per side. The engine refuses these
 *     again if a command reaches it anyway; this refusal is the courtesy that makes the click
 *     fail immediately instead of after a round trip.
 *
 * RESULTS ARE POLLED; EVENTS ARE PUSHED
 * -------------------------------------
 * A relayed call's RESULT is fetched rather than delivered: the poll runs **only while
 * something is pending** and widens as it waits, so request volume is bounded by clicks
 * rather than by wall time — a tab left open with nothing in flight makes no results requests
 * at all. A stream would cost a connection to save a few hundred milliseconds on a click.
 *
 * EVENTS are the other way round, and now have their own channel: `on()` hands off to
 * `eventBus.ts`, which reads `GET /v1/events` as a stream and falls back to rebuilding events
 * from polls only when that stream is down. The difference is who is waiting — a result has a
 * promise held open for it, while an event is a firehose a running agent produces whether
 * anyone asked or not.
 */
import {
  BLOB_NAME_QUERY,
  BLOB_TYPE_QUERY,
  MEDIA_TOKEN_QUERY,
  PROTOCOL_VERSION,
  type CommandEnvelope,
  type CommandRequest,
  type CreateProjectRequest,
  type CreateTaskRequest,
  type ResultsResponse,
  type SettingsResponse,
  type UpdateProjectRequest,
  type UpdateTaskRequest,
  type UploadTicket,
} from '@tm/protocol/wire';
import { CLOUD_BLOB_MAX_BYTES } from '@tm/shared/attachments';
import type { TaskAttachment, UploadedAttachment } from '@tm/shared/attachments';
import { hostOnlyMessage, isRelayable } from '@tm/shared/ipcRelay';
import type { IpcApi, IpcEvents } from '@tm/shared/ipc';
import type { Project, Task } from '@tm/shared/model';
import type { AppSettings } from '@tm/shared/settings';
import { BOARD_CLIENT_HEADER } from '@tm/protocol/wire';
import type { Transport } from '@tm/ui/transport';
import type { FocusSignal } from './BoardPoller';
import { CloudEventBus } from './eventBus';
import { MediaTokenHolder } from './mediaToken';
import { PolledEventBus } from './polledEvents';
import { SseEventStream } from './sseEvents';

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
  /**
   * The tab's visibility, if the host has one. Used only by the pushed event stream, which
   * reconnects the moment the tab comes back to the foreground rather than waiting out a
   * backoff a background tab's throttled timers may have stretched to minutes.
   *
   * Optional so a test — and any host without a `document` — gets a transport that works,
   * just without that one shortcut.
   */
  focus?: FocusSignal;
  /** Every failed attempt to open the event stream. Default: `console.warn`. */
  onEventStreamError?: (error: unknown) => void;
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
  private readonly events: CloudEventBus;
  /** The `?mt=` ticket every thumbnail's URL carries — see `mediaToken.ts`. */
  private readonly mediaToken: MediaTokenHolder;
  private readonly mediaTokenListeners = new Set<() => void>();
  /** How many relayed calls are still awaiting a result — see {@link onPendingChange}. */
  private readonly pendingListeners = new Set<(count: number) => void>();
  /** The count last handed to {@link pendingListeners} — {@link notePending} is called from
   *  several sites that run on every poll pass whether or not anything actually changed
   *  (`pollOnce`, `expire`), and this is what keeps those from renotifying an unchanged count. */
  private lastNotifiedPendingCount = 0;

  constructor(private readonly deps: HttpTransportDeps) {
    this.mediaToken = new MediaTokenHolder({
      apiBase: deps.apiBase,
      getAccessToken: deps.getAccessToken,
      // A token arriving does not change any state React is watching, so the tab would sit
      // showing chips without thumbnails until something else re-rendered it. One hop out
      // through `useCloudBoard` is what makes the pictures appear.
      onChange: () => {
        for (const listener of this.mediaTokenListeners) listener();
      },
      fetchImpl: deps.fetchImpl,
      now: deps.now,
    });
    this.events = new CloudEventBus({
      polled: new PolledEventBus({
        invoke: (channel, ...args) =>
          this.invoke(channel, ...args) as Promise<Awaited<ReturnType<IpcApi[typeof channel]>>>,
      }),
      createStream: (handlers) =>
        new SseEventStream({
          ...handlers,
          apiBase: deps.apiBase,
          getAccessToken: deps.getAccessToken,
          fetchImpl: deps.fetchImpl,
          onError:
            deps.onEventStreamError ??
            ((error: unknown) => console.warn('event stream failed', error)),
        }),
      focus: deps.focus,
    });
  }

  invoke<K extends keyof IpcApi>(
    channel: K,
    ...args: Parameters<IpcApi[K]>
  ): ReturnType<IpcApi[K]> {
    // The direct tier — see the docstring's "Three tiers now". These four never need a
    // desktop Client on record, unlike everything relayed below.
    if (channel === 'task:create') {
      const [projectId, input] = args as Parameters<IpcApi['task:create']>;
      const body: CreateTaskRequest = { projectId, ...input };
      return this.writeTask('/v1/tasks', 'POST', body) as ReturnType<IpcApi[K]>;
    }
    if (channel === 'task:setStatus') {
      const [taskId, status] = args as Parameters<IpcApi['task:setStatus']>;
      const body: UpdateTaskRequest = { status };
      return this.writeTask(`/v1/tasks/${encodeURIComponent(taskId)}`, 'PATCH', body) as ReturnType<
        IpcApi[K]
      >;
    }
    if (channel === 'task:move') {
      const [taskId, toColumn] = args as Parameters<IpcApi['task:move']>;
      const body: UpdateTaskRequest = { toColumn };
      return this.writeTask(`/v1/tasks/${encodeURIComponent(taskId)}`, 'PATCH', body) as ReturnType<
        IpcApi[K]
      >;
    }
    if (channel === 'task:setDescription') {
      const [taskId, description] = args as Parameters<IpcApi['task:setDescription']>;
      const body: UpdateTaskRequest = { description };
      return this.writeTask(`/v1/tasks/${encodeURIComponent(taskId)}`, 'PATCH', body) as ReturnType<
        IpcApi[K]
      >;
    }
    if (channel === 'project:add') {
      const [input] = args as Parameters<IpcApi['project:add']>;
      const body: CreateProjectRequest = input;
      return this.writeProject('/v1/projects', 'POST', body).then((project) => ({
        project,
        tasks: [],
      })) as ReturnType<IpcApi[K]>;
    }
    if (channel === 'project:update') {
      const [projectId, patch] = args as Parameters<IpcApi['project:update']>;
      const body: UpdateProjectRequest = patch;
      return this.writeProject(
        `/v1/projects/${encodeURIComponent(projectId)}`,
        'PATCH',
        body,
      ) as ReturnType<IpcApi[K]>;
    }
    if (channel === 'project:remove') {
      const [projectId] = args as Parameters<IpcApi['project:remove']>;
      return this.deleteProject(projectId) as ReturnType<IpcApi[K]>;
    }
    // Settings are account-scoped and mirrored server-side (`GET`/`PUT /v1/settings`), so both
    // read and write go direct — a browser must be able to see and change them with no desktop
    // Client on record. The server narrows a save to global keys and replays it to desktops.
    if (channel === 'settings:get') {
      return this.readSettings() as ReturnType<IpcApi[K]>;
    }
    if (channel === 'settings:save') {
      const [settings] = args as Parameters<IpcApi['settings:save']>;
      return this.writeSettings(settings) as ReturnType<IpcApi[K]>;
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
   * Where a browser fetches an attachment's bytes from — `GET /v1/attachments/:id?mt=`, for
   * the ones the cloud actually holds, and `''` for every other.
   *
   * The desktop answers `vipper-attachment://a/<id>`, a custom scheme registered only in
   * Electron, which a browser cannot resolve — that is the bug this resolver exists to end.
   * But a URL on this origin is only an honest answer for bytes that are up there, and most
   * are not: only images under the cap are pushed at all, and the cloud is a CACHE that
   * evicts under quota pressure. `cloudBlobAt` is the row's own record of that, so it is what
   * decides here.
   *
   * `''` for the rest, and for the moment before this tab has minted its media token. The
   * strip reads it as "this host cannot show a preview" and renders the chip alone; a
   * plausible URL to a route that 404s would look identical on screen and be a claim that was
   * not true — which is the whole reason the desktop's answer was not simply copied.
   */
  attachmentUrl(attachment: TaskAttachment): string {
    if (!attachment.cloudBlobAt) return '';
    const token = this.mediaToken.current();
    if (!token) return '';
    const url = new URL(`${this.deps.apiBase}/v1/attachments/${encodeURIComponent(attachment.id)}`);
    url.searchParams.set(MEDIA_TOKEN_QUERY, token);
    return url.toString();
  }

  /**
   * Attach files this browser picked: park the bytes in the cloud, then tell the desktop to
   * collect them.
   *
   * Two hops for one gesture, and they are different in kind. The BYTES go straight to the
   * server over their own raw route (`POST /v1/uploads`), because they are megabytes and the
   * relay is a JSON command queue — base64 in a `commands` row would be a third more of them,
   * parked in what is meant to be an audit trail. The COMMAND is an ordinary relayed
   * `attachment:addUploaded` naming the tickets, so the desktop runs its own attachment
   * handler and the file lands under `userData` exactly like one picked there: same naming
   * policy, same dedupe, same events.
   *
   * The uploads run in parallel and are awaited together: a five-file pick should take as
   * long as its largest file, and one that fails must fail the gesture rather than half-
   * attaching it — the tickets that did land expire on their own within the hour.
   */
  async attachFiles(taskId: string, files: readonly File[]): Promise<TaskAttachment[]> {
    if (files.length === 0) return [];
    const uploads = await Promise.all(files.map((file) => this.upload(file)));
    return this.invoke('attachment:addUploaded', taskId, uploads);
  }

  /** One file to `POST /v1/uploads`, answering the ticket that names it on the relay. */
  private async upload(file: File): Promise<UploadedAttachment> {
    if (file.size > CLOUD_BLOB_MAX_BYTES) {
      // Refused here rather than by the server's byte counter, purely so the human is told
      // before the upload rather than after it. The server enforces it either way.
      throw new Error(
        `${file.name} is larger than ${Math.round(CLOUD_BLOB_MAX_BYTES / (1024 * 1024))} MB, ` +
          'which is the most a browser can attach. Attach it from the desktop app.',
      );
    }
    const token = await this.deps.getAccessToken();
    if (!token) throw new Error('Not signed in to vipper.iam.');

    const url = new URL(`${this.deps.apiBase}/v1/uploads`);
    url.searchParams.set(BLOB_NAME_QUERY, file.name);
    if (file.type) url.searchParams.set(BLOB_TYPE_QUERY, file.type);

    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const res = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        // Raw, and it must stay raw: the server reads this body itself under a byte counter,
        // with no parser registered for this type. See `apps/server`'s `rawBody.ts`.
        'content-type': 'application/octet-stream',
      },
      body: file,
    });
    if (!res.ok) throw new Error(`${file.name} could not be uploaded (${res.status})`);

    const ticket = (await res.json()) as UploadTicket;
    return { id: ticket.id, fileName: file.name, mimeType: file.type || null };
  }

  /** Run `cb` whenever a media token arrives — see `mediaToken.ts` on why a render needs this. */
  onMediaTokenChange(cb: () => void): () => void {
    this.mediaTokenListeners.add(cb);
    return () => this.mediaTokenListeners.delete(cb);
  }

  /**
   * Run `cb` with the current count of relayed calls still awaiting a result, every time that
   * count changes. This is the "loading" half of the busy indicator — a browser tab reading
   * the board through a desktop Client is never done just because the poll came back; a
   * relayed call still in flight is data that hasn't arrived yet. Same one-hop-out-of-React
   * shape as {@link onMediaTokenChange}.
   */
  onPendingChange(cb: (count: number) => void): () => void {
    this.pendingListeners.add(cb);
    return () => this.pendingListeners.delete(cb);
  }

  private notePending(): void {
    const count = this.pending.size;
    if (count === this.lastNotifiedPendingCount) return;
    this.lastNotifiedPendingCount = count;
    for (const listener of this.pendingListeners) listener(count);
  }

  /** Stop the result poll and fail everything still waiting. Called when the tab tears down. */
  dispose(): void {
    this.events.dispose();
    this.mediaToken.dispose();
    this.mediaTokenListeners.clear();
    for (const [, entry] of this.pending) {
      entry.reject(new Error('The page is closing.'));
    }
    this.pending.clear();
    // Reported before the listener set is cleared, so a component unmounting mid-call sees
    // the count it's holding go back to 0 rather than being left stuck on whatever it was.
    this.notePending();
    this.pendingListeners.clear();
  }

  private relay(channel: string, args: readonly unknown[]): Promise<unknown> {
    const id = this.mintId();
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, channel, startedAt: this.clock() });
      this.notePending();
      void this.sendCommand('ipc-invoke', { channel, args }, id).catch((e: unknown) => {
        // The command never made it onto the queue, so no result will ever come back for it.
        this.pending.delete(id);
        this.notePending();
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
    // Once per poll rather than once per result: a page draining ten results at once is one
    // size change for a listener to react to, not ten renders of the same final count.
    this.notePending();
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
    this.notePending();
  }

  /**
   * `POST /v1/tasks` or `PATCH /v1/tasks/:id` — the direct tier's one shape. Unlike
   * {@link sendCommand}, this needs no `targetClientId` at all: the server applies the write
   * to the mirror itself before this resolves, and replays it to whichever desktop Clients
   * are on record on its own — see `mirror.service.ts`.
   */
  private async writeTask(path: string, method: 'POST' | 'PATCH', body: unknown): Promise<Task> {
    const token = await this.deps.getAccessToken();
    if (!token) throw new Error('Not signed in to vipper.iam.');

    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.deps.apiBase}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`request failed (${res.status} ${res.statusText})`);
    return (await res.json()) as Task;
  }

  /** `POST /v1/projects` or `PATCH /v1/projects/:id` — the project sibling of {@link writeTask}. */
  private async writeProject(
    path: string,
    method: 'POST' | 'PATCH',
    body: unknown,
  ): Promise<Project> {
    const token = await this.deps.getAccessToken();
    if (!token) throw new Error('Not signed in to vipper.iam.');

    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.deps.apiBase}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`request failed (${res.status} ${res.statusText})`);
    return (await res.json()) as Project;
  }

  /**
   * `GET /v1/settings` — the account's global settings, mirrored server-side so this reads with
   * no desktop Client polling. The response is a complete `AppSettings`; its machine-local
   * fields are stock defaults (only global keys are ever mirrored — see `pickGlobalSettings`),
   * which is exactly what the Settings screen renders and never more.
   */
  private async readSettings(): Promise<AppSettings> {
    const token = await this.deps.getAccessToken();
    if (!token) throw new Error('Not signed in to vipper.iam.');

    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.deps.apiBase}/v1/settings`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`request failed (${res.status} ${res.statusText})`);
    const body = (await res.json()) as SettingsResponse;
    return body.settings;
  }

  /**
   * `PUT /v1/settings` — cloud web writing global settings directly. Sends the whole blob the
   * Settings screen loaded and saves back (it has no partial-save path); the SERVER narrows it
   * to global keys, so the machine-local fields riding along at their defaults are dropped
   * rather than stored, and replays the change to every desktop Client on record.
   */
  private async writeSettings(settings: AppSettings): Promise<void> {
    const token = await this.deps.getAccessToken();
    if (!token) throw new Error('Not signed in to vipper.iam.');

    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.deps.apiBase}/v1/settings`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(settings),
    });
    if (!res.ok) throw new Error(`request failed (${res.status} ${res.statusText})`);
  }

  /** `DELETE /v1/projects/:id` — the direct tier's one no-body shape. */
  private async deleteProject(projectId: string): Promise<void> {
    const token = await this.deps.getAccessToken();
    if (!token) throw new Error('Not signed in to vipper.iam.');

    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const res = await fetchImpl(
      `${this.deps.apiBase}/v1/projects/${encodeURIComponent(projectId)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`request failed (${res.status} ${res.statusText})`);
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
