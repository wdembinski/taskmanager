/**
 * Worktree manager (team-orchestrator feature).
 *
 * Gives each task its own **git worktree on its own branch** so parallel agents
 * never share a working tree, then integrates a finished branch back into the base
 * (rebase onto latest base → fast-forward → remove the worktree). All git sequencing
 * lives here so `scheduler.ts` only deals in high-level results.
 *
 * The base is `Project.baseBranch` when the project names one, and otherwise whatever
 * the main checkout has out. That distinction reaches all the way into HOW the final
 * fast-forward happens: a base that is checked out has to be merged in the work tree
 * (and so must refuse a dirty one), while a base that isn't is advanced as a bare ref
 * move that no working file can block. See {@link WorktreeManager.fastForward}.
 *
 * Integration is **serialized per project** (a promise chain) so two tasks that
 * finish together can't race each other into the base branch.
 *
 * Non-git projects (or projects with worktrees disabled) transparently fall back to
 * the shared-directory behavior, which keeps existing setups working unchanged.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project, Task } from '@shared/model';
import { hostFor, hostJoin, type ExecHost } from './exec';
import {
  abortRebase,
  addedInBranch,
  addWorktree,
  blobSha,
  branchExists,
  checkoutOurs,
  commitAll,
  commitsAhead,
  conflictedFiles,
  continueRebase,
  createRootCommit,
  currentBranch,
  deleteBranch,
  fastForwardRef,
  gitPreflight,
  hasCommits,
  hasConflicts,
  hasStagedChanges,
  isClean,
  isRepo,
  listBranches,
  listUntracked,
  mergeFfOnly,
  preserveUntracked,
  pruneWorktrees,
  rebaseOnto,
  removeUntracked,
  removeWorktree,
  restoreConflicted,
  skipRebase,
  stagePaths,
  workingFileSha,
} from './git';

/**
 * Purely additive text files that are safe to auto-merge with git's `union` driver during a
 * rebase (concatenate both sides instead of conflicting). Scoped to config/list files whose
 * ordering doesn't matter — never source. Code goes to the AI/human rungs instead; a lockfile
 * (and a `package.json` that conflicts only on its version) is handled a rung further down, by
 * {@link WorktreeManager.resolveMechanically} — union-concatenating a lockfile would produce a
 * file no package manager could read.
 */
const UNION_MERGE_FILES = ['.gitignore', 'pnpm-workspace.yaml', '.npmrc'];

/**
 * Lockfiles Rung 1.5 knows how to rebuild, and the command that rebuilds each one from
 * `package.json` ALONE — no `node_modules`, no lifecycle scripts. Which package manager a
 * project uses is read off the lockfile that conflicted, so there is no new setting to get
 * wrong and a repo with two of them resolves each correctly.
 */
const LOCKFILE_REGEN: ReadonlyMap<string, readonly string[]> = new Map([
  ['pnpm-lock.yaml', ['pnpm', 'install', '--lockfile-only']],
  ['package-lock.json', ['npm', 'install', '--package-lock-only']],
  ['yarn.lock', ['yarn', 'install', '--mode', 'update-lockfile']],
]);

/**
 * How long a lockfile rebuild may take before it is abandoned (and the conflict escalated as
 * though this rung had never run). Generous: the resolver talks to a registry, and a large
 * workspace is not quick. Bounded all the same — an integration must never hang on it.
 */
const LOCKFILE_REGEN_TIMEOUT_MS = 5 * 60_000;

/**
 * How many times the rebase may stop, be resolved mechanically, and be continued before we
 * stop trying. Every round consumes one commit of the branch, so this can only be reached by
 * a branch with more conflicting commits than anyone rebases by hand — and a bound is what
 * keeps a rung that drives `rebase --continue` in a loop from being able to spin.
 */
const MAX_MECHANICAL_ROUNDS = 20;

/**
 * How long to wait before retrying a worktree removal that git refused. Long enough for an
 * exiting process to release the directory it had as a cwd (the Windows case this exists
 * for), short enough that a merge never visibly stalls on it.
 */
const WORKTREE_REMOVE_RETRY_MS = 750;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Write an ephemeral gitattributes file declaring `merge=union` for {@link UNION_MERGE_FILES},
 * so a rebase can auto-resolve those additive files without mutating the target repo's own
 * `.gitattributes`. Returns the file path and a `cleanup` that removes its temp dir.
 */
function withUnionAttributes(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'orch-attrs-'));
  const file = join(dir, 'attributes');
  writeFileSync(file, UNION_MERGE_FILES.map((f) => `${f} merge=union`).join('\n') + '\n');
  return {
    file,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

// Conflict markers, matched at the start of a line. `|||||||` only appears under the `diff3`
// conflict styles; it is recognised (and its section discarded) so the parser below doesn't
// depend on the human's `merge.conflictStyle`.
const MARK_OURS = /^<{7}(?:\s|$)/;
const MARK_ORIGINAL = /^\|{7}(?:\s|$)/;
const MARK_SPLIT = /^={7}(?:\s|$)/;
const MARK_THEIRS = /^>{7}(?:\s|$)/;

/** A `"version": "1.2.3"` entry, with or without its trailing comma. Nothing else. */
const VERSION_LINE = /^"version"\s*:\s*"[^"]*"\s*,?$/;

