/**
 * The `Transport` `packages/ui/src/transport.tsx` asks any host app for — apps/client's is
 * `window.api` (the preload bridge); this is apps/web's, an HTTP client over the mirror
 * API. `BoardScreen` reaches it the same way any `@tm/ui` component would,
 * `useTransport().invoke('task:setStatus', …)`, so the one write path this app has is the
 * same shape the desktop app's IPC calls are — not a second, web-only vocabulary.
 *
 * Only the channels `BoardScreen` actually calls are implemented: `task:setStatus` and
 * `task:create`, the two of `CommandEnvelope`'s three v1 kinds (`@tm/protocol/wire`) that
 * have a card on this board to show them on. `add-comment` has no read path here at all —
 * comments live in the desktop's own `task_activity` table, which `GET /v1/board` never
 * mirrors (only `Task`/`Project` rows do) — so there is nothing this app could show a
 * comment queued AGAINST, and it is left unimplemented rather than built to a surface that
 * cannot reconcile it. Every other IpcApi channel `@tm/ui`'s TaskDetail/chat/attachments
 * tree calls belongs to a pane this app does not render yet; each rejects with a message
 * that says so, rather than hanging or silently no-opping.
 *
 * `POST /v1/commands` never writes the mirror itself (`MirrorService.enqueueCommand` only
 * queues a row) — the desktop Client is what actually applies it
 * (`apps/client/src/main/cloudCommands.ts`) on its own next `/v1/sync`, and the result only
 * reaches this app on the NEXT `GET /v1/board` poll. `BoardScreen` owns the optimistic
 * "pending" overlay for that gap (`cloudBoardStore.ts`); this class's job stops at getting
 * the command onto the wire.
 */
import type { CommandEnvelope, CommandKind, CommandRequest } from '@tm/protocol/wire';
import type { IpcApi, IpcEvents } from '@tm/shared/ipc';
import type { ManualStatus, Task } from '@tm/shared/model';
import type { Transport } from '@tm/ui/transport';

const SUPPORTED_CHANNELS = new Set<keyof IpcApi>(['task:setStatus', 'task:create']);

export interface HttpTransportDeps {
  apiBase: string;
  /** This browser session's own id — becomes `CommandEnvelope.issuedBy`, purely for the
   *  desktop app's own log/audit trail; nothing authorizes off of it. */
  clientId: string;
  getAccessToken: () => Promise<string | null>;
  /** The desktop Client to relay a command to, or null when none has ever synced this
   *  account — see `targetClient.ts`. */
  getTargetClientId: () => string | null;
  fetchImpl?: typeof fetch;
  newCommandId?: () => string;
  now?: () => number;
}

export class HttpTransport implements Transport {
  constructor(private readonly deps: HttpTransportDeps) {}

  invoke<K extends keyof IpcApi>(
    channel: K,
    ...args: Parameters<IpcApi[K]>
  ): ReturnType<IpcApi[K]> {
    if (!SUPPORTED_CHANNELS.has(channel)) {
      return Promise.reject(
        new Error(
          `"${String(channel)}" isn't available from the web client yet — make this change from the desktop app.`,
        ),
      ) as ReturnType<IpcApi[K]>;
    }
    if (channel === 'task:setStatus') {
      const [taskId, status] = args as Parameters<IpcApi['task:setStatus']>;
      return this.setStatus(taskId, status) as ReturnType<IpcApi[K]>;
    }
    // The only other member of SUPPORTED_CHANNELS.
    const [projectId, input] = args as Parameters<IpcApi['task:create']>;
    return this.createTask(projectId, input) as ReturnType<IpcApi[K]>;
  }

  on<K extends keyof IpcEvents>(
    _channel: K,
    _callback: (payload: IpcEvents[K]) => void,
  ): () => void {
    // No push channel in v1 (docs/plan/README.md's "No realtime service" section) — every
    // update reaches this app through the next board poll, never a pushed event.
    return () => {};
  }

  pathForFile(_file: File): string {
    // No such thing as a filesystem path for a file picked in a browser — see Transport's
    // own docstring.
    return '';
  }

  private async setStatus(taskId: string, status: ManualStatus): Promise<Task> {
    await this.sendCommand('set-status', { taskId, status });
    // Never read: `BoardScreen` computes and owns its own optimistic overlay
    // (`cloudBoardStore.queuePendingStatusChange`) rather than trust this call's return
    // value, which cannot know the task's real other fields.
    return { id: taskId, status } as Task;
  }

  private async createTask(
    projectId: string,
    input: { title: string; phase?: string; description?: string },
  ): Promise<Task> {
    await this.sendCommand('create-task', {
      projectId,
      title: input.title,
      phase: input.phase,
      description: input.description,
    });
    return {
      id: `pending:${this.mintId()}`,
      projectId,
      phase: input.phase ?? '',
      title: input.title,
      status: 'pending',
    } as Task;
  }

  private async sendCommand(kind: CommandKind, payload: unknown): Promise<void> {
    const targetClientId = this.deps.getTargetClientId();
    if (!targetClientId) {
      throw new Error(
        'No desktop Client has ever synced this account — sign in from the desktop app first.',
      );
    }
    const token = await this.deps.getAccessToken();
    if (!token) throw new Error('Not signed in to vipper.iam.');

    const command = {
      id: this.mintId(),
      issuedAt: this.deps.now?.() ?? Date.now(),
      issuedBy: this.deps.clientId,
      kind,
      payload,
    } as CommandEnvelope;
    const request: CommandRequest = { targetClientId, command };

    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.deps.apiBase}/v1/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(request),
    });
    if (!res.ok) throw new Error(`command failed (${res.status} ${res.statusText})`);
  }

  private mintId(): string {
    return this.deps.newCommandId?.() ?? crypto.randomUUID();
  }
}
