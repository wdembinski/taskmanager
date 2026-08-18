/**
 * Which **agent project** (repo) a My Tasks card should be worked in.
 *
 * A card's own `projectId` always stays on the Personal board; the agent project is a
 * separate pointer that names the repo a delegated run happens in (see `hasRepo` in
 * `model.ts`). Resolution is pure and lives in `shared` because both sides need the
 * same answer: the renderer pre-fills the assign dialog with it, and the main process
 * re-resolves when a run is launched.
 */
import type { Project, Task } from './model';
import { hasRepo } from './model';

/** Canonical form of a JIRA epic key: trimmed and upper-cased (keys are case-insensitive). */
export function normalizeEpicKey(key: string): string {
  return key.trim().toUpperCase();
}

/** Only a project with a repo can host a delegated task — one with no directory never can. */
export function agentProjectsOf(projects: Project[]): Project[] {
  return projects.filter(hasRepo);
}

/**
 * Resolve the agent project for a task, in precedence order:
 *
 * 1. An explicit `task.agentProjectId` — a human already delegated it, and that always
 *    wins (even if the ticket's epic later moves to another project's list).
 * 2. `task.projectTagId` — the card was FILED under a project. That is not a delegation
 *    (see `isAgentAssigned`, which stays on `agentProjectId`), but it is a perfectly
 *    good answer to "which repo would this run in", so a filed card resolves sensibly
 *    the moment you do delegate it.
 * 3. The agent project whose `jiraEpicKeys` contain the ticket's epic/parent key.
 * 4. `null` — nothing owns it, so the assign dialog has to ask.
 *
 * `projects` may be the full project list; projects with no repo are ignored. When two
 * agent projects claim the same epic the first in list order wins (creation order),
 * which is deterministic — the UI still lets the human override.
 */
export function resolveAgentProject(task: Task, projects: Project[]): Project | null {
  const candidates = agentProjectsOf(projects);

  if (task.agentProjectId) {
    // A stale id (project since deleted) falls through to epic matching rather than
    // resolving to nothing, so an assigned card stays workable.
    const explicit = candidates.find((p) => p.id === task.agentProjectId);
    if (explicit) return explicit;
  }

  if (task.projectTagId) {
    const filed = candidates.find((p) => p.id === task.projectTagId);
    if (filed) return filed;
  }

  const epicKey = task.externalParentKey ? normalizeEpicKey(task.externalParentKey) : null;
  if (!epicKey) return null;

  return (
    candidates.find((p) => p.jiraEpicKeys.some((k) => normalizeEpicKey(k) === epicKey)) ?? null
  );
}