/**
 * Resolve a conflicted `package.json` by taking BASE's side of every conflict — but ONLY when
 * every conflict is inside the `version` field. Returns the resolved text, or `null` when
 * anything else conflicted, in which case the caller must leave the file alone.
 *
 * This is the one `package.json` collision with an answer that needs no judgement: a release
 * bumped the version on base while the branch was out, so base's number is by definition the
 * newer one and the branch's is a stale copy of what base used to say. Any *other* hunk —
 * a dependency, a script, an export map — is a real disagreement about the project and
 * belongs to a rung that can read the code.
 *
 * Deliberately a text operation, not a JSON round-trip: reformatting a file the human owns
 * (key order, indentation, trailing newline) to resolve one line would be its own diff.
 */
export function resolveVersionOnlyConflict(text: string): string | null {
  const lines = text.split('\n');
  const out: string[] = [];
  let hunks = 0;

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!MARK_OURS.test(line)) {
      // A closing marker with nothing open means this file is not shaped the way git writes
      // one. Guessing at it is exactly what this rung must not do.
      if (MARK_ORIGINAL.test(line) || MARK_SPLIT.test(line) || MARK_THEIRS.test(line)) return null;
      out.push(line);
      i++;
      continue;
    }

    i++;
    const ours: string[] = [];
    const theirs: string[] = [];
    let side: 'ours' | 'original' | 'theirs' = 'ours';
    let closed = false;
    for (; i < lines.length; i++) {
      const l = lines[i];
      if (MARK_OURS.test(l)) return null; // nested markers: not ours to interpret
      if (MARK_ORIGINAL.test(l)) {
        if (side !== 'ours') return null;
        side = 'original';
      } else if (MARK_SPLIT.test(l)) {
        if (side === 'theirs') return null;
        side = 'theirs';
      } else if (MARK_THEIRS.test(l)) {
        closed = true;
        i++;
        break;
      } else if (side === 'ours') {
        ours.push(l);
      } else if (side === 'theirs') {
        theirs.push(l);
      }
      // The `original` section is the common ancestor git prints for context — never part of
      // a resolution, but its contents still have to pass the version-only test below, or a
      // hunk that merely *mentions* a version would qualify on the strength of its ancestor.
    }
    if (!closed) return null;
    // BOTH sides, so "the branch replaced the version block with something else" cannot pass.
    if (![...ours, ...theirs].every(isVersionOnly)) return null;
    hunks++;
    out.push(...ours); // ours == base, because a rebase replays the branch ON TOP of base
  }

  // No markers at all in a file git calls conflicted: something else is going on (a binary
  // merge, a custom driver). Escalate rather than "resolve" it into a no-op.
  return hunks > 0 ? out.join('\n') : null;
}

/** True for a line that is only a `version` entry (or blank) — the test the hunks must pass. */
function isVersionOnly(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || VERSION_LINE.test(trimmed);
}

/** Split a git-reported path (always `/`-separated) into its directory and file name. */
function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1
    ? { dir: '', name: path }
    : { dir: path.slice(0, slash), name: path.slice(slash + 1) };
}

/**
 * Where a task's agent should run, and (in worktree mode) how to integrate it.
 *   - `worktree`: isolated branch/worktree the orchestrator integrates back into base.
 *   - `shared`  : run in the project dir (non-repo or worktrees disabled).
 *   - `failed`  : a worktree-enabled repo whose isolation couldn't be created — we refuse
 *                 to fall back to the base tree (that would pollute it with uncommitted work).
 */
export type WorktreePrep =
  | {
      mode: 'worktree';
      cwd: string;
      branch: string;
      base: string;
      /**
       * Something preparation had to CHANGE in the base repo to make the run possible (today:
       * born an unborn HEAD). The run proceeds, but a write to the human's repo that they did
       * not ask for has to appear in the task's activity rather than only in git's reflog.
       */
      note?: string;
    }
  | { mode: 'shared'; cwd: string }
  | { mode: 'failed'; reason: string };

/** A prep result the agent can actually launch in (everything except `failed`). */
export type LaunchTarget = Exclude<WorktreePrep, { mode: 'failed' }>;

/**
 * Untracked base-tree files that differed from the incoming branch and were stashed aside
 * (not lost) so the fast-forward could proceed. Surfaced to the human so they can restore them.
 */
export interface PreservedSnapshot {
  stashRef: string;
  files: string[];
}

