/**
 * The size half of the F5.5 contract: an `issues:list` answer is a provider-shaped
 * `IssuePage`, and `clampIssuePage` (`packages/shared/src/issues.ts`) is what a provider
 * must run it through before handing it back. This proves that clamp is actually enough —
 * that the worst page it lets through still fits in one `/v1/sync` request's results half
 * (`boundCloudResults`, `apps/client/src/main/cloudResults.ts`) — rather than hoping the two
 * budgets, chosen for unrelated reasons years apart, happen to agree.
 */
import { describe, expect, it } from 'vitest';
import {
  ISSUE_FACET_LABEL_MAX_COUNT,
  ISSUE_FIELD_MAX_LENGTH,
  ISSUE_LABEL_MAX_COUNT,
  ISSUE_LABEL_MAX_LENGTH,
  ISSUE_TITLE_MAX_LENGTH,
  ISSUES_PAGE_SIZE,
  clampIssuePage,
  type IssuePage,
  type IssueSummary,
} from '@shared/issues';
import { RESULTS_BYTES_LIMIT, boundCloudResults, type PendingResultRow } from './cloudResults';

/**
 * The costliest character that survives `clampIssueSummary`'s clamp: every length bound
 * there counts UTF-16 code units (`.length`), but the wire cost is UTF-8 bytes once
 * `JSON.stringify` runs. A BMP CJK ideograph is one code unit and three UTF-8 bytes — worse
 * than `"` or `\`, which also survive the clamp's control-character strip but only escape to
 * two bytes (`\"`, `\\`), and worse than an astral character (a surrogate pair: two code
 * units, four bytes — 2 bytes/unit, not 3). Nothing that survives the clamp beats 3 bytes/unit.
 */
const WORST_CHAR = '中';

function worst(len: number): string {
  return WORST_CHAR.repeat(len);
}

function worstCaseSummary(): IssueSummary {
  return {
    provider: 'github',
    key: worst(ISSUE_FIELD_MAX_LENGTH),
    title: worst(ISSUE_TITLE_MAX_LENGTH),
    url: worst(ISSUE_FIELD_MAX_LENGTH),
    state: worst(ISSUE_FIELD_MAX_LENGTH),
    labels: Array.from({ length: ISSUE_LABEL_MAX_COUNT }, () => worst(ISSUE_LABEL_MAX_LENGTH)),
    type: worst(ISSUE_FIELD_MAX_LENGTH),
    assignee: worst(ISSUE_FIELD_MAX_LENGTH),
    updatedAt: 9_999_999_999_999,
    // Not part of clampIssueSummary's contract — main resolves this from the store's own
    // task id (a crypto.randomUUID()), fixed-size and never provider data — so a realistic
    // id is the worst case here, not an adversarial one.
    onBoardTaskId: '00000000-0000-4000-8000-000000000000',
  };
}

function worstCasePage(): IssuePage {
  return {
    items: Array.from({ length: ISSUES_PAGE_SIZE }, () => worstCaseSummary()),
    labels: Array.from({ length: ISSUE_FACET_LABEL_MAX_COUNT }, () =>
      worst(ISSUE_LABEL_MAX_LENGTH),
    ),
    nextCursor: null,
  };
}

describe('issues relay size', () => {
  it('fits a worst-case issues:list page under the relay cap with headroom', () => {
    const page = worstCasePage();

    // Confirms this really is the worst case the clamp allows through, not something past
    // its bounds that clampIssuePage would have shortened before it ever reached the relay.
    expect(clampIssuePage(page)).toEqual(page);

    const row: PendingResultRow = {
      commandId: 'cmd-issues-list',
      ok: true,
      reason: null,
      value: page,
    };
    const { results, oversized } = boundCloudResults([row]);

    expect(oversized).toEqual([]);
    expect(results).toHaveLength(1);

    const bytes = Buffer.byteLength(JSON.stringify(results[0]), 'utf8');
    // Half the limit, not all of it: so a later field added to IssueSummary or IssuePage
    // fails here first, rather than at the hard cap in production.
    expect(bytes).toBeLessThanOrEqual(RESULTS_BYTES_LIMIT / 2);
  });
});
