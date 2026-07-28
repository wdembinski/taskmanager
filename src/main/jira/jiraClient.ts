/**
 * Minimal JIRA REST client (Phase B). Uses the Node global `fetch` — no HTTP
 * dependency — and is deliberately free of Electron and the store, so it can be
 * unit-tested with a mocked `fetch`. Auth and API version are injected, so the same
 * client serves self-hosted Server/Data Center (PAT `Bearer`, REST v2) and Atlassian
 * Cloud (email + API token `Basic`, REST v3).
 */
import {
  blocksToText,
  buildAdf,
  buildWikiBody,
  parseAdf,
  type AdfAttachmentRef,
  type AdfMention,
} from './adf';

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

/** A person the @mention picker can offer. `accountId` is Cloud, `name` is Server/DC. */
export interface JiraUser {
  accountId: string | null;
  name: string | null;
  displayName: string;
  emailAddress: string | null;
  avatarUrl: string | null;
}

/** A file attached to an issue. */
export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType: string | null;
  size: number | null;
  /** Authenticated download URL, or null. Opened in the browser, never fetched here. */
  url: string | null;
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
 *
 * Now a thin wrapper over `adf.ts`, so the issue description and the agent briefing get
 * the mention fix for free: the old implementation collected `text` leaves only, and a
 * mention's label lives in `attrs.text`, so every @name was silently deleted.
 */
export function commentBodyToText(body: unknown): string {
  return blocksToText(parseAdf(body));
}

/**
 * The fields a board card is built from. Shared by `search` and `getIssue` on purpose:
 * an issue we just created is read back through the SAME list, so `issueToTask` turns it
 * into a card identical to a synced one and the next poll changes nothing.
 */
