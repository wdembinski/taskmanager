/**
 * Acting on {@link prWatchAction}'s decisions for the merge requests this app opened or
 * matched to a card (Phase: observe PR/MR state and resolve conflicts).
 *
 * Runs after every GitLab/GitHub sync, over the rows that sync just wrote. `prWatchAction`
 * is itself the guard against doing anything twice for the same commit — keyed on
 * `MergeRequest.lastActedSha` — so this file only has to decide HOW to carry out whichever
 * action it returned, never whether to.
 *
 * Its own actions are gated entirely on `features.prAutoResolve` (default OFF, see its own
 * doc): nobody is opted into the app force-pushing their branches, or a forge rebasing their
 * branch, without asking first. The app-merge pass that runs before them is NOT — its opt-in
 * is the project's own "Merge on green" (see {@link appMergePass}).
 */
import type { TaskAttachment } from '@shared/attachments';
import { effectiveAutoMergeBy } from '@shared/appMerge';
import type { ForgeProvider, MergeRequest, PrWatchAction } from '@shared/mergeRequest';
import { forgeName, mrRef, prWatchAction } from '@shared/mergeRequest';
import type { ChatRefusal, ChatSendResult, Project, Task, TaskActivityEntry } from '@shared/model';
import type { RunPurpose } from '@shared/scheduler';
import type { AppSettings } from '@shared/settings';
import { GitHubClient } from '../github/githubClient';
import { GitLabClient } from '../gitlab/gitlabClient';
import { attemptAppMerge } from './appMerge';
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
  /**
   * Hand a failing pipeline to the card's agent — `Scheduler.chatWithAgent`, tagged
   * `fix-pipeline` so the card says why its agent is working again.
   */
  chatWithAgent(taskId: string, message: string, opts: { purpose: RunPurpose }): ChatSendResult;
  /** File a note on the card's timeline. */
  note(projectId: string, taskId: string, body: string): void;
  /** Remember that this MR's head commit has already been acted on, and which action it was. */
  markActed(mrId: string, headSha: string, action: PrWatchAction): void;
  /** The card's agent project — whose "Merge on green" settings the app-merge pass reads. */
  getProject(projectId: string): Project | undefined;
  listAttachments(taskId: string): TaskAttachment[];
  listActivity(taskId: string): TaskActivityEntry[];
  /**
   * `mrId → headSha` the app already merged or was refused on this session — one map, held
   * in `ipc.ts`'s closure, shared with the Approve handler. See `forge/appMerge.ts`.
   */
  appMergeAttempts: Map<string, string>;
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
  // Rows the app-merge pass already dealt with — merged, or handed to the conflict ladder /
  // forge rebase — are left out of the loop below, so one sync never acts on one row twice.
  const handled = new Set<string>();
  for (const mr of mrs) {
    if (await appMergePass(mr, deps)) handled.add(mr.id);
  }
  if (!deps.getSettings().features.prAutoResolve) return;
  for (const mr of mrs) {
    if (!handled.has(mr.id)) await watchOne(mr, deps);
  }
}

/** The card a row acts on behalf of — `openedForTaskId` when set (see its own doc on
 *  `MergeRequest`), else the sync's guess. */
function taskFor(mr: MergeRequest, deps: PrWatcherDeps): Task | undefined {
  const taskId = mr.openedForTaskId ?? mr.taskId;
  return taskId ? deps.getTask(taskId) : undefined;
}

/**
 * Merge `mr` from the app when it is a candidate: open, not a draft, its pipeline passed on a
 * known head, its card's project has "Merge on green" on with the app as the merger (the
 * setting, or the fallback note on the card's timeline), and this session has not already
 * merged or been refused on that head. Returns whether the row was dealt with — merged, or
 * handed to the conflict ladder / a forge rebase. A failure to even ask reads as not dealt
 * with, so the gated loop still looks at the row.
 *
 * Not gated on `features.prAutoResolve`: that flag is about the app rewriting branches, and
 * this pass never does unless it is on — a `conflict`/`behind` refusal is only handed to the
 * existing hand-offs then. Errors are noted on the card, like {@link watchOne}'s, and the head
 * is not remembered, so the next sync tries again.
 */
