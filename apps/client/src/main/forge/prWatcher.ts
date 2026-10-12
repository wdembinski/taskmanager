/**
 * Acting on {@link prWatchAction}'s decisions for the merge requests this app opened or
 * matched to a card (Phase: observe PR/MR state and resolve conflicts).
 *
 * Runs after every GitLab/GitHub sync, over the rows that sync just wrote. `prWatchAction`
 * is itself the guard against doing anything twice for the same commit — keyed on
 * `MergeRequest.lastActedSha` — so this file only has to decide HOW to carry out whichever
 * action it returned, never whether to.
 *
 * Gated entirely on `features.prAutoResolve` (default OFF, see its own doc): nobody is
 * opted into the app force-pushing their branches, or a forge rebasing their branch,
 * without asking first.
 */
import type { ForgeProvider, MergeRequest, PrWatchAction } from '@shared/mergeRequest';
import { forgeName, mrRef, prWatchAction } from '@shared/mergeRequest';
import type { Task } from '@shared/model';
import type { AppSettings } from '@shared/settings';
import { GitHubClient } from '../github/githubClient';
import { GitLabClient } from '../gitlab/gitlabClient';
import { forgeBaseUrl } from './baseUrl';

/** What {@link watchMergeRequests} needs from the world around it. */
export interface PrWatcherDeps {
  getSettings(): AppSettings;
  getTask(taskId: string): Task | undefined;
  /**
   * The decrypted personal access token for a forge, or null when none is saved. Same
   * contract as `CreatePrDeps.tokenFor` — read at the moment it is spent, never held.
   */
  tokenFor(provider: ForgeProvider): string | null;
  /**
   * Queue the conflict ladder for this MR — `Scheduler.resolveForgeConflict`. Fire-and-forget,
   * same as this call always was: it fetches, rebases and force-with-lease pushes in the
   * background and notes the card itself as it goes, so there is nothing here to await or to
   * note on its behalf.
   */
  resolveForgeConflict(taskId: string, mr: MergeRequest): void;
  /** File a note on the card's timeline. */
  note(projectId: string, taskId: string, body: string): void;
  /** Remember that this MR's head commit has already been acted on, and which action it was. */
  markActed(mrId: string, headSha: string, action: PrWatchAction): void;
}

/**
 * Run the watcher over every merge request a sync just wrote.
 *
 * Each row is independent: an error acting on one (a revoked token, an unreachable forge)
 * is noted on that row's own card and never stops the rest from being looked at.
 */
export async function watchMergeRequests(
  mrs: readonly MergeRequest[],
  deps: PrWatcherDeps,
): Promise<void> {
  if (!deps.getSettings().features.prAutoResolve) return;
  for (const mr of mrs) await watchOne(mr, deps);
}

async function watchOne(mr: MergeRequest, deps: PrWatcherDeps): Promise<void> {
  // `openedForTaskId` is authoritative when set — see its own doc on `MergeRequest`. A sync
  // can only ever GUESS `taskId` from the MR's own text, and a guess that misses leaves
  // nobody here to act on behalf of.
  const taskId = mr.openedForTaskId ?? mr.taskId;
  if (!taskId) return;
  const task = deps.getTask(taskId);
  if (!task) return; // the card is gone — nothing to note, no worktree to rebase

  const action = prWatchAction(mr, {
    lastActedSha: mr.lastActedSha,
    lastActedAction: mr.lastActedAction,
  });
  if (action === 'none') return;

  try {
    await act(action, mr, task, deps);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    deps.note(task.projectId, task.id, `Could not act on ${mrRef(mr)}: ${message}`);
    // A genuine failure to even ATTEMPT the action (no token saved, the forge unreachable)
    // is worth retrying on the next sync — unlike an attempt that went through but has not
    // fixed anything yet, which `prWatchAction` already knows to leave alone until the next
    // push gives it a new commit to key on.
    return;
  }
  // `resolve-conflicts` is fire-and-forget (see `act`'s own case below): the ladder it queues
  // is still running when this call returns, so nothing about the episode is true to stamp
  // yet. `Scheduler.driveForgeConflict`/`pushForgeRebase`/`raiseMergeConflict` stamp it
  // themselves once the ladder actually reaches one of its own ends.
  if (mr.headSha && action !== 'resolve-conflicts') deps.markActed(mr.id, mr.headSha, action);
}

async function act(
  action: PrWatchAction,
  mr: MergeRequest,
  task: Task,
  deps: PrWatcherDeps,
): Promise<void> {
  switch (action) {
    case 'none':
      return;
    case 'forge-rebase':
      await forgeRebase(mr, deps);
      deps.note(
        task.projectId,
        task.id,
        `${mrRef(mr)} had fallen behind "${mr.targetBranch}" — asked ${forgeName(mr.provider)} to rebase it.`,
      );
      return;
    case 'resolve-conflicts':
      // Fire-and-forget: the ladder fetches, rebases and force-with-lease pushes in the
      // background, notes the card itself as it goes, and stamps `markActed` itself once it
      // settles (see `Scheduler.resolveForgeConflict`), so there is nothing further to await,
      // to note, or to stamp here.
      deps.resolveForgeConflict(task.id, mr);
      return;
    case 'note-pipeline-failed':
      deps.note(
        task.projectId,
        task.id,
        `${mrRef(mr)}'s pipeline failed: ${mr.pipelineUrl ?? mr.webUrl}`,
      );
      return;
    case 'note-pipeline-passed':
      deps.note(task.projectId, task.id, `${mrRef(mr)}'s pipeline passed.`);
      return;
  }
}

/** Ask the forge to rebase this MR's branch — the same call the manual `mr:rebase` button makes. */
async function forgeRebase(mr: MergeRequest, deps: PrWatcherDeps): Promise<void> {
  const settings = deps.getSettings();
  const token = deps.tokenFor(mr.provider);
  if (!token) throw new Error(`No ${forgeName(mr.provider)} token is saved — add one in Settings.`);

  if (mr.provider === 'gitlab') {
    const client = new GitLabClient({ baseUrl: forgeBaseUrl('gitlab', settings), token });
    await client.rebaseMergeRequest(mr.repoId, mr.number);
    return;
  }
  const [owner, repo] = mr.projectPath.split('/');
  if (!owner || !repo) throw new Error(`Malformed GitHub repository path: ${mr.projectPath}`);
  const client = new GitHubClient({ baseUrl: forgeBaseUrl('github', settings), token });
  await client.updateBranch(owner, repo, mr.number);
}
