/**
 * Pure reconciliation of fetched Linear issues into Personal-board tasks.
 *
 * `github/githubIssueSync.ts`, one tracker over: no DB, no Electron — the IPC layer applies
 * the returned upserts, restores and archives. The *rules* are the shared ones documented
 * there in full (a block the app applied survives a sync, a live run is never evicted from
 * `status`, every field a sync did not return falls back to the prior value, a brand-new
 * card starts read, and no card leaves the board unless Linear was asked about it and
 * answered) — this header only spells out what is genuinely different about Linear.
 *
 * **Identity is the UUID, not the identifier.** A Linear issue moved to another team gets a
 * new identifier (`ENG-12` → `OPS-40`) but keeps its `id` (a UUID) forever. So the card id is
 * `linear-<uuid>`, `externalId` stores the UUID, and `externalKey` stores the identifier —
 * rewritten on every sync, purely for display. Existing cards are indexed by UUID (read off
 * `externalId`, falling back to stripping the `linear-` prefix off `id` for a row written
 * before that field existed), never by identifier, so a team move updates the very same card:
 * same id, same order, same filing, same activity timeline — only the chip text changes.
 *
 * Column resolution reuses `@shared/statusResolve`'s `resolveLinearColumn` whole, which is
 * what makes this reconciler short: a Linear state is one value with a fixed `type`, exactly
 * like a JIRA status plus its category, so there is no GitHub-style second resolver to
 * maintain here. `forge/removalGuard.ts` bounds a single sync the same way it does for every
 * tracker.
 */
import { PERSONAL_PROJECT_ID, type BoardColumn, type Project, type Task } from '@shared/model';
import { resolveOwningBoardProject } from '@shared/agentProjects';
import { columnForTask, isRunStatus, restingStatus, statusForColumn } from '@shared/board';
import { linearCategory, resolveLinearColumn } from '@shared/statusResolve';
import type { LinearStateType } from '@shared/settings';
import {
  guardRemovals,
  isIncompleteAnswer,
  type ForgeRemoval,
  type ForgeRemovalReason,
} from '../forge/removalGuard';
import type { LinearComment, LinearIssue } from './linearClient';

/** A set of issue UUIDs, however the caller happens to be holding them. */
export type KeySet = ReadonlySet<string> | readonly string[];

/** Normalise a {@link KeySet} option; null/undefined stays null — "nobody asked". */
function asSet(keys: KeySet | null | undefined): ReadonlySet<string> | null {
  if (keys == null) return null;
  return keys instanceof Set ? keys : new Set(keys as readonly string[]);
}

/** Every `LinearStateType` Linear itself hands back — see {@link narrowStateType}. */
const KNOWN_STATE_TYPES: ReadonlySet<string> = new Set([
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
]);

/**
 * Narrow a state's raw `type` string to {@link LinearStateType}, falling back to
 * `unstarted` for anything Linear's API starts sending that this build does not yet know —
 * the safe direction, since an unrecognised state reading as "not started" leaves the issue
 * on the board rather than silently filing it as done.
 */
function narrowStateType(type: string): LinearStateType {
  return (KNOWN_STATE_TYPES.has(type) ? type : 'unstarted') as LinearStateType;
}

/** Priority 1–4 named; 0 ("no priority") and anything else fall back to the prior value. */
const PRIORITY_NAMES: Record<number, string> = {
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};

