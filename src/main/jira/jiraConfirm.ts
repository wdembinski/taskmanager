/**
 * The two network passes that stand between a card going missing from a search and that
 * card leaving the board.
 *
 * `jiraSync.ts` decides fates; `jiraJql.ts` composes the strings; this asks the questions.
 * Both passes here answer in the same shape — a set of keys that were **asked and
 * answered**, alongside what came back — because that pairing is the whole point. The
 * reconciler's rule is that no card leaves the board unless JIRA was asked about it by key
 * and answered, and a bare list of issues cannot tell it which keys the question actually
 * covered. A batch that 400s and a batch that legitimately matched nothing produce the same
 * empty answer, and reading the second as the first is how a board loses forty-nine cards
 * because of a fiftieth.
 *
 * Hence the rule every batch here obeys: **each batch stands alone.** `key in (…)` is a
 * single query, and JIRA fails the whole of it if one key names an issue this token cannot
 * see — a ticket someone deleted, a project whose permissions changed. One dead ticket must
 * not make the answer unknowable for the forty-nine batched with it, so a batch that throws,
 * or comes back truncated, contributes to *neither* set and leaves its cards untouched.
 *
 * Written against an injected {@link IssueSearcher} rather than a `JiraClient` — the
 * `discoverSprintFieldId` pattern — so the batching, the composition and the failure
 * discipline are all testable against a fake that counts calls.
 */
import type { JiraIssue, JiraSearchResult } from './jiraClient';
import { chunkKeys, isIssueKey, keysInJql, withKeysIn } from './jiraJql';

/**
 * The slice of `JiraClient` these passes use. Deliberately one method: everything else a
 * client can do is irrelevant here, and a narrower dependency is a fake you can write in
 * four lines rather than a mock of the whole API surface.
 */
export interface IssueSearcher {
  searchAll(
    jql: string,
    opts?: { limit?: number; extraFields?: readonly string[] },
  ): Promise<JiraSearchResult>;
}

/**
 * Keys per request. JQL travels in a URL, and a `key in (…)` of several hundred keys finds
 * the instance's URL limit — see `chunkKeys`. Fifty is comfortably inside every limit we
 * know of, and small enough that losing one batch costs little.
 */
export const CONFIRM_BATCH_SIZE = 50;

export interface JiraConfirmOptions {
  /** Per-instance custom fields to request (epic link, sprint), as the sync passes them. */
  extraFields?: readonly string[];
  /** Keys per request. Defaults to {@link CONFIRM_BATCH_SIZE}. */
  batchSize?: number;
  /**
   * A batch's request threw. Reported rather than swallowed: a confirm pass that quietly
   * fails looks exactly like a board where nothing has left the query, and the keys are
   * what make the next occurrence diagnosable from the log alone.
   */
  onBatchFailed?: (keys: readonly string[], error: unknown) => void;
  /** A batch came back short of the whole answer, so it was discarded. Same reason. */
  onBatchTruncated?: (keys: readonly string[]) => void;
}

/** What {@link confirmStillMatching} learned: who was asked, and who JIRA still returns. */
export interface JiraConfirmResult {
  /** The keys JIRA was asked about and answered for. A key missing from here is unknown. */
  checked: Set<string>;
  /**
   * The subset of {@link checked} the query still returns — cards the paged search left out
   * of its answer while the question itself still matches them. Paging artifacts, and the
   * thing that was eating the board.
   */
  matching: Set<string>;
}

/** What {@link recheckByKey} learned: who was asked, and the issues that came back. */
export interface JiraRecheckResult {
  checked: Set<string>;
  issues: JiraIssue[];
}

/**
 * Run one question over a key list in batches, handing each batch's issues to `take`.
 *
 * Validation happens once, up front: a stored value that is not shaped like an issue key
 * never reaches a JQL string (see `isIssueKey`), and — this is the part that matters — never
 * reaches `checked` either. It was not asked about, so nothing may be concluded from its
 * absence. Duplicates go the same way, so a batch of fifty is fifty distinct questions.
 */
