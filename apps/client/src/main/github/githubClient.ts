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
import type { MergeRequestState } from '@shared/mergeRequest';
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
 * One row of `GET /search/issues` — an issue *or* a pull request, since GitHub keeps both
 * in one index and `pull_request` is the only thing that tells them apart.
 *
 * Deliberately thin, and that is the fact `describePullRequest` is built around: search
 * results carry no branches, no head SHA, no `mergeable_state` and no repository **id**.
 * Everything attention depends on needs the detail endpoints, which is why the list alone
 * can never fill a row in.
 */
export interface GitHubSearchIssueItem {
  /** The GLOBAL issue id — not the repo, and not what `#12` means to a human. */
  id: number;
  /**
   * The GraphQL global node id (`I_kwDO…`). GitHub's own opaque, permanent handle for this
   * issue, and what a mirrored card stores as `externalId` — the numeric `id` above is
   * equally stable, but it is the one identifier GitHub has been steadily moving away from.
   * Optional because an Enterprise Server old enough not to send it must still sync.
   */
  node_id?: string;
  /** The per-repo number, which is what `#12` means. */
  number: number;
  title: string;
  body?: string | null;
  /** `open` or `closed`. Merged-ness lives in `pull_request.merged_at`. */
  state: string;
  draft?: boolean;
  html_url: string;
  /**
   * `https://api.github.com/repos/{owner}/{repo}` — the ONLY thing on a search row that
   * says which repository this is. The owner and repo every detail call needs are parsed
   * back out of it; see `describePullRequest.ts`.
   */
  repository_url: string;
  updated_at: string;
  /** Present iff this row is a pull request. `merged_at` is set once it lands. */
  pull_request?: { url?: string; html_url?: string; merged_at?: string | null } | null;
  user?: { id?: number; login?: string } | null;
  labels?: Array<{ name?: string }> | null;
}

/**
 * One comment on an issue — `GET /repos/{owner}/{repo}/issues/{number}/comments`.
 *
 * Issue comments and pull-request *conversation* comments are the same endpoint on GitHub
 * (a PR is an issue), which is why this type is not called an issue-only thing. Review
 * comments on a diff are a different endpoint and are deliberately not fetched: they are
 * about a line of code, not about the ticket.
 */
export interface GitHubIssueComment {
  id: number;
  body?: string | null;
  created_at: string;
  updated_at?: string;
  html_url?: string;
  user?: { id?: number; login?: string } | null;
}

/** What one `GET /search/issues` question came back with, plus how much to trust it. */
export interface GitHubSearchResult {
  items: GitHubSearchIssueItem[];
  /**
   * GitHub's own admission that it gave up early — the search index timed out and the
   * result set is a partial one it will not vouch for.
   */
  incompleteResults: boolean;
  /**
   * Whether this answer stopped short of the end of the query, for ANY reason:
   * `incompleteResults`, or {@link GitHubClient.paged}'s page cap still having a
   * `rel="next"` to follow when it ran out.
   *
   * The single fact a reconciler needs, and the reason the two are folded into one flag:
   * a short answer is indistinguishable from a shrunken board, so a sync that got one must
   * remove nothing at all — and which *kind* of short does not change that.
   */
  truncated: boolean;
}

/** `GET /repos/{owner}/{repo}/pulls/{number}` — the half a search row cannot answer. */
export interface GitHubPullRequest {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: string;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  html_url: string;
  updated_at?: string;
  /**
   * GitHub's verdict on whether this can merge, and the counterpart of GitLab's
   * `detailed_merge_status`. Carried by the DETAIL endpoint only — search rows omit it.
   */
  mergeable_state?: string | null;
  /**
   * Whether the merge is clean. **Tri-state on purpose:** `null` means GitHub has not
   * finished computing it, which is "checking", not "clean" — treating it as a boolean is
   * how a conflicted branch comes to wear a green tick.
   */
  mergeable?: boolean | null;
  /** The source branch and, crucially, the head SHA the check runs hang off. */
  head?: { ref?: string; sha?: string; repo?: { id?: number; full_name?: string } | null } | null;
  base?: { ref?: string; repo?: { id?: number; full_name?: string } | null } | null;
}

/**
 * One review on a pull request. `state` is `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`,
 * `DISMISSED` or `PENDING`; the fold that turns a list of these into an approval count
 * lives in `describePullRequest.ts`.
 */
