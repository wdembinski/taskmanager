/**
 * Which queued commands a Client's sync should be handed, and when a delivered one becomes
 * deliverable again — the two decisions behind `MirrorService.sync`'s queue read, kept pure
 * so they can be tested without a database, the way `rowVersion.ts` is.
 *
 * WHAT WAS WRONG
 * --------------
 * Delivery was **at-most-once while every docstring claimed at-least-once**. `sync()` set
 * `deliveredAt` inside the same transaction that read the queue and filtered on
 * `deliveredAt IS NULL`, so a command was struck off the moment it was put on the wire.
 * `SyncRequest.ackedCommandIds` was accepted and never read. If the HTTP response carrying
 * a command was lost — a dropped connection, a proxy timeout, a desktop app quit between
 * receiving and applying — nothing ever sent it again.
 *
 * That was survivable for `set-status`, whose effect the browser observes through the mirror
 * and whose optimistic overlay expires on its own. It is not survivable for an `ipc-invoke`:
 * a browser is holding an unresolved promise, and "the reply was lost" and "the desktop has
 * not answered yet" look identical from there, forever.
 *
 * THE LEASE
 * ---------
 * So `deliveredAt` becomes a LEASE rather than a tombstone, and `ackedAt` — set when the
 * applying Client names the id in `ackedCommandIds` — is what actually retires a row. A
 * delivered, unacked command whose lease has expired goes out again.
 *
 * The lease has to be longer than one cadence interval plus the slowest handler that can be
 * relayed, or a command still legitimately running gets sent a second time. `jira:sync` and
 * `gitlab:sync` walk whole issue lists over the network and are minutes-scale, and the drain
 * is serial, so a slow one delays the ones behind it too. {@link COMMAND_LEASE_MS} is set
 * from that, not from how long a fast command takes.
 *
 * Redelivery is safe rather than merely tolerated: the applying Client keys on
 * `CommandEnvelope.id` against its own ledger (`cloud_applied_commands`) and REPLAYS the
 * stored result instead of running the handler again — see `cloudCommands.ts`.
 */

/**
 * How long a delivered command stays off the queue before it is offered again.
 *
 * Five minutes. The inputs: one idle-tier cadence interval (25s), plus the slowest handler
 * a browser can ask for — `jira:sync` and `gitlab:sync` page through a tracker's API and
 * have been observed in the minutes — plus the fact that the drain is serial, so a slow one
 * holds the queue behind it. Erring long costs a lost command five minutes of extra silence;
 * erring short costs a duplicate delivery of something still running, which the ledger
 * absorbs but which would also re-lease the row and could loop.
 */
export const COMMAND_LEASE_MS = 5 * 60 * 1000;

/** The fields of a queued command row this module reasons about. */
export interface LeasableCommand {
  id: string;
  /** When it was last put on the wire, or null if it never has been. */
  deliveredAt: Date | null;
  /** When the target Client confirmed it had it. Null until then. */
  ackedAt: Date | null;
}

/**
 * Whether this row should go out on a sync happening at `now`.
 *
 * Three states, in the order they are reached:
 *  - never delivered → yes, this is its first delivery;
 *  - delivered and acked → no, it is retired and stays in the table as an audit trail;
 *  - delivered, unacked → only once its lease has expired.
 *
 * The boundary is exclusive (`>`, not `>=`) so a lease of zero would still not redeliver
 * within the same millisecond it was issued in — a test that stubs the clock deserves that
 * to be predictable rather than a coin toss.
 */
export function isDeliverable(
  command: LeasableCommand,
  now: number,
  leaseMs: number = COMMAND_LEASE_MS,
): boolean {
  if (command.ackedAt !== null) return false;
  if (command.deliveredAt === null) return true;
  return now - command.deliveredAt.getTime() > leaseMs;
}

/**
 * The instant a lease issued now expires — the value a `deliveredAt < ?` predicate compares
 * against, so the SQL and {@link isDeliverable} cannot drift into two different rules.
 */
export function leaseCutoff(now: number, leaseMs: number = COMMAND_LEASE_MS): Date {
  return new Date(now - leaseMs);
}

/**
 * Which of the ids a Client just acked are real, unacked rows of ITS own — the set safe to
 * stamp `ackedAt` on.
 *
 * Filtered rather than trusted because `ackedCommandIds` is caller-supplied: a Client that
 * has been offline for a week acks a batch it applied before it lost the connection, and
 * some of those rows may already be acked (its previous ack landed, its response did not).
 * Re-stamping one would move an audit timestamp for no reason, and acking an id belonging to
 * another Client would retire a command that had never been delivered at all.
 */
export function acknowledgeable(
  rows: readonly LeasableCommand[],
  ackedIds: readonly string[],
): string[] {
  if (ackedIds.length === 0) return [];
  const claimed = new Set(ackedIds);
  return rows.filter((row) => row.ackedAt === null && claimed.has(row.id)).map((row) => row.id);
}
