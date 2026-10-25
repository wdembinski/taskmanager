/**
 * What an AI review (F16.8) reviews: a `subjectId` resolved ONCE, at start, into a pinned
 * {@link ReviewTarget} — the project to run in, the diff summary, every file's hunks, and
 * the prompt context.
 *
 * Pinning is the point. A card's worktree keeps moving while its agent works, and a PR can
 * be pushed to mid-review. The reviewer was shown one diff, so its findings are validated
 * against — and stamped with the `diffId` of — that diff, not whatever the subject reads as
 * when the reply lands. A draft made on an older diff is then flagged `outdated` by
 * `markOutdated` exactly like a human's (spec item 10).
 *
 * Reads go through the same services the workspace reads through: `DiffService` for a card,
 * `ReviewSubjectService` for a PR. A PR is reviewable only when that service resolved it to a
 * `local-ref` clone — a `forge-api` subject has no clone to check a worktree out of.
 *
 * Never throws: anything that cannot be resolved is a refusal, as data.
 */
import { AI_REVIEW_MAX_CHANGED_LINES, AI_REVIEW_MAX_FILES } from '@shared/aiReview';
import { hasRepo, type Project, type Task } from '@shared/model';
import {
  parseSubjectId,
  type DiffFile,
  type DiffSummary,
  type DiffSummaryResult,
} from '@shared/review';
import type { ExecHost } from '../exec';
import type { Store } from '../store';
import type { DiffService } from './diffService';
import { reviewDocShowArgs, type ReviewPromptContext } from './reviewPrompt';
import type { ReviewSubjectService } from './subjectService';

/** Why an AI review was refused before anything was spent. Checked in this order. */
export type AiReviewRefusalCode =
  | 'shutting-down'
  | 'unknown-subject'
  | 'no-capability'
  | 'too-large'
  | 'duplicate'
  | 'already-reviewed'
  | 'card-running'
  | 'sandbox-unsupported';

/** A refused start: no review row is created. `reason` is shown as the button's tooltip. */
export interface AiReviewRefusal {
  refused: AiReviewRefusalCode;
  reason: string;
}

/** A subject resolved and pinned at the moment its review started. */
export interface ReviewTarget {
  /** The clone the review's worktree is checked out of — a card's run project, a PR's match. */
  project: Project;
  /** The card behind the subject, when there is one — usage is attributed to it. */
  taskId: string | null;
  summary: DiffSummary;
  /** Every non-binary file's hunks, read at start — what findings validate against. */
  files: Map<string, DiffFile>;
  prompt: ReviewPromptContext;
}

export interface AiReviewSubjectSource {
  resolve(subjectId: string): Promise<ReviewTarget | AiReviewRefusal>;
}

export interface AiReviewSubjectDeps {
  store: Pick<Store, 'getTask' | 'getProject' | 'listReviewQueue' | 'listMergeRequests'>;
  diffs: Pick<DiffService, 'summary' | 'filesFor'>;
  subjects: Pick<ReviewSubjectService, 'summary' | 'file' | 'localProject'>;
  hostFor(project: Project): ExecHost;
  /** The card's live worktree directory (`WorktreeManager.inspect`), or null when it has none. */
  cardWorktree(project: Project, ownerTaskId: string, branch?: string): Promise<string | null>;
}

/** How often a subject whose diff moves between the summary and the file reads is re-read. */
const RESOLVE_ATTEMPTS = 2;

const refuse = (refused: AiReviewRefusalCode, reason: string): AiReviewRefusal => ({
  refused,
  reason,
});

export function isRefusal<T extends object>(value: T | AiReviewRefusal): value is AiReviewRefusal {
  return 'refused' in value;
}

/** The size refusal, or null when the subject is within the caps. */
export function tooLargeReason(summary: DiffSummary): string | null {
  const changed = summary.files.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (changed > AI_REVIEW_MAX_CHANGED_LINES) {
    return `too large to review — ${changed.toLocaleString('en-US')} changed lines, cap ${AI_REVIEW_MAX_CHANGED_LINES.toLocaleString('en-US')}`;
  }
  if (summary.truncated || summary.files.length > AI_REVIEW_MAX_FILES) {
    return `too large to review — more than ${AI_REVIEW_MAX_FILES} files changed`;
  }
  return null;
}

