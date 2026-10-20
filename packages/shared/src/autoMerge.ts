/**
 * The pure half of "merge on green" — everything that decides WHETHER a card's pull/merge
 * request should have auto-merge armed right now, and the note text that decision becomes on
 * the card's timeline. The forge call itself (`apps/client/src/main/forge/autoMerge.ts`'s
 * `requestAutoMerge`/`disableAutoMerge`) is a thin side-effecting shell around
 * {@link autoMergeDecision}; this file is what the mutation proof targets, because every gate
 * a human can get burned by — a UI card merging before its owner looked — lives in one
 * function here rather than scattered across the call sites that happen to run it.
 */
import type { Project, TaskActivityEntry } from './model';

/**
 * What {@link autoMergeDecision} answers:
 *
 * - `off` — the project's own `autoMergeOnGreen` is off. No forge call, ever.
 * - `enable` — arm it.
 * - `await-sign-off` — a UI card whose human verdict is still `pending`. Hold, with a note
 *   naming the Approve button, rather than enable on a guess.
 * - `needs-changes` — a UI card whose human verdict is `needs-changes`. Never enable; if it
 *   was already armed from an earlier push, withdraw it.
 */
export type AutoMergeDecision = 'off' | 'enable' | 'await-sign-off' | 'needs-changes';

/**
 * Whether a card's pull/merge request should have auto-merge armed right now — the one
 * function all of "merge on green"'s gating lives in (see {@link Project.autoMergeOnGreen}'s
 * own comment). A card that is not a UI card (`isUiCard: false`) always enables once the
 * project setting is on: the visual sign-off gate exists for shots a human has to look at,
 * and a card with none never grows one.
 */
export function autoMergeDecision(input: {
  enabled: boolean;
  isUiCard: boolean;
  human: 'pending' | 'approved' | 'needs-changes';
}): AutoMergeDecision {
  if (!input.enabled) return 'off';
  if (!input.isUiCard) return 'enable';
  if (input.human === 'approved') return 'enable';
  if (input.human === 'needs-changes') return 'needs-changes';
  return 'await-sign-off';
}

/** The prefix every "armed" note starts with — what {@link autoMergeLanded} looks for. */
export const AUTO_MERGE_ENABLED_PREFIX = 'Auto-merge enabled';
/** The prefix a held-for-sign-off note starts with. */
export const AUTO_MERGE_AWAIT_SIGN_OFF_PREFIX = 'Auto-merge is waiting for visual sign-off';
/** The prefix a withdrawn-for-needs-changes note starts with. */
export const AUTO_MERGE_NEEDS_CHANGES_PREFIX = 'Auto-merge disabled';
/** The prefix every non-fatal forge refusal is caught into, per `requestAutoMerge`'s own
 *  "a refusal is a note, never a throw" rule. */
export const AUTO_MERGE_FAILED_PREFIX = 'Could not enable auto-merge';
/** The prefix a non-fatal refusal from {@link disableAutoMerge}'s own forge call is caught
 *  into — kept apart from {@link AUTO_MERGE_FAILED_PREFIX} so the note never claims to have
 *  been trying to ENABLE anything when it was withdrawing a hold instead. */
export const AUTO_MERGE_DISABLE_FAILED_PREFIX = 'Could not disable auto-merge';
/** The prefix {@link autoMergeLanded}'s own "already credited" note starts with. */
export const MERGED_BY_AUTO_MERGE_PREFIX = 'Merged by auto-merge:';

/**
 * The note left when auto-merge is armed — `immediate` for GitHub's "clean status" fallback,
 * where `enableAutoMerge` found the pull request already mergeable and merged it directly
 * rather than arming a wait.
 */
export function autoMergeEnabledNote(ref: string, immediate: boolean): string {
  return immediate
    ? `${AUTO_MERGE_ENABLED_PREFIX} for ${ref} — its checks were already green, so it merged immediately.`
    : `${AUTO_MERGE_ENABLED_PREFIX} for ${ref} — waiting for checks to pass before merging.`;
}

/** The note left when a UI card's sign-off is still pending. */
export function autoMergeAwaitSignOffNote(ref: string): string {
  return (
    `${AUTO_MERGE_AWAIT_SIGN_OFF_PREFIX} on ${ref} — press Approve in the Visual sign-off ` +
    `panel to enable it.`
  );
}

/** The note left instead of {@link autoMergeAwaitSignOffNote} when the project's AI reviewer
 *  is about to judge the shots — same prefix, since it is the same hold. */
export function autoMergeAwaitAiReviewNote(ref: string): string {
  return `${AUTO_MERGE_AWAIT_SIGN_OFF_PREFIX} on ${ref} — the AI reviewer is checking the shots.`;
}

/** The note left when a UI card's sign-off flags needs-changes. */
export function autoMergeNeedsChangesNote(ref: string): string {
  return `${AUTO_MERGE_NEEDS_CHANGES_PREFIX} on ${ref}: visual sign-off flagged needs changes.`;
}

/** The note an enable refusal is caught into — never thrown, same rule as
 *  `refreshDescription`. */
export function autoMergeFailedNote(ref: string, message: string): string {
  return `${AUTO_MERGE_FAILED_PREFIX} on ${ref}: ${message}`;
}

