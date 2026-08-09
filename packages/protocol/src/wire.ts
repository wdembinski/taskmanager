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

export interface BoardResponse {
  cursor: string;
  cadence: CadenceDirective;
  deltas: MirrorDelta;
}

/** Body of `POST /v1/commands` — one Client asking the server to relay an action to another. */
export interface CommandRequest {
  targetClientId: string;
  command: CommandEnvelope;
}

/** The v1 command kinds a Client can be asked to apply. Acking is by {@link CommandEnvelope.id}. */
export type CommandKind = 'set-status' | 'add-comment' | 'create-task';

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
    >;
