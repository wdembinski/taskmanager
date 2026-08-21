/**
 * Pure reconciliation of fetched GitLab merge requests into stored ones.
 *
 * Mirrors `jira/jiraSync.ts`: no DB, no Electron — the IPC layer applies the returned
 * upserts and deletes. Keyed by `gl-{repoId}-{number}`, so an MR keeps its identity (and
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
  mrIsSettled,
  mrReadyToMerge,
  type MergeRequest,
  type MergeRequestState,
  type PipelineStage,
  type PipelineStatus,
} from '@shared/mergeRequest';
import { gitlabAuthorIsMe, type GitLabIdentityCache } from './identity';
import { discoverIssueKeys, pickTaskKey } from '../forge/issueKeys';
import { latestForeignNoteAt, type ForgeNote } from '../forge/notes';

// Both forge-neutral rules that happened to live here; moved out to `forge/refreshPolicy.ts`
// and re-exported so every existing import site — `ipc.ts` and GitHub's `githubPrSync.ts` —
// is untouched.
export { needsDetailRefresh, PIPELINE_IN_FLIGHT } from '../forge/refreshPolicy';

/** What one fetched MR looks like once the client's shapes are narrowed. */
export interface FetchedMergeRequest {
  repoId: number;
  number: number;
  projectPath: string;
  title: string;
  description: string | null;
  webUrl: string;
  sourceBranch: string;
  targetBranch: string;
  state: MergeRequestState;
  draft: boolean;
  pipelineStatus: PipelineStatus;
  pipelineStages: PipelineStage[];
  pipelineUrl: string | null;
  approvalsRequired: number | null;
  approvalsGiven: number;
  changesRequested: boolean;
  /** GitLab's `detailed_merge_status`, or null when this sync could not read it. */
  detailedMergeStatus: string | null;
  hasConflicts: boolean;
  updatedAt: number;
  /**
   * Human notes, when this sync fetched them. Undefined = "not re-read this time".
   *
   * The provider-NEUTRAL shape (`forge/notes.ts`), not GitLab's wire type: a GitHub pull
   * request fills this in from three endpoints of its own, and the reconcilers must be able
   * to ask the same question of both. The forge maps its payload on the way in.
   */
  notes?: ForgeNote[];
}

