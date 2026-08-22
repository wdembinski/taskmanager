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
  /**
   * GitLab's own verdict on whether this can merge (15.6+). Carried by the DETAIL endpoint
   * only — the list omits it, which is why `describeMergeRequest` must not read it off a
   * list entry and call the absence "mergeable".
   */
  detailed_merge_status?: string | null;
  /** The pre-15.6 spelling, kept as a fallback for older self-hosted instances. */
  merge_status?: string | null;
  has_conflicts?: boolean | null;
  references?: { full?: string } | null;
  head_pipeline?: { id?: number; status?: string; web_url?: string } | null;
  pipeline?: { id?: number; status?: string; web_url?: string } | null;
  reviewers?: Array<{ id: number; username?: string }> | null;
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

/** GitLab's reviewer states, when the instance is new enough to report them. */
export interface GitLabReviewer {
  user?: { id?: number; username?: string };
  state?: string;
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
    const all: GitLabMergeRequest[] = [];
    let page = 1;
    for (let i = 0; i < maxPages; i++) {
      const { body, res } = await this.raw(
        `/merge_requests?scope=created_by_me&state=opened&per_page=100&order_by=updated_at&page=${page}`,
      );
      if (Array.isArray(body)) all.push(...(body as GitLabMergeRequest[]));
      const next = res.headers?.get('x-next-page');
      if (!next) break;
      page = Number(next);
      if (!Number.isFinite(page) || page <= 0) break;
    }
    return all;
  }

  /**
   * One MR in full. The list endpoint does not reliably carry `head_pipeline` or
   * reviewers, so this is the only way to know whether CI is red.
   */
  getMergeRequest(projectId: number, iid: number): Promise<GitLabMergeRequest> {
    return this.request<GitLabMergeRequest>(`/projects/${projectId}/merge_requests/${iid}`);
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
}
