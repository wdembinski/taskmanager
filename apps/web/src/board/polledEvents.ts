/**
 * The engine's events, rebuilt from polls — apps/web's FALLBACK when nothing is pushing.
 *
 * There IS a push channel now (`sseEvents.ts`), and `eventBus.ts` is the composite that
 * chooses between the two. This is the half that runs when the stream is not connected, and
 * it keeps its baselines across the switch so that the first poll after a resume announces
 * everything that changed while the stream was quietly broken. Nothing below has changed
 * because of that; what follows still describes this half exactly, and the map of absences at
 * the bottom is now a statement about the fallback rather than about the app.
 *
 * The desktop's renderer subscribes to a dozen `IpcEvents` channels and the engine pushes to
 * them over Electron IPC. There is no such wire here (docs/plan/README.md's "No realtime
 * service": one polled round trip per tick, because at the active tier's 2.5s a second
 * request is a second bill), so `on()` used to return a no-op and every shared component
 * that depends on an event simply never updated.
 *
 * Almost all of those events are "here is the whole new list" — `chain:changed`,
 * `attachment:changed`, `mergeRequests:changed`, `settings:changed` — and every one of
 * them has a READ that returns exactly the same thing. So the event is reconstructible: call
 * the read, compare it with last time, and fan out when it differs. That is all this is.
 *
 * THREE RULES IT FOLLOWS
 * ----------------------
 *  1. **Only what someone is subscribed to is read.** A tab with no detail pane open must
 *     not be polling `attachment:list`. Subscribing starts the read; the last unsubscribe
 *     stops it.
 *  2. **Diff before emitting.** These are whole-list events and the components treat them as
 *     replacements, so emitting an unchanged list would re-render the board on every tick
 *     forever.
 *  3. **Never emit on the first read.** The first poll is the mount value, not a change, and
 *     a component that has just loaded the same list itself does not need telling.
 *
 * TWO EVENTS DO NOT SURVIVE, AND SAYING SO IS THE POINT
 * -----------------------------------------------------
 *  - `window:maximizedChanged` — host-only anyway; a browser tab has no such window.
 *  - `board:notice` — a transient toast. It is not derivable from any read, because it is
 *    not state: it is a sentence the engine said once during a sync. Polling cannot recover
 *    something that was never stored, and inventing a store for it server-side would be
 *    mirroring a toast. Accepted as lost.
 *
 * `session:event` is also absent, and for a third reason: it is a live stream of a running
 * agent's output, at whatever rate the model emits. Reconstructing it from `task:history`
 * diffs would work and would be a bad idea — the transcript is the largest thing this app
 * could poll. The web reads `task:activity` instead, which is what the timeline actually
 * renders.
 *
 * Pure and fake-`invoke` testable: it holds no React, no fetch, and no `Transport`.
 */
import type { IpcApi, IpcEvents } from '@tm/shared/ipc';

/** The one thing this needs from a host — the same `invoke` `Transport` exposes. */
export interface PolledEventBusDeps {
  invoke: <K extends keyof IpcApi>(
    channel: K,
    ...args: Parameters<IpcApi[K]>
  ) => Promise<Awaited<ReturnType<IpcApi[K]>>>;
  /** Poll interval while at least one channel is subscribed. Matches the board's own tier. */
  intervalMs?: number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  /** Called when a read rejects. Default: swallow — a failed poll is not a failed app. */
  onError?: (channel: string, error: unknown) => void;
}

/** The board's active-tier cadence, so events land on the same rhythm the cards do. */
const DEFAULT_INTERVAL_MS = 2_500;

/**
 * How each supported event is reproduced: the read that returns its payload, and how to
 * decide two payloads are the same thing.
 *
 * `same` is JSON equality for all of them, and deliberately so — these payloads are the
 * whole list, they came off a wire as JSON, and a field-aware comparison would be a second
 * copy of every model's shape maintained by hand. The lists are board-sized, not
 * transcript-sized.
 */
/**
 * The reproducible events.
 *
 * `task:changed` is the odd one: its payload is ONE task, and the read that covers it
 * (`board:tasks`) returns all of them. It is fanned out per changed card rather than emitted
 * whole — which is exactly what the desktop's engine does, one event per task, so the
 * subscriber sees no difference.
 */
const WHOLE_LIST_EVENTS = {
  'chain:changed': 'chain:links',
  'attachment:changed': 'attachment:list',
  'mergeRequests:changed': 'mr:mergeRequests',
  'settings:changed': 'settings:get',
  'sync:changed': 'sync:state',
  'update:changed': 'update:get',
  'limit:changed': 'limit:current',
  'auth:changed': 'auth:current',
  'task:integrating': 'scheduler:integrating',
} as const satisfies Partial<Record<keyof IpcEvents, keyof IpcApi>>;

