/**
 * Linking a merge request or pull request a human opened THEMSELVES — on the forge's own web
 * UI, or from a fork, or from a branch this app never pushed — to a card, by pasting its URL.
 *
 * `forge/createPr.ts` covers the other direction: this app pushes the branch and opens the
 * row. That path knows exactly which card the new row belongs to because it started there.
 * This one starts from a URL instead, so the fetch comes first and the card is asserted
 * afterwards — the human reading the URL off their browser is the one fact neither forge nor
 * any sync can supply.
 *
 * WHAT IT DOES, IN ORDER
 * -----------------------
 *   1. Parse the URL into forge coordinates (`parsePrUrl.ts`), refusing anything that is not
 *      one MR or one PR.
 *   2. Guard that forge is enabled and has a token — a card can be asked to link a forge this
 *      app is not even configured to talk to.
 *   3. Fetch the MR/PR in full and run it through the same `describe*` function the syncs use,
 *      so its pipeline, approvals and conflicts read exactly as a sync would report them.
 *   4. Reconcile it through the same reducer the syncs use, handing in the row already stored
 *      under this id (if any) as `existing`, so read markers and a local rename survive a
 *      re-link rather than resetting to a blank row.
 *   5. Stamp `openedForTaskId` AND `taskId` onto the target card. Both, and unconditionally:
 *      the reconciler's own `openedForTaskId` handling only ever *carries forward* a prior
 *      value (see `gitlabSync.ts#reconcileMergeRequests`), it never sets one for a row it is
 *      seeing for the first time — that is `createPr.ts#rowFor`'s job on the create path, and
 *      this is the same job on the link path. The human pointing at a URL and saying "this
 *      one" beats whatever key-matching the reconciler would otherwise have guessed.
 *   6. Upsert the row and file a timeline note, exactly as `createPr.ts` does.
 */
import type { ForgeProvider, MergeRequest } from '@shared/mergeRequest';
import { forgeName, mrRef } from '@shared/mergeRequest';
import type { Task } from '@shared/model';
import type { AppSettings } from '@shared/settings';
import { describeMergeRequest } from '../gitlab/describeMergeRequest';
import { GitLabClient } from '../gitlab/gitlabClient';
import { mergeRequestId, reconcileMergeRequests } from '../gitlab/gitlabSync';
import { describePullRequest, listedFromDetail } from '../github/describePullRequest';
import { GitHubClient } from '../github/githubClient';
import { pullRequestId, reconcilePullRequests } from '../github/githubPrSync';
import { forgeBaseUrl } from './baseUrl';
import { parsePrUrl } from './parsePrUrl';

/**
 * The board-index shape both reconcilers ask for, minus the forge-specific identity cache —
 * `identity: null` is accepted by either forge's own options type (both spell it
 * `…IdentityCache | null`), and "we could not find out who you are" is the safe direction
 * both already fall back to: it counts nothing as your own comment rather than everything.
 * A link is a one-off fetch of a single row, not a poll, so paying for an identity lookup
 * here would be a network call this flow has no other reason to make.
 */
export interface LinkReconcileOpts {
  knownKeys: readonly string[];
  taskIdByKey: ReadonlyMap<string, string>;
  knownTaskIds: ReadonlySet<string>;
  identity: null;
  now: number;
}

/** What {@link linkMergeRequest} needs from the world around it. */
export interface LinkPrDeps {
  getTask(taskId: string): Task | undefined;
  getSettings(): AppSettings;
  /** Every merge request the board knows about — searched here for a prior stored row. */
  listMergeRequests(): MergeRequest[];
  /**
   * Every tracker key and card id on the board, for the reconciler — the same index
   * `ipc.ts`'s own `boardKeyIndex` builds for the syncs, handed in rather than rebuilt so
   * there is exactly one place that decides what counts as a "known" key or card.
   */
  boardKeyIndex(): {
    knownKeys: string[];
    taskIdByKey: Map<string, string>;
    knownTaskIds: Set<string>;
  };
  upsertMergeRequest(mr: MergeRequest): void;
  /** The decrypted personal access token for a forge, or null when none is saved. */
  tokenFor(provider: ForgeProvider): string | null;
  /** File a note on the card's timeline. */
  note(projectId: string, taskId: string, body: string): void;
  now(): number;
}

