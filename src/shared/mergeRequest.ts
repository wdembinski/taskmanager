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
  /**
   * A name for this MR **in this app only**, or null to use the upstream `title`.
   *
   * Yours, not GitLab's: nothing is ever written back, and the next sync must not touch it —
   * so it is carried across syncs the way the read markers are, as the one kind of field
   * GitLab knows nothing about. An MR titled "Draft: WIP fix for the thing (attempt 3)" is a
   * poor row label, and renaming it upstream is somebody else's call.
   */
  displayName: string | null;
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
  /**
   * **GitLab's own answer to "can this merge"** — `detailed_merge_status`, raw and
   * unnormalized, or null when we could not read it (an instance older than 15.6, or a
   * sync that only saw the list endpoint, which does not carry it).
   *
   * This is the field whose absence made the board lie. Everything else here describes the
   * merge request's *inputs* — is CI green, has anyone approved — and the app inferred
   * "ready to merge" from those. But GitLab refuses a merge for reasons no input mentions:
   * the branch has diverged and needs a rebase, fast-forward is impossible, another MR is
   * blocking it. An MR sitting behind three of those was showing as green and approved.
   *
   * Kept raw rather than parsed into an enum on the way in, so an instance that invents a
   * status we have never heard of degrades to "blocked, and here is what GitLab called it"
   * instead of being silently read as mergeable. See {@link mergeBlockers}.
   */
  detailedMergeStatus: string | null;
  /** Whether the source branch conflicts with its target, as GitLab reports it. */
  hasConflicts: boolean;
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
  | 'state'
  | 'draft'
  | 'changesRequested'
  | 'pipelineStatus'
  | 'approvalsRequired'
  | 'approvalsGiven'
  | 'detailedMergeStatus'
  | 'hasConflicts'
>;

/**
 * Why this merge request cannot be merged right now — one reason per thing a human would
 * have to go and fix.
 *
 * `other` is deliberate and load-bearing: GitLab keeps adding statuses (security policies,
 * external status checks, title regexes), and an unknown one must read as **blocked** with
 * the raw string shown, never as mergeable. Guessing in the optimistic direction is exactly
 * how an MR with conflicts came to wear a green tick.
 */
export type MergeBlocker =
  | 'draft'
  | 'conflict'
  | 'need-rebase'
  | 'discussions'
  | 'changes-requested'
  | 'approvals'
  | 'pipeline'
  | 'blocked-by-another'
  | 'checking'
  | 'other';

/** How each blocker reads on screen — a phrase that completes "can't merge: …". */
export const MERGE_BLOCKER_LABEL: Record<MergeBlocker, string> = {
  draft: 'still a draft',
  conflict: 'merge conflicts',
  'need-rebase': 'needs a rebase',
  discussions: 'unresolved threads',
  'changes-requested': 'changes requested',
  approvals: 'not approved',
  pipeline: 'pipeline not green',
  'blocked-by-another': 'blocked by another merge request',
  checking: 'GitLab is still checking',
  other: 'blocked by GitLab',
};

/**
 * Normalize one `detailed_merge_status` string, or null when GitLab says it can merge.
 *
 * `mergeable` is the ONLY value that means yes. Everything else — including a value this
 * table has never seen — is a blocker, which is the whole point: the failure mode worth
 * engineering against is claiming an MR is ready when it isn't.
 */
export function detailedMergeBlocker(raw: string | null | undefined): MergeBlocker | null {
  if (!raw) return null; // not read at all — the caller falls back to what it does know
  switch (raw) {
    case 'mergeable':
      return null;
    case 'draft_status':
      return 'draft';
    case 'conflict':
      return 'conflict';
    case 'need_rebase':
      return 'need-rebase';
    case 'discussions_not_resolved':
      return 'discussions';
    case 'requested_changes':
      return 'changes-requested';
    case 'not_approved':
    case 'approvals_syncing':
      return 'approvals';
    case 'ci_must_pass':
    case 'ci_still_running':
      return 'pipeline';
    case 'blocked_status':
      return 'blocked-by-another';
    // Not an answer yet — GitLab is working it out. Distinct from a real blocker, because
    // "we don't know yet" must not read as "you have something to fix".
    case 'checking':
    case 'unchecked':
    case 'preparing':
      return 'checking';
    case 'not_open':
      return null; // a closed/merged MR is handled by `state`, not by this
    default:
      return 'other';
  }
}