const ISSUE_FIELDS =
  'summary,status,priority,project,issuetype,labels,updated,comment,description,parent';

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
    const fields = [ISSUE_FIELDS, ...extraFields.filter((f) => f.trim())].join(',');

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

  /**
   * Every workflow status this instance defines, so the status map can be picked from
   * a list rather than typed from memory.
   *
   * Two endpoints with two different shapes for the same thing. The classic `/status`
   * (v2 and v3 alike) returns a flat array whose `statusCategory` is an OBJECT with the
   * stable `key` we map on. Cloud's newer `/statuses/search` is paged (`{values}`) and
   * flattens `statusCategory` to a STRING enum (`TODO`/`IN_PROGRESS`/`DONE`). We ask the
   * classic one first because it works on both and needs no paging, and fall back only
   * if the instance has retired it — normalising either shape to the same category key,
   * so nothing downstream has to know which answered.
   */
  async listStatuses(): Promise<Array<{ name: string; categoryKey: string }>> {
    /** `statusCategory` as an object (classic) or a string enum (Cloud's newer API). */
    const keyOf = (raw: unknown): string => {
      if (typeof raw === 'string') {
        const upper = raw.toUpperCase();
        if (upper === 'IN_PROGRESS') return 'indeterminate';
        if (upper === 'DONE') return 'done';
        return 'new';
      }
      const key = (raw as { key?: unknown } | null)?.key;
      return typeof key === 'string' ? key : 'new';
    };
    const normalize = (list: unknown): Array<{ name: string; categoryKey: string }> =>
      Array.isArray(list)
        ? list
            .map((s) => s as { name?: unknown; statusCategory?: unknown })
            .filter(
              (s): s is { name: string; statusCategory?: unknown } =>
                typeof s.name === 'string' && s.name.length > 0,
            )
            .map((s) => ({ name: s.name, categoryKey: keyOf(s.statusCategory) }))
        : [];

    try {
      return normalize(await this.request<unknown>('/status'));
    } catch {
      const data = await this.request<{ values?: unknown }>('/statuses/search?maxResults=200');
      return normalize(data?.values);
    }
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

  /**
   * Post a comment, optionally naming people and citing files already attached.
   *
   * v3 takes an ADF document, v2 takes wiki markup — two dialects of the same comment,
   * both built by `adf.ts`. Mentions carry real offsets into `text` rather than an
   * inline syntax; see that module for why.
   */
  addComment(
    issueKey: string,
    text: string,
    mentions: readonly AdfMention[] = [],
    attachments: readonly AdfAttachmentRef[] = [],
  ): Promise<JiraComment> {
    const body =
      this.config.apiVersion === '3'
        ? { body: buildAdf(text, mentions, attachments) }
        : { body: buildWikiBody(text, mentions, attachments) };
    return this.request<JiraComment>(`/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * People matching a partial name, for the composer's @mention picker.
   *
   * Three wrinkles. The query PARAM differs by version (`query` on v3, `username` on
   * v2). Global user search is permission-restricted on a lot of Cloud sites, so when we
   * know the issue we ask `/user/assignable/search` instead, which any commenter can
   * normally use. And `accountId` is Cloud-only — a Server result is identified by its
   * `name`, which is what a `[~…]` mention needs there.
   */
  async searchUsers(query: string, issueKey?: string): Promise<JiraUser[]> {
    const q = query.trim();
    if (!q) return [];
    const v3 = this.config.apiVersion === '3';
    const params = new URLSearchParams({ [v3 ? 'query' : 'username']: q, maxResults: '10' });
    if (issueKey) params.set('issueKey', issueKey);
    const path = issueKey ? '/user/assignable/search' : '/user/search';
    const raw = await this.request<unknown>(`${path}?${params.toString()}`);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((entry) => entry as Record<string, unknown>)
      .map((u) => ({
        accountId: typeof u.accountId === 'string' ? u.accountId : null,
        name: typeof u.name === 'string' ? u.name : null,
        displayName:
          typeof u.displayName === 'string' && u.displayName ? u.displayName : String(u.name ?? ''),
        emailAddress: typeof u.emailAddress === 'string' ? u.emailAddress : null,
        avatarUrl:
          typeof u.avatarUrls === 'object' && u.avatarUrls
            ? ((u.avatarUrls as Record<string, unknown>)['24x24'] as string) || null
            : null,
      }))
      .filter((u) => u.displayName.length > 0);
  }

  /**
   * Attach files to an issue. Returns what JIRA stored, so a comment can cite them.
   *
   * Not routed through `request`: that helper is JSON-only, and multipart has two rules
   * that trip people up. `Content-Type` must NOT be set by hand — `fetch` writes it
   * itself, including the boundary, and a hand-written one has no boundary so JIRA
   * rejects the body. And `X-Atlassian-Token: no-check` is mandatory, or the XSRF guard
   * refuses the upload with a 403 that says nothing useful.
   */
  async uploadAttachments(
    issueKey: string,
    files: ReadonlyArray<{ filename: string; data: Uint8Array; mimeType?: string }>,
  ): Promise<JiraAttachment[]> {
    if (!files.length) return [];
    const form = new FormData();
    for (const file of files) {
      // Copy into a fresh ArrayBuffer: a Uint8Array over a pooled Node Buffer can be a
      // VIEW of a much larger block, and Blob would take the whole thing.
      const bytes = new Uint8Array(file.data);
      form.append(
        'file',
        new Blob([bytes], { type: file.mimeType || 'application/octet-stream' }),
        file.filename,
      );
    }
    const res = await fetch(this.url(`/issue/${encodeURIComponent(issueKey)}/attachments`), {
      method: 'POST',
      headers: {
        Authorization: authHeader(this.config.auth),
        Accept: 'application/json',
        'X-Atlassian-Token': 'no-check',
      },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new JiraError(
        `JIRA ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`,
        res.status,
        res.headers?.get('x-authentication-denied-reason') ?? undefined,
      );
    }
    const raw = (await res.json()) as unknown;
    return Array.isArray(raw) ? raw.map(normalizeAttachment) : [];
  }

  /**
   * Projects the user can see. Cloud pages `/project/search`; Server/DC serves a flat
   * `/project`. Both shapes are flattened by `createMeta.normalizeProjects`.
   */
  async listProjects(query?: string): Promise<unknown> {
    if (this.config.apiVersion !== '3') return this.request<unknown>('/project');
    const params = new URLSearchParams({ maxResults: '100', orderBy: 'name' });
    if (query?.trim()) params.set('query', query.trim());
    return this.request<unknown>(`/project/search?${params.toString()}`);
  }

  /**
   * Issue types the user can create in a project.
   *
   * Cloud has a dedicated endpoint; older instances answer the same question through the
   * broad create-meta with an `expand`. We try the dedicated one first on v3 and fall
   * back, because a 404 there is a deployment fact rather than an error worth surfacing.
   */
  async listIssueTypes(projectKey: string): Promise<unknown> {
    const key = encodeURIComponent(projectKey);
    if (this.config.apiVersion === '3') {
      try {
        return await this.request<unknown>(`/issue/createmeta/${key}/issuetypes?maxResults=100`);
      } catch (e) {
        if (!(e instanceof JiraError) || e.status !== 404) throw e;
      }
    }
    return this.request<unknown>(
      `/issue/createmeta?projectKeys=${key}&expand=projects.issuetypes`,
    );
  }

  /** Create an issue. Returns the key JIRA assigned, which is then read back in full. */
  async createIssue(input: {
    projectKey: string;
    issueTypeId: string;
    summary: string;
    description?: string;
  }): Promise<{ id: string; key: string }> {
    const description = input.description?.trim();
    return this.request<{ id: string; key: string }>('/issue', {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          project: { key: input.projectKey },
          issuetype: { id: input.issueTypeId },
          summary: input.summary,
          // Same v2/v3 fork as a comment body: ADF on Cloud, plain text on Server/DC.
          ...(description
            ? { description: this.config.apiVersion === '3' ? buildAdf(description) : description }
            : {}),
        },
      }),
    });
  }

  /**
   * One issue by key, with the same field list `search` asks for — so the result can go
   * straight through `issueToTask` and be indistinguishable from a synced card.
   */
  async getIssue(issueKey: string, extraFields: string[] = []): Promise<JiraIssue> {
    const fields = [ISSUE_FIELDS, ...extraFields.filter((f) => f.trim())].join(',');
    return this.request<JiraIssue>(
      `/issue/${encodeURIComponent(issueKey)}?fields=${encodeURIComponent(fields)}`,
    );
  }

  /** An issue's attachments — metadata is per-ISSUE, so comments are matched by filename. */
  async getAttachments(issueKey: string): Promise<JiraAttachment[]> {
    const data = await this.request<{ fields?: { attachment?: unknown } }>(
      `/issue/${encodeURIComponent(issueKey)}?fields=attachment`,
    );
    const raw = data?.fields?.attachment;
    return Array.isArray(raw) ? raw.map(normalizeAttachment) : [];
  }
}

/** Both endpoints answer with the same attachment shape; narrow it once. */
function normalizeAttachment(entry: unknown): JiraAttachment {
  const a = (entry ?? {}) as Record<string, unknown>;
  return {
    id: String(a.id ?? ''),
    filename: typeof a.filename === 'string' ? a.filename : '',
    mimeType: typeof a.mimeType === 'string' ? a.mimeType : null,
    size: typeof a.size === 'number' ? a.size : null,
    /** The human-facing page. `content` is the raw bytes and needs the same auth. */
    url: typeof a.content === 'string' ? a.content : null,
  };
}