/** The outcome of integrating a task's branch back into base. */
export type IntegrationResult =
  | {
      status: 'merged';
      preserved?: PreservedSnapshot;
      /**
       * The merge moved the `base` REF without touching the main checkout, because that
       * checkout is sitting on some other branch. True of every project that names an
       * integration branch it doesn't keep checked out.
       *
       * It matters to anything that then wants to *use* the merged code in `project.path`
       * — an auto-release above all, which would otherwise cut a release from whatever
       * branch happened to be checked out there (see `scheduler.startReleaseRun`).
       */
      refMoveOnly?: boolean;
      /**
       * The merge landed but the worktree could not be deleted afterwards, and this names
       * what is left on disk. Windows holds a directory open while any process has it as a
       * cwd, so a run whose CLI is still exiting can lose the race with its own cleanup.
       *
       * Reported, never retried into a failure: the merge SUCCEEDED, and re-running it is
       * exactly the loop this field exists to make impossible. A leftover directory that is
       * named on the timeline can be dealt with; a silent one poisons the next run instead.
       */
      cleanupFailed?: string;
      /**
       * Files the rebase conflicted on that were resolved WITHOUT an agent (Rung 1.5): a
       * regenerated lockfile, a `package.json` whose only conflict was a release bump.
       *
       * Reported because it is a write into the human's branch that nobody asked for. The
       * merge succeeded either way, so this is a note and never a problem.
       */
      autoResolved?: string[];
    }
  /**
   * There was nothing to land, so no merge was attempted: the branch is already contained
   * in base (it merged before), or it no longer exists, or the worktree is not a repo.
   *
   * Deliberately NOT an `error`. An error parks the card and offers a Retry that re-runs
   * the identical impossible merge — which is precisely how a card that had already merged
   * successfully ended up stuck in the inbox. Nothing is wrong here, so nothing is asked of
   * the human: the timeline says why, and the card stays where it was.
   */
  | { status: 'nothing-to-merge'; branch: string; base: string; reason: string }
  /** Rebase left conflicts; the worktree is paused mid-rebase for resolution. */
  | { status: 'conflict'; worktree: string; branch: string; base: string }
  /** The base working tree has uncommitted changes, so we won't fast-forward it. */
  | { status: 'dirty-base'; base: string }
  /**
   * The base work tree has untracked files that (a) collide with files this branch adds and
   * (b) we couldn't safely preserve, so we refused to overwrite them. `files` names them.
   */
  | { status: 'blocked-untracked'; base: string; files: string[] }
  | { status: 'error'; message: string };

/**
 * The LEGACY branch name for a task, namespaced so orchestrator branches are recognizable.
 *
 * Superseded by the named branches of Phase 17 (`branchName.ts`), but kept as the fallback
 * for any card assigned before those existed (`Task.agentBranch === null`) — its worktree
 * is already checked out on this name, and renaming it out from under a live run would
 * orphan the work.
 */
export function taskBranch(taskId: string): string {
  return `orch/${taskId}`;
}

export class WorktreeManager {
  /** Per-project promise chain, so integrations run one at a time per project. */
  private readonly chains = new Map<string, Promise<unknown>>();

  /** Resolved worktree roots inside each distro, so `$HOME` is probed once. */
  private readonly wslRoots = new Map<string, string>();

  /** @param localRoot Where worktrees go for local projects (e.g. userData/worktrees). */
  constructor(private readonly localRoot: string) {}

  /**
   * The host a project's git runs on, and where its worktrees live.
   *
   * A WSL project's worktrees must live INSIDE the distro: a Linux `git` cannot
   * sanely own a worktree of an ext4 repo that sits on the Windows side of a 9p
   * share, and the path it records would be meaningless to the other machine.
   */
  private async workspaceFor(project: Project): Promise<{ host: ExecHost; root: string }> {
    const host = hostFor(project.target);
    if (project.target.kind !== 'wsl') return { host, root: this.localRoot };

    const { distro } = project.target;
    let root = this.wslRoots.get(distro);
    if (!root) {
      root = hostJoin(await host.homeDir(), '.local', 'share', 'claude-orchestrator', 'worktrees');
      this.wslRoots.set(distro, root);
    }
    return { host, root };
  }

  /**
   * Deterministic worktree path for a task, so a resumed run reuses it. Joined in
   * the HOST's shape — `node:path.join` would build `\` separators for a Linux path.
   */
  private pathIn(root: string, projectId: string, taskId: string): string {
    return hostJoin(root, projectId, taskId);
  }

