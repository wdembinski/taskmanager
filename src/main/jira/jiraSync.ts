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
 */
import { PERSONAL_PROJECT_ID, type BoardColumn, type Task } from '@shared/model';
import { categoryFromKey, isRunStatus, restingStatus, statusForColumn } from '@shared/board';
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

export interface JiraSyncResult {
  /** JIRA tasks to insert or update (new + changed issues). */
  upserts: Task[];
  /** Ids of JIRA tasks to delete (no longer in the JQL result and not blocked). */
  deleteIds: string[];
}

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
 */
function isRetained(task: Task): boolean {
  return task.retainedSince != null || restingStatus(task) === 'done';
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
    if (restingStatus(task) === 'blocked') continue; // never consulted; never deleted
    if (isRetained(task)) keys.push(task.externalKey);
  }
  return keys;
}

/**
 * Reconcile the JQL result against the current Personal-board tasks. Ad-hoc tasks are
 * never touched. Returns the JIRA upserts and the ids of stale (removable) JIRA tasks.
 *
 * A card the query dropped meets one of four fates:
 *
 *   1. **blocked** — left exactly as it is. An internal-only state JIRA is never asked about.
 *   2. **not retained** — deleted, as it always was: the query is the board.
 *   3. **retained and re-read** — upserted from the re-read issue, so it shows the ticket's
 *      real status and column while keeping its retention clock running.
 *   4. **retained too long, or JIRA no longer returns it** — deleted.
 */
export function reconcileJiraTasks(
  existing: Task[],
  issues: JiraIssue[],
  opts: JiraSyncOptions,
): JiraSyncResult {
  const existingByKey = jiraTasksByKey(existing);
  const seen = new Set<string>();

  const upserts = issues.map((issue, i) => {
    seen.add(issue.key);
    return issueToTask(issue, existingByKey.get(issue.key), opts, i);
  });

  const rechecked = opts.rechecked ? new Map(opts.rechecked.map((i) => [i.key, i])) : null;
  const deleteIds: string[] = [];

  for (const task of existing) {
    if (task.source !== 'jira' || task.externalKey == null || seen.has(task.externalKey)) continue;
    // Keep blocked tickets even if they left the JQL — and read where the card RESTS, so one
    // whose agent is mid-run isn't deleted out from under the session.
    if (restingStatus(task) === 'blocked') continue;
    if (!isRetained(task)) {
      deleteIds.push(task.id);
      continue;
    }
    const now = opts.now ?? Date.now();
    const since = task.retainedSince ?? now;
    // `>=`, so a retention of 0 retires the card on the very sync that dropped it.
    if (now - since >= (opts.retentionMs ?? 0)) {
      deleteIds.push(task.id);
      continue;
    }
    // The re-read didn't run (or failed). Keep the card untouched rather than retire it on
    // a question nobody put — its clock simply starts on the next sync that does ask.
    if (rechecked === null) continue;
    const issue = rechecked.get(task.externalKey);
    // JIRA answered and does not have it: deleted, or no longer visible to this token.
    if (!issue) {
      deleteIds.push(task.id);
      continue;
    }
    upserts.push(issueToTask(issue, task, opts, task.order, since));
  }

  return { upserts, deleteIds };
}
