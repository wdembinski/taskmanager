/**
 * The wire contract between apps/server, apps/web and (later) apps/client's own polling
 * loop — one round trip per tick, because at the active tier's 2.5s a second request is a
 * second bill. `Task`/`Project` are `@tm/shared`'s own types, not redeclared here: a
 * mirrored task IS a Task, not a wire-shaped lookalike that would need to be kept in sync
 * with it by hand.
 */
import type {
  AddProjectInput,
  BoardColumn,
  ManualStatus,
  Project,
  ProjectPatch,
  Task,
  TaskType,
} from '@tm/shared/model';
import type { AppSettings } from '@tm/shared/settings';
import type { CadenceDirective } from './cadence';

/**
 * What changed locally since the caller's last sync, folded into one delta so `/v1/sync`
 * stays one request per tick. Deletions are ids rather than tombstone rows: the mirror is
 * disposable state, so "this id is gone" is everything a receiving Client needs to drop it
 * from its own copy.
 */
export interface MirrorDelta {
  tasks: Task[];
  projects: Project[];
  deletedTaskIds: string[];
  deletedProjectIds: string[];
}

/**
 * The version of THIS contract, sent on every `SyncRequest` and returned on every
 * `BoardResponse`.
 *
 * Nothing on the wire carried a version before, and the two ends do not update together:
 * apps/web is served fresh on every load, apps/client is an installed binary somebody
 * updates when they feel like it. So the realistic mismatch is a browser six versions ahead
 * of the desktop it is talking to, asking it to run a channel that build has never heard of
 * — and the only honest way to say "your desktop app is too old for this" is for the two to
 * have exchanged a number first.
 *
 * Bump it when the wire gains a field an older peer would be WRONG to ignore. Adding an
 * optional field it can safely skip is not that.
 */
export const PROTOCOL_VERSION = 2;

/**
 * Who a desktop Client IS, so a browser can name the machine it is driving rather than count
 * anonymous ids — `ClientPresence.id` is a UUID generated on first sync and says nothing to
 * anybody. Sent on {@link SyncRequest}, persisted on the server's `clients` row, and handed
 * back on {@link ClientPresence.info}.
 *
 * WHAT THIS DELIBERATELY DOES NOT CARRY
 * -------------------------------------
 * What that desktop is CONFIGURED with. `settings:get`, `jira:getConfigStatus`,
 * `gitlab:getConfigStatus`, `project:list` and `exec:listDistros` are all `'relay'` in
 * `@tm/shared/ipcRelay`, so a browser already reads every one of them live, off the target
 * Client, through the same `ipc-invoke` path every other channel uses. Mirroring any of it
 * onto this type would be a second, staler copy of an answer the wire can already ask for —
 * and it would go out of date the moment somebody changed a setting on the desktop.
 *
 * Identity is the exception because it is the one thing you cannot ask a Client for: you have
 * to know which Client to ask FIRST, and picking one is the question this answers.
 *
 * Every field is optional. A build older than this one sends no `info` at all, and a browser
 * that gets none falls back to the id — which is the pre-existing behaviour, not a failure —
 * so this is an added field an older peer can safely skip, and by this file's own rule that
 * is NOT a {@link PROTOCOL_VERSION} bump. A Client that sends `info` fills all four.
 */
export interface ClientInfo {
  /** The machine's own name — `os.hostname()` on the desktop. */
  name?: string;
  /** `process.platform`: `win32`, `linux`, `darwin`. Not narrowed — it is a label to show. */
  platform?: string;
  /** The desktop app's version, `app.getVersion()`. */
  appVersion?: string;
  /**
   * {@link PROTOCOL_VERSION} as that Client understands it — the PERSISTED twin of
   * {@link SyncRequest.protocolVersion}, which the server reads per request and discards.
   *
   * This is the one the browser reads back, and it is what gives `ipcRegistry`'s "…is not
   * wired up in this build of the desktop app. It is probably older than the browser tab
   * talking to it — update it and try again." something to point at BEFORE it fires: a tab
   * whose own `PROTOCOL_VERSION` is ahead of this number can say so up front, instead of
   * letting the human discover it one refused channel at a time.
   */
  protocolVersion?: number;
}

