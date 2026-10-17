/**
 * The desktop's answers to `task:diffSummary`, `task:diffFile` and `task:diffImage` (F6.6,
 * `docs/plan/feature-roadmap/F6-in-app-code-review.md`).
 *
 * It resolves a card to the thing its agent changed — the live worktree when there is one
 * (committed work AND what the agent has not committed yet), otherwise the task branch in the
 * project repo — and diffs it from the base branch's merge base, so the human reviews only
 * what the agent wrote and not what landed on base meanwhile.
 *
 * Four answers that are not a diff, each one a state the pane draws on purpose rather than a
 * git error it has to apologise for:
 *
 *  - `conflicted` — the worktree is mid-rebase or has unmerged paths. Conflict handling stays
 *    with the existing flow; drawing a diff of a half-rebased tree would anchor comments to a
 *    revision nobody will ever see again.
 *  - `landed` — the work merged and its worktree/branch were cleaned up. Must read differently
 *    from an empty diff (memory *a-merge-is-invisible*).
 *  - `no-branch` — the card never produced a branch, or its base cannot be read.
 *  - `stale` — a file read named a `diffId` the worktree has moved on from. Every read
 *    recomputes the id, so a comment is only ever anchored to a revision the human saw.
 *
 * Everything git-shaped goes through {@link DiffGit}, so the service is tested with a fake
 * (`diffService.test.ts`) and the real one is a thin binding of `git.ts` to the project's
 * `ExecHost` ({@link createDiffGit}).
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { hasRepo, type Project, type Task } from '@shared/model';
import type { ForgeProvider, MergeRequest } from '@shared/mergeRequest';
import {
  DIFF_FILE_MAX_BYTES,
  DIFF_IMAGE_MAX_BYTES,
  DIFF_SUMMARY_MAX_FILES,
  LOCAL_REF_CAPABILITIES,
  parsePatch,
  sliceContext,
  subjectId,
  taskSubjectId,
  WORKTREE_CAPABILITIES,
  type DiffContext,
  type DiffContextResult,
  type DiffFile,
  type DiffFileEntry,
  type DiffFileResult,
  type DiffImage,
  type DiffImageResult,
  type DiffImageSide,
  type DiffSide,
  type DiffSummary,
  type DiffSummaryResult,
  type ReviewCapabilities,
  type ReviewSource,
  type ReviewSubject,
} from '@shared/review';
import { diffStatOf, type VariantDiffStat } from '@shared/variants';
import type { ExecHost } from '../exec';
import {
  blobSize,
  branchExists,
  conflictedFiles,
  currentBranch,
  deleteRefs,
  diffFilePatch,
  diffNameStatus,
  diffWorkingTree,
  fetchRefspecs,
  git,
  listRemotes,
  listUntracked,
  mergeBase,
  readWorkingFile,
  rebaseInProgress,
  reviewRef,
  REVIEW_REF_PREFIX,
  showBlob,
  type GitResult,
  type NameStatusEntry,
} from '../git';
import { parseRemoteUrl, type RemoteRef } from '../forge/remoteUrl';
import { taskBranch } from '../worktreeManager';

/** The git reads the service needs, already bound to one project's host. */
export interface DiffGit {
  /** The commit SHA `ref` names, or `''` when it names nothing. */
  revParse(dir: string, ref: string): Promise<string>;
  branchExists(dir: string, branch: string): Promise<boolean>;
  currentBranch(dir: string): Promise<string>;
  mergeBase(dir: string, a: string, b: string): Promise<string>;
  rebaseInProgress(dir: string): Promise<boolean>;
  conflictedFiles(dir: string): Promise<string[]>;
  /** A cheap identity for the work tree's uncommitted state — `''` when it is clean. */
  workingTreeFingerprint(dir: string): Promise<string>;
  /** Committed diff `from..to`. */
  nameStatus(dir: string, from: string, to: string): Promise<NameStatusEntry[]>;
  /** `from` against the work tree, untracked files included. */
  workingTree(dir: string, from: string): Promise<NameStatusEntry[]>;
  filePatch(
    dir: string,
    req: { from: string; to: string | null; path: string; oldPath?: string; untracked?: boolean },
  ): Promise<string | null>;
  /** Byte size of each path at `ref`, or in the work tree when `ref` is null; absent = unknown. */
  fileSizes(dir: string, ref: string | null, paths: string[]): Promise<Map<string, number>>;
  /** Byte size of `path` at `ref` (`null` = work tree), `-1` when unknown. */
  fileSize(dir: string, ref: string | null, path: string): Promise<number>;
  /** Raw bytes of `path` at `ref` (`null` = work tree), or null. */
  readFile(dir: string, ref: string | null, path: string): Promise<Buffer | null>;
}