export interface LinearIssueSyncOptions {
  /** The user's state-name → column map (matched case-insensitively), per `resolveLinearColumn`. */
  overrides?: Record<string, BoardColumn>;
  /** The map the app taught itself from successful drags. Loses to `overrides`. */
  learned?: Record<string, BoardColumn>;
  /**
   * Issue UUID → that issue's comments, for the issues this sync actually re-read them for.
   * A key that is ABSENT means "not asked this time", which keeps whatever the card already
   * knew; an empty array means "asked, and there are none".
   */
  comments?: ReadonlyMap<string, readonly LinearComment[]>;
  /**
   * Whether a comment is one of yours, so answering a ticket in Linear's own UI does not
   * raise the unread border on your own card. With no predicate, every comment counts.
   */
  isMine?: (comment: LinearComment) => boolean;
  /**
   * The issues re-read **by UUID** for the cards the fetch did not return, or **null when
   * that pass did not run or failed**.
   *
   * Null and empty are deliberately different answers, exactly as in `reconcileGitHubIssues`.
   * An empty map is Linear saying "none of those exist any more"; null is us not having
   * asked, and a card must never be archived on the strength of a question nobody put.
   */
  rechecked?: ReadonlyMap<string, LinearIssue> | null;
  /**
   * The UUIDs the re-read pass actually **asked and got an answer for** — the same
   * discipline as `rechecked: null`, but per key. One issue whose call errored must not
   * read as "Linear does not have it".
   */
  recheckedIds?: KeySet | null;
  /**
   * Whether the fetch stopped short of the end of the filter (`LinearIssuePage.truncated`).
   * A short answer looks exactly like a shrunken board, so a truncated one removes nothing.
   */
  truncated?: boolean;
  /** Whether the question itself changed since the last sync. Cards leaving is then expected. */
  queryChanged?: boolean;
  /** Share of the board that may leave in one sync before the guard refuses. Default 0.25. */
  maxRemovalFraction?: number;
  /** Removals below this count are never guarded — small boards are noisy. Default 5. */
  minGuardedRemovals?: number;
  /** Now, in epoch ms — when a card's retention clock starts, and what prunes it. */
  now?: number;
  /** How long a finished card is kept past the filter, in ms. Defaults to 0. */
  retentionMs?: number;
  /** Gate for `settings.features.ticketsToOwnBoard`. Off leaves every card on Personal. */
  assignOwnBoard?: boolean;
  /** The full project list, for resolving the board a ticket's own project owns. */
  projects?: Project[];
}

export interface LinearIssueSyncResult {
  /** Cards to insert or update. */
  upserts: Task[];
  /** Cards to take off the board — every one confirmed by a question Linear answered. */
  removals: ForgeRemoval[];
  /** Removals `guardRemovals` would not let through. Nothing was done to these. */
  refused: ForgeRemoval[];
  /** What the human should be told about this sync, or null when there is nothing to say. */
  warning: string | null;
}

/** The card id for an issue: `linear-{uuid}`. */
export function linearTaskId(uuid: string): string {
  return `linear-${uuid}`;
}

/**
 * The Linear UUID a card refers to: `externalId` when present, else the `linear-` prefix
 * stripped off `id` — a fallback for a row written before `externalId` was populated. Never
 * reads `externalKey`, which is the identifier and churns on a team move.
 */
function linearUuidOf(task: Pick<Task, 'externalId' | 'id'>): string | null {
  if (task.externalId) return task.externalId;
  if (task.id.startsWith('linear-')) return task.id.slice('linear-'.length);
  return null;
}

/** An issue's label names, in Linear's own order. */
function labelsOf(issue: LinearIssue): readonly string[] {
  return issue.labels.nodes.map((l) => l.name);
}

/**
 * Newest comment time (epoch ms) among an issue's comments, ignoring your own, or null.
 * `githubIssueSync.latestForeignCommentTime`, with Linear's simpler `isMine` predicate in
 * place of GitHub's identity cache. An absent predicate counts every comment — the safe
 * direction.
 */
function latestForeignCommentTime(
  comments: readonly LinearComment[],
  isMine?: (comment: LinearComment) => boolean,
): number | null {
  let latest: number | null = null;
  for (const c of comments) {
    if (isMine?.(c)) continue;
    const t = Date.parse(c.createdAt);
    if (!Number.isNaN(t) && (latest == null || t > latest)) latest = t;
  }
  return latest;
}

