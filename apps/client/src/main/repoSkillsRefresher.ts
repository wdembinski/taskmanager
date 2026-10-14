/**
 * Keeps `Project.repoSkills` (F7.11, step 3) in step with the `.claude/skills` a project's
 * own worktree actually carries, so the cloud project mirror has something to answer with: a
 * browser has no worktree of its own to read `.claude/skills` from, only whatever this
 * desktop last scanned and handed to `Store.setProjectRepoSkills`.
 *
 * Pure-ish and shaped like `cloudSkillPusher.ts`'s own pass in spirit, if not in machinery:
 * no network, no retry budget, no timer of its own — just a filesystem sweep every
 * dependency of which (`listRepoSkills`, `hostFor`) is injectable, defaulting to the real
 * implementations, so a test can drive it over a canned project list without touching disk.
 *
 * Failures are per-project and logged, never thrown: one project with a locked path, a
 * missing directory, or a WSL distro that has gone cold must never stop the rest of the
 * sweep — the same fail-soft contract `listRepoSkills` itself already keeps for one bad
 * skill inside a single project, just one level up.
 */
import { hasRepo, isPersonalBoard, type Project } from '@shared/model';
import type { RepoSkillSummary } from '@shared/skills';
import { hostFor as hostForReal, type ExecHost, type ExecTarget } from './exec';
import { listRepoSkills as listRepoSkillsReal } from './repoSkills';
import { logMain } from './log';

export interface RepoSkillsRefresherDeps {
  /** `Store.setProjectRepoSkills` — writes only when the serialized list actually changed. */
  setProjectRepoSkills: (id: string, list: RepoSkillSummary[]) => void;
  /** Defaults to the real filesystem scan (`./repoSkills`); overridden in tests. */
  listRepoSkills?: (projectId: string, root: string, host: ExecHost) => Promise<RepoSkillSummary[]>;
  /** Defaults to the real host registry (`./exec`); overridden in tests. */
  hostFor?: (target: ExecTarget | undefined) => ExecHost;
}

/**
 * Refresh one project. Exported on its own so a `project:add`/`project:update` handler can
 * re-scan just the project that changed, rather than sweeping every project in the app for
 * one edit.
 */
export async function refreshRepoSkillsForProject(
  deps: RepoSkillsRefresherDeps,
  project: Pick<Project, 'id' | 'path' | 'target'>,
): Promise<void> {
  const listRepoSkills = deps.listRepoSkills ?? listRepoSkillsReal;
  const hostFor = deps.hostFor ?? hostForReal;
  try {
    const skills = await listRepoSkills(project.id, project.path, hostFor(project.target));
    deps.setProjectRepoSkills(project.id, skills);
  } catch (e) {
    logMain(`Could not refresh repo skills for project ${project.id}`, e);
  }
}

/**
 * Sweep every project that could actually have `.claude/skills` to find: the Personal board
 * and any plan-less/pathless project are skipped, the same answer `listRepoSkills` itself
 * would give for them (`[]`), just without spending a filesystem round trip to learn it.
 *
 * Each project refreshes independently — `refreshRepoSkillsForProject` never rejects — so
 * one failure never stops the rest.
 */
export async function refreshAllRepoSkills(
  deps: RepoSkillsRefresherDeps,
  projects: readonly Pick<Project, 'id' | 'path' | 'target'>[],
): Promise<void> {
  const targets = projects.filter((project) => !isPersonalBoard(project.id) && hasRepo(project));
  await Promise.all(targets.map((project) => refreshRepoSkillsForProject(deps, project)));
}
