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
import type { GitResult } from './git';
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
  rebasingBranch,
  rebaseInProgress,
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

/**
 * How many directories a task's worktree may be tried at: the canonical one, then `-2`,
 * `-3`… . Each extra slot exists for one reason — the previous one is still on disk and
 * cannot be deleted (see {@link WorktreeManager.chooseBuildPath}) — so a project that has
 * reached the last of them has ten leftover directories the human has not dealt with, and
 * quietly making an eleventh would be hoarding rather than recovering.
 */
const MAX_WORKTREE_SLOTS = 10;

/**
 * What `rmSync` is allowed to do about a directory Windows is still holding: retry the
 * individual `rmdir`/`unlink` that failed, rather than abandoning the whole recursive walk
 * on the first `ENOTEMPTY`/`EBUSY`/`EPERM`. Node does this itself when asked, and asking is
 * strictly better than our own outer retry — that one restarts the entire traversal, so a
 * lock held on one file deep in `node_modules` costs a full re-walk of everything above it.
 */
const RM_RETRY = { maxRetries: 4, retryDelay: 200 } as const;

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
   *
   * `slot` is 0 for the canonical path and 1, 2… for the fallbacks below it; see
   * {@link WorktreeManager.candidatePaths} for why a task may need a second address.
   */
  private pathIn(root: string, projectId: string, taskId: string, slot = 0): string {
    return hostJoin(root, projectId, slot === 0 ? taskId : `${taskId}-${slot + 1}`);
  }

  /**
   * Every directory a task's worktree may live at, most-preferred first.
   *
   * There is more than one because a worktree's directory can OUTLIVE the worktree. Cleanup
   * after a successful merge deletes `.git` and then walks the tree, and on Windows anything
   * still holding a file inside it — an exiting CLI, a watcher, a virus scanner, most often
   * something under `node_modules` — stops that walk part-way. What is left is inert debris,
   * but it sits exactly where the next run's worktree has to go.
   *
   * That is the case this list exists for, and it is a case that ARRIVES with a new step: the
   * card's earlier steps merged, the merge cleaned up, the cleanup half-failed — and the step
   * added afterwards was the first thing to need the directory again. Refusing to run it
   * ("delete that directory and retry") asks the human to win a race against a lock they
   * cannot see, on behalf of work that has nothing to do with it.
   *
   * So preparation falls forward to `<taskId>-2`, `-3`… instead. Everything that READS a
   * task's worktree resolves it through this same list, so the fallback is not a second
   * address anyone has to know about — it is the same worktree, one door along.
   */
  private candidatePaths(root: string, projectId: string, taskId: string): string[] {
    return Array.from({ length: MAX_WORKTREE_SLOTS }, (_, slot) =>
      this.pathIn(root, projectId, taskId, slot),
    );
  }

  /**
   * The task's LIVE worktree — the first candidate that exists and that git still recognises
   * — or null when it has none. Reads only.
   *
   * Existing is not the same as being a worktree, and treating it as such is what let a card
   * try to merge a branch its own successful merge had already deleted: cleanup removed
   * `.git` and then died on a locked `node_modules`, and every later run was handed the
   * leftovers as though they were live. One `isRepo` call per candidate settles it.
   */
  private async findLive(paths: readonly string[], host: ExecHost): Promise<string | null> {
    for (const cwd of paths) {
      // `existsSync` runs on the APP's filesystem, so a distro path has to be named the
      // way Windows can see it (`\\wsl.localhost\…`) before it can be checked.
      if (existsSync(host.toApp(cwd)) && (await isRepo(cwd, host))) return cwd;
    }
    return null;
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
   *
   * `opts.resumingRebase` says this run IS the resolution of a rebase the orchestrator itself
   * paused — the conflict ladder's AI rung, or a human pressing Start while a merge conflict
   * is parked. It changes exactly one thing: the paused rebase is handed over rather than
   * cleared away. See {@link WorktreeManager.rescueDetached}.
   */
  async prepare(
    project: Project,
    task: Task,
    ownerTaskId = task.id,
    branchName?: string,
    startPoint?: string,
    opts?: { resumingRebase?: boolean },
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
    const paths = this.candidatePaths(root, project.id, ownerTaskId);
    const live = await this.findLive(paths, host);
    if (live) {
      // The worktree is already checked out on SOME branch, and if the card was renamed
      // after it was created that is not the name we were just handed. Returning the
      // requested name would be a lie the integration step then acts on, so read the real
      // one — a single git call on a path that already shells out several times.
      //
      // Past `isRepo`, an empty answer is a real anomaly rather than the ordinary "no
      // worktree yet", so it must not fall back to the name we were asked for — that
      // fallback is the exact shape of the bug `findLive` describes.
      //
      // A DETACHED head is empty here too (see `currentBranch`), and that is the case this
      // guard was always describing without catching: a worktree stranded mid-rebase used
      // to report its branch as the literal `HEAD`, which sailed past this check, ran a
      // whole step, and then merged nothing because no branch by that name exists. Refusing
      // costs one interrupted run; the alternative silently drops the work.
      const actual = await currentBranch(live, host);
      if (!actual) {
        const rescued = await this.rescueDetached(live, host, opts?.resumingRebase === true);
        if (rescued.branch === null) {
          return {
            mode: 'failed',
            reason: `${rescued.reason} The task was not run in the base tree (${project.path}) to avoid polluting it.`,
          };
        }
        if (rescued.note) note = `${note ? `${note} ` : ''}${rescued.note}`;
        return { mode: 'worktree', cwd: live, branch: rescued.branch, base, note };
      }
      return { mode: 'worktree', cwd: live, branch: actual, base, note };
    }

    // No live worktree, so one has to be built — and the only thing that can stand in the
    // way is a directory left over from a previous one.
    const chosen = await this.chooseBuildPath(paths, host, project.path);
    if ('reason' in chosen) return { mode: 'failed', reason: chosen.reason };
    const cwd = chosen.cwd;
    if (chosen.note) note = `${note ? `${note} ` : ''}${chosen.note}`;

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

      // A rebase already paused in this worktree is NOT ours to restart, and this is where
      // "Retry integration" used to become an unpressable button. `git rebase <base>` on top
      // of a paused one fails with *"there is already a rebase-merge directory"*; that failure
      // names no conflicted path, so the code below read it as "not a conflict, some other
      // error" and answered with `rebase --abort` — throwing away the very resolutions Rung 2's
      // agent (or the human) had just staged, and leaving the next press to repeat the cycle.
      //
      // Checked BEFORE the safety commit, which is the more dangerous half. `commitAll` is
      // `git add -A` and a commit; run mid-rebase it stages the conflict MARKERS and writes
      // them into history. That never surfaced only because the failure it led to ended in
      // the abort above, which threw the marker commit away with everything else — so fixing
      // the abort without fixing this would have merged `<<<<<<<` into the base branch.
      if (await rebaseInProgress(worktree, host)) {
        return this.continuePausedRebase(project, branch, base, worktree, host);
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
          if (!(await hasConflicts(worktree, host))) {
            // A rebase can stop with NOTHING left unmerged, and that is not an error either.
            // `rerere` replays a resolution this repo has recorded before, stages it, and git
            // still stops — so the tree is clean, the index is full, and all that is owed is
            // `--continue`. Reading a clean tree as "no conflict to fix" is what turned the
            // second and third presses of Retry into the same parked failure as the first: the
            // more times a branch had been rebased, the more reliably rerere made it
            // unmergeable. If no rebase is running at all, this really is some other failure.
            if (!(await rebaseInProgress(worktree, host))) break;
            rebased = await this.advancePausedRebase(worktree, attrsPath, host);
            continue;
          }
          const fixed = await this.resolveMechanically(worktree, host);
          // `null` = something here needs judgement. The work tree is exactly as git left it
          // (see `resolveMechanically`), so the AI/human rung below gets the real conflict —
          // never a tree this rung had already half-resolved and made to look clean.
          if (!fixed) break;
          autoResolved.push(...fixed);
          rebased = await this.advancePausedRebase(worktree, attrsPath, host);
        }

        // Anything still conflicted is a real conflict → `conflict`, for the AI/human rungs.
        if (rebased.code !== 0) {
          if (await hasConflicts(worktree, host)) {
            return { status: 'conflict', worktree, branch, base };
          }
          // Safe to abort: this rebase is one THIS call started, a few lines above — a rebase
          // that was already paused when we arrived never reaches here (it is handled before
          // the safety commit). Undoing our own is free; undoing somebody else's is how a
          // resolution gets thrown away.
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
   * Move a paused rebase on by one patch: continue it, or skip a patch that resolution
   * emptied.
   *
   * The two are told apart by the index, never by guessing. `--continue` refuses an empty
   * patch (*"No changes - did you forget to use 'git add'?"*), which is the shape a
   * resolution takes when it reproduces what base already has — that commit's content IS in
   * base, so skipping loses nothing and is the outcome the rebase would have reached alone.
   */
  private async advancePausedRebase(
    worktree: string,
    attrsPath: string,
    host: ExecHost,
  ): Promise<GitResult> {
    return (await hasStagedChanges(worktree, host))
      ? continueRebase(worktree, attrsPath, host)
      : skipRebase(worktree, host);
  }

  /**
   * Finish integration after a human (or agent) resolved a rebase conflict in the
   * worktree: drive the rebase to its end, then fast-forward.
   */
  finishAfterConflict(
    project: Project,
    branch: string,
    base: string,
    worktree: string,
  ): Promise<IntegrationResult> {
    return this.enqueue(project.id, async () => {
      const { host } = await this.workspaceFor(project);
      return this.continuePausedRebase(project, branch, base, worktree, host);
    });
  }

  /**
   * Drive a rebase that is already paused in `worktree` to its end, then fast-forward.
   *
   * The one path for every arrival at a paused rebase — the human answering *Resolved*, Rung
   * 2's agent run ending, and a plain re-`integrate` that found one waiting. Deliberately NOT
   * enqueued: `integrate` and `finishAfterConflict` are the enqueued entry points, and taking
   * the per-project lock twice would deadlock.
   *
   * Looped, because a rebase stops once per conflicting COMMIT and a branch with thirteen of
   * them stops thirteen times. Continuing exactly once and then fast-forwarding assumed the
   * caller would be back for each of the others; that held for the human answering *Resolved*,
   * and not for a stop this can settle by itself — a lockfile on the ninth commit, or one
   * `rerere` has already staged — which is now driven through here instead of costing a rung.
   */
  private async continuePausedRebase(
    project: Project,
    branch: string,
    base: string,
    worktree: string,
    host: ExecHost,
  ): Promise<IntegrationResult> {
    // Union attrs so later patches' additive files still auto-merge.
    const attrs = withUnionAttributes();
    const attrsPath = host.toNative(attrs.file);
    const autoResolved: string[] = [];
    try {
      for (let round = 0; round < MAX_MECHANICAL_ROUNDS; round++) {
        if (await hasConflicts(worktree, host)) {
          // Rung 1.5 still applies to the stops a resumed rebase runs into: a lockfile that
          // collides on the ninth commit is no more worth an agent session than one that
          // collides on the first. `null` means this one needs judgement — up the ladder.
          const fixed = await this.resolveMechanically(worktree, host);
          if (!fixed) return { status: 'conflict', worktree, branch, base };
          autoResolved.push(...fixed);
        } else if (!(await rebaseInProgress(worktree, host))) {
          // No rebase left to drive: it finished — just now, or before we were called.
          const done = await this.fastForward(project, branch, base, worktree);
          if (done.status !== 'merged' || autoResolved.length === 0) return done;
          return { ...done, autoResolved: [...new Set(autoResolved)] };
        }
        const advanced = await this.advancePausedRebase(worktree, attrsPath, host);
        // A `--continue` that neither finished the rebase nor left conflicts is a failure this
        // cannot resolve, and the one thing that must NOT follow it is a fast-forward:
        // mid-rebase the branch ref still points at its PRE-rebase commit, so advancing base to
        // it would merge the unrebased work and report a success. Say so instead, and leave the
        // paused rebase exactly as it is — it is what the next attempt has to work with.
        if (advanced.code !== 0 && !(await hasConflicts(worktree, host))) {
          return {
            status: 'error',
            message: advanced.stderr.trim() || 'could not continue the paused rebase',
          };
        }
      }
      return {
        status: 'error',
        message:
          `the rebase of "${branch}" onto ${base} stopped more than ${MAX_MECHANICAL_ROUNDS} ` +
          `times; it is still paused in ${worktree}`,
      };
    } finally {
      attrs.cleanup();
    }
  }

  /**
   * Remove a task's worktree (best effort) — used when cleaning up a failed task, and when a
   * project's execution target moves and its worktrees have to go with it.
   *
   * Sweeps every candidate path rather than only the canonical one: a run that had to build
   * next door to undeletable debris (see {@link WorktreeManager.candidatePaths}) leaves BOTH
   * on disk, and a "Clean up & abandon" that removed only the address the worktree would
   * have had is exactly the kind of cleanup this whole area exists to stop trusting. Debris
   * git no longer recognises is deleted outright — there is no worktree left for git to
   * remove, its admin record went with the `.git` file.
   */
  async cleanup(project: Project, taskId: string): Promise<void> {
    const { host, root } = await this.workspaceFor(project);
    for (const cwd of this.candidatePaths(root, project.id, taskId)) {
      if (!existsSync(host.toApp(cwd))) continue;
      if (await isRepo(cwd, host)) await this.removeWorktreeChecked(project, cwd, host);
      else await this.removeDebris(host.toApp(cwd));
    }
  }

  /**
   * A live worktree whose `HEAD` is detached: put a branch back under it, or say why not.
   *
   * A detached worktree is a card that cannot be started at all — no step, no chat, no
   * merge — and the state is not rare: any agent that runs `git rebase` in its own worktree
   * and stops on a conflict leaves exactly this behind, as does the planning session that
   * traces a rebase to see whether a branch still lands. Refusing was the old answer, and it
   * refused the same way every time it was pressed: the only recovery offered was "Retry
   * fresh (discard branch)", which throws away every commit on the branch to fix a state
   * that costs nothing to undo. That is the wrong trade by a wide margin.
   *
   * So a paused REBASE is recovered rather than reported. `rebase --abort` is the same
   * command the old message asked the human to run, and it is safe by construction: it
   * restores the branch at the commit it had before the rebase started, so no commit can be
   * lost — only the replay in flight, which the card is about to redo anyway.
   *
   * The exception is `resuming`, and it is the whole reason this takes a flag. When the
   * orchestrator paused the rebase itself and this run is the resolution of it (conflict
   * ladder Rung 2/3), aborting would discard the very work the run exists to do — so the
   * branch is read out of the rebase state and the pause is handed over untouched.
   *
   * Anything ELSE that detaches a HEAD (a bare `git checkout <sha>`, a bisect) has no
   * one obvious undo and might be deliberate, so it is still refused — with a message that
   * says what was checked rather than guessing at a cause.
   */
  private async rescueDetached(
    live: string,
    host: ExecHost,
    resuming: boolean,
  ): Promise<{ branch: string; note?: string } | { branch: null; reason: string }> {
    const rebasing = await rebasingBranch(live, host);
    if (!rebasing) {
      return {
        branch: null,
        reason:
          `The worktree at ${live} is a git repository but has no branch checked out, and no ` +
          `rebase is in progress there to explain it — so this task has no branch to work on ` +
          `or merge back. Check \`git -C "${live}" status\`: a detached HEAD is what a bare ` +
          `\`git checkout <commit>\` or an interrupted bisect leaves behind, and checking the ` +
          `branch back out (\`git -C "${live}" checkout <branch>\`) clears it. "Retry fresh ` +
          `(discard branch)" on the card rebuilds the worktree, at the cost of the branch.`,
      };
    }
    if (resuming) return { branch: rebasing };

    const aborted = await abortRebase(live, host);
    // The abort's own exit code is not the question — whether a branch is back under HEAD is,
    // and only git can answer that. An abort that half-worked and left the head detached is
    // still a refusal, and it must not be reported as a recovery.
    const restored = await currentBranch(live, host);
    if (!restored) {
      return {
        branch: null,
        reason:
          `The worktree at ${live} is stranded part-way through a rebase of "${rebasing}", ` +
          `so it has no branch checked out and this task had nothing to work on. Undoing that ` +
          `rebase automatically failed: ${aborted.stderr.trim() || 'git rebase --abort failed'}. ` +
          `Run \`git -C "${live}" rebase --abort\` yourself, or use "Retry fresh (discard ` +
          `branch)" on the card to rebuild the worktree.`,
      };
    }
    return {
      branch: restored,
      note:
        `This card's worktree was stranded part-way through a rebase of "${rebasing}" onto ` +
        `something else, which leaves it with no branch checked out and blocks every run on ` +
        `the card. That rebase was undone (\`git rebase --abort\`) and "${restored}" checked ` +
        `back out before this run started. No commit was lost — an aborted rebase restores ` +
        `the branch exactly as it was before it began — but if that rebase was one you wanted, ` +
        `it has to be started again.`,
    };
  }

  /**
   * Where to BUILD a task's worktree, given that it has no live one: the first candidate
   * path that is free, clearing leftovers out of the preferred ones on the way.
   *
   * The whole method is about one failure and the two ways of answering it. A previous
   * worktree's directory is still on disk with its `.git` gone — inert debris from a cleanup
   * that a Windows lock stopped part-way (see {@link WorktreeManager.candidatePaths}).
   *
   *  - **Delete it and reuse the address.** Always tried first, and it is safe by
   *    construction — which is the only reason this deletes anything. `integrate` commits
   *    everything in the worktree (`commitAll`) BEFORE it merges, and cleanup only runs
   *    after that merge succeeded, so whatever is left in a directory git has stopped
   *    tracking was already committed and already landed. There is nothing here that git
   *    ever held and could still lose.
   *  - **Leave it and build next door.** What this used to do instead was park the task
   *    with "delete that directory and retry" — and that is how a card whose earlier steps
   *    had merged perfectly well came to refuse every step added afterwards: the lock is on
   *    a `node_modules` tree nobody can see holding, and the work being blocked has nothing
   *    to do with it. The debris is named on the timeline so it can be swept up later,
   *    which is a chore; not running is a stop.
   *
   * Returns the path to build at (plus anything the human has to be told), or the reason
   * nothing could be done.
   */
  private async chooseBuildPath(
    paths: readonly string[],
    host: ExecHost,
    projectPath: string,
  ): Promise<{ cwd: string; note?: string } | { reason: string }> {
    /** Debris we could not delete, in the order the paths were tried. */
    const leftover: { path: string; why: string }[] = [];

    for (const cwd of paths) {
      if (!existsSync(host.toApp(cwd))) {
        return { cwd, note: this.leftoverNote(leftover, cwd) || undefined };
      }
      const why = await gitPreflight(cwd, host);
      if (why.state !== 'not-a-repo') {
        // git itself could not be run (not installed, distro down). That is not the
        // directory's fault, and deleting a work tree on the strength of an answer we
        // never got is how real work disappears. Refuse instead.
        return {
          reason:
            `Couldn't tell whether the worktree at ${cwd} is still a git repository: ` +
            `${why.state === 'unknown' ? why.detail : why.state}. Nothing was deleted and ` +
            `the task was not run — fix git for that path and retry.`,
        };
      }
      const failure = await this.removeDebris(host.toApp(cwd));
      if (!failure) {
        // A write outside the task's own worktree belongs on the timeline, exactly like the
        // unborn-HEAD repair in `prepare` — it explains where a directory went.
        //
        // git may still hold an admin record pointing at the path just removed, which would
        // make `worktree add` refuse. `prepare`'s own prune-and-retry covers it.
        const repaired =
          `The worktree at ${cwd} was left half-deleted by an earlier cleanup (its ` +
          `\`.git\` was gone), so it was removed and rebuilt. Nothing was lost: a worktree ` +
          `is only ever cleaned up after its work has been committed and merged.`;
        const stranded = this.leftoverNote(leftover, cwd);
        return { cwd, note: stranded ? `${repaired} ${stranded}` : repaired };
      }
      leftover.push({ path: cwd, why: failure });
    }

    return {
      reason:
        `This task's worktree could not be built: all ${paths.length} directories it may use ` +
        `under ${paths[0]} are occupied by leftovers from earlier worktrees that cannot be ` +
        `deleted (${leftover.map((l) => `${l.path}: ${l.why}`).join('; ')}). Delete them and ` +
        `retry. The task was not run in the base tree (${projectPath}) to avoid polluting it.`,
    };
  }

  /** The half of a prep note that accounts for debris left standing, or undefined if none. */
  private leftoverNote(leftover: readonly { path: string; why: string }[], cwd: string): string {
    if (leftover.length === 0) return '';
    return (
      `An earlier worktree of this card is still on disk at ` +
      `${leftover.map((l) => l.path).join(', ')} and could not be deleted ` +
      `(${leftover[leftover.length - 1].why}), so this run was given a fresh worktree at ` +
      `${cwd} instead of waiting for it. Nothing in the leftover directory is needed — a ` +
      `worktree is only ever cleaned up after its work has been committed and merged — so ` +
      `delete it whenever convenient.`
    );
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
        rmSync(appPath, { recursive: true, force: true, ...RM_RETRY });
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
    // Resolved through the same candidate list `prepare` builds with, so a worktree that had
    // to be built next door to undeletable debris is still the one the Merge button finds.
    const cwd = await this.findLive(this.candidatePaths(root, project.id, ownerTaskId), host);
    if (!cwd) return null;
    // The worktree's own HEAD outranks the name we were handed: a card renamed after its
    // worktree was made carries a branch name that was never checked out anywhere. Mid-rebase
    // there is no HEAD branch to read, and the branch being replayed is the truthful answer —
    // it is what the worktree goes back to, and reading nothing here would fall through to a
    // name that may never have been checked out (see `rescueDetached`).
    const branch =
      (await currentBranch(cwd, host)) ||
      (await rebasingBranch(cwd, host)) ||
      branchName?.trim() ||
      taskBranch(ownerTaskId);
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
