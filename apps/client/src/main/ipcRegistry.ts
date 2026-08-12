/**
 * The engine's own IPC handlers, reachable by name so a relayed `ipc-invoke` can run one.
 *
 * `ipc.ts`'s `handle()` helper registers a channel with Electron; it now also records the
 * handler here. Two callers, one function, no second implementation of any channel — which
 * is the whole reason the relay carries a channel name rather than ~100 hand-mapped command
 * kinds: the desktop handler already chose the right atomicity, already pushes the right
 * events, already does the JIRA write-back. A parallel "cloud" implementation of `task:move`
 * would be a second answer to a question that already has one.
 *
 * This lives in its own file, importing nothing from Electron, so it is testable without a
 * running app — which is also why it is a class with a shared instance rather than a module
 * of module-level state a test could not isolate.
 *
 * TWO REFUSALS, BOTH DELIBERATE
 * -----------------------------
 * A channel is dispatched only if `@tm/shared/ipcRelay` marks it `'relay'` AND a handler is
 * registered for it. The browser refuses host-only channels for itself
 * (`httpTransport.ts`), which makes the click fail immediately; this refusal is the one that
 * is actually load-bearing, because a command arrives over HTTP from whatever wrote it.
 *
 * NEVER THROWS
 * ------------
 * {@link RelayRegistry.invoke} always resolves to a result. A rejection here would land in
 * the middle of a serial drain and take the commands behind it down with it, and the browser
 * on the other end is holding a promise that has to be settled either way.
 *
 * THE MESSAGE IS VERBATIM
 * -----------------------
 * `ipcErrorMessage` (`@shared/ipcError`) exists to strip the `Error invoking remote method
 * '…':` prefix Electron adds — and it is a PRELOAD concern (`preload/index.ts`), not this
 * one. Nothing adds a prefix on this path, so unwrapping here would be looking for something
 * that is not there. What matters instead is not falling back to `String(err)`, which
 * renders a plain `Error` as the word "Error" and would show a browser a refusal with no
 * reason in it.
 */
import { hostOnlyMessage, isRelayable } from '@shared/ipcRelay';

/** What a relayed invoke answers with. Mirrors `CommandResult` minus the id. */
export interface RelayInvokeResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

type AnyHandler = (...args: never[]) => unknown;

export class RelayRegistry {
  private readonly handlers = new Map<string, AnyHandler>();

  /** Record a channel's handler. Called by `ipc.ts`'s `handle()` for every channel. */
  register(channel: string, handler: AnyHandler): void {
    this.handlers.set(channel, handler);
  }

  /** Whether this channel could be relayed right now — classified AND wired. */
  canInvoke(channel: string): boolean {
    return isRelayable(channel) && this.handlers.has(channel);
  }

  /**
   * Run one channel on behalf of a remote caller.
   *
   * The order of the two checks matters: a host-only channel is refused with the reason it
   * is host-only even though it IS registered, because "the desktop app has not finished
   * starting" and "this will never work from a browser" are different answers and the second
   * one is actionable.
   */
  async invoke(channel: string, args: readonly unknown[]): Promise<RelayInvokeResult> {
    if (!isRelayable(channel)) {
      return { ok: false, error: hostOnlyMessage(channel) };
    }
    const handler = this.handlers.get(channel);
    if (!handler) {
      return {
        ok: false,
        error:
          `"${channel}" is not wired up in this build of the desktop app. It is probably ` +
          'older than the browser tab talking to it — update it and try again.',
      };
    }

    try {
      const value = await (handler as (...a: unknown[]) => unknown)(...args);
      return { ok: true, value: serializable(value) };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  /** Drop everything — tests only; the app registers once and never unregisters. */
  reset(): void {
    this.handlers.clear();
  }

  /** How many channels are wired. Exposed so a test can prove registration happened at all. */
  size(): number {
    return this.handlers.size;
  }
}

/** The instance `ipc.ts` fills and `cloudCommands.ts` dispatches through. */
export const relayRegistry = new RelayRegistry();

/**
 * The handler's own message, or the best available description of something thrown that was
 * not an `Error`.
 *
 * `String(err)` is the tempting one-liner and it is wrong for the commonest case in this
 * codebase by far: `String(new Error('Task not found.'))` is `"Error: Task not found."` and
 * `String({})` is `"[object Object]"`, but a rejected promise carrying a bare `Error` with a
 * message is what nearly every handler in `ipc.ts` produces, and its `.message` is the
 * sentence somebody wrote for a human to read.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // A message-less Error is the exact case that made `String(err)` unacceptable: it
    // stringifies to the bare word "Error", which reads to a human as if the app had
    // nothing to say — and is indistinguishable from a hundred other failures.
    return err.message || UNEXPLAINED;
  }
  if (typeof err === 'string' && err) return err;
  const described = String(err);
  return described && described !== '[object Object]' ? described : UNEXPLAINED;
}

const UNEXPLAINED = 'The desktop app failed without saying why.';

/**
 * The value as it will survive the trip: JSON, because that is what the wire is.
 *
 * Done HERE rather than left to `JSON.stringify` on the server, so a channel that returns
 * something unserialisable (a circular reference, most plausibly) fails as this one
 * command's error instead of throwing inside the sync request that carries it and taking
 * the whole tick with it. `undefined` stays `undefined` — plenty of `IpcApi` channels are
 * `Promise<void>`, and `CommandResult.value` is optional for exactly them.
 */
function serializable(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    throw new Error('This channel returned something that cannot be sent to a browser.');
  }
}
