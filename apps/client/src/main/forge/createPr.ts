/**
 * Opening a pull request for a card — the one entry point, shared by the button and by the
 * scheduler.
 *
 * WHY ONE FUNCTION
 * ----------------
 * There are two ways a PR gets opened (a human presses **Create PR**, or the card's work
 * finishes with "open a PR when finished" on) and exactly one thing that should happen in
 * both cases. Written twice, the two would drift on the details that matter most and are
 * hardest to see: which branch was pushed, which task the row was filed against, whether the
 * token got into a log. So the callers differ only in what they do with the answer.
 *
 * WHAT IT DOES, IN ORDER
 * ----------------------
 *   1. Resolve the card's branch and base — through `worktrees.inspect`, which READS what is
 *      on disk rather than building it, the same pair the Merge button falls back to after a
 *      restart.
 *   2. Read `origin`, and work out which forge it belongs to (`remoteUrl.ts`).
 *   3. Push the branch, failing fast rather than prompting (`git.pushBranch`).
 *   4. POST the create, treating "one already exists" as success.
 *   5. Upsert a `merge_requests` row against the card, so it shows up now rather than after
 *      the next poll — and under the id the next sync will use, so it is recognised as the
 *      SAME row rather than duplicated.
 *   6. Note it on the card's timeline with the URL.
 *
 * EVERY REFUSAL NAMES ITS WALL
 * ----------------------------
 * No remote, no token for that forge, nothing committed on the branch, the branch already
 * merged — each of those throws a sentence a human can act on, because a gate that refuses
 * has to say WHICH gate. One guessed sentence covering six different walls is the failure
 * `a-refusal-that-named-the-wrong-wall` is about.
 */
import type { ForgeProvider, MergeRequest } from '@shared/mergeRequest';
import { forgeName, mrIsSettled, mrNoun, mrRef } from '@shared/mergeRequest';
import type { Project, Task } from '@shared/model';
import type { AppSettings } from '@shared/settings';
import { sanitizeToken } from '@shared/secretToken';
import { commitsAhead, hasCommits, pushBranch, remoteUrl } from '../git';
import { hostFor } from '../exec';
import { GitHubClient } from '../github/githubClient';
import { pullRequestId } from '../github/githubPrSync';
import { GitLabClient } from '../gitlab/gitlabClient';
import { mergeRequestId } from '../gitlab/gitlabSync';
import { forgeBaseUrl } from './baseUrl';
import { parseRemoteUrl, pickForge } from './remoteUrl';

/** What {@link openPullRequest} needs from the world around it. */
export interface CreatePrDeps {
  getTask(taskId: string): Task | undefined;
  getProject(projectId: string): Project | undefined;
  getSettings(): AppSettings;
  /** Every merge request the board knows about — filtered to this card here. */
  listMergeRequests(): MergeRequest[];
  upsertMergeRequest(mr: MergeRequest): void;
  /**
   * What the card's worktree and branch ARE on disk right now, or null.
   * `WorktreeManager.inspect` — reading, never preparing.
   */
  inspect(
    project: Project,
    ownerTaskId: string,
    branchName?: string,
  ): Promise<{ cwd: string; branch: string; base: string } | null>;
  /**
   * The decrypted personal access token for a forge, or null when none is saved.
   *
   * A callback rather than a value because the secret must be read at the moment it is
   * spent: holding one in a long-lived object is how a token outlives the settings change
   * that revoked it, and it puts the plaintext somewhere a heap dump can find it.
   */
  tokenFor(provider: ForgeProvider): string | null;
  /** File a note on the card's timeline. */
  note(projectId: string, taskId: string, body: string): void;
  now(): number;
}

/** What the caller gets back — enough to link to, and enough to know not to shout. */
export interface OpenedPullRequest {
  url: string;
  /** How a human writes it: `#12` on GitHub, `!12` on GitLab. */
  ref: string;
  /** It was already open, so this call reported it rather than created it. */
  existed: boolean;
}

