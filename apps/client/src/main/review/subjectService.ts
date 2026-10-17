/**
 * The one entry point `review:subjectSummary`/`review:subjectFile`/`review:subjectImage`/
 * `review:context` (F15.10) call: a `subjectId` in, the right source's answer out, whichever
 * of the three a review subject's diff happens to live in right now.
 *
 * A `task` subject's reads go straight to {@link DiffService}'s own task-facing methods — it
 * already knows how to resolve a card to its worktree or branch and answer `stale`/`landed`/
 * `conflicted`/`no-branch` on its own.
 *
 * A `pr` subject has no such single owner. `summary()` is the only place that DECIDES which
 * of `local-ref`/`forge-api` answers a subject: it resolves the full {@link ReviewSubject}
 * (`findPrSubject`, since a bare `subjectId` carries no `repoPath`), reads the forge's own
 * detail, and tries {@link DiffService.resolvePrLocal} against it. Success remembers the
 * resolved diff under `local-ref`; anything else answers from {@link ForgeDiffSource} instead,
 * with `fallbackReason` set to say why, and remembers the subject under `forge-api`.
 *
 * Every later `file`/`image`/`context` call for that subject follows what `summary()` last
 * decided — the routing rule a PR's reads need and a task's don't: `local-ref` is routed back
 * into `DiffService`'s `*In` methods against the SAME `ResolvedDiff`, checking `diffId`
 * against it ourselves (an old id answers `stale` right here, with no further calls), while
 * `forge-api` is handed straight to `ForgeDiffSource`, which already knows how to answer
 * `stale` against its own memory of the subject's current revision. A subject with no
 * `summary()` behind it yet has nothing to route by and throws.
 */
import type { ForgeProvider } from '@shared/mergeRequest';
import {
  parseSubjectId,
  type DiffContextResult,
  type DiffFileResult,
  type DiffImageResult,
  type DiffSide,
  type DiffStale,
  type DiffSummaryResult,
  type ReviewSubjectKey,
} from '@shared/review';
import type { Store } from '../store';
import { DiffService, type PrLocalResult, type ResolvedDiff } from './diffService';
import { ForgeDiffSource, type PrSubject } from './forgeDiffSource';

export interface ReviewSubjectServiceDeps {
  diffs: Pick<
    DiffService,
    | 'summary'
    | 'file'
    | 'image'
    | 'context'
    | 'resolvePrLocal'
    | 'summaryFor'
    | 'fileIn'
    | 'imageIn'
    | 'contextIn'
  >;
  forge: Pick<ForgeDiffSource, 'detail' | 'summary' | 'file' | 'image' | 'context'>;
  store: Pick<Store, 'listReviewQueue' | 'listMergeRequests'>;
  /** The git-remote-style host a provider's forge calls are configured against (`hostOf`, `queueService.ts`). */
  hostFor(provider: ForgeProvider): string;
}

/** What `summary()` decided for a `pr` subject, so a later read knows where to go. */
type PrResolution =
  | { source: 'local-ref'; subject: PrSubject; resolved: ResolvedDiff }
  | { source: 'forge-api'; subject: PrSubject };

/** The human-readable reason a PR fell back to `forge-api`, for the source badge's tooltip. */
function fallbackReasonFor(result: Exclude<PrLocalResult, { status: 'ok' }>): string {
  switch (result.status) {
    case 'no-project':
      return 'no project with a local clone of this repository is open';
    case 'fetch-failed':
      return result.reason;
    case 'stale':
      return `the local clone's fetched head (${result.headSha}) does not match the pull request's (${result.forgeHeadSha})`;
  }
}

export class ReviewSubjectService {
  constructor(private readonly deps: ReviewSubjectServiceDeps) {}

  /** `subjectId` → the last `summary()` decided for it. Empty until a subject is summarized. */
  private readonly resolutions = new Map<string, PrResolution>();

  async summary(id: string): Promise<DiffSummaryResult> {
    const key = this.parseKey(id);
    if (key.kind === 'task') return this.deps.diffs.summary(key.taskId);
    return this.summaryForPr(id);
  }

  async file(id: string, diffId: string, path: string): Promise<DiffFileResult> {
    const key = this.parseKey(id);
    if (key.kind === 'task') return this.deps.diffs.file(key.taskId, diffId, path);
    return this.forPr(
      id,
      diffId,
      async (resolved) => ({
        status: 'ok',
        file: await this.deps.diffs.fileIn(resolved, diffId, path),
      }),
      (subject) => this.deps.forge.file(subject, diffId, path),
    );
  }

