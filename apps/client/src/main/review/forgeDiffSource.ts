/**
 * The `forge-api` {@link ReviewSource}: a pull request's diff read straight from GitHub's or
 * GitLab's own REST API, for a PR with no local clone to fetch from
 * (`DiffService.resolvePrLocal` is `local-ref`'s equivalent, `apps/client/src/main/review/diffService.ts`).
 * F15.9's queue service and F15.10's IPC channels are the callers; this module knows nothing
 * about either.
 *
 * States answered on purpose, the same way `diffService.ts`'s own are:
 *
 *  - `stale` — the PR's head moved since `diffId` was handed out. Answered against the latest
 *    revision this instance has seen for the subject, never re-asked on every call; see below.
 *  - a `tooLarge` file — the forge omitted the patch (GitHub: binary/oversized, no `patch`
 *    field at all; GitLab: `too_large: true`) or the patch itself exceeds `DIFF_FILE_MAX_BYTES`.
 *  - an unknown path — thrown, the same way `DiffService.entryFor` throws for a card.
 *
 * **The LRU and the staleness rule.** `summary()` is this module's only way to learn the
 * current revision: it always re-reads the PR's detail and file list and computes a fresh
 * `diffId`. A small `subjectState` map remembers the latest known `(diffId, baseSha, headSha,
 * baseRef)` per subject, so `file`/`image`/`context` can answer `stale` for an old `diffId`
 * WITHOUT a network call — they only re-ask the forge's detail endpoint when the subject has
 * never been summarized by this instance (a fresh source handed an id out of nowhere). A
 * second map, the LRU proper, is keyed by `diffId` and capped at
 * {@link ForgeDiffSource.MAX_CACHE_ENTRIES} entries; it holds the parsed file rows for a
 * revision. A hit answers with no network call at all. A miss for a `diffId` that `subjectState`
 * still calls current — evicted, not stale — re-fetches only the file list, never the detail.
 *
 * **The GitHub base-tip approximation.** GitLab's `diff_refs.base_sha` is the true merge base
 * the forge itself computed for this merge request. GitHub's pull-request detail carries no
 * such field — `base.sha` is the base BRANCH's current tip, which drifts every time something
 * else lands on it. Using it as `baseSha` is an approximation `local-ref`'s own `mergeBase()`
 * call does not need to make; it is kept anyway because the alternative is cloning the
 * repository, which is exactly what `forge-api` exists to avoid.
 */
import { createHash } from 'node:crypto';
import { forgeName, type ForgeProvider } from '@shared/mergeRequest';
import {
  DIFF_FILE_MAX_BYTES,
  DIFF_IMAGE_MAX_BYTES,
  DIFF_SUMMARY_MAX_FILES,
  FORGE_API_CAPABILITIES,
  parseHunks,
  sliceContext,
  subjectId,
  type DiffContextResult,
  type DiffFileEntry,
  type DiffFileResult,
  type DiffFileStatus,
  type DiffImageResult,
  type DiffImageSide,
  type DiffSide,
  type DiffStale,
  type DiffSummary,
  type ReviewSubject,
} from '@shared/review';
import { GitHubError, type GitHubClient, type GitHubPullRequestFile } from '../github/githubClient';
import {
  GitLabError,
  type GitLabClient,
  type GitLabMergeRequestDiff,
} from '../gitlab/gitlabClient';
import { base64Length, computeDiffId, imageMimeOf } from './diffService';

export type PrSubject = Extract<ReviewSubject, { kind: 'pr' }>;

/** The forge clients this source reads from — one per provider, resolved lazily. */
export interface ForgeDiffSourceDeps {
  githubClient(): GitHubClient | null;
  gitlabClient(): GitLabClient | null;
}

/** One file's cached row — enough to answer `file`/`image`/`context` with no further listing. */
interface ForgeFileRow {
  oldPath?: string;
  status: DiffFileStatus;
  /** Raw patch/diff text, or `null` when the forge gave none — the `tooLarge` sentinel. */
  patch: string | null;
  newBlobSha?: string;
}

