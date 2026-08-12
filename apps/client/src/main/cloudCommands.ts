/**
 * Applies one relayed `CommandEnvelope` (`@tm/protocol/wire`) on this desktop client.
 *
 * Two shapes of command reach here, and they are not the same kind of thing:
 *
 *  - The three **v1 edit kinds** (`set-status`, `add-comment`, `create-task`) are mapped by
 *    hand to the exact `Store` mutation the desktop UI's own IPC handler would make. No new
 *    write path: each branch either calls a `Store` method already in service, or rejects
 *    with the same validation an IPC handler would throw.
 *  - **`ipc-invoke`** runs the desktop's own handler for a named channel, through
 *    `ipcRegistry.ts`. That is the one the web client uses for everything now, and it is why
 *    the first list stopped growing at three: `IpcApi` is ~115 channels, and a hundred
 *    hand-mapped kinds would be a second, drifting copy of an engine that already exists.
 *
 * NO BATCH TRANSACTION — AND THAT IS THE FIX, NOT A REGRESSION
 * ------------------------------------------------------------
 * This used to be `store.runInTransaction(() => commands.map(applyOne))`: one transaction
 * per poll tick, all-or-nothing. That could not survive going async, and not in a way
 * anything would have caught. `runInTransaction` is `db.transaction(fn)()`, and
 * better-sqlite3 requires `fn` to be SYNCHRONOUS. Hand it an `async` one and it dutifully
 * returns a Promise, the transaction commits at the first `await`, and every write after
 * that point runs untransacted — no error, no warning, nothing red. The whole guarantee
 * evaporates while the code still reads as if it were there.
 *
 * The fix is not an async transaction (there is no such thing here). It is that the batch
 * transaction was the wrong unit anyway: a relayed invoke runs the desktop's OWN handler,
 * which already chose its own atomicity — `task:move` writes the ticket then the row,
 * `attachment:add` copies files, `jira:createTask` makes a network call. Wrapping a batch of
 * those in one SQLite transaction was never going to make them atomic together, and rolling
 * back command #2 because command #4 failed is not something any caller asked for: they are
 * separate clicks by a human.
 *
 * So each command runs on its own, and the only transaction left is the tiny synchronous one
 * that records its outcome in the ledger.
 *
 * REPLAY, NOT RE-EXECUTE
 * ----------------------
 * Delivery is at-least-once and, since the server started leasing rather than tombstoning
 * (`apps/server/src/mirror/commandQueue.ts`), redelivery genuinely happens. The ledger
 * therefore stores each command's ANSWER, and a repeat arrival replays it. Storing a boolean
 * and short-circuiting to `{ok:true}`, as this did, is subtly wrong once redelivery is real:
 * a redelivered `task:run` on a card that is running *because of that very command* would
 * re-enter `scheduler.startTaskNow` and hand the browser "already running" for a command
 * that had succeeded.
 */
import { columnForStatus, restingStatus } from '@shared/board';
import { isManualStatus } from '@shared/model';
import { mergeAppSettings } from '@shared/settings';
import type { CommandEnvelope } from '@protocol/wire';
import { humanStatusPatch } from './cardStatusGuard';
import { resolveMove } from './jira/jiraMove';
import { relayRegistry, type RelayRegistry } from './ipcRegistry';
import type { StoredCloudOutcome, Store } from './store';

export interface CloudCommandOutcome extends StoredCloudOutcome {
  id: string;
}

const REJECTED_STATUS_MOVE =
  'This card is linked to JIRA — move it from the desktop app so the ticket stays in sync.';

/**
 * The kinds somebody is holding a promise for. Only these have their result put on the wire
 * (`SyncRequest.results`); the edit kinds' effect is observed through the mirror, and a
 * result for one would be bytes nothing reads.
 */
function isAwaited(command: CommandEnvelope): boolean {
  return command.kind === 'ipc-invoke';
}

/**
 * Apply one relayed command and return its outcome. Never rejects: every failure a caller
 * could act on comes back as `ok: false` with a reason, because the serial drain behind this
 * must not lose the commands queued after a bad one.
 *
 * Commands are applied in the order they are given, by the caller
 * (`main/commandQueue.ts`) — NOT re-sorted by `issuedAt`, which used to happen here.
 * `issuedAt` is a browser's wall clock (`httpTransport.ts` stamps it): untrusted,
 * unsynchronized, and different per tab. The server already delivers `createdAt ASC` from a
 * clock it owns. One authority, monotonic, trusted.
 */