/**
 * Push this card's branch and open a pull request for it.
 *
 * Throws — with a sentence naming the wall — rather than returning a failure shape: every
 * caller either shows the message (the panel's `MessageBar`) or parks it (the scheduler),
 * and neither has anything useful to do with a partial success.
 */
export async function openPullRequest(
  deps: CreatePrDeps,
  taskId: string,
): Promise<OpenedPullRequest> {
  const task = deps.getTask(taskId);
  if (!task) throw new Error('That card no longer exists.');

  // A step never opens its own pull request: it shares its parent's worktree and branch, so
  // one PR covers the whole plan and it belongs to the card the branch belongs to. Exactly
  // the `worktreeOwner` rule the merge already follows.
  const ownerId = task.parentTaskId ?? task.id;
  const owner = ownerId === task.id ? task : (deps.getTask(ownerId) ?? task);

  const project = deps.getProject(owner.agentProjectId ?? '');
  if (!project) {
    throw new Error('This card is not delegated to an agent project, so it has no branch.');
  }

  /**
   * The pull request this card already has, if it has one.
   *
   * It does **not** short-circuit the push, and that is the whole subtlety. A card whose PR is
   * open goes on working — the next step of the same plan, a re-run, a chat that writes code —
   * and every one of those settles through here again. Returning the open one at this point
   * would strand those commits on the local branch forever: the pull request would show the
   * first run's work and nothing after it, while the card's timeline claimed a push that never
   * happened. So the branch is pushed every time and only the POST is skipped, which is what
   * "already open" actually means.
   */
  const alreadyOpen = openMergeRequestFor(deps.listMergeRequests(), owner.id);
  /**
   * Report that pull request — for the paths below where there is genuinely nothing left to
   * push. A link to the open one is a better answer there than an error about a branch that
   * has already done its job.
   */
  const reportOpen = (): OpenedPullRequest | null =>
    alreadyOpen ? { url: alreadyOpen.webUrl, ref: mrRef(alreadyOpen), existed: true } : null;

  const live = await deps.inspect(project, owner.id, owner.agentBranch ?? undefined);
  if (!live) {
    // A card whose branch was merged and cleaned up may still carry an open pull request —
    // one somebody merged on the forge, say. Its link is the useful answer, not this refusal.
    const open = reportOpen();
    if (open) return open;
    throw new Error(
      `There is no branch left for this card. Its worktree and branch are removed as the ` +
        `last step of a successful merge, so this usually means the work is already in ` +
        `${project.baseBranch?.trim() || 'the base branch'}.`,
    );
  }

  const host = hostFor(project.target);

  // Nothing to open a pull request FOR. Asked of the branch against its base rather than of
  // the worktree's tidiness: a branch with an uncommitted file has work on it, and a branch
  // whose commits are all in base already has none — and only the second is a refusal.
  if (!(await hasCommits(live.cwd, host))) {
    const open = reportOpen();
    if (open) return open;
    throw new Error(
      `Nothing has been committed on "${live.branch}" yet, so there is nothing to open a pull request for.`,
    );
  }
  const ahead = await commitsAhead(live.cwd, live.base, live.branch, host);
  if (ahead === 0) {
    // Nothing new to push AND one already open is the ordinary shape of a settled card being
    // asked twice — the pull request carries everything the branch has. Report it.
    const open = reportOpen();
    if (open) return open;
    throw new Error(
      `"${live.branch}" has no commits that ${live.base} does not already have — it has ` +
        `been merged, or nothing was ever written to it. There is nothing to open a pull ` +
        `request for.`,
    );
  }

  const origin = await remoteUrl(live.cwd, 'origin', host);
  if (!origin) {
    throw new Error(
      `${project.name} has no "origin" remote, so there is nowhere to push "${live.branch}". ` +
        `Add one (\`git remote add origin …\`) and press this again.`,
    );
  }
  const remote = parseRemoteUrl(origin);
  if (!remote) {
    throw new Error(
      `The "origin" remote of ${project.name} (${origin}) is not a GitHub or GitLab URL, so ` +
        `there is no forge to open a pull request on.`,
    );
  }

  const settings = deps.getSettings();
  const provider = pickForge(remote.host, settings);
  if (!provider) {
    throw new Error(
      `${remote.host} is not a forge this app is set up for. Enable GitHub or GitLab in ` +
        `Settings and point its URL at ${remote.host}.`,
    );
  }

  const token = deps.tokenFor(provider);
  if (!token) {
    throw new Error(
      `No ${forgeName(provider)} token is saved, so the branch cannot be pushed or a ` +
        `${mrNoun(provider)} opened. Add one in Settings.`,
    );
  }
  const clean = sanitizeToken(token);

  // The push. A tokenized URL only when the remote is https — an ssh remote authenticates
  // with a key and there is nothing to inject — and it is passed as ARGV, never written into
  // `.git/config`, which is why `pushBranch` drops `--set-upstream` for it.
  const httpsRemote = /^https?:\/\//i.test(origin);
  const pushed = await pushBranch(live.cwd, 'origin', live.branch, {
    url: httpsRemote ? tokenizedUrl(remote.host, remote.path, provider, clean) : undefined,
    secrets: [clean],
    host,
  });
  if (pushed.code !== 0) {
    // Redacted by `pushBranch` before it got here: git quotes the URL it was given back in
    // its own error, token and all, and this string goes on a timeline that keeps it.
    const why = (pushed.stderr.trim() || pushed.stdout.trim() || 'git push failed').slice(0, 400);
    throw new Error(`Could not push "${live.branch}" to ${remote.host}: ${why}`);
  }

  // Already open — so the push above is the entire job, and there is nothing to POST. Both
  // forges would refuse a second create as a duplicate anyway; this simply does not ask, and
  // the note says what actually happened rather than claiming to have opened one.
  if (alreadyOpen) {
    deps.note(
      project.id,
      owner.id,
      `Pushed "${live.branch}" to ${remote.host} — ${mrRef(alreadyOpen)} was already open for ` +
        `it and now carries this work: ${alreadyOpen.webUrl}`,
    );
    return { url: alreadyOpen.webUrl, ref: mrRef(alreadyOpen), existed: true };
  }

  const title = prTitle(owner);
  const body = prBody(owner, provider);
  const created =
    provider === 'github'
      ? await createOnGitHub(settings, clean, remote.path, live.branch, live.base, title, body)
      : await createOnGitLab(settings, clean, remote.path, live.branch, live.base, title, body);

  // `#12` / `!12`, from the same function the card row, the tooltip and the attention reason
  // spell it with — `created` carries the provider and the number, which is all `mrRef` reads.
  const ref = mrRef(created);
  deps.upsertMergeRequest(rowFor(created, owner.id, deps.now()));
  deps.note(
    project.id,
    owner.id,
    created.existed
      ? `A ${mrNoun(created.provider)} for "${live.branch}" was already open — ` +
          `${ref}: ${created.webUrl}`
      : `Pushed "${live.branch}" to ${remote.host} and opened ${ref} against ` +
          `\`${live.base}\` — ${created.webUrl}`,
  );

  return { url: created.webUrl, ref, existed: created.existed };
}