/**
 * The git reads/writes `resolvePrLocal` and `pruneReviewRefs` need, kept separate from
 * {@link DiffGit} so the existing fake in `diffService.test.ts` still compiles unchanged.
 */
export interface ReviewRefGit {
  listRemotes(dir: string): Promise<{ name: string; fetchUrl: string; pushUrl: string }[]>;
  fetchRefspecs(
    dir: string,
    remoteOrUrl: string,
    specs: readonly string[],
    opts?: { url?: string; secrets?: readonly string[] },
  ): Promise<GitResult>;
  /** Every ref under `prefix`, full name (`refs/tm/review/<id>/<side>`). */
  listRefs(dir: string, prefix: string): Promise<string[]>;
  deleteRefs(dir: string, prefix: string): Promise<GitResult>;
}

export interface DiffServiceDeps {
  getTask(id: string): Task | undefined;
  getProject(id: string): Project | undefined;
  /** `WorktreeManager.inspect` — reads the live worktree, never creates one. */
  inspect(
    project: Project,
    ownerTaskId: string,
    branchName?: string,
  ): Promise<{ cwd: string; branch: string; base: string } | null>;
  gitFor(project: Project): DiffGit;
  listMergeRequests(): MergeRequest[];
  /** Every project the app knows about — `resolvePrLocal`'s and `pruneReviewRefs`' search space. */
  listProjects?(): Project[];
  refGitFor?(project: Project): ReviewRefGit;
  /**
   * Auth for a fetch against `remote` (already parsed from `fetchUrl`) on behalf of
   * `provider` — the tokenized URL for an https remote, built the way
   * `resolveForgeGitTarget` does it (`forge/createPr.ts`). `null` means "fetch the named
   * remote as is": no token saved, or nothing to inject (an ssh remote authenticates with
   * a key).
   */
  fetchAuthFor?(
    provider: ForgeProvider,
    remote: RemoteRef,
    fetchUrl: string,
  ): { url?: string; secrets: string[] } | null;
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

/** The MIME type for an image path, or null when the extension is not one the pane previews. */
export function imageMimeOf(path: string): string | null {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? null : (IMAGE_MIME[path.slice(dot + 1).toLowerCase()] ?? null);
}

/** Length of `bytes` once base64-encoded — what the image cap is measured in. */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** `diffId`: a short hash of (base, head, work-tree fingerprint). */
export function computeDiffId(baseSha: string, headSha: string, fingerprint: string): string {
  return createHash('sha256')
    .update(`${baseSha}\0${headSha}\0${fingerprint}`)
    .digest('hex')
    .slice(0, 12);
}

/** Where a subject's diff lives right now, with the revision it was taken at. */
export interface ResolvedDiff {
  git: DiffGit;
  /** The worktree, or the project repo when only the branch is left. */
  dir: string;
  baseRef: string;
  /** The merge base — what the diff is taken FROM. */
  baseSha: string;
  headSha: string;
  /** Null when the work tree is included (no worktree = the branch tip). */
  to: string | null;
  includesWorkingTree: boolean;
  diffId: string;
  source: ReviewSource;
  subjectId: string;
  capabilities: ReviewCapabilities;
}

/** Where a card's diff lives right now, with the revision it was taken at. */
type Resolved = Exclude<DiffSummaryResult, { status: 'ok' }> | ({ status: 'ok' } & ResolvedDiff);

/** What `resolvePrLocal` needs: the forge's own view of the PR, independent of any card. */
export interface PrLocalRequest {
  subject: Extract<ReviewSubject, { kind: 'pr' }>;
  host: string;
  headSha: string;
  baseBranch: string;
}

export type PrLocalResult =
  | { status: 'ok'; resolved: ResolvedDiff }
  | { status: 'no-project' }
  | { status: 'fetch-failed'; reason: string }
  | { status: 'stale'; headSha: string; forgeHeadSha: string };

export class DiffService {
  constructor(private readonly deps: DiffServiceDeps) {}