  /**
   * Decide where a task should run. In worktree mode, ensure the task's worktree
   * exists (creating it off the current base branch on first run) and return it;
   * non-repo / worktrees-disabled projects run in the shared project directory.
   *
   * A worktree-*enabled* repo whose isolation can't be created is reported as `failed`
   * rather than silently degraded to the shared dir: running an agent in the base tree is
   * exactly how it accumulates uncommitted scaffold that later blocks every integration.
   *
   * `ownerTaskId` is the task the worktree BELONGS to, which is normally the task being
   * run. The plan-driven subtasks feature (Phase 11) is the exception: every step of a
   * plan runs in its parent's worktree on the parent's branch, so the whole chain
   * accumulates on one branch and integrates once — the caller passes the parent's id.
   *
   * `branchName` (Phase 17) is the human-chosen branch. Omitted falls back to the legacy
   * {@link taskBranch}, so an un-migrated card keeps the name its worktree already has.
   *
   * `startPoint` is what a `stacked` chain link needs (see `@shared/taskChain`): the new
   * branch is cut from the PREDECESSOR's branch, so this card starts with that card's
   * commits already in its tree. It affects the `git worktree add` start-point and nothing
   * else — the returned `base` is still the project's integration branch, so where this
   * card eventually merges is unchanged. Ignored for a worktree that already exists, which
   * has a start point by definition.
   */
  async prepare(
    project: Project,
    task: Task,
    ownerTaskId = task.id,
    branchName?: string,
    startPoint?: string,
  ): Promise<WorktreePrep> {
    const { host, root } = await this.workspaceFor(project);
    if (!project.useWorktrees || !(await isRepo(project.path, host))) {
      return { mode: 'shared', cwd: project.path };
    }

    // An UNBORN repo (`git init`, no commit yet) is a work tree with no commit to branch from,
    // so `git worktree add` cannot possibly succeed here — and every failure button the human
    // is then offered (Retry, Retry fresh, AI fix) re-runs the identical impossible command.
    // Born it instead: one empty root commit, which touches none of their files. See
    // `createRootCommit`. Only if that fails do we park the task, naming the real cause.
    let note: string | undefined;
    if (!(await hasCommits(project.path, host))) {
      const born = await createRootCommit(project.path, host);
      if (born.code !== 0) {
        return {
          mode: 'failed',
          reason:
            `The repo at ${project.path} has no commits yet, so there is nothing for this ` +
            `task's branch to start from, and creating an empty first commit failed: ` +
            `${born.stderr.trim() || 'git commit failed'}. Make one commit in that repo ` +
            `(\`git commit --allow-empty -m "Initial commit"\`) and retry. The task was not ` +
            `run, so nothing was written to the base tree.`,
        };
      }
      note =
        `The repo at ${project.path} had no commits, so this task had nothing to branch ` +
        `from. Created an empty \`Initial commit\` on \`${await currentBranch(project.path, host)}\` ` +
        `to start the history — no files were added to it.`;
    }

    // The project may NAME its integration branch, in which case the checkout's wandering
    // HEAD is none of this task's business. An unnamed base still means "whatever is
    // checked out", exactly as before.
    const configured = project.baseBranch?.trim() ?? '';
    if (configured && !(await branchExists(project.path, configured, host))) {
      const known = await listBranches(project.path, host);
      return {
        mode: 'failed',
        reason:
          `This project's base branch is set to "${configured}", but no such branch exists in ` +
          `${project.path}, so there is nothing for this task to branch from or merge back ` +
          `into. ${
            known.length > 0
              ? `The repo has: ${known.join(', ')}.`
              : 'The repo has no local branches.'
          } Fix it in the project's settings. The task was not run.`,
      };
    }

    const base = configured || (await currentBranch(project.path, host));
    // `currentBranch` reports its own failure as `''`, and an empty string handed to git as a
    // start-point becomes `fatal: not a valid object name: ''` — a message that sends the human
    // looking at the branch name. Refuse to shell out with it and say what actually happened.
    if (!base) {
      return {
        mode: 'failed',
        reason:
          `Couldn't read the current branch of ${project.path}, so this task has no base to ` +
          `branch from. The repo is in a state git won't report a HEAD for — check ` +
          `\`git -C "${project.path}" status\` (a half-finished rebase/merge or a broken HEAD ` +
          `does this), or name the branch to build on in the project's settings. The task was ` +
          `not run in the base tree.`,
      };
    }
    const branch = branchName?.trim() || taskBranch(ownerTaskId);
    const cwd = this.pathIn(root, project.id, ownerTaskId);
    // `existsSync` runs on the APP's filesystem, so a distro path has to be named the
    // way Windows can see it (`\\wsl.localhost\…`) before it can be checked.
    //
    // Existing is NOT the same as being a worktree, and treating it as such is what let a
    // card try to merge a branch its own successful merge had already deleted: cleanup
    // removed `.git` and then died on a locked `node_modules`, and every later run was
    // handed the leftovers as though they were live. One `isRepo` call settles it.
    if (existsSync(host.toApp(cwd)) && (await isRepo(cwd, host))) {
      // The worktree is already checked out on SOME branch, and if the card was renamed
      // after it was created that is not the name we were just handed. Returning the
      // requested name would be a lie the integration step then acts on, so read the real
      // one — a single git call on a path that already shells out several times.
      //
      // Past `isRepo`, an empty answer is a real anomaly rather than the ordinary "no
      // worktree yet", so it must not fall back to the name we were asked for — that
      // fallback is the exact shape of the bug above.
      const actual = await currentBranch(cwd, host);
      if (!actual) {
        return {
          mode: 'failed',
          reason:
            `The worktree at ${cwd} is a git repository but git won't say which branch it ` +
            `has checked out, so this task has no branch to work on or merge back. Check ` +
            `\`git -C "${cwd}" status\` (a half-finished rebase or a broken HEAD does this). ` +
            `The task was not run in the base tree (${project.path}) to avoid polluting it.`,
        };
      }
      return { mode: 'worktree', cwd, branch: actual, base };
    }

    // The directory is there but git does not recognise it: debris from a cleanup that
    // half-finished. Clear it so the worktree can be rebuilt below.
    //
    // Safe by construction, which is the only reason this deletes anything: `integrate`
    // commits everything in the worktree (`commitAll`) BEFORE it merges, and cleanup only
    // runs after that merge succeeded. So whatever is left in a directory git has stopped
    // tracking was already committed and already landed — there is nothing here that git
    // ever held and could still lose.
    if (existsSync(host.toApp(cwd))) {
      const why = await gitPreflight(cwd, host);
      if (why.state !== 'not-a-repo') {
        // git itself could not be run (not installed, distro down). That is not the
        // directory's fault, and deleting a work tree on the strength of an answer we
        // never got is how real work disappears. Refuse instead.
        return {
          mode: 'failed',
          reason:
            `Couldn't tell whether the worktree at ${cwd} is still a git repository: ` +
            `${why.state === 'unknown' ? why.detail : why.state}. Nothing was deleted and ` +
            `the task was not run — fix git for that path and retry.`,
        };
      }
      // Retried, for exactly the reason the directory is in this state at all: what
      // half-deleted it was a Windows lock on `node_modules`, and a lock held by an exiting
      // process is usually gone a moment later. `removeWorktreeChecked` next door already
      // retries; a single attempt here left a card parked on `ENOTEMPTY` while the git path
      // beside it would have recovered.
      const removed = await this.removeDebris(host.toApp(cwd));
      if (removed) {
        return {
          mode: 'failed',
          reason:
            `The worktree at ${cwd} is no longer a git repository — a previous cleanup left ` +
            `it half-deleted — and it could not be removed to rebuild it: ${removed}. Delete ` +
            `that directory and retry. The task was not run in the base tree ` +
            `(${project.path}) to avoid polluting it.`,
        };
      }
      // A write outside the task's own worktree belongs on the timeline, exactly like the
      // unborn-HEAD repair above — it explains where a directory went.
      note =
        `${note ? `${note} ` : ''}The worktree at ${cwd} was left half-deleted by an earlier ` +
        `cleanup (its \`.git\` was gone), so it was removed and rebuilt. Nothing was lost: a ` +
        `worktree is only ever cleaned up after its work has been committed and merged.`;
      // git may still hold an admin record pointing at the path we just removed, which
      // would make `worktree add` refuse. `prepare`'s own prune-and-retry below covers it.
    }

    // A `stacked` chain link asks for this branch to be cut from another card's, not from
    // base. A start point that no longer exists falls back to `base` in silence, and that
    // is the right answer rather than a failure: the commonest way for it to go missing is
    // the predecessor merging and its branch being deleted — by which time its work IS in
    // base, so base gives this card exactly what the link asked for.
    const wanted = startPoint?.trim() ?? '';
    const from =
      wanted && wanted !== base && (await branchExists(project.path, wanted, host)) ? wanted : base;
    if (from !== base) {
      // The one place that knows what the start point turned out to be, so it is also the
      // only place that can say it truthfully on the card's timeline.
      note =
        `${note ? `${note} ` : ''}This task's branch "${branch}" was cut from "${from}" rather ` +
        `than from ${base}, because its chain stacks it on that branch — it starts with that ` +
        `work already in it, and still merges back into ${base}.`;
    }

    let res = await addWorktree(project.path, cwd, branch, from, host);
    if (res.code !== 0) {
      // One recovery attempt: a stale worktree admin record (e.g. a dir removed out of
      // band) can block re-creation. Prune, then retry once.
      await pruneWorktrees(project.path, host);
      res = await addWorktree(project.path, cwd, branch, from, host);
    }
    if (res.code !== 0) {
      return {
        mode: 'failed',
        reason:
          `Couldn't create an isolated git worktree for this task at ${cwd}: ` +
          `${res.stderr.trim() || 'git worktree add failed'}. The task was not run in the base ` +
          `tree (${project.path}) to avoid polluting it. Fix the git state and retry.`,
      };
    }
    return { mode: 'worktree', cwd, branch, base, note };
  }

