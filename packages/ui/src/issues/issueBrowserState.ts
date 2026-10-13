/**
 * The issue browser's list, filters and drafts, kept as a pure state machine — this repo has
 * no DOM test harness (no jsdom, no testing-library), so the only way to prove paging and the
 * out-of-order network race are correct is to pull them out of the component and test them as
 * plain functions. Same shape as `taskTimeline.ts` and `activity/feedState.ts`.
 *
 * The race: changing provider, search or a label filter all start a fresh `issues:list` call
 * while a previous one may still be in flight (a slow first page racing a fast second one, or
 * "load more" racing a filter change). `applied` is the sequence number of the newest load this
 * state has accepted anything from. `loadStarted` mints the new frontier from a `seq` the caller
 * owns (one ever-increasing counter, as in the other two modules); `pageArrived` and
 * `pageFailed` are refused — same state object back — unless their `seq` is still that frontier,
 * so an answer that lost the race against a newer load can never land.
 *
 * Two things that are NOT part of that race, by design:
 *  - `drafts` is keyed by issue, not by load, so it survives every provider switch, search edit
 *    and page fetch untouched — only an explicit edit (`editDraft`) or hand-off
 *    (`forgetIssueDraft`) ever changes it.
 *  - `selectedLabels` is the human's choice, not a fact about the current page. A page's own
 *    `facetLabels` can omit a label the human already picked (paging, or a search that narrows
 *    the result set) without that choice silently vanishing — `visibleFacetLabels` always shows
 *    the selected ones even when the latest page's facets do not mention them.
 */
import type { IssueProviderId, IssuePage, IssueQuery, IssueSummary } from '@tm/shared/issues';

export interface IssueBrowserState {
  provider: IssueProviderId | null;
  search: string;
  /** The human's label filter. Never pruned by a page answer — see the header note. */
  selectedLabels: readonly string[];
  /** The last page's own `labels` — every label seen across the scope, for the filter chips. */
  facetLabels: readonly string[];
  items: readonly IssueSummary[];
  nextCursor: string | null;
  selectedKey: string | null;
  loading: boolean;
  /** The provider's message verbatim, or null. F5.8 is the one that shows it. */
  error: string | null;
  /** The newest load sequence number this state has accepted anything from. */
  applied: number;
  /** `issueDraftKey(issue)` → the typed prompt, for issues the human has actually edited. */
  drafts: Readonly<Record<string, string>>;
}

export const EMPTY_ISSUE_BROWSER: IssueBrowserState = {
  provider: null,
  search: '',
  selectedLabels: [],
  facetLabels: [],
  items: [],
  nextCursor: null,
  selectedKey: null,
  loading: false,
  error: null,
  applied: 0,
  drafts: {},
};

/**
 * Switched to a different tracker, or to none. Resets everything about the previous provider's
 * query and list — search, label filter, facets, items, cursor and selection — but keeps
 * `drafts`, which belong to issues, not to a provider. A no-op (the same provider again) returns
 * the same object.
 */
export function selectProvider(
  s: IssueBrowserState,
  provider: IssueProviderId | null,
): IssueBrowserState {
  if (provider === s.provider) return s;
  return {
    ...s,
    provider,
    search: '',
    selectedLabels: [],
    facetLabels: [],
    items: [],
    nextCursor: null,
    selectedKey: null,
    error: null,
  };
}

/** The query text changed. Clears the list and selection; the caller starts a new load. */
export function setSearch(s: IssueBrowserState, search: string): IssueBrowserState {
  if (search === s.search) return s;
  return { ...s, search, items: [], nextCursor: null, selectedKey: null };
}

/** Adds `label` to the filter if absent, removes it if present. Clears the list and selection. */
export function toggleLabel(s: IssueBrowserState, label: string): IssueBrowserState {
  const selectedLabels = s.selectedLabels.includes(label)
    ? s.selectedLabels.filter((l) => l !== label)
    : [...s.selectedLabels, label];
  return { ...s, selectedLabels, items: [], nextCursor: null, selectedKey: null };
}

/** Replaces the whole label filter. Clears the list and selection. A no-op if unchanged. */
export function setLabels(s: IssueBrowserState, labels: readonly string[]): IssueBrowserState {
  const unchanged =
    labels.length === s.selectedLabels.length && labels.every((l, i) => l === s.selectedLabels[i]);
  if (unchanged) return s;
  return { ...s, selectedLabels: [...labels], items: [], nextCursor: null, selectedKey: null };
}

/**
 * The `issues:list` request this state would make — null when no provider is selected, since
 * there is then nothing to query. `cursor` is passed through as given (omit it for a first page).
 */
export function issueQueryFor(s: IssueBrowserState, cursor?: string | null): IssueQuery | null {
  if (s.provider === null) return null;
  return {
    provider: s.provider,
    search: s.search === '' ? null : s.search,
    labels: [...s.selectedLabels],
    cursor: cursor ?? null,
  };
}

/**
 * A load began. `seq` becomes the new frontier — only a `seq` older than what is already
 * applied is refused, which cannot happen through normal use since callers mint `seq` from one
 * ever-increasing counter. A first-page load (`append: false`) blanks `items` and `nextCursor`
 * so the new query starts from nothing; `append: true` ("load more") keeps them.
 */
