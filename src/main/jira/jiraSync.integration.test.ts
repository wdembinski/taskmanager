/**
 * The regression the user was actually bitten by, wired end to end: **a 300-card board
 * survives a sync**.
 *
 * Every piece of this was already unit-tested in isolation — `searchAll` pages
 * (`jiraClient.test.ts`), the by-key passes batch and stand alone (`jiraConfirm.test.ts`),
 * the reconciler names a question behind every fate (`jiraSync.test.ts`) — and the board
 * still lost two hundred cards, because the defect lived in the *seam*: a search that
 * stopped at a hundred handed the reconciler ninety-nine per cent of a plausible answer,
 * and nothing downstream could tell. So this file asserts the pipeline, not the parts. It
 * is the same sequence `ipc.ts`'s `syncJira` runs, in the same order, over the same three
 * hundred issues:
 *
 *     fetch (mocked, paged)  →  searchAll  →  retainedKeys / removalCandidateKeys
 *                            →  recheckByKey / confirmStillMatching  →  reconcileJiraTasks
 *
 * No Electron and no SQLite: the store round trip — archived by a sync, invisible to
 * `board:tasks`, restored under the same id with its steps, timeline and files still
 * attached — is a claim about a real database and is proved in
 * `scripts/verify-jira-archive.mjs`. What is proved *here* is the decision.
 *
 * **Every scenario below also proves it can fail.** A green test that would stay green with
 * the fix reverted is worse than no test, so each one is paired with the same board run
 * through the pre-fix code path — the limit pinned back to 100, the truncation flag ignored,
 * the guard removed — and asserts the ~200 removals that path produces. That contrast is the
 * point; the passing half on its own would be decoration.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JIRA_BOARD_LIMIT } from '@shared/board';
import { PERSONAL_PROJECT_ID, type Task, type TaskStatus } from '@shared/model';
import { JiraClient, type JiraIssue, type JiraSearchResult } from './jiraClient';
import { confirmStillMatching, recheckByKey, type IssueSearcher } from './jiraConfirm';
import {
  reconcileJiraTasks,
  removalCandidateKeys,
  retainedKeys,
  type JiraSyncOptions,
  type JiraSyncResult,
} from './jiraSync';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The instance

/** The board's effective query — the commonest one there is, and the one that bit us. */
const JQL = 'assignee = currentUser() AND resolution = Unresolved';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** How many cards are on this board. The number the user had, and the number that vanished. */
const BOARD_SIZE = 300;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const key = (n: number): string => `BOARD-${n}`;

const issueFor = (n: number, statusCategory = 'new'): JiraIssue => ({
  id: String(n),
  key: key(n),
  fields: {
    summary: `Card for ${key(n)}`,
    status: {
      name: statusCategory === 'done' ? 'Closed' : 'To Do',
      statusCategory: { key: statusCategory, name: 'X' },
    },
    priority: { name: 'Medium' },
    project: { key: 'BOARD', name: 'The Board' },
  },
});

/**
 * A card already on the board. Its id is deliberately NOT `jira-<id>`: every assertion that
 * a card kept its identity across a sync would pass by accident if the reconciler's
 * fallback id happened to match the one it was meant to preserve.
 */
const cardFor = (n: number, over: Partial<Task> = {}): Task => ({
  id: `card-${key(n)}`,
  projectId: PERSONAL_PROJECT_ID,
  phase: 'The Board',
  title: `Card for ${key(n)}`,
  status: 'pending' as TaskStatus,
  sessionId: null,
  order: n,
  dependsOn: [],
  source: 'jira',
  isContract: false,
  isScaffold: false,
  externalSource: 'jira',
  externalKey: key(n),
  externalId: String(n),
  archivedAt: null,
  retainedSince: null,
  ...over,
});

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * A JIRA Server/DC instance that pages properly: it honours `startAt`, never returns more
 * than `maxResults`, and reports a truthful `total`.
 *
 * Deliberately a *well-behaved* server. The board did not lose two hundred cards because
 * JIRA misbehaved — it lost them because we asked for a hundred and read the answer as the
 * whole truth. Give the mock a flaw and the test would be about the flaw.
 */