/** The note a disable refusal is caught into. */
export function autoMergeDisableFailedNote(ref: string, message: string): string {
  return `${AUTO_MERGE_DISABLE_FAILED_PREFIX} on ${ref}: ${message}`;
}

/** The note {@link autoMergeLanded} tells its caller to file once a card's auto-merge actually
 *  lands. */
export function mergedByAutoMergeNote(ref: string): string {
  return `${MERGED_BY_AUTO_MERGE_PREFIX} ${ref}.`;
}

/**
 * Whether a card's merge request just landing should be credited to auto-merge — true when
 * the latest `Auto-merge enabled` note on the card is still uncontested, i.e. no
 * `Merged by auto-merge` note sits after it. Read fresh off the card's own timeline rather
 * than off any in-memory flag: the timeline is the only record that survives a restart.
 */
export function autoMergeLanded(activity: readonly TaskActivityEntry[]): boolean {
  const comments = activity.filter(
    (e): e is TaskActivityEntry & { kind: 'comment' } => e.kind === 'comment',
  );
  const latestEnabled = [...comments]
    .filter((c) => c.body.startsWith(AUTO_MERGE_ENABLED_PREFIX))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!latestEnabled) return false;
  const supersededByMerge = comments.some(
    (c) => c.body.startsWith(MERGED_BY_AUTO_MERGE_PREFIX) && c.createdAt > latestEnabled.createdAt,
  );
  return !supersededByMerge;
}

/** What {@link autoMergePrerequisites} reads about a base branch's actual requirements —
 *  the common shape both forges' own `getAutoMergeFacts` can be reduced to. */
export interface AutoMergePrerequisiteFacts {
  /** Whether the forge itself allows auto-merge on this repository at all, or `null` when
   *  that is not knowable (GitLab reports no such flag). */
  allowAutoMerge: boolean | null;
  /** The base branch's own required checks, or `null` when unreadable (no permission). */
  requiredChecks: string[] | null;
}

/**
 * The sentences Test connection (a later step) shows beside a project's "Merge on green"
 * setting — never a throw, since none of this stops auto-merge from being requested; it is
 * purely "here is what you might be surprised by". Empty when the setting is off, since
 * there is nothing to warn about for a feature that is not armed.
 */
export function autoMergePrerequisites(
  project: Pick<Project, 'autoMergeOnGreen' | 'autoMergeRequiredChecks'>,
  facts: AutoMergePrerequisiteFacts,
): string[] {
  if (!project.autoMergeOnGreen) return [];
  const problems: string[] = [];
  if (facts.allowAutoMerge === false) {
    problems.push(
      'This repository does not allow auto-merge — enable it in its settings before ' +
        '"Merge on green" can do anything.',
    );
  }
  if (facts.requiredChecks === null) {
    problems.push(
      "Could not read the base branch's required checks, so there is no way to confirm " +
        'auto-merge will actually wait for CI.',
    );
  } else if (facts.requiredChecks.length === 0) {
    problems.push(
      'The base branch requires no checks at all, so auto-merge would merge a pull request ' +
        'the moment it opens.',
    );
  } else {
    const named = new Set(project.autoMergeRequiredChecks);
    const missing = facts.requiredChecks.filter((check) => !named.has(check));
    if (missing.length > 0) {
      problems.push(
        `The base branch requires ${missing.join(', ')}, which "Merge on green"'s own checks ` +
          `list does not name — add ${missing.length === 1 ? 'it' : 'them'} so this is not a ` +
          `surprise.`,
      );
    }
  }
  return problems;
}

/** What {@link autoMergeGitLabPrerequisites} reads about a project's own merge settings —
 *  the shape `GitLabClient.getAutoMergeFacts` already returns. GitLab has no equivalent of
 *  a base branch's required-checks list (a pipeline either exists or it doesn't), so this
 *  carries only the one project-wide setting that can silently defeat "Merge on green". */
export interface GitLabAutoMergePrerequisiteFacts {
  /** `GET /projects/:id`'s own `only_allow_merge_if_pipeline_succeeds`, or `null` on an
   *  instance too old to send it. */
  pipelineMustSucceed: boolean | null;
}

/**
 * The GitLab half of {@link autoMergePrerequisites} — same purpose, never a throw, empty
 * when the setting is off — but over GitLab's own, much smaller set of facts: there is no
 * "required checks" list to cross-check, only whether this project itself insists a pipeline
 * succeeds before anything merges. Without that, `merge_when_pipeline_succeeds` has nothing
 * to wait for and the merge request merges the moment it opens.
 */
export function autoMergeGitLabPrerequisites(
  project: Pick<Project, 'autoMergeOnGreen'>,
  facts: GitLabAutoMergePrerequisiteFacts,
): string[] {
  if (!project.autoMergeOnGreen) return [];
  if (facts.pipelineMustSucceed === null) {
    return [
      "Could not read this project's merge settings — the token needs at least Maintainer " +
        'access; check it by hand.',
    ];
  }
  if (facts.pipelineMustSucceed === false) {
    return [
      'This project does not require pipelines to succeed before merging — switch on ' +
        '"Pipelines must succeed" (Settings → Merge requests), or auto-merge will merge the ' +
        'moment the merge request opens.',
    ];
  }
  return [];
}
