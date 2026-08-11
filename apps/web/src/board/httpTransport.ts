/**
 * The `Transport` `packages/ui/src/transport.tsx` asks any host app for — apps/client's is
 * `window.api` (the preload bridge); this is apps/web's, an HTTP client over the mirror
 * API. `BoardScreen` reaches it the same way any `@tm/ui` component would,
 * `useTransport().invoke('task:setStatus', …)`, so the one write path this app has is the
 * same shape the desktop app's IPC calls are — not a second, web-only vocabulary.
 *
 * Every channel falls in one of three tiers, and the rule that sorts a READ into the middle
 * one or the last is this: **a read channel is stubbed when its result is only displayed; it
 * is refused when its result is fed back into board state.** A stub is a claim this app makes
 * about the world ("there are no live runs"), and a claim is only harmless while it stays
 * inside the pane that asked.
 *
 *  1. **Relayed** — `task:setStatus` and `task:create`, two of `CommandEnvelope`'s three v1
 *     kinds (`@tm/protocol/wire`): the ones that have a card on this board to show them on.
 *     `add-comment` is deliberately NOT here even though the kind exists — comments live in
 *     the desktop's own `task_activity` table, which `GET /v1/board` never mirrors (only
 *     `Task`/`Project` rows do), so the comment would land in a pane that can never show it
 *     arrived.
 *  2. **Stubbed reads** ({@link STUBBED_READS}) — the mount-time reads the shared
 *     `TaskDetail` tree makes for things this app has no mirror of. Each answers the empty
 *     truth ("nothing here"), which is exactly what a browser with no engine behind it
 *     should say. Rejecting instead would be worse than useless: `task:activity` is the one
 *     mount read with no `.catch` at its call site (`TaskDetail.tsx`'s `loadActivity`), so a
 *     rejection there is an unhandled rejection AND leaves the previously selected card's
 *     timeline on screen under the new card's title.
 *  3. **Refused** — everything else, with a message naming the desktop app. That includes
 *     `jira:markRead`, which by the rule above is a read but returns a `Task` that goes
 *     straight into `onStatusChanged`: a fabricated one would clobber the real card on the
 *     board. Its call site already `.catch`es, so refusing is invisible there and safe.
 *
 * Every refused WRITE already lands in an existing `try/catch → setError` in the component
 * that made it, so a control pressed in this pane fails loudly where it was pressed and
 * harmlessly everywhere else.
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
import { DEFAULT_SETTINGS } from '@tm/shared/settings';
import type { Transport } from '@tm/ui/transport';

/**
 * Tier 2 — the reads that answer instead of rejecting, and what each answers. Typed against
 * `IpcApi` itself, so a stub can never drift from the shape its callers destructure.
 *
 * Why each one is here rather than refused (the rule is in this file's header):
 *
 *  - `task:activity` — the timeline. The one mount read with no `.catch`.
 *  - `scheduler:activeRuns` — used only to decide which live run's output to follow. There
 *    are no runs to follow from a browser.
 *  - `settings:get` — read for `autoIntegrate` alone, to label a switch. The desktop's own
 *    defaults are the honest answer for an app that mirrors no settings.
 *  - `project:hasReleaseDoc` — likewise a label, and its caller treats a FAILURE as "yes",
 *    which would be the one answer this app cannot support.
 *  - `jira:priorities` — the priority dropdown's options; the caller falls back to
 *    `DEFAULT_PRIORITIES` when the list is empty.
 *  - `jira:fetchComments` — live ticket comments, merged into the timeline for display.
 *  - `gitlab:markRead` / `gitlab:markEventsSeen` — both are bare `void`s at their call site
 *    (`TaskDetail.tsx`'s `MergeRequests`), and there are no merge requests here to mark.
 */
const STUBBED_READS: { [K in keyof IpcApi]?: () => Awaited<ReturnType<IpcApi[K]>> } = {
  'task:activity': () => [],
  'scheduler:activeRuns': () => [],
  // A fresh object per call: `DEFAULT_SETTINGS` is a shared module-level literal, and a
  // caller that edited what it was handed would be editing every other caller's copy.
  'settings:get': () => ({ ...DEFAULT_SETTINGS }),
  'project:hasReleaseDoc': () => false,
  'jira:priorities': () => [],
  'jira:fetchComments': () => [],
  'gitlab:markRead': () => [],
  'gitlab:markEventsSeen': () => [],
};

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
    // Tier 1: the two relayed writes.
    if (channel === 'task:setStatus') {
      const [taskId, status] = args as Parameters<IpcApi['task:setStatus']>;
      return this.setStatus(taskId, status) as ReturnType<IpcApi[K]>;
    }
    if (channel === 'task:create') {
      const [projectId, input] = args as Parameters<IpcApi['task:create']>;
      return this.createTask(projectId, input) as ReturnType<IpcApi[K]>;
    }
    // Tier 2: a read whose answer only ever gets displayed.
    const stub = STUBBED_READS[channel];
    if (stub) return Promise.resolve(stub()) as unknown as ReturnType<IpcApi[K]>;
    // Tier 3: everything else.
    return Promise.reject(
      new Error(
        `"${String(channel)}" isn't available from the web client yet — make this change from the desktop app.`,
      ),
    ) as ReturnType<IpcApi[K]>;
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
