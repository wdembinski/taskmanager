/**
 * Minimal GitHub REST client, shaped after `gitlab/gitlabClient.ts`.
 *
 * Node global `fetch`, no HTTP dependency, and deliberately free of Electron and the store
 * so it can be unit-tested against a mocked `fetch`. One auth mode: a personal access
 * token as `Authorization: Bearer`, which works on github.com and GitHub Enterprise Server
 * alike, for both classic and fine-grained tokens.
 *
 * Two things differ from GitLab and are the reason this is a separate file rather than a
 * flag on that one:
 *
 *  - **The base URL.** github.com's API lives on its own host (`https://api.github.com`),
 *    while an Enterprise instance serves it from `<host>/api/v3`. The user should not have
 *    to know which shape their instance wants, so {@link apiRoot} decides from what they
 *    typed and this is the only place that rule exists.
 *  - **Pagination.** GitLab hands you the next page number in `x-next-page`; GitHub sends
 *    an RFC 5988 `Link` header and expects you to follow `rel="next"` as a whole URL. The
 *    URL is followed verbatim rather than re-derived, because the search endpoints attach
 *    their own opaque parameters to it.
 */
import { sanitizeToken } from '@shared/secretToken';

export interface GitHubClientConfig {
  /**
   * `https://api.github.com`, or an Enterprise instance root. Either the instance root
   * (`https://github.acme.internal`) or its API root (`.../api/v3`) is accepted — see
   * {@link apiRoot}.
   */
  baseUrl: string;
  token: string;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

/** `GET /user` — who the token belongs to. */
export interface GitHubUser {
  id: number;
  login: string;
  name?: string | null;
}

/**
 * Where REST calls go, given what the user typed.
 *
 * github.com is the special case, not the general one: its API is a different HOST, so a
 * `https://api.github.com` in the settings is already the API root and gets no suffix.
 * Everything else is an Enterprise Server instance, whose API hangs off `/api/v3` — and an
 * instance root is what people paste, so the suffix is added if it isn't already there.
 */
export function apiRoot(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (/^https?:\/\/api\.github\.com$/i.test(trimmed)) return trimmed;
  if (/\/api\/v3$/i.test(trimmed)) return trimmed;
  return `${trimmed}/api/v3`;
}

/**
 * The `rel="next"` URL from a `Link` header, or null when this was the last page.
 *
 * Exported because it is the one piece of GitHub's pagination worth testing on its own:
 * the header is a comma-separated list of `<url>; rel="name"` and the next link is not
 * reliably first — a middle page carries `prev`, `next`, `last` and `first` together.
 */
export function nextPageUrl(link: string | null | undefined): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part.trim());
    if (match) return match[1];
  }
  return null;
}

export class GitHubClient {
  constructor(private readonly config: GitHubClientConfig) {}

  private url(path: string): string {
    return `${apiRoot(this.config.baseUrl)}${path}`;
  }

  /**
   * The header set every call wears.
   *
   * `X-GitHub-Api-Version` is not optional politeness: GitHub pins response shapes to it,
   * and omitting it means the app silently follows whatever the newest default becomes.
   * The token is cleaned at the point of USE, not just where it was saved — a token stored
   * with a pasted newline on it is already in the store and nothing about it looks wrong.
   */
  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${sanitizeToken(this.config.token)}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  /** One request against an absolute URL. Returns the body and the response, for `Link`. */
  private async rawUrl(url: string): Promise<{ body: unknown; res: Response }> {
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubError(
        `GitHub ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`,
        res.status,
      );
    }
    if (res.status === 204) return { body: undefined, res };
    return { body: await res.json(), res };
  }

  /** One request against a path below the API root. */
  private raw(path: string): Promise<{ body: unknown; res: Response }> {
    return this.rawUrl(this.url(path));
  }

  private async request<T>(path: string): Promise<T> {
    return (await this.raw(path)).body as T;
  }

  /**
   * Every page of a list endpoint, following `Link: rel="next"` up to `maxPages`.
   *
   * Capped rather than trusting the header forever: a paginated endpoint that keeps
   * advertising a next page (a misconfigured proxy, a search that never narrows) would
   * otherwise spin until the process is killed.
   */
  async paged<T>(path: string, maxPages = 5): Promise<T[]> {
    const all: T[] = [];
    let url: string | null = this.url(path);
    for (let i = 0; i < maxPages && url; i++) {
      const { body, res }: { body: unknown; res: Response } = await this.rawUrl(url);
      if (Array.isArray(body)) all.push(...(body as T[]));
      url = nextPageUrl(res.headers?.get('link'));
    }
    return all;
  }

  /** GET /user — the "Test connection" call, and the identity every comment is compared to. */
  getMe(): Promise<GitHubUser> {
    return this.request<GitHubUser>('/user');
  }
}
