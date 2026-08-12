/**
 * Pure reconciliation of fetched GitHub issues into Personal-board tasks.
 *
 * `jira/jiraSync.ts`, one tracker over: no DB, no Electron — the IPC layer applies the
 * returned upserts, restores and archives. Keyed by `owner/repo#123` so a card keeps its id
 * (and thus its activity timeline, its files, its chain arrows and its unread marker) across
 * syncs.
 *
 * **Why this is its own reconciler and not a flag on the JIRA one.** Everything about how
 * `reconcileJiraTasks` asks its questions is JIRA-shaped: it takes a JQL string, it works
 * around a paged search that silently truncates, and it needs a whole second *confirm* pass
 * — `(<the query>) AND key in (…)` — because JIRA has no other way to distinguish "this
 * ticket stopped matching" from "that page was short". None of that is true here. GitHub's
 * search tells you itself when it gave up (`incomplete_results`), and an issue can be re-read
 * by number for a flat one call. So the *shape* is different and the file is separate; the
 * **rules** are not, and the ones that are genuinely shared are shared as code rather than
 * copied — `forge/removalGuard.ts` for the bound on a single sync, and
 * `@shared/statusResolve`'s `resolveGitHubColumn` for the column, which the drag in step 6
 * calls too so that a move and the next poll cannot disagree.
 *
 * Everything `issueToTask` learned the hard way on JIRA is carried over verbatim, because
 * none of it was about JIRA:
 *
 *  - a block the app itself applied (`preBlockStatus`) survives a sync;
 *  - a live run is never evicted from `status` (`preRunStatus`) — the tracker still decides
 *    the column, it just writes it to the value the run will be restored to;
 *  - every field a sync did not return falls back to the prior value rather than blanking it;
 *  - a brand-new card starts **read**, so the first sync does not turn the board orange.
 *
 * And the rule the whole module exists to enforce, unchanged from `reconcileJiraTasks`:
 * **no card leaves the board unless GitHub was asked about it by number and answered.**
 * A truncated search, a re-read that failed, a question nobody put — every one of them means
 * *keep*. The mistake is not symmetric: a card wrongly kept is a stale row you can drag away,
 * a card wrongly removed is work the human can no longer see.
 */
import {
  PERSONAL_PROJECT_ID,
  type BoardColumn,
  type JiraStatusCategory,
  type Task,
} from '@shared/model';
import { columnForTask, isRunStatus, restingStatus, statusForColumn } from '@shared/board';
import { firstUnmappedLabel, resolveGitHubColumn } from '@shared/statusResolve';
import { guardRemovals, type ForgeRemoval, type ForgeRemovalReason } from '../forge/removalGuard';
import { githubAuthorIsMe, type GitHubIdentityCache } from './identity';
import type { GitHubIssueComment, GitHubSearchIssueItem } from './githubClient';

/** A set of issue keys, however the caller happens to be holding them. */
export type KeySet = ReadonlySet<string> | readonly string[];

/** Normalise a {@link KeySet} option; null/undefined stays null — "nobody asked". */
function asSet(keys: KeySet | null | undefined): ReadonlySet<string> | null {
  if (keys == null) return null;
  return keys instanceof Set ? keys : new Set(keys as readonly string[]);
}