/**
 * Everything standing between this merge request and a merge, in the order you would fix it.
 *
 * Two sources, deliberately combined rather than one trusted over the other:
 *
 *  - **GitLab's own verdict** (`detailedMergeStatus`), which is the only thing that knows
 *    about conflicts, rebases and cross-MR blocks. When it is absent — an older instance, or
 *    a sync that never fetched the detail — `hasConflicts` and `draft` still stand in for
 *    the two most common cases.
 *  - **Our own two conditions**, a red pipeline and a missing approval, which GitLab only
 *    enforces when the *project* is configured to require them. A project with no such rule
 *    reports `mergeable` over a failed pipeline, and "nothing left to do but merge it" is
 *    plainly untrue there.
 *
 * Empty means empty: a merge request with no blockers is one you can go and land.
 * Non-`opened` returns empty too — a merged MR is not "blocked", it is finished.
 */
export function mergeBlockers(mr: MergeReadiness): MergeBlocker[] {
  if (mr.state !== 'opened') return [];
  const found = new Set<MergeBlocker>();
  if (mr.draft) found.add('draft');
  if (mr.hasConflicts) found.add('conflict');

  const upstream = detailedMergeBlocker(mr.detailedMergeStatus);
  if (upstream) found.add(upstream);

  if (mr.pipelineStatus !== 'success') found.add('pipeline');
  const approval = mrApprovalState(mr);
  if (approval === 'changes-requested') found.add('changes-requested');
  else if (approval !== 'approved') found.add('approvals');

  // A stable order, so a row's reasons don't reshuffle between syncs: structural problems
  // first (they block everything else), then review, then CI.
  const ORDER: MergeBlocker[] = [
    'conflict',
    'need-rebase',
    'blocked-by-another',
    'draft',
    'changes-requested',
    'discussions',
    'approvals',
    'pipeline',
    'checking',
    'other',
  ];
  return ORDER.filter((b) => found.has(b));
}

/**
 * Nothing is left to do but merge it — literally nothing: {@link mergeBlockers} is empty.
 *
 * The one piece of *good* news the board shouts about, and it earns that because it is the
 * only state where the MR is waiting on **you** specifically. Red pipelines and review
 * comments tell you to go and work; this tells you to go and finish.
 *
 * It used to be a hand-written conjunction over the MR's inputs — open, not a draft, green,
 * approved — and that list was missing everything only GitLab knows: conflicts, a branch
 * that needs rebasing, a block by another MR. An MR failing all three of those satisfied
 * every clause here and was announced as ready. Asking `mergeBlockers` instead means the
 * question is answered in one place and a newly invented GitLab status blocks by default.
 */
export function mrReadyToMerge(mr: MergeReadiness): boolean {
  return mr.state === 'opened' && mergeBlockers(mr).length === 0;
}

/** Just the fields the review verdict depends on. See {@link mrApprovalState}. */
export type ApprovalFacts = Pick<
  MergeRequest,
  'changesRequested' | 'approvalsRequired' | 'approvalsGiven'
>;

/**
 * What REVIEW says about an MR — the single answer every surface renders.
 *
 *  - `changes-requested` — a reviewer objected. First, because an objection outranks a tick:
 *    an MR can satisfy its approval bar and still have someone asking for changes, and the
 *    green would bury it.
 *  - `approved`   — somebody actually approved, and the bar is met.
 *  - `unopposed`  — the bar is met but NOBODY APPROVED, which only happens on a project
 *    requiring zero approvals. Nothing is blocking the merge, and no human has looked at it.
 *    Those are different facts and must not share a glyph: this is the state that had every
 *    green MR on a rule-less project claiming to be approved.
 *  - `awaiting`   — the bar is unmet, or the instance would not tell us what it is
 *    (`/approvals` is tier-gated). Somebody approving against an unknown bar is not evidence
 *    the bar is met, and this is the wrong place to guess.
 */
export type MrApprovalState = 'changes-requested' | 'approved' | 'unopposed' | 'awaiting';

export function mrApprovalState(mr: ApprovalFacts): MrApprovalState {
  if (mr.changesRequested) return 'changes-requested';
  if (mr.approvalsRequired === null) return 'awaiting';
  if (mr.approvalsGiven < mr.approvalsRequired) return 'awaiting';
  return mr.approvalsGiven > 0 ? 'approved' : 'unopposed';
}

