/**
 * The side-effecting half of "merge on green" — ask the forge to arm or withdraw auto-merge
 * on a card's pull/merge request. `@shared/autoMerge`'s `autoMergeDecision` owns every GATE
 * (whether this should run at all); this file only ever carries out whichever branch that
 * function already picked.
 *
 * **Non-fatal, like `refreshDescription`.** The pull/merge request is already open, which is
 * the part of the job that matters. A forge refusal — insufficient permissions, a revoked
 * token, an instance too old to know the field — becomes a timeline note, never a throw.
 */
import type { TaskAttachment } from '@shared/attachments';
import {
  autoMergeAwaitSignOffNote,
  autoMergeDecision,
  autoMergeDisableFailedNote,
  autoMergeEnabledNote,
  autoMergeFailedNote,
  autoMergeNeedsChangesNote,
} from '@shared/autoMerge';
import { mrRef, type ForgeProvider, type MergeRequest } from '@shared/mergeRequest';
import type { Project, Task, TaskActivityEntry } from '@shared/model';
import type { AppSettings } from '@shared/settings';
import type { SignOffStatus } from '@shared/visualSignOff';
import { latestVisualState, shotPairs } from '@shared/visualSignOff';
import { hostFor } from '../exec';
import { GitHubClient } from '../github/githubClient';
import { GitLabClient } from '../gitlab/gitlabClient';
import { forgeBaseUrl } from './baseUrl';
import { openMergeRequestFor, resolveForgeGitTarget } from './createPr';

/** What {@link requestAutoMerge} and {@link disableAutoMerge} need from the world around
 *  them — a strict subset of `CreatePrDeps`, so `openPullRequest` can hand its own deps
 *  straight through. */
export interface AutoMergeDeps {
  listAttachments(taskId: string): TaskAttachment[];
  listActivity(taskId: string): TaskActivityEntry[];
  note(projectId: string, taskId: string, body: string): void;
}

/** The pull/merge request {@link requestAutoMerge}/{@link disableAutoMerge} act on — just
 *  enough to build a forge client and name it on the timeline. */
export interface AutoMergeTarget {
  provider: ForgeProvider;
  projectPath: string;
  number: number;
}

/**
 * Ask the forge to arm or withdraw auto-merge on `mr`, following whatever
 * {@link autoMergeDecision} says the card's current state calls for.
 *
 * Called from both PR-open exits of `openPullRequest` — on every push, not just the first,
 * because a UI card's sign-off (or a human's needs-changes flag) can change between pushes
 * and this is the one place that re-reads it.
 */
