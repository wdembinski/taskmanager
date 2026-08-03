/**
 * Reading a project's commit graph out of its repository.
 *
 * The engine half of `@shared/gitGraph`: it runs exactly one `git log` and hands the output
 * to the pure parser/layout there. Two things about it are deliberate.
 *
 * **It goes through `hostFor(project.target)`.** A project can run inside WSL, and a bare
 * `spawn('git')` would then read the Windows side of a repository that only exists in the
 * distro — see `src/main/git.ts`. Every git call in this app takes a host for that reason.
 *
 * **It never throws.** A project folder that isn't a repository, has no commits, or has gone
 * missing is a normal project, not an error — the same judgement `project:gitPreflight` makes.
 * Every one of those returns an EMPTY graph carrying a sentence the UI can show, so a panel
 * that can't draw a graph says why instead of breaking the screen around it.
 */
import type { GitPreflight, Project, Task } from '@shared/model';
import {
  GIT_LOG_FORMAT,
  buildGitGraph,
  emptyGitGraph,
  parseGitLog,
  withRefRoles,
  type GitGraph,
} from '@shared/gitGraph';
import { hostFor } from './exec';
import { git, gitPreflight } from './git';
import { taskBranch } from './worktreeManager';

/** How many commits a graph shows when the caller doesn't say. Roughly a screenful, scrolled. */
export const DEFAULT_GRAPH_LIMIT = 120;

/**
 * The ceiling on `limit`, because the renderer draws one row per commit and a repo can have
 * a hundred thousand of them. A graph is a view, not an export.
 */
const MAX_GRAPH_LIMIT = 1000;

/**
 * Branch name → the id of the card whose work it carries, for one project.
 *
 * This mapping lives here, on the engine side, because it is the engine that owns both halves
 * of it: `Task.agentBranch` is the name the human chose when the agent was assigned, and cards
 * from before branch naming existed still work on the legacy `orch/<taskId>` — the same
 * fallback `Scheduler.branchFor` applies (`src/main/scheduler.ts`). Getting it wrong here
 * would silently un-name half the branches in the drawing.
 *
 * `tasks` is every card the app knows about, from every board: a card delegated to this
 * project usually lives on the Personal board, not in the project, so filtering by
 * `projectId` alone would find nothing.
 */
export function cardBranchesFor(tasks: readonly Task[], projectId: string): Map<string, string> {
  const byBranch = new Map<string, string>();
  for (const task of tasks) {
    // A step of an approved plan shares its parent's worktree, and a worktree has exactly one
    // branch — so the OWNER card names it and the steps are skipped rather than each claiming
    // the same branch and the last one winning.
    if (task.parentTaskId) continue;
    // Where the card RUNS: the agent project it was delegated to, else its own project (a
    // plan project's tasks run in the project itself).
    if ((task.agentProjectId ?? task.projectId) !== projectId) continue;
    const branch = task.agentBranch?.trim() || taskBranch(task.id);
    if (!byBranch.has(branch)) byBranch.set(branch, task.id);
  }
  return byBranch;
}

/** Turn a preflight that isn't `ready` into the sentence the panel shows instead of a graph. */
function reasonForPreflight({ state, detail }: GitPreflight): string {
  switch (state) {
    case 'missing':
      return "That project folder isn't there on the machine this project runs on.";
    case 'not-a-repo':
      return 'This folder is not a git repository, so there is no history to show.';
    case 'no-commits':
      return 'This repository has no commits yet — its history starts with the first one.';
    default:
      return detail || 'Git could not be read for this project.';
  }
}

/**
 * Read `project`'s history as a laid-out graph.
 *
 * `cardBranches` comes from {@link cardBranchesFor}; the base branch is the project's, falling
 * back to whatever the main checkout has out — which is what an empty `baseBranch` has always
 * meant (`Project.baseBranch`). The preflight answers both questions in one go: whether there
 * is anything to read, and what that current branch is.
 *
 * One commit MORE than asked for is fetched, purely so "there is older history than this" can
 * be reported honestly rather than guessed from `length === limit`.
 */
export async function readGitGraph(
  project: Project,
  cardBranches: ReadonlyMap<string, string>,
  limit = DEFAULT_GRAPH_LIMIT,
): Promise<GitGraph> {
  try {
    if (!project.path.trim()) return emptyGitGraph('This project has no folder to read.');

    const host = hostFor(project.target);
    const pre = await gitPreflight(project.path, host);
    if (pre.state !== 'ready') return emptyGitGraph(reasonForPreflight(pre));
    const baseBranch = project.baseBranch.trim() || pre.branch || '';

    const wanted = Math.min(Math.max(1, Math.trunc(limit) || DEFAULT_GRAPH_LIMIT), MAX_GRAPH_LIMIT);
    const res = await git(
      project.path,
      [
        'log',
        '--date-order',
        // `--all` so branches nobody has checked out — every card's branch, by definition —
        // are in the graph. Without it you only ever see the line HEAD is on.
        '--all',
        '-n',
        String(wanted + 1),
        '--decorate=full',
        `--format=${GIT_LOG_FORMAT}`,
      ],
      host,
    );
    if (res.code !== 0) {
      return emptyGitGraph(res.stderr.trim() || 'git log could not be read here.', baseBranch);
    }

    const parsed = parseGitLog(res.stdout);
    const truncated = parsed.length > wanted;
    const commits = truncated ? parsed.slice(0, wanted) : parsed;
    return buildGitGraph(withRefRoles(commits, { baseBranch, cardBranches }), {
      baseBranch,
      truncated,
    });
  } catch (err) {
    return emptyGitGraph(err instanceof Error ? err.message : String(err));
  }
}
