/**
 * The wire contract between apps/server, apps/web and (later) apps/client's own polling
 * loop — one round trip per tick, because at the active tier's 2.5s a second request is a
 * second bill. `Task`/`Project` are `@tm/shared`'s own types, not redeclared here: a
 * mirrored task IS a Task, not a wire-shaped lookalike that would need to be kept in sync
 * with it by hand.
 */
import type { ManualStatus, Project, Task } from '@tm/shared/model';
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
