/**
 * Pure reconciliation of fetched JIRA issues into Personal-board tasks (Phase C).
 * Mirrors `taskReconcile` in spirit: no DB, no Electron — the IPC layer applies the
 * returned upserts/deletes to the store. Keyed by issue key so a task keeps its id
 * (and thus its activity timeline + unread markers) across syncs.
 *
 * Internal-only state is preserved: a task the user moved to `blocked` stays blocked
 * (JIRA is never consulted for blocking), and blocked tasks that drop out of the JQL
 * result are NOT deleted, so a blocked ticket never silently vanishes.
 *
 * The other thing that does not vanish is a **finished** card. The board is the JQL result,
 * and the commonest JQL there is — `resolution = Unresolved` — stops matching an issue the
 * instant you finish it, so dragging a card into DONE used to delete it out of the column
 * you had just dropped it in. Those cards are retained instead, and re-read by key so they
 * keep following their ticket even while the query cannot see them. See {@link retainedKeys}.
 *
 * Above all of that sits the rule this module now exists to enforce — see
 * {@link reconcileJiraTasks}: **no card leaves the board unless JIRA was asked about it by
 * key and answered.**
 */
import { PERSONAL_PROJECT_ID, type BoardColumn, type Task } from '@shared/model';
import {
  categoryFromKey,
  columnForTask,
  isRunStatus,
  restingStatus,
  statusForColumn,
} from '@shared/board';
import { resolveStatusColumn } from '@shared/statusResolve';
import { commentBodyToText, type JiraIssue } from './jiraClient';
import { authorIsMe, type JiraIdentityCache } from './identity';
import { epicKeyFromIssue, epicNameFromIssue } from './epicField';
import { sprintNameFromIssue } from './jiraSprint';

export interface JiraSyncOptions {
  /** Base URL, used to build each issue's deep link. */
  baseUrl: string;
  /**
   * The user's raw-status-name → column map (matched case-insensitively) — the top
   * tier of `resolveStatusColumn`, which is what actually decides the column.
   */
  overrides?: Record<string, BoardColumn>;
  /**
   * The map the app taught itself from successful drags. Loses to `overrides`, beats
   * the name heuristic and the category. See `shared/statusResolve.ts`.
   */
  learned?: Record<string, BoardColumn>;
  /**
   * The discovered "Epic Link" custom field id, or null when the instance has none
   * (Cloud team-managed) or discovery failed — the epic then comes from `parent`.
   */
  epicFieldId?: string | null;
  /**
   * Epic key → epic NAME, for instances whose epic link is the custom field (which
   * carries a bare key). Supplied by the caller from one batched lookup; issues that
   * carry their parent inline never need it.
   */
  epicNames?: ReadonlyMap<string, string>;
  /**
   * The discovered "Sprint" custom field id, or null when the instance has none (no
   * JIRA Software) or discovery failed — cards then simply carry no sprint name.
   */
  sprintFieldId?: string | null;
  /**
   * Who the stored PAT belongs to, so a comment you wrote yourself does not raise the
   * unread border on your own card. Absent/null keeps the old behaviour: every comment
   * counts. See `latestForeignCommentTime`.
   */
  identity?: JiraIdentityCache | null;
  /**
   * The issues fetched by key for the cards being retained past the query (the keys
   * {@link retainedKeys} asked for), or **null when that fetch did not run or failed**.
   *
   * Null and empty are deliberately different answers. An empty array is JIRA saying "none
   * of those keys exist any more", which retires them; null is us not having asked, and a
   * card must never be deleted on the strength of a question nobody put.
   */
  rechecked?: JiraIssue[] | null;
  /**
   * The keys of {@link rechecked}'s question that were actually **asked and answered** —
   * the same discipline as `rechecked: null`, but per key.
   *
   * The re-read is chunked (a `key in (…)` of three hundred keys finds your instance's URL
   * limit), and one dead key 400s the whole batch it is in. Without this, a batch that
   * failed is indistinguishable from a batch that came back empty, and every card in it is
   * retired on a question that errored. Absent/null keeps the old whole-or-nothing reading:
   * `rechecked` answers for every key that was asked for.
   */
  recheckedKeys?: KeySet | null;
  /**
   * The keys the **confirm pass** put to JIRA — "of these cards, which still match the
   * board's query?" — or null when that pass did not run.
   *
   * The companion of {@link queryMatches}, and deliberately a separate set from it, because
   * "asked, and JIRA said no" and "never asked" are different answers and only the first is
   * grounds for taking a card off the board. A key missing from here is kept.
   */
  queryChecked?: KeySet | null;
  /**
   * The subset of {@link queryChecked} that JIRA said **still matches** the query.
   *
   * Every key in here is a card the paged search left out of its answer while the query
   * itself still returns it — a paging artifact, and the thing that was eating the board.
   * They are kept, and counted into {@link JiraSyncResult.warning}.
   */
  queryMatches?: KeySet | null;
  /**
   * Whether the search that produced `issues` stopped short of the end (see
   * `jiraClient.searchAll`). A short answer looks exactly like a shrunken board, so a
   * truncated one removes nothing at all.
   */
  truncated?: boolean;
  /**
   * Whether the question itself changed since the last sync — the sprint rolled over, the
   * JQL was edited in Settings. Cards leaving is then expected, so {@link guardRemovals}
   * stands down; the guard is there to catch a board shrinking while the question held still.
   */
  queryChanged?: boolean;
  /** Share of the board that may leave in one sync before the guard refuses. Default 0.25. */
  maxRemovalFraction?: number;
  /** Removals below this count are never guarded — small boards are noisy. Default 5. */
  minGuardedRemovals?: number;
  /** Now, in epoch ms — when a card's retention clock starts, and what prunes it. */
  now?: number;
  /**
   * How long a retained card is kept, in ms. **Defaults to 0**, which retires a finished
   * card the moment the query drops it — the behaviour before retention existed, and the
   * right answer for every caller that is not the poll (a freshly created issue has no
   * history to keep).
   */
  retentionMs?: number;
}