/** `git status --porcelain` → the paths it names (a rename's new path), unquoted. */
export function parsePorcelainPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split('\n')) {
    const entry = line.replace(/\r$/, '');
    if (entry.length < 4) continue;
    let path = entry.slice(3);
    const arrow = path.indexOf(' -> ');
    if (arrow !== -1) path = path.slice(arrow + 4);
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    paths.push(path);
  }
  return paths;
}

const SUMMARY_FAILURES: Record<Exclude<DiffSummaryResult['status'], 'ok'>, string> = {
  'no-branch': 'this card has no branch to review',
  landed: 'this card has already landed — there is nothing left to review',
  conflicted: 'this card is mid-conflict — resolve it before asking for a review',
};

export class AiReviewSubjects implements AiReviewSubjectSource {
  constructor(private readonly deps: AiReviewSubjectDeps) {}

  async resolve(subjectId: string): Promise<ReviewTarget | AiReviewRefusal> {
    const key = parseSubjectId(subjectId);
    if (!key) return refuse('unknown-subject', `${subjectId} is not a review subject`);
    try {
      return key.kind === 'task'
        ? await this.resolveTask(key.taskId)
        : await this.resolvePr(subjectId);
    } catch (err) {
      return refuse('unknown-subject', err instanceof Error ? err.message : String(err));
    }
  }

  private async resolveTask(taskId: string): Promise<ReviewTarget | AiReviewRefusal> {
    const { store } = this.deps;
    const task = store.getTask(taskId);
    if (!task) return refuse('unknown-subject', 'that card is no longer in the app');
    // Steps of a plan run in their parent's worktree, on the parent's branch.
    const owner = (task.parentTaskId && store.getTask(task.parentTaskId)) || task;
    const project = this.runProjectFor(owner);
    if (!project?.path || !hasRepo(project)) {
      return refuse('no-capability', "this card's project has no repository to review in");
    }

    for (let attempt = 0; attempt < RESOLVE_ATTEMPTS; attempt++) {
      const result = await this.deps.diffs.summary(taskId);
      if (result.status !== 'ok') return refuse('unknown-subject', SUMMARY_FAILURES[result.status]);
      const { summary } = result;
      const gated = this.gate(summary);
      if (gated) return gated;

      const paths = summary.files.filter((f) => !f.binary).map((f) => f.path);
      const read = await this.deps.diffs.filesFor(taskId, paths);
      if (!read) return refuse('unknown-subject', 'this card has no diff to review');
      if (read.diffId !== summary.diffId) continue; // moved between the two reads: again
      const files = new Map<string, DiffFile>();
      for (const [path, entry] of read.files) if (entry) files.set(path, entry.file);

      const uncommittedFiles = summary.includesWorkingTree
        ? await this.uncommittedFiles(project, owner.id, owner.agentBranch ?? undefined)
        : [];
      const ticket =
        task.externalKey && task.externalDescription
          ? { key: task.externalKey, body: task.externalDescription }
          : undefined;
      return {
        project,
        taskId,
        summary,
        files,
        prompt: {
          subject: {
            kind: 'task',
            title: task.title,
            ...(task.description ? { description: task.description } : {}),
          },
          ...(ticket ? { ticket } : {}),
          ...this.revision(summary),
          ...(uncommittedFiles.length > 0 ? { uncommittedFiles } : {}),
          reviewDoc: await this.reviewDoc(project, summary.baseSha),
          ...(project.instructions ? { instructions: project.instructions } : {}),
        },
      };
    }
    return refuse('unknown-subject', "this card's changes kept moving while they were read");
  }

