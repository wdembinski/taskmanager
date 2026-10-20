/**
 * The side-effecting half of "Task Manager merges it itself" — the fallback for a forge that
 * cannot auto-merge. `@shared/appMerge`'s `appMergeDecision` owns every gate; this file only
 * re-reads the facts it needs from the forge, hands them over, and carries out a `merge`.
 *
 * **One PUT per head, never a guess.** Every fact the decision reads is fetched again right
 * here, immediately before the merge, and the PUT carries the sha whose checks were read — so
 * a push that lands between the read and the merge makes the forge refuse rather than merge a
 * commit nobody checked. The sha is then remembered in `appMergeAttempts` (merged or refused,
 * never while merely waiting), so the next sync over the same head makes no forge call at all.
 */
import {
  appMergeDecision,
  appMergedNote,
  appMergeRefusedNote,
  type AppMergeCheck,
  type AppMergeInput,
  type AppMergeRefusal,
} from '@shared/appMerge';
import type { TaskAttachment } from '@shared/attachments';
import { mrRef, type MergeRequest } from '@shared/mergeRequest';
import type { Project, Task, TaskActivityEntry } from '@shared/model';
import type { AppSettings } from '@shared/settings';
import { latestVisualState, shotPairs } from '@shared/visualSignOff';
import { GitHubClient, GitHubError } from '../github/githubClient';
import { GitLabClient, GitLabError } from '../gitlab/gitlabClient';
import { checksFromGitHub, checksFromGitLab } from './appMergeChecks';
import { forgeBaseUrl } from './baseUrl';

/** What {@link attemptAppMerge} needs from the world around it. */
export interface AppMergeDeps {
  listAttachments(taskId: string): TaskAttachment[];
  listActivity(taskId: string): TaskActivityEntry[];
  note(projectId: string, taskId: string, body: string): void;
  /**
   * `mrId → headSha` for every head this session already merged or was refused on — held in
   * `ipc.ts`'s closure. In memory on purpose: a restart re-checks every green PR once, which
   * is how a PR that went green while the app was closed still merges.
   */
  appMergeAttempts: Map<string, string>;
}

/** The merge request {@link attemptAppMerge} acts on — the synced row, whose `headSha` is the
 *  commit the sync saw pass. */
export type AppMergeTarget = Pick<
  MergeRequest,
  'id' | 'provider' | 'projectPath' | 'repoId' | 'number' | 'headSha' | 'targetBranch'
>;

export type AppMergeOutcome =
  { kind: 'merged' } | { kind: 'refused'; reason: AppMergeRefusal } | { kind: 'waiting' };

/** HTTP statuses a merge PUT answers with when the forge refuses THIS merge (not a
 *  credential or transport failure) — GitHub 405/409/422, GitLab 405/406/409/422. */
const MERGE_REFUSAL_STATUSES: ReadonlySet<number> = new Set([405, 406, 409, 422]);

/**
 * Merge `mr` from the app if — and only if — {@link appMergeDecision} says so on facts read
 * from the forge just now. A `refuse` (decided here, or the forge refusing the PUT) leaves an
 * `appMergeRefusedNote`; a `merge` leaves `appMergedNote`; a `wait` leaves nothing and is not
 * remembered, so the next sync looks again.
 *
 * Throws on a failure to even ask (an unreadable PR, a 401, the forge unreachable) — the
 * caller notes it and, since nothing was remembered, tries again on the next sync.
 */
