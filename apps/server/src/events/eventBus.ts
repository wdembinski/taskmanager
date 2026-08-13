import { Injectable, Logger } from '@nestjs/common';
import type { EventEnvelope, GapFrame, GapReason } from '@tm/protocol/wire';
import { isForwarded } from '@tm/shared/ipcEventFanout';

/**
 * The push channel's middle: every engine event a desktop hands over, fanned out to whichever
 * browsers on that account are watching right now.
 *
 * **Nothing here touches the database, and that is the design, not an omission.** An event is
 * a moment — "the agent wrote a line", "a card moved" — and the state it describes is already
 * mirrored on its own schedule by `MirrorService`. Persisting the moments too would buy a
 * second, slower copy of the same truth and a write on every line an agent emits, which is the
 * write-amplification Phase 25's cost estimate ruled out for presence and rules out here for
 * the same money. So the only durability this module has is the replay ring below, which is
 * measured in seconds and lives in this process.
 *
 * That makes it one more thing (with `PresenceRegistry` and `IamAuthGuard`'s auth caches) that
 * is per-process and therefore **only correct on one replica** — see
 * `docs/09-deploying-the-cloud-service.md`, where that assumption is now pinned rather than
 * assumed.
 *
 * Three bounds, each against a different way this could grow without limit:
 *
 *  - {@link REPLAY_LIMIT}/{@link REPLAY_WINDOW_MS} — what a reconnecting browser can be given
 *    back. Sized for the gap a reconnect actually leaves, not for history.
 *  - {@link SUBSCRIBER_QUEUE_LIMIT} — one slow reader's backlog. Beyond it the OLDEST events
 *    go and the subscriber is told, because a transcript's newest lines are the ones somebody
 *    is watching, and a silent drop shows a plausible, wrong picture of what an agent did.
 *  - the account map itself, reclaimed once an account has no subscribers and nothing left to
 *    replay.
 */

/**
 * How many events the replay ring holds per account.
 *
 * It exists for exactly one gap: the ~1s between the server closing a stream at its
 * {@link SSE_MAX_LIFETIME_MS} and the browser reconnecting. 200 is what a running agent emits
 * in a few seconds of heavy output — generous for that gap and nowhere near a history.
 */
export const REPLAY_LIMIT = 200;

/**
 * And an age bound on top of the count, because 200 events can be a second or an hour.
 *
 * 30s: past that, a browser has been away long enough that re-reading the board is both
 * cheaper and more honest than replaying a burst of stale moments at it.
 */
export const REPLAY_WINDOW_MS = 30_000;

/**
 * How many events one subscriber may have queued before the server starts shedding.
 *
 * Reached only by a reader that has stopped reading — the socket's own buffer absorbs an
 * ordinary slow connection — so this is the backstop against a tab that is suspended, or a
 * connection that is dead but not yet closed, holding memory proportional to how long an agent
 * keeps talking.
 */
export const SUBSCRIBER_QUEUE_LIMIT = 500;

/**
 * How long after its last subscriber leaves an account still counts as watched.
 *
 * Without it, {@link EventBus.listeners} answers 0 for the second between the server's own
 * lifetime close and the browser's reconnect — and a desktop reading that as "nobody is
 * watching" stops forwarding until its next sync says otherwise, which puts a hole in the
 * stream every five minutes by design. 15s covers a reconnect (and a page reload) without
 * keeping a closed tab alive for long.
 */
export const LISTENER_GRACE_MS = 15_000;

/** One event on the wire out, with the id its SSE frame carries. */
export interface StreamedEvent {
  /**
   * Monotonic **per account, assigned by this server** — deliberately not
   * `EventEnvelope.seq`, which is per sending desktop Client and so is not comparable
   * between two of them. `Last-Event-ID` resumes from this one.
   */
  readonly id: number;
  readonly envelope: EventEnvelope;
  /** When the server received it — what {@link REPLAY_WINDOW_MS} is measured against. */
  readonly receivedAt: number;
}

/** What a drain hands the stream: the gap that precedes these events, then the events. */
export interface DrainedEvents {
  events: StreamedEvent[];
  gap: GapFrame | null;
}

interface AccountStream {
  /** The last id issued on this account. Ids are contiguous, which is what makes a gap countable. */
  lastId: number;
  replay: StreamedEvent[];
  subscribers: Set<EventSubscription>;
  /** Epoch ms until which a departed subscriber still counts — see {@link LISTENER_GRACE_MS}. */
  graceUntil: number;
}

