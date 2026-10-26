/**
 * The three review queues — *Requested from me*, *My PRs/MRs* and *Agent cards awaiting
 * review* (F15.9, `docs/plan/feature-roadmap/F15-review-workspace.md`) — refreshed from the
 * forges and the store, cached in `review_queue` so the sidebar count survives a restart
 * with no round trip, and reconciled so a short answer or a forge outage never drops a row
 * a COMPLETE pass did not actually say was gone.
 *
 * **Segments, not queues, are the unit a refresh reconciles.** `requested` is really two
 * independent network calls — GitHub's `listReviewRequests()` and GitLab's
 * `listReviewerMergeRequests(username)` — so it splits into segments `requested:github` and
 * `requested:gitlab`, reconciled independently: a GitHub outage must not touch GitLab's rows
 * in the same `requested` queue, and vice versa. `mine` (a synchronous read of
 * `store.listMergeRequests()`, no forge call) and `agent` (a synchronous read of the store's
 * own tasks) are each one segment, always complete.
 *
 * **Forge-disabled is a complete empty answer; a throw (including "no token") is a
 * failure.** `store.getSettings().github.enabled`/`.gitlab.enabled` is checked BEFORE
 * building a client — when off, the segment answers `{ rows: [], complete: true }` straight
 * away, so turning an integration off clears its rows out of the cache instead of leaving
 * them stranded forever. Only once enabled is a client actually built; `deps.github()`/
 * `deps.gitlab()` throw when no token is saved (`ipc.ts`'s own `buildGitHubClient`/
 * `buildGitLabClient`), and that throw — along with any network failure from the list call
 * itself, and a `requested:gitlab` segment with no cached username yet — is the `failure`
 * case: no writes, existing rows and `syncedAt` left exactly as stored.
 *
 * **Enrichment (`projectId`, `draftCount`, `viewedCount`) runs once per `refresh()`, after
 * every segment's raw rows are collected — not per segment.** A `Map` memoizes
 * `diffs.matchProject` by `` `${host}\n${repoPath}` `` so ten PRs on the same repo cost one
 * match, and `countReviewDrafts`/`countReviewViewed` are each one grouped read over the
 * whole store rather than one query per row.
 *
 * **Dedup happens in `snapshot()`, on the cached rows, every time — never baked into what
 * `refresh()` writes.** A `requested` row whose subject also sits in `mine` is dropped at
 * read time, so a row that stops being deduped (the human's `mine` row lands, or the PR
 * closes) does not need `refresh()` to run again first.
 */
import {
  mrRef,
  type ForgeProvider,
  type MergeRequest,
  type PipelineStatus,
} from '@shared/mergeRequest';
import type { Task } from '@shared/model';
import {
  subjectId,
  taskSubjectId,
  type ReviewQueue,
  type ReviewQueueItem,
  type ReviewQueuesSnapshot,
  type ReviewSubject,
} from '@shared/review';
import type { AppSettings } from '@shared/settings';
import { repoRefFromApiUrl } from '../github/describePullRequest';
import type { GitHubClient, GitHubSearchIssueItem } from '../github/githubClient';
import { projectPathOf } from '../gitlab/describeMergeRequest';
import {
  toPipelineStatus,
  type GitLabClient,
  type GitLabMergeRequest,
} from '../gitlab/gitlabClient';
import type { Store } from '../store';
import type { DiffService } from './diffService';

/** One cached row — a `ReviewQueueItem` paired with when it was last synced. */
export interface QueuedRow {
  item: ReviewQueueItem;
  syncedAt: number;
}

/** What one refresh segment came back with. */
export type SegmentResult = { rows: ReviewQueueItem[]; complete: boolean } | 'failure';

/** One refresh segment's identity — a whole queue, or one provider's half of `requested`. */
export interface QueueSegment {
  queue: ReviewQueue;
  provider?: ForgeProvider;
}

const QUEUES: readonly ReviewQueue[] = ['requested', 'mine', 'agent'];

