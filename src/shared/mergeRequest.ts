/**
 * A GitLab merge request, as the board understands one.
 *
 * The point of the integration: the MR for a ticket lives in a different tool from the
 * ticket, so "is this actually done?" needs two tabs. Putting the MR on the card that
 * carries its JIRA key answers it in one glance — and, more usefully, lets a red
 * pipeline or a review comment raise the SAME orange ring an unread ticket comment does.
 *
 * Pure types and predicates, shared by the engine and the UI so the ring and the card
 * ordering cannot disagree about what "wants you" means.
 */

/** The upstream state of an MR, as GitLab reports it. */
export type MergeRequestState = 'opened' | 'merged' | 'closed' | 'locked';

/** A CI pipeline's outcome. `unknown` when the MR carries no pipeline we could read. */
export type PipelineStatus =
  | 'unknown'
  | 'created'
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'canceled'
  | 'skipped'
  | 'manual';

/**
 * One stage of the head pipeline, folded from its jobs.
 *
 * A single overall status answers "is CI green", but not "how far has it got" or "which
 * part broke" — which is the question you actually have while an MR waits. GitLab has no
 * stage endpoint, so these are derived from the pipeline's jobs (see `pipelineStages.ts`).
 */
export interface PipelineStage {
  name: string;
  status: PipelineStatus;
}

export interface MergeRequest {
  /** `gl-{projectId}-{iid}` — stable across syncs and unique per instance. */
  id: string;
  /** The board task this MR was matched to, or null while nothing claims it. */
  taskId: string | null;
  provider: 'gitlab';
  gitlabProjectId: number;
  /** `group/subgroup/repo`, for display. */
  projectPath: string;
  /** The per-project MR number — what `!123` means to a human. */
  iid: number;
  title: string;
  webUrl: string;
  sourceBranch: string;
  targetBranch: string;
  state: MergeRequestState;
  draft: boolean;
  pipelineStatus: PipelineStatus;
  pipelineUrl: string | null;
  /**
   * The head pipeline's stages, in pipeline order. Empty when the jobs could not be read
   * (the endpoint is permission-gated on some instances) — never a claim that a pipeline
   * has no stages, so the UI falls back to the single overall status.
   */
  pipelineStages: PipelineStage[];
  /**
   * How many approvals the project requires, or null when we could not find out —
   * `/approvals` is tier-gated and 403s on some instances. Null must render as
   * "approvals unknown" rather than a confident and wrong `0/0`.
   */
  approvalsRequired: number | null;
  approvalsGiven: number;
  /**
   * Whether a reviewer asked for changes. Needs GitLab ≥16 and is tier-gated on some
   * paths, so a drop in `approvalsGiven` since the last sync stands in for it where the
   * reviewer state is not available.
   */
  changesRequested: boolean;
  /** Every JIRA key found in the branch, title or description. */
  issueKeys: string[];
  /** Epoch ms of the newest note NOT written by you, or null. */
  latestNoteAt: number | null;
  /** Epoch ms the user last read this MR's discussion. */
  lastReadAt: number | null;
  /**
   * Epoch ms of the last *event* worth noticing — a pipeline going red, approvals
   * dropping. Tracked separately from notes so that opening an MR after a red pipeline
   * does not also silence a comment that lands a second later.
   */
  lastEventAt: number | null;
  lastEventSeenAt: number | null;
  updatedAt: number;
  syncedAt: number;
}

/** Pipeline outcomes that are a problem rather than a stage of one. */
const BAD_PIPELINES: ReadonlySet<PipelineStatus> = new Set(['failed', 'canceled']);

/**
 * Just the fields readiness depends on, so the sync can ask about a freshly fetched MR —
 * which has no id, markers or issue keys yet — without assembling a whole `MergeRequest`
 * to answer a question about six fields.
 */
export type MergeReadiness = Pick<
  MergeRequest,
  'state' | 'draft' | 'changesRequested' | 'pipelineStatus' | 'approvalsRequired' | 'approvalsGiven'
>;

/**
 * Nothing is left to do but merge it: green, approved, not a draft, nobody objecting.
 *
 * The one piece of *good* news the board shouts about, and it earns that because it is the
 * only state where the MR is waiting on **you** specifically. Red pipelines and review
 * comments tell you to go and work; this tells you to go and finish.
 *
 * Two deliberate narrowings, both about not claiming more than we know:
 *
 *  - `approvalsRequired === null` means the instance would not tell us (`/approvals` is
 *    tier-gated). Somebody approving against an unknown bar is not evidence the bar is met,
 *    and this is the wrong place to guess — the same reason `approvalSummary` says
 *    "approvals unknown" rather than `0/0`.
 *  - `approvalsGiven > 0` on top of meeting the bar, so a project that requires **zero**
 *    approvals does not mark every green MR as approved. With no rule and nobody having
 *    looked, "it has been approved" is simply not true.
 *
 * `success` only, not `skipped` or `manual`: a pipeline nobody ran is not a pipeline that
 * passed.
 */

export function mrReadyToMerge(mr: MergeReadiness): boolean {
  if (mr.state !== 'opened' || mr.draft || mr.changesRequested) return false;
  if (mr.pipelineStatus !== 'success') return false;
  if (mr.approvalsRequired === null) return false;
  return mr.approvalsGiven > 0 && mr.approvalsGiven >= mr.approvalsRequired;
}

/**
 * Whether an MR is asking for the user's attention.
 *
 * Only an OPEN one can: a merged or closed MR is history, however red its last pipeline
 * was. Three independent reasons, each with its own read marker, so clearing one never
 * silences the other.
 */
export function mrNeedsAttention(mr: MergeRequest): boolean {
  if (mr.state !== 'opened') return false;
  const unreadNote = mr.latestNoteAt !== null && mr.latestNoteAt > (mr.lastReadAt ?? 0);
  const unseenEvent = mr.lastEventAt !== null && mr.lastEventAt > (mr.lastEventSeenAt ?? 0);
  return (
    unreadNote ||
    (unseenEvent &&
      (BAD_PIPELINES.has(mr.pipelineStatus) || mr.changesRequested || mrReadyToMerge(mr)))
  );
}

/** Why an MR is shouting, for the tooltip. Null when it isn't. */
export function mrAttentionReason(mr: MergeRequest): string | null {
  if (!mrNeedsAttention(mr)) return null;
  const reasons: string[] = [];
  if (mr.latestNoteAt !== null && mr.latestNoteAt > (mr.lastReadAt ?? 0)) {
    reasons.push('new comments');
  }
  const unseenEvent = mr.lastEventAt !== null && mr.lastEventAt > (mr.lastEventSeenAt ?? 0);
  if (unseenEvent && BAD_PIPELINES.has(mr.pipelineStatus)) {
    reasons.push(mr.pipelineStatus === 'failed' ? 'the pipeline failed' : 'the pipeline was cancelled');
  }
  if (unseenEvent && mr.changesRequested) reasons.push('changes were requested');
  if (unseenEvent && mrReadyToMerge(mr)) reasons.push('approved and green — ready to merge');
  return reasons.length ? `!${mr.iid}: ${reasons.join(', ')}` : null;
}

/** "2/3", or "approvals unknown" when the instance would not tell us. */
export function approvalSummary(mr: MergeRequest): string {
  if (mr.approvalsRequired === null) return 'approvals unknown';
  return `${mr.approvalsGiven}/${mr.approvalsRequired} approved`;
}