/** Convert one issue to a task, folding in any preserved state from the existing one. */
export function issueToTask(
  issue: LinearIssue,
  existing: Task | undefined,
  opts: LinearIssueSyncOptions,
  order: number,
  retainedSince: number | null = null,
): Task {
  const stateType = narrowStateType(issue.state.type);
  const resolved = resolveLinearColumn(issue.state.name, stateType, opts.overrides, opts.learned);
  const derivedStatus = statusForColumn(resolved.column);

  // Only OUR block is preserved — `githubIssueSync.issueToTask`'s identical rule. Read from
  // where the card RESTS, not from `status`: a card whose agent is running has lent that
  // field to the run, and a blocked card that is running is still blocked.
  const localBlock = existing
    ? restingStatus(existing) === 'blocked' && existing.preBlockStatus != null
    : false;
  const resting = localBlock ? 'blocked' : derivedStatus;
  // A live run owns `status` and a poll must not evict it.
  const borrowed = existing && isRunStatus(existing.status) ? existing.status : null;

  // Absent from the map means "this sync did not re-read the comments", which keeps what we
  // knew; present-and-empty means "asked, and there are none". Keyed by UUID, not identifier.
  const fetched = opts.comments?.get(issue.id);
  const latestCommentAt = fetched ? latestForeignCommentTime(fetched, opts.isMine) : null;
  // A brand-new card starts "read" so the first sync doesn't turn every card orange; an
  // existing one keeps the user's own marker.
  const lastReadCommentAt = existing ? (existing.lastReadCommentAt ?? null) : latestCommentAt;

  const description = (issue.description ?? '').trim() || null;

  // File the card on its own project's board rather than Personal when the issue resolves to
  // a project that owns one — see `resolveOwningBoardProject`. Linear carries no epic key, so
  // this only ever fires through an existing `agentProjectId`/`projectTagId`.
  const owningBoardProject = opts.assignOwnBoard
    ? resolveOwningBoardProject(
        {
          agentProjectId: existing?.agentProjectId ?? null,
          projectTagId: existing?.projectTagId ?? null,
          externalParentKey: null,
        },
        opts.projects ?? [],
      )
    : null;

  return {
    id: existing?.id ?? linearTaskId(issue.id),
    projectId: owningBoardProject?.id ?? PERSONAL_PROJECT_ID,
    phase: issue.team.key,
    title: issue.title,
    status: borrowed ?? resting,
    sessionId: null,
    order: existing?.order ?? order,
    dependsOn: [],
    source: 'linear',
    isContract: false,
    isScaffold: false,
    externalSource: 'linear',
    // The identifier is rewritten on every sync — a team move turns `ENG-12` into `OPS-40` —
    // while the card's own id and the UUID below never change.
    externalKey: issue.identifier,
    externalId: issue.id,
    externalUrl: issue.url || (existing?.externalUrl ?? null),
    externalStatus: issue.state.name,
    externalStatusCategory: linearCategory(stateType),
    // Priority is read-only. 0 ("no priority") and an unrecognised value fall back to
    // whatever the card already had, like every other field a sync did not actually learn.
    externalPriority: PRIORITY_NAMES[issue.priority] ?? existing?.externalPriority ?? null,
    // Linear has no type taxonomy the way GitHub's `bug`/`enhancement` labels are; preserved
    // rather than derived.
    externalType: existing?.externalType ?? null,
    externalLabel: labelsOf(issue)[0] ?? null,
    // Linear has no epic and no sprint. Preserved rather than nulled, for the same reason
    // `githubIssueSync.issueToTask` keeps them: a field that only ever writes null is a
    // field waiting to wipe something the day that stops being true.
    externalParentKey: null,
    externalEpicName: existing?.externalEpicName ?? null,
    externalSprint: existing?.externalSprint ?? null,
    externalDescription: description ?? existing?.externalDescription ?? null,
    preBlockStatus: localBlock ? (existing?.preBlockStatus ?? null) : null,
    preRunStatus: borrowed ? resting : null,
    retainedSince,
    lastReadCommentAt,
    latestCommentAt: latestCommentAt ?? existing?.latestCommentAt ?? null,
    projectTagId: existing?.projectTagId ?? null,
    agentProjectId: existing?.agentProjectId ?? null,
  };
}