  private async resolvePr(subjectId: string): Promise<ReviewTarget | AiReviewRefusal> {
    for (let attempt = 0; attempt < RESOLVE_ATTEMPTS; attempt++) {
      const result = await this.deps.subjects.summary(subjectId);
      if (result.status !== 'ok') return refuse('unknown-subject', SUMMARY_FAILURES[result.status]);
      const { summary } = result;
      const project = this.deps.subjects.localProject(subjectId);
      if (summary.source !== 'local-ref' || !project) {
        return refuse('no-capability', 'add the repo as a project to let the AI review it');
      }
      const gated = this.gate(summary);
      if (gated) return gated;

      const files = new Map<string, DiffFile>();
      let moved = false;
      for (const entry of summary.files) {
        if (entry.binary) continue;
        const read = await this.deps.subjects.file(subjectId, summary.diffId, entry.path);
        if (read.status !== 'ok') {
          moved = true;
          break;
        }
        files.set(entry.path, read.file);
      }
      if (moved) continue;

      const { title, ref, taskId } = this.prFacts(subjectId);
      return {
        project,
        taskId,
        summary,
        files,
        prompt: {
          subject: { kind: 'pr', title, ...(ref ? { ref } : {}) },
          ...this.revision(summary),
          reviewDoc: await this.reviewDoc(project, summary.baseSha),
          ...(project.instructions ? { instructions: project.instructions } : {}),
        },
      };
    }
    return refuse('unknown-subject', 'the pull request moved while its changes were read');
  }

  /** The capability and the caps — refused before a single file is read. */
  private gate(summary: DiffSummary): AiReviewRefusal | null {
    if (!summary.capabilities?.aiReview) {
      return refuse('no-capability', 'add the repo as a project to let the AI review it');
    }
    const large = tooLargeReason(summary);
    return large ? refuse('too-large', large) : null;
  }

  private revision(
    summary: DiffSummary,
  ): Pick<ReviewPromptContext, 'baseRef' | 'baseSha' | 'headSha' | 'files'> {
    return {
      baseRef: summary.baseRef,
      baseSha: summary.baseSha,
      headSha: summary.headSha,
      files: summary.files.map((f) => ({
        path: f.path,
        ...(f.oldPath ? { oldPath: f.oldPath } : {}),
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        binary: f.binary,
      })),
    };
  }

  /** A PR's title, its forge handle and its card, from the queue cache or `merge_requests`. */
  private prFacts(subjectId: string): { title: string; ref?: string; taskId: string | null } {
    const { store } = this.deps;
    const queued = store.listReviewQueue().find((row) => row.item.subjectId === subjectId)?.item;
    const mr = store.listMergeRequests().find((m) => m.id === subjectId);
    return {
      title: queued?.title ?? mr?.title ?? subjectId,
      ref: queued?.ref ?? (mr ? `${mr.provider === 'github' ? '#' : '!'}${mr.number}` : undefined),
      taskId: queued?.taskId ?? mr?.taskId ?? null,
    };
  }

  /** `REVIEW.md` from the BASE commit, or null (the default checklist) when git says no. */
  private async reviewDoc(project: Project, baseSha: string): Promise<string | null> {
    try {
      const res = await this.deps
        .hostFor(project)
        .exec(project.path, 'git', reviewDocShowArgs(baseSha));
      return res.code === 0 ? res.stdout : null;
    } catch {
      return null;
    }
  }

  /** The card worktree's dirty files — named in the prompt as NOT reviewed. */
  private async uncommittedFiles(
    project: Project,
    ownerTaskId: string,
    branch?: string,
  ): Promise<string[]> {
    try {
      const cwd = await this.deps.cardWorktree(project, ownerTaskId, branch);
      if (!cwd) return [];
      const res = await this.deps.hostFor(project).exec(cwd, 'git', ['status', '--porcelain']);
      return res.code === 0 ? parsePorcelainPaths(res.stdout) : [];
    } catch {
      return [];
    }
  }

  /** `Scheduler.runProjectFor`'s rule: the agent project when it has a repo, else the card's. */
  private runProjectFor(task: Task): Project | undefined {
    if (task.agentProjectId) {
      const agentProject = this.deps.store.getProject(task.agentProjectId);
      if (agentProject && hasRepo(agentProject)) return agentProject;
    }
    return this.deps.store.getProject(task.projectId);
  }
}