/** One file row as read off the forge, before it is split into a summary entry and a cache row. */
interface ForgeFileRowRaw extends ForgeFileRow {
  path: string;
  additions: number;
  deletions: number;
}

/** The parsed revision a `diffId` resolves to — the LRU's own value type. */
interface ForgeDiffCacheEntry {
  subjectId: string;
  baseSha: string;
  headSha: string;
  baseRef: string;
  rows: Map<string, ForgeFileRow>;
}

/** What `subjectState` remembers between calls — the live revision, without its file rows. */
interface SubjectRevision {
  diffId: string;
  baseSha: string;
  headSha: string;
  baseRef: string;
}

/** GitHub's file-status vocabulary, narrowed to ours. Anything unrecognised reads as `modified`. */
function mapGitHubStatus(status: string): DiffFileStatus {
  switch (status) {
    case 'added':
      return 'added';
    case 'removed':
      return 'deleted';
    case 'renamed':
      return 'renamed';
    case 'copied':
      return 'copied';
    default:
      return 'modified'; // 'modified', 'changed', 'unchanged', or anything GitHub adds later
  }
}

function toGitHubRow(f: GitHubPullRequestFile): ForgeFileRowRaw {
  const status = mapGitHubStatus(f.status);
  return {
    path: f.filename,
    oldPath: status === 'renamed' || status === 'copied' ? f.previous_filename : undefined,
    status,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    // Missing for binary and oversized files alike — GitHub gives no way to tell them apart,
    // so both read as `tooLarge` with an unknown byte count.
    patch: f.patch ?? null,
    newBlobSha: f.sha,
  };
}

function mapGitLabStatus(d: GitLabMergeRequestDiff): DiffFileStatus {
  if (d.renamed_file) return 'renamed';
  if (d.new_file) return 'added';
  if (d.deleted_file) return 'deleted';
  return 'modified';
}

/** Lines added/removed in a header-less diff body, by counting `parseHunks`' own line kinds. */
function countChanges(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of parseHunks(patch)) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') additions += 1;
      else if (line.kind === 'del') deletions += 1;
    }
  }
  return { additions, deletions };
}

/** A stand-in blob sha for GitLab, which carries none on its diff rows: a hash of the diff text. */
function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function toGitLabRow(d: GitLabMergeRequestDiff): ForgeFileRowRaw {
  const status = mapGitLabStatus(d);
  const path = status === 'deleted' ? d.old_path : d.new_path;
  const oldPath = status === 'renamed' ? d.old_path : undefined;
  // `too_large` is the one GitLab signal for "no diff to show" — an ordinary empty diff (a
  // pure rename with no content change) is a real, parseable `tooLarge: false` answer.
  const patch = d.too_large ? null : d.diff;
  const { additions, deletions } = patch ? countChanges(patch) : { additions: 0, deletions: 0 };
  return {
    path,
    oldPath,
    status,
    additions,
    deletions,
    patch,
    newBlobSha: patch !== null ? hashText(patch) : undefined,
  };
}

/** `owner/repo` split for the GitHub client's calls; GitLab's take the whole path as one id. */
function splitOwnerRepo(repoPath: string): { owner: string; repo: string } {
  const slash = repoPath.indexOf('/');
  return slash === -1
    ? { owner: repoPath, repo: '' }
    : { owner: repoPath.slice(0, slash), repo: repoPath.slice(slash + 1) };
}

/** `owner/repo#12` / `group/repo!12` — the ref a thrown error names the subject by. */
function forgeRef(subject: PrSubject): string {
  return `${subject.repoPath}${subject.provider === 'github' ? '#' : '!'}${subject.number}`;
}

