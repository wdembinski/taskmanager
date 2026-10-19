/**
 * Minimal GitLab REST client, shaped after `jira/jiraClient.ts`.
 *
 * Node global `fetch`, no HTTP dependency, and deliberately free of Electron and the
 * store so it can be unit-tested against a mocked `fetch`. One auth mode, unlike JIRA:
 * `PRIVATE-TOKEN` works on gitlab.com and every self-hosted instance, for both personal
 * and project access tokens.
 */
import type { MergeRequestState, PipelineStatus } from '@shared/mergeRequest';
import { sanitizeToken } from '@shared/secretToken';

export interface GitLabClientConfig {
  /** Instance root, e.g. `https://gitlab.com`. No trailing slash required. */
  baseUrl: string;
  token: string;
}

export class GitLabError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitLabError';
  }
}

/** `GET /user` — who the token belongs to. */
export interface GitLabUser {
  id: number;
  username: string;
  name?: string;
}

/** One merge request, as the list and detail endpoints report it. */
export interface GitLabMergeRequest {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description?: string | null;
  state: string;
  draft?: boolean;
  work_in_progress?: boolean;
  web_url: string;
  source_branch: string;
  target_branch: string;
  updated_at: string;
  /** The source branch's head commit, as of this response — on both the list and the detail. */
  sha?: string | null;
  /**
   * GitLab's own verdict on whether this can merge (15.6+). Carried by the DETAIL endpoint
   * only — the list omits it, which is why `describeMergeRequest` must not read it off a
   * list entry and call the absence "mergeable".
   */
  detailed_merge_status?: string | null;
  /** The pre-15.6 spelling, kept as a fallback for older self-hosted instances. */
  merge_status?: string | null;
  /**
   * The base, head and start SHAs this merge request's diff was computed against — carried
   * by the DETAIL endpoint only, same as `detailed_merge_status`. The version a diff
   * ({@link GitLabClient.listMergeRequestDiffs}) and a positioned comment (F18) belong to.
   */
  diff_refs?: { base_sha?: string; head_sha?: string; start_sha?: string } | null;
  has_conflicts?: boolean | null;
  /**
   * Set once this merge request is waiting for its pipeline before merging — GitLab's own
   * auto-merge flag, and what {@link GitLabClient.enableAutoMerge} reads to decide the call
   * is already a no-op.
   */
  merge_when_pipeline_succeeds?: boolean | null;
  references?: { full?: string } | null;
  head_pipeline?: { id?: number; status?: string; web_url?: string } | null;
  pipeline?: { id?: number; status?: string; web_url?: string } | null;
  reviewers?: Array<{ id: number; username?: string }> | null;
  /**
   * Returned by default on both the list and detail endpoints, like `GitLabNote.author`
   * above — the client's own type just never declared it until F15.9 needed an author for
   * the `requested` queue's rows.
   */
  author?: { id?: number; username?: string; name?: string } | null;
}

/**
 * One job of a pipeline. `stage` is the only place GitLab exposes a pipeline's stages, so
 * these are what `pipelineStages.ts` folds. `allow_failure` matters: a job that fails
 * without failing the pipeline must not paint its stage red.
 */
export interface GitLabJob {
  id?: number;
  name?: string;
  stage?: string;
  status?: string;
  allow_failure?: boolean;
  web_url?: string;
}

export interface GitLabApprovals {
  approvals_required?: number | null;
  approvals_left?: number | null;
  approved_by?: Array<{ user?: { id?: number } }> | null;
}

export interface GitLabNote {
  id: number;
  body: string;
  created_at: string;
  system?: boolean;
  author?: { id?: number; username?: string; name?: string } | null;
}

/**
 * One issue, as `GET /issues` and `GET /projects/:id/issues` both report it — the issue
 * browser's (F5.5) GitLab shape. `labels` comes back as bare name strings, unlike the
 * label *objects* {@link listProjectLabels} returns, because the issue list endpoint only
 * grows that detail behind `with_labels_details`, which nothing here asks for.
 */
export interface GitLabIssue {
  iid: number;
  title: string;
  web_url: string;
  state: string;
  labels: string[];
  assignee?: { name?: string | null; username?: string | null } | null;
  updated_at: string;
  issue_type?: string | null;
  references?: { full?: string } | null;
}