export async function attemptAppMerge(
  deps: AppMergeDeps,
  opts: {
    project: Pick<Project, 'autoMergeMethod' | 'autoMergeRequiredChecks'>;
    task: Pick<Task, 'id' | 'projectId'>;
    mr: AppMergeTarget;
    token: string;
    settings: AppSettings;
  },
): Promise<AppMergeOutcome> {
  const { mr, task } = opts;
  const ref = mrRef(mr);
  const expectedSha = mr.headSha;
  if (!expectedSha) return { kind: 'waiting' };

  const { pairs } = shotPairs(deps.listAttachments(task.id));
  const isUiCard = pairs.length > 0;
  const human = latestVisualState(
    deps.listActivity(task.id),
    pairs.map((p) => p.name),
  ).human;
  const requiredChecks = opts.project.autoMergeRequiredChecks ?? [];

  const remember = () => deps.appMergeAttempts.set(mr.id, expectedSha);
  const refused = (reason: AppMergeRefusal, detail: string): AppMergeOutcome => {
    remember();
    deps.note(task.projectId, task.id, appMergeRefusedNote(ref, reason, detail));
    return { kind: 'refused', reason };
  };

  const forge =
    mr.provider === 'github'
      ? await readGitHub(opts.token, opts.settings, mr)
      : await readGitLab(opts.token, opts.settings, mr);

  const decision = appMergeDecision({
    ...forge.facts,
    expectedSha,
    requiredChecks,
    isUiCard,
    human,
  });
  if (decision.kind === 'wait') return { kind: 'waiting' };
  if (decision.kind === 'refuse') return refused(decision.reason, decision.detail);

  try {
    await forge.merge(decision.sha, opts.project.autoMergeMethod);
  } catch (err) {
    const status =
      err instanceof GitHubError || err instanceof GitLabError ? err.status : undefined;
    if (status === undefined || !MERGE_REFUSAL_STATUSES.has(status)) throw err;
    const message = forgeMessage(err as Error);
    return refused(classifyRefusal(message), `${forgeLabel(mr)} refused the merge — ${message}`);
  }
  remember();
  deps.note(task.projectId, task.id, appMergedNote(ref, forge.base || mr.targetBranch));
  return { kind: 'merged' };
}

/** The facts a forge contributes to {@link AppMergeInput}, and the one write it may then do. */
interface ForgeRead {
  facts: Omit<AppMergeInput, 'expectedSha' | 'requiredChecks' | 'isUiCard' | 'human'>;
  base: string;
  merge(sha: string, method: Project['autoMergeMethod']): Promise<void>;
}

async function readGitHub(
  token: string,
  settings: AppSettings,
  mr: AppMergeTarget,
): Promise<ForgeRead> {
  const [owner, repo] = mr.projectPath.split('/');
  if (!owner || !repo) throw new Error(`Malformed GitHub repository path: ${mr.projectPath}`);
  const client = new GitHubClient({ baseUrl: forgeBaseUrl('github', settings), token });
  const pr = await client.getPullRequest(owner, repo, mr.number);
  const liveHeadSha = pr.head?.sha ?? null;

  // Checks are only worth reading for the head we set out to merge; a moved head is refused
  // on that fact alone, and reading the new head's checks would only spend calls.
  let checks: AppMergeCheck[] = [];
  if (liveHeadSha && liveHeadSha === mr.headSha) {
    const [runs, combined] = await Promise.all([
      client.listCheckRuns(owner, repo, liveHeadSha),
      client.getCombinedStatus(owner, repo, liveHeadSha),
    ]);
    checks = checksFromGitHub(runs, combined);
  }

  return {
    facts: {
      state: pr.merged || pr.merged_at ? 'merged' : pr.state === 'open' ? 'open' : 'closed',
      draft: pr.draft ?? false,
      mergeable: pr.mergeable ?? null,
      behind: pr.mergeable_state === 'behind',
      conflicted: pr.mergeable_state === 'dirty',
      liveHeadSha,
      checksSha: liveHeadSha ?? '',
      checks,
    },
    base: pr.base?.ref ?? mr.targetBranch,
    merge: async (sha, method) => {
      await client.mergePullRequest(owner, repo, mr.number, sha, undefined, method);
      // GitHub deletes the head branch itself when the repository says so; otherwise it is
      // ours to clean up. Never a fork's branch — that repository is not ours to write to.
      const headRef = pr.head?.ref;
      const sameRepo =
        pr.head?.repo?.full_name !== undefined &&
        pr.head?.repo?.full_name === pr.base?.repo?.full_name;
      if (!headRef || !sameRepo) return;
      const repository = await client.getRepository(owner, repo);
      if (repository.delete_branch_on_merge) return;
      await client.deleteBranch(owner, repo, headRef);
    },
  };
}

