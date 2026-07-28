/**
 * Pure reconciliation of fetched GitLab merge requests into stored ones.
 *
 * Mirrors `jira/jiraSync.ts`: no DB, no Electron — the IPC layer applies the returned
 * upserts and deletes. Keyed by `gl-{projectId}-{iid}`, so an MR keeps its identity (and
 * therefore its read markers) across syncs.
 *
 * Two things here are easy to get wrong, and both are about NOT shouting:
 *
 *  - `lastEventAt` moves only when a pipeline *transitions into* failed/canceled, or
 *    when approvals *drop*. Bumping it while a pipeline is steadily red would re-raise
 *    the alarm on every poll, so "Mark seen" would never stick.
 *  - `latestNoteAt` counts only notes that are not yours, for the same reason JIRA's
 *    does — see `identity.ts`.
 */
import {
  type MergeRequest,
  type MergeRequestState,
  type PipelineStatus,
} from '@shared/mergeRequest';
import { gitlabAuthorIsMe, type GitLabIdentityCache } from './identity';
import { discoverIssueKeys, pickTaskKey } from './mrMatch';
import type { GitLabNote } from './gitlabClient';

/** What one fetched MR looks like once the client's shapes are narrowed. */
export interface FetchedMergeRequest {
  gitlabProjectId: number;
  iid: number;
  projectPath: string;
  title: string;
  description: string | null;
  webUrl: string;
  sourceBranch: string;
  targetBranch: string;
  state: MergeRequestState;
  draft: boolean;
  pipelineStatus: PipelineStatus;
  pipelineUrl: string | null;
  approvalsRequired: number | null;
  approvalsGiven: number;
  changesRequested: boolean;
  updatedAt: number;
  /** Human notes, when this sync fetched them. Undefined = "not re-read this time". */
  notes?: GitLabNote[];
}

export interface GitLabSyncOptions {
  /** Every `externalKey` on the board, so a key nothing carries is not a key. */
  knownKeys: readonly string[];
  /** JIRA key → board task id, for filing a matched MR. */
  taskIdByKey: ReadonlyMap<string, string>;
  identity: GitLabIdentityCache | null;
  now: number;
}

export interface GitLabSyncResult {
  upserts: MergeRequest[];
  /** Ids of stored MRs that are no longer open and can go. */
  deleteIds: string[];
}

/** Pipelines that mean "something broke", as opposed to "still running". */
const BAD_PIPELINES: ReadonlySet<PipelineStatus> = new Set(['failed', 'canceled']);

export function mergeRequestId(gitlabProjectId: number, iid: number): string {
  return `gl-${gitlabProjectId}-${iid}`;
}