/** One label of a project's own label list — `GET /projects/:id/labels`. */
export interface GitLabLabel {
  name?: string | null;
}

/** What {@link GitLabClient.listIssues} is asked to narrow a page to. */
export interface GitLabIssueQuery {
  state: 'opened';
  labels?: string[];
  search?: string;
  page: number;
  perPage: number;
}

/** GitLab's reviewer states, when the instance is new enough to report them. */
export interface GitLabReviewer {
  user?: { id?: number; username?: string };
  state?: string;
}

/**
 * One changed file's diff — a row of `GET /merge_requests/:iid/diffs` (15.7+) or an entry of
 * `changes` on the legacy `/changes` endpoint, which {@link GitLabClient.listMergeRequestDiffs}
 * folds into the same shape.
 */
export interface GitLabMergeRequestDiff {
  old_path: string;
  new_path: string;
  diff: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
  a_mode?: string;
  b_mode?: string;
  /** `diff` is empty when this is set — the file is too big for GitLab to compute one. */
  too_large?: boolean;
  /** GitLab computed the diff but is not sending it inline; a caller must fetch it on demand. */
  collapsed?: boolean;
  generated_file?: boolean;
}

/** Every file {@link GitLabClient.listMergeRequestDiffs} read, and which endpoint answered. */
export interface GitLabMergeRequestDiffList {
  diffs: GitLabMergeRequestDiff[];
  /** The page cap stopped `/diffs` early, or `/changes` admitted its own `overflow: true`. */
  truncated: boolean;
  endpoint: 'diffs' | 'changes';
}

/** What {@link GitLabClient.getAutoMergeFacts} answers about a project. */
export interface GitLabAutoMergeFacts {
  /** `GET /projects/:id`'s own merge-on-green setting, or `null` on an instance too old to send it. */
  onlyAllowMergeIfPipelineSucceeds: boolean | null;
}

/** What {@link GitLabClient.createMergeRequest} is asked to open. */
export interface CreateMergeRequestInput {
  source_branch: string;
  target_branch: string;
  title: string;
  description?: string;
  /** Delete the source branch on merge. Off unless the caller says otherwise. */
  remove_source_branch?: boolean;
}

/**
 * A merge request that now exists, and whether **we** are the ones who made it.
 *
 * The GitLab half of `CreatedPullRequest` in `github/githubClient.ts`, and it exists for
 * exactly the same reason: pressing the button twice is ordinary, and the second press must
 * report the MR that is already open rather than fail over something that is not wrong.
 */
export interface CreatedMergeRequest {
  mergeRequest: GitLabMergeRequest;
  existed: boolean;
}

/**
 * GitLab's way of saying "there is already one of these": **409**, with
 * `Another open merge request already exists for this source branch: !12`.
 *
 * The status is checked as well as the text because 409 is also GitLab's answer to a couple
 * of genuine conflicts, and the text as well as the status because reading every 409 as
 * "already open" would send the caller hunting for an MR that was never made.
 */
function isAlreadyExists(err: unknown): boolean {
  return (
    err instanceof GitLabError &&
    err.status === 409 &&
    /merge request already exists/i.test(err.message)
  );
}

/** Narrow GitLab's `state` string to ours; anything unexpected reads as closed. */
export function toMergeRequestState(raw: string | undefined): MergeRequestState {
  switch (raw) {
    case 'opened':
    case 'merged':
    case 'locked':
      return raw;
    default:
      return 'closed';
  }
}

/** Narrow a pipeline status; an absent or unknown one is honestly `unknown`. */
export function toPipelineStatus(raw: string | null | undefined): PipelineStatus {
  switch (raw) {
    case 'created':
    case 'pending':
    case 'running':
    case 'success':
    case 'failed':
    case 'canceled':
    case 'skipped':
    case 'manual':
      return raw;
    case 'cancelled': // some versions spell it with two Ls
      return 'canceled';
    default:
      return 'unknown';
  }
}

/**
 * `/projects/:id/repository/files/<path>/raw?ref=<ref>`, with the whole path encoded as ONE
 * opaque segment — slashes included — since GitLab's repository-files API addresses a file by
 * its full path as a single segment. Shared by {@link GitLabClient.getRawFile} and
 * {@link GitLabClient.getRawFileBytes}, which differ only in how they read the response body.
 */
