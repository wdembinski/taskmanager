import { describe, expect, it } from 'vitest';
import type { IssuePage, IssueSummary } from '@tm/shared/issues';
import {
  EMPTY_ISSUE_BROWSER,
  editDraft,
  forgetIssueDraft,
  isPromptUntouched,
  issueDraftKey,
  issueQueryFor,
  loadStarted,
  pageArrived,
  pageFailed,
  parseDrafts,
  prefillPrompt,
  promptFor,
  selectIssue,
  selectProvider,
  serializeDrafts,
  setLabels,
  setSearch,
  toggleLabel,
  visibleFacetLabels,
} from './issueBrowserState';

const issue = (key: string, overrides: Partial<IssueSummary> = {}): IssueSummary => ({
  provider: 'jira',
  key,
  title: `Title for ${key}`,
  url: `https://example.test/${key}`,
  state: 'Open',
  labels: [],
  updatedAt: 1,
  onBoardTaskId: null,
  ...overrides,
});

const page = (items: IssueSummary[], overrides: Partial<IssuePage> = {}): IssuePage => ({
  items,
  labels: [],
  nextCursor: null,
  ...overrides,
});

describe('loadStarted / pageArrived / pageFailed', () => {
  it('ignores an out-of-order page answer that arrives after a newer one', () => {
    let state = selectProvider(EMPTY_ISSUE_BROWSER, 'jira');
    state = loadStarted(state, 1, { append: false });
    state = loadStarted(state, 2, { append: false });
    state = pageArrived(state, 2, page([issue('A-2')]), { append: false });

    const stale = pageArrived(state, 1, page([issue('A-1')]), { append: false });

    expect(stale).toBe(state);
    expect(stale.items).toEqual([issue('A-2')]);
  });

  it('ignores a stale page failure the same way', () => {
    let state = selectProvider(EMPTY_ISSUE_BROWSER, 'jira');
    state = loadStarted(state, 1, { append: false });
    state = loadStarted(state, 2, { append: false });
    state = pageArrived(state, 2, page([issue('A-2')]), { append: false });

    const stale = pageFailed(state, 1, 'stale failure');

    expect(stale).toBe(state);
    expect(stale.error).toBeNull();
  });

  it('de-dupes an appended page against what is already loaded', () => {
    let state = selectProvider(EMPTY_ISSUE_BROWSER, 'jira');
    state = loadStarted(state, 1, { append: false });
    state = pageArrived(state, 1, page([issue('A-1'), issue('A-2')], { nextCursor: 'c1' }), {
      append: false,
    });
    state = loadStarted(state, 2, { append: true });

    const next = pageArrived(state, 2, page([issue('A-2'), issue('A-3')]), { append: true });

    expect(next.items.map((i) => i.key)).toEqual(['A-1', 'A-2', 'A-3']);
  });

  it('turns a failed load into an error and clears loading', () => {
    let state = selectProvider(EMPTY_ISSUE_BROWSER, 'jira');
    state = loadStarted(state, 1, { append: false });

    const failed = pageFailed(state, 1, 'rate limited');

    expect(failed.error).toBe('rate limited');
    expect(failed.loading).toBe(false);
  });
});

describe('selectProvider', () => {
  it('resets search, labels, list and selection but keeps drafts', () => {
    let state = selectProvider(EMPTY_ISSUE_BROWSER, 'jira');
    state = setSearch(state, 'bug');
    state = toggleLabel(state, 'urgent');
    state = loadStarted(state, 1, { append: false });
    state = pageArrived(state, 1, page([issue('A-1')], { labels: ['urgent'] }), {
      append: false,
    });
    state = selectIssue(state, 'A-1');
    state = editDraft(state, issue('A-1'), 'hand this off');

    const switched = selectProvider(state, 'github');

    expect(switched.provider).toBe('github');
    expect(switched.search).toBe('');
    expect(switched.selectedLabels).toEqual([]);
    expect(switched.facetLabels).toEqual([]);
    expect(switched.items).toEqual([]);
    expect(switched.selectedKey).toBeNull();
    expect(switched.drafts).toEqual({ [issueDraftKey(issue('A-1'))]: 'hand this off' });
  });

  it('is a no-op when selecting the already-active provider', () => {
    const state = selectProvider(EMPTY_ISSUE_BROWSER, 'jira');
    expect(selectProvider(state, 'jira')).toBe(state);
  });
});

