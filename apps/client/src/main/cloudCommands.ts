/**
 * Maps each relayed `CommandEnvelope` (`@tm/protocol/wire`) to the exact `Store` mutation
 * the desktop UI's own IPC handler would make for the same edit — `set-status` mirrors
 * `task:setStatus`, `add-comment` mirrors `task:addComment`, `create-task` mirrors
 * `task:create` (all in `ipc.ts`). No new write path: every branch below either calls a
 * `Store` method already in service, or rejects with the same validation an IPC handler
 * would throw, so a command from the web app cannot do what the desktop UI could not.
 *
 * One deliberate gap from `task:setStatus`: that handler can also push a JIRA transition,
 * which is a network call, and `applyCloudCommands` runs its whole batch inside ONE
 * `Store.runInTransaction` (`seq` order, one transaction per poll tick) — better-sqlite3's
 * transactions are synchronous and cannot await, so there is no way to make that call from
 * inside one. Rather than apply the local half of a JIRA-linked move and silently drop the
 * push (leaving the card wrong until a human happens to fix it from the desktop), a
 * `set-status` that would need one is rejected outright: `resolveMove` already only ever
 * names a `jiraTransition` for a JIRA-linked task moving to a real column, so this refusal
 * fires exactly there and nowhere else.
 *
 * Applying writes through the SAME `Store` methods `ipc.ts` uses on the `tasks`/`projects`
 * tables, which is what makes the result mirror back out on the next poll "for free": the
 * SQLite triggers behind `cloud_outbox` (see `store.ts`) fire for those writes exactly as
 * they would for a human's own edit, with no special-casing needed here for the return
 * trip.
 *
 * At-least-once delivery (`cloudPoller.ts`'s own header) means the same command id can
 * arrive more than once — a retried request, a redelivery after a dropped response — so
 * applying is keyed by id against `Store`'s applied-command ledger (`cloud_applied_commands`):
 * a repeat arrival is a no-op, not a second edit.
 */
import { columnForStatus, restingStatus } from '@shared/board';
import { isManualStatus } from '@shared/model';
import type { CommandEnvelope } from '@protocol/wire';
import { humanStatusPatch } from './cardStatusGuard';
import { resolveMove } from './jira/jiraMove';
import type { Store } from './store';

export interface CloudCommandOutcome {
  id: string;
  /** The card the command targeted, or null for a command with none (an unresolved id, or
   *  a `create-task` — resolved to the task it MADE only when it succeeded). */
  taskId: string | null;
  /** The board to refresh (`project:tasksChanged`), when applying changed one. */
  projectId: string | null;
  ok: boolean;
  /** Set when `ok` is false. Also written onto `taskId`'s own timeline as a comment when
   *  `taskId` names a real task, so a rejection is never visible only in the log. */
  reason: string | null;
}

const REJECTED_STATUS_MOVE =
  'This card is linked to JIRA — move it from the desktop app so the ticket stays in sync.';

/**
 * Apply a batch of relayed commands as one `Store` transaction, in `issuedAt` order — the
 * outbox's own vocabulary calls this "seq order": the order the commands actually happened
 * in, not the order the network happened to deliver them.
 */
export function applyCloudCommands(
  store: Store,
  commands: readonly CommandEnvelope[],
): CloudCommandOutcome[] {
  const ordered = [...commands].sort((a, b) => a.issuedAt - b.issuedAt);
  return store.runInTransaction(() => ordered.map((command) => applyOne(store, command)));
}

function applyOne(store: Store, command: CommandEnvelope): CloudCommandOutcome {
  if (store.isCloudCommandApplied(command.id)) {
    return { id: command.id, taskId: null, projectId: null, ok: true, reason: null };
  }

  const result = mapCommand(store, command);
  store.markCloudCommandApplied(command.id);

  if (!result.ok && result.taskId) {
    const task = store.getTask(result.taskId);
    // Surfaced on the card, not only in the log — see the module docstring.
    if (task)
      store.addComment(task.projectId, result.taskId, `Cloud edit rejected: ${result.reason}`);
  }

  return { id: command.id, ...result };
}

function mapCommand(store: Store, command: CommandEnvelope): Omit<CloudCommandOutcome, 'id'> {
  switch (command.kind) {
    case 'set-status':
      return applySetStatus(store, command);
    case 'add-comment':
      return applyAddComment(store, command);
    case 'create-task':
      return applyCreateTask(store, command);
    default:
      // A row read back out is trusted to be a real CommandEnvelope (see the server's own
      // commandMapping.ts) — but "trusted" isn't "verified", and a future server build could
      // relay a CommandKind this client predates. Reject rather than throw: one unknown
      // command must not take the rest of the batch's transaction down with it.
      return { taskId: null, projectId: null, ok: false, reason: 'Unknown command kind.' };
  }
}

function applySetStatus(
  store: Store,
  command: Extract<CommandEnvelope, { kind: 'set-status' }>,
): Omit<CloudCommandOutcome, 'id'> {
  const { taskId, status } = command.payload;
  const existing = store.getTask(taskId);
  if (!existing) return { taskId, projectId: null, ok: false, reason: 'Task not found.' };
  if (!isManualStatus(status)) {
    return {
      taskId,
      projectId: existing.projectId,
      ok: false,
      reason: `"${status}" is not a hand-settable status.`,
    };
  }

  // Same borrowing rule `task:setStatus` respects (see cardStatusGuard.ts): a live run keeps
  // `status`, so the human's — here, the web app's — choice is read from where the card
  // RESTS, and a no-op move writes nothing at all.
  const from = restingStatus(existing);
  if (from === status) return { taskId, projectId: existing.projectId, ok: true, reason: null };

  const move = resolveMove(existing, columnForStatus(status));
  if (move.jiraTransition) {
    return { taskId, projectId: existing.projectId, ok: false, reason: REJECTED_STATUS_MOVE };
  }

  const task = store.updateTask(taskId, {
    ...humanStatusPatch(existing, status),
    preBlockStatus: move.preBlockStatus,
  });
  if (!task) return { taskId, projectId: null, ok: false, reason: 'Task not found.' };
  store.recordStatusChange(task.projectId, taskId, from, status);
  return { taskId, projectId: task.projectId, ok: true, reason: null };
}

function applyAddComment(
  store: Store,
  command: Extract<CommandEnvelope, { kind: 'add-comment' }>,
): Omit<CloudCommandOutcome, 'id'> {
  const { taskId, body } = command.payload;
  const task = store.getTask(taskId);
  if (!task) return { taskId, projectId: null, ok: false, reason: 'Task not found.' };

  const entry = store.addComment(task.projectId, taskId, body);
  if (!entry) {
    return { taskId, projectId: task.projectId, ok: false, reason: 'A comment needs some text.' };
  }
  return { taskId, projectId: task.projectId, ok: true, reason: null };
}

function applyCreateTask(
  store: Store,
  command: Extract<CommandEnvelope, { kind: 'create-task' }>,
): Omit<CloudCommandOutcome, 'id'> {
  const { projectId, title, phase, description } = command.payload;
  const project = store.getProject(projectId);
  if (!project) return { taskId: null, projectId: null, ok: false, reason: 'Unknown project.' };

  const task = store.createTask(projectId, { title, phase, description });
  if (!task) return { taskId: null, projectId, ok: false, reason: 'A task needs a title.' };
  return { taskId: task.id, projectId, ok: true, reason: null };
}