/** Every event this bus can reproduce — the whole-list ones plus the two derived below. */
export const REPRODUCIBLE_EVENTS: ReadonlyArray<keyof IpcEvents> = [
  ...(Object.keys(WHOLE_LIST_EVENTS) as Array<keyof IpcEvents>),
  'task:changed',
  'attention:new',
  'attention:resolved',
];

/**
 * Events THIS BUS cannot rebuild, with the reason, so a caller can say so in the UI.
 *
 * Read as "why is nothing arriving on this channel *while the app is polling*". Several of
 * these do arrive when the push stream is connected (`eventBus.ts`), which is the whole point
 * of having built it — a poll can only ever find state that is still there to be read, and a
 * push carries the occurrence itself.
 */
export const UNREPRODUCIBLE_EVENTS: Readonly<Record<string, string>> = {
  'window:maximizedChanged': 'a browser tab has no app window to maximize',
  'board:notice': 'a one-off notice is not state, so a poll cannot find it again',
  'session:event':
    'a live transcript is pushed, not polled — it is far too large to re-read on a timer, ' +
    'so while the event stream is down the timeline stops until the run settles',
  'session:gap':
    'a poll has no stream to lose lines from, so it never has a hole to admit to — which is ' +
    'not the same as being complete; see `session:event` above',
  'project:tasksChanged': 'the board is mirrored directly; this app reads it from the mirror',
  'scheduler:changed': 'no project queues are shown in the browser',
  'usage:sample': 'a per-second sample cannot survive a 2.5s poll — the chart redraws instead',
};

type Listener = (payload: never) => void;