async function appMergePass(mr: MergeRequest, deps: PrWatcherDeps): Promise<boolean> {
  if (mr.state !== 'opened' || mr.draft || mr.pipelineStatus !== 'success' || !mr.headSha) {
    return false;
  }
  if (deps.appMergeAttempts.get(mr.id) === mr.headSha) return false;
  const task = taskFor(mr, deps);
  if (!task) return false;
  const project = deps.getProject(task.agentProjectId ?? '');
  if (!project?.autoMergeOnGreen) return false;
  if (effectiveAutoMergeBy(project.autoMergeBy, deps.listActivity(task.id)) !== 'app') {
    return false;
  }

  try {
    const token = deps.tokenFor(mr.provider);
    if (!token)
      throw new Error(`No ${forgeName(mr.provider)} token is saved — add one in Settings.`);
    const outcome = await attemptAppMerge(deps, {
      project,
      task,
      mr,
      token,
      settings: deps.getSettings(),
    });
    if (outcome.kind === 'merged') return true;
    if (outcome.kind !== 'refused' || !deps.getSettings().features.prAutoResolve) return false;
    if (outcome.reason === 'conflict') {
      deps.resolveForgeConflict(task.id, mr);
      return true;
    }
    if (outcome.reason === 'behind') {
      await forgeRebase(mr, deps);
      deps.note(task.projectId, task.id, forgeRebaseNote(mr));
      return true;
    }
    return false;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    deps.note(task.projectId, task.id, `Could not merge ${mrRef(mr)}: ${message}`);
    return false;
  }
}

async function watchOne(mr: MergeRequest, deps: PrWatcherDeps): Promise<void> {
  // `openedForTaskId` is authoritative when set — see its own doc on `MergeRequest`. A sync
  // can only ever GUESS `taskId` from the MR's own text, and a guess that misses leaves
  // nobody here to act on behalf of.
  const task = taskFor(mr, deps);
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
      deps.note(task.projectId, task.id, forgeRebaseNote(mr));
      return;
    case 'resolve-conflicts':
      // Fire-and-forget: the ladder fetches, rebases and force-with-lease pushes in the
      // background, notes the card itself as it goes, and stamps `markActed` itself once it
      // settles (see `Scheduler.resolveForgeConflict`), so there is nothing further to await,
      // to note, or to stamp here.
      deps.resolveForgeConflict(task.id, mr);
      return;
    case 'fix-pipeline': {
      const result = deps.chatWithAgent(
        task.id,
        `${mrRef(mr)}'s pipeline failed: ${mr.pipelineUrl ?? mr.webUrl}. Please look at what ` +
          `broke, fix it, and push.`,
        { purpose: 'fix-pipeline' },
      );
      deps.note(task.projectId, task.id, pipelineFixNote(mr, result));
      return;
    }
    case 'note-pipeline-passed':
      deps.note(task.projectId, task.id, `${mrRef(mr)}'s pipeline passed.`);
      return;
  }
}

function forgeRebaseNote(mr: MergeRequest): string {
  return `${mrRef(mr)} had fallen behind "${mr.targetBranch}" — asked ${forgeName(mr.provider)} to rebase it.`;
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

/** What to write on the card's timeline once the agent has (or hasn't) been asked to fix a
 * failing pipeline. */
function pipelineFixNote(mr: MergeRequest, result: ChatSendResult): string {
  if (result.status !== 'refused') {
    return `${mrRef(mr)}'s pipeline failed — asked the agent to fix it.`;
  }
  return (
    `${mrRef(mr)}'s pipeline failed, but it could not be handed to the agent ` +
    `(${explainRefusal(result.reason)}). Fix it by hand, or ask again from the card.`
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