export interface GitLabSyncOptions {
  /** Every `externalKey` on the board, so a key nothing carries is not a key. */
  knownKeys: readonly string[];
  /** JIRA key → board task id, for filing a matched MR. */
  taskIdByKey: ReadonlyMap<string, string>;
  /**
   * Every card id on the board, so a remembered link can be checked against it.
   *
   * `MergeRequest.openedForTaskId` outlives the card it names — a card can be deleted or
   * archived while its merge request is still open upstream — and a row filed under a card
   * that is no longer there is exactly the orphan `taskId: null` exists to describe. So the
   * link is honoured only while the card is on the board, and falls back to matching by key
   * the moment it is not.
   */
  knownTaskIds: ReadonlySet<string>;
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

export function mergeRequestId(repoId: number, number: number): string {
  return `gl-${repoId}-${number}`;
}

/**
 * Which board task a STORED MR belongs to, given the board as it is now.
 *
 * Re-matching only sees the fields we store, and the description is not one of them — so a
 * key discovered from the description on the last real sync is kept rather than forgotten.
 *
 * A card this app opened the MR FOR beats all of it, and that ordering is the point rather
 * than a tie-break: everything below is an attempt to work out which card an MR belongs to
 * from what the forge says about it, and `openedForTaskId` is not an attempt — it is the
 * answer, recorded at the moment the button was pressed. See {@link MergeRequest.openedForTaskId}.
 */
function matchTaskId(
  mr: Pick<MergeRequest, 'title' | 'sourceBranch' | 'issueKeys' | 'openedForTaskId'>,
  opts: Pick<GitLabSyncOptions, 'knownKeys' | 'taskIdByKey' | 'knownTaskIds'>,
): string | null {
  if (mr.openedForTaskId && opts.knownTaskIds.has(mr.openedForTaskId)) return mr.openedForTaskId;
  const found = discoverIssueKeys(
    { title: mr.title, sourceBranch: mr.sourceBranch },
    opts.knownKeys,
  );
  const keys = found.length ? found : mr.issueKeys.filter((k) => opts.knownKeys.includes(k));
  const key = pickTaskKey(keys);
  return key ? (opts.taskIdByKey.get(key) ?? null) : null;
}

/**
 * Reconcile the fetched MRs against what is stored.
 *
 * The fetch is `state=opened`, so an MR that dropped out of it has either **landed** or
 * been closed. Those two used to be the same case — deleted — which is why merging an MR
 * made it disappear off the card that had been carrying it: the one moment you most want
 * the card to say "this shipped" was the moment the row vanished.
 *
 * So a SETTLED MR is retained, as long as it still names a card on the board. It is that
 * card's history: no ring (see `mrNeedsAttention`), no further network calls (its state is
 * terminal, so there is nothing left to re-read), and a merged/closed verdict where the
 * approval tick used to be. Everything else that dropped out is deleted as before —
 * including a settled MR whose ticket has since left the board, which is what stops the
 * table growing without bound.
 *
 * A stored MR whose task has since left the board but which is still OPEN is not deleted
 * either: it keeps `taskId: null` and is re-matched every sync, so a JQL change does not
 * throw away its read markers.
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
    const id = mergeRequestId(mr.repoId, mr.number);
    seen.add(id);
    const prior = byId.get(id);

    const issueKeys = discoverIssueKeys(
      { title: mr.title, description: mr.description, sourceBranch: mr.sourceBranch },
      opts.knownKeys,
    );
    const key = pickTaskKey(issueKeys);
    // The card that opened it, if we opened it and that card is still on the board; the key
    // this fetch found otherwise. A sync must not be able to un-file a merge request from
    // the card it was opened for — see {@link matchTaskId}.
    const openedForTaskId = prior?.openedForTaskId ?? null;
    const taskId =
      openedForTaskId && opts.knownTaskIds.has(openedForTaskId)
        ? openedForTaskId
        : key
          ? (opts.taskIdByKey.get(key) ?? null)
          : null;

    // Notes are only re-read for MRs that changed, so an absent list means "keep what
    // we knew" rather than "there are none".
    const latestNoteAt = mr.notes
      ? (latestForeignNoteAt(mr.notes, (n) => gitlabAuthorIsMe(n.author, opts.identity)) ??
        prior?.latestNoteAt ??
        null)
      : (prior?.latestNoteAt ?? null);

    // An event fires on the TRANSITION, never on a steady state — otherwise "Mark seen"
    // would be undone by the very next poll.
    const wentRed =
      BAD_PIPELINES.has(mr.pipelineStatus) &&
      !BAD_PIPELINES.has(prior?.pipelineStatus ?? 'unknown');
    const approvalsDropped = prior !== undefined && mr.approvalsGiven < prior.approvalsGiven;
    const nowRequested = mr.changesRequested && !prior?.changesRequested;
    // Becoming ready to merge is an event too — the good one. Same transition discipline as
    // `wentRed`, and for the same reason: an MR that is steadily green and approved would
    // otherwise re-raise itself on every poll, so "Acknowledge pipeline" would never stick
    // and the ring would follow the MR until somebody merged it.
    const becameReady = mrReadyToMerge(mr) && !(prior !== undefined && mrReadyToMerge(prior));
    const lastEventAt =
      wentRed || approvalsDropped || nowRequested || becameReady
        ? opts.now
        : (prior?.lastEventAt ?? null);

    upserts.push({
      id,
      taskId,
      // Carried, never re-derived — the same rule the read markers and the local rename
      // follow, and for the same reason: GitLab has never heard of it.
      openedForTaskId,
      provider: 'gitlab',
      repoId: mr.repoId,
      projectPath: mr.projectPath,
      number: mr.number,
      title: mr.title,
      webUrl: mr.webUrl,
      sourceBranch: mr.sourceBranch,
      targetBranch: mr.targetBranch,
      state: mr.state,
      draft: mr.draft,
      pipelineStatus: mr.pipelineStatus,
      pipelineStages: mr.pipelineStages,
      pipelineUrl: mr.pipelineUrl,
      approvalsRequired: mr.approvalsRequired,
      approvalsGiven: mr.approvalsGiven,
      changesRequested: mr.changesRequested,
      // Same fall-back rule as the pipeline and the notes: a sync that did not re-read the
      // detail keeps what we knew, rather than blanking GitLab's verdict into "unknown" —
      // which `mergeBlockers` would then read as one fewer reason not to merge.
      detailedMergeStatus: mr.detailedMergeStatus ?? prior?.detailedMergeStatus ?? null,
      hasConflicts: mr.hasConflicts,
      issueKeys,
      latestNoteAt,
      // The user's own markers survive every sync — they are the one thing GitLab
      // knows nothing about. A local rename is the same kind of field: nothing upstream can
      // change it, so it is carried rather than re-derived.
      displayName: prior?.displayName ?? null,
      lastReadAt: prior?.lastReadAt ?? null,
      lastEventAt,
      lastEventSeenAt: prior?.lastEventSeenAt ?? null,
      updatedAt: mr.updatedAt,
      syncedAt: opts.now,
    });
  }

  const deleteIds: string[] = [];
  for (const mr of existing) {
    if (seen.has(mr.id)) continue;
    // Settled and still filed under a card: keep it, re-matched against the board as it is
    // now — a card whose ticket has left takes its merged MRs with it on the next pass.
    if (mrIsSettled(mr)) {
      const taskId = matchTaskId(mr, opts);
      if (taskId !== null) {
        if (taskId !== mr.taskId) upserts.push({ ...mr, taskId });
        continue;
      }
    }
    deleteIds.push(mr.id);
  }

  return { upserts, deleteIds };
}

/**
 * The cards whose work this sync says has **landed** — one entry per card with a merge
 * request GitLab reports as `merged`.
 *
 * This is the other half of `Task.landedAt`, and the one that matters for a team: the app
 * only ever does the merging itself for a project it integrates locally, whereas a card
 * whose branch goes through review lands when somebody clicks Merge in GitLab, which the
 * app learns about here and nowhere else. Without it, an `after-merge` chain on a
 * review-based project would wait forever for a merge that had already happened.
 *
 * No setting gates it, and none is needed: a local-only project has no merge-request rows,
 * so this simply returns nothing for one. Filtering is left to the caller, which is
 * idempotent — a merged MR is retained on its card and re-reported on every poll.
 */
export function landedTaskIds(mrs: readonly MergeRequest[]): string[] {
  const ids = new Set<string>();
  for (const mr of mrs) if (mr.state === 'merged' && mr.taskId) ids.add(mr.taskId);
  return [...ids];
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
  opts: Pick<GitLabSyncOptions, 'knownKeys' | 'taskIdByKey' | 'knownTaskIds'>,
): MergeRequest[] {
  const changed: MergeRequest[] = [];
  for (const mr of existing) {
    const taskId = matchTaskId(mr, opts);
    if (taskId !== mr.taskId) changed.push({ ...mr, taskId });
  }
  return changed;
}
