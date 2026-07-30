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
  return unreadNote || (unseenEvent && (BAD_PIPELINES.has(mr.pipelineStatus) || mr.changesRequested));
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
  return reasons.length ? `!${mr.iid}: ${reasons.join(', ')}` : null;
}

/** "2/3", or "approvals unknown" when the instance would not tell us. */
export function approvalSummary(mr: MergeRequest): string {
  if (mr.approvalsRequired === null) return 'approvals unknown';
  return `${mr.approvalsGiven}/${mr.approvalsRequired} approved`;
}