/** A set of issue keys, however the caller happens to be holding them. */
export type KeySet = ReadonlySet<string> | readonly string[];

/** Normalise a {@link KeySet} option; null/undefined stays null — "nobody asked". */
function asSet(keys: KeySet | null | undefined): ReadonlySet<string> | null {
  if (keys == null) return null;
  return keys instanceof Set ? keys : new Set(keys as readonly string[]);
}

/** Why the board is letting go of a card. Each one is a different question having answered. */
export type JiraRemovalReason =
  /** JIRA was asked whether this key still matches the query, and said no. */
  | 'left-query'
  /** A retained card that has been kept for longer than the retention window. */
  | 'retention-expired'
  /** Asked for by key, and JIRA does not have it: deleted, or invisible to this token. */
  | 'gone-from-jira';

/**
 * One card the board is letting go of. Carries the key and the title as well as the id,
 * because the caller has to be able to *tell the human what left* — an id alone is not
 * something anybody can check against JIRA.
 */
export interface JiraRemoval {
  taskId: string;
  key: string;
  title: string;
  reason: JiraRemovalReason;
}

export interface JiraSyncResult {
  /** JIRA tasks to insert or update (new + changed issues). */
  upserts: Task[];
  /**
   * Cards to take off the board — every one of them confirmed by a question JIRA answered.
   *
   * Deliberately not called `deleteIds`: that name invited `store.deleteTask`, and a card
   * leaving the board is not the human deleting it. See `store.archiveTask`.
   */
  removals: JiraRemoval[];
  /** Ids of archived cards whose issue is back in the query — put them back on the board. */
  restoreIds: string[];
  /** Removals {@link guardRemovals} would not let through. Nothing was done to these. */
  refused: JiraRemoval[];
  /** What the human should be told about this sync, or null when there is nothing to say. */
  warning: string | null;
}

/** What {@link guardRemovals} made of a removal set: what may go, what may not, and why. */
export interface JiraRemovalGuard {
  removals: JiraRemoval[];
  refused: JiraRemoval[];
  warning: string | null;
}

/** Share of the board that may leave in one sync before the guard refuses the lot. */
export const DEFAULT_MAX_REMOVAL_FRACTION = 0.25;

/** Below this many removals the guard never fires — a four-card board is all fractions. */
export const DEFAULT_MIN_GUARDED_REMOVALS = 5;

/**
 * Newest comment time (epoch ms) from an issue's inline comments, **ignoring your own**,
 * or null.
 *
 * `latestCommentAt` drives the unread border. Counting your own comments meant that
 * answering a ticket in the JIRA web UI lit your own card orange on the next sync, and
 * the only way to clear it was to open the card and read the thing you had just written.
 *
 * When the identity is unknown, every comment counts — the pre-existing behaviour. That
 * is the safe direction: a card that shouts when it needn't is a nuisance, a card that
 * stays quiet when someone is waiting on you is a missed reply.
 */
