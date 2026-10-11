/**
 * The issue browser's data model (F5): a read-only page of a tracker's open issues, and
 * the query that fetched it. See
 * `docs/plan/feature-roadmap/F5-composer-and-hand-to-agent.md` for the full design — this
 * file is the shared contract only; the three providers that actually talk to JIRA,
 * GitHub and GitLab (`apps/client/src/main/issues/`) and the `issues:list`/`issues:import`
 * handlers behind them are F5.5.
 */

/** The trackers the issue browser can list from. GitLab has no client support yet in v1. */
export const ISSUE_PROVIDERS = ['jira', 'github', 'gitlab'] as const;
export type IssueProviderId = (typeof ISSUE_PROVIDERS)[number];

/**
 * One issue as the browser lists it — a read-only summary, not the full issue a sync would
 * build into a `Task`.
 */
export interface IssueSummary {
  provider: IssueProviderId;
  /** The issue key shown to the user — `PROJ-123`, `owner/repo#123`, `group/project!45`. */
  key: string;
  title: string;
  /** Deep link to the issue in the tracker's web UI. */
  url: string;
  /** The raw workflow status name in the tracker (e.g. "In Review"). */
  state: string;
  labels: string[];
  /** The issue type (e.g. "Bug", "Story"), when the tracker has one. */
  type?: string | null;
  /** The assignee's display name, when the issue has one. */
  assignee?: string | null;
  /** Epoch ms the issue was last updated — sorts the list newest-first. */
  updatedAt: number;
  /**
   * The id of the card this issue is **already on the board as**, or null.
   *
   * Resolved in main (not by the provider) by matching `(externalSource, externalKey)`
   * against the store, so the browser can offer "On board → open" instead of letting a
   * human import the same issue twice.
   */
  onBoardTaskId: string | null;
}

/** What `issues:list` asks for. */
export interface IssueQuery {
  provider: IssueProviderId;
  search?: string | null;
  labels?: string[];
  /**
   * Which project/repo to list from — a JIRA project key, a GitHub `owner/repo`, a GitLab
   * project id. `null`/omitted means the provider's own configured default.
   */
  scope?: string | null;
  /** Opaque, provider-specific. Omit for the first page. */
  cursor?: string | null;
}

/** What `issues:list` answers with. */
export interface IssuePage {
  items: IssueSummary[];
  /** Every label seen across the scope — not just this page's — for the filter chips. */
  labels: string[];
  /** Pass back into the next `issues:list` call to continue. Null when this was the last page. */
  nextCursor: string | null;
}

/** How many issues one page carries, at most. */
export const ISSUES_PAGE_SIZE = 50;

/** How much of an issue's title survives a clamp. */
export const ISSUE_TITLE_MAX_LENGTH = 300;
/** How many labels one issue carries, at most, after a clamp. */
export const ISSUE_LABEL_MAX_COUNT = 10;
/** How much of one label's name survives a clamp. */
export const ISSUE_LABEL_MAX_LENGTH = 40;
/** How much of any other string field (`key`, `url`, `state`, `type`, `assignee`) survives. */
export const ISSUE_FIELD_MAX_LENGTH = 200;
/** How many facet labels an {@link IssuePage} carries, at most, after a clamp. */
export const ISSUE_FACET_LABEL_MAX_COUNT = 100;

/**
 * Truncate to `maxLen` UTF-16 code units, never splitting a surrogate pair in two, and drop
 * every C0 control character first — each would otherwise survive the cut only to cost 6
 * bytes once JSON-escaped (`\u0001` and friends), which is exactly the kind of tracker-data
 * surprise this clamp exists to rule out.
 */
function truncateString(value: string, maxLen: number): string {
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\x00-\x1f]/g, '');
  if (stripped.length <= maxLen) return stripped;
  const cut = stripped.slice(0, maxLen);
  const lastCode = cut.charCodeAt(cut.length - 1);
  // A lone high surrogate at the cut point means its low surrogate was sliced away.
  const splitPair = lastCode >= 0xd800 && lastCode <= 0xdbff;
  return splitPair ? cut.slice(0, -1) : cut;
}

/**
 * Enforce every bound above on one issue — what F5.5's providers must call before handing
 * a page back, so the size guarantee below is real rather than a hope about what a tracker
 * might send. Pure and total: never throws, never drops the issue, only shortens it.
 */
export function clampIssueSummary(s: IssueSummary): IssueSummary {
  return {
    ...s,
    key: truncateString(s.key, ISSUE_FIELD_MAX_LENGTH),
    title: truncateString(s.title, ISSUE_TITLE_MAX_LENGTH),
    url: truncateString(s.url, ISSUE_FIELD_MAX_LENGTH),
    state: truncateString(s.state, ISSUE_FIELD_MAX_LENGTH),
    labels: s.labels
      .slice(0, ISSUE_LABEL_MAX_COUNT)
      .map((label) => truncateString(label, ISSUE_LABEL_MAX_LENGTH)),
    type: s.type == null ? s.type : truncateString(s.type, ISSUE_FIELD_MAX_LENGTH),
    assignee: s.assignee == null ? s.assignee : truncateString(s.assignee, ISSUE_FIELD_MAX_LENGTH),
  };
}

/**
 * The page-level counterpart of {@link clampIssueSummary}: caps `items` at
 * {@link ISSUES_PAGE_SIZE}, clamps each one, and caps the facet `labels` at
 * {@link ISSUE_FACET_LABEL_MAX_COUNT}.
 */
export function clampIssuePage(p: IssuePage): IssuePage {
  return {
    items: p.items.slice(0, ISSUES_PAGE_SIZE).map(clampIssueSummary),
    labels: p.labels
      .slice(0, ISSUE_FACET_LABEL_MAX_COUNT)
      .map((label) => truncateString(label, ISSUE_LABEL_MAX_LENGTH)),
    nextCursor: p.nextCursor,
  };
}
