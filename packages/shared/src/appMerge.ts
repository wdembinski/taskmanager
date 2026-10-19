/**
 * The pure half of "Task Manager merges it itself" — the fallback for a forge that cannot
 * auto-merge (a private repo on GitHub Free answers 403 to every ruleset and auto-merge call,
 * yet still accepts a plain merge). Everything that decides WHETHER the app may merge a green
 * pull/merge request right now lives in {@link appMergeDecision}, read off facts the caller
 * re-fetched from the forge immediately before the merge call; the forge calls themselves are
 * a thin side-effecting shell around it. This file is what the mutation proof targets: a merge
 * the app performs on a guess cannot be taken back, so every gate sits in one function here.
 */
import type { AutoMergeBy, TaskActivityEntry } from './model';

/**
 * One check (a GitHub check run or commit status, or a GitLab pipeline job) reduced to the
 * common shape {@link appMergeDecision} reads. `conclusion` is only meaningful once
 * `completed` — a check still running carries `'unknown'`.
 */
export type AppMergeCheck = {
  name: string;
  completed: boolean;
  conclusion:
    | 'success'
    | 'failure'
    | 'cancelled'
    | 'neutral'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | 'stale'
    | 'unknown';
};

/** Why {@link appMergeDecision} refused — each one a fact a human has to change before the
 *  app may merge, as opposed to a `wait`, which resolves itself. */
export type AppMergeRefusal =
  | 'closed'
  | 'draft'
  | 'sign-off'
  | 'stale-sha'
  | 'conflict'
  | 'behind'
  | 'not-mergeable'
  | 'no-checks'
  | 'failed-check'
  | 'missing-required'
  | 'required-not-success';

/** Why {@link appMergeDecision} is holding: `computing` — the forge has not finished working
 *  out whether the pull request is mergeable; `pending` — a check is still running. */
export type AppMergeWait = 'computing' | 'pending';

export type AppMergeDecision =
  | { kind: 'merge'; sha: string }
  | { kind: 'wait'; reason: AppMergeWait }
  | { kind: 'refuse'; reason: AppMergeRefusal; detail: string };

/** What {@link appMergeDecision} reads — every field re-read from the forge right before the
 *  merge, except `expectedSha` (the head the caller decided to merge) and the card's own
 *  sign-off facts. */
export interface AppMergeInput {
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  /** The forge's own tri-state verdict; `null` while it is still computing. */
  mergeable: boolean | null;
  /** The branch is behind its base and the base requires it to be up to date. */
  behind: boolean;
  conflicted: boolean;
  /** The pull request's head as the forge reports it now, or `null` if unreadable. */
  liveHeadSha: string | null;
  /** The head the caller set out to merge — the sha whose pipeline it saw pass. */
  expectedSha: string;
  /** The commit the `checks` were read for. */
  checksSha: string;
  checks: readonly AppMergeCheck[];
  /** The project's `autoMergeRequiredChecks` — names that must each be present and green. */
  requiredChecks: readonly string[];
  isUiCard: boolean;
  human: 'pending' | 'approved' | 'needs-changes';
}

/** The conclusions that mean a check actually failed — any one of them, required or not,
 *  refuses the merge. `neutral`/`skipped` on a non-required check pass. */
const FAILING_CONCLUSIONS: ReadonlySet<AppMergeCheck['conclusion']> = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
]);

/**
 * Whether Task Manager may merge a pull/merge request right now. The order is load-bearing:
 * the facts a human must change (closed, draft, sign-off) come first, then the head moving
 * under us (a merge of a sha whose checks we never read), then the forge's own mergeability,
 * and only then the checks — where anything still running WAITS rather than refuses, so a
 * green-but-incomplete set is never merged on the strength of "nothing failed yet".
 */
export function appMergeDecision(input: AppMergeInput): AppMergeDecision {
  const refuse = (reason: AppMergeRefusal, detail: string): AppMergeDecision => ({
    kind: 'refuse',
    reason,
    detail,
  });

  if (input.state !== 'open') return refuse('closed', `it is already ${input.state}`);
  if (input.draft) return refuse('draft', 'it is still a draft');
  if (input.isUiCard && input.human !== 'approved') {
    return refuse(
      'sign-off',
      input.human === 'needs-changes'
        ? 'visual sign-off flagged needs changes'
        : 'its visual sign-off is still pending — press Approve to let it merge',
    );
  }
  if (input.liveHeadSha !== input.expectedSha) {
    return refuse(
      'stale-sha',
      `its head moved from ${short(input.expectedSha)} to ${short(input.liveHeadSha)}`,
    );
  }
  if (input.checksSha !== input.liveHeadSha) {
    return refuse(
      'stale-sha',
      `its checks were read for ${short(input.checksSha)}, not its head ${short(input.liveHeadSha)}`,
    );
  }
  if (input.conflicted) return refuse('conflict', 'it has conflicts with its base branch');
  if (input.behind) return refuse('behind', 'it is behind its base branch');
  if (input.mergeable === null) return { kind: 'wait', reason: 'computing' };
  if (input.mergeable === false) return refuse('not-mergeable', 'the forge says it cannot merge');
  if (input.checks.length === 0) {
    return refuse('no-checks', 'it has no checks, so nothing says it is green');
  }
  if (input.checks.some((c) => !c.completed)) return { kind: 'wait', reason: 'pending' };

  const failed = input.checks.filter((c) => FAILING_CONCLUSIONS.has(c.conclusion));
  if (failed.length > 0) {
    return refuse('failed-check', `${listChecks(failed)} did not pass`);
  }
  const present = new Set(input.checks.map((c) => c.name));
  const missing = input.requiredChecks.filter((name) => !present.has(name));
  if (missing.length > 0) {
    return refuse('missing-required', `required ${listNames(missing)} never ran`);
  }
  const required = new Set(input.requiredChecks);
  const notSuccess = input.checks.filter((c) => required.has(c.name) && c.conclusion !== 'success');
  if (notSuccess.length > 0) {
    return refuse('required-not-success', `required ${listChecks(notSuccess)} did not succeed`);
  }
  // The live head equals `expectedSha` here (checked above); `expectedSha` is the typed one.
  return { kind: 'merge', sha: input.expectedSha };
}

