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
 * opted into an agent resolving their merge conflicts, or a forge rebasing their branch,
 * without asking first.
 */
import type { ForgeProvider, MergeRequest, PrWatchAction } from '@shared/mergeRequest';
import { forgeName, mrRef, prWatchAction } from '@shared/mergeRequest';
import type { ChatRefusal, ChatSendResult, Task } from '@shared/model';
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
  /** Hand a problem to the card's agent — `Scheduler.chatWithAgent`. */
  chatWithAgent(taskId: string, message: string): ChatSendResult;
  /** File a note on the card's timeline. */
  note(projectId: string, taskId: string, body: string): void;
  /** Remember that this MR's head commit has already been acted on. */
  markActed(mrId: string, headSha: string): void;
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
  if (!task) return; // the card is gone — nothing to note, nobody to chat with

  const action = prWatchAction(mr, { lastActedSha: mr.lastActedSha });
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
  if (mr.headSha) deps.markActed(mr.id, mr.headSha);
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
    case 'resolve-conflicts': {
      const result = deps.chatWithAgent(
        task.id,
        `${mrRef(mr)} (${mr.webUrl}) has a merge conflict against "${mr.targetBranch}". Please ` +
          `fetch the latest "${mr.targetBranch}", rebase "${mr.sourceBranch}" onto it, resolve ` +
          `the conflicts, and push.`,
      );
      deps.note(task.projectId, task.id, conflictNote(mr, result));
      return;
    }
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

/** What to write on the card's timeline once the agent has (or hasn't) been asked. */
function conflictNote(mr: MergeRequest, result: ChatSendResult): string {
  if (result.status !== 'refused') {
    return `${mrRef(mr)} has a merge conflict — asked the agent to resolve it.`;
  }
  return (
    `${mrRef(mr)} has a merge conflict, but it could not be handed to the agent ` +
    `(${explainRefusal(result.reason)}). Resolve it by hand, or ask again from the card.`
  );
}

function explainRefusal(reason: ChatRefusal): string {
  switch (reason) {
    case 'never-ran':
      return 'this card has never run, so there is no conversation to continue';
    case 'limit':
      return 'a usage limit is holding all work right now';
    case 'signed-out':
      return 'claude is signed out';
    case 'awaiting-decision':
      return 'the card is already waiting on a decision';
    case 'chain-busy':
      return 'the card is mid-chain';
    case 'not-running':
      return 'the app is shutting down';
    default:
      return reason;
  }
}