  /** Why the last `resolvePrLocal` fetch for a subject failed — the source badge's tooltip. */
  private readonly fetchFailures = new Map<string, string>();

  fetchFailureFor(id: string): string | null {
    return this.fetchFailures.get(id) ?? null;
  }

  async summary(taskId: string): Promise<DiffSummaryResult> {
    const resolved = await this.resolveTask(taskId);
    if (resolved.status !== 'ok') return resolved;
    return { status: 'ok', summary: await this.summaryFor(resolved) };
  }

  /** The file-list build `summary` and every other subject source share. */
  async summaryFor(resolved: ResolvedDiff): Promise<DiffSummary> {
    const entries = await this.entries(resolved);
    const truncated = entries.length > DIFF_SUMMARY_MAX_FILES;
    const listed = entries.slice(0, DIFF_SUMMARY_MAX_FILES);
    const sizes = await this.sizesOf(resolved, listed);
    const files = listed.map((e): DiffFileEntry => ({
      path: e.path,
      ...(e.oldPath ? { oldPath: e.oldPath } : {}),
      status: e.status,
      additions: e.additions,
      deletions: e.deletions,
      binary: e.binary,
      image: imageMimeOf(e.path) !== null,
      bytes: sizes.get(e.path) ?? 0,
    }));
    return {
      diffId: resolved.diffId,
      baseRef: resolved.baseRef,
      baseSha: resolved.baseSha,
      headSha: resolved.headSha,
      includesWorkingTree: resolved.includesWorkingTree,
      files,
      truncated,
      subjectId: resolved.subjectId,
      source: resolved.source,
      capabilities: resolved.capabilities,
    };
  }

  async file(taskId: string, diffId: string, path: string): Promise<DiffFileResult> {
    const current = await this.current(taskId, diffId);
    if (current.status === 'stale') return current;
    const file = await this.fileIn(current.resolved, diffId, path);
    return { status: 'ok', file };
  }

  /** `file`'s body, for a caller that already holds a `ResolvedDiff` (`resolvePrLocal`'s own). */
  async fileIn(resolved: ResolvedDiff, diffId: string, path: string): Promise<DiffFile> {
    const entry = await this.entryFor(resolved, path);
    return this.fileFrom(resolved, entry, diffId);
  }