/** A 404 from either forge, turned into a message naming the subject rather than a raw status. */
function readableForgeError(err: unknown, subject: PrSubject): Error {
  if (err instanceof GitHubError && err.status === 404) {
    return new Error(`${forgeRef(subject)} could not be found on GitHub.`);
  }
  if (err instanceof GitLabError && err.status === 404) {
    return new Error(`${forgeRef(subject)} could not be found on GitLab.`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

function buildRows(rawRows: readonly ForgeFileRowRaw[]): Map<string, ForgeFileRow> {
  return new Map(
    rawRows.map((r) => [
      r.path,
      { oldPath: r.oldPath, status: r.status, patch: r.patch, newBlobSha: r.newBlobSha },
    ]),
  );
}

export class ForgeDiffSource {
  private static readonly MAX_CACHE_ENTRIES = 8;

  constructor(private readonly deps: ForgeDiffSourceDeps) {}

  /** `diffId` → that revision's parsed file rows, in recency order (oldest first). */
  private readonly cache = new Map<string, ForgeDiffCacheEntry>();
  /** `subjectId` → the latest revision this instance has resolved for it. */
  private readonly subjectState = new Map<string, SubjectRevision>();

  private clientFor(provider: ForgeProvider): GitHubClient | GitLabClient {
    const client = provider === 'github' ? this.deps.githubClient() : this.deps.gitlabClient();
    if (!client) throw new Error(`No ${forgeName(provider)} client is configured for this host.`);
    return client;
  }

  /** The PR/MR detail read: head/base SHAs and the base branch's name. */
  async detail(subject: PrSubject): Promise<SubjectRevision> {
    try {
      if (subject.provider === 'github') {
        const client = this.clientFor('github') as GitHubClient;
        const { owner, repo } = splitOwnerRepo(subject.repoPath);
        const pr = await client.getPullRequest(owner, repo, subject.number);
        const baseSha = pr.base?.sha ?? '';
        const headSha = pr.head?.sha ?? '';
        return {
          diffId: computeDiffId(baseSha, headSha, 'forge'),
          baseSha,
          headSha,
          baseRef: pr.base?.ref ?? '',
        };
      }
      const client = this.clientFor('gitlab') as GitLabClient;
      const mr = await client.getMergeRequestByPath(subject.repoPath, subject.number);
      const baseSha = mr.diff_refs?.base_sha ?? '';
      const headSha = mr.sha ?? mr.diff_refs?.head_sha ?? '';
      return {
        diffId: computeDiffId(baseSha, headSha, 'forge'),
        baseSha,
        headSha,
        baseRef: mr.target_branch,
      };
    } catch (err) {
      throw readableForgeError(err, subject);
    }
  }

  /** The PR/MR's changed files, forge-shaped rows mapped to ours. */
  private async fetchFiles(
    subject: PrSubject,
  ): Promise<{ rows: ForgeFileRowRaw[]; truncated: boolean }> {
    if (subject.provider === 'github') {
      const client = this.clientFor('github') as GitHubClient;
      const { owner, repo } = splitOwnerRepo(subject.repoPath);
      try {
        const { files, truncated } = await client.listPullRequestFiles(owner, repo, subject.number);
        return { rows: files.map(toGitHubRow), truncated };
      } catch (err) {
        throw readableForgeError(err, subject);
      }
    }
    const client = this.clientFor('gitlab') as GitLabClient;
    try {
      const { diffs, truncated } = await client.listMergeRequestDiffs(
        subject.repoPath,
        subject.number,
      );
      return { rows: diffs.map(toGitLabRow), truncated };
    } catch (err) {
      if (err instanceof GitLabError && err.status === 404) {
        throw new Error(
          `${forgeRef(subject)}: this GitLab instance exposes no merge request diff endpoint.`,
        );
      }
      throw readableForgeError(err, subject);
    }
  }

  /**
   * The summary for this subject, right now: always re-reads the PR/MR detail and its file
   * list — this is the only operation that discovers a new `diffId` — then caches the result
   * under it and remembers it as the subject's latest known revision.
   */
  async summary(subject: PrSubject): Promise<DiffSummary> {
    const sid = subjectId(subject);
    const revision = await this.detail(subject);
    const { rows: rawRows, truncated: clientTruncated } = await this.fetchFiles(subject);

    const cappedByCount = rawRows.length > DIFF_SUMMARY_MAX_FILES;
    const listed = rawRows.slice(0, DIFF_SUMMARY_MAX_FILES);
    const files: DiffFileEntry[] = listed.map((r) => ({
      path: r.path,
      ...(r.oldPath ? { oldPath: r.oldPath } : {}),
      status: r.status,
      additions: r.additions,
      deletions: r.deletions,
      binary: false,
      image: imageMimeOf(r.path) !== null,
      bytes: 0,
      ...(r.newBlobSha ? { newBlobSha: r.newBlobSha } : {}),
    }));

    const summary: DiffSummary = {
      diffId: revision.diffId,
      baseRef: revision.baseRef,
      baseSha: revision.baseSha,
      headSha: revision.headSha,
      includesWorkingTree: false,
      files,
      truncated: clientTruncated || cappedByCount,
      subjectId: sid,
      source: 'forge-api',
      capabilities: FORGE_API_CAPABILITIES,
    };

    this.cachePut(revision.diffId, {
      subjectId: sid,
      baseSha: revision.baseSha,
      headSha: revision.headSha,
      baseRef: revision.baseRef,
      rows: buildRows(rawRows),
    });
    this.subjectState.set(sid, revision);
    return summary;
  }

  async file(subject: PrSubject, diffId: string, path: string): Promise<DiffFileResult> {
    const resolved = await this.ensureCurrent(subject, diffId);
    if (resolved.status === 'stale') return resolved;
    const row = resolved.entry.rows.get(path);
    if (!row) throw new Error(`${path} is not part of this pull request's changes.`);
    if (row.patch === null) {
      return { status: 'ok', file: { diffId, path, hunks: [], tooLarge: { bytes: 0 } } };
    }
    const bytes = Buffer.byteLength(row.patch, 'utf8');
    if (bytes > DIFF_FILE_MAX_BYTES) {
      return { status: 'ok', file: { diffId, path, hunks: [], tooLarge: { bytes } } };
    }
    return { status: 'ok', file: { diffId, path, hunks: parseHunks(row.patch) } };
  }

  async image(subject: PrSubject, diffId: string, path: string): Promise<DiffImageResult> {
    const resolved = await this.ensureCurrent(subject, diffId);
    if (resolved.status === 'stale') return resolved;
    const row = resolved.entry.rows.get(path);
    if (!row) throw new Error(`${path} is not part of this pull request's changes.`);
    const mime = imageMimeOf(path);
    if (!mime) throw new Error(`${path} is not an image this pane can preview.`);
    const { baseSha, headSha } = resolved.entry;
    const oldSide =
      row.status === 'added'
        ? null
        : await this.imageSide(subject, baseSha, row.oldPath ?? path, mime);
    const newSide =
      row.status === 'deleted' ? null : await this.imageSide(subject, headSha, path, mime);
    return { status: 'ok', image: { diffId, path, old: oldSide, new: newSide } };
  }

  private async imageSide(
    subject: PrSubject,
    ref: string,
    path: string,
    mime: string,
  ): Promise<DiffImageSide | null> {
    const bytes = await this.readRawBytes(subject, ref, path);
    if (base64Length(bytes.length) > DIFF_IMAGE_MAX_BYTES)
      return { bytes: bytes.length, tooLarge: true };
    return { bytes: bytes.length, mime, base64: bytes.toString('base64') };
  }

  async context(
    subject: PrSubject,
    diffId: string,
    path: string,
    side: DiffSide,
    from: number,
    to: number,
  ): Promise<DiffContextResult> {
    const resolved = await this.ensureCurrent(subject, diffId);
    if (resolved.status === 'stale') return resolved;
    const row = resolved.entry.rows.get(path);
    if (!row) throw new Error(`${path} is not part of this pull request's changes.`);
    const { baseSha, headSha } = resolved.entry;
    const ref = side === 'old' ? baseSha : headSha;
    const readPath = side === 'old' ? (row.oldPath ?? path) : path;
    const bytes = await this.readRawBytes(subject, ref, readPath);
    if (bytes.length > DIFF_FILE_MAX_BYTES) {
      return {
        status: 'ok',
        context: {
          diffId,
          path,
          side,
          start: 0,
          text: [],
          truncated: false,
          tooLarge: { bytes: bytes.length },
        },
      };
    }
    return {
      status: 'ok',
      context: sliceContext(bytes.toString('utf8'), { diffId, path, side, from, to }),
    };
  }

  private async readRawBytes(subject: PrSubject, ref: string, path: string): Promise<Buffer> {
    if (subject.provider === 'github') {
      const client = this.clientFor('github') as GitHubClient;
      const { owner, repo } = splitOwnerRepo(subject.repoPath);
      return client.getRawFileBytes(owner, repo, path, ref);
    }
    const client = this.clientFor('gitlab') as GitLabClient;
    return client.getRawFileBytes(subject.repoPath, path, ref);
  }

  /**
   * The revision `diffId` names, or `stale` when it is not this subject's current one.
   *
   * `subjectState` is checked FIRST, and it is a plain map lookup — no network call — so
   * this costs nothing even on a hit. It must come before the LRU: a `diffId` that is still
   * sitting in the cache from before the head moved is exactly the case that must answer
   * `stale`, and trusting a cache hit on its own would serve that old revision's data back as
   * if it were current. Only once `subjectState` agrees `diffId` IS the current one does a
   * cache hit short-circuit the rest — the common case, and the one with no network call at
   * all. If `subjectState` has never heard of this subject (a fresh source, handed an id out
   * of nowhere), the detail is read live to find out. Either way, a `diffId` that turns out to
   * still be current but fell out of the LRU gets only its file list re-read, never its detail.
   */
  private async ensureCurrent(
    subject: PrSubject,
    diffId: string,
  ): Promise<{ status: 'ok'; entry: ForgeDiffCacheEntry } | DiffStale> {
    const sid = subjectId(subject);
    const known = this.subjectState.get(sid);
    if (known) {
      if (known.diffId !== diffId) return { status: 'stale', diffId, currentDiffId: known.diffId };
      const hit = this.cacheTouch(diffId);
      return hit
        ? { status: 'ok', entry: hit }
        : { status: 'ok', entry: await this.refetchRows(subject, known) };
    }

    const revision = await this.detail(subject);
    this.subjectState.set(sid, revision);
    if (revision.diffId !== diffId) {
      return { status: 'stale', diffId, currentDiffId: revision.diffId };
    }
    const hit = this.cacheTouch(diffId);
    return hit
      ? { status: 'ok', entry: hit }
      : { status: 'ok', entry: await this.refetchRows(subject, revision) };
  }

  private async refetchRows(
    subject: PrSubject,
    revision: SubjectRevision,
  ): Promise<ForgeDiffCacheEntry> {
    const { rows: rawRows } = await this.fetchFiles(subject);
    const entry: ForgeDiffCacheEntry = {
      subjectId: subjectId(subject),
      baseSha: revision.baseSha,
      headSha: revision.headSha,
      baseRef: revision.baseRef,
      rows: buildRows(rawRows),
    };
    this.cachePut(revision.diffId, entry);
    return entry;
  }

  private cachePut(diffId: string, entry: ForgeDiffCacheEntry): void {
    this.cache.delete(diffId);
    this.cache.set(diffId, entry);
    if (this.cache.size > ForgeDiffSource.MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  /** A cache read that also refreshes recency, so eviction drops the least recently used. */
  private cacheTouch(diffId: string): ForgeDiffCacheEntry | undefined {
    const entry = this.cache.get(diffId);
    if (!entry) return undefined;
    this.cache.delete(diffId);
    this.cache.set(diffId, entry);
    return entry;
  }
}