  /**
   * Integrate a finished task's branch back into base: safety-commit anything the
   * agent left, rebase onto the latest base, then fast-forward base to it and remove
   * the worktree. Serialized per project. See IntegrationResult for the outcomes.
   *
   * Refuses up front when there is nothing to land (see `nothing-to-merge`). Every caller
   * fires this without knowing whether a merge is owed — `settle` runs it for any finished
   * worktree run including a chat reply, and the Merge button rebuilds its context from
   * facts on disk — so "is there work here?" has to be answered HERE, once, rather than by
   * each caller guessing.
   */
  integrate(
    project: Project,
    branch: string,
    base: string,
    worktree: string,
    commitMessage: string,
  ): Promise<IntegrationResult> {
    return this.enqueue(project.id, async () => {
      const { host } = await this.workspaceFor(project);

      // Checked BEFORE `commitAll`, which would otherwise shell out into a directory that
      // is not a repo and report its failure as a bare "not a git repository" — the message
      // that sent a human looking for a broken project rather than a finished merge.
      if (!(await isRepo(worktree, host))) {
        return {
          status: 'nothing-to-merge',
          branch,
          base,
          reason:
            `the worktree at ${worktree} is no longer a git repository, which is what a ` +
            `worktree looks like after its branch has been merged and cleaned up`,
        };
      }
      if (!(await branchExists(project.path, branch, host))) {
        return {
          status: 'nothing-to-merge',
          branch,
          base,
          reason:
            `branch "${branch}" no longer exists in ${project.path} — it is deleted as the ` +
            `last step of a successful merge, so its work is already in ${base}`,
        };
      }

      // AFTER `commitAll`, and that order matters: a run that left work uncommitted has
      // something to land, and asking before the safety commit would call it empty.
      await commitAll(worktree, commitMessage, host);
      const ahead = await commitsAhead(worktree, base, branch, host);
      if (ahead === 0) {
        return {
          status: 'nothing-to-merge',
          branch,
          base,
          reason:
            `branch "${branch}" has no commits that ${base} does not already have, so there ` +
            `is nothing for a merge to move`,
        };
      }

      // Rung 1 (mechanical): rebase with union merge for additive config files, so
      // `.gitignore`/workspace-list churn auto-resolves instead of conflicting.
      const attrs = withUnionAttributes();
      // The attributes file is written on the app's filesystem, so git must be told
      // the name its OWN machine knows it by.
      const attrsPath = host.toNative(attrs.file);
      try {
        let rebased = await rebaseOnto(worktree, base, attrsPath, host);

        // Rung 1.5 (mechanical, scripted): a conflict git's merge drivers can't touch but
        // that still has ONE right answer nobody needs to read code to find — a lockfile, a
        // version line a release bumped. Resolving it here is worth a rung of its own because
        // the alternative is Rung 2, and Rung 2 costs a whole agent session to run a command
        // this can run itself. Lockfile collisions are far and away the commonest thing
        // parallel worktrees conflict on.
        //
        // Looped, because a rebase stops once per conflicting COMMIT: resolving the first one
        // and handing the second to an agent would spend the session this rung exists to save.
        // Each round consumes one commit, so the bound can only be hit by a pathological branch.
        const autoResolved: string[] = [];
        for (let round = 0; rebased.code !== 0 && round < MAX_MECHANICAL_ROUNDS; round++) {
          if (!(await hasConflicts(worktree, host))) break;
          const fixed = await this.resolveMechanically(worktree, host);
          // `null` = something here needs judgement. The work tree is exactly as git left it
          // (see `resolveMechanically`), so the AI/human rung below gets the real conflict —
          // never a tree this rung had already half-resolved and made to look clean.
          if (!fixed) break;
          autoResolved.push(...fixed);
          // A resolution that reproduces what base already has empties the patch, and
          // `--continue` refuses an empty one. That commit's content IS in base, so skipping
          // is not a loss — it is the same outcome the rebase would have reached alone.
          rebased = (await hasStagedChanges(worktree, host))
            ? await continueRebase(worktree, attrsPath, host)
            : await skipRebase(worktree, host);
        }

        // Anything still conflicted is a real conflict → `conflict`, for the AI/human rungs.
        if (rebased.code !== 0) {
          if (await hasConflicts(worktree, host)) {
            return { status: 'conflict', worktree, branch, base };
          }
          await abortRebase(worktree, host);
          return { status: 'error', message: rebased.stderr || 'rebase failed' };
        }
        const done = await this.fastForward(project, branch, base, worktree);
        if (done.status !== 'merged' || autoResolved.length === 0) return done;
        return { ...done, autoResolved: [...new Set(autoResolved)] };
      } finally {
        attrs.cleanup();
      }
    });
  }

