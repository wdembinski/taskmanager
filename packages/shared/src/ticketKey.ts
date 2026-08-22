/**
 * A native ticket's **name** — `TM-123` — and the only place its shape is decided.
 *
 * A key is permanent: it goes into commit messages, branch names, chat, and other people's
 * notes, and every one of those becomes a lie if the same key ever means a second ticket.
 * So the rules live in one pure module that both sides import — the store, which issues
 * keys, and the renderer, which shows them and parses them back out of what a human typed.
 *
 * No React, no Electron, no DB. See `Project.ticketPrefix` and `Task.ticketKey`.
 */

/**
 * How long a prefix may be. Not a technical bound — it is how much room a key is worth on a
 * card, where it sits beside the title on the narrowest line the board has.
 */
export const MAX_TICKET_PREFIX_LENGTH = 10;

/** The parts of a key, as {@link parseTicketKey} hands them back. */
export interface ParsedTicketKey {
  /** Already normalized: upper-case, alphanumeric, never a bare number. */
  prefix: string;
  /** The ordinal. Always ≥ 1 — there is no `TM-0`. */
  ticketNumber: number;
}

/**
 * The canonical form of a key prefix, or **null when there isn't one**.
 *
 * Upper-cases (keys are conventionally upper and compared case-blind), strips everything
 * that is not a letter or a digit (a prefix must survive being pasted into a branch name),
 * and truncates to {@link MAX_TICKET_PREFIX_LENGTH}.
 *
 * Two refusals, both returning null rather than a repaired string:
 *
 *  - **empty** — `'  '`, `'--'`, `'…'`. There is nothing to name the tickets with.
 *  - **a bare number** — `'12'`. `12-3` would be a key that {@link parseTicketKey} could
 *    only guess at, since it has no way to tell the prefix from the ordinal. Refusing it
 *    here is what lets the parser be exact rather than heuristic.
 *
 * Idempotent: the output of this function normalizes to itself. The truncation happens
 * *before* the bare-number test on purpose, so a prefix whose letters are cut off by the
 * length bound (`1234567890AB`) is refused rather than silently becoming a number.
 */
export function normalizeTicketPrefix(raw: string): string | null {
  const stripped = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const prefix = stripped.slice(0, MAX_TICKET_PREFIX_LENGTH);
  if (!prefix) return null;
  if (/^\d+$/.test(prefix)) return null;
  return prefix;
}

/**
 * Build the key for `ticketNumber` under `prefix`.
 *
 * **Throws** on an unusable prefix or a non-positive/non-integer number, rather than
 * returning a broken string. This is the one function in the app that names a thing
 * permanently, and a silent `'-5'` written into a row would be a name nothing could
 * un-write. Every caller validates the prefix first (the store refuses to create a ticket
 * for a project that has none), so the throw is a guard against a bug, not a control flow —
 * and inside the allocator's transaction it rolls the whole insert back, which is exactly
 * the right outcome: a refused create must never burn a number.
 */
export function formatTicketKey(prefix: string, ticketNumber: number): string {
  const normalized = normalizeTicketPrefix(prefix);
  if (!normalized) throw new Error(`Not a usable ticket prefix: ${JSON.stringify(prefix)}`);
  if (!Number.isInteger(ticketNumber) || ticketNumber < 1) {
    throw new Error(`Not a usable ticket number: ${String(ticketNumber)}`);
  }
  return `${normalized}-${ticketNumber}`;
}

/**
 * Split a key back into its parts, or null when it is not one.
 *
 * Exact, not forgiving. It splits on the FIRST hyphen — a normalized prefix can never
 * contain one — and then requires both halves to be canonical: the prefix must normalize to
 * itself, and the ordinal must be digits with no leading zero (`TM-007` is refused, because
 * accepting it would mean two spellings of one ticket and only one of them round-trips
 * through {@link formatTicketKey}).
 *
 * Whitespace around the whole thing is forgiven — it comes from a paste, not from a
 * decision — and so is the case, since keys are compared case-blind.
 */
export function parseTicketKey(key: string): ParsedTicketKey | null {
  const trimmed = key.trim();
  const dash = trimmed.indexOf('-');
  if (dash <= 0) return null;

  const prefix = normalizeTicketPrefix(trimmed.slice(0, dash));
  if (!prefix || prefix !== trimmed.slice(0, dash).toUpperCase()) return null;

  const digits = trimmed.slice(dash + 1);
  if (!/^[1-9]\d*$/.test(digits)) return null;

  const ticketNumber = Number(digits);
  return Number.isSafeInteger(ticketNumber) ? { prefix, ticketNumber } : null;
}

/** Whether `key` is a well-formed ticket key. The predicate over {@link parseTicketKey}. */
export function isTicketKey(key: string): boolean {
  return parseTicketKey(key) !== null;
}

/** Fallback base when a project's name has nothing usable in it (`normalizeTicketPrefix` refuses it). */
const FALLBACK_TICKET_PREFIX_BASE = 'PROJECT';

/**
 * A starting guess for a ticket prefix, from a project's name — initials for a multi-word
 * name ("Task Manager" → "TM"), the first few letters otherwise. Purely a convenience: the
 * result still needs {@link normalizeTicketPrefix}, and callers that need one guaranteed
 * free of collisions should feed this into {@link uniqueTicketPrefix}.
 */
export function suggestTicketPrefix(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const raw =
    words.length > 1
      ? words
          .map((w) => w[0])
          .join('')
          .slice(0, 4)
      : words[0].slice(0, 4);
  return normalizeTicketPrefix(raw) ?? '';
}

/**
 * A ticket prefix, normalized from `base`, guaranteed not to collide (case-blind) with
 * anything in `taken`.
 *
 * Falls back to a constant when `base` normalizes to nothing — a prefix from an empty or
 * symbols-only name would otherwise leave the caller without one to append a suffix to.
 * Then appends `2`, `3`, … until free, re-truncating each candidate to
 * {@link MAX_TICKET_PREFIX_LENGTH} so a suffix never pushes the result past the bound —
 * and, since the truncated result could otherwise end up bare digits (which
 * `normalizeTicketPrefix` refuses), routes every candidate back through it rather than
 * concatenating by hand.
 */
export function uniqueTicketPrefix(base: string, taken: Iterable<string>): string {
  const takenSet = new Set(Array.from(taken, (key) => key.toUpperCase()));
  const normalizedBase = normalizeTicketPrefix(base) ?? FALLBACK_TICKET_PREFIX_BASE;

  if (!takenSet.has(normalizedBase)) return normalizedBase;

  for (let suffix = 2; ; suffix++) {
    const suffixStr = String(suffix);
    const truncatedBase = normalizedBase.slice(
      0,
      Math.max(1, MAX_TICKET_PREFIX_LENGTH - suffixStr.length),
    );
    const candidate = normalizeTicketPrefix(`${truncatedBase}${suffixStr}`);
    if (candidate && !takenSet.has(candidate)) return candidate;
  }
}
