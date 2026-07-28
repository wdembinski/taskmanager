/**
 * Minimal JIRA REST client (Phase B). Uses the Node global `fetch` — no HTTP
 * dependency — and is deliberately free of Electron and the store, so it can be
 * unit-tested with a mocked `fetch`. Auth and API version are injected, so the same
 * client serves self-hosted Server/Data Center (PAT `Bearer`, REST v2) and Atlassian
 * Cloud (email + API token `Basic`, REST v3).
 */

export interface JiraAuth {
  /** `bearer` = PAT (server/DC); `basic` = email + API token (cloud). */
  mode: 'bearer' | 'basic';
  /** The PAT (bearer) or API token (basic). */
  token: string;
  /** Account email — required for `basic` only. */
  email?: string;
}

export interface JiraClientConfig {
  /** Base URL with no trailing slash, e.g. `https://jira.company.com`. */
  baseUrl: string;
  /** REST API version segment: `2` (server) or `3` (cloud). */
  apiVersion: '2' | '3';
  auth: JiraAuth;
}

export interface JiraMyself {
  displayName: string;
  emailAddress?: string;
  name?: string;
  accountId?: string;
}

export interface JiraStatusRef {
  name: string;
  statusCategory: { key: string; name: string };
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    status: JiraStatusRef;
    priority?: { name: string } | null;
    project?: { key: string; name: string } | null;
    issuetype?: { name: string } | null;
    labels?: string[] | null;
    updated?: string;
    /** Present when the search requests the `comment` field (used for unread detection). */
    comment?: { comments: JiraComment[] } | null;
    /** Plain string on v2; Atlassian Document Format (object) on v3. Null when empty. */
    description?: unknown;
    /**
     * The parent issue — the epic on Cloud team-managed projects. Server/DC and
     * company-managed Cloud instead use the "Epic Link" custom field, read off
     * `fields` by its discovered id (see `epicField.ts`).
     */
    parent?: { key?: string } | null;
  };
}

/**
 * One entry of `GET /field` — the instance's field metadata. Used only to discover
 * the per-instance "Epic Link" custom field id (see `epicField.ts`).
 */
export interface JiraField {
  id: string;
  name?: string;
  /** `schema.custom` is the field *type* URI, e.g. `…greenhopper…:gh-epic-link`. */
  schema?: { custom?: string };
}

export interface JiraTransition {
  id: string;
  name: string;
  to: JiraStatusRef;
}

export interface JiraComment {
  id: string;
  /** `accountId` is Cloud-only; Server/DC identifies people by display name alone. */
  author?: { displayName?: string; accountId?: string };
  /** Plain string on v2; Atlassian Document Format (object) on v3. */
  body: unknown;
  created: string;
}

/** Build the `Authorization` header value for either auth mode. Pure/testable. */
export function authHeader(auth: JiraAuth): string {
  if (auth.mode === 'bearer') return `Bearer ${auth.token}`;
  const basic = Buffer.from(`${auth.email ?? ''}:${auth.token}`).toString('base64');
  return `Basic ${basic}`;
}

/**
 * Flatten a rich-text field (v2 plain string or v3 ADF) to display text. Used for
 * comment bodies and for issue descriptions, which have the same v2/v3 shapes.
 */
export function commentBodyToText(body: unknown): string {
  if (typeof body === 'string') return body;
  // Atlassian Document Format: walk the node tree collecting `text` leaves.
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { text?: unknown; content?: unknown; type?: unknown };
    if (typeof n.text === 'string') out.push(n.text);
    if (n.type === 'paragraph' || n.type === 'hardBreak') out.push('\n');
    if (Array.isArray(n.content)) for (const child of n.content) walk(child);
  };
  walk(body);
  return out
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * JIRA Server/DC's `X-Authentication-Denied-Reason` header. It carries the only
     * explanation for some 403s (most usefully `AUTHENTICATION_DENIED ... CAPTCHA_CHALLENGE`,
     * raised after repeated failed logins) — the response body is empty in that case.
     */
    readonly deniedReason?: string,
  ) {
    super(message);
    this.name = 'JiraError';
  }
}

export class JiraClient {
  constructor(private readonly config: JiraClientConfig) {}

