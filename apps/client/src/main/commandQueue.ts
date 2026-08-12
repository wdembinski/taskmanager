/**
 * Drains relayed commands **one at a time, in delivered order**, and emits each result.
 *
 * WHY THIS EXISTS RATHER THAN AN `await` IN THE POLLER
 * ----------------------------------------------------
 * `CloudPollerDeps.onCommands` is typed `(commands) => void` and called fire-and-forget
 * (`cloudPoller.ts`), while `tick()`'s `finally` clears `running` and re-arms the timer.
 * Applying was synchronous, so that was fine. Applying an `ipc-invoke` is not: the handler
 * is `async`, so simply making the callback `async` would let the next tick's batch start
 * draining while this one was still mid-command — two drains interleaved over the same
 * cards, in an order nobody chose.
 *
 * Awaiting the drain inside `send()` instead would fix the interleaving and break something
 * worse: poll liveness would be coupled to handler latency. One `jira:sync` taking two
 * minutes would stop cloud sync for two minutes; one channel that never resolves would stop
 * it forever. Nothing else about the mirror — the board push, the presence beat, the cadence
 * — has anything to do with how long a relayed handler takes.
 *
 * So the poller stays a poller and hands off here. The queue owns the serialization.
 *
 * WHY SERIAL AT ALL
 * -----------------
 * Because the commands are a human's clicks in the order they made them. "Move this card to
 * In Progress, then start it" run concurrently is a race between two writes to one row, and
 * whichever loses produces a card that is running and still in To Do. Concurrency here would
 * buy latency on a queue that is almost always length one.
 *
 * WHY NOT RE-SORT BY `issuedAt`
 * -----------------------------
 * `applyCloudCommands` used to sort the batch by `issuedAt`, which is a BROWSER's wall clock
 * (`httpTransport.ts` stamps it) — untrusted, unsynchronized, and different per tab. The
 * server already returns `createdAt ASC` from one clock it owns. One authority, monotonic,
 * trusted; the delivered order is the order.
 *
 * Pure: no `Store`, no Electron, every dependency injected.
 */

/** What the queue needs to know about one command. Deliberately not `CommandEnvelope`. */
export interface QueuedCommand {
  id: string;
}

export interface CommandQueueDeps<T extends QueuedCommand, R> {
  /** Run one command. Must not throw; if it does, see {@link CommandQueue.enqueue}. */
  run: (command: T) => Promise<R>;
  /** Called with each command's result, in the order they were run. */
  onResult?: (command: T, result: R) => void;
  /** Called when `run` rejected despite the contract above — a bug, not a command failure. */
  onError?: (command: T, error: unknown) => void;
}

export class CommandQueue<T extends QueuedCommand, R> {
  private readonly pending: T[] = [];
  private draining: Promise<void> | null = null;
  /** Ids already queued or run this process — see {@link enqueue}. */
  private readonly seen = new Set<string>();

  constructor(private readonly deps: CommandQueueDeps<T, R>) {}

  /**
   * Add commands to the tail of the queue and make sure a drain is running.
   *
   * Returns immediately — the caller is a poll tick that must not wait. A command whose id
   * is already queued is dropped: redelivery is normal now that the server leases rather
   * than tombstones (`apps/server/src/mirror/commandQueue.ts`), and queueing the same id
   * twice would run it twice within one process even though the persistent ledger would
   * have replayed it. The ledger is still the real guard — this only avoids the pointless
   * round trip.
   */
  enqueue(commands: readonly T[]): void {
    for (const command of commands) {
      if (this.seen.has(command.id)) continue;
      this.seen.add(command.id);
      this.pending.push(command);
    }
    if (this.pending.length > 0 && !this.draining) {
      this.draining = this.drain().finally(() => {
        this.draining = null;
        // Something enqueued during the final `await` of the last drain would otherwise sit
        // here until the next poll — which is a real gap, since a drain of a slow command
        // can span several ticks.
        if (this.pending.length > 0) this.enqueue([]);
      });
    }
  }

  /** Whether a drain is in flight. For tests and for a shutdown that wants to wait. */
  get busy(): boolean {
    return this.draining !== null;
  }

  /** Resolves when the current drain finishes (immediately if none is running). */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async drain(): Promise<void> {
    // `shift` inside the loop rather than a snapshot: a command enqueued mid-drain joins
    // THIS drain, which is what keeps a second one from starting beside it.
    for (let next = this.pending.shift(); next !== undefined; next = this.pending.shift()) {
      const command = next;
      try {
        const result = await this.deps.run(command);
        this.deps.onResult?.(command, result);
      } catch (error) {
        // `run` is contracted not to throw (`ipcRegistry.ts` returns failures as values), so
        // reaching here is a bug in the dispatcher, not a command that failed. Either way it
        // must not abort the batch: the commands behind this one are unrelated clicks.
        this.deps.onError?.(command, error);
      }
    }
  }
}