/** Body of `POST /v1/sync` — a Client's heartbeat and its outgoing changes in one request. */
export interface SyncRequest {
  clientId: string;
  /** Opaque server-issued position in the change stream; echoed back on the next call. */
  cursor: string | null;
  focused: boolean;
  deltas: MirrorDelta;
  /**
   * Ids of commands this Client applied (or rejected) since its last sync — see
   * `CommandEnvelope`. At-least-once delivery is the only guarantee a poll loop can give,
   * so a command is not the caller's problem to retry once its id shows up here; this is
   * how the Client closes the loop on what `SyncResponse.commands` handed it, whether or
   * not that command survived the applying Client's own validation.
   */
  ackedCommandIds: string[];
  /**
   * What each of those commands actually ANSWERED, for the ones somebody is waiting on.
   *
   * An ack says the command is off the queue; a result says what it returned. `set-status`
   * only ever needed the first — the web app watches the mirror for its effect and never
   * reads a return value. An `ipc-invoke` is the opposite: a browser is holding an unresolved
   * promise for it, so the value has to travel.
   *
   * Optional so a desktop build that predates results still type-checks against this
   * contract; the server treats a missing array as an empty one.
   */
  results?: CommandResult[];
  /** {@link PROTOCOL_VERSION} as this Client understands it. Absent from an older build. */
  protocolVersion?: number;
  /**
   * Who this Client is — see {@link ClientInfo}. Sent on every sync rather than once at
   * registration: there is no registration step (the row is upserted lazily on first sync),
   * and a desktop that gets renamed or updated has to be able to say so without one.
   */
  info?: ClientInfo;
  /**
   * This desktop's GLOBAL settings (`@tm/shared`'s `pickGlobalSettings` — account-scoped keys
   * only, never its machine-local ones), sent to SEED and update the server's settings mirror
   * so cloud web can read them with no desktop polling. Sent only on the ticks where they
   * changed since the last successful push, not every tick — see `cloudPoller.ts`.
   *
   * Optional and safe to ignore: a server that predates the settings mirror drops it, and the
   * only cost is that cloud web falls back to defaults until a newer server catches the next
   * push — an older peer being behind, not wrong, so no `PROTOCOL_VERSION` bump.
   */
  settings?: Partial<AppSettings>;
}

/**
 * Response to `GET /v1/settings`, and the body of a `PUT /v1/settings` reply — the account's
 * global settings as the server's mirror currently holds them, filled out over
 * `DEFAULT_SETTINGS` so cloud web always receives a COMPLETE {@link AppSettings} to render.
 *
 * The machine-local fields in it are stock defaults, never a real desktop's values: only
 * global keys are ever written into the mirror (`pickGlobalSettings` gates every write), and
 * cloud web renders only global fields anyway. A `PUT` body is a `Partial<AppSettings>`; the
 * server narrows it to global keys and folds it over what the mirror holds.
 */
export interface SettingsResponse {
  settings: AppSettings;
}

/**
 * What one command returned, travelling back the way its ack does.
 *
 * `value` is whatever the channel's own `IpcApi` signature resolves to, JSON round-tripped —
 * which is the same trip an Electron IPC reply already makes (structured clone), so a shape
 * that survives one survives the other.
 *
 * `error` is the handler's message **verbatim**. Not `String(err)`, which renders a plain
 * `Error` as the word "Error" and tells the human nothing, and not the preload bridge's
 * `ipcErrorMessage` unwrapping either: that strips an `Error invoking remote method '…':`
 * prefix Electron adds, and no such prefix exists on this path. The message that crosses
 * here is the one the handler wrote.
 */
