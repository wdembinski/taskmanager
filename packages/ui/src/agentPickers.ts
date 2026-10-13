/**
 * The agent pickers two dialogs share: `AssignAgentDialog`'s (an existing card) and
 * `AddTaskDialog`'s Run-it section (a card about to be created). Pure — no React — so both
 * seed and react to the same project/mode precedence without restating it twice.
 */
import { isPersonalBoard } from '@tm/shared/model';
import type { Project, Task } from '@tm/shared/model';
import { seedAssignProject } from '@tm/shared/agentProjects';
import type { PermissionMode } from '@tm/shared/session';

/** Offered in every permission-mode picker, in this order. */
export const PERMISSION_MODES: PermissionMode[] = [
  'acceptEdits',
  'plan',
  'manual',
  'bypassPermissions',
];

/** The mode a dialog starts on when neither the card nor its project says otherwise. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'acceptEdits';

/**
 * The mode a dialog seeds on open: the card's own override, else the resolved project's
 * default, else {@link DEFAULT_PERMISSION_MODE}.
 */
export function seedPermissionMode(
  card: Pick<Task, 'agentMode'> | null,
  project: Pick<Project, 'defaultPermissionMode'> | null,
): PermissionMode {
  return card?.agentMode ?? project?.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE;
}

/**
 * What picking a project in the dropdown switches the mode to — the picked project's own
 * default, else whatever was already selected. The model deliberately does not follow the
 * same rule (it already means "follow the project" by staying untouched), but the mode is a
 * per-project default that a fresh pick should adopt — see `AssignAgentDialog`'s `pickProject`.
 */
export function modeForPickedProject(
  projects: Pick<Project, 'id' | 'defaultPermissionMode'>[],
  id: string,
  current: PermissionMode,
): PermissionMode {
  return projects.find((p) => p.id === id)?.defaultPermissionMode ?? current;
}

/** Shown wherever a picker has no agent projects to offer. */
export const NO_AGENT_PROJECTS_MESSAGE =
  'No agent projects yet. Add one in the desktop app, under Projects (a repository folder, plus the JIRA epics it owns), and then assign this card.';

/** What `seedNewCardAssign` needs to know about a card that does not exist yet. */
export interface NewCardAssignSeed {
  /** The project or board the card is about to be created on — `PERSONAL_PROJECT_ID` or
   *  any other project, same meaning as `AddTaskForm.boardId`. */
  boardId: string;
  /** The epic the card's ticket would hang off, if any — only its key matters here. */
  epic?: Pick<Task, 'externalKey'> | null;
}

/**
 * Seed `AddTaskDialog`'s Run-it section the way `AssignAgentDialog` seeds an existing one: run
 * the seedable shape a card about to be created on `boardId` would have through the same
 * `seedAssignProject` precedence, so pre-filling a card that doesn't exist yet agrees with
 * pre-filling one that does. The model is always `null` — a fresh card has no override of its
 * own, so it follows whatever project resolves — and the id is `''` when nothing resolves; no
 * guessing.
 */
export function seedNewCardAssign(
  seed: NewCardAssignSeed,
  projects: Project[],
): { agentProjectId: string; model: null; mode: PermissionMode } {
  const resolved = seedAssignProject(
    {
      projectId: seed.boardId,
      agentProjectId: null,
      projectTagId: isPersonalBoard(seed.boardId) ? null : seed.boardId,
      externalParentKey: seed.epic?.externalKey ?? null,
    },
    projects,
  );
  return {
    agentProjectId: resolved?.id ?? '',
    model: null,
    mode: seedPermissionMode(null, resolved),
  };
}