export class PolledEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();
  /** The last payload seen per event, so a poll can tell a change from a repeat. */
  private readonly last = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private disposed = false;
  private paused = false;

  constructor(private readonly deps: PolledEventBusDeps) {}

  /**
   * Stop polling WITHOUT forgetting anything — subscriptions, and above all the baselines,
   * are kept exactly as they are.
   *
   * For `eventBus.ts`, which pauses this bus for as long as the pushed stream is connected.
   * Disposing or unsubscribing instead would drop the baselines, and the baselines are what
   * make the resume worth having: the first poll after one diffs against the board as it was
   * when the stream took over, so a change the stream failed to deliver is announced rather
   * than silently absorbed into a fresh baseline.
   *
   * {@link poll} still works while paused, and deliberately: a caller that KNOWS it has a
   * hole (the stream said so) wants exactly one pass, not a timer.
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.stop();
  }

  /** Poll again, starting with an immediate pass — see {@link pause}. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.listeners.size > 0) this.start();
  }

  /**
   * Subscribe. Returns the unsubscribe, exactly as `Transport.on` promises.
   *
   * An event this bus cannot reproduce gets a live subscription that simply never fires,
   * rather than a throw: the caller is shared UI that also runs on the desktop, where the
   * event is real, and making it branch on the host is what `Transport` exists to avoid.
   */
  on<K extends keyof IpcEvents>(channel: K, callback: (payload: IpcEvents[K]) => void): () => void {
    const set = this.listeners.get(channel) ?? new Set<Listener>();
    set.add(callback as Listener);
    this.listeners.set(channel, set);
    this.start();

    return () => {
      const live = this.listeners.get(channel);
      if (!live) return;
      live.delete(callback as Listener);
      if (live.size === 0) {
        this.listeners.delete(channel);
        // Forget the baseline too: a later subscriber must not be handed a "change" measured
        // against a list nobody has been watching since.
        this.last.delete(channel);
        if (!this.listeners.has('attention:new') && !this.listeners.has('attention:resolved')) {
          this.last.delete(ATTENTION_BASELINE);
        }
      }
      if (this.listeners.size === 0) this.stop();
    };
  }

  /**
   * One pass over every subscribed channel. Exposed so a test need not run a timer.
   *
   * Serial, not `Promise.all`: each read is a full relayed round trip through the desktop,
   * and firing eight of them at once would put eight commands in one drain — which is
   * serial on the other side anyway, so the concurrency buys nothing and costs eight
   * simultaneous `POST /v1/commands`.
   */
  async poll(): Promise<void> {
    if (this.disposed) return;
    // Joining a pass already in flight rather than skipping: `start()` fires one the instant
    // something subscribes, and a caller that asked to poll deserves a resolved promise that
    // means "a poll has finished", not one that means "somebody else was busy".
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runPass().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runPass(): Promise<void> {
    // The two attention events share one read, so they are polled once between them rather
    // than once each.
    if (this.listeners.has('attention:new') || this.listeners.has('attention:resolved')) {
      await this.pollAttention();
    }
    for (const channel of [...this.listeners.keys()]) {
      if (channel === 'attention:new' || channel === 'attention:resolved') continue;
      await this.pollChannel(channel);
    }
  }

  /**
   * The inbox, as the two events the desktop pushes for it.
   *
   * `attention:list` is one list and the engine's two events are its edges: an item that has
   * appeared is `attention:new`, one that has gone is `attention:resolved` (which carries
   * only the id, because by then there is nothing left to carry). An item whose CONTENT
   * changed emits neither — the desktop does not re-announce one either, and the pane holds
   * the item it was given.
   */
  private async pollAttention(): Promise<void> {
    let items: Array<{ id: string }>;
    try {
      items = (await this.deps.invoke('attention:list')) as Array<{ id: string }>;
    } catch (error) {
      this.deps.onError?.('attention:list', error);
      return;
    }

    const encoded = new Map(items.map((item) => [item.id, JSON.stringify(item)]));
    const previous = this.last.get(ATTENTION_BASELINE);
    this.last.set(ATTENTION_BASELINE, JSON.stringify([...encoded]));
    if (previous === undefined) return; // baseline — the pane loaded this itself

    const before = new Map(JSON.parse(previous) as Array<[string, string]>);
    for (const [id, item] of encoded) {
      if (!before.has(id)) this.fan('attention:new', JSON.parse(item) as unknown);
    }
    for (const id of before.keys()) {
      if (!encoded.has(id)) this.fan('attention:resolved', { id });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.listeners.clear();
    this.last.clear();
  }

  private async pollChannel(channel: string): Promise<void> {
    const read = readFor(channel);
    if (!read) return;
    try {
      this.emitIfChanged(channel, await this.deps.invoke(read as 'chain:links'));
    } catch (error) {
      // Reported by the READ that failed, not the event it feeds: "chain:links is refusing"
      // is diagnosable and "chain:changed is refusing" names a channel nothing ever called.
      this.deps.onError?.(read, error);
    }
  }

  /**
   * Emit unless the payload is byte-identical to the last one seen.
   *
   * `task:changed` is special-cased into per-card events here rather than in the reproducer,
   * because the diff has to be per card too: emitting the whole board when one card moved
   * would make every open pane re-read.
   */
  private emitIfChanged(channel: string, payload: unknown): void {
    if (channel === 'task:changed') {
      this.emitChangedTasks(payload as Array<{ id: string }>);
      return;
    }
    const encoded = JSON.stringify(payload ?? null);
    const first = !this.last.has(channel);
    if (this.last.get(channel) === encoded) return;
    this.last.set(channel, encoded);
    // The first read is the mount value, not a change. Recorded as the baseline and not
    // announced — the component that just subscribed has already loaded this itself.
    if (first) return;
    this.fan(channel, payload);
  }

  private emitChangedTasks(tasks: Array<{ id: string }>): void {
    const previous = this.last.get('task:changed');
    const byId = new Map(tasks.map((task) => [task.id, JSON.stringify(task)]));
    this.last.set('task:changed', JSON.stringify([...byId]));
    if (previous === undefined) return; // baseline

    const before = new Map(JSON.parse(previous) as Array<[string, string]>);
    for (const [id, encoded] of byId) {
      if (before.get(id) === encoded) continue;
      this.fan('task:changed', { task: JSON.parse(encoded) as unknown, runId: null });
    }
  }

  private fan(channel: string, payload: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) {
      (listener as (p: unknown) => void)(payload);
    }
  }

  private start(): void {
    if (this.timer || this.disposed || this.paused) return;
    const set = this.deps.setIntervalImpl ?? setInterval;
    this.timer = set(() => void this.poll(), this.deps.intervalMs ?? DEFAULT_INTERVAL_MS);
    // Read once immediately so the baseline is established without waiting a whole interval,
    // which also means the first real change is caught one interval sooner.
    void this.poll();
  }

  private stop(): void {
    if (!this.timer) return;
    const clear = this.deps.clearIntervalImpl ?? clearInterval;
    clear(this.timer);
    this.timer = null;
  }
}

/** The `IpcApi` read that reproduces this event, or null if nothing does. */
function readFor(channel: string): keyof IpcApi | null {
  const whole = (WHOLE_LIST_EVENTS as Record<string, keyof IpcApi | undefined>)[channel];
  if (whole) return whole;
  // The board, from which `emitChangedTasks` does the per-card diff.
  if (channel === 'task:changed') return 'board:tasks';
  return null;
}

/** The key `pollAttention` keeps its baseline under — not an event name, so it cannot clash. */
const ATTENTION_BASELINE = '@attention';