function short(sha: string | null): string {
  return sha === null ? 'an unreadable head' : sha.slice(0, 7);
}

function listChecks(checks: readonly AppMergeCheck[]): string {
  return listNames(checks.map((c) => `${c.name} (${c.conclusion})`));
}

function listNames(names: readonly string[]): string {
  return names.length === 1 ? `check ${names[0]}` : `checks ${names.join(', ')}`;
}

/** The prefix the automatic-fallback note starts with — what {@link effectiveAutoMergeBy}
 *  looks for on a card's timeline. */
export const AUTO_MERGE_APP_FALLBACK_PREFIX = 'Auto-merge is not available';
/** The prefix a successful app merge's note starts with. */
export const APP_MERGED_PREFIX = 'Merged by Task Manager:';
/** The prefix a refused app merge's note starts with. */
export const APP_MERGE_REFUSED_PREFIX = 'Task Manager did not merge';
/** The prefix the "app mode is on" note starts with. */
export const APP_MERGE_MODE_PREFIX = 'Task Manager will merge';

/**
 * Who merges this card's pull request: `'app'` when the project setting says so, OR when the
 * forge already refused auto-merge on this card and `requestAutoMerge` recorded the fallback
 * on its timeline. The timeline, not a rewritten setting, is the record — it survives a
 * restart, and nobody's project setting changes behind their back.
 */
export function effectiveAutoMergeBy(
  setting: AutoMergeBy,
  activity: readonly TaskActivityEntry[],
): AutoMergeBy {
  if (setting === 'app') return 'app';
  const fellBack = activity.some(
    (e) => e.kind === 'comment' && e.body.startsWith(AUTO_MERGE_APP_FALLBACK_PREFIX),
  );
  return fellBack ? 'app' : 'forge';
}

const UNAVAILABLE_MESSAGE =
  /not allowed|auto-?merge is not (enabled|allowed)|upgrade to github pro|make this repository public|pull request auto merge is not allowed|merge when pipeline succeeds/i;

/**
 * Whether an `enableAutoMerge` refusal means the forge cannot auto-merge here at all (its
 * plan or the repository's visibility forbids it) — the case the app falls back to merging
 * itself — rather than a transient or credential failure. A 401 is always a credential
 * failure, whatever its message says, and stays a plain failure note.
 */
export function isAutoMergeUnavailable(
  status: number | null | undefined,
  message: string,
): boolean {
  if (status === 401) return false;
  if (status === 403) return true;
  return UNAVAILABLE_MESSAGE.test(message);
}

/** The note an app merge that landed leaves on the card. Deliberately NOT an
 *  `Auto-merge enabled` note, so `autoMergeLanded` never credits it a second time. */
export function appMergedNote(ref: string, base: string): string {
  return `${APP_MERGED_PREFIX} ${ref} into ${base} — every check passed.`;
}

/** The note a refused app merge leaves on the card — `reason` names the gate, `detail` the
 *  fact behind it. */
export function appMergeRefusedNote(ref: string, reason: AppMergeRefusal, detail: string): string {
  return `${APP_MERGE_REFUSED_PREFIX} ${ref} (${reason}): ${detail}.`;
}

/** The note `requestAutoMerge` leaves when the forge refuses auto-merge for a plan/visibility
 *  reason — the timeline record {@link effectiveAutoMergeBy} reads. */
export function autoMergeAppFallbackNote(ref: string, message: string): string {
  const why = message.trim().replace(/[.\s]+$/, '');
  return (
    `${AUTO_MERGE_APP_FALLBACK_PREFIX} on ${ref} — ${why}; Task Manager will merge it itself ` +
    `once it is green.`
  );
}

/** The note `requestAutoMerge` leaves in `'app'` mode instead of arming the forge. */
export function appMergeModeNote(ref: string): string {
  return `${APP_MERGE_MODE_PREFIX} ${ref} itself once its checks pass.`;
}