/** The card's open merge request, if it has one. A settled one is history, not a blocker. */
export function openMergeRequestFor(
  all: readonly MergeRequest[],
  taskId: string,
): MergeRequest | null {
  return all.find((mr) => mr.taskId === taskId && !mrIsSettled(mr)) ?? null;
}

/**
 * The forge's ephemeral basic-auth URL.
 *
 * Each forge has its own conventional username for a token, and they are not
 * interchangeable — `oauth2` against GitHub and `x-access-token` against GitLab both
 * authenticate as nobody. The token is percent-encoded because it lands in the userinfo
 * component of a URL, where a `/` or an `@` in it would move the host.
 */
function tokenizedUrl(host: string, path: string, provider: ForgeProvider, token: string): string {
  const user = provider === 'github' ? 'x-access-token' : 'oauth2';
  return `https://${user}:${encodeURIComponent(token)}@${host}/${path}.git`;
}

/**
 * The title: the card's own, with its tracker key in front when it has one.
 *
 * The key is what makes the pull request findable from the ticket and — on GitLab — what
 * `discoverIssueKeys` matches back to this card on the next sync, so it is worth the
 * characters. Not repeated when the title already opens with it, which is what a card
 * created from a ticket usually looks like.
 */
export function prTitle(task: Pick<Task, 'title' | 'externalKey' | 'ticketKey'>): string {
  const title = task.title.trim();
  const key = (task.ticketKey ?? task.externalKey ?? '').trim();
  // A GitHub issue's key is `owner/repo#12`, which is a reference and not a prefix anyone
  // wants in a title — it is put in the BODY instead, as a closing reference.
  if (!key || key.includes('#') || title.toUpperCase().startsWith(key.toUpperCase())) return title;
  return `${key}: ${title}`;
}