/** GitLab `detailed_merge_status` values that mean "not worked out yet" — a wait. */
const GITLAB_COMPUTING: ReadonlySet<string> = new Set([
  'checking',
  'unchecked',
  'preparing',
  'approvals_syncing',
  'ci_still_running',
  'ci_must_pass',
]);

async function readGitLab(
  token: string,
  settings: AppSettings,
  mr: AppMergeTarget,
): Promise<ForgeRead> {
  const client = new GitLabClient({ baseUrl: forgeBaseUrl('gitlab', settings), token });
  const detail = await client.getMergeRequestByPath(mr.projectPath, mr.number);
  const liveHeadSha = detail.sha ?? null;
  const dms = detail.detailed_merge_status ?? null;

  let mergeable: boolean | null;
  if (dms) {
    mergeable = dms === 'mergeable' ? true : GITLAB_COMPUTING.has(dms) ? null : false;
  } else {
    const legacy = detail.merge_status ?? '';
    mergeable = legacy === 'can_be_merged' ? true : legacy === 'cannot_be_merged' ? false : null;
  }
  const conflicted = detail.has_conflicts === true || dms === 'conflict';
  const behind = dms === 'need_rebase';

  const pipeline = detail.head_pipeline ?? null;
  const checksSha = pipeline?.sha ?? liveHeadSha ?? '';
  let checks: AppMergeCheck[] = [];
  if (pipeline?.id && liveHeadSha && liveHeadSha === mr.headSha) {
    checks = checksFromGitLab(await client.listPipelineJobs(detail.project_id, pipeline.id));
  }

  return {
    facts: {
      state: detail.state === 'opened' ? 'open' : detail.state === 'merged' ? 'merged' : 'closed',
      draft: detail.draft ?? detail.work_in_progress ?? false,
      mergeable,
      behind,
      conflicted,
      liveHeadSha,
      checksSha,
      checks,
    },
    base: detail.target_branch ?? mr.targetBranch,
    merge: async (sha, method) => {
      // GitLab cleans up when the merge request or the project already says to; otherwise
      // ask for the deletion as part of the merge itself.
      let removes = detail.force_remove_source_branch === true;
      if (!removes) {
        const project = await client.getProjectMergeSettings(mr.projectPath);
        removes = project.removeSourceBranchAfterMerge === true;
      }
      await client.mergeMergeRequest(detail.project_id, mr.number, sha, {
        squash: method === 'squash',
        shouldRemoveSourceBranch: !removes,
      });
    },
  };
}

function forgeLabel(mr: Pick<MergeRequest, 'provider'>): string {
  return mr.provider === 'github' ? 'GitHub' : 'GitLab';
}

/**
 * The forge's own sentence out of a client error — `"GitHub 405 Method Not Allowed: {json}"`
 * carries it as the JSON body's `message` (GitLab sometimes as an array or object of them).
 */
export function forgeMessage(err: Error): string {
  const raw = err.message;
  const colon = raw.indexOf(': ');
  if (colon >= 0) {
    try {
      const body = JSON.parse(raw.slice(colon + 2)) as { message?: unknown };
      const msg = body?.message;
      if (typeof msg === 'string' && msg.trim()) return msg.trim().replace(/\.$/, '');
      if (Array.isArray(msg) && msg.length > 0) return msg.map(String).join('; ');
      if (msg && typeof msg === 'object') return Object.values(msg).flat().map(String).join('; ');
    } catch {
      // not JSON — the raw message is the best there is
    }
  }
  return raw.replace(/\.$/, '');
}

/** Which gate a forge's merge refusal is — `conflict`/`behind` are the two the PR watcher
 *  can hand to the existing conflict ladder / forge rebase. */
export function classifyRefusal(message: string): AppMergeRefusal {
  if (/head branch was modified|sha .*(does not match|mismatch)|sha.*not match/i.test(message)) {
    return 'stale-sha';
  }
  if (/conflict/i.test(message)) return 'conflict';
  if (
    /behind|out of date|not up to date|up-to-date|needs? (a )?rebase|need_rebase/i.test(message)
  ) {
    return 'behind';
  }
  return 'not-mergeable';
}
