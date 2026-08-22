/**
 * Pure state for the web board: the mirrored tasks/projects (`GET /v1/board`'s own
 * accumulate-by-id shape, since the web app keeps no local SQLite mirror of its own — see
 * `@tm/protocol/wire`'s `BoardResponse` docstring), plus the one thing that makes editing
 * here honest: a **pending status change** per card whose `set-status` command has been
 * sent but not yet seen to land.
 *
 * "Reconciled on the next board read" (this step's own brief) means exactly what
 * {@link reconcilePendingStatusChanges} does: a pending change drops out the moment a poll
 * comes back with that task already at the status it asked for — not because this app
 * decided the command succeeded (it has no way to know that; only the desktop Client that
 * actually applies it does), but because the observable world now agrees with what was
 * asked. A command the desktop Client rejects (see `cloudCommands.ts`) never reconciles
 * that way and is instead cleared by {@link expirePendingStatusChanges}, on a timeout —
 * see `useCloudBoard.ts` for where that runs.
 */
import type { CadenceDirective } from '@tm/protocol/cadence';
import type { BoardResponse, ClientPresence } from '@tm/protocol/wire';
import type { ManualStatus, Project, Task } from '@tm/shared/model';

export interface PendingStatusChange {
  commandId: string;
  taskId: string;
  status: ManualStatus;
  issuedAt: number;
}

export interface CloudBoardState {
  tasks: Record<string, Task>;
  projects: Record<string, Project>;
  /** `SinceRowversion` — `null` until the first successful poll. */
  cursor: string | null;
  /** The desktop Clients on this account, as of the last poll — see `ClientPresence`. */
  clients: ClientPresence[];
  cadence: CadenceDirective | null;
  /** Keyed by `CommandEnvelope.id`. */
  pendingStatusChanges: Record<string, PendingStatusChange>;
}

export const EMPTY_BOARD_STATE: CloudBoardState = {
  tasks: {},
  projects: {},
  cursor: null,
  clients: [],
  cadence: null,
  pendingStatusChanges: {},
};

/** A pending change older than this is presumed lost (rejected, or the command that never
 *  reached a Client) rather than left "queued" on the card forever. */
export const PENDING_STATUS_TIMEOUT_MS = 2 * 60_000;

export function applyBoardResponse(
  state: CloudBoardState,
  response: BoardResponse,
): CloudBoardState {
  const tasks = { ...state.tasks };
  for (const task of response.deltas.tasks) tasks[task.id] = task;
  for (const id of response.deltas.deletedTaskIds) delete tasks[id];

  const projects = { ...state.projects };
  for (const project of response.deltas.projects) projects[project.id] = project;
  for (const id of response.deltas.deletedProjectIds) delete projects[id];

  return {
    tasks,
    projects,
    cursor: response.cursor,
    clients: response.clients,
    cadence: response.cadence,
    pendingStatusChanges: reconcilePendingStatusChanges(state.pendingStatusChanges, tasks),
  };
}

/** Drops any pending change whose task has already settled at the status it asked for. */
function reconcilePendingStatusChanges(
  pending: Record<string, PendingStatusChange>,
  tasks: Record<string, Task>,
): Record<string, PendingStatusChange> {
  const next: Record<string, PendingStatusChange> = {};
  for (const [id, change] of Object.entries(pending)) {
    const task = tasks[change.taskId];
    if (task && task.status === change.status) continue;
    next[id] = change;
  }
  return next;
}

/** Drops any pending change issued more than {@link PENDING_STATUS_TIMEOUT_MS} before `now`. */
export function expirePendingStatusChanges(state: CloudBoardState, now: number): CloudBoardState {
  const next: Record<string, PendingStatusChange> = {};
  let changed = false;
  for (const [id, change] of Object.entries(state.pendingStatusChanges)) {
    if (now - change.issuedAt > PENDING_STATUS_TIMEOUT_MS) {
      changed = true;
      continue;
    }
    next[id] = change;
  }
  return changed ? { ...state, pendingStatusChanges: next } : state;
}

export function queuePendingStatusChange(
  state: CloudBoardState,
  change: PendingStatusChange,
): CloudBoardState {
  return {
    ...state,
    pendingStatusChanges: { ...state.pendingStatusChanges, [change.commandId]: change },
  };
}

/** Rolls back one pending change by its command id — used when `POST /v1/commands` itself
 *  fails (not signed in, no desktop Client, a network error): the edit never reached the
 *  wire, so there is nothing left to reconcile it against. */
export function clearPendingStatusChange(
  state: CloudBoardState,
  commandId: string,
): CloudBoardState {
  if (!(commandId in state.pendingStatusChanges)) return state;
  const pendingStatusChanges = { ...state.pendingStatusChanges };
  delete pendingStatusChanges[commandId];
  return { ...state, pendingStatusChanges };
}

/** The status a card should render as: its own last pending edit if it has one still in
 *  flight, otherwise the mirrored status. Reads the MOST RECENTLY issued pending change for
 *  the task, so a card dragged twice in a row shows where it is headed, not where it first
 *  left from. */
export function displayStatus(state: CloudBoardState, task: Task): Task['status'] {
  let latest: PendingStatusChange | undefined;
  for (const change of Object.values(state.pendingStatusChanges)) {
    if (change.taskId !== task.id) continue;
    if (!latest || change.issuedAt > latest.issuedAt) latest = change;
  }
  return latest?.status ?? task.status;
}

export function isTaskPending(state: CloudBoardState, taskId: string): boolean {
  return Object.values(state.pendingStatusChanges).some((c) => c.taskId === taskId);
}

/**
 * Drop a project the server just created or edited straight into the mirror, ahead of the
 * next `GET /v1/board` poll.
 *
 * `POST /v1/projects` and `PATCH /v1/projects/:id` (`projectsApi.ts`) are writes to the same
 * authoritative store `applyBoardResponse` reads back from — the write bumps `rowVersion`, so
 * the next poll would fold it in regardless — but a hub that only showed a new project once a
 * poll happened to land would read as broken for however long that takes. This is the same
 * optimism `queuePendingStatusChange` gives a dragged card, applied to a row this tab wrote
 * itself rather than merely asked the desktop to.
 */
export function mergeProject(state: CloudBoardState, project: Project): CloudBoardState {
  return { ...state, projects: { ...state.projects, [project.id]: project } };
}