/**
 * The body: the card's description, plus a closing reference when the card IS a GitHub issue.
 *
 * `Closes owner/repo#12` earns its place twice over — GitHub closes the issue when the PR
 * lands, and `prMatch.closingReferences` reads it straight back on the next sync, so the PR
 * files itself against this card with no extra bookkeeping. Only for GitHub: the syntax
 * means nothing on GitLab, and a card mirrored from a GitHub issue whose code lives on
 * GitLab is not a shape worth inventing a reference for.
 */
export function prBody(
  task: Pick<Task, 'externalDescription' | 'description' | 'externalSource' | 'externalKey'>,
  provider: ForgeProvider,
): string {
  // `externalDescription` FIRST, and it is not the obviously-named field: that is the one a
  // card's brief actually lives in — what the detail pane edits, what the agent's prompt
  // reads, and what `createTask` writes. `Task.description` is a STEP's brief, and a step
  // never opens its own pull request, so it is only a fallback for the shape where a card
  // somehow carries one.
  const description = (task.externalDescription ?? task.description ?? '').trim();
  const closes =
    provider === 'github' && task.externalSource === 'github' && task.externalKey?.includes('#')
      ? `Closes ${task.externalKey.trim()}`
      : '';
  return [description, closes].filter(Boolean).join('\n\n');
}

/**
 * What both forges' creates boil down to, before it becomes a stored row.
 *
 * No `ref` field: `#12` and `!12` are a function of `provider` and `number`, both of which are
 * right here, and {@link mrRef} is where that function lives. Carrying the string as well
 * would be a third place the forge's notation is decided — and the one place it could be
 * decided WRONGLY, since nothing checks a hand-written `#` against the provider beside it.
 */
interface CreatedRef {
  provider: ForgeProvider;
  repoId: number;
  projectPath: string;
  number: number;
  title: string;
  webUrl: string;
  sourceBranch: string;
  targetBranch: string;
  draft: boolean;
  existed: boolean;
}