export interface CommandResult {
  commandId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

/**
 * Response to `GET /v1/results?since=` — the results for commands THIS caller issued.
 *
 * Its own route rather than a field on `BoardResponse`, because the two have different
 * scopes and mixing them would be a leak: a board is account-wide (every tab and every
 * desktop client on the account reads the same one), while a result belongs to the one tab
 * that is awaiting it. Scoping by `issuedBy` is what keeps a second tab from resolving a
 * promise it never made.
 */
export interface ResultsResponse {
  results: CommandResult[];
  /** Pass back as `since` on the next poll. */
  cursor: string;
}

/** Response to `POST /v1/sync` — the world's changes since `cursor`, plus what to do next. */
export interface SyncResponse {
  cursor: string;
  cadence: CadenceDirective;
  commands: CommandEnvelope[];
  /**
   * How many browser sessions are currently listening for pushed events (see
   * {@link EventEnvelope}). Zero — or absent — means nobody is watching, and a Client that
   * reads it that way stops forwarding until the next sync says otherwise.
   *
   * This is the whole reason the count travels on a response the Client already makes: a
   * desktop with no browser open must not be posting a running agent's transcript into the
   * cloud for nobody, and asking "is anyone there?" on its own route would be a second
   * request per tick — the thing `SyncRequest` exists to avoid.
   *
   * Optional, so no `PROTOCOL_VERSION` bump: a server that predates the push channel omits
   * it and a Client that never forwards ignores it. Neither is WRONG to skip it, which is
   * exactly the line this file's rule draws — an older desktop that never forwards is old,
   * not broken, and the browser falls back to `PolledEventBus` as it does today.
   */
  eventListeners?: number;
}

/**
 * One engine event on its way to the browser — the push half of the mirror.
 *
 * `channel` is a `keyof IpcEvents` and `payload` its `IpcEvents[channel]`, both widened here
 * for the same reason `ipc-invoke` widens its own: this package must not depend on the
 * desktop's IPC contract, and the value has been through JSON either way. The narrowing
 * happens where it can be enforced — the forwarding Client classifies the channel against
 * `@tm/shared/ipcEventFanout`, and the receiving browser hands the payload to a subscriber
 * that was typed by `Transport.on` long before it got here.
 *
 * Payloads are capped at `MAX_EVENT_BYTES` by that same module before they are enveloped:
 * a `session:event` carrying a `Write` tool's input carries the whole file.
 */
export interface EventEnvelope {
  channel: string;
  payload: unknown;
  /** Epoch ms the desktop emitted it — the browser orders by this, not by arrival. */
  at: number;
  /**
   * The sender's own monotonic counter, one stream per `clientId` (not per channel). It
   * exists so a receiver can tell "nothing has happened" from "I was not told": a jump means
   * events were coalesced or dropped between two batches, which is `EventBatchRequest.gap`
   * on the sending side and a re-read on the receiving one.
   */
  seq: number;
}

/**
 * Body of `POST /v1/events` — one desktop Client handing over what its engine just pushed.
 *
 * A batch rather than an event per request because the events arrive in bursts (a running
 * agent emits a dozen `session:event`s a second) and the whole design of this wire is one
 * round trip per tick.
 */
export interface EventBatchRequest {
  clientId: string;
  /**
   * How many events this Client dropped since its last batch — coalesced by policy, or shed
   * because the queue was full. Absent or 0 means the stream is complete.
   *
   * Reported rather than hidden: a browser that knows it has holes can re-read the affected
   * transcript (`session:gap` → `task:activity`), and one that is silently missing lines
   * shows a plausible, wrong picture of what an agent did.
   */
  gap?: number;
  events: EventEnvelope[];
}

/**
 * Response to `POST /v1/events` — the same listener count {@link SyncResponse.eventListeners}
 * carries, answered on the push itself so a Client learns the audience left without waiting
 * for its next sync.
 */
export interface EventBatchResponse {
  listeners: number;
}

/**
 * The `event:` names carried on `GET /v1/events`, the server-sent stream that delivers the
 * batches above to a browser.
 *
 * Here rather than in apps/server because a frame name is only worth anything to the reader
 * on the other end: the server writes these strings and apps/web matches on them, which is
 * the definition of a wire, and a magic string copied across an app boundary is the thing
 * this package exists to stop.
 *
 * `engine` rather than `event` for the payload frame so no control name can ever collide
 * with it — and `message`, EventSource's default name for an unnamed frame, stays free.
 */
export const EVENT_STREAM_FRAMES = {
  /** One {@link EventEnvelope}, carrying the `id:` a `Last-Event-ID` resumes from. */
  event: 'engine',
  /** Always the first frame on a connection — {@link HelloFrame}. */
  hello: 'hello',
  /** Something was lost, and this says how much — {@link GapFrame}. */
  gap: 'gap',
  /** The server is closing this stream deliberately — {@link ByeFrame}. */
  bye: 'bye',
} as const;

/**
 * `?lastEventId=` on `GET /v1/events`, the query-string twin of the `Last-Event-ID` header.
 *
 * Both, because the two possible readers can each only send one of them: a `fetch`-based
 * reader must set the header itself (it is the only way it can carry an `Authorization`
 * header at all), while a plain `EventSource` sets `Last-Event-ID` for free and cannot set
 * any header — so anything else it wants to say has to travel in the URL.
 */
export const EVENT_STREAM_LAST_ID_QUERY = 'lastEventId';

/**
 * The stream's opening frame. `resumed: false` with `lastEventId: null` is a fresh
 * connection and nothing is wrong; `resumed: false` with an id is a reconnect the server
 * could not honour, and a {@link GapFrame} follows saying so.
 */
export interface HelloFrame {
  resumed: boolean;
  /** The position the client asked to resume from, echoed back — `null` if it asked for none. */
  lastEventId: number | null;
}

/**
 * Why a hole exists in the stream.
 *
 * - `sender` — the desktop coalesced or shed events before forwarding (`EventBatchRequest.gap`).
 * - `shed` — this subscriber could not keep up and the server dropped its oldest queued events.
 * - `expired` — a resume arrived after the events it asked for had aged out of the replay ring.
 * - `reset` — the server has no memory of the id at all (it restarted, or the account's ring
 *   was reclaimed), so not even the size of the hole is known.
 */
export type GapReason = 'sender' | 'shed' | 'expired' | 'reset';

/** A hole in the stream — the browser's cue to re-read whatever it was watching. */
export interface GapFrame {
  reason: GapReason;
  /** How many events were lost, when that is knowable. Absent means "unknown, assume many". */
  count?: number;
}

/**
 * The server hanging up on purpose, so a reader can tell a deliberate close from a dropped
 * connection. Either way it reconnects — `lifetime` just means it was expected.
 */
export interface ByeFrame {
  reason: 'lifetime' | 'shutdown';
}

/** Body of `POST /v1/presence` — a bare focus beat between full syncs. */
export interface PresenceRequest {
  clientId: string;
  focused: boolean;
}

/** Response to `POST /v1/presence` — just the cadence, so a beat doubles as a cadence check. */
export interface PresenceResponse {
  cadence: CadenceDirective;
}

/**
 * `GET /v1/board?since=<rowversion>` — the web app's own read path; it keeps no local
 * mirror to carry a `/v1/sync` cursor for, so it hands back a SQL Server rowversion
 * instead. `X-TM-Focus` and `X-TM-Client-Id` double as its presence beat: a GET carries no
 * body to put one in.
 */
export const BOARD_FOCUS_HEADER = 'X-TM-Focus';
export const BOARD_CLIENT_HEADER = 'X-TM-Client-Id';

/**
 * One desktop Client's presence, as the web app needs it: which id to send a command to
 * (`CommandRequest.targetClientId`), and how long ago it last polled — the honesty check
 * behind the "no Client has polled recently" banner (apps/web's own step in
 * docs/plan/README.md Phase 25). Deliberately narrower than `PresenceBeat`: a web session's
 * own presence isn't a target for anything, and `focused` doesn't matter here — an idle-tier
 * desktop Client still polls (just slower) and is still a valid command target.
 */
export interface ClientPresence {
  id: string;
  /** Epoch ms this Client's presence entry last beat — see `PRESENCE_TTL_MS`. */
  lastSeen: number;
  /**
   * What that Client last told us it was — see {@link ClientInfo}.
   *
   * Read from the server's `clients` row rather than from the presence map: presence is
   * in-memory and rebuilt from beats, identity is durable and written once per sync, so
   * folding the second into the first would put a name back into memory that a restart
   * would lose. Absent for a Client whose build predates {@link SyncRequest.info}.
   */
  info?: ClientInfo;
}

export interface BoardResponse {
  cursor: string;
  cadence: CadenceDirective;
  deltas: MirrorDelta;
  /**
   * Every desktop Client on this account currently within `PRESENCE_TTL_MS`, most recently
   * seen first. Empty means no desktop Client is polling right now — a command queued via
   * `POST /v1/commands` would have nowhere to be delivered to and nobody to apply it.
   */
  clients: ClientPresence[];
  /** {@link PROTOCOL_VERSION} as the SERVER understands it. */
  protocolVersion?: number;
  /**
   * True when the page cap cut this read short: there are more rows past `cursor` and the
   * caller should poll again immediately rather than wait out its cadence.
   *
   * The push side has been bounded since `SYNC_BYTES_LIMIT`; the read side was not, so a
   * first poll against a mature board asked for every row it had ever mirrored in one
   * response. See `mirror.service.ts`'s `rowsSince`.
   */
  hasMore?: boolean;
}

/**
 * Body of `POST /v1/tasks` — a browser creating an ad-hoc task directly, without going
 * through a desktop Client at all.
 *
 * Every other write a browser makes travels as a relayed `CommandRequest` (`ipc-invoke` of
 * `task:create`, applied by whichever desktop Client picks it up on its next sync) — which
 * means it does nothing at all for an account no desktop Client is currently polling for.
 * This route is the server applying the SAME shape itself: `mirror.service.ts`'s
 * `createTask` runs the identical checks `ipc.ts`'s `task:create` handler does against its
 * local store, but against `project_mirrors`, and builds the row with `@tm/shared`'s own
 * `buildAdhocTask` — so a card made this way is byte-for-byte what a desktop would have
 * produced from the same input, not a wire-shaped lookalike.
 */
export interface CreateTaskRequest {
  projectId: string;
  title: string;
  phase?: string;
  type?: TaskType | null;
  /** The card's brief — lands in `Task.externalDescription`, same as `task:create`'s. */
  description?: string | null;
  projectTagId?: string | null;
}

/**
 * Body of `PATCH /v1/tasks/:id` — a browser editing, moving or hand-setting the status of
 * a mirrored task directly, the write-endpoint sibling of {@link CreateTaskRequest}.
 *
 * Every field is optional and independent, so a request patches only what it names: a title
 * edit does not also require a column. `toColumn` and `status` are mutually meaningful but
 * not mutually exclusive to send — `mirror.service.ts`'s `updateTask` reads `toColumn` first
 * (the board drag) and falls back to `status` (the detail pane's dropdown), the same
 * precedence `ipc.ts`'s `task:move`/`task:setStatus` split into two handlers for.
 *
 * `resolveMove` (`@tm/shared/moveResolve`, lifted out of the desktop's own `jiraMove.ts` for
 * this route) decides the effect of either one; there is no JIRA transition to apply here,
 * because an ad-hoc task made through this same route family never carries a linked issue.
 */
export interface UpdateTaskRequest {
  /** Move to this board column — the drag-and-drop path. */
  toColumn?: BoardColumn;
  /** Hand-set this status directly — the detail pane's dropdown path. */
  status?: ManualStatus;
  title?: string;
  phase?: string;
  type?: TaskType | null;
  /** Lands in `Task.externalDescription`, same as {@link CreateTaskRequest.description}. */
  description?: string | null;
  projectTagId?: string | null;
}

/**
 * Body of `POST /v1/projects` — a browser creating a project directly, without going
 * through a desktop Client at all — the project sibling of {@link CreateTaskRequest}.
 *
 * Reuses `@tm/shared/model`'s own {@link AddProjectInput} rather than a narrower wire-only
 * shape: unlike an ad-hoc task, which only ever fills a handful of `Task`'s many fields,
 * `buildProject` (`@tm/shared/projectBuilders`) already IS the one object-construction path
 * for every kind of project, on the desktop and here alike — inventing a second, narrower
 * input type would just be a copy of the fields it already accepts.
 */
export type CreateProjectRequest = AddProjectInput;

/**
 * Body of `PATCH /v1/projects/:id` — edit a mirrored project directly, the project sibling
 * of {@link UpdateTaskRequest}. Reuses `@tm/shared/model`'s own {@link ProjectPatch} for the
 * same reason {@link CreateProjectRequest} reuses `AddProjectInput`: it already is the "what
 * may be edited after creation" contract the desktop's own `project:update` uses.
 */
export type UpdateProjectRequest = ProjectPatch;

/** Body of `POST /v1/commands` — one Client asking the server to relay an action to another. */
export interface CommandRequest {
  targetClientId: string;
  command: CommandEnvelope;
}

/**
 * The command kinds a Client can be asked to apply. Acking is by {@link CommandEnvelope.id}.
 *
 * The first three are v1's: one kind per EDIT, each mapped by hand to the `Store` mutation
 * the desktop's own IPC handler would make (`apps/client/src/main/cloudCommands.ts`).
 * `ipc-invoke` is v2's, and it is the reason that list stopped growing: the web client needs
 * roughly a hundred channels, and a hundred hand-mapped kinds would be a second, drifting
 * copy of `IpcApi` — every one of which already has a handler on the desktop that does the
 * right thing, including the atomicity, the JIRA push and the events. So the relay carries
 * the CHANNEL rather than a translation of it, and `@tm/shared/ipcRelay` decides which
 * channels are allowed through.
 *
 * The three older kinds stay: they are what a browser session issued before it could relay,
 * a queued one can still be in the table across an upgrade, and `set-status` in particular
 * is worth keeping as its own kind — its effect is observed through the mirror, so it needs
 * no result to come back at all.
 *
 * `create-task` is the one of the three the web has STOPPED sending. It carries four fields,
 * and the shared add-task dialog collects a dozen (type, filing, parent, chain link, ticket),
 * so a card made in a browser now relays `task:create` like any other channel and gets the
 * real row back rather than a fabricated id. The kind is still applied — an older client's
 * queued command must not become unreadable — but nothing issues it any more.
 */
export type CommandKind = 'set-status' | 'add-comment' | 'create-task' | 'ipc-invoke';

interface CommandEnvelopeOf<Kind extends CommandKind, Payload> {
  id: string;
  issuedAt: number;
  issuedBy: string;
  kind: Kind;
  payload: Payload;
}

export type CommandEnvelope =
  | CommandEnvelopeOf<'set-status', { taskId: string; status: ManualStatus }>
  | CommandEnvelopeOf<'add-comment', { taskId: string; body: string }>
  | CommandEnvelopeOf<
      'create-task',
      { projectId: string; title: string; phase?: string; description?: string }
    >
  /**
   * Run one `IpcApi` channel on the target Client and send back what it returned.
   *
   * `channel` is a `keyof IpcApi` and `args` its `Parameters<…>`, but both are widened here
   * on purpose: this package must not depend on the desktop's IPC contract, and the payload
   * has been through JSON either way. The narrowing happens where it can be enforced — the
   * applying Client checks the channel against `@tm/shared/ipcRelay` and its own registry
   * before it dispatches anything.
   */
  | CommandEnvelopeOf<'ipc-invoke', { channel: string; args: unknown[] }>;

/**
 * THE BLOB ROUTES — how an attachment's bytes reach a browser, and how a browser's bytes
 * reach a desktop.
 *
 * Five routes, two directions, and one thing they all have in common: the body is **raw**.
 * `POST /v1/uploads` and `PUT /v1/attachments/:id/blob` send `application/octet-stream` and
 * the two GETs answer with it, because a file is bytes and base64 in a JSON envelope would
 * be a third more of them for nothing.
 *
 * - `POST /v1/uploads` — a browser hands over a file it wants attached, before any card row
 *   for it exists. Answers an {@link UploadTicket}; the id in it is what a relayed
 *   `attachment:*` channel then names, so the desktop can fetch the bytes and write them
 *   where every other attachment lives.
 * - `GET /v1/uploads/:id` — the desktop collecting those bytes. Guarded like every other
 *   `/v1` route.
 * - `PUT /v1/attachments/:id/blob` — the desktop pushing an existing attachment's bytes up,
 *   so a browser can look at them. Answers {@link BlobStored}, whose `storedAt` is what the
 *   desktop records as `TaskAttachment.cloudBlobAt`.
 * - `GET /v1/attachments/:id?mt=` — the picture itself, for an `<img src>`. The ONLY route
 *   authorised by a media token rather than by a bearer, for the reason `MediaTokenGuard`
 *   exists: an `<img>` cannot set an `Authorization` header.
 * - `DELETE /v1/attachments/:id/blob` — the bytes are gone locally, so drop the copy.
 *
 * The metadata (`name`, `type`) travels in the query string rather than in the body for the
 * same reason the body is raw: there is no envelope to put it in.
 */

/** `?name=` on the two upload routes — the file's original name, for the chip and the download. */
export const BLOB_NAME_QUERY = 'name';

/** `?type=` on the two upload routes — the sender's best guess at a MIME type, or nothing. */
export const BLOB_TYPE_QUERY = 'type';

/**
 * `?mt=` on `GET /v1/attachments/:id` — the media token.
 *
 * In the URL, not a header, and that is the whole point: the reader is an `<img src>`, which
 * sets no headers at all. See the server's `mediaTokens.ts` for what a token is worth (one
 * account, `media:read`, ten minutes) and why that is the narrowest thing that can be put in
 * a URL a browser will happily leak into a referrer.
 */
export const MEDIA_TOKEN_QUERY = 'mt';

/**
 * The original file name on `GET /v1/uploads/:id` — a raw body has nowhere else to carry it.
 *
 * **Percent-encoded**, and the reader must `decodeURIComponent` it: a header value is latin-1
 * by the letter of HTTP, and a file name is whatever the human called it.
 */
export const BLOB_NAME_HEADER = 'X-TM-File-Name';

/** What `POST /v1/uploads` answers: bytes are held, here is what to call them. */
export interface UploadTicket {
  /** Server-assigned. What a relayed `attachment:*` channel names to claim these bytes. */
  id: string;
  /** How many bytes the server actually counted — not what the sender declared. */
  size: number;
  /** Epoch ms this ticket stops being claimable and its bytes are reclaimed. */
  expiresAt: number;
}

/** What `PUT /v1/attachments/:id/blob` answers — `storedAt` becomes `cloudBlobAt`. */
export interface BlobStored {
  storedAt: number;
  size: number;
}

/** What `POST /v1/media-tokens` answers — one short-lived `media:read` ticket for this account. */
export interface MediaTokenGrant {
  token: string;
  expiresAt: number;
}

/**
 * Every personal access token starts with this, immediately after minting and forever after.
 * It earns its place twice: it lets `IamAuthGuard` route a bearer to the local PAT check
 * without a database hit (an IAM-issued token never carries it), and it gives a secret
 * scanner something fixed to match if one of these ever leaks into a log or a repo.
 */
export const PAT_PREFIX = 'tmpat_';

/** The random part of a token: 32 CSPRNG bytes, base64url-encoded. */
export const PAT_SECRET_LENGTH = 43;

/** No token may outlive this many days — `POST /v1/tokens` rejects a longer `expiresInDays`. */
export const MAX_PAT_EXPIRY_DAYS = 365;

/**
 * The expiry presets both the web create form and the server's validation agree on. `null`
 * is "no expiry". Shared here, not just in the server, because the web dropdown and the
 * server's cap have to offer and accept the same set of numbers.
 */
export const PAT_EXPIRY_CHOICES: ReadonlyArray<number | null> = [30, 90, 365, null];

/** Preselected in the web create form when nothing else has been chosen. */
export const PAT_DEFAULT_EXPIRY_DAYS = 90;

/**
 * One personal access token, as returned by the list route. Deliberately carries no secret
 * and no hash — this is what the server is willing to show back to the account that owns it,
 * which is everything except the thing that would let it be replayed. Timestamps are epoch
 * ms, matching `attachment_blobs`' choice, so a caller compares them with plain arithmetic
 * rather than parsing a date.
 */
export interface PersonalAccessToken {
  id: string;
  name: string;
  hint: string;
  createdAt: number;
  /** `null` means the token never expires. */
  expiresAt: number | null;
  /** `null` means still live. */
  revokedAt: number | null;
  /** `null` means never used. */
  lastUsedAt: number | null;
}

/** What `POST /v1/tokens` takes: a label and an optional expiry, in days from now. */
export interface CreatePatRequest {
  name: string;
  /** Omitted or `null` means the token never expires. */
  expiresInDays?: number | null;
}

/**
 * What `POST /v1/tokens` answers. `token` is the ONLY time the secret exists outside the
 * caller's own process — the server keeps a hash, never the token itself, so there is no
 * later route that can show it again.
 */
export interface CreatedPersonalAccessToken {
  token: string;
  pat: PersonalAccessToken;
}

/** What `GET /v1/tokens` answers. */
export interface PersonalAccessTokenList {
  tokens: PersonalAccessToken[];
}
