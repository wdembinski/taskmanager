/**
 * Pure reconciliation of fetched JIRA issues into Personal-board tasks (Phase C).
 * Mirrors `taskReconcile` in spirit: no DB, no Electron — the IPC layer applies the
 * returned upserts/deletes to the store. Keyed by issue key so a task keeps its id
 * (and thus its activity timeline + unread markers) across syncs.
 *
 * Internal-only state is preserved: a task the user moved to `blocked` stays blocked
 * (JIRA is never consulted for blocking), and blocked tasks that drop out of the JQL
 * result are NOT deleted, so a blocked ticket never silently vanishes.
 */
import { PERSONAL_PROJECT_ID, type BoardColumn, type Task } from '@shared/model';
import { categoryFromKey, categoryToColumn, statusForColumn } from '@shared/board';
import { commentBodyToText, type JiraIssue } from './jiraClient';
import { epicKeyFromIssue } from './epicField';

export interface JiraSyncOptions {
  /** Base URL, used to build each issue's deep link. */
  baseUrl: string;
  /** Optional raw-status-name → column overrides. */
  overrides?: Record<string, BoardColumn>;
  /**
   * The discovered "Epic Link" custom field id, or null when the instance has none
   * (Cloud team-managed) or discovery failed — the epic then comes from `parent`.
   */
  epicFieldId?: string | null;
}

export interface JiraSyncResult {
  /** JIRA tasks to insert or update (new + changed issues). */
  upserts: Task[];
  /** Ids of JIRA tasks to delete (no longer in the JQL result and not blocked). */
  deleteIds: string[];
}

/** Newest comment time (epoch ms) from an issue's inline comments, or null. */
function latestCommentTime(issue: JiraIssue): number | null {
  const comments = issue.fields.comment?.comments ?? [];
  let latest: number | null = null;
  for (const c of comments) {
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
): Task {
  const rawStatus = issue.fields.status.name;
  const category = categoryFromKey(issue.fields.status.statusCategory.key);
  const column = opts.overrides?.[rawStatus] ?? categoryToColumn(category);
  const derivedStatus = statusForColumn(column);

  // `blocked` is an internal-only state — keep it (and its restore target) across syncs.
  const blocked = existing?.status === 'blocked';

  // Epic/parent key and description drive agent delegation (which repo owns the
  // ticket, and the brief handed to the agent). Both fall back to the previously
  // stored value, so a sync that didn't return the field can't wipe what we knew.
  const parentKey = epicKeyFromIssue(issue, opts.epicFieldId ?? null);
  const description = commentBodyToText(issue.fields.description) || null;

  const latestCommentAt = latestCommentTime(issue);
  // A brand-new task starts "read" (lastRead = latest) so the first sync doesn't turn
  // every card orange; existing tasks keep the user's read marker.
  const lastReadCommentAt = existing ? (existing.lastReadCommentAt ?? null) : latestCommentAt;

  return {
    id: existing?.id ?? `jira-${issue.id}`,
    projectId: PERSONAL_PROJECT_ID,
    // The board shows the JIRA project name as the card's "Project:" label.
    phase: issue.fields.project?.name ?? issue.key.split('-')[0],
    title: issue.fields.summary,
    status: blocked ? 'blocked' : derivedStatus,
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
    externalPriority: issue.fields.priority?.name ?? null,
    externalType: issue.fields.issuetype?.name ?? null,
    externalLabel: issue.fields.labels?.[0] ?? null,
    externalParentKey: parentKey ?? existing?.externalParentKey ?? null,
    externalDescription: description ?? existing?.externalDescription ?? null,
    preBlockStatus: blocked ? (existing?.preBlockStatus ?? null) : null,
    lastReadCommentAt,
    // Keep the newest known comment time: fall back to the prior value if this sync
    // didn't return comments for the issue.
    latestCommentAt: latestCommentAt ?? existing?.latestCommentAt ?? null,
    // Agent delegation is internal-only state, like `blocked` — JIRA knows nothing
    // about it, so a re-sync carries the existing assignment through untouched.
    agentProjectId: existing?.agentProjectId ?? null,
  };
}

/**
 * Reconcile the JQL result against the current Personal-board tasks. Ad-hoc tasks are
 * never touched. Returns the JIRA upserts and the ids of stale (removable) JIRA tasks.
 */
export function reconcileJiraTasks(
  existing: Task[],
  issues: JiraIssue[],
  opts: JiraSyncOptions,
): JiraSyncResult {
  const existingByKey = new Map(
    existing
      .filter((t) => t.source === 'jira' && t.externalKey)
      .map((t) => [t.externalKey as string, t]),
  );
  const seen = new Set<string>();

  const upserts = issues.map((issue, i) => {
    seen.add(issue.key);
    return issueToTask(issue, existingByKey.get(issue.key), opts, i);
  });

  const deleteIds = existing
    .filter(
      (t) =>
        t.source === 'jira' &&
        t.externalKey != null &&
        !seen.has(t.externalKey) &&
        t.status !== 'blocked', // keep blocked tickets even if they left the JQL
    )
    .map((t) => t.id);

  return { upserts, deleteIds };
}