/**
 * Whether a card that has left the fetch is one the board **keeps** — "finished" read off
 * the COLUMN, not a hand-copied list of statuses, so `cancelled`/`stopped`/`failed` (all of
 * which sit in DONE) cannot be missed. `githubIssueSync.isRetained`, unchanged.
 */
function isRetained(task: Task): boolean {
  return task.retainedSince != null || columnForTask(task) === 'done';
}

/** Linear cards on the board, keyed by UUID (see {@link linearUuidOf}). */
function linearTasksByUuid(existing: readonly Task[]): Map<string, Task> {
  const map = new Map<string, Task>();
  for (const task of existing) {
    if (task.source !== 'linear') continue;
    const uuid = linearUuidOf(task);
    if (uuid != null) map.set(uuid, task);
  }
  return map;
}

/**
 * Every Linear card the fetch left out that still has something worth asking about — the
 * issues to re-read **by UUID**. Skips cards that are archived (already off the board; the
 * next explicit restore decides, not this sync) or resting blocked (never removed, so never
 * worth asking). `githubIssueSync.issuesToRecheck`'s identical contract, one list where the
 * JIRA sync needs two, because Linear answers "does this exist, and what state is it in?" in
 * one call per id, the same as GitHub answers it per number.
 */
export function issuesToRecheck(
  existing: readonly Task[],
  issues: readonly LinearIssue[],
): string[] {
  const returned = new Set(issues.map((issue) => issue.id));
  const ids: string[] = [];
  for (const task of existing) {
    if (task.source !== 'linear') continue;
    const uuid = linearUuidOf(task);
    if (uuid == null || returned.has(uuid)) continue;
    if (task.archivedAt != null) continue;
    if (restingStatus(task) === 'blocked') continue;
    ids.push(uuid);
  }
  return ids;
}

/**
 * Reconcile the fetched Linear issues against the current Personal-board tasks. Cards from
 * any other source — ad-hoc, plan, JIRA, GitHub, native tickets — are never touched,
 * structurally: every loop below filters on `source === 'linear'`.
 *
 * The fates are `reconcileGitHubIssues`'s ten, read against Linear's own shapes:
 *
 *   1. **blocked** — untouched.
 *   2. **archived** — stays off the board whether or not the fetch returns its issue again.
 *   3. **the fetch was truncated** (`LinearIssuePage.truncated`) — everything is kept.
 *   4. **this sync's own answer looks incomplete** ({@link isIncompleteAnswer}) — kept.
 *   5. **the re-read did not run, or this issue's own call failed** — kept.
 *   6. **asked for by UUID, and Linear does not have it** — `gone-from-jira`.
 *   7. **asked, and the re-read resolves to a `done` column** (`completed`/`canceled`) —
 *      kept and retained, even if the card was not already finished, and its clock starts.
 *   8. **asked, still not done, and nothing is retaining it** — `left-query`.
 *   9. **retained past its window** — `retention-expired`.
 *  10. otherwise — upserted from the re-read issue, with its retention clock preserved.
 *
 * Whatever survives that is put to `guardRemovals`, here rather than in the caller.
 */