/**
 * One browser's view of the stream: a bounded queue, the hole it knows about, and a wake-up.
 *
 * Queue-then-wake rather than write-through, because the writer is a socket that can refuse:
 * `sseStream.ts` drains this when it can write and stops when it cannot, and the bound above
 * is what keeps a reader that never comes back from costing unbounded memory.
 */
export class EventSubscription {
  private readonly queue: StreamedEvent[] = [];
  private pendingGap: GapFrame | null;
  private wake: (() => void) | null = null;
  private closed = false;

  constructor(
    readonly accountId: string,
    /** Whether the requested `Last-Event-ID` was still replayable — the `hello` frame's field. */
    readonly resumed: boolean,
    /** The position asked for, echoed on `hello`. */
    readonly lastEventId: number | null,
    backlog: readonly StreamedEvent[],
    gap: GapFrame | null,
    private readonly detach: (subscription: EventSubscription) => void,
  ) {
    this.queue.push(...backlog);
    this.pendingGap = gap;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Registers the pump, and fires it immediately if anything is already waiting — a resumed
   * subscription is born with a backlog, and nothing else would come along to notice it.
   */
  onWake(listener: () => void): void {
    this.wake = listener;
    if (this.queue.length > 0 || this.pendingGap) listener();
  }

  /** Everything queued since the last drain, and the hole in front of it. */
  drain(): DrainedEvents {
    const events = this.queue.splice(0, this.queue.length);
    const gap = this.pendingGap;
    this.pendingGap = null;
    return { events, gap };
  }

  /** @internal — called by {@link EventBus.publish}. */
  offer(events: readonly StreamedEvent[]): void {
    if (this.closed || events.length === 0) return;
    this.queue.push(...events);
    const overflow = this.queue.length - SUBSCRIBER_QUEUE_LIMIT;
    if (overflow > 0) {
      this.queue.splice(0, overflow);
      this.noteGap('shed', overflow);
    }
    this.wake?.();
  }

  /**
   * @internal — records a hole.
   *
   * Two holes merge into one frame, keeping the FIRST reason (what went wrong first is what a
   * reader would want to act on) and summing the counts — unless either is unknown, in which
   * case so is the total. A gap that lies low is worse than one that admits it cannot count.
   */
  noteGap(reason: GapReason, count?: number): void {
    if (this.closed) return;
    const previous = this.pendingGap;
    if (!previous) {
      this.pendingGap = count === undefined ? { reason } : { reason, count };
    } else if (previous.count === undefined || count === undefined) {
      this.pendingGap = { reason: previous.reason };
    } else {
      this.pendingGap = { reason: previous.reason, count: previous.count + count };
    }
    this.wake?.();
  }

  /** Idempotent: the stream closes on its own lifetime AND on the peer hanging up. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake = null;
    this.queue.length = 0;
    this.detach(this);
  }
}

@Injectable()
export class EventBus {
  private readonly logger = new Logger('EventBus');
  private readonly accounts = new Map<string, AccountStream>();

  /**
   * Takes one desktop's batch and hands it to every browser watching that account.
   *
   * `senderGap` is what the forwarder admits to having dropped before this batch
   * (`EventBatchRequest.gap`); it travels through as a `gap` frame rather than being counted
   * here, because only the sender knows it happened.
   *
   * Channels classified `drop` by `@tm/shared/ipcEventFanout` are refused even if a Client
   * forwards them. The forwarder applies the same table, so this is the server declining to
   * trust that it did: `project:tasksChanged` reaching a browser twice — once here, once
   * through the mirror — is exactly the stale second copy that table's `drop` reason names.
   */
  publish(accountId: string, envelopes: readonly EventEnvelope[], senderGap = 0): void {
    const now = Date.now();
    const stream = this.streamFor(accountId);

    if (senderGap > 0) {
      for (const subscriber of stream.subscribers) subscriber.noteGap('sender', senderGap);
    }

    const stamped: StreamedEvent[] = [];
    for (const envelope of envelopes) {
      if (!isForwarded(envelope.channel)) continue;
      stamped.push({ id: ++stream.lastId, envelope, receivedAt: now });
    }

    if (stamped.length > 0) {
      stream.replay.push(...stamped);
      for (const subscriber of stream.subscribers) subscriber.offer(stamped);
    }

    this.prune(now);
  }

  /**
   * Opens one browser's subscription, replaying whatever it missed if it can be replayed.
   *
   * The three outcomes a `lastEventId` can have are the whole point of the ring:
   *
   *  - it names the newest id, or everything after it is still held → `resumed`, no hole;
   *  - the events after it have aged out → the hole is COUNTABLE, because ids are contiguous
   *    per account: `firstAvailable - lastEventId - 1`;
   *  - it is ahead of anything this process ever issued → the server restarted or reclaimed
   *    the account, and the size of the hole is genuinely unknown (`reset`).
   */
  subscribe(accountId: string, lastEventId: number | null, now = Date.now()): EventSubscription {
    const stream = this.streamFor(accountId);
    this.expire(stream, now);

    let resumed = false;
    let backlog: StreamedEvent[] = [];
    let gap: GapFrame | null = null;

    if (lastEventId !== null) {
      if (lastEventId > stream.lastId) {
        gap = { reason: 'reset' };
      } else {
        backlog = stream.replay.filter((event) => event.id > lastEventId);
        const firstAvailable = backlog.length > 0 ? backlog[0]!.id : stream.lastId + 1;
        const missed = firstAvailable - lastEventId - 1;
        if (missed <= 0) resumed = true;
        else gap = { reason: 'expired', count: missed };
      }
      if (!resumed) {
        this.logger.log(
          `account=${accountId} resume=failed from=${lastEventId} reason=${gap?.reason ?? 'none'}`,
        );
      }
    }

    const subscription = new EventSubscription(
      accountId,
      resumed,
      lastEventId,
      backlog,
      gap,
      (departing) => this.detach(departing),
    );
    stream.subscribers.add(subscription);
    stream.graceUntil = 0;
    return subscription;
  }

  /**
   * How many browsers are watching this account — `SyncResponse.eventListeners` and
   * `EventBatchResponse.listeners`, i.e. the only thing that tells a desktop whether forwarding
   * is worth the bytes.
   *
   * Errs HIGH for {@link LISTENER_GRACE_MS} after the last one leaves, and deliberately: the
   * question a desktop is really asking is "is anyone there", and answering 0 during the
   * reconnect this server itself forced would tear a hole in the stream every five minutes.
   */
  listeners(accountId: string, now = Date.now()): number {
    const stream = this.accounts.get(accountId);
    if (!stream) return 0;
    if (stream.subscribers.size > 0) return stream.subscribers.size;
    return now < stream.graceUntil ? 1 : 0;
  }

  private streamFor(accountId: string): AccountStream {
    let stream = this.accounts.get(accountId);
    if (!stream) {
      stream = { lastId: 0, replay: [], subscribers: new Set(), graceUntil: 0 };
      this.accounts.set(accountId, stream);
    }
    return stream;
  }

  private detach(subscription: EventSubscription): void {
    const stream = this.accounts.get(subscription.accountId);
    if (!stream) return;
    stream.subscribers.delete(subscription);
    if (stream.subscribers.size === 0) stream.graceUntil = Date.now() + LISTENER_GRACE_MS;
  }

  /** Ages the ring out by time first, then by count — both bounds, in that order. */
  private expire(stream: AccountStream, now: number): void {
    while (stream.replay.length > 0 && now - stream.replay[0]!.receivedAt > REPLAY_WINDOW_MS) {
      stream.replay.shift();
    }
    if (stream.replay.length > REPLAY_LIMIT) {
      stream.replay.splice(0, stream.replay.length - REPLAY_LIMIT);
    }
  }

  /**
   * Ages every account's ring, and forgets the ones with nothing left.
   *
   * The whole map rather than just the account being published to, because an account is only
   * ever reclaimable while nothing is happening on it — pruning lazily on touch would keep a
   * desktop that went offline forever. It is cheap: this map holds accounts with a desktop
   * currently forwarding, and a publish is already a network round trip.
   *
   * Forgetting an account loses its `lastId`, which is what a later `reset` gap admits to.
   * That only happens after the ring has aged out AND nobody has watched for
   * {@link LISTENER_GRACE_MS}, by which point a resume would have been `expired` anyway.
   */
  private prune(now: number): void {
    for (const [accountId, stream] of this.accounts) {
      this.expire(stream, now);
      if (stream.subscribers.size === 0 && stream.replay.length === 0 && now >= stream.graceUntil) {
        this.accounts.delete(accountId);
      }
    }
  }
}