/**
 * Fetch one MR/PR by URL and file it against `taskId`.
 *
 * Throws — with a sentence naming the wall — rather than returning a failure shape: the bad
 * URL, the disabled provider, the missing token and "GitLab/GitHub could not find that" are
 * all refusals a human reads and acts on, in the dialog that called this.
 */
export async function linkMergeRequest(
  deps: LinkPrDeps,
  taskId: string,
  url: string,
): Promise<MergeRequest> {
  const task = deps.getTask(taskId);
  if (!task) throw new Error('That card no longer exists.');

  const parsed = parsePrUrl(url);
  if (!parsed) {
    throw new Error(`"${url.trim()}" is not a GitLab merge request or GitHub pull request URL.`);
  }

  const settings = deps.getSettings();
  const enabled = parsed.provider === 'gitlab' ? settings.gitlab.enabled : settings.github.enabled;
  if (!enabled) {
    throw new Error(`${forgeName(parsed.provider)} is not enabled. Turn it on in Settings first.`);
  }
  const token = deps.tokenFor(parsed.provider);
  if (!token) {
    throw new Error(`No ${forgeName(parsed.provider)} token is saved. Add one in Settings.`);
  }
  // Throws its own named-setting sentence when the URL field is blank — see `baseUrl.ts`.
  const baseUrl = forgeBaseUrl(parsed.provider, settings);

  const stored = deps.listMergeRequests();
  const { knownKeys, taskIdByKey, knownTaskIds } = deps.boardKeyIndex();
  const now = deps.now();

  const opts: LinkReconcileOpts = { knownKeys, taskIdByKey, knownTaskIds, identity: null, now };
  const row =
    parsed.provider === 'github'
      ? await linkGitHubPullRequest(
          new GitHubClient({ baseUrl, token }),
          { owner: parsed.owner, repo: parsed.repo, number: parsed.number },
          stored,
          opts,
        )
      : await linkGitLabMergeRequest(
          new GitLabClient({ baseUrl, token }),
          { projectPath: parsed.projectPath, number: parsed.number },
          stored,
          opts,
        );

  // The human's assertion beats the matcher: both fields are stamped, unconditionally, and
  // the reconciler's own `openedForTaskId ?? null` carry-forward is overridden rather than
  // relied on — see the file comment for why the reconciler alone cannot do this.
  const linked: MergeRequest = { ...row, openedForTaskId: taskId, taskId };
  deps.upsertMergeRequest(linked);
  deps.note(task.projectId, taskId, `Linked ${mrRef(linked)}: ${linked.webUrl}`);
  return linked;
}

/**
 * The GitLab half, taking an already-built {@link GitLabClient} rather than a token — so a
 * test can hand in a stub the same way `describeMergeRequest.test.ts` does, without this
 * function's own guard clauses (enabled, token, base URL) getting in the way of exercising
 * the fetch-then-reconcile part on its own. `linkMergeRequest` above is what builds the real
 * client from a saved token.
 */
export async function linkGitLabMergeRequest(
  client: GitLabClient,
  args: { projectPath: string; number: number },
  stored: readonly MergeRequest[],
  opts: LinkReconcileOpts,
): Promise<MergeRequest> {
  const detail = await client.getMergeRequestByPath(args.projectPath, args.number);
  const id = mergeRequestId(detail.project_id, detail.iid);
  const prior = stored.find((mr) => mr.id === id);
  const fetched = await describeMergeRequest(client, detail, { stale: true, prior });
  const { upserts } = reconcileMergeRequests(prior ? [prior] : [], [fetched], opts);
  return upserts[0];
}

/** The GitHub half of {@link linkGitLabMergeRequest} — same shape, same reason. */
export async function linkGitHubPullRequest(
  client: GitHubClient,
  args: { owner: string; repo: string; number: number },
  stored: readonly MergeRequest[],
  opts: LinkReconcileOpts,
): Promise<MergeRequest> {
  const detail = await client.getPullRequest(args.owner, args.repo, args.number);
  // Same field describePullRequest itself reads its `repoId` from — the TARGET repo, not the
  // head's, so a pull request opened from a fork is still identified by the repo it targets.
  const repoId = detail.base?.repo?.id ?? 0;
  const id = pullRequestId(repoId, detail.number);
  const prior = stored.find((mr) => mr.id === id);
  const listed = listedFromDetail(detail, args.owner, args.repo);
  const fetched = await describePullRequest(client, listed, { stale: true, prior, detail });
  const { upserts } = reconcilePullRequests(prior ? [prior] : [], [fetched], opts);
  return upserts[0];
}