export interface GitHubIssueSyncOptions {
  /**
   * The user's label → column map (matched case-insensitively) — the top tier of
   * `resolveGitHubColumn`, and on GitHub the *only* way a card reaches any column other than
   * TO DO and DONE.
   */
  overrides?: Record<string, BoardColumn>;
  /** The map the app taught itself from successful drags. Loses to `overrides`. */
  learned?: Record<string, BoardColumn>;
  /**
   * Who the stored token belongs to, so a comment you wrote yourself does not raise the
   * unread border on your own card. Absent/null keeps every comment counting.
   */
  identity?: GitHubIdentityCache | null;
  /**
   * `owner/repo#123` → that issue's comments, for the issues this sync actually re-read them
   * for. A key that is ABSENT means "not asked this time", which keeps whatever the card
   * already knew; an empty array means "asked, and there are none".
   *
   * Comments cost a call each, so the caller fetches them only for issues whose `updated_at`
   * moved — bounded by the size of the board, never by the size of the repository.
   */
  comments?: ReadonlyMap<string, readonly GitHubIssueComment[]>;
  /**
   * The issues re-read **by number** for the cards the search did not return, or **null when
   * that pass did not run or failed**.
   *
   * Null and empty are deliberately different answers, exactly as in `reconcileJiraTasks`.
   * An empty map is GitHub saying "none of those exist any more"; null is us not having
   * asked, and a card must never be archived on the strength of a question nobody put.
   */
  rechecked?: ReadonlyMap<string, GitHubSearchIssueItem> | null;
  /**
   * The keys the re-read pass actually **asked and got an answer for** — the same discipline
   * as `rechecked: null`, but per key. One issue whose call errored (a transient 502, a repo
   * that just went private) must not read as "GitHub does not have it".
   */
  recheckedKeys?: KeySet | null;
  /**
   * Whether the search stopped short of the end of the query — `incomplete_results`, or the
   * page cap. A short answer looks exactly like a shrunken board, so a truncated one removes
   * nothing at all, for any reason.
   */
  truncated?: boolean;
  /**
   * Whether the question itself changed since the last sync (the issue query was edited).
   * Cards leaving is then expected, so `guardRemovals` stands down.
   */
  queryChanged?: boolean;
  /** Share of the board that may leave in one sync before the guard refuses. Default 0.25. */
  maxRemovalFraction?: number;
  /** Removals below this count are never guarded — small boards are noisy. Default 5. */
  minGuardedRemovals?: number;
  /** Now, in epoch ms — when a card's retention clock starts, and what prunes it. */
  now?: number;
  /**
   * How long a finished card is kept past the query, in ms. **Defaults to 0**, which retires
   * it the moment the query drops it.
   */
  retentionMs?: number;
}

export interface GitHubIssueSyncResult {
  /** Cards to insert or update. */
  upserts: Task[];
  /** Cards to take off the board — every one confirmed by a question GitHub answered. */
  removals: ForgeRemoval[];
  /** Ids of archived cards whose issue is back in the query — put them back on the board. */
  restoreIds: string[];
  /** Removals `guardRemovals` would not let through. Nothing was done to these. */
  refused: ForgeRemoval[];
  /** What the human should be told about this sync, or null when there is nothing to say. */
  warning: string | null;
}

/** One issue, named the way a board card names it and a pull request refers to it. */
export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
  /** `owner/repo#123` — the card's `externalKey`. */
  key: string;
}

/**
 * `/repos/{owner}/{repo}` off a search row's `repository_url` — the ONLY thing on a listing
 * that says which repository the row belongs to.
 *
 * A local copy of `describePullRequest.repoRefFromApiUrl` rather than an import of it: this
 * module is about issues, that one is about pull requests, and a shared four-line regex is
 * not worth a dependency between two reconcilers that otherwise share nothing.
 */
export function repoRefFrom(url: string | undefined): { owner: string; repo: string } {
  const match = /\/repos\/([^/]+)\/([^/]+)\/?$/.exec(url ?? '');
  return { owner: match?.[1] ?? '', repo: match?.[2] ?? '' };
}