function rawFilePath(projectId: number | string, path: string, ref: string): string {
  const project = encodeURIComponent(String(projectId));
  return `/projects/${project}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`;
}

export class GitLabClient {
  constructor(private readonly config: GitLabClientConfig) {}

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}/api/v4${path}`;
  }

  /** One request. Returns the parsed body and the response, so pagination can read headers. */
  private async raw(path: string): Promise<{ body: unknown; res: Response }> {
    const res = await fetch(this.url(path), {
      // Cleaned at the point of use, not just where it was saved — a token stored with a
      // pasted newline on it is already in the store, and nothing about it looks wrong.
      headers: { 'PRIVATE-TOKEN': sanitizeToken(this.config.token), Accept: 'application/json' },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitLabError(
        `GitLab ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`,
        res.status,
      );
    }
    if (res.status === 204) return { body: undefined, res };
    return { body: await res.json(), res };
  }

  private async request<T>(path: string): Promise<T> {
    return (await this.raw(path)).body as T;
  }

  /**
   * One GET whose `Response` the caller reads for itself — the shape {@link getRawFile} and
   * {@link getRawFileBytes} need and every other read on this client does not. Mirrors
   * {@link raw}'s failure path exactly, so a 404 here is the same {@link GitLabError} a caller
   * already knows how to tell apart from every other status.
   */
  private async rawResponse(path: string): Promise<Response> {
    const res = await fetch(this.url(path), {
      headers: { 'PRIVATE-TOKEN': sanitizeToken(this.config.token), Accept: 'application/json' },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitLabError(
        `GitLab ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`,
        res.status,
      );
    }
    return res;
  }

  /** {@link rawResponse}, read as text — the shape {@link getRawFile} needs. */
  private async rawText(path: string): Promise<string> {
    return (await this.rawResponse(path)).text();
  }

  /**
   * Every page of a list endpoint, following `x-next-page` up to `maxPages` — the loop
   * {@link listMyMergeRequests} used to run inline, extracted so {@link listReviewerMergeRequests}
   * does not have to repeat it. An empty header means the same thing a missing one does (the
   * last page), as {@link listIssues} already has to account for.
   *
   * `truncated` is true only when the cap stopped the read with a next page still on offer —
   * exhausting the pages on our own terms (no `x-next-page`, or one GitLab sends but cannot
   * be read as a positive page number) is an honestly complete answer, not a short one.
   */
  private async pageByNextPage<T>(
    path: string,
    maxPages: number,
  ): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    let page = 1;
    for (let i = 0; i < maxPages; i++) {
      const pagedPath = path.includes('?') ? `${path}&page=${page}` : `${path}?page=${page}`;
      const { body, res } = await this.raw(pagedPath);
      if (Array.isArray(body)) items.push(...(body as T[]));
      const next = res.headers?.get('x-next-page');
      if (!next || !next.trim()) return { items, truncated: false };
      const nextPage = Number(next);
      if (!Number.isFinite(nextPage) || nextPage <= 0) return { items, truncated: false };
      page = nextPage;
    }
    return { items, truncated: true };
  }

  /**
   * One GraphQL call, at `/api/graphql` rather than `/api/v4` — the only route to the merge
   * commit message GitLab itself would propose, which the REST API has no field for.
   *
   * A deliberate mirror of `GitHubClient.graphql`: errors are checked at TWO levels, because
   * a POST to `/graphql` answers with a non-2xx only for transport-level failures (auth,
   * rate limiting). A query GitLab could not resolve — a merge request the token cannot see,
   * a field an older instance does not have — comes back as HTTP 200 with an `errors` array
   * instead, and reading only the status would hand the caller a `data` full of nulls that
   * looks like "no message proposed" rather than a call that never answered.
   */
  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/api/graphql`, {
      method: 'POST',
      headers: {
        'PRIVATE-TOKEN': sanitizeToken(this.config.token),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitLabError(
        `GitLab ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`,
        res.status,
      );
    }
    const body = (await res.json().catch(() => undefined)) as
      { data?: T; errors?: Array<{ message?: string }> } | undefined;
    if (body?.errors?.length) {
      throw new GitLabError(
        `GitLab GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`,
        res.status,
      );
    }
    return body?.data as T;
  }

  /**
   * One WRITE — the only calls in this client that change anything on the instance.
   *
   * A deliberate mirror of `GitHubClient.write`, down to the reasoning: it is a separate
   * method rather than a `method` parameter on {@link raw} so that **every read stays a
   * read by construction**. A method argument defaulting to GET is one careless call away
   * from a POST, and this client is otherwise entirely read-only — the board mirrors
   * GitLab, it does not drive it.
   *
   * Same {@link GitLabError} on failure, carrying the same status, because the callers
   * distinguish outcomes by status (a 409 is "already open", not a fault) and a second
   * error type would mean a second set of those checks.
   */
  private async write<T>(
    path: string,
    method: 'POST' | 'PUT' | 'DELETE',
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      'PRIVATE-TOKEN': sanitizeToken(this.config.token),
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(this.url(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitLabError(
        `GitLab ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`,
        res.status,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json().catch(() => undefined)) as T;
  }

  /** GET /user — the "Test connection" call, and the identity every note is compared to. */
  getMe(): Promise<GitLabUser> {
    return this.request<GitLabUser>('/user');
  }

  /**
   * Open merge requests the user created, newest activity first.
   *
   * `scope=created_by_me` only — a decision, not an oversight: it is the set you are
   * responsible for landing. MRs where you are merely a reviewer are someone else's to
   * push, and folding them in would double the board's noise. Follows `x-next-page`,
   * since GitLab pages at 100 and a busy month exceeds that.
   */
  async listMyMergeRequests(maxPages = 5): Promise<GitLabMergeRequest[]> {
    const { items } = await this.pageByNextPage<GitLabMergeRequest>(
      '/merge_requests?scope=created_by_me&state=opened&per_page=100&order_by=updated_at',
      maxPages,
    );
    return items;
  }

  /**
   * Open merge requests where the signed-in user is a REVIEWER rather than the author — the
   * counterpart of {@link listMyMergeRequests}'s `created_by_me`.
   *
   * `scope=all` is not optional: GitLab defaults this endpoint's scope to `created_by_me`,
   * which would silently hide every merge request this call exists to find — one the token
   * did not open itself. `truncated` is returned alongside the list for the same reason
   * GitHub's `listReviewRequests` does: a review queue that silently dropped rows is a worse
   * failure than one that admits it could not finish reading them.
   */
  async listReviewerMergeRequests(
    username: string,
    maxPages = 5,
  ): Promise<{ mergeRequests: GitLabMergeRequest[]; truncated: boolean }> {
    const { items, truncated } = await this.pageByNextPage<GitLabMergeRequest>(
      `/merge_requests?reviewer_username=${encodeURIComponent(username)}&state=opened&scope=all&per_page=100&order_by=updated_at`,
      maxPages,
    );
    return { mergeRequests: items, truncated };
  }

  /**
   * One page of open issues — a project's own when `projectId` is given, or everything
   * assigned to the signed-in user when it is null, the same `scope` the issue browser's
   * other two providers default to when nothing narrows them further.
   *
   * Pages by `x-next-page`, the same header {@link listMyMergeRequests} follows, but reads
   * it once rather than looping: the issue browser asks for one page at a time and carries
   * the cursor itself. GitLab answers with the header present but EMPTY on the last page
   * rather than omitting it, so a blank string is treated the same as a missing one.
   */
  async listIssues(
    projectId: string | null,
    query: GitLabIssueQuery,
  ): Promise<{ issues: GitLabIssue[]; nextPage: string | null }> {
    const params = new URLSearchParams();
    params.set('state', query.state);
    params.set('page', String(query.page));
    params.set('per_page', String(query.perPage));
    if (query.labels?.length) params.set('labels', query.labels.join(','));
    if (query.search?.trim()) params.set('search', query.search.trim());
    const path = projectId
      ? `/projects/${encodeURIComponent(projectId)}/issues?${params}`
      : `/issues?scope=assigned_to_me&${params}`;
    const { body, res } = await this.raw(path);
    const next = res.headers?.get('x-next-page');
    return {
      issues: Array.isArray(body) ? (body as GitLabIssue[]) : [],
      nextPage: next && next.trim() ? next : null,
    };
  }

  /**
   * A project's own labels — the first 100 — for the issue browser's facet list. GitHub's
   * `listRepoLabels` counterpart; GitLab's equivalent lives on the project rather than an
   * instance-wide endpoint the way JIRA's `/label` does.
   */
  listProjectLabels(projectId: string): Promise<GitLabLabel[]> {
    return this.request<GitLabLabel[]>(
      `/projects/${encodeURIComponent(projectId)}/labels?per_page=100`,
    );
  }

  /**
   * One MR in full. The list endpoint does not reliably carry `head_pipeline` or
   * reviewers, so this is the only way to know whether CI is red.
   */
  getMergeRequest(projectId: number, iid: number): Promise<GitLabMergeRequest> {
    return this.request<GitLabMergeRequest>(`/projects/${projectId}/merge_requests/${iid}`);
  }

  /**
   * The same MR as {@link getMergeRequest}, addressed by the project's URL-encoded PATH
   * instead of its numeric id — what a pasted merge-request URL actually gives
   * (`forge/parsePrUrl.ts`), rather than the id only a prior API call would know. Used once,
   * to resolve a manually linked URL into the numeric `project_id` that `describeMergeRequest`
   * and every other call in this client need; see `forge/linkPr.ts`.
   */
  getMergeRequestByPath(projectPath: string, iid: number): Promise<GitLabMergeRequest> {
    return this.request<GitLabMergeRequest>(
      `/projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}`,
    );
  }

  /**
   * Every changed file's diff — `GET /merge_requests/:iid/diffs` (15.7+), paged by
   * `x-next-page` up to `maxPages`, written out rather than delegated to
   * {@link pageByNextPage}: a 404 on the very FIRST page falls back to the legacy `/changes`
   * endpoint (pre-15.7, or an instance that never grew `/diffs`), but a 404 on any LATER page
   * is a real fault — the merge request vanished mid-read, a token revoked between pages —
   * and must propagate rather than silently restart the whole read through `/changes`.
   *
   * Any other error from `/diffs`, or a 404 from `/changes` too, propagates; F15.8 is what
   * turns the latter into an explicit "no diff endpoint" error for the UI.
   */
  async listMergeRequestDiffs(
    projectId: number | string,
    iid: number,
    maxPages = 30,
  ): Promise<GitLabMergeRequestDiffList> {
    const project = encodeURIComponent(String(projectId));
    const basePath = `/projects/${project}/merge_requests/${iid}/diffs?per_page=100`;

    let firstPage: { body: unknown; res: Response };
    try {
      firstPage = await this.raw(`${basePath}&page=1`);
    } catch (err) {
      if (err instanceof GitLabError && err.status === 404) {
        return this.mergeRequestChangesFallback(project, iid);
      }
      throw err;
    }

    const diffs: GitLabMergeRequestDiff[] = Array.isArray(firstPage.body)
      ? (firstPage.body as GitLabMergeRequestDiff[])
      : [];
    let next = firstPage.res.headers?.get('x-next-page');
    for (let i = 1; i < maxPages; i++) {
      if (!next || !next.trim()) break;
      const page = Number(next);
      if (!Number.isFinite(page) || page <= 0) break;
      const { body, res } = await this.raw(`${basePath}&page=${page}`);
      if (Array.isArray(body)) diffs.push(...(body as GitLabMergeRequestDiff[]));
      next = res.headers?.get('x-next-page');
    }
    const truncated = Boolean(
      next && next.trim() && Number.isFinite(Number(next)) && Number(next) > 0,
    );
    return { diffs, truncated, endpoint: 'diffs' };
  }

  /**
   * The legacy `/changes` endpoint {@link listMergeRequestDiffs} falls back to. GitLab moved
   * the per-file diff list out of the detail payload and into its own `/diffs` endpoint in
   * 15.7 — everything older only ever exposed it bundled under `changes` here. `overflow` is
   * GitLab's own truncation flag for this endpoint, since `/changes` answers in one response
   * and carries no `x-next-page` to page through.
   */
  private async mergeRequestChangesFallback(
    project: string,
    iid: number,
  ): Promise<GitLabMergeRequestDiffList> {
    const body = await this.request<{ changes?: unknown; overflow?: boolean }>(
      `/projects/${project}/merge_requests/${iid}/changes`,
    );
    return {
      diffs: Array.isArray(body?.changes) ? (body.changes as GitLabMergeRequestDiff[]) : [],
      truncated: body?.overflow === true,
      endpoint: 'changes',
    };
  }

  /**
   * A file's raw content at a ref — `GET /projects/:id/repository/files/<path>/raw?ref=<ref>`.
   *
   * The whole path is encoded as ONE opaque segment (`encodeURIComponent(path)`, slashes
   * included), unlike GitHub's per-segment encoding: GitLab's repository-files API addresses
   * a file by its full path as a single segment, so a literal `/` must arrive as `%2F` or the
   * request resolves against a different, shorter path.
   */
  getRawFile(projectId: number | string, path: string, ref: string): Promise<string> {
    return this.rawText(rawFilePath(projectId, path, ref));
  }

  /**
   * The same file, as raw BYTES rather than text — what a context read needs for a path that
   * may not be UTF-8 (an image blob, say). Reads the response's `arrayBuffer()` rather than
   * `.text()`, so bytes that are not valid UTF-8 survive the round trip unchanged; `.text()`
   * would replace them with the Unicode replacement character.
   */
  async getRawFileBytes(projectId: number | string, path: string, ref: string): Promise<Buffer> {
    const res = await this.rawResponse(rawFilePath(projectId, path, ref));
    return Buffer.from(await res.arrayBuffer());
  }

  /** Approval state. Tier-gated — a 403 here is normal and the caller degrades. */
  getApprovals(projectId: number, iid: number): Promise<GitLabApprovals> {
    return this.request<GitLabApprovals>(`/projects/${projectId}/merge_requests/${iid}/approvals`);
  }

  /** Reviewer states — `requested_changes` needs GitLab ≥16 and may simply be absent. */
  async getReviewers(projectId: number, iid: number): Promise<GitLabReviewer[]> {
    const body = await this.request<unknown>(
      `/projects/${projectId}/merge_requests/${iid}/reviewers`,
    );
    return Array.isArray(body) ? (body as GitLabReviewer[]) : [];
  }

  /**
   * A pipeline's jobs, newest first — the only route to its stages, which GitLab does not
   * expose on their own. Permission-gated on some instances (a 403 for a token that can
   * read the MR but not its CI), so the caller degrades to the overall status.
   *
   * One page of 100: a pipeline with more jobs than that would make the stage row
   * unreadable anyway, and every stage still appears as long as its first job is on the
   * page — `include_retried` is left off so retries do not crowd it out.
   */
  async listPipelineJobs(projectId: number, pipelineId: number): Promise<GitLabJob[]> {
    const body = await this.request<unknown>(
      `/projects/${projectId}/pipelines/${pipelineId}/jobs?per_page=100`,
    );
    return Array.isArray(body) ? (body as GitLabJob[]) : [];
  }

  /**
   * Rebase the source branch onto the target — `PUT /projects/{id}/merge_requests/{iid}/rebase`.
   *
   * GitLab queues this rather than doing it inline, so the response carries no new merge
   * status: the caller re-syncs afterwards the same way a poll would, and the rebase shows up
   * once GitLab has actually finished it.
   */
  async rebaseMergeRequest(projectId: number, iid: number): Promise<void> {
    await this.write<unknown>(`/projects/${projectId}/merge_requests/${iid}/rebase`, 'PUT');
  }

  /**
   * Merge it — `PUT /projects/{id}/merge_requests/{iid}/merge`.
   *
   * `sha`, when given, is GitLab's own guard against merging a branch that moved out from
   * under the human after they looked at it: GitLab answers with a 409 if the source
   * branch's current head does not match. Refusals go through the same {@link write}
   * every other mutation does, so "not mergeable" (405), blocked (406), a moved SHA (409),
   * or a validation failure (422) all surface as a {@link GitLabError} carrying GitLab's own
   * message rather than a generic one of ours.
   *
   * `options.message`, when given and not blank, becomes `merge_commit_message` — or, when
   * `options.squash` is set, `squash` plus `squash_commit_message` instead, since a squashed
   * merge request writes a DIFFERENT commit than its merge commit and GitLab keeps the two
   * messages as separate fields.
   */
  mergeMergeRequest(
    projectId: number,
    iid: number,
    sha?: string,
    options?: { message?: string; squash?: boolean },
  ): Promise<GitLabMergeRequest> {
    const body: Record<string, unknown> = {};
    if (sha) body.sha = sha;
    const message = options?.message && options.message.trim() ? options.message : undefined;
    if (options?.squash) {
      body.squash = true;
      if (message) body.squash_commit_message = message;
    } else if (message) {
      body.merge_commit_message = message;
    }
    return this.write<GitLabMergeRequest>(
      `/projects/${projectId}/merge_requests/${iid}/merge`,
      'PUT',
      Object.keys(body).length ? body : undefined,
    );
  }

  /**
   * The commit message GitLab itself would propose for merging this merge request, and the
   * method it would use — read with GraphQL's `defaultMergeCommitMessage` /
   * `defaultSquashCommitMessage`, which the REST API has no equivalent for, because GitLab
   * renders these from a configurable TEMPLATE (`merge_commit_template`,
   * `squash_commit_template`) and re-implementing that templating here would drift the
   * moment a project changes its own.
   *
   * `squashOnMerge` decides merge vs. squash, the same choice `mergeMergeRequest`'s
   * `options.squash` makes, so the proposal and the merge read the same project setting.
   * A project configured for fast-forward-only merges (`mergeMethod: "FF"`) creates no merge
   * commit at all, so there is no message to propose and the field stays null.
   */
  async getMergeProposal(
    projectPath: string,
    iid: number,
  ): Promise<{ method: 'merge' | 'squash' | 'ff'; message: string | null }> {
    const data = await this.graphql<{
      project?: {
        mergeMethod?: string | null;
        mergeRequest?: {
          defaultMergeCommitMessage?: string | null;
          defaultSquashCommitMessage?: string | null;
          squashOnMerge?: boolean | null;
        } | null;
      } | null;
    }>(
      `query($fullPath: ID!, $iid: String!) {
        project(fullPath: $fullPath) {
          mergeMethod
          mergeRequest(iid: $iid) {
            defaultMergeCommitMessage
            defaultSquashCommitMessage
            squashOnMerge
          }
        }
      }`,
      { fullPath: projectPath, iid: String(iid) },
    );
    const project = data.project;
    if (project?.mergeMethod === 'FF') return { method: 'ff', message: null };
    const mr = project?.mergeRequest;
    if (mr?.squashOnMerge) {
      return { method: 'squash', message: mr.defaultSquashCommitMessage ?? null };
    }
    return { method: 'merge', message: mr?.defaultMergeCommitMessage ?? null };
  }

  /**
   * Open a merge request — `POST /projects/{path}/merge_requests`.
   *
   * Addressed by the **URL-encoded project path** (`group%2Fsub%2Fproj`) rather than by the
   * numeric id, which GitLab accepts everywhere an id is taken. That saves a whole extra
   * round trip: the path is what a git remote already carries, whereas the numeric id is
   * something only the API knows — and looking it up first would mean a lookup that can
   * fail for its own reasons before the create has even been attempted.
   *
   * **An existing merge request is a SUCCESS**, exactly as on GitHub: a 409 is what pressing
   * the button twice looks like, and the open MR for that source branch is fetched and
   * returned with `existed: true`. See {@link CreatedMergeRequest}.
   */
  async createMergeRequest(
    projectPath: string,
    input: CreateMergeRequestInput,
  ): Promise<CreatedMergeRequest> {
    const project = encodeURIComponent(projectPath);
    try {
      const mergeRequest = await this.write<GitLabMergeRequest>(
        `/projects/${project}/merge_requests`,
        'POST',
        {
          source_branch: input.source_branch,
          target_branch: input.target_branch,
          title: input.title,
          // Sent even when empty, so a card with no description clears rather than inherits.
          description: input.description ?? '',
          remove_source_branch: input.remove_source_branch ?? false,
        },
      );
      return { mergeRequest, existed: false };
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      const open = await this.findOpenMergeRequest(projectPath, input.source_branch);
      if (!open) throw err;
      return { mergeRequest: open, existed: true };
    }
  }

  /**
   * Update a merge request's own fields — `PUT /projects/{path}/merge_requests/{iid}`.
   *
   * Addressed by the URL-encoded project path, same as {@link createMergeRequest}. Only
   * `description` is ever sent — `createPr.ts`'s refresh-on-push rewrites the description
   * to stay in step with the branch's own commits on every push, but leaves the title alone,
   * for the same reason `githubClient`'s `updatePullRequest` leaves it alone: a human may
   * have retitled it.
   */
  async updateMergeRequest(
    projectPath: string,
    iid: number,
    input: { description: string },
  ): Promise<GitLabMergeRequest> {
    const project = encodeURIComponent(projectPath);
    return this.write<GitLabMergeRequest>(`/projects/${project}/merge_requests/${iid}`, 'PUT', {
      description: input.description,
    });
  }

  /** The open MR whose source branch is `branch`, or null when there is none. */
  async findOpenMergeRequest(
    projectPath: string,
    branch: string,
  ): Promise<GitLabMergeRequest | null> {
    const project = encodeURIComponent(projectPath);
    const body = await this.request<unknown>(
      `/projects/${project}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}&per_page=1`,
    );
    const list = Array.isArray(body) ? (body as GitLabMergeRequest[]) : [];
    return list[0] ?? null;
  }

  /**
   * Human notes on an MR, newest first. System notes (status changes, label edits) are
   * dropped: they are the tool talking to itself, and counting them as unread comments
   * would leave every MR permanently orange.
   */
  async listNotes(projectId: number, iid: number): Promise<GitLabNote[]> {
    const body = await this.request<unknown>(
      `/projects/${projectId}/merge_requests/${iid}/notes?per_page=100&order_by=created_at&sort=desc`,
    );
    return Array.isArray(body) ? (body as GitLabNote[]).filter((n) => n?.system !== true) : [];
  }

  /**
   * Arm auto-merge — `PUT /merge_requests/:iid/merge` with `merge_when_pipeline_succeeds`,
   * the flag that has meant "merge this once its pipeline is green" since before GitLab had
   * a dedicated name for the feature. `auto_merge: true` is sent alongside it: GitLab 17+'s
   * own name for the same request, sent so a newer instance recognises this as an explicit
   * auto-merge request rather than inferring it — and simply ignored by anything older.
   *
   * **Idempotent.** A fresh {@link getMergeRequestByPath} decides first: a merge request
   * already flagged `merge_when_pipeline_succeeds` means some earlier call already armed it,
   * and `'already'` is reported rather than re-sending a PUT GitLab would answer with
   * nothing new to do.
   */
  async enableAutoMerge(
    projectPath: string,
    iid: number,
    options?: { squash?: boolean },
  ): Promise<'already' | 'enabled'> {
    const mr = await this.getMergeRequestByPath(projectPath, iid);
    if (mr.merge_when_pipeline_succeeds) return 'already';
    const project = encodeURIComponent(projectPath);
    const body: Record<string, unknown> = {
      merge_when_pipeline_succeeds: true,
      auto_merge: true,
    };
    if (options?.squash !== undefined) body.squash = options.squash;
    await this.write(`/projects/${project}/merge_requests/${iid}/merge`, 'PUT', body);
    return 'enabled';
  }

  /**
   * Disarm auto-merge — `POST /merge_requests/:iid/cancel_merge_when_pipeline_succeeds`,
   * GitLab's own endpoint for withdrawing the hold {@link enableAutoMerge} placed. Safe to
   * call on a merge request with none armed: GitLab answers success either way, so there is
   * no fresh read to make it conditional on the way {@link enableAutoMerge} has one.
   */
  async cancelAutoMerge(projectPath: string, iid: number): Promise<void> {
    const project = encodeURIComponent(projectPath);
    await this.write(
      `/projects/${project}/merge_requests/${iid}/cancel_merge_when_pipeline_succeeds`,
      'POST',
    );
  }

  /**
   * Whether this project itself requires a green pipeline before ANY merge request can be
   * merged — `GET /projects/:id`'s `only_allow_merge_if_pipeline_succeeds`, a project-wide
   * setting independent of any one merge request's own `merge_when_pipeline_succeeds`.
   */
  async getAutoMergeFacts(projectPath: string): Promise<GitLabAutoMergeFacts> {
    const project = encodeURIComponent(projectPath);
    const body = await this.request<{ only_allow_merge_if_pipeline_succeeds?: boolean | null }>(
      `/projects/${project}`,
    );
    return {
      onlyAllowMergeIfPipelineSucceeds: body.only_allow_merge_if_pipeline_succeeds ?? null,
    };
  }
}