export function reconcileLinearIssues(
  existing: Task[],
  issues: LinearIssue[],
  opts: LinearIssueSyncOptions,
): LinearIssueSyncResult {
  const existingByUuid = linearTasksByUuid(existing);
  const seen = new Set<string>();

  const upserts: Task[] = [];
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    seen.add(issue.id);
    const prior = existingByUuid.get(issue.id);
    // Archived cards stay off the board even when the fetch returns their issue again — the
    // sync must never resurrect a removed card; only an explicit restore does.
    if (prior?.archivedAt != null) continue;
    upserts.push(issueToTask(issue, prior, opts, i));
  }

  const rechecked = opts.rechecked ?? null;
  const recheckedIds = asSet(opts.recheckedIds);
  const truncated = opts.truncated === true;
  const now = opts.now ?? Date.now();

  // The denominator is the BOARD, not the fetch's answer, which is the very thing under
  // suspicion when this guard matters.
  const onBoardLinearCards = existing.filter(
    (t) => t.source === 'linear' && linearUuidOf(t) != null && t.archivedAt == null,
  );
  const boardCount = onBoardLinearCards.length;
  const missingCount = onBoardLinearCards.filter(
    (t) => !seen.has(linearUuidOf(t) as string),
  ).length;
  const incompleteAnswer = isIncompleteAnswer(missingCount, boardCount, opts);

  const candidates: ForgeRemoval[] = [];

  /**
   * The one funnel every removal goes through, so `truncated` cannot be forgotten in a
   * branch. `key` is the card's current identifier, for display — not the UUID this module
   * actually keys on.
   */
  const drop = (task: Task, reason: ForgeRemovalReason): void => {
    if (truncated || incompleteAnswer) return;
    candidates.push({
      taskId: task.id,
      key: task.externalKey ?? '',
      title: task.title,
      reason,
    });
  };

  for (const task of existing) {
    if (task.source !== 'linear') continue;
    const uuid = linearUuidOf(task);
    if (uuid == null || seen.has(uuid)) continue;
    // Already off the board, and the fetch has not brought it back: say nothing about it.
    if (task.archivedAt != null) continue;
    // Keep blocked cards even when they leave the fetch — and read where the card RESTS, so
    // one whose agent is mid-run isn't removed out from under the session.
    if (restingStatus(task) === 'blocked') continue;

    // The re-read didn't run (or failed outright). Keep the card untouched rather than retire
    // it on a question nobody put; its clock simply starts on the next sync that does ask.
    if (rechecked === null) continue;
    // Same rule one level finer: this issue's own call errored, so `rechecked` not listing it
    // says nothing at all.
    if (recheckedIds !== null && !recheckedIds.has(uuid)) continue;

    const issue = rechecked.get(uuid);
    // Linear answered and does not have it: deleted, or invisible to this token.
    if (!issue) {
      drop(task, 'gone-from-jira');
      continue;
    }

    // The answer is in hand, so ask it what the column should be rather than only what the
    // card used to say. An issue the human completed or cancelled is finished, whatever
    // column it was sitting in when the fetch dropped it, and that is a card the board KEEPS
    // (and starts a retention clock on) rather than one it archives.
    const column = resolveLinearColumn(
      issue.state.name,
      narrowStateType(issue.state.type),
      opts.overrides,
      opts.learned,
    ).column;
    if (!isRetained(task) && column !== 'done') {
      drop(task, 'left-query');
      continue;
    }

    const since = task.retainedSince ?? now;
    // `>=`, so a retention of 0 retires the card on the very sync that dropped it.
    if (now - since >= (opts.retentionMs ?? 0)) {
      drop(task, 'retention-expired');
      continue;
    }
    upserts.push(issueToTask(issue, task, opts, task.order, since));
  }

  const guarded = guardRemovals(candidates, boardCount, {
    ...opts,
    tracker: 'Linear',
    queryName: 'issue filter',
  });

  const notes: string[] = [];
  if (truncated) {
    notes.push(
      'Linear did not return the whole issue filter, so no card was removed from the board ' +
        'this sync.',
    );
  } else if (incompleteAnswer) {
    notes.push(
      `Linear's answer left out ${missingCount} of ${boardCount} board cards without the ` +
        `filter changing, so no card was removed from the board this sync.`,
    );
  }
  if (guarded.warning) notes.push(guarded.warning);

  return {
    upserts,
    removals: guarded.removals,
    refused: guarded.refused,
    warning: notes.length ? notes.join(' ') : null,
  };
}