function latestForeignCommentTime(
  issue: JiraIssue,
  identity: JiraIdentityCache | null,
): number | null {
  const comments = issue.fields.comment?.comments ?? [];
  let latest: number | null = null;
  for (const c of comments) {
    if (authorIsMe(c.author, identity)) continue;
    const t = Date.parse(c.created);
    if (!Number.isNaN(t) && (latest == null || t > latest)) latest = t;
  }
  return latest;
}

/** Convert one issue to a task, folding in any preserved state from the existing one. */
function issueToTask(
  issue: JiraIssue,
  existing: Task | undefined,
  opts: JiraSyncOptions,
  order: number,
  retainedSince: number | null = null,
): Task {
  const rawStatus = issue.fields.status.name;
  const category = categoryFromKey(issue.fields.status.statusCategory.key);
  const column = resolveStatusColumn(rawStatus, category, opts.overrides, opts.learned).column;
  const derivedStatus = statusForColumn(column);

  // `blocked` is an internal-only state — keep it (and its restore target) across syncs.
  // Read from where the card RESTS, not from `status`: a card whose agent is running has
  // lent that field to the run, and a blocked card that is running is still blocked.
  const blocked = existing ? restingStatus(existing) === 'blocked' : false;
  // Where the card should rest once the tracker has had its say.
  const resting = blocked ? 'blocked' : derivedStatus;
  // A live run owns `status` and a poll must not evict it — that would drop the card out
  // of "running" mid-session, and with it the spinner, the drag guard and the chat
  // target. The tracker still decides the COLUMN; it just writes it to the parked value
  // the run will be restored to, so a ticket someone moved in JIRA while the agent worked
  // lands in its new column the moment the run ends.
  const borrowed = existing && isRunStatus(existing.status) ? existing.status : null;

  // Epic/parent key and description drive agent delegation (which repo owns the
  // ticket, and the brief handed to the agent). Both fall back to the previously
  // stored value, so a sync that didn't return the field can't wipe what we knew.
  const parentKey = epicKeyFromIssue(issue, opts.epicFieldId ?? null);
  // Inline parent first (free), then the batch the caller fetched. Same fall-back rule as
  // every field here: a sync that could not resolve the name must not wipe a known one.
  const epicName =
    epicNameFromIssue(issue) ?? (parentKey ? (opts.epicNames?.get(parentKey) ?? null) : null);
  const sprint = sprintNameFromIssue(issue, opts.sprintFieldId ?? null);
  const description = commentBodyToText(issue.fields.description) || null;

  const latestCommentAt = latestForeignCommentTime(issue, opts.identity ?? null);
  // A brand-new task starts "read" (lastRead = latest) so the first sync doesn't turn
  // every card orange; existing tasks keep the user's read marker.
  const lastReadCommentAt = existing ? (existing.lastReadCommentAt ?? null) : latestCommentAt;

  return {
    id: existing?.id ?? `jira-${issue.id}`,
    projectId: PERSONAL_PROJECT_ID,
    // The board shows the JIRA project name as the card's "Project:" label.
    phase: issue.fields.project?.name ?? issue.key.split('-')[0],
    title: issue.fields.summary,
    status: borrowed ?? resting,
    sessionId: null,
    order: existing?.order ?? order,
    dependsOn: [],
    source: 'jira',
    isContract: false,
    isScaffold: false,
    externalSource: 'jira',
    externalKey: issue.key,
    externalId: issue.id,
    externalUrl: `${opts.baseUrl.replace(/\/+$/, '')}/browse/${issue.key}`,
    externalStatus: rawStatus,
    externalStatusCategory: category,
    // Same fall-back rule as the fields below: a search that didn't return `priority`
    // must not wipe the one we already knew — which now matters more than it did, since
    // the user can set this themselves (`task:setPriority`).
    externalPriority: issue.fields.priority?.name ?? existing?.externalPriority ?? null,
    externalType: issue.fields.issuetype?.name ?? null,
    externalLabel: issue.fields.labels?.[0] ?? null,
    externalParentKey: parentKey ?? existing?.externalParentKey ?? null,
    externalEpicName: epicName ?? existing?.externalEpicName ?? null,
    // Same fall-back rule as the epic and description above: a sync that didn't ask
    // for the sprint field must not wipe a name we already knew.
    externalSprint: sprint ?? existing?.externalSprint ?? null,
    externalDescription: description ?? existing?.externalDescription ?? null,
    preBlockStatus: blocked ? (existing?.preBlockStatus ?? null) : null,
    preRunStatus: borrowed ? resting : null,
    // Null for an issue the JQL returned — it is an ordinary card, whatever it was before.
    retainedSince,
    lastReadCommentAt,
    // Keep the newest known comment time: fall back to the prior value if this sync
    // didn't return comments for the issue.
    latestCommentAt: latestCommentAt ?? existing?.latestCommentAt ?? null,
    // The filing and the delegation are both internal-only state, like `blocked` —
    // JIRA knows nothing about either, so a re-sync carries them through untouched.
    projectTagId: existing?.projectTagId ?? null,
    agentProjectId: existing?.agentProjectId ?? null,
  };
}