export function loadStarted(
  s: IssueBrowserState,
  seq: number,
  options: { append: boolean },
): IssueBrowserState {
  if (seq < s.applied) return s;
  return {
    ...s,
    applied: seq,
    items: options.append ? s.items : [],
    nextCursor: options.append ? s.nextCursor : null,
    loading: true,
    error: null,
  };
}

function dedupeAppend(
  existing: readonly IssueSummary[],
  incoming: readonly IssueSummary[],
): IssueSummary[] {
  const seen = new Set(existing.map((item) => item.key));
  const added = incoming.filter((item) => !seen.has(item.key));
  return [...existing, ...added];
}

/**
 * A page answered. Ignored unless `seq` is still the frontier — an out-of-order answer (a
 * superseded load, or one that lost the race against a newer one) is dropped, returning the
 * same state object. Otherwise: `append: true` concatenates onto `items`, de-duped by key;
 * `append: false` replaces `items` outright. Either way `facetLabels` and `nextCursor` come from
 * this page. `selectedKey` is dropped only when a first page arrives and does not contain it —
 * an appended page can never un-select something, since it only ever adds to what is shown.
 */
export function pageArrived(
  s: IssueBrowserState,
  seq: number,
  page: IssuePage,
  options: { append: boolean },
): IssueBrowserState {
  if (seq !== s.applied) return s;
  const items = options.append ? dedupeAppend(s.items, page.items) : page.items;
  const selectedKey =
    !options.append &&
    s.selectedKey !== null &&
    !page.items.some((item) => item.key === s.selectedKey)
      ? null
      : s.selectedKey;
  return {
    ...s,
    items,
    facetLabels: page.labels,
    nextCursor: page.nextCursor,
    selectedKey,
    loading: false,
    error: null,
  };
}

/** A page failed. Same frontier guard as {@link pageArrived}; sets `error` to the message. */
export function pageFailed(s: IssueBrowserState, seq: number, message: string): IssueBrowserState {
  if (seq !== s.applied) return s;
  return { ...s, error: message, loading: false };
}

/** Selects an issue by key, or clears the selection with `null`. A no-op if unchanged. */
export function selectIssue(s: IssueBrowserState, key: string | null): IssueBrowserState {
  if (key === s.selectedKey) return s;
  return { ...s, selectedKey: key };
}

/**
 * `selectedLabels` ∪ `facetLabels`, selected ones first — so a label the human picked is always
 * shown as a chip, even on a page whose own facets do not mention it (see the header note).
 */
export function visibleFacetLabels(s: IssueBrowserState): readonly string[] {
  const result = [...s.selectedLabels];
  const seen = new Set(result);
  for (const label of s.facetLabels) {
    if (!seen.has(label)) {
      result.push(label);
      seen.add(label);
    }
  }
  return result;
}

/** The key a hand-off draft is parked under: the provider, then the issue's own key. */
export function issueDraftKey(issue: IssueSummary): string {
  return `${issue.provider}:${issue.key}`;
}

/** What an untouched hand-off prompt reads: the issue's key and link, never its body or title. */
export function prefillPrompt(issue: IssueSummary): string {
  return `${issue.key}\n${issue.url}`;
}

/** The prompt to show for `issue`: the parked draft if there is one, else the prefill. */
export function promptFor(s: IssueBrowserState, issue: IssueSummary): string {
  return s.drafts[issueDraftKey(issue)] ?? prefillPrompt(issue);
}

/**
 * The human edited the hand-off prompt for `issue`. Stores `text` as a draft — unless it is
 * exactly the untouched prefill, in which case any existing draft is removed instead: typing
 * and then reverting is "nothing typed", not a draft worth keeping. A no-op (nothing to change
 * either way) returns the same object.
 */
export function editDraft(
  s: IssueBrowserState,
  issue: IssueSummary,
  text: string,
): IssueBrowserState {
  const key = issueDraftKey(issue);
  const current = s.drafts[key];
  if (text === prefillPrompt(issue)) {
    if (current === undefined) return s;
    const drafts = { ...s.drafts };
    delete drafts[key];
    return { ...s, drafts };
  }
  if (current === text) return s;
  return { ...s, drafts: { ...s.drafts, [key]: text } };
}

/** Forgets the draft for `issue`, if any — after a hand-off, so it does not resurface later. */
export function forgetIssueDraft(s: IssueBrowserState, issue: IssueSummary): IssueBrowserState {
  const key = issueDraftKey(issue);
  if (!(key in s.drafts)) return s;
  const drafts = { ...s.drafts };
  delete drafts[key];
  return { ...s, drafts };
}

/**
 * Pure localStorage codec for `drafts`. Total: bad JSON, a non-object, an array, or any
 * non-string value all collapse to `{}` (or are dropped) rather than throwing, so the only
 * thing F5.8 needs to wrap in try/catch is the `localStorage` access itself.
 */
export function parseDrafts(raw: string | null): Readonly<Record<string, string>> {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

/** The inverse of {@link parseDrafts}. */
export function serializeDrafts(drafts: Readonly<Record<string, string>>): string {
  return JSON.stringify(drafts);
}