export async function requestAutoMerge(
  deps: AutoMergeDeps,
  opts: {
    project: Pick<Project, 'id' | 'autoMergeOnGreen' | 'autoMergeMethod'>;
    owner: Pick<Task, 'id'>;
    mr: AutoMergeTarget;
    token: string;
    settings: AppSettings;
  },
): Promise<void> {
  if (!opts.project.autoMergeOnGreen) return;

  const { pairs } = shotPairs(deps.listAttachments(opts.owner.id));
  const isUiCard = pairs.length > 0;
  const human = latestVisualState(
    deps.listActivity(opts.owner.id),
    pairs.map((p) => p.name),
  ).human;

  const decision = autoMergeDecision({ enabled: opts.project.autoMergeOnGreen, isUiCard, human });
  const ref = mrRef(opts.mr);

  if (decision === 'off') return;

  if (decision === 'await-sign-off') {
    deps.note(opts.project.id, opts.owner.id, autoMergeAwaitSignOffNote(ref));
    return;
  }

  if (decision === 'needs-changes') {
    await disableAutoMerge(deps, opts);
    deps.note(opts.project.id, opts.owner.id, autoMergeNeedsChangesNote(ref));
    return;
  }

  try {
    let immediate = false;
    let outcome: 'already' | 'enabled';
    if (opts.mr.provider === 'github') {
      const [ownerName, repoName] = opts.mr.projectPath.split('/');
      const client = new GitHubClient({
        baseUrl: forgeBaseUrl('github', opts.settings),
        token: opts.token,
      });
      const result = await client.enableAutoMerge(
        ownerName,
        repoName,
        opts.mr.number,
        opts.project.autoMergeMethod,
      );
      immediate = result === 'merged';
      outcome = result === 'already' ? 'already' : 'enabled';
    } else {
      const client = new GitLabClient({
        baseUrl: forgeBaseUrl('gitlab', opts.settings),
        token: opts.token,
      });
      outcome = await client.enableAutoMerge(opts.mr.projectPath, opts.mr.number, {
        squash: opts.project.autoMergeMethod === 'squash',
      });
    }
    if (outcome === 'already') return;
    deps.note(opts.project.id, opts.owner.id, autoMergeEnabledNote(ref, immediate));
  } catch (err) {
    deps.note(
      opts.project.id,
      opts.owner.id,
      autoMergeFailedNote(ref, err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * Withdraw auto-merge on `mr`, if it was armed — GitHub's `disablePullRequestAutoMerge`,
 * GitLab's `cancel_merge_when_pipeline_succeeds`. Called from {@link requestAutoMerge}'s own
 * `needs-changes` branch, and directly from the Approve/Needs-changes handler (a later step
 * of this ticket), so a human flagging needs-changes withdraws the hold immediately rather
 * than waiting for the next push.
 *
 * Non-fatal, the same rule as {@link requestAutoMerge}'s own forge call.
 */
export async function disableAutoMerge(
  deps: AutoMergeDeps,
  opts: {
    project: Pick<Project, 'id'>;
    owner: Pick<Task, 'id'>;
    mr: AutoMergeTarget;
    token: string;
    settings: AppSettings;
  },
): Promise<void> {
  const ref = mrRef(opts.mr);
  try {
    if (opts.mr.provider === 'github') {
      const [ownerName, repoName] = opts.mr.projectPath.split('/');
      const client = new GitHubClient({
        baseUrl: forgeBaseUrl('github', opts.settings),
        token: opts.token,
      });
      await client.disableAutoMerge(ownerName, repoName, opts.mr.number);
    } else {
      const client = new GitLabClient({
        baseUrl: forgeBaseUrl('gitlab', opts.settings),
        token: opts.token,
      });
      await client.cancelAutoMerge(opts.mr.projectPath, opts.mr.number);
    }
  } catch (err) {
    deps.note(
      opts.project.id,
      opts.owner.id,
      autoMergeDisableFailedNote(ref, err instanceof Error ? err.message : String(err)),
    );
  }
}

/** What {@link applyVisualSignOff} needs from the world around it — built from the same
 *  pieces as `createPrDeps()` (`ipc.ts`), since it resolves a card's forge target the exact
 *  same way `openPullRequest` does. */
export interface VisualSignOffDeps extends AutoMergeDeps {
  getTask(taskId: string): Task | undefined;
  getProject(projectId: string): Project | undefined;
  getSettings(): AppSettings;
  listMergeRequests(): MergeRequest[];
  /** What the card's worktree IS on disk right now, or null — `WorktreeManager.inspect`. */
  inspect(
    project: Project,
    ownerTaskId: string,
    branchName?: string,
  ): Promise<{ cwd: string; branch: string; base: string } | null>;
  tokenFor(provider: ForgeProvider): string | null;
}

/**
 * The forge-side half of a human's Approve/Needs-changes press on the card panel's own
 * Visual sign-off section (`packages/ui/src/VisualSignOff.tsx`'s `submitVisualSignOff`,
 * via `ipc.ts`'s `task:visualSignOff`).
 *
 * `approved` calls {@link requestAutoMerge} — called AFTER the sign-off comment has already
 * landed on the card's timeline, so the decision it reads off `latestVisualState` is this
 * verdict, and a UI card's own gate now answers `'enable'`. `needs-changes` calls
 * {@link disableAutoMerge} directly, withdrawing any hold immediately rather than waiting for
 * the next push to notice.
 *
 * Does nothing when the project's own "merge on green" is off, or when the card has no open
 * pull/merge request — there is nothing to arm or withdraw either way. Non-fatal, the same
 * rule as {@link requestAutoMerge}'s own forge call: a refusal (no token, no origin remote,
 * the forge itself refusing) becomes a timeline note, never a throw back to the button.
 */
export async function applyVisualSignOff(
  deps: VisualSignOffDeps,
  taskId: string,
  status: SignOffStatus,
): Promise<void> {
  const task = deps.getTask(taskId);
  if (!task) return;
  const project = deps.getProject(task.agentProjectId ?? '');
  if (!project || !project.autoMergeOnGreen) return;

  const mr = openMergeRequestFor(deps.listMergeRequests(), taskId);
  if (!mr) return;

  try {
    const settings = deps.getSettings();
    const live = await deps.inspect(project, taskId, task.agentBranch ?? undefined);
    if (!live) return;
    const host = hostFor(project.target);
    const target = await resolveForgeGitTarget(project, live.cwd, host, settings, deps.tokenFor);
    const mrTarget: AutoMergeTarget = {
      provider: mr.provider,
      projectPath: target.path,
      number: mr.number,
    };

    if (status === 'approved') {
      await requestAutoMerge(deps, {
        project,
        owner: task,
        mr: mrTarget,
        token: target.token,
        settings,
      });
    } else {
      await disableAutoMerge(deps, {
        project,
        owner: task,
        mr: mrTarget,
        token: target.token,
        settings,
      });
    }
  } catch (err) {
    deps.note(
      project.id,
      taskId,
      `Could not ${status === 'approved' ? 'enable' : 'disable'} auto-merge: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