export interface ReviewQueueServiceDeps {
  store: Pick<
    Store,
    | 'listReviewQueue'
    | 'applyReviewQueue'
    | 'countReviewDrafts'
    | 'countReviewViewed'
    | 'listMergeRequests'
    | 'listProjects'
    | 'getTasks'
    | 'getSettings'
    | 'loadGitHubIdentity'
    | 'loadGitLabIdentity'
  >;
  diffs: Pick<DiffService, 'matchProject' | 'pruneReviewRefs'>;
  /** Throws when GitHub is disabled or no token is saved — `ipc.ts`'s own `buildGitHubClient`. */
  github(): GitHubClient;
  /** Same, for GitLab — `buildGitLabClient`. */
  gitlab(): GitLabClient;
  /** Called with the new snapshot, only when it differs from the previous one. */
  emit(snapshot: ReviewQueuesSnapshot): void;
  /** Overridable for tests; `Date.now` otherwise. */
  now?(): number;
}

/**
 * A GitHub search row for a review-requested PR → a `requested` item. `repoId` is resolved
 * by the caller (a search row carries only `repository_url`, which names the repo but not
 * its numeric id) — see {@link ReviewQueueService}'s repo-id map.
 */
export function githubRowToItem(row: GitHubSearchIssueItem, repoId: number): ReviewQueueItem {
  const { owner, repo } = repoRefFromApiUrl(row.repository_url);
  const repoPath = `${owner}/${repo}`;
  const subject: ReviewSubject = {
    kind: 'pr',
    provider: 'github',
    repoId,
    repoPath,
    number: row.number,
  };
  return {
    subjectId: subjectId(subject),
    queue: 'requested',
    subject,
    title: row.title,
    author: row.user?.login ?? '',
    repoPath,
    ref: mrRef({ provider: 'github', number: row.number }),
    headSha: null,
    draft: row.draft ?? false,
    updatedAt: Date.parse(row.updated_at) || 0,
    projectId: null,
    taskId: null,
    draftCount: 0,
    viewedCount: 0,
    fileCount: null,
  };
}

/**
 * A GitLab reviewer-MR row → a `requested` item. Unlike GitHub's search row, this carries a
 * numeric `project_id` already — no repo-id lookup needed.
 */
export function gitlabRowToItem(row: GitLabMergeRequest): ReviewQueueItem {
  const repoPath = projectPathOf(row);
  const subject: ReviewSubject = {
    kind: 'pr',
    provider: 'gitlab',
    repoId: row.project_id,
    repoPath,
    number: row.iid,
  };
  return {
    subjectId: subjectId(subject),
    queue: 'requested',
    subject,
    title: row.title,
    author: row.author?.name ?? row.author?.username ?? '',
    repoPath,
    ref: mrRef({ provider: 'gitlab', number: row.iid }),
    headSha: row.sha ?? null,
    draft: row.draft ?? row.work_in_progress ?? false,
    updatedAt: Date.parse(row.updated_at) || 0,
    projectId: null,
    taskId: null,
    draftCount: 0,
    viewedCount: 0,
    fileCount: null,
    headRef: row.source_branch,
    pipeline: gitlabRowPipeline(row),
  };
}

/**
 * The list row's head pipeline, when it carries one GitLab spelled in a way we know — the
 * list endpoint often omits `head_pipeline`, and that absence is "not known", not `unknown`.
 */
function gitlabRowPipeline(row: GitLabMergeRequest): PipelineStatus | null {
  const status = toPipelineStatus(row.head_pipeline?.status);
  return status === 'unknown' ? null : status;
}

/**
 * One of the board's own `merge_requests` rows → a `mine` item. `authorFor` reads the
 * cached forge identity for the row's own provider — a `mine` row is, by construction,
 * always authored by the signed-in user, so there is no forge payload of its own to read an
 * author off.
 */
export function mergeRequestToItem(
  mr: MergeRequest,
  authorFor: (provider: ForgeProvider) => string,
): ReviewQueueItem {
  const subject: ReviewSubject = {
    kind: 'pr',
    provider: mr.provider,
    repoId: mr.repoId,
    repoPath: mr.projectPath,
    number: mr.number,
  };
  return {
    subjectId: subjectId(subject),
    queue: 'mine',
    subject,
    title: mr.displayName ?? mr.title,
    author: authorFor(mr.provider),
    repoPath: mr.projectPath,
    ref: mrRef(mr),
    headSha: mr.headSha,
    draft: mr.draft,
    updatedAt: mr.updatedAt,
    projectId: null,
    taskId: mr.taskId,
    draftCount: 0,
    viewedCount: 0,
    fileCount: null,
    headRef: mr.sourceBranch,
    pipeline: mr.pipelineStatus,
  };
}