/**
 * Whether an MR's life is **over** — it landed, or somebody closed it unmerged.
 *
 * The board only ever fetches `state=opened`, so a settled MR is one GitLab has stopped
 * listing. That absence used to delete it, which is why merging an MR made it vanish off
 * the card that had been tracking it all week. A settled MR is that card's history and it
 * stays; see `gitlab/gitlabSync.ts` for the retention rule.
 *
 * `locked` is deliberately absent: a locked MR is still open, just frozen.
 */
export function mrIsSettled(mr: Pick<MergeRequest, 'state'>): boolean {
  return mr.state === 'merged' || mr.state === 'closed';
}

/**
 * The one thing an MR's review slot says — the verdict every surface renders.
 *
 * {@link mrApprovalState} answers "what does REVIEW say", which is only the interesting
 * question while the MR is still open. Once it has landed, "2/2 approved" is a fact about
 * a decision nobody is waiting on any more, and showing the approval tick there claims the
 * MR is still asking to be merged. So an outcome outranks a review state: `merged` and
 * `closed` are terminal and win.
 */
export type MrVerdict = MrApprovalState | 'merged' | 'closed' | 'blocked';

/**
 * `blocked` outranks every review state, and that is the fix for a green tick on an MR
 * nobody could merge: an approval is a statement about a REVIEW, and it stays true, but on a
 * branch with conflicts it is not the thing the row should be saying. Only the STRUCTURAL
 * blockers get here — a red pipeline has its own dots on the row and a draft its own chip,
 * so promoting those would be the same fact told twice.
 */
const STRUCTURAL: ReadonlySet<MergeBlocker> = new Set([
  'conflict',
  'need-rebase',
  'blocked-by-another',
]);

export function mrVerdict(mr: MergeReadiness): MrVerdict {
  if (mr.state === 'merged') return 'merged';
  if (mr.state === 'closed') return 'closed';
  if (mergeBlockers(mr).some((b) => STRUCTURAL.has(b))) return 'blocked';
  return mrApprovalState(mr);
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
    reasons.push(
      mr.pipelineStatus === 'failed' ? 'the pipeline failed' : 'the pipeline was cancelled',
    );
  }
  if (unseenEvent && mr.changesRequested) reasons.push('changes were requested');
  if (unseenEvent && mrReadyToMerge(mr)) reasons.push('approved and green — ready to merge');
  return reasons.length ? `!${mr.iid}: ${reasons.join(', ')}` : null;
}

/**
 * What to call this MR on screen: your override, else the upstream title.
 *
 * One function so the card row and the detail pane cannot disagree — and so a row never
 * falls back to the source branch, which is what it used to show and which answers a
 * different question ("where is it") from the one a row label should ("what is it").
 */
export function mrLabel(mr: MergeRequest): string {
  return mr.displayName?.trim() || mr.title;
}

/**
 * The verdict in words — the card row's tooltip and the pane's badge, so the glyph and the
 * sentence beside it can never come from two different readings of the same MR.
 *
 * A settled MR says how it ended, not how its review was going: "2/2 approved" on something
 * that merged last Tuesday describes a queue nobody is in any more.
 */
export function verdictSummary(mr: MergeRequest): string {
  switch (mrVerdict(mr)) {
    case 'merged':
      return 'merged';
    case 'closed':
      return 'closed without merging';
    case 'changes-requested':
      return 'changes requested';
    case 'blocked':
      // Every reason, not just the first: GitLab's own UI lists them together, and being
      // told about the conflict only to hit the rebase next is two trips for one problem.
      return `can't merge — ${mergeBlockers(mr).map((b) => MERGE_BLOCKER_LABEL[b]).join(', ')}`;
    default:
      return approvalSummary(mr);
  }
}

/** "2/3", or "approvals unknown" when the instance would not tell us. */
export function approvalSummary(mr: MergeRequest): string {
  if (mr.approvalsRequired === null) return 'approvals unknown';
  // "0/0 approved" is the sentence that started all of this: it reads as a satisfied bar
  // when what it means is that there is no bar and nobody has looked. Say the second thing.
  if (mr.approvalsRequired === 0 && mr.approvalsGiven === 0) return 'no approval required';
  return `${mr.approvalsGiven}/${mr.approvalsRequired} approved`;
}
