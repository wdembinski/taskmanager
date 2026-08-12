/**
 * Who *you* are on the connected GitHub instance.
 *
 * Same job as `gitlab/identity.ts` and `jira/identity.ts`, for the same reason: a pull
 * request's discussion is full of your own comments, and counting them as unread would
 * leave every PR you have ever commented on permanently orange. `GET /user` answers it;
 * the result is cached in `app_state` keyed by `baseUrl`, so pointing the app at another
 * instance (github.com, then an Enterprise host) re-discovers rather than mis-attributing
 * — two different servers can hand out the same login to different people.
 *
 * When the identity is unknown, no comment is yours — the same safe direction the other
 * two take. A PR that shouts when it needn't is a nuisance; one that stays quiet while a
 * reviewer waits is a missed review.
 */
import type { GitHubUser } from './githubClient';

export interface GitHubIdentityCache {
  /** Numeric user id — stable across renames, and what comment authors carry. */
  id: number | null;
  /** The `login`, GitHub's name for what GitLab calls a username. */
  login: string;
  /** The instance this identity belongs to — the cache key. */
  baseUrl: string;
}

/** The author shape a GitHub comment or review carries. */
export interface GitHubAuthor {
  id?: number;
  login?: string;
}

/**
 * Whether a comment's author is the user. Matches on the numeric id when both sides have
 * one, and falls back to `login`. An unknown identity matches nothing.
 */
export function githubAuthorIsMe(
  author: GitHubAuthor | null | undefined,
  identity: GitHubIdentityCache | null,
): boolean {
  if (!author || !identity) return false;
  if (typeof author.id === 'number' && identity.id !== null) return author.id === identity.id;
  const mine = identity.login.trim().toLowerCase();
  const theirs = author.login?.trim().toLowerCase() ?? '';
  return mine.length > 0 && mine === theirs;
}

/** Shape `GET /user` into the cache row for `baseUrl`. */
export function githubIdentityFrom(user: GitHubUser, baseUrl: string): GitHubIdentityCache {
  return {
    id: typeof user.id === 'number' ? user.id : null,
    login: user.login ?? '',
    baseUrl,
  };
}
