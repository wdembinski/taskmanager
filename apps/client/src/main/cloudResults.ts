/**
 * Pure shaping of the relayed answers waiting in `cloud_applied_commands` into the
 * `SyncRequest.results` one `/v1/sync` request may carry. The results half of what
 * `cloudDelta.ts` does for the entities half, and it exists for exactly the same reason:
 * **anything a tick puts in the body has to be bounded, or the tick can wedge forever.**
 *
 * The failure this was written for (15 Aug 2026). A browser tab asked for a card's activity
 * timeline about thirty times in one burst; every answer was applied and stored, and each
 * was a few hundred kilobytes of timeline JSON. `CloudPoller` then put **all 36 of them** in
 * every request — `getPendingCloudResults()` was read straight onto the wire, uncapped and
 * unbatched — so each tick built a 10,427,787-byte body, the server's 8 MB backstop
 * (`apps/server/src/config/bodyLimit.ts`) refused it `413`, nothing was marked sent, and the
 * next tick rebuilt the identical body. Forever. The 1 MB `SYNC_BYTES_LIMIT` did not help:
 * it measures the ENTITIES, and the entities in those requests were one 15 kB task.
 *
 * Everything downstream of that sync stopped with it, which is how the bug was noticed: the
 * outbox never drained, so three cards created after the wedge — "Add user details page",
 * "Budget schema plan and implementation", "Add button to Create PR/MR" — were never mirrored
 * and simply did not exist on the web board.
 *
 * Two rules, and the second is the one that matters:
 *
 *  - **Pack, oldest first, within a byte budget** (always at least one, so a tick can never
 *    do nothing). The rest wait for the next tick — a result is a small independent message,
 *    not part of a batch that has to land together.
 *  - **An answer too large to ever be sent is replaced by an error, not carried forever.**
 *    A task row is durable state, so `cloudDelta.ts` sends an oversized one anyway rather
 *    than lose the card. A result is not: it is one browser interaction's return value, and
 *    a body no hop will accept means the promise waiting on it never resolves either way.
 *    Replacing it with a truthful `ok: false` settles that promise, retires the row, and —
 *    the whole point — lets every result and every card queued behind it through.
 */
import type { CommandResult } from '@protocol/wire';

/**
 * How many bytes of relayed answers one `/v1/sync` request may carry.
 *
 * A sibling of `SYNC_BYTES_LIMIT` rather than a share of it: the two halves are queued by
 * different things (SQLite triggers vs. a browser's clicks) and neither should be able to
 * starve the other out of a tick. Worst case a request is therefore both budgets plus its
 * framing — comfortably inside the server's 8 MB `DEFAULT_BODY_LIMIT`, which is the number
 * that has to stay several times larger than whatever this file lets through.
 */
export const RESULTS_BYTES_LIMIT = 1_000_000;

/** The one row shape this needs — `Store`'s `PendingCloudResult`, structurally. */
export interface PendingResultRow {
  commandId: string;
  ok: boolean;
  reason: string | null;
  /** What the channel returned, for an `ipc-invoke`. Absent for the edit kinds. */
  value?: unknown;
}

/** One answer that could never be sent, for the caller to log. `bytes` is what it measured. */
export interface OversizedResult {
  commandId: string;
  bytes: number;
}

export interface BoundedResults {
  /** Exactly what goes on the wire this tick. */
  results: CommandResult[];
  /** The command ids `results` speaks for — what the caller may mark sent, and nothing more. */
  sent: string[];
  /** Those whose real answer was swapped for an error because it exceeded `hardCapBytes`. */
  oversized: OversizedResult[];
}

/**
 * The answers this tick can carry, in the order they were applied.
 *
 * `budgetBytes` is how much this REQUEST may spend (halved by `CloudPoller` after a 413, so
 * an intermediary with a tighter limit than the origin's converges instead of retrying);
 * `hardCapBytes` is the fixed size past which a single answer is judged unsendable and
 * replaced. They are two parameters rather than one so that a shrunken budget only ever
 * defers answers, never destroys them — a transient 413 must not start discarding results
 * that were perfectly sendable a minute ago.
 */
export function boundCloudResults(
  rows: readonly PendingResultRow[],
  budgetBytes: number = RESULTS_BYTES_LIMIT,
  hardCapBytes: number = RESULTS_BYTES_LIMIT,
): BoundedResults {
  const results: CommandResult[] = [];
  const sent: string[] = [];
  const oversized: OversizedResult[] = [];
  let bytes = 0;

  for (const row of rows) {
    const answer = toCommandResult(row);
    const size = resultBytes(answer);
    const tooLarge = size > hardCapBytes;
    const entry = tooLarge ? unsendable(row.commandId, size) : answer;
    const entrySize = tooLarge ? resultBytes(entry) : size;

    // "At least one" comes first: a budget smaller than the head of the queue must still
    // make progress, or the queue never moves and the outbox behind it never drains.
    if (results.length > 0 && bytes + entrySize > budgetBytes) break;

    results.push(entry);
    sent.push(row.commandId);
    bytes += entrySize;
    if (tooLarge) oversized.push({ commandId: row.commandId, bytes: size });
  }

  return { results, sent, oversized };
}

/** The stored outcome as the wire wants it. Absent `value`/`error` stay absent — a `null`
 *  reason is "no error", not an error whose message is null. */
function toCommandResult(row: PendingResultRow): CommandResult {
  return {
    commandId: row.commandId,
    ok: row.ok,
    ...(row.value === undefined ? {} : { value: row.value }),
    ...(row.reason === null ? {} : { error: row.reason }),
  };
}

/** What a browser is told instead of an answer that cannot fit in any request. */
function unsendable(commandId: string, bytes: number): CommandResult {
  return {
    commandId,
    ok: false,
    error: `The desktop's answer was too large to send (${bytes} bytes).`,
  };
}

/** `+ 1` for the comma joining it to its neighbours, exactly as `cloudDelta.rowBytes` counts. */
function resultBytes(result: CommandResult): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf8') + 1;
}