  /**
   * Finish integration after a human (or agent) resolved a rebase conflict in the
   * worktree: continue the rebase if one is still in progress, then fast-forward.
   */
  finishAfterConflict(
    project: Project,
    branch: string,
    base: string,
    worktree: string,
  ): Promise<IntegrationResult> {
    return this.enqueue(project.id, async () => {
      const { host } = await this.workspaceFor(project);
      if (await hasConflicts(worktree, host)) return { status: 'conflict', worktree, branch, base };
      // If a rebase is still open (conflicts were staged but not continued), continue it
      // (union attrs so later patches' additive files still auto-merge); a "no rebase in
      // progress" error is fine — it means they finished already.
      const attrs = withUnionAttributes();
      try {
        await continueRebase(worktree, host.toNative(attrs.file), host);
      } finally {
        attrs.cleanup();
      }
      if (await hasConflicts(worktree, host)) return { status: 'conflict', worktree, branch, base };
      return this.fastForward(project, branch, base, worktree);
    });
  }

  /** Remove a task's worktree (best effort) — used when cleaning up a failed task. */
  async cleanup(project: Project, taskId: string): Promise<void> {
    const { host, root } = await this.workspaceFor(project);
    const cwd = this.pathIn(root, project.id, taskId);
    if (existsSync(host.toApp(cwd))) await this.removeWorktreeChecked(project, cwd, host);
  }