/**
 * A top-level card awaiting review → an `agent` item. `projectId` is filled straight from
 * the task — no `matchProject` call needed, unlike a PR row — and `updatedAt` is
 * `task.workedAt`, non-null by construction: {@link agentQueueRows}'s predicate already
 * requires it.
 */
export function taskToItem(task: Task, projectName: string): ReviewQueueItem {
  const subject: ReviewSubject = { kind: 'task', taskId: task.id };
  return {
    subjectId: taskSubjectId(task.id),
    queue: 'agent',
    subject,
    title: task.title,
    author: '',
    repoPath: projectName,
    ref: '',
    headSha: null,
    draft: false,
    updatedAt: task.workedAt ?? 0,
    projectId: task.projectId,
    taskId: task.id,
    draftCount: 0,
    viewedCount: 0,
    fileCount: null,
  };
}

/**
 * Every top-level card the `agent` queue wants: `in-review`, something actually ran
 * (`workedAt`), and not already merged (`landedAt`). A step of an approved plan is not its
 * own review subject, hence `parentTaskId == null`. Always complete — a store read cannot
 * truncate or go offline.
 */
function agentQueueRows(
  deps: Pick<ReviewQueueServiceDeps['store'], 'listProjects' | 'getTasks'>,
): ReviewQueueItem[] {
  const items: ReviewQueueItem[] = [];
  for (const project of deps.listProjects()) {
    for (const task of deps.getTasks(project.id)) {
      if (task.parentTaskId != null) continue;
      if (task.status !== 'in-review') continue;
      if (task.workedAt == null) continue;
      if (task.landedAt != null) continue;
      items.push(taskToItem(task, project.name));
    }
  }
  return items;
}

/**
 * Whether a cached row belongs to the given segment — a whole queue, or (for `requested`)
 * one provider's half of it, read back out of the row's own `subject.provider` since the
 * table carries no provider column.
 */
function rowInSegment(row: QueuedRow, segment: QueueSegment): boolean {
  if (row.item.queue !== segment.queue) return false;
  if (!segment.provider) return true;
  return row.item.subject.kind === 'pr' && row.item.subject.provider === segment.provider;
}

/**
 * The pure reconciliation a refresh segment performs on a set of cached rows — the same
 * semantics `Store.applyReviewQueue` carries out in SQL, restated here so it is directly
 * unit-testable and so a fake store (in tests) can implement `applyReviewQueue` as one call
 * to this.
 *
 * `failure` changes nothing. `complete: false` upserts every returned row and deletes
 * nothing in this segment — a row this round did not mention keeps its last known state.
 * `complete: true` upserts every returned row, then drops every OTHER cached row in this
 * exact segment.
 */
export function reconcileSegment(
  cached: readonly QueuedRow[],
  result: SegmentResult,
  syncedAt: number,
  segment: QueueSegment,
): QueuedRow[] {
  if (result === 'failure') return [...cached];
  const outside = cached.filter((row) => !rowInSegment(row, segment));
  const returned = new Set(result.rows.map((item) => item.subjectId));
  const kept = result.complete
    ? []
    : cached.filter((row) => rowInSegment(row, segment) && !returned.has(row.item.subjectId));
  const fresh = result.rows.map((item): QueuedRow => ({ item, syncedAt }));
  return [...outside, ...kept, ...fresh];
}

/**
 * Drop any `requested` row whose subject also sits in `mine` — the case a PR that is both
 * mine and requested is shown once, under *My PRs/MRs*. Read-time, not write-time: a row
 * that stops being deduped does not need another `refresh()` first.
 */
export function dedupe(rows: readonly QueuedRow[]): QueuedRow[] {
  const mineIds = new Set(
    rows.filter((row) => row.item.queue === 'mine').map((row) => row.item.subjectId),
  );
  return rows.filter((row) => !(row.item.queue === 'requested' && mineIds.has(row.item.subjectId)));
}