export async function applyCloudCommand(
  store: Store,
  command: CommandEnvelope,
  registry: RelayRegistry = relayRegistry,
): Promise<CloudCommandOutcome> {
  const replay = store.getCloudCommandOutcome(command.id);
  if (replay) return { id: command.id, ...replay };

  const outcome = await dispatch(store, command, registry);

  // The only transaction, and it is synchronous — see the module docstring. Recording the
  // ledger entry and the rejection comment together means a crash between them cannot leave
  // a command marked applied with no trace of why it was refused.
  store.runInTransaction(() => {
    store.recordCloudCommandApplied(command.id, outcome, isAwaited(command));
    if (!outcome.ok && outcome.taskId) {
      const task = store.getTask(outcome.taskId);
      // Surfaced on the card, not only in the log — a refusal a human never sees is a
      // control that silently did nothing.
      if (task)
        store.addComment(task.projectId, outcome.taskId, `Cloud edit rejected: ${outcome.reason}`);
    }
  });

  return { id: command.id, ...outcome };
}

async function dispatch(
  store: Store,
  command: CommandEnvelope,
  registry: RelayRegistry,
): Promise<StoredCloudOutcome> {
  switch (command.kind) {
    case 'set-status':
      return applySetStatus(store, command);
    case 'add-comment':
      return applyAddComment(store, command);
    case 'create-task':
      return applyCreateTask(store, command);
    case 'ipc-invoke':
      return applyIpcInvoke(store, command, registry);
    default:
      // A row read back out is trusted to be a real CommandEnvelope (see the server's own
      // commandMapping.ts) — but "trusted" isn't "verified", and a future server build could
      // relay a CommandKind this client predates. Reject rather than throw: an unknown
      // command must be answerable, because a browser may be awaiting it.
      return { taskId: null, projectId: null, ok: false, reason: 'Unknown command kind.' };
  }
}

/**
 * Run one `IpcApi` channel on behalf of a browser.
 *
 * `settings:save` is the one channel whose arguments are rewritten on the way through, and
 * the reason is staleness rather than trust: both Settings screens load the whole
 * `AppSettings` blob at mount and save it back whole, so a save always overwrites everything
 * — including whatever the engine learned in between (`settings:changed` exists for exactly
 * that). A browser widens that window a great deal: a tab left open on Settings all afternoon
 * would write an afternoon-old blob back over a JIRA status mapping the engine learned from
 * a drag ten minutes ago. Merging the incoming blob over the CURRENT one keeps the fields the
 * human actually touched and leaves the rest alone.
 */
async function applyIpcInvoke(
  store: Store,
  command: Extract<CommandEnvelope, { kind: 'ipc-invoke' }>,
  registry: RelayRegistry,
): Promise<StoredCloudOutcome> {
  const { channel } = command.payload;
  const args =
    channel === 'settings:save'
      ? [mergeAppSettings(store.getSettings(), command.payload.args[0])]
      : command.payload.args;

  const result = await registry.invoke(channel, args);
  return {
    // A relayed invoke names no card of its own: whatever it changed announced itself
    // through the handler's own events, which is precisely why the fan-out this used to do
    // per outcome was removed (see `ipc.ts`).
    taskId: null,
    projectId: null,
    ok: result.ok,
    reason: result.ok ? null : (result.error ?? 'The desktop app refused this.'),
    value: result.value,
  };
}

function applySetStatus(
  store: Store,
  command: Extract<CommandEnvelope, { kind: 'set-status' }>,
): StoredCloudOutcome {
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

  // The one deliberate gap from `task:setStatus`: that handler can also push a JIRA
  // transition. This kind predates the relay and is kept for queued rows written by an older
  // browser build, so it keeps the refusal it always had rather than growing a network call;
  // a current web client sends `task:move` over `ipc-invoke`, which DOES transition the
  // ticket because it runs the real handler.
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
): StoredCloudOutcome {
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
): StoredCloudOutcome {
  const { projectId, title, phase, description } = command.payload;
  const project = store.getProject(projectId);
  if (!project) return { taskId: null, projectId: null, ok: false, reason: 'Unknown project.' };

  const task = store.createTask(projectId, { title, phase, description });
  if (!task) return { taskId: null, projectId, ok: false, reason: 'A task needs a title.' };
  return { taskId: task.id, projectId, ok: true, reason: null };
}