  async image(id: string, diffId: string, path: string): Promise<DiffImageResult> {
    const key = this.parseKey(id);
    if (key.kind === 'task') return this.deps.diffs.image(key.taskId, diffId, path);
    return this.forPr(
      id,
      diffId,
      async (resolved) => ({
        status: 'ok',
        image: await this.deps.diffs.imageIn(resolved, diffId, path),
      }),
      (subject) => this.deps.forge.image(subject, diffId, path),
    );
  }

  async context(
    id: string,
    diffId: string,
    path: string,
    side: DiffSide,
    from: number,
    to: number,
  ): Promise<DiffContextResult> {
    const key = this.parseKey(id);
    if (key.kind === 'task')
      return this.deps.diffs.context(key.taskId, diffId, path, side, from, to);
    return this.forPr(
      id,
      diffId,
      async (resolved) => ({
        status: 'ok',
        context: await this.deps.diffs.contextIn(resolved, diffId, path, side, from, to),
      }),
      (subject) => this.deps.forge.context(subject, diffId, path, side, from, to),
    );
  }

  private parseKey(id: string): ReviewSubjectKey {
    const key = parseSubjectId(id);
    if (!key) throw new Error(`Not a review subject: ${id}`);
    return key;
  }

  /**
   * Decides, for a `pr` subject, whether its diff lives in a local clone or has to be read
   * from the forge's own API — the one place that call is made, so every later `file`/
   * `image`/`context` for this subject can just look up what was decided here.
   */
  private async summaryForPr(id: string): Promise<DiffSummaryResult> {
    const subject = this.findPrSubject(id);
    const host = this.deps.hostFor(subject.provider);
    const revision = await this.deps.forge.detail(subject);
    const local = await this.deps.diffs.resolvePrLocal({
      subject,
      host,
      headSha: revision.headSha,
      baseBranch: revision.baseRef,
    });
    if (local.status === 'ok') {
      this.resolutions.set(id, { source: 'local-ref', subject, resolved: local.resolved });
      return { status: 'ok', summary: await this.deps.diffs.summaryFor(local.resolved) };
    }
    this.resolutions.set(id, { source: 'forge-api', subject });
    const summary = await this.deps.forge.summary(subject);
    return { status: 'ok', summary: { ...summary, fallbackReason: fallbackReasonFor(local) } };
  }

  /**
   * Routes a `pr` subject's `file`/`image`/`context` read by what `summary()` last decided:
   * `local-ref` goes to `viaLocal` against the remembered `ResolvedDiff`, after checking
   * `diffId` against it ourselves (`DiffService`'s `*In` methods take an already-resolved
   * diff and do not check staleness on their own); `forge-api` goes straight to `viaForge`,
   * which already knows how to answer `stale` on its own.
   */
  private async forPr<R>(
    id: string,
    diffId: string,
    viaLocal: (resolved: ResolvedDiff) => Promise<R>,
    viaForge: (subject: PrSubject) => Promise<R | DiffStale>,
  ): Promise<R | DiffStale> {
    const resolution = this.resolutions.get(id);
    if (!resolution) throw new Error(`${id} has no summary loaded yet.`);
    if (resolution.source === 'forge-api') return viaForge(resolution.subject);
    if (resolution.resolved.diffId !== diffId) {
      return { status: 'stale', diffId, currentDiffId: resolution.resolved.diffId };
    }
    return viaLocal(resolution.resolved);
  }

  /**
   * The full {@link ReviewSubject} behind a `pr` subjectId — the one thing `parseSubjectId`
   * cannot recover, since `repoPath` is never encoded in the id itself. Checked against the
   * review queue cache first (its rows already carry the subject whole), then against the
   * board's own `merge_requests` (`MergeRequest.id` is the very same `gh-`/`gl-` string).
   * Throws when neither knows this subject — nothing to read a diff FROM.
   */
  private findPrSubject(id: string): PrSubject {
    const queued = this.deps.store.listReviewQueue().find((row) => row.item.subjectId === id)
      ?.item.subject;
    if (queued?.kind === 'pr') return queued;
    const mr = this.deps.store.listMergeRequests().find((m) => m.id === id);
    if (mr) {
      return {
        kind: 'pr',
        provider: mr.provider,
        repoId: mr.repoId,
        repoPath: mr.projectPath,
        number: mr.number,
      };
    }
    throw new Error(`${id} is not in any review queue.`);
  }
}