/**
 * The git-remote-style host for a forge's configured API base URL, for `matchProject` — and,
 * via `ipc.ts`'s own `hostFor`, what `ReviewSubjectService` resolves a PR's provider to
 * (F15.10).
 */
export function hostOf(baseUrl: string): string {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    // `api.github.com` is the API root; the remote every project clone actually carries
    // is `github.com` — the same substitution `forge/remoteUrl.ts` makes for the reverse
    // direction.
    return hostname === 'api.github.com' ? 'github.com' : hostname;
  } catch {
    return '';
  }
}

export class ReviewQueueService {
  private readonly now: () => number;
  private inFlight: Promise<void> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private previousSnapshotKey: string | null = null;
  private readonly partialState: Record<ReviewQueue, boolean> = {
    requested: false,
    mine: false,
    agent: false,
  };

  constructor(private readonly deps: ReviewQueueServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The cached snapshot, deduped — synchronous, so opening the workspace never waits. */
  snapshot(): ReviewQueuesSnapshot {
    const rows = dedupe(this.deps.store.listReviewQueue());
    const asOf: Record<ReviewQueue, number | null> = { requested: null, mine: null, agent: null };
    for (const queue of QUEUES) {
      const synced = rows.filter((row) => row.item.queue === queue).map((row) => row.syncedAt);
      asOf[queue] = synced.length > 0 ? Math.min(...synced) : null;
    }
    return {
      items: rows.map((row) => row.item),
      asOf,
      partial: QUEUES.filter((queue) => this.partialState[queue]),
    };
  }

  /** The cached snapshot, and fires a full refresh without waiting for it. */
  open(): ReviewQueuesSnapshot {
    void this.refresh();
    return this.snapshot();
  }

  /** `refresh()` once, then every 5 minutes until {@link stop}. */
  async start(): Promise<void> {
    await this.refresh();
    this.interval = setInterval(() => void this.refresh(), 5 * 60_000);
    this.interval.unref?.();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /**
   * Every segment: the two `requested` forge calls, `mine` and `agent`. Concurrent callers
   * share one in-flight pass.
   */
  async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runRefresh({ local: false }).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * Only `mine` + `agent` — no forge call, so nothing to dedup concurrency for. For a card
   * leaving `in-review`, or a merge-request sync landing, so either drops out of its queue
   * without waiting for the 5-minute timer. Never prunes refs: pruning is only meaningful
   * once the `requested` segments have had their say too.
   */
  async refreshLocal(): Promise<void> {
    await this.runRefresh({ local: true });
  }

  private async runRefresh(opts: { local: boolean }): Promise<void> {
    const settings = this.deps.store.getSettings();
    const syncedAt = this.now();

    const mineResult: SegmentResult = { rows: this.mineRows(), complete: true };
    const agentResult: SegmentResult = { rows: agentQueueRows(this.deps.store), complete: true };

    let githubResult: SegmentResult | null = null;
    let gitlabResult: SegmentResult | null = null;
    if (!opts.local) {
      [githubResult, gitlabResult] = await Promise.all([
        this.requestedGitHub(settings),
        this.requestedGitLab(settings),
      ]);
    }

    const segments: Array<{ segment: QueueSegment; result: SegmentResult }> = [
      { segment: { queue: 'mine' }, result: mineResult },
      { segment: { queue: 'agent' }, result: agentResult },
    ];
    if (githubResult)
      segments.push({ segment: { queue: 'requested', provider: 'github' }, result: githubResult });
    if (gitlabResult)
      segments.push({ segment: { queue: 'requested', provider: 'gitlab' }, result: gitlabResult });

    await this.enrichAndWrite(segments, syncedAt, settings);

    if (!opts.local) {
      this.partialState.requested = isIncomplete(githubResult) || isIncomplete(gitlabResult);
      await this.pruneRefs();
    }

    this.emitIfChanged();
  }

  private mineRows(): ReviewQueueItem[] {
    const github = this.deps.store.loadGitHubIdentity();
    const gitlab = this.deps.store.loadGitLabIdentity();
    const authorFor = (provider: ForgeProvider): string =>
      provider === 'github' ? (github?.login ?? '') : (gitlab?.username ?? '');
    return this.deps.store.listMergeRequests().map((mr) => mergeRequestToItem(mr, authorFor));
  }

  private async requestedGitHub(settings: AppSettings): Promise<SegmentResult> {
    if (!settings.github.enabled) return { rows: [], complete: true };
    try {
      const client = this.deps.github();
      const search = await client.listReviewRequests();
      const repoIds = new Map<string, number>();
      for (const mr of this.deps.store.listMergeRequests()) {
        if (mr.provider === 'github') repoIds.set(mr.projectPath.toLowerCase(), mr.repoId);
      }
      const rows: ReviewQueueItem[] = [];
      let unresolved = false;
      for (const item of search.items) {
        const { owner, repo } = repoRefFromApiUrl(item.repository_url);
        const key = `${owner}/${repo}`.toLowerCase();
        let repoId = repoIds.get(key);
        if (repoId === undefined) {
          try {
            const repository = await client.getRepository(owner, repo);
            repoId = repository.id;
            repoIds.set(key, repoId);
          } catch {
            unresolved = true;
            continue;
          }
        }
        rows.push(githubRowToItem(item, repoId));
      }
      return { rows, complete: !search.truncated && !search.incompleteResults && !unresolved };
    } catch {
      return 'failure';
    }
  }

  private async requestedGitLab(settings: AppSettings): Promise<SegmentResult> {
    if (!settings.gitlab.enabled) return { rows: [], complete: true };
    const identity = this.deps.store.loadGitLabIdentity();
    if (!identity?.username) return 'failure';
    try {
      const client = this.deps.gitlab();
      const { mergeRequests, truncated } = await client.listReviewerMergeRequests(
        identity.username,
      );
      return { rows: mergeRequests.map(gitlabRowToItem), complete: !truncated };
    } catch {
      return 'failure';
    }
  }

  /**
   * `projectId`/`draftCount`/`viewedCount`, over every segment's raw rows at once, then the
   * reconciliation write per segment.
   */
  private async enrichAndWrite(
    segments: Array<{ segment: QueueSegment; result: SegmentResult }>,
    syncedAt: number,
    settings: AppSettings,
  ): Promise<void> {
    const draftCounts = this.deps.store.countReviewDrafts();
    const viewedCounts = this.deps.store.countReviewViewed();
    const projectIdByHostPath = new Map<string, string | null>();
    const githubHost = hostOf(settings.github.baseUrl);
    const gitlabHost = hostOf(settings.gitlab.baseUrl);

    const resolveProjectId = async (item: ReviewQueueItem): Promise<string | null> => {
      if (item.projectId !== null) return item.projectId;
      if (item.subject.kind !== 'pr') return null;
      const host = item.subject.provider === 'github' ? githubHost : gitlabHost;
      const key = `${host}\n${item.subject.repoPath}`;
      if (projectIdByHostPath.has(key)) return projectIdByHostPath.get(key) ?? null;
      const match = await this.deps.diffs.matchProject(host, item.subject.repoPath);
      const projectId = match?.project.id ?? null;
      projectIdByHostPath.set(key, projectId);
      return projectId;
    };

    for (const { segment, result } of segments) {
      if (result === 'failure') continue;
      const enriched: ReviewQueueItem[] = [];
      for (const item of result.rows) {
        enriched.push({
          ...item,
          projectId: await resolveProjectId(item),
          draftCount: draftCounts.get(item.subjectId) ?? 0,
          viewedCount: viewedCounts.get(item.subjectId) ?? 0,
        });
      }
      this.deps.store.applyReviewQueue(segment, enriched, syncedAt, { complete: result.complete });
    }
  }

  private async pruneRefs(): Promise<void> {
    const keep = new Set(this.deps.store.listReviewQueue().map((row) => row.item.subjectId));
    await this.deps.diffs.pruneReviewRefs(keep);
  }

  private emitIfChanged(): void {
    const next = this.snapshot();
    const key = JSON.stringify(next);
    if (key === this.previousSnapshotKey) return;
    this.previousSnapshotKey = key;
    this.deps.emit(next);
  }
}

function isIncomplete(result: SegmentResult | null): boolean {
  if (result === null) return false;
  return result === 'failure' || !result.complete;
}
