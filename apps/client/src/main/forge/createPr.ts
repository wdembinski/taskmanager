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
 *   1½. When asked to (`opts.commitLeftover`), commit whatever is sitting uncommitted in the
 *      worktree before anything downstream looks at the branch — mirroring the safety commit
 *      `integrate` already takes before it merges, for the identical reason: a run can finish
 *      with edits still on disk, and a pull request opened without them would describe work
 *      that was never actually sent. Skipped outright when a rebase is paused here
 *      (`rebaseInProgress`) — committing mid-rebase would stage the conflict markers
 *      themselves, exactly the trap `integrate`'s own ordering guards against. Only the
 *      scheduler asks for this: it is the one caller that can finish a run with nothing
 *      committed yet, where the human pressing **Create PR** has always done so against a
 *      worktree whose tree is either already committed or is about to refuse with a clear
 *      "nothing to open a pull request for" instead.
 *   2. Read `origin`, and work out which forge it belongs to (`remoteUrl.ts`).
 *   3. Check the remote: fetch `origin`'s current copy of `base` and, if it has moved since
 *      this worktree last saw it, rebase the branch onto its new tip before anything is
 *      pushed ({@link WorktreeManager.syncOntoRemoteBase}, reusing the same mechanical
 *      conflict rungs `integrate` does). Opening a pull request against a base the branch has
 *      already fallen behind is exactly how a conflict shows up on the forge that nothing
 *      here ever saw coming — this is what catches it first. If that rebase turns out to
 *      have absorbed the branch's own work (someone merged it already, on the forge or by
 *      hand), there is nothing left to open a pull request for — refused the same way an
 *      empty branch always was, just discovered a step later. The rebase lands the branch on
 *      the remote's own fresh copy of `base` (`sync.remoteBase`), not necessarily on `base`
 *      itself — a local `base` that has diverged from origin (a squash merge, a local merge)
 *      can no longer be fast-forwarded to match it, so everything read AFTER the sync (the
 *      re-check below, and the pull request's own body) reads against `remoteBase` instead.
 *   4. Push the branch, failing fast rather than prompting (`git.pushBranch`). What this push
 *      is ALLOWED to do is worked out fresh by `planBranchPush`, never by step 3's status
 *      alone: a branch this worktree had already rebased onto its own copy of `base` before
 *      step 3 ever ran reports `sync.status === 'up-to-date'` (there was nothing NEW to
 *      fetch), yet its SHAs still differ from whatever was pushed under this name before — an
 *      ordinary push there is rejected as non-fast-forward with no lease ever considered. So
 *      every push fetches the remote branch's current tip and plans against it: a tip that is
 *      an ancestor of `HEAD` gets an ordinary push; a tip this branch's own history can fully
 *      account for (it is an ancestor of the fresh remote-base ref, or every commit it has
 *      that `HEAD` doesn't has a patch-id twin in `HEAD`) gets a lease
 *      (`--force-with-lease`) pinned to that tip; anything else — a commit genuinely foreign
 *      to this branch — refuses outright, naming the wall, rather than overwriting it.
 *   5. POST the create, treating "one already exists" as success — and when it was, or
 *      already was before the POST, PATCH/PUT its description to match the branch's current
 *      commits ({@link refreshDescription}), since the push just pushed.
 *   6. Upsert a `merge_requests` row against the card, so it shows up now rather than after
 *      the next poll — and under the id the next sync will use, so it is recognised as the
 *      SAME row rather than duplicated.
 *   7. Note it on the card's timeline with the URL.
 *
 * EVERY REFUSAL NAMES ITS WALL
 * ----------------------------
 * No remote, no token for that forge, nothing committed on the branch, the branch already
 * merged — each of those throws a sentence a human can act on, because a gate that refuses
 * has to say WHICH gate. One guessed sentence covering six different walls is the failure
 * `a-refusal-that-named-the-wrong-wall` is about.
 */
import type { TaskAttachment } from '@shared/attachments';
import type { ForgeProvider, MergeRequest } from '@shared/mergeRequest';
import { forgeName, mrIsSettled, mrNoun, mrRef } from '@shared/mergeRequest';
import type { Project, Task, TaskActivityEntry } from '@shared/model';
import type { AppSettings } from '@shared/settings';
import { sanitizeToken } from '@shared/secretToken';
import { variantWorkOwner } from '@shared/variants';
import { latestVisualState, shotPairs } from '@shared/visualSignOff';
import {
  aggregateTested,
  branchChangesBody,
  prSubject,
  wrapHanging,
  wrapPlainText,
} from '@shared/commitMessage';
import {
  branchCommitMessages,
  cherryUnmatched,
  commitAll,
  commitsAhead,
  hasCommits,
  isAncestor,
  pushBranch,
  rebaseInProgress,
  remoteBranchSha,
  remoteUrl,
  uncommittedPaths,
} from '../git';
import { hostFor, type ExecHost } from '../exec';
import { GitHubClient } from '../github/githubClient';
import { pullRequestId } from '../github/githubPrSync';
import { GitLabClient } from '../gitlab/gitlabClient';
import { mergeRequestId } from '../gitlab/gitlabSync';
import { REMOTE_BASE_REF } from '../worktreeManager';
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
  /** Every live variant row of any leader — `store.listVariantRows()`, for `variantWorkOwner`. */
  listVariantRows(leaderId?: string): Task[];
  /**
   * The owner card's own attachments — `store.attachmentsForTask`. Read to find a pending
   * visual sign-off (`shotPairs`), never a step's.
   */
  listAttachments(taskId: string): TaskAttachment[];
  /**
   * The owner card's own timeline — `store.getTaskActivity`. Read for the latest agent
   * verdict and human sign-off (`latestVisualState`), the same comments the card panel's
   * `VisualSignOff` section reads.
   */
  listActivity(taskId: string): TaskActivityEntry[];
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
   * Make sure `branch` is rebased onto `base` AS IT STANDS ON THE REMOTE right now, before
   * anything is pushed — `WorktreeManager.syncOntoRemoteBase`, reusing the exact conflict
   * rungs the branch's eventual merge would use. `opts.url`, when given, is the same
   * ephemeral tokenized URL the push uses a moment later, for a private remote.
   */
  syncOntoRemoteBase(
    project: Project,
    base: string,
    worktree: string,
    opts: { url?: string },
  ): Promise<
    | { status: 'up-to-date' }
    | { status: 'synced'; remoteBase: string; autoResolved?: string[] }
    | { status: 'conflict'; files: string[] }
    | { status: 'error'; message: string }
  >;
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

/**
 * What {@link prBody} needs to know about a card's pending visual sign-off — built from
 * {@link shotPairs}/{@link latestVisualState} at the call site (`visualSignOffFor`), never
 * recomputed inside `prBody` itself, so it stays a pure function of its arguments.
 */
export interface PrVisualSignOff {
  /** The text after "review them on" — the card's ticketKey/externalKey, or its title when
   *  it has neither. */
  cardKey: string;
  screens: readonly { name: string; verdict?: string }[];
}

/**
 * The owner card's pending visual sign-off, read fresh on every call (the attachments and the
 * timeline can both have changed since the last push) — `undefined` for the common case, a
 * card `ui-shots.mjs` never shot.
 */
function visualSignOffFor(
  deps: CreatePrDeps,
  owner: Pick<Task, 'id' | 'title' | 'ticketKey' | 'externalKey'>,
): PrVisualSignOff | undefined {
  const { pairs } = shotPairs(deps.listAttachments(owner.id));
  if (pairs.length === 0) return undefined;

  const screenNames = pairs.map((p) => p.name);
  const state = latestVisualState(deps.listActivity(owner.id), screenNames);
  const cardKey = (owner.ticketKey ?? owner.externalKey ?? '').trim() || owner.title;

  return {
    cardKey,
    screens: pairs.map((p) => {
      const row = state.rows.get(p.name);
      const verdict =
        row?.status === 'mismatch'
          ? row.note || 'flagged, no reason given'
          : row?.status === 'ok'
            ? 'matched the mockup'
            : undefined;
      return { name: p.name, verdict };
    }),
  };
}

/**
 * What {@link openPullRequest} should do about pushing `branch`, worked out BEFORE the push
 * runs rather than guessed from `sync`'s status alone — see this file's own notes on why
 * `sync.status === 'synced'` used to be the only case that took a lease, and why a branch
 * rebased onto a base this worktree already had (so `sync` reports `up-to-date`) still needs
 * one.
 *
 * - `new` — the remote has no such branch yet. An ordinary push creates it.
 * - `fast-forward` — the remote's tip is an ancestor of `HEAD`. An ordinary push lands it;
 *   there is nothing here a lease would protect that a ff-only push doesn't already refuse.
 * - `lease` — the remote's tip is NOT an ancestor of `HEAD`, but every commit it has that
 *   `HEAD` does not is accounted for (see the two-part test below) — the local branch was
 *   rebased, not raced. `expected` is the remote SHA to lease the push against.
 * - `refuse` — the remote has at least one commit `HEAD` cannot account for: somebody else
 *   pushed to this branch. `reason` names what was found, for the caller's own wall-naming
 *   refusal.
 */
export type BranchPushPlan =
  | { kind: 'new' }
  | { kind: 'fast-forward' }
  | { kind: 'lease'; expected: string }
  | { kind: 'refuse'; reason: string };

/**
 * Decide how {@link openPullRequest} may push `branch`, given the remote's current tip
 * (`remoteSha`, freshly fetched — `null` when the remote has no such branch) and the refs the
 * local HEAD was (or wasn't) just rebased onto (`baseRefs` — the fresh `refs/orch/remote-base`
 * and/or `compareBase`; see {@link openPullRequest}'s own comment for why both are offered).
 *
 * A branch counts as "locally rebased, safe to overwrite" when the remote tip is not an
 * ancestor of `HEAD` but either:
 *
 *  1. the remote tip is itself an ancestor of one of `baseRefs` — it never carried any work
 *     of its own beyond the base, so replacing it loses nothing, or
 *  2. every commit the remote has that `HEAD` does not already has a patch-id twin
 *     somewhere in `HEAD` ({@link cherryUnmatched} reports none) — the rebase replayed them
 *     under new SHAs.
 *
 * Anything else means a commit exists on the remote that this branch's own history cannot
 * account for — somebody else pushed here — and that is refused rather than overwritten.
 */
export async function planBranchPush(opts: {
  cwd: string;
  branch: string;
  remoteSha: string | null;
  baseRefs: readonly string[];
  host?: ExecHost;
}): Promise<BranchPushPlan> {
  const { cwd, branch, remoteSha, baseRefs, host } = opts;
  if (remoteSha === null) return { kind: 'new' };
  if (await isAncestor(cwd, remoteSha, 'HEAD', host)) return { kind: 'fast-forward' };

  for (const baseRef of baseRefs) {
    if (baseRef && (await isAncestor(cwd, remoteSha, baseRef, host))) {
      return { kind: 'lease', expected: remoteSha };
    }
  }

  const unmatched = await cherryUnmatched(cwd, 'HEAD', remoteSha, host);
  if (unmatched.length === 0) return { kind: 'lease', expected: remoteSha };

  const n = unmatched.length;
  return {
    kind: 'refuse',
    reason:
      `${n} commit${n === 1 ? '' : 's'} on the remote (${unmatched.map((s) => s.slice(0, 7)).join(', ')}) ` +
      `${n === 1 ? 'has' : 'have'} no match in "${branch}"`,
  };
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
  opts?: { commitLeftover?: boolean },
): Promise<OpenedPullRequest> {
  const task = deps.getTask(taskId);
  if (!task) throw new Error('That card no longer exists.');

  // A step never opens its own pull request: it shares its parent's worktree and branch, so
  // one PR covers the whole plan and it belongs to the card the branch belongs to. Exactly
  // the `worktreeOwner` rule the merge already follows — and a leader routes the same way,
  // through whichever variant it picked, refusing before a pick exactly as the merge does.
  const resolved = variantWorkOwner(task, deps.listVariantRows(), (id) => deps.getTask(id));
  if ('refused' in resolved) throw new Error(resolved.refused);
  const ownerId = resolved.ownerId;
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

  // A write nobody asked for, the same as `resyncNote` below — so it goes on the timeline the
  // same way. Skipped when a rebase is paused here: `commitAll` is `git add -A` and a commit,
  // and run mid-rebase it would stage the conflict markers themselves into history.
  if (opts?.commitLeftover && !(await rebaseInProgress(live.cwd, host))) {
    const committed = await commitAll(live.cwd, prTitle(owner), host);
    if (committed) {
      deps.note(
        project.id,
        owner.id,
        `Committed uncommitted work left on "${live.branch}" before opening a pull request for it.`,
      );
    }
  }

  // Nothing to open a pull request FOR. Asked of the branch against its base rather than of
  // the worktree's tidiness: a branch with an uncommitted file has work on it, and a branch
  // whose commits are all in base already has none — and only the second is a refusal.
  if (!(await hasCommits(live.cwd, host))) {
    const open = reportOpen();
    if (open) return open;
    throw await nothingCommittedError(
      live.cwd,
      live.branch,
      host,
      `Nothing has been committed on "${live.branch}" yet, so there is nothing to open a pull request for.`,
    );
  }
  const ahead = await commitsAhead(live.cwd, live.base, live.branch, host);
  if (ahead === 0) {
    // Nothing new to push AND one already open is the ordinary shape of a settled card being
    // asked twice — the pull request carries everything the branch has. Report it.
    const open = reportOpen();
    if (open) return open;
    throw await nothingCommittedError(
      live.cwd,
      live.branch,
      host,
      `"${live.branch}" has no commits that ${live.base} does not already have — it has ` +
        `been merged, or nothing was ever written to it. There is nothing to open a pull ` +
        `request for.`,
    );
  }

  const settings = deps.getSettings();
  const target = await resolveForgeGitTarget(project, live.cwd, host, settings, deps.tokenFor);

  // Check the remote BEFORE pushing: fetch origin's current copy of `base` and, if it has
  // moved since this worktree last saw it, rebase the branch onto the fresh tip — reusing the
  // same mechanical conflict rungs `integrate` uses to land a merge. Skipping this is exactly
  // how a pull request ends up opened against a base the branch has already fallen behind,
  // showing a conflict on the forge that nothing here ever saw coming.
  const sync = await deps.syncOntoRemoteBase(project, live.base, live.cwd, { url: target.url });
  if (sync.status === 'conflict') {
    throw new Error(
      `"${live.base}" has moved on ${target.host} since "${live.branch}" was built, and ` +
        `rebasing onto its current state conflicts on ${sync.files.join(', ')}. Pull the ` +
        `latest ${live.base} into this project and resolve that there, then press this again.`,
    );
  }
  if (sync.status === 'error') {
    throw new Error(
      `Could not rebase "${live.branch}" onto the latest ${live.base} from ${target.host}: ` +
        `${sync.message}`,
    );
  }
  // A write nobody asked for belongs on the timeline even when it worked — the only place a
  // human can see that a conflict rebasing onto the fresher base was resolved automatically.
  const resyncNote =
    sync.status === 'synced' && sync.autoResolved?.length
      ? ` "${live.base}" had moved on ${target.host}; rebasing onto it hit ${sync.autoResolved.length} ` +
        `conflict(s) that were resolved automatically, with no agent (${sync.autoResolved.join(', ')}).`
      : '';

  // What the branch is actually compared against from here on: the remote's own fresh copy
  // of `base` when the sync just rebased onto it, never `live.base` itself in that case — a
  // local `base` that has diverged from origin can no longer be fast-forwarded to match it
  // (see `syncOntoRemoteBase`'s own comment), so `live.base` would describe the branch against
  // a ref it was never actually rebased onto.
  const compareBase = sync.status === 'synced' ? sync.remoteBase : live.base;

  // Re-asked AFTER the sync, which may have just rebased the branch onto a base that already
  // contained every one of its commits — someone merged this exact work on the forge, or by
  // hand, while the worktree sat idle. The EARLIER check above only ever saw this worktree's
  // own, possibly stale, copy of base; this is the first point the fresh one can be trusted.
  if (sync.status === 'synced') {
    const stillAhead = await commitsAhead(live.cwd, compareBase, live.branch, host);
    if (stillAhead === 0) {
      const open = reportOpen();
      if (open) return open;
      throw new Error(
        `"${live.branch}" has no commits that ${live.base} does not already have, now that ` +
          `${target.host}'s current state has been pulled in — its work is already there. ` +
          `There is nothing to open a pull request for.`,
      );
    }
  }

  // The material `prBody` summarises. Read AFTER the remote check, which may have rebased the
  // branch onto a fresher base — same messages, new commits. `[]` on a read failure, not on a
  // genuinely empty branch — `ahead` already ruled that out above — so `prBody` reads an empty
  // array as "fall back to the card's own description" rather than "say nothing".
  const commits = await branchCommitMessages(live.cwd, compareBase, live.branch, host);

  // Read fresh on every push — never cached from the last time this card's PR was opened or
  // refreshed, since a step running between pushes can leave new shots, or a human can have
  // signed off since.
  const signOff = visualSignOffFor(deps, owner);

  // Fetched fresh, moments before the push, rather than reused from `sync` — which never
  // looked at the BRANCH's own remote ref, only `base`'s. `null` means the remote has no such
  // branch yet.
  const remoteSha = await remoteBranchSha(live.cwd, 'origin', live.branch, {
    url: target.url,
    secrets: [target.token],
    host,
  });

  // Worked out before the push rather than guessed from `sync`'s status: a branch this
  // worktree had already rebased onto its own copy of `base` reports `sync.status ===
  // 'up-to-date'` (nothing NEW to fetch), yet its SHAs still differ from whatever was pushed
  // under this name before — exactly the "Could not push … non-fast-forward" wall this ticket
  // exists to close. `baseRefs` offers both the fresh remote-base ref `syncOntoRemoteBase`
  // fetches on every call (even when it reports `up-to-date`) and `compareBase` itself, which
  // is the same ref in the `synced` case and `live.base` otherwise.
  const plan = await planBranchPush({
    cwd: live.cwd,
    branch: live.branch,
    remoteSha,
    baseRefs: [REMOTE_BASE_REF, compareBase],
    host,
  });
  if (plan.kind === 'refuse') {
    throw new Error(
      `"${live.branch}" has commits on ${target.host} this branch does not — ${plan.reason}. ` +
        `Left alone rather than overwrite them.`,
    );
  }

  // The push. `target.url` is a tokenized URL only when the remote is https — an ssh remote
  // authenticates with a key and there is nothing to inject — and it is passed as ARGV, never
  // written into `.git/config`, which is why `pushBranch` drops `--set-upstream` for it. The
  // remote check above fetched through the same URL.
  //
  // `new` on a branch the sync just rebased (`sync.status === 'synced'`) still leases against
  // the remote's absence — see `PushOptions.forceWithLease` — the same `''` this already did
  // before `planBranchPush` existed; any other `new` (nothing to rebase, nothing pushed before)
  // is a plain push, exactly as it always was.
  const forceWithLease =
    plan.kind === 'lease'
      ? { expected: plan.expected }
      : plan.kind === 'new' && sync.status === 'synced'
        ? { expected: '' }
        : undefined;
  const pushed = await pushBranch(live.cwd, 'origin', live.branch, {
    url: target.url,
    secrets: [target.token],
    host,
    ...(forceWithLease ? { forceWithLease } : {}),
  });
  if (pushed.code !== 0) {
    // Redacted by `pushBranch` before it got here: git quotes the URL it was given back in
    // its own error, token and all, and this string goes on a timeline that keeps it.
    const why = (pushed.stderr.trim() || pushed.stdout.trim() || 'git push failed').slice(0, 400);
    throw new Error(`Could not push "${live.branch}" to ${target.host}: ${why}`);
  }

  // Already open — so the push above is the entire job, and there is nothing to POST. Both
  // forges would refuse a second create as a duplicate anyway; this simply does not ask, and
  // the note says what actually happened rather than claiming to have opened one. The
  // description is refreshed anyway: the push just carried new commits, and the pull
  // request's body is supposed to summarise the branch's CURRENT state, not the one it had
  // when it was first opened.
  if (alreadyOpen) {
    await refreshDescription(
      deps,
      project.id,
      owner.id,
      settings,
      target.token,
      target.provider,
      target.path,
      alreadyOpen.number,
      prBody(owner, target.provider, commits, signOff),
    );
    deps.note(
      project.id,
      owner.id,
      `Pushed "${live.branch}" to ${target.host} — ${mrRef(alreadyOpen)} was already open for ` +
        `it and now carries this work: ${alreadyOpen.webUrl}${resyncNote}`,
    );
    return { url: alreadyOpen.webUrl, ref: mrRef(alreadyOpen), existed: true };
  }

  const title = prTitle(owner);
  const body = prBody(owner, target.provider, commits, signOff);
  const created =
    target.provider === 'github'
      ? await createOnGitHub(
          settings,
          target.token,
          target.path,
          live.branch,
          live.base,
          title,
          body,
        )
      : await createOnGitLab(
          settings,
          target.token,
          target.path,
          live.branch,
          live.base,
          title,
          body,
        );

  // The create call above found one GitHub/GitLab already considers open (see
  // `createOnGitHub`/`createOnGitLab`'s `existed: true`) — the same "refresh it anyway" case
  // as `alreadyOpen` above, just discovered a step later, after the POST rather than before it.
  if (created.existed) {
    await refreshDescription(
      deps,
      project.id,
      owner.id,
      settings,
      target.token,
      target.provider,
      target.path,
      created.number,
      body,
    );
  }

  // `#12` / `!12`, from the same function the card row, the tooltip and the attention reason
  // spell it with — `created` carries the provider and the number, which is all `mrRef` reads.
  const ref = mrRef(created);
  deps.upsertMergeRequest(rowFor(created, owner.id, deps.now()));
  deps.note(
    project.id,
    owner.id,
    (created.existed
      ? `A ${mrNoun(created.provider)} for "${live.branch}" was already open — ` +
        `${ref}: ${created.webUrl}`
      : `Pushed "${live.branch}" to ${target.host} and opened ${ref} against ` +
        `\`${live.base}\` — ${created.webUrl}`) + resyncNote,
  );

  return { url: created.webUrl, ref, existed: created.existed };
}

/**
 * Rewrite an already-open pull request's or merge request's description to match the
 * branch's current commits, after a push that found one already there — either because
 * {@link openMergeRequestFor} already knew about it, or because the create call just above
 * discovered the same thing a step later (`existed: true`).
 *
 * **Non-fatal.** The push already succeeded, which is the part of the job that matters; a
 * refusal here (a revoked token, a human-deleted PR, a forge outage) is noted on the card's
 * timeline rather than thrown, because throwing would turn a successful push into a reported
 * failure. The title is never touched — only `body`/`description` is sent — because a human
 * may have retitled the pull request, and nothing here should undo that.
 */
async function refreshDescription(
  deps: CreatePrDeps,
  projectId: string,
  taskId: string,
  settings: AppSettings,
  token: string,
  provider: ForgeProvider,
  projectPath: string,
  number: number,
  body: string,
): Promise<void> {
  try {
    if (provider === 'github') {
      const [ownerName, repoName] = projectPath.split('/');
      const client = new GitHubClient({ baseUrl: forgeBaseUrl('github', settings), token });
      await client.updatePullRequest(ownerName, repoName, number, { body });
    } else {
      const client = new GitLabClient({ baseUrl: forgeBaseUrl('gitlab', settings), token });
      await client.updateMergeRequest(projectPath, number, { description: body });
    }
  } catch (err) {
    deps.note(
      projectId,
      taskId,
      `Pushed the branch, but could not refresh the ${mrNoun(provider)}'s description: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The refusal for a branch `commitsAhead`/`hasCommits` found nothing to open a pull request
 * for — naming whichever is actually true. "Merged, or nothing was ever written" is only an
 * honest answer when the worktree itself is clean; a run that finished with edits still on
 * disk (`a-refusal-that-named-the-wrong-wall`'s own case, F7.2) left real work sitting right
 * there, and the generic sentence sends a human looking for a merge that never happened
 * instead of telling them to just commit it.
 */
async function nothingCommittedError(
  cwd: string,
  branch: string,
  host: ExecHost | undefined,
  genericMessage: string,
): Promise<Error> {
  const dirty = await uncommittedPaths(cwd, host);
  if (dirty.length === 0) return new Error(genericMessage);
  return new Error(
    `Nothing is committed on "${branch}" yet, but its worktree has uncommitted changes ` +
      `(${dirty.join(', ')}). Commit them, then press this again.`,
  );
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
export function tokenizedUrl(
  host: string,
  path: string,
  provider: ForgeProvider,
  token: string,
): string {
  const user = provider === 'github' ? 'x-access-token' : 'oauth2';
  return `https://${user}:${encodeURIComponent(token)}@${host}/${path}.git`;
}

/**
 * What a push or fetch against a card's forge needs: which provider it is, where its
 * remote lives, a usable token, and (for an https remote) the ephemeral tokenized URL to
 * authenticate the git call with — undefined for ssh, which authenticates with a key and
 * has nothing to inject.
 */
export interface ForgeGitTarget {
  provider: ForgeProvider;
  host: string;
  path: string;
  /** Already sanitized — pass straight to a git call's `secrets`. */
  token: string;
  url: string | undefined;
}

/**
 * Read `origin`, work out which forge it belongs to, and get a token for it — the
 * preamble every push or fetch against a PR/MR's forge needs. Shared by {@link
 * openPullRequest} and the scheduler's PR-conflict ladder (`Scheduler.setForgeGit`), so
 * the three walls either one can refuse on — no remote, not a forge this app knows, no
 * token — are named in exactly one place rather than two that can drift apart.
 */
export async function resolveForgeGitTarget(
  project: Project,
  cwd: string,
  host: ExecHost | undefined,
  settings: AppSettings,
  tokenFor: (provider: ForgeProvider) => string | null,
): Promise<ForgeGitTarget> {
  const origin = await remoteUrl(cwd, 'origin', host);
  if (!origin) {
    throw new Error(
      `${project.name} has no "origin" remote, so there is nowhere to push or fetch its ` +
        `branches. Add one (\`git remote add origin …\`) and try again.`,
    );
  }
  const remote = parseRemoteUrl(origin);
  if (!remote) {
    throw new Error(
      `The "origin" remote of ${project.name} (${origin}) is not a GitHub or GitLab URL, so ` +
        `there is no forge to act against.`,
    );
  }
  const provider = pickForge(remote.host, settings);
  if (!provider) {
    throw new Error(
      `${remote.host} is not a forge this app is set up for. Enable GitHub or GitLab in ` +
        `Settings and point its URL at ${remote.host}.`,
    );
  }
  const token = tokenFor(provider);
  if (!token) {
    throw new Error(`No ${forgeName(provider)} token is saved. Add one in Settings.`);
  }
  const clean = sanitizeToken(token);
  const httpsRemote = /^https?:\/\//i.test(origin);
  return {
    provider,
    host: remote.host,
    path: remote.path,
    token: clean,
    url: httpsRemote ? tokenizedUrl(remote.host, remote.path, provider, clean) : undefined,
  };
}

/**
 * The title: a Conventional Commits subject derived from the card, CONTRIBUTING.md §1's
 * shape — `type: summary`, 50 characters or fewer — rather than the card's own free-form
 * title. `@shared/commitMessage`'s `prSubject` does the actual work (and the type inference
 * it shares with the branch name), so this is just the `Task` fields it needs.
 */
export function prTitle(task: Pick<Task, 'title' | 'type' | 'issueType' | 'externalType'>): string {
  return prSubject({
    title: task.title,
    taskType: task.type,
    issueType: task.issueType,
    externalType: task.externalType,
  });
}

/**
 * The body: the branch's own commits summarised into CONTRIBUTING.md §2's plain-text,
 * 72-column shape — `@shared/commitMessage`'s `branchChangesBody` does the actual
 * summarising — ending in a `Ticket ID:` trailer (when the card has a key) and a `Tested:`
 * one, plus a closing reference when the card IS a GitHub issue.
 *
 * `commits` is the branch's own commit messages, oldest first
 * (`apps/client/src/main/git.ts`'s `branchCommitMessages`), passed in rather than re-read so
 * this stays a pure function of its arguments. When it is empty — `branchCommitMessages`
 * failed to read the branch, rather than the branch genuinely having none, since
 * {@link openPullRequest} already refused before this is ever called on an empty branch —
 * the body falls back to the card's own description, exactly as it did before commits were
 * summarised at all.
 *
 * `Tested:` cannot say what a human would — there is no "what I ran" to ask an automated PR
 * for — so `aggregateTested` pulls the real answer out of the commits themselves: every one
 * CONTRIBUTING.md and `CLAUDE.md` require to carry its own `Tested:` line, honestly. Only
 * when none of them do (an old branch, commits made before this convention) does it fall
 * back to naming where the answer lives instead of inventing one.
 *
 * `Closes owner/repo#12` earns its place twice over — GitHub closes the issue when the PR
 * lands, and `prMatch.closingReferences` reads it straight back on the next sync, so the PR
 * files itself against this card with no extra bookkeeping. Only for GitHub: the syntax
 * means nothing on GitLab, and a card mirrored from a GitHub issue whose code lives on
 * GitLab is not a shape worth inventing a reference for.
 *
 * `signOff` — when given, and carrying at least one screen — adds a "Visual sign-off"
 * section before the trailers, naming how many screens `ui-shots.mjs` shot and each one's
 * latest agent verdict, so a human reviewing the pull request knows to go look at the card
 * before merging rather than discovering the shots exist by accident. Built by
 * {@link visualSignOffFor}, never recomputed here.
 */
export function prBody(
  task: Pick<
    Task,
    'externalDescription' | 'description' | 'externalSource' | 'externalKey' | 'ticketKey'
  >,
  provider: ForgeProvider,
  commits: readonly string[],
  signOff?: PrVisualSignOff,
): string {
  const changes = branchChangesBody(commits);
  // `externalDescription` FIRST, and it is not the obviously-named field: that is the one a
  // card's brief actually lives in — what the detail pane edits, what the agent's prompt
  // reads, and what `createTask` writes. `Task.description` is a STEP's brief, and a step
  // never opens its own pull request, so it is only a fallback for the shape where a card
  // somehow carries one. Read only when `changes` is empty — the branch's own commits beat
  // the card's description whenever there is something to summarise.
  const description = (task.externalDescription ?? task.description ?? '').trim();
  const wrapped = changes || (description ? wrapPlainText(description) : '');

  const key = (task.ticketKey ?? task.externalKey ?? '').trim();
  // A GitHub issue's key is `owner/repo#12`, which is a closing reference, not a ticket id.
  const isGitHubIssueRef =
    provider === 'github' && task.externalSource === 'github' && key.includes('#');
  const ticketId = key && !isGitHubIssueRef ? `Ticket ID: ${key}` : '';
  const closes = isGitHubIssueRef ? `Closes ${key}` : '';
  const testedValue = aggregateTested(commits);
  const commitWord = commits.length === 1 ? 'commit' : 'commits';
  const testedFallback =
    commits.length > 0
      ? `see this branch's ${commits.length} ${commitWord}, each already carrying its own ` +
        `test trailer per CONTRIBUTING.md.`
      : `see this branch's own commits, each already carrying its own test trailer per ` +
        `CONTRIBUTING.md.`;
  const tested = wrapHanging(`Tested: ${testedValue || testedFallback}`, 72, 8);

  const trailers = [ticketId, closes, tested].filter(Boolean).join('\n');
  return [wrapped, formatVisualSignOffSection(signOff), trailers].filter(Boolean).join('\n\n');
}

/**
 * The "Visual sign-off" section `prBody` inserts before the trailers — `''` when `signOff` is
 * absent or names no screens, which is the common case (a card `ui-shots.mjs` never shot).
 * Wrapped at 72 columns the same way the rest of the body is: the heading as a plain
 * paragraph, each screen as a `wrapPlainText`-style bullet.
 */
function formatVisualSignOffSection(signOff: PrVisualSignOff | undefined): string {
  if (!signOff || signOff.screens.length === 0) return '';
  const n = signOff.screens.length;
  const heading = wrapHanging(
    `Visual sign-off: ${n} screen${n === 1 ? '' : 's'} compared - review them on ` +
      `${signOff.cardKey} in VIPPER before merging.`,
    72,
    0,
  );
  const bullets = signOff.screens.map((s) =>
    wrapHanging(`- ${s.name}${s.verdict ? `: ${s.verdict}` : ''}`, 72, 2),
  );
  return [heading, ...bullets].join('\n');
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
  /** The head commit the forge reported at create (or already-open) time, when it said. */
  headSha?: string | null;
  existed: boolean;
  /**
   * The forge's own `updated_at` for the created (or already-open) row, or 0 when it did not
   * say. This is what `rowFor` stamps the stored row's `updatedAt` with, and it has to be
   * the FORGE's clock rather than the APP's: `needsDetailRefresh` decides a PR is worth
   * re-reading by asking whether the next sync's `updated_at` is newer than what is stored,
   * and the app's `Date.now()` — taken after the push and the create call both round-tripped
   * — routinely reads later than GitHub's own timestamp for the same event. A row seeded
   * ahead of the forge's clock looks already-current on the very next sync and never gets
   * its first real detail read, so `pipelineStatus` stays `unknown` and `approvalsRequired`
   * stays `null` until something else bumps `updated_at`.
   */
  updatedAt: number;
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
    headSha: pullRequest.head?.sha ?? null,
    existed,
    updatedAt: Date.parse(pullRequest.updated_at ?? '') || 0,
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
    headSha: mergeRequest.sha ?? null,
    existed,
    updatedAt: Date.parse(mergeRequest.updated_at) || 0,
  };
}

/**
 * The stored row for a freshly opened PR.
 *
 * Three things are deliberate. The **id** comes from the same builders the syncs use
 * (`pullRequestId` / `mergeRequestId`), so the next reconcile pass recognises this row as
 * the one it is about to refresh rather than filing a duplicate beside it. Every field we did
 * not just learn takes its **honest empty value** — `pipelineStatus: 'unknown'`,
 * `approvalsRequired: null`, `pipelineStages: []` — because the interface's own comments are
 * explicit that these must not be confidently wrong: a `0` required-approvals on a fresh PR
 * would render as "no approval needed", and a `success` pipeline as a green tick on a
 * pipeline that has not started.
 *
 * And **`openedForTaskId`**, which is what keeps the row on the card. `taskId` alone does
 * not: every sync rebuilds it from the keys it can find in the pull request's own text, and
 * a card with no tracker key — or a GitHub card, whose key goes in the body as a closing
 * reference — supplies nothing to find. The row was appearing the moment the button was
 * pressed and dropping off the card on the very next poll, still open and belonging to
 * nobody. This is the one thing about it the forge cannot tell us, so it is remembered.
 *
 * `updatedAt` is `created.updatedAt` — the forge's own clock — rather than `now`, which is
 * the app's; see {@link CreatedRef.updatedAt} for why seeding it from the wrong clock leaves
 * a freshly opened row unread forever. `syncedAt` stays `now`: that field really does mean
 * "when we looked", and we looked now.
 */
export function rowFor(created: CreatedRef, taskId: string, now: number): MergeRequest {
  return {
    id:
      created.provider === 'github'
        ? pullRequestId(created.repoId, created.number)
        : mergeRequestId(created.repoId, created.number),
    taskId,
    openedForTaskId: taskId,
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
    headSha: created.headSha ?? null,
    // Never acted on — the watcher has not even seen this row yet.
    lastActedSha: null,
    lastActedAction: null,
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
    updatedAt: created.updatedAt,
    syncedAt: now,
  };
}