  /**
   * Every requested path's patch against the current diff, in one `resolve` and one
   * `entries` call — what F6.8's `ReviewService` recomputes `outdated` against, and
   * anchors a new or moved comment to, without a round trip per file. Null when the
   * resolution itself is not `ok` (landed/conflicted/no-branch); a requested path that is
   * not in the entries maps to `null` rather than throwing, since the caller is checking
   * several paths at once and one missing path should not fail the rest.
   */
  async filesFor(
    taskId: string,
    paths: readonly string[],
  ): Promise<{
    diffId: string;
    files: Map<string, { file: DiffFile; oldPath?: string } | null>;
  } | null> {
    const resolved = await this.resolveTask(taskId);
    if (resolved.status !== 'ok') return null;
    const entries = await this.entries(resolved);
    const files = new Map<string, { file: DiffFile; oldPath?: string } | null>();
    for (const path of paths) {
      const entry = entries.find((e) => e.path === path);
      if (!entry) {
        files.set(path, null);
        continue;
      }
      const file = await this.fileFrom(resolved, entry, resolved.diffId);
      files.set(path, { file, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}) });
    }
    return { diffId: resolved.diffId, files };
  }

  /** The patch→`DiffFile` conversion (the `tooLarge` cap, then `parsePatch`) `file` and `filesFor` share. */
  private async fileFrom(
    resolved: ResolvedDiff,
    entry: NameStatusEntry,
    diffId: string,
  ): Promise<DiffFile> {
    const patch = await resolved.git.filePatch(resolved.dir, {
      from: resolved.baseSha,
      to: resolved.to,
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      ...(entry.untracked ? { untracked: true } : {}),
    });
    if (patch === null) throw new Error(`Couldn't read the changes to ${entry.path}.`);
    const bytes = Buffer.byteLength(patch, 'utf8');
    if (bytes > DIFF_FILE_MAX_BYTES) {
      return { diffId, path: entry.path, hunks: [], tooLarge: { bytes } };
    }
    const hunks = parsePatch(patch)[0]?.hunks ?? [];
    return { diffId, path: entry.path, hunks };
  }

  /**
   * A variant row's diff stat (F10.4): files touched and total added/removed lines, from
   * the full entry list — no `DIFF_SUMMARY_MAX_FILES` truncation, no size reads, since the
   * compare view only ever shows the three counts. `{ 0, 0, 0 }` for anything that is not
   * an ordinary diff (no branch, conflicted, landed) — nothing to compare yet, not a stat
   * worth distinguishing from zero.
   */
  async stat(taskId: string): Promise<VariantDiffStat> {
    const resolved = await this.resolveTask(taskId);
    if (resolved.status !== 'ok') return { files: 0, added: 0, removed: 0 };
    const entries = await this.entries(resolved);
    return diffStatOf(entries);
  }

  async image(taskId: string, diffId: string, path: string): Promise<DiffImageResult> {
    const current = await this.current(taskId, diffId);
    if (current.status === 'stale') return current;
    const image = await this.imageIn(current.resolved, diffId, path);
    return { status: 'ok', image };
  }

  /** `image`'s body, for a caller that already holds a `ResolvedDiff` (`resolvePrLocal`'s own). */
  async imageIn(resolved: ResolvedDiff, diffId: string, path: string): Promise<DiffImage> {
    const entry = await this.entryFor(resolved, path);
    const mime = imageMimeOf(entry.path);
    if (!mime) throw new Error(`${path} is not an image this pane can preview.`);
    const oldSide =
      entry.status === 'added'
        ? null
        : await this.imageSide(resolved, resolved.baseSha, entry.oldPath ?? entry.path, mime);
    const newSide =
      entry.status === 'deleted'
        ? null
        : await this.imageSide(resolved, resolved.to, entry.path, mime);
    return { diffId, path: entry.path, old: oldSide, new: newSide };
  }

  async context(
    taskId: string,
    diffId: string,
    path: string,
    side: DiffSide,
    from: number,
    to: number,
  ): Promise<DiffContextResult> {
    const current = await this.current(taskId, diffId);
    if (current.status === 'stale') return current;
    const context = await this.contextIn(current.resolved, diffId, path, side, from, to);
    return { status: 'ok', context };
  }

  /**
   * `context`'s body, for a caller that already holds a `ResolvedDiff` (`resolvePrLocal`'s
   * own). The ref is `baseSha` for `old` and `resolved.to` for `new` (`null` means the work
   * tree); the path is `entry.oldPath ?? path` on the old side. Weighed BEFORE it is read, the
   * same way {@link imageSide} is: an oversized blob is never pulled through the host just to
   * be thrown away. A side that does not exist (the old side of an added file, the new side
   * of a deleted one) answers `text: []` with no git call at all.
   */
  async contextIn(
    resolved: ResolvedDiff,
    diffId: string,
    path: string,
    side: DiffSide,
    from: number,
    to: number,
  ): Promise<DiffContext> {
    const entry = await this.entryFor(resolved, path);
    const missing =
      (side === 'old' && entry.status === 'added') ||
      (side === 'new' && entry.status === 'deleted');
    if (missing) {
      return { diffId, path, side, start: 0, text: [], truncated: false };
    }
    const ref = side === 'old' ? resolved.baseSha : resolved.to;
    const readPath = side === 'old' ? (entry.oldPath ?? path) : path;
    const size = await resolved.git.fileSize(resolved.dir, ref, readPath);
    if (size > DIFF_FILE_MAX_BYTES) {
      return {
        diffId,
        path,
        side,
        start: 0,
        text: [],
        truncated: false,
        tooLarge: { bytes: size },
      };
    }
    const bytes = await resolved.git.readFile(resolved.dir, ref, readPath);
    return sliceContext(bytes ? bytes.toString('utf8') : '', { diffId, path, side, from, to });
  }

  /**
   * One side of an image, weighed BEFORE it is read: an oversized blob is never pulled
   * through the host just to be thrown away.
   */
  private async imageSide(
    resolved: ResolvedDiff,
    ref: string | null,
    path: string,
    mime: string,
  ): Promise<DiffImageSide | null> {
    const size = await resolved.git.fileSize(resolved.dir, ref, path);
    if (size < 0) return null;
    if (base64Length(size) > DIFF_IMAGE_MAX_BYTES) return { bytes: size, tooLarge: true };
    const bytes = await resolved.git.readFile(resolved.dir, ref, path);
    if (!bytes) return null;
    if (base64Length(bytes.length) > DIFF_IMAGE_MAX_BYTES) {
      return { bytes: bytes.length, tooLarge: true }; // grew between the two reads
    }
    return { bytes: bytes.length, mime, base64: bytes.toString('base64') };
  }

  /**
   * The current revision, or `stale` when it is not the one the caller loaded. A card that
   * has since landed, conflicted or lost its branch is stale too — with an empty
   * `currentDiffId`, since there is no diff to move to; the reload shows why.
   */
  private async current(
    taskId: string,
    diffId: string,
  ): Promise<
    | { status: 'stale'; diffId: string; currentDiffId: string }
    | { status: 'ok'; resolved: ResolvedDiff }
  > {
    const resolved = await this.resolveTask(taskId);
    if (resolved.status !== 'ok') return { status: 'stale', diffId, currentDiffId: '' };
    if (resolved.diffId !== diffId) {
      return { status: 'stale', diffId, currentDiffId: resolved.diffId };
    }
    return { status: 'ok', resolved };
  }

  private entries(resolved: ResolvedDiff): Promise<NameStatusEntry[]> {
    return resolved.to === null
      ? resolved.git.workingTree(resolved.dir, resolved.baseSha)
      : resolved.git.nameStatus(resolved.dir, resolved.baseSha, resolved.to);
  }

  private async entryFor(resolved: ResolvedDiff, path: string): Promise<NameStatusEntry> {
    const entry = (await this.entries(resolved)).find((e) => e.path === path);
    if (!entry) throw new Error(`${path} is not part of this card's changes.`);
    return entry;
  }

  /** Each file's size on the side that exists — the new side, or the old one for a deletion. */
  private async sizesOf(
    resolved: ResolvedDiff,
    entries: NameStatusEntry[],
  ): Promise<Map<string, number>> {
    const deleted = entries.filter((e) => e.status === 'deleted').map((e) => e.path);
    const present = entries.filter((e) => e.status !== 'deleted').map((e) => e.path);
    const [newSizes, oldSizes] = await Promise.all([
      present.length ? resolved.git.fileSizes(resolved.dir, resolved.to, present) : new Map(),
      deleted.length ? resolved.git.fileSizes(resolved.dir, resolved.baseSha, deleted) : new Map(),
    ]);
    return new Map([...oldSizes, ...newSizes]);
  }

  /** task → project → worktree or branch → base → revision. */
  private async resolveTask(taskId: string): Promise<Resolved> {
    const task = this.deps.getTask(taskId);
    if (!task) throw new Error('That card is no longer in the app.');
    // Steps of a plan run in their parent's worktree on the parent's branch.
    const owner = (task.parentTaskId && this.deps.getTask(task.parentTaskId)) || task;
    const project = this.runProjectFor(owner);
    if (!project?.path || !hasRepo(project)) return { status: 'no-branch' };
    const g = this.deps.gitFor(project);

    const live = await this.deps.inspect(project, owner.id, owner.agentBranch ?? undefined);
    if (live) {
      const conflicted = await g.conflictedFiles(live.cwd);
      if (conflicted.length > 0 || (await g.rebaseInProgress(live.cwd))) {
        return { status: 'conflicted', files: conflicted };
      }
      const headSha = await g.revParse(live.cwd, 'HEAD');
      const baseSha = headSha ? await g.mergeBase(live.cwd, live.base, headSha) : '';
      if (!headSha || !baseSha) return { status: 'no-branch' };
      const fingerprint = await g.workingTreeFingerprint(live.cwd);
      return {
        status: 'ok',
        git: g,
        dir: live.cwd,
        baseRef: live.base,
        baseSha,
        headSha,
        to: null,
        includesWorkingTree: true,
        diffId: computeDiffId(baseSha, headSha, fingerprint),
        source: 'worktree',
        subjectId: taskSubjectId(taskId),
        capabilities: WORKTREE_CAPABILITIES,
      };
    }

    // No worktree. Landed work wins over a branch someone left behind: what the human wants
    // to hear about a merged card is that it merged, not a diff that is now empty.
    if (owner.landedAt != null) {
      return { status: 'landed', forgeUrl: this.forgeUrlFor(owner.id) };
    }
    const branch = owner.agentBranch?.trim() || taskBranch(owner.id);
    if (!(await g.branchExists(project.path, branch))) return { status: 'no-branch' };
    const baseRef = project.baseBranch?.trim() || (await g.currentBranch(project.path));
    if (!baseRef) return { status: 'no-branch' };
    const headSha = await g.revParse(project.path, branch);
    const baseSha = headSha ? await g.mergeBase(project.path, baseRef, headSha) : '';
    if (!headSha || !baseSha) return { status: 'no-branch' };
    return {
      status: 'ok',
      git: g,
      dir: project.path,
      baseRef,
      baseSha,
      headSha,
      to: headSha,
      includesWorkingTree: false,
      diffId: computeDiffId(baseSha, headSha, ''),
      source: 'worktree',
      subjectId: taskSubjectId(taskId),
      capabilities: WORKTREE_CAPABILITIES,
    };
  }

  /** The same resolution as `Scheduler.runProjectFor`: the agent project, else the card's own. */
  private runProjectFor(task: Task): Project | undefined {
    if (task.agentProjectId) {
      const agentProject = this.deps.getProject(task.agentProjectId);
      if (agentProject && hasRepo(agentProject)) return agentProject;
    }
    return this.deps.getProject(task.projectId);
  }

  private forgeUrlFor(taskId: string): string | null {
    const mrs = this.deps.listMergeRequests().filter((mr) => mr.taskId === taskId);
    return (mrs.find((mr) => mr.state === 'merged') ?? mrs[0])?.webUrl ?? null;
  }

  /**
   * Resolve a pull request's diff against a project already cloned on this machine — a
   * fetched ref rather than the forge's own API, so it is subject to no rate limit and
   * reads the exact bytes the forge has, not a synthesized patch.
   *
   * The ONE `fetchRefspecs` call below fetches both the PR's head and its target branch's
   * current tip into scratch refs under `REVIEW_REF_PREFIX`; a verify step re-fetches once
   * more if the head moved between the forge telling us its SHA and this fetch landing, and
   * gives up with `stale` if it still doesn't match.
   */
  async resolvePrLocal(req: PrLocalRequest): Promise<PrLocalResult> {
    const id = subjectId(req.subject);
    const match = await this.matchPrProject(req);
    if (!match) return { status: 'no-project' };
    const { project, remote, parsedRemote, refGit } = match;
    const g = this.deps.gitFor(project);

    const headRef = reviewRef(id, 'head');
    const baseRef = reviewRef(id, 'base');
    const headSpec =
      req.subject.provider === 'github'
        ? `+refs/pull/${req.subject.number}/head:${headRef}`
        : `+refs/merge-requests/${req.subject.number}/head:${headRef}`;
    const baseSpec = `+refs/heads/${req.baseBranch}:${baseRef}`;

    const auth =
      this.deps.fetchAuthFor?.(req.subject.provider, parsedRemote, remote.fetchUrl) ?? null;
    const fetchOpts = { url: auth?.url, secrets: auth?.secrets };

    const fetchOnce = async (): Promise<PrLocalResult | null> => {
      const res = await refGit.fetchRefspecs(
        project.path,
        remote.name,
        [headSpec, baseSpec],
        fetchOpts,
      );
      if (res.code === 0) return null;
      const reason = firstNonEmptyLine(res.stderr) || 'git fetch failed';
      this.fetchFailures.set(id, reason);
      return { status: 'fetch-failed', reason };
    };

    const firstFailure = await fetchOnce();
    if (firstFailure) return firstFailure;

    let headRefSha = await g.revParse(project.path, headRef);
    if (headRefSha !== req.headSha) {
      const secondFailure = await fetchOnce();
      if (secondFailure) return secondFailure;
      headRefSha = await g.revParse(project.path, headRef);
      if (headRefSha !== req.headSha) {
        return { status: 'stale', headSha: headRefSha, forgeHeadSha: req.headSha };
      }
    }

    const baseSha = await g.mergeBase(project.path, baseRef, headRef);
    if (!baseSha) {
      const reason = 'no common history with base';
      this.fetchFailures.set(id, reason);
      return { status: 'fetch-failed', reason };
    }

    this.fetchFailures.delete(id);
    return {
      status: 'ok',
      resolved: {
        git: g,
        dir: project.path,
        baseRef: req.baseBranch,
        baseSha,
        headSha: req.headSha,
        to: req.headSha,
        includesWorkingTree: false,
        diffId: computeDiffId(baseSha, req.headSha, 'local-ref'),
        source: 'local-ref',
        subjectId: id,
        capabilities: LOCAL_REF_CAPABILITIES,
      },
    };
  }

  /**
   * The project (and the remote on it) whose `origin`/`upstream`/… points at `host`/
   * `repoPath` — every remote of every repo-backed project counts, so a fork checkout
   * matches through `upstream` even when its `origin` is the user's own fork. `null` when
   * nothing matches, or when the deps this needs (`listProjects`, `refGitFor`) are absent.
   *
   * Public because F15.9's queue service calls this directly to fill `ReviewQueueItem.
   * projectId` for every row of a refresh, without needing `matchPrProject`'s own addition
   * on top (the `refGit`, which only resolving a diff needs in order to fetch).
   */
  async matchProject(
    host: string,
    repoPath: string,
  ): Promise<{
    project: Project;
    remote: { name: string; fetchUrl: string; pushUrl: string };
    parsedRemote: RemoteRef;
  } | null> {
    const refGitFor = this.deps.refGitFor;
    if (!refGitFor) return null;
    const projects = this.deps.listProjects?.() ?? [];
    for (const project of projects) {
      if (!project.path || !hasRepo(project)) continue;
      const refGit = refGitFor(project);
      const remotes = await refGit.listRemotes(project.path);
      for (const remote of remotes) {
        const parsed = parseRemoteUrl(remote.fetchUrl);
        if (!parsed) continue;
        if (
          parsed.host.toLowerCase() === host.toLowerCase() &&
          parsed.path.toLowerCase() === repoPath.toLowerCase()
        ) {
          return { project, remote, parsedRemote: parsed };
        }
      }
    }
    return null;
  }

  /**
   * {@link matchProject}, plus the `refGit` only resolving a diff needs (to fetch the PR's
   * refs) — the extra `matchProject` itself does not return, since the queue service's own
   * call has nothing to fetch.
   */
  private async matchPrProject(req: PrLocalRequest): Promise<{
    project: Project;
    remote: { name: string; fetchUrl: string; pushUrl: string };
    parsedRemote: RemoteRef;
    refGit: ReviewRefGit;
  } | null> {
    const refGitFor = this.deps.refGitFor;
    if (!refGitFor) return null;
    const match = await this.matchProject(req.host, req.subject.repoPath);
    return match ? { ...match, refGit: refGitFor(match.project) } : null;
  }

  /**
   * Drop every review ref whose subject id is not in `keep` — F15.9's queue service calls
   * this with the union of every queue's subject ids once it has loaded them. Failures are
   * swallowed per project, so one bad repo cannot stop the rest from being pruned.
   */
  async pruneReviewRefs(keep: ReadonlySet<string>): Promise<void> {
    const refGitFor = this.deps.refGitFor;
    if (!refGitFor) return;
    const projects = this.deps.listProjects?.() ?? [];
    for (const project of projects) {
      if (!project.path || !hasRepo(project)) continue;
      try {
        const refGit = refGitFor(project);
        const refs = await refGit.listRefs(project.path, REVIEW_REF_PREFIX);
        const ids = new Set<string>();
        for (const ref of refs) {
          const rest = ref.slice(REVIEW_REF_PREFIX.length);
          const slash = rest.lastIndexOf('/');
          if (slash === -1) continue;
          ids.add(rest.slice(0, slash));
        }
        for (const id of ids) {
          if (keep.has(id)) continue;
          await refGit.deleteRefs(project.path, `${REVIEW_REF_PREFIX}${id}`);
          this.fetchFailures.delete(id);
        }
      } catch {
        // One bad repo must not stop the rest from being pruned.
      }
    }
  }
}