  private url(path: string): string {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    return `${base}/rest/api/${this.config.apiVersion}${path}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(this.url(path), {
      ...init,
      headers: {
        Authorization: authHeader(this.config.auth),
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new JiraError(
        `JIRA ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`,
        res.status,
        res.headers?.get('x-authentication-denied-reason') ?? undefined,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** GET /myself — used by the "Test connection" button. */
  testConnection(): Promise<JiraMyself> {
    return this.request<JiraMyself>('/myself');
  }

  /**
   * Search issues by JQL, returning the fields the board needs. `extraFields` carries
   * per-instance fields the caller discovered at runtime — currently the "Epic Link"
   * custom field id (`customfield_NNNNN`), which cannot be named up front.
   *
   * Two different endpoints, because Atlassian removed the Cloud one. `/search` still
   * serves Server/DC, but on Cloud it now answers with a "migrate to
   * /rest/api/3/search/jql" error — so Cloud goes to the enhanced search instead. That
   * endpoint pages by opaque cursor rather than `startAt`, drops `total` entirely, and
   * hands back short pages whenever it feels like it, so a single request is NOT the
   * whole answer: we follow `nextPageToken` until the board's cap is filled.
   */
  async search(jql: string, maxResults = 100, extraFields: string[] = []): Promise<JiraIssue[]> {
    const fields = [
      'summary,status,priority,project,issuetype,labels,updated,comment,description,parent',
      ...extraFields.filter((f) => f.trim()),
    ].join(',');

    if (this.config.apiVersion !== '3') {
      const params = new URLSearchParams({ jql, maxResults: String(maxResults), fields });
      const data = await this.request<{ issues: JiraIssue[] }>(`/search?${params.toString()}`);
      return data.issues ?? [];
    }

    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    // A page cap, because an empty page WITH a token is a documented quirk of this
    // endpoint — "no issues" alone can't be the stop condition, and nothing else here
    // would stop a server that keeps handing out tokens forever.
    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({
        jql,
        maxResults: String(Math.min(100, maxResults - issues.length)),
        fields,
      });
      if (nextPageToken) params.set('nextPageToken', nextPageToken);
      const data = await this.request<{
        issues?: JiraIssue[];
        nextPageToken?: string;
        isLast?: boolean;
      }>(`/search/jql?${params.toString()}`);
      issues.push(...(data.issues ?? []));
      nextPageToken = data.isLast ? undefined : data.nextPageToken;
      if (!nextPageToken || issues.length >= maxResults) break;
    }
    return issues.slice(0, maxResults);
  }

  /** GET /field — the instance's field metadata (used to discover the Epic Link field). */
  async listFields(): Promise<JiraField[]> {
    return (await this.request<JiraField[]>('/field')) ?? [];
  }

  /** Available workflow transitions for an issue (needed to resolve a status move). */
  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    const data = await this.request<{ transitions: JiraTransition[] }>(
      `/issue/${encodeURIComponent(issueKey)}/transitions`,
    );
    return data.transitions ?? [];
  }

  /** Apply a transition by id (changes the issue's status). */
  doTransition(issueKey: string, transitionId: string): Promise<void> {
    return this.request<void>(`/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: transitionId } }),
    });
  }

  /** Fetch an issue's comments, oldest first. */
  async getComments(issueKey: string): Promise<JiraComment[]> {
    const data = await this.request<{ comments: JiraComment[] }>(
      `/issue/${encodeURIComponent(issueKey)}/comment`,
    );
    return data.comments ?? [];
  }

  /**
   * The instance's priority scale, most urgent first (JIRA returns it in rank order).
   *
   * Two endpoints again: Server/DC serves a plain array from `/priority`, while Cloud
   * has moved to the paged `/priority/search` (`{ values: [...] }`) and answers the
   * old path with a deprecation error on some sites. We ask by API version and fall
   * back to the other shape rather than guessing, since a wrong guess would leave the
   * priority dropdown empty with no explanation.
   */
  async listPriorities(): Promise<string[]> {
    const names = (list: unknown): string[] =>
      Array.isArray(list)
        ? list
            .map((p) => (p as { name?: unknown }).name)
            .filter((n): n is string => typeof n === 'string' && n.length > 0)
        : [];

    if (this.config.apiVersion === '3') {
      const data = await this.request<{ values?: unknown }>('/priority/search');
      return names(data?.values);
    }
    return names(await this.request<unknown>('/priority'));
  }

  /**
   * Set an issue's priority by name. `PUT /issue/{key}` answers 204 with no body.
   *
   * By name rather than id because the name is what we store on the task and show on
   * the card; the names come from {@link listPriorities}, i.e. from this same
   * instance, so they are ones the workflow actually has. JIRA rejects the edit (400)
   * if the field is not on the issue's screen — which is a real answer worth showing
   * the user, not something to paper over.
   */
  setPriority(issueKey: string, name: string): Promise<void> {
    return this.request<void>(`/issue/${encodeURIComponent(issueKey)}`, {
      method: 'PUT',
      body: JSON.stringify({ fields: { priority: { name } } }),
    });
  }

  /** Post a comment. v2 takes a plain string body; v3 wraps it in a minimal ADF doc. */
  addComment(issueKey: string, text: string): Promise<JiraComment> {
    const body =
      this.config.apiVersion === '3'
        ? {
            body: {
              type: 'doc',
              version: 1,
              content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
            },
          }
        : { body: text };
    return this.request<JiraComment>(`/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
}
