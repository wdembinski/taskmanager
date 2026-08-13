/**
 * What happens to each engine EVENT on its way to a browser — and which ones never leave the
 * machine they were pushed on.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `ipcRelay.ts` is this file's mirror image for the other direction: it decides which
 * `IpcApi` calls a browser may make of a desktop Client. This one decides which `IpcEvents`
 * pushes travel back. The two problems look alike and are not. An invoke is one call a human
 * just made, and the only question is whether it makes sense over there. An event is a firehose
 * nobody asked for — a running agent emits `session:event` at whatever rate the model writes —
 * so the question here is not only *may* it travel, but *how much of it has to*.
 *
 * Hence four classes rather than two flags, one per way an event's volume can be honestly
 * reduced:
 *
 *  - **replace-last** — the whole-list events. `chain:changed`, `settings:changed` and the
 *    rest carry a complete replacement, so a queue holding three of them is holding two
 *    stale copies. Exactly the set `apps/web/src/board/polledEvents.ts` already reproduces
 *    from reads, and for the same reason: replacing is idempotent.
 *  - **replace-by-key** — one subject's whole state. `task:changed` is a card; two updates for
 *    the same card collapse, two for different cards must not.
 *  - **stream** — an edge, not a state. `session:event` is a line of a transcript and
 *    `attention:new` is an item appearing; dropping one loses the event itself, so these are
 *    queued in full and shed only under real pressure — which is what `session:gap` and
 *    `EventBatchRequest.gap` exist to admit to.
 *  - **drop** — never forwarded at all, with the reason written down.
 *
 * THE GATE
 * --------
 * {@link EVENT_FANOUT} is **exhaustive over `keyof IpcEvents`** under the same `satisfies`
 * gate `ipcRelay.ts` uses, and for the same reason: a new event channel fails `pnpm typecheck`
 * here until somebody classifies it. A hand-kept list would silently default a new channel to
 * one behaviour or the other, and the first person to find out would be whoever's browser tab
 * either missed an event or was buried in them.
 *
 * Pure: no transport, no queue, no timers. The forwarder that reads this lives in apps/client
 * and the receiver in apps/web; both are later steps.
 */
import type { IpcEvents } from './ipc';
import type { SchedulerChange, TaskChange } from './scheduler';

/**
 * How one channel's events are queued for a remote listener.
 *
 * `Payload` is the channel's own `IpcEvents[K]`, so a `replace-by-key` policy's `key` is
 * written against the real payload type rather than casting inside the table.
 */
export type FanoutPolicy<Payload = unknown> =
  /** Coalesce to the newest: the payload is a complete replacement for the last one. */
  | { readonly kind: 'replace-last' }
  /** Coalesce per subject: the payload is a complete replacement for that subject only. */
  | { readonly kind: 'replace-by-key'; readonly key: (payload: Payload) => string }
  /** Never coalesce: each event is an occurrence, and merging two loses one. */
  | { readonly kind: 'stream' }
  /** Never forward. `reason` is the sentence, kept beside the decision. */
  | { readonly kind: 'drop'; readonly reason: string };

/**
 * A policy read out of the table BY NAME, where the payload's type is no longer known.
 *
 * `never` rather than `unknown` because a function parameter is contravariant under
 * `strictFunctionTypes`: `(change: TaskChange) => string` is assignable to `(p: never) =>
 * string` and not to `(p: unknown) => string`. {@link coalesceKey} is the one place that
 * calls it, and it casts there.
 */
export type AnyFanoutPolicy = FanoutPolicy<never>;

/**
 * Every event channel and what becomes of it, exhaustive over `IpcEvents`.
 *
 * **The whole-list events** are `replace-last` to a channel. They are the ones
 * `polledEvents.ts` names, plus `usage:sample` — which is not a list, but whose two
 * subscribers (`Performance.tsx`, `UsageQuotaBars.tsx`) ignore its payload entirely and
 * re-read on it, so a burst of samples is one wake-up and coalescing them costs nothing.
 *
 * **`task:changed`** keys by the card. So do `scheduler:changed` (by project) and
 * `session:gap` (by run) — a second "this run has holes" is the same fact as the first, and
 * the consumer's answer to either is one re-read.
 *
 * **The streams** are the ones with no read behind them. `session:event` is the agent's
 * output as it happens; `attention:new` / `attention:resolved` are the inbox's two edges;
 * `board:notice` is a sentence the engine said once, which `polledEvents.ts` calls
 * unreproducible for exactly this reason — a poll cannot find a toast again, but a push can
 * carry one.
 *
 * **The two drops** are dropped for opposite reasons. `window:maximizedChanged` is about a
 * window a browser tab does not have. `project:tasksChanged` carries a project's whole task
 * list — rows that already reach the browser through the mirror, on their own schedule, so
 * forwarding them ships the same data twice and the second copy is the one that can be stale.
 */
