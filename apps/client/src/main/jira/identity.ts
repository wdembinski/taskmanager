/**
 * Who *you* are on the linked JIRA instance (Phase 12).
 *
 * The chat pane puts your own words on the right and everyone else's on the left, and a
 * ticket comment is the one entry the app cannot attribute from its own data: comments
 * arrive with an author, and until now nothing knew whether that author was the user.
 *
 * `GET /myself` answers it (the same call "Test connection" makes). The result is cached
 * in `app_state` keyed by `baseUrl` — exactly like the Epic Link field id (`epicField.ts`)
 * — so pointing the app at another site re-discovers rather than mis-attributing.
 *
 * When the identity is unknown (never connected, request failed), **every** comment is
 * someone else's. Guessing the other way would put words in the user's mouth on the
 * wrong side of the pane, which is worse than an under-styled comment.
 */
import type { JiraMyself } from './jiraClient';

/** The cached `/myself`, scoped to the site it came from. */
export interface JiraIdentityCache {
  /** Cloud sites return one; Server/DC generally do not. */
  accountId: string | null;
  /** Always present, and the only handle a Server comment can be matched on. */
  displayName: string;
  /** The site this identity belongs to — the cache key. */
  baseUrl: string;
}

/** The author shape a comment carries (both API versions). */
export interface CommentAuthor {
  displayName?: string;
  accountId?: string;
}

/**
 * Whether a comment's author is the user. Matches on `accountId` when BOTH sides have
 * one — it is stable across renames — and falls back to `displayName`, which is all a
 * Server instance offers. An unknown identity matches nothing.
 */
export function authorIsMe(
  author: CommentAuthor | undefined,
  identity: JiraIdentityCache | null,
): boolean {
  if (!author || !identity) return false;
  if (author.accountId && identity.accountId) return author.accountId === identity.accountId;
  const mine = identity.displayName.trim().toLowerCase();
  const theirs = author.displayName?.trim().toLowerCase() ?? '';
  return mine.length > 0 && mine === theirs;
}

/** Shape `GET /myself` into the cache row for `baseUrl`. */
export function identityFrom(me: JiraMyself, baseUrl: string): JiraIdentityCache {
  return { accountId: me.accountId ?? null, displayName: me.displayName ?? '', baseUrl };
}