function pagedInstance(issues: readonly JiraIssue[], serverPageCap = 100) {
  const pages: Array<{ startAt: number; maxResults: number }> = [];
  const fetchMock = vi.fn(async (url: string) => {
    const params = new URL(url).searchParams;
    const startAt = Number(params.get('startAt') ?? '0');
    const maxResults = Number(params.get('maxResults') ?? '100');
    pages.push({ startAt, maxResults });
    // Instances cap the page below what you ask for (`jira.search.views.default.max`), so
    // the server's own cap wins — the case that makes `startAt` advance by what came back.
    const size = Math.min(maxResults, serverPageCap);
    return jsonResponse({
      startAt,
      maxResults: size,
      total: issues.length,
      issues: issues.slice(startAt, startAt + size),
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { pages };
}

const client = (): JiraClient =>
  new JiraClient({
    baseUrl: 'https://jira.company.com',
    apiVersion: '2',
    auth: { mode: 'bearer', token: 'pat' },
  });

// ---------------------------------------------------------------------------
// The by-key passes' instance, as a fake searcher (the `jiraConfirm.test.ts` shape)

/** The keys named by a composed `key in (...)` clause. */
const keysOf = (jql: string): string[] =>
  /key in \(([^)]*)\)/
    .exec(jql)?.[1]
    .split(',')
    .map((k) => k.trim()) ?? [];

type BatchAnswer = (asked: string[], jql: string) => JiraSearchResult;

/** Everything asked about still exists / still matches. */
const affirmsAll: BatchAnswer = (asked) => ({
  issues: asked.map((k) => issueFor(Number(k.split('-')[1]))),
  truncated: false,
});

/** JIRA answered, and has none of them — the only honest grounds for a removal. */
const deniesAll: BatchAnswer = () => ({ issues: [], truncated: false });

/** The batch came back short, so it answered nothing at all. */
const truncatesAll: BatchAnswer = () => ({ issues: [], truncated: true });

function fakeSearcher(answer: BatchAnswer): IssueSearcher & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    searchAll: (jql: string) => {
      const batch = keysOf(jql);
      asked.push(batch);
      return Promise.resolve(answer(batch, jql));
    },
  };
}

// ---------------------------------------------------------------------------
// The pipeline itself

interface SyncRun extends JiraSyncResult {
  /** What the paged search actually returned, and whether it reached the end. */
  issues: JiraIssue[];
  truncated: boolean;
  /** The two key lists the passes were built from — the sync's own view of what is missing. */
  retained: string[];
  candidates: string[];
  /** Keys whose batch was reported unusable, per pass. */
  truncatedBatches: string[];
  failedBatches: string[];
}

/**
 * One sync, exactly as `ipc.ts`'s `syncJira` runs it.
 *
 * A transcription rather than a call, because `syncJira` is a closure inside `registerIpc`
 * and reaching it would mean an Electron `ipcMain`, a real store and a settings row — all of
 * which this is not about. The risk that comes with a transcription is drift, so this is
 * kept in the same ORDER and with the same arguments as the original, and the one thing that
 * would matter if it drifted (whether the confirm pass runs at all on a truncated fetch) is
 * asserted below rather than assumed.
 */
async function sync(params: {
  existing: Task[];
  searcher: IssueSearcher;
  /** Pinned back to 100 by the scenario that reconstructs the defect. */
  limit?: number;
  jql?: string;
  reconcile?: Partial<JiraSyncOptions>;
}): Promise<SyncRun> {
  const jql = params.jql ?? JQL;
  const truncatedBatches: string[] = [];
  const failedBatches: string[] = [];
  const log = {
    onBatchTruncated: (batch: readonly string[]) => truncatedBatches.push(...batch),
    onBatchFailed: (batch: readonly string[]) => failedBatches.push(...batch),
  };

  const { issues, truncated } = await client().searchAll(jql, {
    limit: params.limit ?? JIRA_BOARD_LIMIT,
  });

  const retained = retainedKeys(params.existing, issues);
  const { checked: recheckedKeys, issues: rechecked } = await recheckByKey(
    params.searcher,
    retained,
    log,
  );

  const candidates = removalCandidateKeys(params.existing, issues);
  const confirmed =
    candidates.length > 0 && !truncated
      ? await confirmStillMatching(params.searcher, jql, candidates, log)
      : null;

  const result = reconcileJiraTasks(params.existing, issues, {
    baseUrl: 'https://jira.company.com',
    rechecked,
    recheckedKeys,
    queryChecked: confirmed?.checked ?? null,
    queryMatches: confirmed?.matching ?? null,
    truncated,
    now: NOW,
    ...params.reconcile,
  });

  return { ...result, issues, truncated, retained, candidates, truncatedBatches, failedBatches };
}

/**
 * The reconciler as it behaved BEFORE any of this: absence from the search is a verdict.
 *
 * Nothing here is the current code path — `truncated` is forced off, every missing key is
 * declared asked-and-denied, and the removal guard is disabled with a fraction of 1. That is
 * precisely the point. It is how each scenario proves it is load-bearing: run the same board
 * and the same mocked instance through the old semantics and count the cards that would have
 * gone. If a scenario's "nothing was removed" ever stops meaning anything, this half turns
 * red with it.
 */
function asPreFixCode(existing: Task[], issues: JiraIssue[]): JiraSyncResult {
  const missing = removalCandidateKeys(existing, issues);
  return reconcileJiraTasks(existing, issues, {
    baseUrl: 'https://jira.company.com',
    truncated: false,
    queryChecked: missing,
    queryMatches: [],
    maxRemovalFraction: 1,
    now: NOW,
  });
}

// ---------------------------------------------------------------------------

describe('a 300-card board survives a sync', () => {
  const issues = range(1, BOARD_SIZE).map((n) => issueFor(n));
  const board = range(1, BOARD_SIZE).map((n) => cardFor(n));

  it('pages the whole query and removes nothing', async () => {
    const { pages } = pagedInstance(issues);
    const run = await sync({ existing: board, searcher: fakeSearcher(affirmsAll) });

    // The search really did page — three requests walking the offset, not one lucky answer.
    expect(pages.map((p) => p.startAt)).toEqual([0, 100, 200]);
    expect(run.issues).toHaveLength(BOARD_SIZE);
    expect(run.truncated).toBe(false);

    expect(run.removals).toEqual([]);
    expect(run.refused).toEqual([]);
    expect(run.upserts).toHaveLength(BOARD_SIZE);
    expect(run.warning).toBeNull();
  });

  it('leaves every card on its own row — same id, same order, nothing re-created', async () => {
    pagedInstance(issues);
    const run = await sync({ existing: board, searcher: fakeSearcher(affirmsAll) });

    expect(run.upserts.map((t) => t.id)).toEqual(board.map((t) => t.id));
    expect(run.upserts.every((t) => t.externalUrl?.startsWith('https://jira.company.com/browse/')));
    expect(run.restoreIds).toEqual([]);
  });

  it('costs nothing extra: a whole answer asks no by-key questions at all', async () => {
    pagedInstance(issues);
    const searcher = fakeSearcher(affirmsAll);
    const run = await sync({ existing: board, searcher });

    // The confirm pass is only ever paid for by cards the search failed to return, and a
    // healthy board produces none. A version of this that cost 6 requests per poll on a
    // healthy board would be reverted, so the zero is part of the feature.
    expect(run.retained).toEqual([]);
    expect(run.candidates).toEqual([]);
    expect(searcher.asked).toEqual([]);
  });

  // ---- and now prove it could have failed -------------------------------------------------

  it('with the limit pinned back to 100, the old code path would have removed 200', async () => {
    pagedInstance(issues);
    const run = await sync({ existing: board, searcher: fakeSearcher(affirmsAll), limit: 100 });

    // The defect, in two lines: a hundred issues came back, and two hundred cards are now
    // missing from the answer. This is the exact input the pre-fix reconciler acted on.
    expect(run.issues).toHaveLength(100);
    expect(run.candidates).toHaveLength(200);

    const preFix = asPreFixCode(board, run.issues);
    expect(preFix.removals).toHaveLength(200);
    expect(preFix.removals.map((r) => r.reason)).toEqual(Array(200).fill('left-query'));
    expect(preFix.removals[0].key).toBe(key(101));
  });

  it('the current code path removes none of those 200, and says why', async () => {
    pagedInstance(issues);
    const searcher = fakeSearcher(affirmsAll);
    const run = await sync({ existing: board, searcher, limit: 100 });

    // The limit is still pinned at 100 — the fix is not that we ask for more, it is that a
    // search which stopped short is not evidence that anything left.
    expect(run.truncated).toBe(true);
    expect(run.removals).toEqual([]);
    expect(run.refused).toEqual([]);
    expect(run.warning).toContain('did not return the whole query');
    // And the confirm pass is skipped outright: the reconciler removes nothing on a short
    // answer anyway, so 4 requests asking about 200 keys would be bought and thrown away.
    expect(searcher.asked).toEqual([]);
  });

  it('and keeps them even when the short answer does NOT admit to being short', async () => {
    // The nastier shape of the same bug, and the one `truncated` alone cannot catch: a proxy
    // or an instance that answers with a hundred issues and a `total` of a hundred. Nothing
    // in the response is a lie the client can detect — so the cards are kept because JIRA was
    // asked about them BY KEY and said the query still returns them.
    pagedInstance(issues.slice(0, 100));
    const searcher = fakeSearcher(affirmsAll);
    const run = await sync({ existing: board, searcher });

    expect(run.truncated).toBe(false);
    expect(run.candidates).toHaveLength(200);
    expect(searcher.asked.map((b) => b.length)).toEqual([50, 50, 50, 50]);
    expect(run.removals).toEqual([]);
    expect(run.refused).toEqual([]);
    expect(run.warning).toContain('200 cards missing from the search still match the query');

    // Same instance, same board, old semantics: two hundred cards gone.
    expect(asPreFixCode(board, run.issues).removals).toHaveLength(200);
  });

  it('a confirm batch that 400s costs its fifty cards nothing', async () => {
    // The confirm pass has the same failure mode as the re-read, and it is worth its own
    // scenario because the consequence is worse: these are cards nothing else is keeping. One
    // deleted ticket fails the whole `key in (…)` it was batched into, and if a batch that
    // errored read as "JIRA says none of these match", one dead ticket would cost forty-nine
    // live cards. Sixty are missing here, in batches of 50 and 10; the first batch throws.
    pagedInstance(issues.slice(0, 240));
    let batch = 0;
    const searcher = fakeSearcher(() => {
      if (batch++ === 0) throw new Error('JIRA 400: An issue with key BOARD-250 does not exist');
      return { issues: [], truncated: false };
    });
    const run = await sync({ existing: board, searcher });

    expect(run.truncated).toBe(false);
    expect(run.candidates).toHaveLength(60);
    expect(run.failedBatches).toHaveLength(50);
    // Only the batch that answered may take cards off the board.
    expect(run.removals.map((r) => r.key)).toEqual(range(291, 300).map(key));
    expect(run.removals.map((r) => r.reason)).toEqual(Array(10).fill('left-query'));
    expect(run.refused).toEqual([]);

    // Old semantics, same instance: all sixty, including the fifty nobody got an answer for.
    expect(asPreFixCode(board, run.issues).removals).toHaveLength(60);
  });

  it('and still lets an honest removal through — the guard is not a blanket "never"', async () => {
    // Three cards genuinely closed out of a 300-card board. Confirmed by key, denied by JIRA,
    // well under the guard's share: they go. A fix that kept everything forever would pass
    // every test above and be useless.
    const remaining = issues.filter((i) => !['BOARD-7', 'BOARD-8', 'BOARD-9'].includes(i.key));
    pagedInstance(remaining);
    const run = await sync({ existing: board, searcher: fakeSearcher(deniesAll) });

    expect(run.truncated).toBe(false);
    expect(run.removals.map((r) => r.key)).toEqual(['BOARD-7', 'BOARD-8', 'BOARD-9']);
    expect(run.removals.map((r) => r.reason)).toEqual(Array(3).fill('left-query'));
    expect(run.refused).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('a truncated re-read takes nothing off the board', () => {
  /**
   * The board as it looks a fortnight in: 240 cards the query returns, and 60 finished ones
   * it stopped matching the moment they were resolved. Those 60 are RETAINED — kept past the
   * query on their own clock — and followed by key, which is the pass this describes.
   */
  const live = range(1, 240).map((n) => cardFor(n));
  const finished = range(241, BOARD_SIZE).map((n) =>
    cardFor(n, { status: 'done', retainedSince: NOW - DAY }),
  );
  const board = [...live, ...finished];
  const issues = range(1, 240).map((n) => issueFor(n));
  /** A week, so the retention clock is nowhere near expiry and the re-read is what decides. */
  const RETENTION = { retentionMs: 7 * DAY };

  it('the re-read is what is being asked, and it covers exactly the finished cards', async () => {
    pagedInstance(issues);
    const searcher = fakeSearcher(affirmsAll);
    const run = await sync({ existing: board, searcher, reconcile: RETENTION });

    expect(run.truncated).toBe(false);
    expect(run.retained).toEqual(finished.map((t) => t.externalKey));
    // Nothing else is missing, so the confirm pass has nothing to ask about.
    expect(run.candidates).toEqual([]);
    expect(searcher.asked.map((b) => b.length)).toEqual([50, 10]);
  });

  it('every batch short: nothing is removed', async () => {
    pagedInstance(issues);
    const searcher = fakeSearcher(truncatesAll);
    const run = await sync({ existing: board, searcher, reconcile: RETENTION });

    expect(run.truncatedBatches).toHaveLength(60);
    expect(run.removals).toEqual([]);
    expect(run.refused).toEqual([]);
    // Kept, untouched — not "kept and quietly reset". Their clocks keep running from where
    // they were, so the next sync that does get an answer decides on the real elapsed time.
    expect(run.upserts.map((t) => t.id)).toEqual(live.map((t) => t.id));
  });

  it('one batch short, one answered: only the answered keys can go', async () => {
    // The rule the whole `jiraConfirm` module exists for — each batch stands alone. One dead
    // ticket 400s the fifty batched with it, and those fifty must not pay for it.
    pagedInstance(issues);
    let batch = 0;
    const searcher = fakeSearcher(() =>
      batch++ === 0 ? { issues: [], truncated: true } : { issues: [], truncated: false },
    );
    const run = await sync({ existing: board, searcher, reconcile: RETENTION });

    expect(run.truncatedBatches).toHaveLength(50);
    expect(run.removals.map((r) => r.key)).toEqual(range(291, 300).map(key));
    expect(run.removals.map((r) => r.reason)).toEqual(Array(10).fill('gone-from-jira'));
  });

  it('a truncated SEARCH also stops a re-read that answered — the one funnel every drop goes through', async () => {
    // The case that pins `truncated` itself rather than the rules around it. Here the re-read
    // is perfectly healthy: 60 keys asked, 60 answered, JIRA has none of them, and every one
    // of those cards is `gone-from-jira` on the evidence. The only thing between them and the
    // board is that the main search stopped short — and a search we know was short removes
    // nothing, for ANY reason, which is why the reason is not consulted at the last step.
    pagedInstance(issues);
    const run = await sync({
      existing: board,
      searcher: fakeSearcher(deniesAll),
      limit: 100,
      reconcile: RETENTION,
    });

    expect(run.truncated).toBe(true);
    expect(run.retained).toHaveLength(60);
    expect(run.removals).toEqual([]);
    expect(run.warning).toContain('did not return the whole query');
  });

  it('a batch that errors is the same answer as one that was never asked', async () => {
    pagedInstance(issues);
    const searcher = fakeSearcher(() => {
      throw new Error('JIRA 400: An issue with key BOARD-250 does not exist');
    });
    const run = await sync({ existing: board, searcher, reconcile: RETENTION });

    expect(run.failedBatches).toHaveLength(60);
    expect(run.removals).toEqual([]);
  });

  // ---- and now prove it could have failed -------------------------------------------------

  it('when the re-read DOES answer and JIRA has none of them, all 60 go', async () => {
    // Without this the three assertions above are vacuous: they would read identically if
    // `gone-from-jira` had simply been deleted from the reconciler.
    pagedInstance(issues);
    const run = await sync({
      existing: board,
      searcher: fakeSearcher(deniesAll),
      reconcile: RETENTION,
    });

    expect(run.removals).toHaveLength(60);
    expect(run.removals.map((r) => r.reason)).toEqual(Array(60).fill('gone-from-jira'));
    expect(run.refused).toEqual([]);
  });

  it('and a card the re-read finds keeps its clock rather than restarting it', async () => {
    pagedInstance(issues);
    const run = await sync({
      existing: board,
      searcher: fakeSearcher(affirmsAll),
      reconcile: RETENTION,
    });

    expect(run.removals).toEqual([]);
    const followed = run.upserts.filter((t) => t.retainedSince != null);
    expect(followed).toHaveLength(60);
    expect(followed.every((t) => t.retainedSince === NOW - DAY)).toBe(true);
    // Same row it was before — a retained card that came back as a new id would lose its
    // timeline, its files and every arrow drawn to it.
    expect(followed.map((t) => t.id)).toEqual(finished.map((t) => t.id));
  });
});

// ---------------------------------------------------------------------------

describe('a sprint switch narrows the board, and the way back restores it', () => {
  const board = range(1, BOARD_SIZE).map((n) => cardFor(n));
  /** The new sprint carries 60 of the 300 over; the other 240 are last sprint's. */
  const carriedOver = range(1, 60).map((n) => issueFor(n));
  const NEW_SPRINT = `${JQL} AND sprint in openSprints()`;

  it('the guard stands down when the QUESTION changed, so the 240 really do leave', async () => {
    pagedInstance(carriedOver);
    const run = await sync({
      existing: board,
      searcher: fakeSearcher(deniesAll),
      jql: NEW_SPRINT,
      reconcile: { queryChanged: true },
    });

    expect(run.candidates).toHaveLength(240);
    expect(run.removals).toHaveLength(240);
    expect(run.refused).toEqual([]);
    // Every one of them was ASKED ABOUT BY KEY first — the sprint rolling over does not
    // license removing cards, it only licenses removing this MANY of them at once.
    expect(run.removals.map((r) => r.reason)).toEqual(Array(240).fill('left-query'));
    // And each names the ticket and the title, because the human has to be able to check it
    // against JIRA. `removals`, not `deleteIds`: the caller archives these (see
    // `ipc.ts` → `store.archiveTask`), and the row keeps everything hanging off it.
    expect(run.removals[0]).toMatchObject({
      taskId: 'card-BOARD-61',
      key: 'BOARD-61',
      title: 'Card for BOARD-61',
    });
  });

  it('while the SAME shrinkage with the question unchanged is refused outright', async () => {
    // The mutation for the clause above. If `queryChanged` stopped being read, this would
    // start removing 240 cards and the test would say so.
    pagedInstance(carriedOver);
    const run = await sync({ existing: board, searcher: fakeSearcher(deniesAll) });

    expect(run.removals).toEqual([]);
    expect(run.refused).toHaveLength(240);
    expect(run.warning).toContain('Kept 240 of 300 JIRA cards');
    expect(run.warning).toContain('more than 25% of the board in one sync');
  });

  it('the way back: the same rows return, same ids, nothing re-created', async () => {
    // The board a sync later, with the 240 archived — which is what `getPersonalTasksForSync`
    // hands the reconciler, and the reason it is the ONE read that includes archived cards.
    const afterSwitch = [
      ...range(1, 60).map((n) => cardFor(n)),
      ...range(61, BOARD_SIZE).map((n) =>
        cardFor(n, { archivedAt: NOW - DAY, archivedReason: 'left-query' }),
      ),
    ];
    pagedInstance(range(1, BOARD_SIZE).map((n) => issueFor(n)));
    const searcher = fakeSearcher(deniesAll);
    const run = await sync({
      existing: afterSwitch,
      searcher,
      reconcile: { queryChanged: true },
    });

    expect(run.restoreIds).toEqual(range(61, BOARD_SIZE).map((n) => `card-${key(n)}`));
    expect(run.removals).toEqual([]);
    expect(run.refused).toEqual([]);
    // The whole point of archiving rather than deleting: the ticket lands back on the row it
    // left on. A `jira-*` id in here would mean a brand-new card beside the archived one, and
    // everything the old row carried stranded on a card nobody can see.
    expect(run.upserts).toHaveLength(BOARD_SIZE);
    expect(run.upserts.map((t) => t.id)).toEqual(afterSwitch.map((t) => t.id));
    expect(run.upserts.some((t) => t.id.startsWith('jira-'))).toBe(false);
  });

  it('an archived card the query still does not return is left alone, not asked about again', async () => {
    const afterSwitch = [
      ...range(1, 60).map((n) => cardFor(n)),
      ...range(61, BOARD_SIZE).map((n) =>
        cardFor(n, { archivedAt: NOW - DAY, archivedReason: 'left-query' }),
      ),
    ];
    pagedInstance(carriedOver);
    const searcher = fakeSearcher(deniesAll);
    const run = await sync({ existing: afterSwitch, searcher, jql: NEW_SPRINT });

    // Already off the board: there is no fate left to decide, so it costs no request and
    // produces no second removal.
    expect(run.candidates).toEqual([]);
    expect(run.retained).toEqual([]);
    expect(searcher.asked).toEqual([]);
    expect(run.removals).toEqual([]);
    expect(run.restoreIds).toEqual([]);
    expect(run.warning).toBeNull();
  });
});
