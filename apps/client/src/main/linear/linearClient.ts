/**
 * Minimal Linear GraphQL client, shaped after `github/githubClient.ts`'s doc density and
 * error-text pattern (status plus the first 300 chars of the response), but with
 * `fetchImpl?: typeof fetch` injected in `agentProfilesApi.ts`'s style rather than
 * GitHub's constructor config — there is no base-URL derivation here, only one endpoint.
 *
 * One auth mode: a Linear personal API key goes on the wire RAW as `Authorization`, with
 * no `Bearer` prefix — unlike GitHub and GitLab, both token-based but both `Bearer`.
 *
 * `request` cannot stop at `res.ok` the way `githubClient`'s `raw`/`write` do: Linear
 * routinely answers a bad key with HTTP 400 and `AUTHENTICATION_ERROR` in `errors` rather
 * than a 401, so the body is parsed and `errors` read on every response, 2xx or not.
 * Linear's partial-success shape — `data` and `errors` both present — is surfaced via
 * {@link LinearGraphQLError.partialData} rather than discarded, the opposite of
 * `githubClient.graphql`'s all-or-nothing throw.
 */
import type { IssueFilter, LinearRequest } from './linearQueries';
import {
  chunkIds,
  commentCreateMutation,
  commentsQuery,
  issueUpdateStateMutation,
  issuesByIdQuery,
  issuesQuery,
  teamStatesQuery,
  teamsQuery,
  viewerQuery,
} from './linearQueries';
import { sanitizeToken } from '@shared/secretToken';
import type { LinearWorkflowState } from './linearMove';
import { narrowStateType } from './linearSync';

export interface LinearClientConfig {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Defaults to Linear's own GraphQL endpoint; overridable for tests. */
  endpoint?: string;
}

const DEFAULT_ENDPOINT = 'https://api.linear.app/graphql';

/** One entry of a GraphQL response's `errors` array, Linear's own `extensions.code` included. */
interface LinearGraphQLErrorEntry {
  message: string;
  extensions?: { code?: string };
}

interface LinearGraphQLBody<T> {
  data?: T;
  errors?: LinearGraphQLErrorEntry[];
}

/** Base of the error ladder. Every subclass carries the HTTP status the response actually had. */
export class LinearError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LinearError';
  }
}

/** HTTP 401, or any GraphQL error with `extensions.code === 'AUTHENTICATION_ERROR'`. */
export class LinearAuthError extends LinearError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = 'LinearAuthError';
  }
}

/**
 * Any `errors` entry with `extensions.code === 'RATELIMITED'`, or HTTP 429.
 *
 * `resetAt` is epoch ms, read by {@link parseRateLimitReset}, or null when Linear sent
 * nothing parseable — the message names when Linear will be read again since the status
 * bar shows it as-is.
 */
export class LinearRateLimitError extends LinearError {
  constructor(
    status: number,
    readonly resetAt: number | null,
  ) {
    super(
      resetAt !== null
        ? `Linear rate limit — resets at ${new Date(resetAt).toISOString()}`
        : 'Linear rate limit — reset time unknown',
      status,
    );
    this.name = 'LinearRateLimitError';
  }
}

/**
 * Any other `errors` array, INCLUDING when `data` is also present — Linear's partial-success
 * shape is kept on {@link partialData} rather than discarded, for a caller that wants what
 * did come back.
 */
export class LinearGraphQLError<T = unknown> extends LinearError {
  constructor(
    status: number,
    readonly errors: LinearGraphQLErrorEntry[],
    readonly partialData: T | undefined,
  ) {
    super(errors.map((e) => e.message).join('; ') || 'Linear GraphQL error', status);
    this.name = 'LinearGraphQLError';
  }
}

/**
 * `x-ratelimit-requests-reset`, falling back to `x-ratelimit-complexity-reset`. Accepts
 * either epoch-ms or epoch-seconds — a value under 1e12 could not be a millisecond
 * timestamp in this century, so it is read as seconds and multiplied. Null when absent or
 * unparseable, never NaN.
 */
export function parseRateLimitReset(headers: { get(name: string): string | null }): number | null {
  const raw =
    headers.get('x-ratelimit-requests-reset') ?? headers.get('x-ratelimit-complexity-reset');
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return value < 1e12 ? value * 1000 : value;
}

/** Mirrors `linearQueries.ts`'s `ISSUE_FIELDS` fragment, field for field. */
export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  priority: number;
  updatedAt: string;
  state: { id: string; name: string; type: string };
  team: { id: string; key: string };
  labels: { nodes: Array<{ name: string }> };
  assignee: { id: string; name: string } | null;
}

/** Mirrors the comment selection in `linearQueries.ts`'s `commentsQuery`. */
export interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  url: string;
  user: { id: string; name: string; displayName: string } | null;
}

/** Mirrors `linearQueries.ts`'s `viewerQuery` — the authenticated token's own identity. */
export interface LinearViewer {
  id: string;
  name: string;
  displayName: string;
}

/** Mirrors `linearQueries.ts`'s `teamsQuery` selection. */
export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

/**
 * The result of {@link LinearClient.fetchIssues}: the page it collected, plus whether the
 * cap stopped it short — the same contract as `GitHubSearchResult.truncated`, so a
 * reconciler never reads a capped answer as a shrunken board.
 */
export interface LinearIssuePage {
  issues: LinearIssue[];
  truncated: boolean;
  cap: number;
}