/** `owner/repo#123` — the repo-scoped spelling. See `Task.externalKey` for why not `#123`. */
export function issueKeyFor(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`;
}

/**
 * The card id for an issue: `gh-{owner}-{repo}-{number}`.
 *
 * Prefixed like `gl-`/`gh-` on merge requests, and for the same reason — one board holds
 * cards from two trackers and their ids must not collide. Built from the repo PATH rather
 * than a numeric repository id because a search row does not carry one (see
 * `githubPrSync.pullRequestId`, which pays for that omission with a placeholder row).
 */
export function issueTaskId(owner: string, repo: string, number: number): string {
  return `gh-${owner}-${repo}-${number}`;
}

/** An issue's label names, trimmed and blank-free, in GitHub's own order. */
function labelsOf(issue: GitHubSearchIssueItem): string[] {
  return (issue.labels ?? []).map((l) => (l?.name ?? '').trim()).filter((name) => name.length > 0);
}

/**
 * The board column, as a JIRA status category.
 *
 * The column is the truth here and the category is a display detail the card and the pane
 * already read, so it is DERIVED from the column rather than invented beside it — a GitHub
 * issue has no category of its own, and two independently-computed answers would eventually
 * disagree about the same card.
 */
function categoryForColumn(column: BoardColumn): JiraStatusCategory {
  if (column === 'done') return 'Done';
  if (column === 'todo') return 'To Do';
  return 'In Progress';
}

/**
 * The issue's type, from the two labels GitHub itself creates in every new repository.
 *
 * Only those two, deliberately. `externalType` drives the card's type icon and nothing else,
 * and a repository's own taxonomy (`kind/feature`, `type: chore`) is exactly what the
 * label → column map and the label chip are for. Guessing at it here would put a beaker on a
 * card because somebody wrote "enhancement request" in a label about something else.
 */
function issueTypeFrom(labels: readonly string[]): string | null {
  for (const label of labels) {
    const lower = label.toLowerCase();
    if (lower === 'bug') return 'Bug';
    if (lower === 'enhancement') return 'Enhancement';
  }
  return null;
}

/**
 * Newest comment time (epoch ms) among an issue's comments, **ignoring your own**, or null.
 *
 * `jiraSync.latestForeignCommentTime`, unchanged in every respect that matters: counting your
 * own comments meant answering a ticket in the tracker's web UI lit your own card orange, and
 * the only way to clear it was to open the card and read the thing you had just written.
 * An unknown identity counts every comment — the safe direction.
 */
function latestForeignCommentTime(
  comments: readonly GitHubIssueComment[],
  identity: GitHubIdentityCache | null,
): number | null {
  let latest: number | null = null;
  for (const c of comments) {
    if (githubAuthorIsMe(c.user, identity)) continue;
    const t = Date.parse(c.created_at);
    if (!Number.isNaN(t) && (latest == null || t > latest)) latest = t;
  }
  return latest;
}

/** Convert one issue to a task, folding in any preserved state from the existing one. */
export function issueToTask(
  issue: GitHubSearchIssueItem,
  existing: Task | undefined,
  opts: GitHubIssueSyncOptions,
  order: number,
  retainedSince: number | null = null,
): Task {
  const { owner, repo } = repoRefFrom(issue.repository_url);
  const key = issueKeyFor(owner, repo, issue.number);
  const labels = labelsOf(issue);
  const resolved = resolveGitHubColumn(labels, issue.state, opts.overrides, opts.learned);
  const derivedStatus = statusForColumn(resolved.column);

  // Only OUR block is preserved — the identical rule to `jiraSync.issueToTask`, and here it
  // is even sharper: GitHub has no blocked state of its own at all, so a card resting in
  // BLOCKED is *always* either the app's own block or a label the user mapped onto that
  // column. The first must survive a poll (nothing but this app will ever move it out
  // again); the second needs no preserving, because the label re-asserts it every sync and
  // removing the label in GitHub is exactly how it should stop.
  //
  // Read from where the card RESTS, not from `status`: a card whose agent is running has
  // lent that field to the run, and a blocked card that is running is still blocked.
  const localBlock = existing
    ? restingStatus(existing) === 'blocked' && existing.preBlockStatus != null
    : false;
  const resting = localBlock ? 'blocked' : derivedStatus;
  // A live run owns `status` and a poll must not evict it — that would drop the card out of
  // "running" mid-session, and with it the spinner, the drag guard and the chat target.
  const borrowed = existing && isRunStatus(existing.status) ? existing.status : null;

  // Absent from the map means "this sync did not re-read the comments", which keeps what we
  // knew; present-and-empty means "asked, and there are none". See `GitHubIssueSyncOptions`.
  const fetched = opts.comments?.get(key);
  const latestCommentAt = fetched ? latestForeignCommentTime(fetched, opts.identity ?? null) : null;
  // A brand-new card starts "read" so the first sync doesn't turn every card orange; an
  // existing one keeps the user's own marker.
  const lastReadCommentAt = existing ? (existing.lastReadCommentAt ?? null) : latestCommentAt;

  const description = (issue.body ?? '').trim() || null;

  return {
    id: existing?.id ?? issueTaskId(owner, repo, issue.number),
    projectId: PERSONAL_PROJECT_ID,
    // The repository is what the card's "Project:" line says — the nearest thing GitHub has
    // to JIRA's project name, and the only grouping a cross-repo board can show.
    phase: owner && repo ? `${owner}/${repo}` : repo || owner,
    title: issue.title,
    status: borrowed ?? resting,
    sessionId: null,
    order: existing?.order ?? order,
    dependsOn: [],
    source: 'github',
    isContract: false,
    isScaffold: false,
    externalSource: 'github',
    externalKey: key,
    // The node id when the instance sends one, else the numeric id as a string. Falls back to
    // the prior value like every other field: a shape we failed to read must not blank one we
    // already had.
    externalId: issue.node_id ?? (issue.id ? String(issue.id) : (existing?.externalId ?? null)),
    externalUrl: issue.html_url || (existing?.externalUrl ?? null),
    // What this board is calling the issue's status: the LABEL that decided its column when
    // one did, and the issue's own open/closed state when nothing else spoke. Both are things
    // a human can go and check against the issue, which is the whole job of this field.
    externalStatus: resolved.label ?? issue.state,
    externalStatusCategory: categoryForColumn(resolved.column),
    // GitHub has no priority. The field is kept because a human may have set one here
    // (`task:setPriority` is local-only for a card that is not JIRA's), and a sync must not
    // wipe what the human typed.
    externalPriority: existing?.externalPriority ?? null,
    externalType: issueTypeFrom(labels) ?? existing?.externalType ?? null,
    // The first label NOT already spending itself on the column — see `firstUnmappedLabel`.
    externalLabel: firstUnmappedLabel(labels, opts.overrides, opts.learned),
    // GitHub has no epic and no sprint. Preserved rather than nulled: a card mirrored from
    // JIRA cannot become this one (different `source`), but a field that only ever writes
    // null is a field waiting to wipe something the day that stops being true.
    externalParentKey: existing?.externalParentKey ?? null,
    externalEpicName: existing?.externalEpicName ?? null,
    externalSprint: existing?.externalSprint ?? null,
    externalDescription: description ?? existing?.externalDescription ?? null,
    preBlockStatus: localBlock ? (existing?.preBlockStatus ?? null) : null,
    preRunStatus: borrowed ? resting : null,
    retainedSince,
    lastReadCommentAt,
    latestCommentAt: latestCommentAt ?? existing?.latestCommentAt ?? null,
    // Internal-only state GitHub has never heard of: the filing and the delegation come
    // through a re-sync untouched.
    projectTagId: existing?.projectTagId ?? null,
    agentProjectId: existing?.agentProjectId ?? null,
  };
}

/**
 * Whether a card that has left the query is one the board **keeps**.
 *
 * `jiraSync.isRetained`, and the reasoning transfers word for word: the query it just fell
 * out of is almost certainly `is:open`, which stops matching an issue the instant you close
 * it — so dragging a card into DONE would delete it out of the column you had just dropped it
 * in. The second clause keeps a card that is *already* being retained counting even after it
 * reopens, which is what makes reopening an issue on github.com visible on the board.
 *
 * "Finished" is read off the COLUMN, not a hand-copied list of statuses, so `cancelled`,
 * `stopped` and `failed` — all of which sit in DONE — cannot be missed.
 */
function isRetained(task: Task): boolean {
  return task.retainedSince != null || columnForTask(task) === 'done';
}

/** GitHub cards on the board, keyed by `owner/repo#123`. */
function githubTasksByKey(existing: readonly Task[]): Map<string, Task> {
  return new Map(
    existing
      .filter((t) => t.source === 'github' && t.externalKey)
      .map((t) => [t.externalKey as string, t]),
  );
}

/**
 * Every card the search left out that still has something worth asking about — the issues to
 * re-read **by number**.
 *
 * One list where the JIRA sync needs two (`retainedKeys` and `removalCandidateKeys`), and
 * that is the whole shape difference between the two trackers. JIRA has to ask two different
 * questions — "does this still match the JQL?" for the cards it would drop, and "what is this
 * ticket doing now?" for the ones it is keeping — because a JQL cannot be asked about one
 * issue cheaply. GitHub answers both at once: `GET /issues/{n}` says whether the issue exists
 * AND what state it is in, for one call, so every card the search left out gets the same
 * question and the reconciler decides from the answer.
 *
 * Bounded by the BOARD, not by the repository: at most one call per card already on it.
 */
export function issuesToRecheck(
  existing: readonly Task[],
  issues: readonly GitHubSearchIssueItem[],
): IssueRef[] {
  const returned = new Set(
    issues.map((i) => {
      const { owner, repo } = repoRefFrom(i.repository_url);
      return issueKeyFor(owner, repo, i.number);
    }),
  );
  const refs: IssueRef[] = [];
  for (const task of existing) {
    if (task.source !== 'github' || task.externalKey == null) continue;
    if (returned.has(task.externalKey)) continue;
    if (task.archivedAt != null) continue; // already off the board; nothing left to decide
    if (restingStatus(task) === 'blocked') continue; // never removed, so never worth asking
    const parsed = parseIssueKey(task.externalKey);
    if (parsed) refs.push(parsed);
  }
  return refs;
}

/** `owner/repo#123` back into its parts, or null when the key is not that shape. */
export function parseIssueKey(key: string): IssueRef | null {
  const match = /^([^/#\s]+)\/([^/#\s]+)#(\d+)$/.exec(key.trim());
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    number: Number(match[3]),
    key: `${match[1]}/${match[2]}#${match[3]}`,
  };
}

/**
 * Reconcile the issue-query result against the current Personal-board tasks. Cards from any
 * other source — ad-hoc, plan, JIRA, native tickets — are never touched, structurally: every
 * loop below filters on `source === 'github'`.
 *
 * The fates, each one naming the question behind it:
 *
 *   1. **blocked** — untouched. A blocked card is never removed, so no answer could change
 *      the outcome and there is no question worth asking.
 *   2. **archived** — already off the board. Back in the query ⇒ it returns (`restoreIds`);
 *      still absent ⇒ nothing to say.
 *   3. **the search was truncated** — everything is kept, whatever else is true of it.
 *   4. **the re-read did not run, or this issue's own call failed** — kept. A card must not
 *      be archived on a question that errored.
 *   5. **asked for by number, and GitHub does not have it** — `gone-from-jira`, which is this
 *      vocabulary's name for "gone from the tracker" (see `TaskArchiveReason`).
 *   6. **asked, and GitHub says it is closed** — kept and retained, even if the card was not
 *      already finished. The answer is in hand and it says the work landed; taking the card
 *      off the board at the exact moment a human wants to see it land would be perverse.
 *   7. **asked, still open, and nothing is retaining it** — `left-query`.
 *   8. **retained past its window** — `retention-expired`.
 *   9. otherwise — upserted from the re-read issue, with its retention clock preserved.
 *
 * Whatever survives that is put to `guardRemovals`, **here** rather than in the caller: a
 * guard the caller can forget to apply is not a guard.
 */
export function reconcileGitHubIssues(
  existing: Task[],
  issues: GitHubSearchIssueItem[],
  opts: GitHubIssueSyncOptions,
): GitHubIssueSyncResult {
  const existingByKey = githubTasksByKey(existing);
  const seen = new Set<string>();
  const restoreIds: string[] = [];

  const upserts = issues.map((issue, i) => {
    const { owner, repo } = repoRefFrom(issue.repository_url);
    const key = issueKeyFor(owner, repo, issue.number);
    seen.add(key);
    const prior = existingByKey.get(key);
    // Archived, and the query returns it again: the issue matches, so the card comes back to
    // the board — the same row, with the timeline, files and links it left with.
    if (prior?.archivedAt != null) restoreIds.push(prior.id);
    return issueToTask(issue, prior, opts, i);
  });

  const rechecked = opts.rechecked ?? null;
  const recheckedKeys = asSet(opts.recheckedKeys);
  const truncated = opts.truncated === true;
  const now = opts.now ?? Date.now();

  const candidates: ForgeRemoval[] = [];

  /**
   * The one funnel every removal goes through, so `truncated` cannot be forgotten in a
   * branch: a search we know was short removes nothing at all, for any reason.
   */
  const drop = (task: Task, reason: ForgeRemovalReason): void => {
    if (truncated) return;
    candidates.push({
      taskId: task.id,
      key: task.externalKey as string,
      title: task.title,
      reason,
    });
  };

  for (const task of existing) {
    if (task.source !== 'github' || task.externalKey == null || seen.has(task.externalKey)) {
      continue;
    }
    // Already off the board, and the query has not brought it back: say nothing about it.
    if (task.archivedAt != null) continue;
    // Keep blocked cards even when they leave the query — and read where the card RESTS, so
    // one whose agent is mid-run isn't removed out from under the session.
    if (restingStatus(task) === 'blocked') continue;

    // The re-read didn't run (or failed outright). Keep the card untouched rather than retire
    // it on a question nobody put; its clock simply starts on the next sync that does ask.
    if (rechecked === null) continue;
    // Same rule one level finer: this issue's own call errored, so `rechecked` not listing it
    // says nothing at all.
    if (recheckedKeys !== null && !recheckedKeys.has(task.externalKey)) continue;

    const issue = rechecked.get(task.externalKey);
    // GitHub answered and does not have it: deleted, transferred, or the repository is no
    // longer visible to this token.
    if (!issue) {
      drop(task, 'gone-from-jira');
      continue;
    }

    // The answer is in hand, so ask it what the column should be rather than only what the
    // card used to say. A card the human closed on github.com is finished, whatever column it
    // was sitting in when the query dropped it, and that is a card the board KEEPS (and
    // starts a retention clock on) rather than one it archives.
    const column = resolveGitHubColumn(
      labelsOf(issue),
      issue.state,
      opts.overrides,
      opts.learned,
    ).column;
    if (!isRetained(task) && column !== 'done') {
      drop(task, 'left-query');
      continue;
    }

    const since = task.retainedSince ?? now;
    // `>=`, so a retention of 0 retires the card on the very sync that dropped it.
    if (now - since >= (opts.retentionMs ?? 0)) {
      drop(task, 'retention-expired');
      continue;
    }
    upserts.push(issueToTask(issue, task, opts, task.order, since));
  }

  // The denominator is the BOARD — the cards a human can see — not the query's answer, which
  // is the very thing under suspicion when this guard matters.
  const boardCount = existing.filter(
    (t) => t.source === 'github' && t.externalKey != null && t.archivedAt == null,
  ).length;
  const guarded = guardRemovals(candidates, boardCount, {
    ...opts,
    tracker: 'GitHub',
    queryName: 'issue query',
  });

  const notes: string[] = [];
  if (truncated) {
    notes.push(
      'GitHub did not return the whole issue query, so no card was removed from the board ' +
        'this sync.',
    );
  }
  if (guarded.warning) notes.push(guarded.warning);

  return {
    upserts,
    removals: guarded.removals,
    restoreIds,
    refused: guarded.refused,
    warning: notes.length ? notes.join(' ') : null,
  };
}