/**
 * The board card for ONE issue — the freshly-created-issue path, where there is no query
 * to reconcile against and at most one card in play.
 *
 * `existing` is the card the issue lands on. Passing the card you just created locally is
 * what "create the ticket and link it to this task" means: the issue's fields are written
 * onto that same row (same id, so its timeline, its filing and its steps all stay put),
 * rather than a second card appearing beside the one you typed. Pass `undefined` and the
 * issue brings a brand-new card with it, which is what creating a ticket on its own does.
 *
 * Deliberately the SAME `issueToTask` a sync uses: a hand-built card would differ from
 * whatever the next poll produces and appear to mutate on its own.
 */
export function issueToBoardTask(
  issue: JiraIssue,
  existing: Task | undefined,
  opts: JiraSyncOptions,
): Task {
  return issueToTask(issue, existing, opts, existing?.order ?? 0);
}

/**
 * Whether a card that has left the query is one the board **keeps**.
 *
 * Either it is finished — the case this exists for, since the query it just fell out of is
 * almost certainly one that excludes finished work — or it is already being retained, which
 * has to keep counting even after the ticket moves back out of Done. That second clause is
 * what makes reopening a ticket in JIRA visible on the board: without it a retained card
 * would be retired by the very sync that discovered it had come back to life.
 *
 * "Finished" is read off the **column**, not a hand-copied list of statuses, so it cannot
 * drift from what the board shows. That is not a tidy-up: `restingStatus(task) === 'done'`
 * missed `cancelled`, `stopped` and `failed`, all of which sit in the DONE column — so the
 * poll deleted the card you had just decided not to do, out of the column you had just
 * dropped it in, and the only trace was that it was gone.
 */
function isRetained(task: Task): boolean {
  return task.retainedSince != null || columnForTask(task) === 'done';
}

/** JIRA tasks on the board, keyed by issue key. */
function jiraTasksByKey(existing: readonly Task[]): Map<string, Task> {
  return new Map(
    existing
      .filter((t) => t.source === 'jira' && t.externalKey)
      .map((t) => [t.externalKey as string, t]),
  );
}

/**
 * The issue keys the sync must re-read **by key**, because the JQL no longer returns them
 * but the board is keeping their cards anyway.
 *
 * This is what stops a retained card from freezing at the state it was in when it left the
 * query. Move the ticket from Done back to In Progress in JIRA and the JQL may still not
 * match it — `resolution` is only cleared by a workflow post-function, and plenty of
 * workflows do not have one — so the query alone would never mention it again. Asking for it
 * by key always answers, and the card lands in whatever column its real status resolves to.
 *
 * Bounded by construction: only cards already on the board, only ones the query dropped.
 */
export function retainedKeys(existing: readonly Task[], issues: readonly JiraIssue[]): string[] {
  const returned = new Set(issues.map((i) => i.key));
  const keys: string[] = [];
  for (const task of existing) {
    if (task.source !== 'jira' || task.externalKey == null) continue;
    if (returned.has(task.externalKey)) continue;
    if (task.archivedAt != null) continue; // already off the board; nothing left to decide
    if (restingStatus(task) === 'blocked') continue; // never consulted; never deleted
    if (isRetained(task)) keys.push(task.externalKey);
  }
  return keys;
}

/**
 * The issue keys the sync must **confirm** before any of their cards may leave the board —
 * the cards the query did not return and that nothing else is keeping.
 *
 * The companion of {@link retainedKeys}, and its complement: that one asks about cards the
 * board is keeping *anyway*, this one about cards the board would otherwise drop. Together
 * they cover every card the query left out.
 *
 * The point is the direction of the question. Asking the JQL and seeing what comes back
 * cannot distinguish "this ticket no longer matches" from "this page was short", and the
 * board pays for the difference by the card. Asking `(<the query>) AND key in (…)` about a
 * bounded, board-sized list has an answer that can be trusted in the negative — see
 * `jiraJql.withKeysIn`.
 *
 * Bounded by the **board** rather than the query: at most one key per card already on it,
 * however many issues the instance holds.
 */