interface IssueConnection {
  nodes: LinearIssue[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

export class LinearClient {
  private readonly endpoint: string;

  constructor(private readonly config: LinearClientConfig) {
    this.endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
  }

  /**
   * The one POST every other method funnels through: one `fetchImpl` call, the error
   * ladder above, then `data` returned.
   */
  private async request<T>(req: LinearRequest): Promise<T> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const res = await fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: sanitizeToken(this.config.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: req.query, variables: req.variables }),
    });

    const text = await res.text().catch(() => '');
    let body: LinearGraphQLBody<T> | undefined;
    try {
      body = text ? (JSON.parse(text) as LinearGraphQLBody<T>) : undefined;
    } catch {
      body = undefined;
    }

    const errors = body?.errors ?? [];
    const authError = errors.find((e) => e.extensions?.code === 'AUTHENTICATION_ERROR');
    if (res.status === 401 || authError) {
      throw new LinearAuthError(
        authError?.message ?? `Linear ${res.status} ${res.statusText}`,
        res.status,
      );
    }

    const rateLimitError = errors.find((e) => e.extensions?.code === 'RATELIMITED');
    if (res.status === 429 || rateLimitError) {
      throw new LinearRateLimitError(res.status, parseRateLimitReset(res.headers));
    }

    if (errors.length > 0) {
      throw new LinearGraphQLError(res.status, errors, body?.data);
    }

    if (!res.ok) {
      throw new LinearError(
        `Linear ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`,
        res.status,
      );
    }

    return body?.data as T;
  }

  /**
   * Pages `issuesQuery` while `hasNextPage`, stopping at `cap` — slicing the final page
   * down to size — and reporting `truncated: true` whenever Linear still had more. A
   * `hasNextPage: true` with no `endCursor` also stops, `truncated: true`, rather than
   * looping on an unchanged cursor.
   */
  async fetchIssues(
    filter: IssueFilter,
    { cap = 500, pageSize = 50 }: { cap?: number; pageSize?: number } = {},
  ): Promise<LinearIssuePage> {
    const issues: LinearIssue[] = [];
    let after: string | null = null;
    let truncated = false;

    for (;;) {
      const data: { issues: IssueConnection } = await this.request(
        issuesQuery(filter, after, pageSize),
      );
      issues.push(...data.issues.nodes);
      const { hasNextPage, endCursor } = data.issues.pageInfo;

      if (issues.length >= cap) {
        truncated = hasNextPage;
        break;
      }
      if (!hasNextPage) break;
      if (!endCursor) {
        truncated = true;
        break;
      }
      after = endCursor;
    }

    return { issues: issues.slice(0, cap), truncated, cap };
  }

  /**
   * The retained-issue re-read: `chunkIds` then one `request` per chunk built by
   * `issuesByIdQuery`, which itself returns null for a chunk with no valid id — no call is
   * made for it.
   */
  async fetchIssuesByIds(ids: readonly string[]): Promise<LinearIssue[]> {
    const issues: LinearIssue[] = [];
    for (const chunk of chunkIds(ids)) {
      const req = issuesByIdQuery(chunk);
      if (!req) continue;
      const data: { issues: IssueConnection } = await this.request(req);
      issues.push(...data.issues.nodes);
    }
    return issues;
  }

  /** One issue's comments, oldest-page-first, up to `maxPages`. */
  async fetchComments(issueId: string, maxPages = 2): Promise<LinearComment[]> {
    const comments: LinearComment[] = [];
    let after: string | null = null;

    for (let i = 0; i < maxPages; i++) {
      const data: {
        issue: {
          comments: {
            nodes: LinearComment[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      } = await this.request(commentsQuery(issueId, after));

      const connection = data.issue?.comments;
      if (!connection) break;
      comments.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) break;
      after = connection.pageInfo.endCursor;
    }

    return comments;
  }

  /**
   * Move an issue to a new workflow state. Throws {@link LinearError} when Linear's own
   * `success` flag comes back false, so a caller can roll an optimistic move back.
   */
  async updateIssueState(issueId: string, stateId: string): Promise<void> {
    const data = await this.request<{ issueUpdate: { success: boolean } }>(
      issueUpdateStateMutation(issueId, stateId),
    );
    if (!data.issueUpdate.success) {
      throw new LinearError(`Linear issueUpdate reported failure for ${issueId}`, 200);
    }
  }

  /** Post a comment on an issue. Throws {@link LinearError} when `success` comes back false. */
  async createComment(issueId: string, body: string): Promise<LinearComment> {
    const data = await this.request<{
      commentCreate: { success: boolean; comment: LinearComment };
    }>(commentCreateMutation(issueId, body));
    if (!data.commentCreate.success) {
      throw new LinearError(`Linear commentCreate reported failure for ${issueId}`, 200);
    }
    return data.commentCreate.comment;
  }

  /** The authenticated token's own identity — used by "Test connection" and to decide "mine". */
  async getViewer(): Promise<LinearViewer> {
    const data = await this.request<{ viewer: LinearViewer }>(viewerQuery());
    return data.viewer;
  }

  /** Every team in the workspace, for the Settings `teamKeys` picker. */
  async listTeams(): Promise<LinearTeam[]> {
    const data = await this.request<{ teams: { nodes: LinearTeam[] } }>(teamsQuery());
    return data.teams.nodes;
  }

  /**
   * One team's workflow states, for the Settings status-map viewer. `type` is narrowed via
   * `linearSync`'s `narrowStateType`, the same safety net a sync reads a state through.
   */
  async listTeamStates(teamKey: string): Promise<LinearWorkflowState[]> {
    const data = await this.request<{
      workflowStates: {
        nodes: Array<{ id: string; name: string; type: string; position: number }>;
      };
    }>(teamStatesQuery(teamKey));
    return data.workflowStates.nodes.map((s) => ({ ...s, type: narrowStateType(s.type) }));
  }
}
