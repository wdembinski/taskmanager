/**
 * Agent profiles and the durable assignment queue — the vocabulary for "who runs a
 * ticket, with what model/permissions, and has it been picked up yet" (cloud as
 * central control for projects, step 5). An `AgentProfile` names a reusable run
 * configuration; an `Assignment` queues one ticket against one profile until some
 * desktop claims and runs it.
 *
 * Deliberately separate from the existing `AssignAgentInput`/`Task.agentProjectId`
 * flow in `model.ts`: that flow delegates ONE card to an agent PROJECT (a repo/
 * worktree) a human picks by hand, synchronously, from whichever desktop happens to
 * be open. This is queue- and profile-based instead — a ticket is handed to a named
 * run configuration and left for ANY desktop serving that project to pick up
 * whenever it next polls, which is what makes the cloud (rather than one open
 * desktop) the place a ticket gets assigned from.
 */
import type { ClaudeModel, PermissionMode } from './session';

/** A reusable run configuration a ticket can be queued against. */
export interface AgentProfile {
  id: string;
  name: string;
  model: ClaudeModel;
  permissionMode: PermissionMode;
  /** The project this profile is meant for by default; `null` = none, an assignment
   *  must always name a `projectId` of its own regardless of this default. */
  defaultProjectId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** What creating a profile sends. */
export interface AddAgentProfileInput {
  name: string;
  model: ClaudeModel;
  permissionMode: PermissionMode;
  defaultProjectId?: string | null;
}

/** The subset of a profile a human may edit after it's created. */
export type AgentProfilePatch = Partial<
  Pick<AgentProfile, 'name' | 'model' | 'permissionMode' | 'defaultProjectId'>
>;

/**
 * Where one queued ticket stands. `queued` → `claimed` (one desktop has reserved it,
 * `claimedByClientId` is who) → `running` (that desktop's scheduler actually started a
 * session for it) → `done`/`failed` (terminal).
 *
 * A desktop that dies between claiming and reporting just leaves the row `claimed` or
 * `running` forever, for now — nothing here re-queues an abandoned claim. That is a
 * real gap, not an oversight, and is left for later rather than guessed at here.
 */
export type AssignmentStatus = 'queued' | 'claimed' | 'running' | 'done' | 'failed';

export interface Assignment {
  id: string;
  projectId: string;
  ticketId: string;
  profileId: string;
  status: AssignmentStatus;
  /** The desktop `Client` id that claimed this row (`loadCloudClientId()`'s value —
   *  the same id `SyncRequest.clientId` carries). `null` until claimed. */
  claimedByClientId: string | null;
  claimedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  /** The scheduler's own `runId` for the session this assignment started, once known. */
  runId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** What queuing a ticket for an agent sends. */
export interface CreateAssignmentInput {
  projectId: string;
  ticketId: string;
  profileId: string;
}

/** What claiming a queued assignment sends: the id of the desktop making the claim. */
export interface ClaimAssignmentInput {
  clientId: string;
}

/**
 * What a claimer reports back as it works an assignment it holds: `running` once its
 * own `runTask` call actually produced a session, `done`/`failed` once that session
 * finishes. Only the client that holds the claim may report against it — the service
 * checks `clientId` against `Assignment.claimedByClientId` on every call.
 */
export interface ReportAssignmentInput {
  status: Extract<AssignmentStatus, 'running' | 'done' | 'failed'>;
  clientId: string;
  runId?: string | null;
}