async function createOnGitHub(
  settings: AppSettings,
  token: string,
  projectPath: string,
  branch: string,
  base: string,
  title: string,
  body: string,
): Promise<CreatedRef> {
  const [ownerName, repoName] = projectPath.split('/');
  if (!ownerName || !repoName) {
    throw new Error(
      `"${projectPath}" is not an owner/repo path, so GitHub cannot be asked for a pull request.`,
    );
  }
  // Through the same guard `ipc.ts` builds its clients behind, so a blank setting refuses with
  // the sentence naming it rather than with `TypeError: Invalid URL` from inside `fetch`.
  // `apiRoot`'s rule — github.com is its own host, an Enterprise instance hangs off `/api/v3`
  // — is NOT re-derived here; `githubClient.ts` owns it, and a second copy is a second thing
  // to keep in step.
  const client = new GitHubClient({ baseUrl: forgeBaseUrl('github', settings), token });
  const { pullRequest, existed } = await client.createPullRequest(ownerName, repoName, {
    head: branch,
    base,
    title,
    body,
  });
  return {
    provider: 'github',
    // 0 when GitHub did not say — `githubPrSync` already stores placeholder rows under
    // `gh-0-{number}` and hands their markers on once the real id is learned, so this is a
    // shape the reconciler knows rather than a new one.
    repoId: pullRequest.head?.repo?.id ?? 0,
    projectPath: `${ownerName}/${repoName}`,
    number: pullRequest.number,
    title: pullRequest.title ?? title,
    webUrl: pullRequest.html_url,
    sourceBranch: pullRequest.head?.ref ?? branch,
    targetBranch: pullRequest.base?.ref ?? base,
    draft: pullRequest.draft === true,
    existed,
  };
}

async function createOnGitLab(
  settings: AppSettings,
  token: string,
  projectPath: string,
  branch: string,
  base: string,
  title: string,
  body: string,
): Promise<CreatedRef> {
  // Same guard as the GitHub half, one forge over. See {@link forgeBaseUrl}.
  const client = new GitLabClient({ baseUrl: forgeBaseUrl('gitlab', settings), token });
  const { mergeRequest, existed } = await client.createMergeRequest(projectPath, {
    source_branch: branch,
    target_branch: base,
    title,
    description: body,
  });
  return {
    provider: 'gitlab',
    repoId: mergeRequest.project_id ?? 0,
    projectPath,
    number: mergeRequest.iid,
    title: mergeRequest.title ?? title,
    webUrl: mergeRequest.web_url,
    sourceBranch: mergeRequest.source_branch ?? branch,
    targetBranch: mergeRequest.target_branch ?? base,
    draft: mergeRequest.draft === true || mergeRequest.work_in_progress === true,
    existed,
  };
}

/**
 * The stored row for a freshly opened PR.
 *
 * Two things are deliberate. The **id** comes from the same builders the syncs use
 * (`pullRequestId` / `mergeRequestId`), so the next reconcile pass recognises this row as
 * the one it is about to refresh rather than filing a duplicate beside it. And every field
 * we did not just learn takes its **honest empty value** — `pipelineStatus: 'unknown'`,
 * `approvalsRequired: null`, `pipelineStages: []` — because the interface's own comments are
 * explicit that these must not be confidently wrong: a `0` required-approvals on a fresh PR
 * would render as "no approval needed", and a `success` pipeline as a green tick on a
 * pipeline that has not started.
 */
function rowFor(created: CreatedRef, taskId: string, now: number): MergeRequest {
  return {
    id:
      created.provider === 'github'
        ? pullRequestId(created.repoId, created.number)
        : mergeRequestId(created.repoId, created.number),
    taskId,
    provider: created.provider,
    repoId: created.repoId,
    projectPath: created.projectPath,
    number: created.number,
    title: created.title,
    displayName: null,
    webUrl: created.webUrl,
    sourceBranch: created.sourceBranch,
    targetBranch: created.targetBranch,
    state: 'opened',
    draft: created.draft,
    pipelineStatus: 'unknown',
    pipelineUrl: null,
    pipelineStages: [],
    approvalsRequired: null,
    approvalsGiven: 0,
    changesRequested: false,
    detailedMergeStatus: null,
    hasConflicts: false,
    issueKeys: [],
    latestNoteAt: null,
    lastReadAt: null,
    lastEventAt: null,
    lastEventSeenAt: null,
    updatedAt: now,
    syncedAt: now,
  };
}