export interface GitHubReview {
  id: number;
  state?: string;
  submitted_at?: string | null;
  user?: { id?: number; login?: string } | null;
}

/**
 * One check run on a commit — GitHub's unit of CI, and the equivalent of a GitLab job.
 *
 * Two fields where GitLab has one: a run is `queued`/`in_progress`/`completed`, and only a
 * completed one has a `conclusion`. Both are needed to say what a dot should look like —
 * see `checkRuns.ts`.
 */
export interface GitHubCheckRun {
  id?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string | null;
  details_url?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

/** One legacy commit status — what CI reported before check runs existed. */
export interface GitHubStatusContext {
  context?: string;
  state?: string;
  target_url?: string | null;
}

/** `GET /repos/{owner}/{repo}/commits/{sha}/status`, for repos still on commit statuses. */
export interface GitHubCombinedStatus {
  state?: string;
  total_count?: number;
  sha?: string;
  statuses?: GitHubStatusContext[] | null;
}

/**
 * `GET /repos/{owner}/{repo}/branches/{branch}/protection`.
 *
 * Admin-gated: on a repository you merely contribute to this 403s, which is the normal
 * case and not an error worth showing. See `describePullRequest.ts` for what is done
 * instead — nothing, deliberately.
 */
export interface GitHubBranchProtection {
  required_pull_request_reviews?: {
    required_approving_review_count?: number | null;
    dismiss_stale_reviews?: boolean;
    require_code_owner_reviews?: boolean;
  } | null;
}

/**
 * Narrow a pull request's state to ours.
 *
 * GitHub has no `merged` state: a landed PR is `closed` with `merged_at` set, and reading
 * that as "closed" would put every shipped branch in the same bucket as an abandoned one —
 * on a card, the difference between "this shipped" and "this was thrown away".
 *
 * `locked` has no analogue here: GitHub's `locked` flag freezes the *conversation*, while
 * GitLab's `locked` state means a merge is in progress. Mapping one onto the other would
 * claim a PR was mid-merge because somebody muted an argument on it.
 */
export function toPullRequestState(pr: {
  state?: string;
  merged?: boolean | null;
  merged_at?: string | null;
  pull_request?: { merged_at?: string | null } | null;
}): MergeRequestState {
  if (pr.merged === true || pr.merged_at || pr.pull_request?.merged_at) return 'merged';
  return pr.state === 'open' ? 'opened' : 'closed';
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

/**
 * `/repos/{owner}/{repo}`, with both parts escaped.
 *
 * Escaped rather than interpolated raw because these come back off a search row's
 * `repository_url` and go straight into a path: an owner or repo containing anything
 * URL-significant would otherwise change which endpoint we called.
 */
function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
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
   * One WRITE — the only calls in this client that change anything on github.com.
   *
   * Separate from {@link rawUrl} rather than a parameter on it, so that every read stays a
   * read by construction: a method argument that defaults to GET is one careless call away
   * from a PATCH. The error path is deliberately identical, because the caller
   * (`ipc.ts task:move`) turns any failure into a REFUSED move — a card must never claim a
   * move the forge did not make, so what matters is that a failure is impossible to miss.
   */
  private async write<T>(
    path: string,
    method: 'PATCH' | 'POST' | 'DELETE',
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(this.url(path), {
      method,
      headers:
        body === undefined
          ? this.headers()
          : { ...this.headers(), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubError(
        `GitHub ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`,
        res.status,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json().catch(() => undefined)) as T;
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

  /**
   * Your open pull requests, newest activity first.
   *
   * `author:@me` only — the same decision GitLab's `scope=created_by_me` makes, and for the
   * same reason: this is the set *you* are responsible for landing. PRs you were merely
   * asked to review are someone else's to push, and folding them in would double the noise
   * on a board whose whole point is "what is mine and what is it waiting on".
   *
   * `advanced_search=true` is not optional politeness either. GitHub deprecated the legacy
   * search syntax on 4 Sep 2025; a query sent without the flag comes back with a
   * deprecation warning and is scheduled to stop working. Our query means the same thing
   * under both syntaxes — the difference is only how a space between several `repo:`/`org:`
   * qualifiers is read, and there is one qualifier of each here.
   *
   * Search is the only endpoint that answers "across every repository" in one call, which
   * is why it is used despite being the thinnest payload GitHub has: see
   * {@link GitHubSearchIssueItem} for what it will not tell you.
   */
  async listMyPullRequests(maxPages = 5): Promise<GitHubSearchIssueItem[]> {
    return (await this.searchIssues('is:pr is:open author:@me', maxPages)).items;
  }

  /**
   * One search query, followed to the end, with **how short the answer was** attached.
   *
   * `advanced_search=true` is not optional politeness: GitHub deprecated the legacy search
   * syntax on 4 Sep 2025, and a query sent without the flag comes back with a deprecation
   * warning and is scheduled to stop working. It matters more here than for the fixed PR
   * query above, because this one is a string the USER wrote and may well contain several
   * `repo:`/`org:` qualifiers — the one place the two syntaxes read a space differently.
   *
   * The two truncation signals are folded into one `truncated` here rather than left for
   * every caller to combine, because forgetting either has the same consequence and it is
   * the expensive one: a board that reads a short answer as a shrunken board and archives
   * the difference. See {@link GitHubSearchResult}.
   */
  async searchIssues(query: string, maxPages = 5): Promise<GitHubSearchResult> {
    const q = encodeURIComponent(query.trim());
    const items: GitHubSearchIssueItem[] = [];
    let incompleteResults = false;
    let url: string | null = this.url(
      `/search/issues?q=${q}&advanced_search=true&sort=updated&order=desc&per_page=100`,
    );
    let i = 0;
    for (; i < maxPages && url; i++) {
      const { body, res }: { body: unknown; res: Response } = await this.rawUrl(url);
      const page = body as { items?: unknown; incomplete_results?: unknown } | null;
      if (Array.isArray(page?.items)) items.push(...(page.items as GitHubSearchIssueItem[]));
      if (page?.incomplete_results === true) incompleteResults = true;
      // The `Link` header, not a page counter: search hangs its own opaque parameters off
      // the next URL, and re-deriving it drops them.
      url = nextPageUrl(res.headers?.get('link'));
    }
    // `url` still being set means the cap stopped us, not GitHub — there is another page
    // out there we chose not to read, which is exactly as short an answer as a timed-out
    // index and has to be reported as one.
    return { items, incompleteResults, truncated: incompleteResults || url !== null };
  }

  /**
   * One issue by number — the re-read that lets a card leave the board.
   *
   * The counterpart of `getPullRequest`, and it exists for the same reason: absence from a
   * search is a hint, never a verdict. Asking for an issue by its number has an answer that
   * can be trusted in the negative (a 404 is `GitHubError` with `status: 404`), and it is
   * bounded by the size of the BOARD rather than the size of the repository.
   *
   * Returns the search-row shape because that is what {@link GitHubSearchIssueItem} is —
   * the fields both endpoints agree on — so the reconciler has one mapping rather than two.
   */
  getIssue(owner: string, repo: string, number: number): Promise<GitHubSearchIssueItem> {
    return this.request<GitHubSearchIssueItem>(`${repoPath(owner, repo)}/issues/${number}`);
  }

  /**
   * Open or close an issue — `PATCH /repos/{owner}/{repo}/issues/{number}`.
   *
   * The board's half of DONE: closing is the only thing GitHub itself understands as
   * "finished", and any move out of DONE reopens. `state` is the ONLY field sent, so a PATCH
   * cannot quietly rewrite a title or a body it merely happened to have read.
   *
   * `state_reason` is deliberately left out: GitHub defaults a close to `completed`, and the
   * board has no way to tell "done" from "not planned" — a card dragged into DONE is the human
   * saying the work is finished, which is exactly the default.
   */
  setIssueState(
    owner: string,
    repo: string,
    number: number,
    state: 'open' | 'closed',
  ): Promise<GitHubSearchIssueItem> {
    return this.write<GitHubSearchIssueItem>(`${repoPath(owner, repo)}/issues/${number}`, 'PATCH', {
      state,
    });
  }

  /**
   * Add labels to an issue — `POST /repos/{owner}/{repo}/issues/{number}/labels`.
   *
   * Additive by definition: this endpoint appends, it does not replace, which is why removing
   * the label a card is leaving behind is a separate call rather than a PUT of the whole set.
   * A PUT would silently delete every label the app knows nothing about — the repository's own
   * taxonomy — on every drag.
   */
  addLabels(owner: string, repo: string, number: number, labels: string[]): Promise<unknown> {
    return this.write(`${repoPath(owner, repo)}/issues/${number}/labels`, 'POST', { labels });
  }

  /**
   * Remove ONE label from an issue — `DELETE .../issues/{number}/labels/{name}`.
   *
   * **404 means the label was not on the issue**, which is the ordinary outcome of two drags
   * racing or of somebody removing it in the browser first, and the caller treats it as
   * success. The name is escaped: labels routinely contain spaces, slashes and colons.
   */
  removeLabel(owner: string, repo: string, number: number, label: string): Promise<unknown> {
    return this.write(
      `${repoPath(owner, repo)}/issues/${number}/labels/${encodeURIComponent(label)}`,
      'DELETE',
    );
  }

  /**
   * An issue's comments, oldest first.
   *
   * Two pages by default. The unread border only needs the NEWEST foreign comment, and a
   * thread longer than two hundred comments is one where the newest is certain to be past
   * the cap anyway — `sort=created&direction=desc` would be the fix if this ever bites, at
   * the cost of the oldest-first order every caller currently expects.
   */
  listIssueComments(
    owner: string,
    repo: string,
    number: number,
    maxPages = 2,
  ): Promise<GitHubIssueComment[]> {
    return this.paged<GitHubIssueComment>(
      `${repoPath(owner, repo)}/issues/${number}/comments?per_page=100`,
      maxPages,
    );
  }

  /**
   * One pull request in full — the head SHA, the branches, `mergeable` and
   * `mergeable_state`. None of those are on a search row, so this is the only route to
   * knowing whether CI is green or whether the branch conflicts.
   */
  getPullRequest(owner: string, repo: string, number: number): Promise<GitHubPullRequest> {
    return this.request<GitHubPullRequest>(`${repoPath(owner, repo)}/pulls/${number}`);
  }

  /** Every review, oldest first — GitHub returns the whole history, not the current state. */
  listReviews(owner: string, repo: string, number: number, maxPages = 3): Promise<GitHubReview[]> {
    return this.paged<GitHubReview>(
      `${repoPath(owner, repo)}/pulls/${number}/reviews?per_page=100`,
      maxPages,
    );
  }

  /**
   * The check runs on a commit — GitHub's answer to GitLab's pipeline jobs.
   *
   * `filter=latest` is the default and is sent anyway, because it is what makes a re-run
   * replace its failed predecessor rather than sit beside it. GitLab has no such filter and
   * `pipelineStages.ts` has to dedupe by hand; here the server does it, and being explicit
   * stops a future default change quietly reintroducing the stale-red-stage bug.
   *
   * One page of 100: more jobs than that would make the dot row unreadable anyway.
   */
  async listCheckRuns(owner: string, repo: string, sha: string): Promise<GitHubCheckRun[]> {
    const body = await this.request<unknown>(
      `${repoPath(owner, repo)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100&filter=latest`,
    );
    const runs = (body as { check_runs?: unknown } | null)?.check_runs;
    return Array.isArray(runs) ? (runs as GitHubCheckRun[]) : [];
  }

  /**
   * The legacy commit statuses on a commit, rolled up.
   *
   * Not a fallback for a failed call — a fallback for a different WORLD: plenty of repos
   * still report CI through the statuses API (Jenkins, Buildkite, CircleCI's older
   * integration), and those have no check runs at all. A PR there would otherwise read as
   * "no pipeline" while a wall of red sat on it in the browser.
   */
  getCombinedStatus(owner: string, repo: string, sha: string): Promise<GitHubCombinedStatus> {
    return this.request<GitHubCombinedStatus>(
      `${repoPath(owner, repo)}/commits/${encodeURIComponent(sha)}/status?per_page=100`,
    );
  }

  /**
   * A branch's protection rule — the only place the *required* approval count lives.
   *
   * **403s without admin on the repository**, which is the ordinary case for anyone
   * contributing to someone else's project, and a 404 means the branch simply is not
   * protected. The caller distinguishes the two by {@link GitHubError.status}; neither is
   * an error worth surfacing.
   */
  getBranchProtection(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<GitHubBranchProtection> {
    return this.request<GitHubBranchProtection>(
      `${repoPath(owner, repo)}/branches/${encodeURIComponent(branch)}/protection`,
    );
  }
}