export const EVENT_FANOUT = {
  'session:event': { kind: 'stream' },
  'session:gap': { kind: 'replace-by-key', key: (gap: { runId: string }) => gap.runId },

  'task:changed': { kind: 'replace-by-key', key: (change: TaskChange) => change.task.id },
  'task:integrating': { kind: 'replace-last' },

  'scheduler:changed': {
    kind: 'replace-by-key',
    key: (change: SchedulerChange) => change.projectId,
  },

  'attention:new': { kind: 'stream' },
  'attention:resolved': { kind: 'stream' },
  'board:notice': { kind: 'stream' },

  'limit:changed': { kind: 'replace-last' },
  'auth:changed': { kind: 'replace-last' },
  'usage:sample': { kind: 'replace-last' },
  'mergeRequests:changed': { kind: 'replace-last' },
  'chain:changed': { kind: 'replace-last' },
  'attachment:changed': { kind: 'replace-last' },
  'sync:changed': { kind: 'replace-last' },
  'settings:changed': { kind: 'replace-last' },
  'update:changed': { kind: 'replace-last' },

  'window:maximizedChanged': {
    kind: 'drop',
    reason: 'a browser tab has no app window to maximize',
  },
  'project:tasksChanged': {
    kind: 'drop',
    reason: 'those rows already reach the browser through the mirror',
  },
} satisfies { [K in keyof IpcEvents]: FanoutPolicy<IpcEvents[K]> };

/**
 * This channel's policy, or `null` when the name is not an event channel at all.
 *
 * The ownership check is not ceremony: `EVENT_FANOUT` is an object literal, so
 * `EVENT_FANOUT['constructor']` is a function rather than `undefined` and a plain lookup
 * would hand back a "policy" for a name that is not a channel. `ipcRelay.ts` escapes this by
 * comparing the value to a string; here the value is an object, so the key is what gets
 * checked.
 */
export function fanoutPolicy(channel: string): AnyFanoutPolicy | null {
  if (!Object.prototype.hasOwnProperty.call(EVENT_FANOUT, channel)) return null;
  return (EVENT_FANOUT as Record<string, AnyFanoutPolicy | undefined>)[channel] ?? null;
}

/** Whether this channel's events travel to a remote listener at all. */
export function isForwarded(channel: string): channel is keyof IpcEvents {
  const policy = fanoutPolicy(channel);
  return policy !== null && policy.kind !== 'drop';
}

/** Why a channel is never forwarded, or `null` when it is (or is not a channel). */
export function dropReason(channel: string): string | null {
  const policy = fanoutPolicy(channel);
  return policy?.kind === 'drop' ? policy.reason : null;
}

/**
 * The separator between a channel name and its subject in a coalescing key.
 *
 * A NUL, because it cannot appear in a channel name or in a task / run / project id — so
 * `'a'` + `'b:c'` and `'a:b'` + `'c'` cannot produce the same key and collapse two subjects
 * into one.
 */
const KEY_SEPARATOR = '\u0000';

/**
 * The key a queued event coalesces on, or `null` when it must not coalesce.
 *
 * One string covers both coalescing classes so a queue needs one `Map` and no branch: a
 * `replace-last` channel keys on its own name, a `replace-by-key` one on the name plus its
 * subject.
 *
 * `null` for a stream — and also for a channel that is dropped or unknown, neither of which
 * should have reached a queue: callers ask {@link isForwarded} first.
 */
export function coalesceKey(channel: string, payload: unknown): string | null {
  const policy = fanoutPolicy(channel);
  if (!policy) return null;
  if (policy.kind === 'replace-last') return channel;
  if (policy.kind !== 'replace-by-key') return null;
  const key = (policy.key as (p: unknown) => string)(payload);
  return `${channel}${KEY_SEPARATOR}${key}`;
}