/** The first non-empty, trimmed line of `text` — what a redacted git error is reported by. */
function firstNonEmptyLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  );
}

/** `ls-tree -r -l -z` records: `<mode> <type> <sha> <size>\t<path>`. */
function parseLsTreeSizes(stdout: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const record of stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const size = Number(record.slice(0, tab).trim().split(/\s+/)[3]);
    if (Number.isFinite(size)) sizes.set(record.slice(tab + 1), size);
  }
  return sizes;
}

/** The real {@link DiffGit}: `git.ts`, bound to one project's host. */
export function createDiffGit(host: ExecHost): DiffGit {
  const workSize = (dir: string, path: string): number => {
    try {
      return statSync(join(host.toApp(dir), path)).size;
    } catch {
      return -1;
    }
  };
  return {
    async revParse(dir, ref) {
      const res = await git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], host);
      return res.code === 0 ? res.stdout.trim() : '';
    },
    branchExists: (dir, branch) => branchExists(dir, branch, host),
    currentBranch: (dir) => currentBranch(dir, host),
    mergeBase: (dir, a, b) => mergeBase(dir, a, b, host),
    rebaseInProgress: (dir) => rebaseInProgress(dir, host),
    conflictedFiles: (dir) => conflictedFiles(dir, host),
    async workingTreeFingerprint(dir) {
      // Tracked changes by their exact content, untracked files by their blob hashes: two
      // calls whatever the size of the tree, and any edit the agent makes moves one of them.
      const [tracked, untracked] = await Promise.all([
        git(dir, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--binary'], host),
        listUntracked(dir, host),
      ]);
      const hashed = untracked.length
        ? await git(dir, ['hash-object', '--', ...untracked], host)
        : { code: 0, stdout: '' };
      if (tracked.code !== 0) {
        // Too big for the buffer: fall back to the status listing, which still moves when a
        // file starts or stops being changed.
        const status = await git(dir, ['status', '--porcelain=v2', '-z'], host);
        return `status:${status.stdout}\0${untracked.join('\0')}\0${hashed.stdout}`;
      }
      if (!tracked.stdout && !untracked.length) return '';
      return createHash('sha256')
        .update(tracked.stdout)
        .update('\0')
        .update(untracked.join('\0'))
        .update('\0')
        .update(hashed.stdout)
        .digest('hex');
    },
    nameStatus: (dir, from, to) => diffNameStatus(dir, from, to, host),
    workingTree: (dir, from) => diffWorkingTree(dir, from, host),
    filePatch: (dir, req) => diffFilePatch(dir, req, host),
    async fileSizes(dir, ref, paths) {
      if (ref === null) {
        return new Map(
          paths.map((p) => [p, workSize(dir, p)] as const).filter(([, size]) => size >= 0),
        );
      }
      const res = await git(dir, ['ls-tree', '-r', '-l', '-z', ref], host);
      if (res.code !== 0) return new Map();
      const all = parseLsTreeSizes(res.stdout);
      const wanted = new Set(paths);
      return new Map([...all].filter(([p]) => wanted.has(p)));
    },
    async fileSize(dir, ref, path) {
      return ref === null ? workSize(dir, path) : blobSize(dir, ref, path, host);
    },
    async readFile(dir, ref, path) {
      return ref === null ? readWorkingFile(dir, path, host) : showBlob(dir, ref, path, host);
    },
  };
}

/** The real {@link ReviewRefGit}: `git.ts`, bound to one project's host. */
export function createReviewRefGit(host: ExecHost): ReviewRefGit {
  return {
    listRemotes: (dir) => listRemotes(dir, host),
    fetchRefspecs: (dir, remoteOrUrl, specs, opts) =>
      fetchRefspecs(dir, remoteOrUrl, specs, { ...opts, host }),
    async listRefs(dir, prefix) {
      const res = await git(dir, ['for-each-ref', '--format=%(refname)', prefix], host);
      if (res.code !== 0) return [];
      return res.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    },
    deleteRefs: (dir, prefix) => deleteRefs(dir, prefix, host),
  };
}