describe('drafts', () => {
  it('reads the prefill before any edit, with no draft stored', () => {
    const state = EMPTY_ISSUE_BROWSER;
    const i = issue('A-1');

    expect(promptFor(state, i)).toBe(prefillPrompt(i));
    expect(state.drafts).toEqual({});
  });

  it('stores a draft once the human edits away from the prefill', () => {
    const i = issue('A-1');
    const edited = editDraft(EMPTY_ISSUE_BROWSER, i, 'please pick this up');

    expect(promptFor(edited, i)).toBe('please pick this up');
    expect(edited.drafts).toEqual({ [issueDraftKey(i)]: 'please pick this up' });
  });

  it('removes the draft when the edit reverts back to the prefill', () => {
    const i = issue('A-1');
    const edited = editDraft(EMPTY_ISSUE_BROWSER, i, 'please pick this up');
    const reverted = editDraft(edited, i, prefillPrompt(i));

    expect(reverted.drafts).toEqual({});
    expect(promptFor(reverted, i)).toBe(prefillPrompt(i));
  });

  it('never contains the issue title or body in the prefill', () => {
    const i = issue('A-1', { title: 'A secret title nobody should hand off' });

    expect(prefillPrompt(i)).toBe(`A-1\n${i.url}`);
    expect(prefillPrompt(i)).not.toContain(i.title);
  });

  it('isPromptUntouched is true for a fresh issue with no draft', () => {
    const i = issue('A-1');
    expect(isPromptUntouched(EMPTY_ISSUE_BROWSER, i)).toBe(true);
  });

  it('isPromptUntouched is false once the human edits the prompt', () => {
    const i = issue('A-1');
    const edited = editDraft(EMPTY_ISSUE_BROWSER, i, 'please pick this up');
    expect(isPromptUntouched(edited, i)).toBe(false);
  });

  it('isPromptUntouched is true again once an edit reverts back to the prefill', () => {
    const i = issue('A-1');
    const edited = editDraft(EMPTY_ISSUE_BROWSER, i, 'please pick this up');
    const reverted = editDraft(edited, i, prefillPrompt(i));
    expect(isPromptUntouched(reverted, i)).toBe(true);
  });

  it('forgets a draft after a hand-off', () => {
    const i = issue('A-1');
    const edited = editDraft(EMPTY_ISSUE_BROWSER, i, 'please pick this up');
    const forgotten = forgetIssueDraft(edited, i);

    expect(forgotten.drafts).toEqual({});
  });

  it('parseDrafts survives garbage input', () => {
    expect(parseDrafts(null)).toEqual({});
    expect(parseDrafts('not json')).toEqual({});
    expect(parseDrafts('null')).toEqual({});
    expect(parseDrafts('[]')).toEqual({});
    expect(parseDrafts('42')).toEqual({});
    expect(parseDrafts('{"a": 1, "b": "kept"}')).toEqual({ b: 'kept' });
  });

  it('round-trips through serializeDrafts', () => {
    const drafts = { 'jira:A-1': 'hello' };
    expect(parseDrafts(serializeDrafts(drafts))).toEqual(drafts);
  });
});

describe('visibleFacetLabels', () => {
  it('keeps a selected label even when the newest page omits it from its facets', () => {
    let state = selectProvider(EMPTY_ISSUE_BROWSER, 'jira');
    state = toggleLabel(state, 'urgent');
    state = loadStarted(state, 1, { append: false });
    state = pageArrived(state, 1, page([issue('A-1')], { labels: ['other'] }), {
      append: false,
    });

    expect(visibleFacetLabels(state)).toEqual(['urgent', 'other']);
  });
});

describe('issueQueryFor', () => {
  it('returns null when no provider is selected', () => {
    expect(issueQueryFor(EMPTY_ISSUE_BROWSER)).toBeNull();
  });

  it('builds the query from provider, search, labels and an explicit cursor', () => {
    let state = selectProvider(EMPTY_ISSUE_BROWSER, 'jira');
    state = setSearch(state, 'bug');
    state = toggleLabel(state, 'urgent');

    expect(issueQueryFor(state, 'cursor-1')).toEqual({
      provider: 'jira',
      search: 'bug',
      labels: ['urgent'],
      cursor: 'cursor-1',
    });
    expect(issueQueryFor(state)).toMatchObject({ cursor: null });
  });
});

describe('setSearch / toggleLabel / setLabels', () => {
  it('clears the list and selection on a search change', () => {
    let state = selectProvider(EMPTY_ISSUE_BROWSER, 'jira');
    state = loadStarted(state, 1, { append: false });
    state = pageArrived(state, 1, page([issue('A-1')]), { append: false });
    state = selectIssue(state, 'A-1');

    const next = setSearch(state, 'bug');

    expect(next.items).toEqual([]);
    expect(next.selectedKey).toBeNull();
  });

  it('is a no-op when the search text is unchanged', () => {
    const state = setSearch(EMPTY_ISSUE_BROWSER, 'bug');
    expect(setSearch(state, 'bug')).toBe(state);
  });

  it('is a no-op when setLabels is given the same labels', () => {
    const state = setLabels(EMPTY_ISSUE_BROWSER, ['urgent']);
    expect(setLabels(state, ['urgent'])).toBe(state);
  });

  it('toggleLabel adds then removes a label', () => {
    const added = toggleLabel(EMPTY_ISSUE_BROWSER, 'urgent');
    expect(added.selectedLabels).toEqual(['urgent']);

    const removed = toggleLabel(added, 'urgent');
    expect(removed.selectedLabels).toEqual([]);
  });
});

describe('selectIssue', () => {
  it('is a no-op when selecting the already-selected key', () => {
    const state = selectIssue(EMPTY_ISSUE_BROWSER, 'A-1');
    expect(selectIssue(state, 'A-1')).toBe(state);
  });

  it('drops the selection only on a first page that lacks it', () => {
    let state = selectProvider(EMPTY_ISSUE_BROWSER, 'jira');
    state = loadStarted(state, 1, { append: false });
    state = pageArrived(state, 1, page([issue('A-1')]), { append: false });
    state = selectIssue(state, 'A-1');

    state = loadStarted(state, 2, { append: false });
    const replaced = pageArrived(state, 2, page([issue('A-2')]), { append: false });
    expect(replaced.selectedKey).toBeNull();
  });

  it('keeps the selection across an appended page that lacks it', () => {
    let state = selectProvider(EMPTY_ISSUE_BROWSER, 'jira');
    state = loadStarted(state, 1, { append: false });
    state = pageArrived(state, 1, page([issue('A-1')]), { append: false });
    state = selectIssue(state, 'A-1');

    state = loadStarted(state, 2, { append: true });
    const appended = pageArrived(state, 2, page([issue('A-2')]), { append: true });
    expect(appended.selectedKey).toBe('A-1');
  });
});