/** Newest note NOT written by you, in epoch ms, or null. */
function latestForeignNoteAt(
  notes: readonly GitLabNote[],
  identity: GitLabIdentityCache | null,
): number | null {
  let latest: number | null = null;
  for (const note of notes) {
    if (gitlabAuthorIsMe(note.author, identity)) continue;
    const at = Date.parse(note.created_at);
    if (!Number.isNaN(at) && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

/**
 * Reconcile the fetched MRs against what is stored.
 *
 * MRs that dropped out of the fetch are deleted — the fetch is `state=opened`, so
 * dropping out means merged or closed, and a landed MR is not news. A stored MR whose
 * task has since left the board is NOT deleted: it keeps `taskId: null` and is re-matched
 * every sync, so a JQL change does not throw away its read markers.
 */
export function reconcileMergeRequests(
  existing: readonly MergeRequest[],
  fetched: readonly FetchedMergeRequest[],
  opts: GitLabSyncOptions,
): GitLabSyncResult {
  const byId = new Map(existing.map((mr) => [mr.id, mr]));
  const upserts: MergeRequest[] = [];
  const seen = new Set<string>();

  for (const mr of fetched) {
    const id = mergeRequestId(mr.gitlabProjectId, mr.iid);
    seen.add(id);
    const prior = byId.get(id);

    const issueKeys = discoverIssueKeys(
      { title: mr.title, description: mr.description, sourceBranch: mr.sourceBranch },
      opts.knownKeys,
    );
    const key = pickTaskKey(issueKeys);
    const taskId = key ? (opts.taskIdByKey.get(key) ?? null) : null;

    // Notes are only re-read for MRs that changed, so an absent list means "keep what
    // we knew" rather than "there are none".
    const latestNoteAt = mr.notes
      ? (latestForeignNoteAt(mr.notes, opts.identity) ?? prior?.latestNoteAt ?? null)
      : (prior?.latestNoteAt ?? null);

    // An event fires on the TRANSITION, never on a steady state — otherwise "Mark seen"
    // would be undone by the very next poll.
    const wentRed = BAD_PIPELINES.has(mr.pipelineStatus) && !BAD_PIPELINES.has(prior?.pipelineStatus ?? 'unknown');
    const approvalsDropped = prior !== undefined && mr.approvalsGiven < prior.approvalsGiven;
    const nowRequested = mr.changesRequested && !prior?.changesRequested;
    const lastEventAt =
      wentRed || approvalsDropped || nowRequested ? opts.now : (prior?.lastEventAt ?? null);

    upserts.push({
      id,
      taskId,
      provider: 'gitlab',
      gitlabProjectId: mr.gitlabProjectId,
      projectPath: mr.projectPath,
      iid: mr.iid,
      title: mr.title,
      webUrl: mr.webUrl,
      sourceBranch: mr.sourceBranch,
      targetBranch: mr.targetBranch,
      state: mr.state,
      draft: mr.draft,
      pipelineStatus: mr.pipelineStatus,
      pipelineUrl: mr.pipelineUrl,
      approvalsRequired: mr.approvalsRequired,
      approvalsGiven: mr.approvalsGiven,
      changesRequested: mr.changesRequested,
      issueKeys,
      latestNoteAt,
      // The user's own markers survive every sync — they are the one thing GitLab
      // knows nothing about.
      lastReadAt: prior?.lastReadAt ?? null,
      lastEventAt,
      lastEventSeenAt: prior?.lastEventSeenAt ?? null,
      updatedAt: mr.updatedAt,
      syncedAt: opts.now,
    });
  }

  // Re-match anything the fetch didn't return: the MR is still open (we only delete
  // what GitLab stopped listing), but the board may have gained the card it names.
  const deleteIds: string[] = [];
  for (const mr of existing) {
    if (seen.has(mr.id)) continue;
    deleteIds.push(mr.id);
  }

  return { upserts, deleteIds };
}

/**
 * Re-file stored MRs against the board as it is now, without touching GitLab.
 *
 * Called when the board changes (a sync, a JQL edit): an MR whose ticket has just
 * appeared should attach itself, and one whose ticket has left should let go rather
 * than point at a card that no longer exists.
 */
export function rematchMergeRequests(
  existing: readonly MergeRequest[],
  opts: Pick<GitLabSyncOptions, 'knownKeys' | 'taskIdByKey'>,
): MergeRequest[] {
  const changed: MergeRequest[] = [];
  for (const mr of existing) {
    const issueKeys = discoverIssueKeys(
      { title: mr.title, sourceBranch: mr.sourceBranch },
      opts.knownKeys,
    );
    // Keep what we discovered from the description on the last real sync: re-matching
    // only sees the fields we store, so a description-only key must not be forgotten.
    const keys = issueKeys.length ? issueKeys : mr.issueKeys.filter((k) => opts.knownKeys.includes(k));
    const key = pickTaskKey(keys);
    const taskId = key ? (opts.taskIdByKey.get(key) ?? null) : null;
    if (taskId !== mr.taskId) changed.push({ ...mr, taskId });
  }
  return changed;
}