export function removalCandidateKeys(
  existing: readonly Task[],
  issues: readonly JiraIssue[],
): string[] {
  const returned = new Set(issues.map((i) => i.key));
  const keys: string[] = [];
  for (const task of existing) {
    if (task.source !== 'jira' || task.externalKey == null) continue;
    if (returned.has(task.externalKey)) continue;
    if (task.archivedAt != null) continue; // already off the board
    if (restingStatus(task) === 'blocked') continue; // never consulted; never removed
    if (isRetained(task)) continue; // {@link retainedKeys} asks about these, by key
    keys.push(task.externalKey);
  }
  return keys;
}

/**
 * Refuse a removal set that is too big a share of the board to believe.
 *
 * Every removal below has an answer from JIRA behind it, so this is not a second opinion on
 * any one card — it is a bound on how wrong one sync is allowed to be. A credential that
 * silently narrowed, a filter someone half-edited, an instance answering a query with
 * something odd: the failure mode they share is *many cards at once*, and taking a third of
 * a board off in one poll is the kind of thing to stop and report rather than do and log.
 *
 * Two dials, and the second matters as much as the first: on a four-card board every honest
 * removal is a quarter of it, so nothing under {@link DEFAULT_MIN_GUARDED_REMOVALS} is
 * guarded at all.
 *
 * It stands down entirely when `queryChanged` — a new sprint, an edited JQL. The board is
 * *meant* to turn over then, and a guard that fires on the one expected mass removal would
 * be teaching the human to ignore it.
 *
 * All or nothing: a partial removal would leave the board in a state no question produced.
 */
export function guardRemovals(
  removals: readonly JiraRemoval[],
  boardCount: number,
  opts: {
    maxRemovalFraction?: number;
    minGuardedRemovals?: number;
    queryChanged?: boolean;
  } = {},
): JiraRemovalGuard {
  const allowed: JiraRemovalGuard = { removals: [...removals], refused: [], warning: null };
  if (opts.queryChanged) return allowed;

  const fraction = opts.maxRemovalFraction ?? DEFAULT_MAX_REMOVAL_FRACTION;
  const floor = opts.minGuardedRemovals ?? DEFAULT_MIN_GUARDED_REMOVALS;
  if (removals.length < floor) return allowed;
  if (removals.length <= boardCount * fraction) return allowed;

  const pct = Math.round(fraction * 100);
  return {
    removals: [],
    refused: [...removals],
    warning:
      `Kept ${removals.length} of ${boardCount} JIRA cards that JIRA says have left the ` +
      `query — more than ${pct}% of the board in one sync. Nothing was removed. Check the ` +
      `board's JQL and that JIRA is answering it in full.`,
  };
}

/**
 * Reconcile the JQL result against the current Personal-board tasks. Ad-hoc tasks are
 * never touched.
 *
 * **The rule this function exists to enforce: no card leaves the board unless JIRA was
 * asked about it by key and answered.** A short page, a failed batch, a question nobody
 * put — every one of them means *keep*. Absence from the query is a hint, never a verdict:
 * the search is paged, it is capped, and an instance that answers with ninety issues
 * instead of three hundred is indistinguishable, from here, from a board that shrank to
 * ninety. That mistake is not symmetric — a card wrongly kept is a stale row you can drag
 * away, a card wrongly removed is work the human can no longer see.
 *
 * So every fate below names the question behind it:
 *
 *   1. **blocked** — untouched. An internal-only state JIRA is never asked about.
 *   2. **archived** — already off the board. Back in the query ⇒ it returns (`restoreIds`);
 *      still absent ⇒ nothing to say.
 *   3. **the search was truncated** — everything is kept, whatever else is true of it.
 *   4. **never asked about** (`queryChecked` has no such key) — kept.
 *   5. **asked, and JIRA says it still matches** (`queryMatches`) — kept, and counted: this
 *      is a *paging artifact*, the case that was eating the board, and the count is the most
 *      diagnostic number this function produces.
 *   6. **asked, and JIRA says it no longer matches** — `left-query`.
 *   7. **retained past its window** — `retention-expired`.
 *   8. **retained, its batch failed** (`recheckedKeys` has no such key) — kept.
 *   9. **retained, asked for by key, and JIRA does not have it** — `gone-from-jira`.
 *  10. otherwise — upserted from the re-read issue, with its retention clock preserved.
 *
 * Whatever survives all that is then put to {@link guardRemovals}, **here** rather than in
 * the caller: a guard the caller can forget to apply is not a guard.
 */
