import { describe, expect, it } from 'vitest';
import {
  clampIssuePage,
  clampIssueSummary,
  ISSUE_FACET_LABEL_MAX_COUNT,
  ISSUE_FIELD_MAX_LENGTH,
  ISSUE_LABEL_MAX_COUNT,
  ISSUE_LABEL_MAX_LENGTH,
  ISSUE_TITLE_MAX_LENGTH,
  ISSUES_PAGE_SIZE,
  type IssuePage,
  type IssueSummary,
} from './issues';

function makeSummary(overrides: Partial<IssueSummary> = {}): IssueSummary {
  return {
    provider: 'jira',
    key: 'PROJ-1',
    title: 'A perfectly ordinary title',
    url: 'https://example.atlassian.net/browse/PROJ-1',
    state: 'In Progress',
    labels: ['backend'],
    type: 'Bug',
    assignee: 'Ada Lovelace',
    updatedAt: 1000,
    onBoardTaskId: null,
    ...overrides,
  };
}

describe('clampIssueSummary', () => {
  it('leaves an in-bounds summary unchanged', () => {
    const summary = makeSummary();
    expect(clampIssueSummary(summary)).toEqual(summary);
  });

  it('truncates the title to ISSUE_TITLE_MAX_LENGTH', () => {
    const summary = makeSummary({ title: 'x'.repeat(ISSUE_TITLE_MAX_LENGTH + 50) });
    const clamped = clampIssueSummary(summary);
    expect(clamped.title).toHaveLength(ISSUE_TITLE_MAX_LENGTH);
  });

  it('truncates key, url and state to ISSUE_FIELD_MAX_LENGTH', () => {
    const summary = makeSummary({
      key: 'k'.repeat(ISSUE_FIELD_MAX_LENGTH + 10),
      url: 'u'.repeat(ISSUE_FIELD_MAX_LENGTH + 10),
      state: 's'.repeat(ISSUE_FIELD_MAX_LENGTH + 10),
    });
    const clamped = clampIssueSummary(summary);
    expect(clamped.key).toHaveLength(ISSUE_FIELD_MAX_LENGTH);
    expect(clamped.url).toHaveLength(ISSUE_FIELD_MAX_LENGTH);
    expect(clamped.state).toHaveLength(ISSUE_FIELD_MAX_LENGTH);
  });

  it('truncates type and assignee to ISSUE_FIELD_MAX_LENGTH, leaving null/undefined alone', () => {
    const summary = makeSummary({
      type: 't'.repeat(ISSUE_FIELD_MAX_LENGTH + 10),
      assignee: 'a'.repeat(ISSUE_FIELD_MAX_LENGTH + 10),
    });
    const clamped = clampIssueSummary(summary);
    expect(clamped.type).toHaveLength(ISSUE_FIELD_MAX_LENGTH);
    expect(clamped.assignee).toHaveLength(ISSUE_FIELD_MAX_LENGTH);

    const nullish = makeSummary({ type: null, assignee: undefined });
    const clampedNullish = clampIssueSummary(nullish);
    expect(clampedNullish.type).toBeNull();
    expect(clampedNullish.assignee).toBeUndefined();
  });

  it('caps the label count at ISSUE_LABEL_MAX_COUNT and each label at ISSUE_LABEL_MAX_LENGTH', () => {
    const summary = makeSummary({
      labels: Array.from({ length: ISSUE_LABEL_MAX_COUNT + 5 }, (_, i) =>
        `label-${i}-`.padEnd(ISSUE_LABEL_MAX_LENGTH + 10, 'x'),
      ),
    });
    const clamped = clampIssueSummary(summary);
    expect(clamped.labels).toHaveLength(ISSUE_LABEL_MAX_COUNT);
    for (const label of clamped.labels) {
      expect(label.length).toBeLessThanOrEqual(ISSUE_LABEL_MAX_LENGTH);
    }
  });

  it('never splits a surrogate pair at the cut point', () => {
    // U+1F600 (😀) is a surrogate pair — two UTF-16 code units. Land the cut right between
    // them and the clamp must drop the whole character rather than leaving a lone surrogate.
    const emoji = '\u{1F600}';
    const title = 'x'.repeat(ISSUE_TITLE_MAX_LENGTH - 1) + emoji;
    const clamped = clampIssueSummary(makeSummary({ title }));
    expect(clamped.title).toHaveLength(ISSUE_TITLE_MAX_LENGTH - 1);
    expect(clamped.title.endsWith('x')).toBe(true);
    // No lone high surrogate left dangling at the end.
    const lastCode = clamped.title.charCodeAt(clamped.title.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
  });

  it('strips C0 control characters from every field', () => {
    const summary = makeSummary({
      title: 'before\u0001after',
      key: 'PROJ\u0007-1',
      state: 'In\u0000Progress',
    });
    const clamped = clampIssueSummary(summary);
    expect(clamped.title).toBe('beforeafter');
    expect(clamped.key).toBe('PROJ-1');
    expect(clamped.state).toBe('InProgress');
  });
});

describe('clampIssuePage', () => {
  function makePage(overrides: Partial<IssuePage> = {}): IssuePage {
    return {
      items: [makeSummary()],
      labels: ['backend', 'frontend'],
      nextCursor: null,
      ...overrides,
    };
  }

  it('leaves an in-bounds page unchanged', () => {
    const page = makePage();
    expect(clampIssuePage(page)).toEqual(page);
  });

  it('caps items at ISSUES_PAGE_SIZE', () => {
    const page = makePage({
      items: Array.from({ length: ISSUES_PAGE_SIZE + 10 }, (_, i) =>
        makeSummary({ key: `PROJ-${i}` }),
      ),
    });
    expect(clampIssuePage(page).items).toHaveLength(ISSUES_PAGE_SIZE);
  });

  it('caps the facet labels at ISSUE_FACET_LABEL_MAX_COUNT', () => {
    const page = makePage({
      labels: Array.from({ length: ISSUE_FACET_LABEL_MAX_COUNT + 20 }, (_, i) => `label-${i}`),
    });
    expect(clampIssuePage(page).labels).toHaveLength(ISSUE_FACET_LABEL_MAX_COUNT);
  });

  it('clamps every item it carries', () => {
    const page = makePage({
      items: [makeSummary({ title: 'x'.repeat(ISSUE_TITLE_MAX_LENGTH + 1) })],
    });
    expect(clampIssuePage(page).items[0].title).toHaveLength(ISSUE_TITLE_MAX_LENGTH);
  });
});