/**
 * The cap on one enveloped payload, in bytes of UTF-8 JSON.
 *
 * 32 KB, and the number matters because of exactly one field: `SessionEvent`'s `tool-use`
 * carries `input: Record<string, unknown>`, which for a `Write` is the entire file being
 * written. Everything else on this wire is board-shaped and bounded by what a human typed.
 * That one field is unbounded, and it arrives at the rate an agent writes files.
 *
 * A cap is acceptable here in a way it would not be in the transcript, and the distinction is
 * the point: **the browser is not the transcript of record — `task:activity` is.** The pushed
 * stream exists so a watching human sees the agent working; the durable, complete copy is on
 * the desktop and readable through a channel that relays. So a 200 KB payload is clipped and
 * says so, rather than being dropped or blocking a queue everything else is waiting behind.
 */
export const MAX_EVENT_BYTES = 32 * 1024;

/** The property that marks a payload nothing could be salvaged from. */
export const DROPPED_PAYLOAD_MARKER = '__eventPayloadDropped';

/**
 * What a payload becomes when clamping its strings could not get it under the cap — thousands
 * of small fields, or a value JSON refuses (a cycle, a BigInt). `bytes` is what it serialized
 * to, or -1 when it would not serialize at all, so a log can say how far over it was.
 */
export interface DroppedPayload {
  readonly [DROPPED_PAYLOAD_MARKER]: true;
  readonly bytes: number;
}

/** Whether a received payload is one this module gave up on. */
export function isDroppedPayload(value: unknown): value is DroppedPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[DROPPED_PAYLOAD_MARKER] === true
  );
}

/** A payload capped for the wire, and whether anything was lost getting it there. */
export interface TruncatedPayload {
  payload: unknown;
  truncated: boolean;
}

/**
 * Cap one payload at `maxBytes` of UTF-8 JSON, losing as little as possible.
 *
 * Strings are clamped, structure is kept: a clipped `Write` input still says which file it
 * was writing and how long the content was, which is what a human watching a transcript is
 * reading anyway. The caps are tried widest-first so a payload that is 1 KB over does not get
 * cut to 64 characters to save 30.
 *
 * Takes a payload rather than an `EventEnvelope`: this package must not depend on
 * `@tm/protocol` (that dependency runs the other way), and the envelope's other three fields
 * are a channel name and two numbers.
 */
export function truncateEventPayload(
  payload: unknown,
  maxBytes: number = MAX_EVENT_BYTES,
): TruncatedPayload {
  const encoded = serialize(payload);
  if (encoded === null) return { payload: dropped(-1), truncated: true };
  const bytes = utf8Bytes(encoded);
  if (bytes <= maxBytes) return { payload, truncated: false };

  for (const cap of STRING_CAPS) {
    const clamped = clampStrings(payload, cap);
    const reEncoded = serialize(clamped);
    if (reEncoded !== null && utf8Bytes(reEncoded) <= maxBytes) {
      return { payload: clamped, truncated: true };
    }
  }
  return { payload: dropped(bytes), truncated: true };
}

/**
 * The per-string caps, widest first. Each pass is cheap (the payload is already in memory and
 * bounded by what an agent emitted), and stopping at the first that fits is what keeps a
 * slightly-oversized event legible.
 */
const STRING_CAPS = [4_096, 1_024, 256, 64, 0];

const ENCODER = new TextEncoder();

function utf8Bytes(text: string): number {
  return ENCODER.encode(text).length;
}

/** JSON, or `null` for a value JSON will not take — a cycle, a BigInt, a throwing getter. */
function serialize(value: unknown): string | null {
  try {
    return JSON.stringify(value ?? null) ?? 'null';
  } catch {
    return null;
  }
}

function dropped(bytes: number): DroppedPayload {
  return { [DROPPED_PAYLOAD_MARKER]: true, bytes };
}

/**
 * Every string in the payload, clamped to `cap` characters and told what it lost.
 *
 * Only ever called on a value {@link serialize} has already accepted, so there is no cycle to
 * recurse into forever.
 */
function clampStrings(value: unknown, cap: number): unknown {
  if (typeof value === 'string') return clampString(value, cap);
  if (Array.isArray(value)) return value.map((item) => clampStrings(item, cap));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = clampStrings(item, cap);
    return out;
  }
  return value;
}

function clampString(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}…[+${text.length - cap} characters]`;
}
