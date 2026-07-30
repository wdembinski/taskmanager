/**
 * Minimal GitLab REST client, shaped after `jira/jiraClient.ts`.
 *
 * Node global `fetch`, no HTTP dependency, and deliberately free of Electron and the
 * store so it can be unit-tested against a mocked `fetch`. One auth mode, unlike JIRA:
 * `PRIVATE-TOKEN` works on gitlab.com and every self-hosted instance, for both personal
 * and project access tokens.
 */
import type { MergeRequestState, PipelineStatus } from '@shared/mergeRequest';

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
      headers: { 'PRIVATE-TOKEN': this.config.token, Accept: 'application/json' },
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
