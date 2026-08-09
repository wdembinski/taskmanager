/**
 * Who *you* are on the connected GitLab instance.
 *
 * Same job as `jira/identity.ts` and for the same reason: an MR's discussion is full of
 * your own notes, and counting them as unread would leave every MR you have ever
 * commented on permanently orange. `GET /user` answers it; the result is cached in
 * `app_state` keyed by `baseUrl`, so pointing the app at another instance re-discovers
 * rather than mis-attributing.
 *
 * When the identity is unknown, no note is yours — the same safe direction JIRA takes.
 * An MR that shouts when it needn't is a nuisance; one that stays quiet while a reviewer
 * waits is a missed review.
 */
import type { GitLabUser } from './gitlabClient';

export interface GitLabIdentityCache {
  /** Numeric user id — stable across renames, and what notes carry. */
  id: number | null;
  username: string;
  /** The instance this identity belongs to — the cache key. */
  baseUrl: string;
}

/** The author shape a note carries. */
export interface NoteAuthor {
  id?: number;
  username?: string;
}

/**
 * Whether a note's author is the user. Matches on the numeric id when both sides have
 * one, and falls back to `username`. An unknown identity matches nothing.
 */
export function gitlabAuthorIsMe(
  author: NoteAuthor | null | undefined,
  identity: GitLabIdentityCache | null,
): boolean {
  if (!author || !identity) return false;
  if (typeof author.id === 'number' && identity.id !== null) return author.id === identity.id;
  const mine = identity.username.trim().toLowerCase();
  const theirs = author.username?.trim().toLowerCase() ?? '';
  return mine.length > 0 && mine === theirs;
}

/** Shape `GET /user` into the cache row for `baseUrl`. */
export function gitlabIdentityFrom(user: GitLabUser, baseUrl: string): GitLabIdentityCache {
  return {
    id: typeof user.id === 'number' ? user.id : null,
    username: user.username ?? '',
    baseUrl,
  };
}