  /**
   * Delete a directory git has stopped recognising, retrying once. Returns null on success,
   * or git-free filesystem error text.
   *
   * Separate from {@link removeWorktreeChecked} because there is no worktree left to ask git
   * to remove — the admin record went with the `.git` file — so this is a plain `rm -rf`.
   * The retry is the shared part, and it is the point: the lock that produces this state is
   * held by a process on its way out.
   */
  private async removeDebris(appPath: string): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        rmSync(appPath, { recursive: true, force: true });
        return null;
      } catch (err) {
        if (attempt === 1) return (err as Error).message ?? String(err);
        await delay(WORKTREE_REMOVE_RETRY_MS);
      }
    }
    return null;
  }

  /**
   * Remove a worktree, and say so when it doesn't work. Returns null on success, or a
   * sentence naming what is left behind.
   *
   * Every call site used to discard `removeWorktree`'s exit code, and the one time it
   * mattered it mattered a lot: on Windows a directory cannot be deleted while any process
   * holds it as a cwd, so a run whose CLI was still exiting lost the race with its own
   * cleanup. Git got as far as `.git` and stopped, and every later run was handed the
   * remains as a live worktree. Hence the retry — the lock is held by something on its way
   * out, so a moment later it is usually gone — and hence the message when it isn't.
   */
  private async removeWorktreeChecked(
    project: Project,
    worktree: string,
    host: ExecHost,
  ): Promise<string | null> {
    let res = await removeWorktree(project.path, worktree, host);
    if (res.code !== 0) {
      await delay(WORKTREE_REMOVE_RETRY_MS);
      res = await removeWorktree(project.path, worktree, host);
    }
    if (res.code === 0) return null;
    const why = res.stderr.trim() || 'git worktree remove failed';
    return (
      `the worktree at ${worktree} could not be removed (${why}), so it is still on disk. ` +
      `Nothing depends on it — delete it when convenient.`
    );
  }

  /**
   * What a task's worktree and branch ARE on disk right now, or null if there is no live
   * pair to merge. Creates nothing, deletes nothing, repairs nothing.
   *
   * This exists because the Merge button needs to answer "is there a branch here?" and the
   * only thing that could answer it was `prepare` — which is a *mutating* call. Asking it
   * on a card whose branch had already merged rebuilt the worktree and re-created the
   * deleted branch, so pressing Merge on finished work manufactured the very thing it was
   * about to report as empty. Reading and preparing are different questions.
   */
  async inspect(
    project: Project,
    ownerTaskId: string,
    branchName?: string,
  ): Promise<{ cwd: string; branch: string; base: string } | null> {
    const { host, root } = await this.workspaceFor(project);
    if (!project.useWorktrees || !(await isRepo(project.path, host))) return null;
    const cwd = this.pathIn(root, project.id, ownerTaskId);
    if (!existsSync(host.toApp(cwd)) || !(await isRepo(cwd, host))) return null;
    // The worktree's own HEAD outranks the name we were handed: a card renamed after its
    // worktree was made carries a branch name that was never checked out anywhere.
    const branch =
      (await currentBranch(cwd, host)) || branchName?.trim() || taskBranch(ownerTaskId);
    if (!(await branchExists(project.path, branch, host))) return null;
    const base = project.baseBranch?.trim() || (await currentBranch(project.path, host));
    return base ? { cwd, branch, base } : null;
  }

  /** The work-tree paths currently in conflict (for the human/AI conflict-fix prompt). */
  async listConflicts(project: Project, worktree: string): Promise<string[]> {
    const { host } = await this.workspaceFor(project);
    return conflictedFiles(worktree, host);
  }

  /**
   * Rung 1.5: resolve the conflicts a rebase is stopped on WITHOUT an agent, or touch nothing.
   *
   * Returns the paths it resolved and staged, or `null` — and `null` means the work tree is
   * byte-for-byte as git left it, conflict markers and all. That all-or-nothing contract is
   * the point of the whole method: a partially resolved tree handed to the AI rung looks
   * clean, so the agent stages what it finds, the orchestrator continues the rebase, and a
   * lockfile nobody ever regenerated lands in base. Hence the two phases below — every file
   * is *classified* before any file is *written*, and nothing is staged until every write
   * has succeeded.
   *
   * What it can answer, and nothing else:
   *   - a lockfile → take base's copy and rebuild it from the merged `package.json`
   *     ({@link LOCKFILE_REGEN}); the branch's copy is a resolution of a dependency graph
   *     that no longer exists, so merging its text is meaningless in a way editing it isn't.
   *   - a `package.json` whose only conflict is its `version` → base's number wins
   *     ({@link resolveVersionOnlyConflict}).
   */
  private async resolveMechanically(worktree: string, host: ExecHost): Promise<string[] | null> {
    const files = await conflictedFiles(worktree, host);
    if (files.length === 0) return null;

    // Phase 1 — classify. Reads only, so an unresolvable file found on the last path still
    // leaves the work tree exactly as it was.
    const locks: { path: string; command: readonly string[]; dir: string }[] = [];
    const rewrites: { path: string; text: string }[] = [];
    for (const path of files) {
      const { dir, name } = splitPath(path);
      const command = LOCKFILE_REGEN.get(name);
      if (command) {
        locks.push({ path, command, dir });
        continue;
      }
      if (name !== 'package.json') return null;
      const current = this.readWorktreeFile(worktree, path, host);
      const resolved = current === null ? null : resolveVersionOnlyConflict(current);
      if (resolved === null) return null;
      rewrites.push({ path, text: resolved });
    }

    // Phase 2 — write. Nothing is staged yet, so the index still holds git's unmerged stages
    // and `restoreConflicted` can put every marker back if any step below fails.
    const touched: string[] = [];
    const giveUp = async (): Promise<null> => {
      await restoreConflicted(worktree, touched, host);
      return null;
    };
    for (const { path, text } of rewrites) {
      try {
        writeFileSync(this.appPath(worktree, path, host), text);
      } catch {
        return giveUp();
      }
      touched.push(path);
    }
    for (const { path, command, dir } of locks) {
      const took = await checkoutOurs(worktree, [path], host);
      if (took.code !== 0) return giveUp();
      touched.push(path);
      // Run where the lockfile lives, not at the worktree root: that is the package manager's
      // own idea of the project, and a monorepo can hold more than one.
      const cwd = dir === '' ? worktree : hostJoin(worktree, ...dir.split('/'));
      const ran = await host.exec(cwd, command[0], [...command.slice(1)], {
        // Windows resolves `pnpm`/`npm`/`yarn` through a `.cmd` shim, which only a shell finds.
        resolveViaShell: true,
        timeoutMs: LOCKFILE_REGEN_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
      });
      // The package manager missing, offline, or unhappy with the manifest is not something
      // to paper over: escalate, and the AI rung runs it again with a human behind it.
      if (ran.code !== 0) return giveUp();
    }

    const staged = await stagePaths(worktree, touched, host);
    if (staged.code !== 0) return giveUp();
    return touched;
  }

  /** A work-tree-relative git path as a name THIS process can hand to `fs`. */
  private appPath(worktree: string, path: string, host: ExecHost): string {
    return host.toApp(hostJoin(worktree, ...path.split('/')));
  }

  /** Read a work-tree file, or null if it can't be read (binary/gone is not this rung's problem). */
  private readWorktreeFile(worktree: string, path: string, host: ExecHost): string | null {
    try {
      return readFileSync(this.appPath(worktree, path, host), 'utf8');
    } catch {
      return null;
    }
  }

  /** Advance base to the (already rebased) branch, then clean up the worktree. */
  private async fastForward(
    project: Project,
    branch: string,
    base: string,
    worktree: string,
  ): Promise<IntegrationResult> {
    const { host } = await this.workspaceFor(project);

    // Is `base` the branch the main checkout is sitting on? Only then does integrating it
    // mean writing files into that checkout — and only then can the human's uncommitted work
    // be at risk from it. When it isn't (they named an integration branch and are looking at
    // something else, or at a detached HEAD), the merge is a pure ref move: no file is
    // touched, so a dirty work tree is simply irrelevant and must not block anything.
    if ((await currentBranch(project.path, host)) !== base) {
      const advanced = await fastForwardRef(project.path, branch, base, host);
      if (advanced.code !== 0) {
        return {
          status: 'error',
          message:
            advanced.stderr.trim() ||
            `could not fast-forward "${base}" to "${branch}" in ${project.path}`,
        };
      }
      const leftover = await this.removeWorktreeChecked(project, worktree, host);
      await deleteBranch(project.path, branch, host);
      return { status: 'merged', refMoveOnly: true, cleanupFailed: leftover ?? undefined };
    }

    // Never fast-forward a base tree that has uncommitted *tracked* work — we'd risk the
    // user's changes. Park instead; they can commit/stash and retry.
    if (!(await isClean(project.path, host))) return { status: 'dirty-base', base };

    // A fast-forward checks out the branch's newly-added files; git refuses to clobber any
    // that already exist *untracked* in the base tree. Clear that path safely: exact dupes
    // are removed (the merge recreates identical bytes); files whose untracked content
    // differs are stashed aside (preserved, not lost) so the branch's version can win.
    const { identical, differing } = await classifyUntrackedCollisions(
      project.path,
      base,
      branch,
      host,
    );
    if (identical.length > 0) await removeUntracked(project.path, identical, host);
    let preserved: PreservedSnapshot | undefined;
    if (differing.length > 0) {
      const stash = await preserveUntracked(
        project.path,
        differing,
        `orch-preserve ${branch}`,
        host,
      );
      if (!stash.ok || !stash.stashRef) {
        // Couldn't preserve — do NOT force the merge over uncommitted content.
        return { status: 'blocked-untracked', base, files: differing };
      }
      preserved = { stashRef: stash.stashRef, files: stash.files };
    }

    const merged = await mergeFfOnly(project.path, branch, host);
    if (merged.code !== 0) return { status: 'error', message: merged.stderr || 'merge failed' };
    const leftover = await this.removeWorktreeChecked(project, worktree, host);
    await deleteBranch(project.path, branch, host);
    return { status: 'merged', preserved, cleanupFailed: leftover ?? undefined };
  }

  /** Run `fn` after any pending work for `key`, keeping a single chain per project. */
  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run regardless of the previous task's outcome
    this.chains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}

/**
 * Split the untracked files in `dir` that collide with files `branch` adds into those whose
 * content is *identical* to the branch's version (safe to drop — the merge recreates them) and
 * those that *differ* (must be preserved, never silently overwritten). Content is compared via
 * filter-aware hashes so autocrlf/`.gitattributes` normalization isn't mistaken for a difference.
 * On any uncertainty (a blob that can't be read/hashed) the file is treated as `differing`.
 */
export async function classifyUntrackedCollisions(
  dir: string,
  base: string,
  branch: string,
  host?: ExecHost,
): Promise<{ identical: string[]; differing: string[] }> {
  const added = new Set(await addedInBranch(dir, base, branch, host));
  const collisions = (await listUntracked(dir, host)).filter((f) => added.has(f));
  const identical: string[] = [];
  const differing: string[] = [];
  for (const path of collisions) {
    const [branchBlob, workingBlob] = await Promise.all([
      blobSha(dir, branch, path, host),
      workingFileSha(dir, path, host),
    ]);
    if (branchBlob !== '' && workingBlob !== '' && branchBlob === workingBlob) {
      identical.push(path);
    } else {
      differing.push(path);
    }
  }
  return { identical, differing };
}
