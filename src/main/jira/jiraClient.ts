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
  };
}

export interface JiraTransition {
  id: string;
  name: string;
  to: JiraStatusRef;
}

export interface JiraComment {
  id: string;
  author?: { displayName?: string };
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

/** Flatten a comment body (v2 plain string or v3 ADF) to display text. */
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
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
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
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** GET /myself — used by the "Test connection" button. */
  testConnection(): Promise<JiraMyself> {
    return this.request<JiraMyself>('/myself');
  }

  /** Search issues by JQL, returning the fields the board needs. */
  async search(jql: string, maxResults = 100): Promise<JiraIssue[]> {
    const params = new URLSearchParams({
      jql,
      maxResults: String(maxResults),
      fields: 'summary,status,priority,project,issuetype,labels,updated,comment',
    });
    const data = await this.request<{ issues: JiraIssue[] }>(`/search?${params.toString()}`);
    return data.issues ?? [];
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