async function askInBatches(
  client: IssueSearcher,
  keys: readonly string[],
  buildJql: (batch: string[]) => string,
  opts: JiraConfirmOptions,
  take: (batch: string[], issues: JiraIssue[]) => void,
): Promise<Set<string>> {
  const checked = new Set<string>();
  const valid = [...new Set(keys.filter(isIssueKey).map((k) => k.trim()))];
  for (const batch of chunkKeys(valid, opts.batchSize ?? CONFIRM_BATCH_SIZE)) {
    const jql = buildJql(batch);
    // Empty means no key survived composition. Never run the bare filter: it would match
    // the whole board and answer a question about cards nobody asked about.
    if (!jql) continue;
    try {
      const result = await client.searchAll(jql, {
        // One more than the batch, deliberately. `key in (…)` cannot return more issues
        // than it names, so the headroom is never used to hold results — it exists so a
        // full batch does not stop ON the limit, which `searchAll` reads as "there may be
        // more" and reports as truncation. A batch where all fifty keys still match is the
        // ordinary case, and it must not be the case that always comes back unusable.
        limit: batch.length + 1,
        extraFields: opts.extraFields,
      });
      // A short answer is not an answer. Each batch stands alone, so this one simply goes
      // unasked and its cards keep whatever the reconciler does with an unasked key: stay.
      if (result.truncated) {
        opts.onBatchTruncated?.(batch);
        continue;
      }
      for (const key of batch) checked.add(key);
      take(batch, result.issues);
    } catch (e) {
      opts.onBatchFailed?.(batch, e);
    }
  }
  return checked;
}

/**
 * Ask JIRA which of these cards its **effective** query still returns.
 *
 * The board's own query, intersected with a bounded list of keys — `(<the query>) AND key in
 * (…)`, see `withKeysIn`. Asking the query and seeing what comes back cannot distinguish
 * "this ticket no longer matches" from "this page was short"; asking about a specific,
 * board-sized set of keys has an answer that can be trusted in the negative.
 *
 * "Effective" is not a nicety: the query the sync actually ran is the one with
 * `openSprints()` folded in when the board is filtered to the current sprint. Confirming
 * against the *raw* JQL would keep every card the sprint filter is meant to hide.
 *
 * An issue JIRA affirms here is a **paging artifact** — the search left it out, the query
 * still has it — and must be kept.
 */
export async function confirmStillMatching(
  client: IssueSearcher,
  jql: string,
  keys: readonly string[],
  opts: JiraConfirmOptions = {},
): Promise<JiraConfirmResult> {
  const matching = new Set<string>();
  const checked = await askInBatches(
    client,
    keys,
    (batch) => withKeysIn(jql, batch),
    opts,
    (batch, issues) => {
      // Answer in the CALLER's spelling. `checked` holds the keys we sent and `matching`
      // would otherwise hold the keys JIRA sent back, and the reconciler tests one against
      // the other — a card stored as `abc-1` against an issue returned as `ABC-1` would read
      // as "asked, and JIRA says no", which is grounds for removal. Keys are canonical in
      // practice; this makes it not matter.
      const bySpelling = new Map(batch.map((k) => [k.toUpperCase(), k]));
      for (const issue of issues) {
        matching.add(bySpelling.get(issue.key.toUpperCase()) ?? issue.key);
      }
    },
  );
  return { checked, matching };
}

/**
 * Re-read a set of issues **by key alone**, ignoring the board's query entirely.
 *
 * This is the pass behind retained cards. A finished card is kept past the query it fell out
 * of, and the query will very likely never mention it again — `resolution = Unresolved` does
 * not match a ticket whose resolution was never cleared on the way back out of Done — so
 * asking by key is the only way that card can follow its ticket into another column, or
 * learn that the ticket is gone.
 */
export async function recheckByKey(
  client: IssueSearcher,
  keys: readonly string[],
  opts: JiraConfirmOptions = {},
): Promise<JiraRecheckResult> {
  const issues: JiraIssue[] = [];
  const checked = await askInBatches(
    client,
    keys,
    (batch) => keysInJql(batch),
    opts,
    (_batch, found) => issues.push(...found),
  );
  return { checked, issues };
}
