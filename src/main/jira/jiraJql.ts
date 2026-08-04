/**
 * Asking JIRA about a specific set of cards — "do THESE still match the board's
 * query?" — rather than asking for the query and seeing what comes back.
 *
 * This is what turns "a card wasn't in the answer" into "a card is genuinely gone".
 * The board's own JQL is a moving target: it is paged, it is capped, and a slow or
 * short answer looks exactly like a shrinking board. Re-asking by key is the only
 * question with an answer that can be trusted in the negative — JIRA either lists the
 * key or it doesn't, and there is no page beyond it to be missing.
 *
 * Pure string work, no client: everything here is unit-testable, and the interpolation
 * is the dangerous part. Keys come out of our own SQLite, but a key is still a value
 * being pasted into a query, so nothing that isn't shaped like an issue key gets past
 * {@link isIssueKey}.
 */
import { splitOrderBy } from './jiraSprint';

/**
 * `PROJ-123`. JIRA project keys start with a letter and carry letters, digits and
 * underscores; the issue number is plain digits. Deliberately strict — anything else,
 * whatever it once meant, is not going into a JQL string.
 */
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** Whether a stored value is safe to interpolate into `key in (...)`. */
export function isIssueKey(value: unknown): value is string {
  return typeof value === 'string' && ISSUE_KEY.test(value.trim());
}

/**
 * The `key in (A-1, A-2)` clause for a set of keys, or `''` when none of them survive
 * validation. Duplicates are dropped: the same key twice is legal JQL but it inflates
 * the request for nothing, and a chunk of 50 that is really 30 distinct keys wastes
 * half the round trip.
 */
export function keysInJql(keys: readonly unknown[]): string {
  const valid = [...new Set(keys.filter(isIssueKey).map((k) => k.trim()))];
  return valid.length ? `key in (${valid.join(', ')})` : '';
}

/**
 * The board's query narrowed to a specific set of keys — "of these cards, which still
 * match?".
 *
 * Two details, both borrowed from `withCurrentSprint`, and both the difference between
 * an answer and nonsense:
 *
 *   - the user's filter is **parenthesised**, because a query ending in a top-level
 *     `OR` (`assignee = currentUser() OR reporter = currentUser()`) would otherwise
 *     bind `key in (…)` to the last branch alone and answer a question nobody asked;
 *   - the trailing `ORDER BY` is **dropped**, because this is a membership test over a
 *     handful of keys and a sort on it is pure cost — and some sorts (`ORDER BY rank`)
 *     are expensive enough on Server/DC to notice.
 *
 * Returns `''` when no key survives validation. A caller must treat that as "nothing to
 * ask", never as a query to run: the bare filter would match the whole board.
 */
export function withKeysIn(jql: string, keys: readonly unknown[]): string {
  const clause = keysInJql(keys);
  if (!clause) return '';
  const { where } = splitOrderBy(jql);
  return where ? `(${where}) AND ${clause}` : clause;
}

/**
 * Split keys into request-sized batches. JQL is sent in a URL, and a `key in (...)` of
 * several hundred keys is how you find your instance's URL length limit — as a 400 or,
 * on a fronted deployment, a 414 from a proxy that never reaches JIRA at all. Fifty
 * keys is comfortably inside every limit we know of.
 */
export function chunkKeys(keys: readonly string[], size = 50): string[][] {
  const step = Math.max(1, Math.floor(size));
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += step) chunks.push(keys.slice(i, i + step));
  return chunks;
}