export function reconcileJiraTasks(
  existing: Task[],
  issues: JiraIssue[],
  opts: JiraSyncOptions,
): JiraSyncResult {
  const existingByKey = jiraTasksByKey(existing);
  const seen = new Set<string>();
  const restoreIds: string[] = [];

  const upserts = issues.map((issue, i) => {
    seen.add(issue.key);
    const prior = existingByKey.get(issue.key);
    // Archived, and the query returns it again: the ticket matches, so the card comes back
    // to the board — the same row, with the timeline, files and links it left with.
    if (prior?.archivedAt != null) restoreIds.push(prior.id);
    return issueToTask(issue, prior, opts, i);
  });

  const rechecked = opts.rechecked ? new Map(opts.rechecked.map((i) => [i.key, i])) : null;
  const recheckedKeys = asSet(opts.recheckedKeys);
  const queryChecked = asSet(opts.queryChecked);
  const queryMatches = asSet(opts.queryMatches);
  const truncated = opts.truncated === true;

  const candidates: JiraRemoval[] = [];
  /** Cards the query left out that JIRA says still match it — a short page, not a removal. */
  let pagingArtifacts = 0;

  /**
   * The one funnel every removal goes through, so `truncated` cannot be forgotten in a
   * branch: a search we know was short removes nothing, for any reason.
   */
  const drop = (task: Task, reason: JiraRemovalReason): void => {
    if (truncated) return;
    candidates.push({
      taskId: task.id,
      key: task.externalKey as string,
      title: task.title,
      reason,
    });
  };

  for (const task of existing) {
    if (task.source !== 'jira' || task.externalKey == null || seen.has(task.externalKey)) continue;
    // Already off the board, and the query has not brought it back: say nothing about it.
    if (task.archivedAt != null) continue;
    // Keep blocked tickets even if they left the JQL — and read where the card RESTS, so one
    // whose agent is mid-run isn't removed out from under the session.
    if (restingStatus(task) === 'blocked') continue;

    if (!isRetained(task)) {
      // Nobody put the question: the confirm pass did not run, or did not cover this key
      // (its batch failed, or the key was added after the pass was built).
      if (queryChecked === null || !queryChecked.has(task.externalKey)) continue;
      // Asked, and JIRA says the query DOES still return it — so the search that left it
      // out was short, not authoritative. Keeping it is the fix; counting it is the
      // evidence that this is what has been happening.
      if (queryMatches?.has(task.externalKey)) {
        pagingArtifacts++;
        continue;
      }
      drop(task, 'left-query');
      continue;
    }

    const now = opts.now ?? Date.now();
    const since = task.retainedSince ?? now;
    // `>=`, so a retention of 0 retires the card on the very sync that dropped it.
    if (now - since >= (opts.retentionMs ?? 0)) {
      drop(task, 'retention-expired');
      continue;
    }
    // The re-read didn't run (or failed). Keep the card untouched rather than retire it on
    // a question nobody put — its clock simply starts on the next sync that does ask.
    if (rechecked === null) continue;
    // Same rule one level finer: this key's own batch errored, so `rechecked` not listing
    // it says nothing at all. One dead key 400s the fifty around it.
    if (recheckedKeys !== null && !recheckedKeys.has(task.externalKey)) continue;
    const issue = rechecked.get(task.externalKey);
    // JIRA answered and does not have it: deleted, or no longer visible to this token.
    if (!issue) {
      drop(task, 'gone-from-jira');
      continue;
    }
    upserts.push(issueToTask(issue, task, opts, task.order, since));
  }

  // The denominator is the BOARD — the cards a human can see — not the query's answer,
  // which is the very thing under suspicion when this guard matters.
  const boardCount = existing.filter(
    (t) => t.source === 'jira' && t.externalKey != null && t.archivedAt == null,
  ).length;
  const guarded = guardRemovals(candidates, boardCount, opts);

  const notes: string[] = [];
  if (truncated) {
    notes.push(
      'JIRA did not return the whole query, so no card was removed from the board this sync.',
    );
  }
  if (pagingArtifacts > 0) {
    notes.push(
      `${pagingArtifacts} card${pagingArtifacts === 1 ? '' : 's'} missing from the search ` +
        `still match the query — a paging artifact, not a removal. They were kept.`,
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
