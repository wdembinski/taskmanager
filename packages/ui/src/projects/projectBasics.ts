/**
 * The tickets-or-personal choice every project form makes, and the pure logic behind it —
 * `ProjectForm.tsx` draws the choice itself (`ProjectBasicsFields.tsx`) in place of its own
 * "Ticket key prefix" field for any plan-less project, the one shape the store's guaranteed
 * a prefix applies to (`store.addProject`/`updateProject`, gated on `AddProjectInput.personal`
 * / `ProjectPatch.personal`).
 *
 * A project's mode is never stored directly — it is read off `ownsTickets` (a non-empty
 * `ticketPrefix`), the same fact the rest of the app already keys off. This module is only
 * the UI's way of asking for that fact as a single choice instead of an implicit one.
 *
 * No React, no Electron — see `ProjectBasicsFields.tsx` for the form this drives.
 */
import type { AddProjectInput, AgentRole, Effort, Project } from '@tm/shared/model';
import { AGENT_ROLES, ownsTickets } from '@tm/shared/model';
import type { ClaudeModel } from '@tm/shared/session';
import { normalizeTicketPrefix } from '@tm/shared/ticketKey';

export type TicketMode = 'personal' | 'tickets';

/** A project's mode, read off the one fact that actually decides it. */
export function ticketModeOf(project: Project): TicketMode {
  return ownsTickets(project) ? 'tickets' : 'personal';
}

export interface TicketPrefixErrorArgs {
  mode: TicketMode;
  prefix: string;
  /** Every other project, so a chosen prefix can be checked against theirs. */
  projects: Project[];
  /** The project being edited, excluded from the collision check against itself. */
  editingId?: string;
}

/**
 * Why `prefix` can't be saved for a project in `mode`, or `null` if it can.
 *
 * A `'personal'` project never owns a prefix, so nothing here can be wrong about it. A
 * `'tickets'` project's prefix is genuinely optional too — the store guarantees one for a
 * plan-less project regardless (`suggestTicketPrefix` + `uniqueTicketPrefix`), so an empty
 * field is left for the store to fill in rather than blocked here. What IS checked is that a
 * prefix the human DID type is usable and unclaimed.
 */
export function ticketPrefixError({
  mode,
  prefix,
  projects,
  editingId,
}: TicketPrefixErrorArgs): string | null {
  if (mode === 'personal' || !prefix.trim()) return null;

  const normalized = normalizeTicketPrefix(prefix);
  if (!normalized) {
    return 'Not a usable prefix — needs at least one letter, and cannot be just digits.';
  }

  const takenBy = projects.find(
    (p) => p.id !== editingId && p.ticketPrefix && p.ticketPrefix.toUpperCase() === normalized,
  );
  return takenBy ? `Already used by ${takenBy.name}.` : null;
}

/**
 * The project form's roles table (F28.1, mockup v11-4) — the same four rows the Start dialog
 * shows, as this project's defaults for every card that leaves a role unset.
 *
 * Workers is the project's `defaultModel`, the bottom rung, so it is never `null` and has no
 * sentinel. Planner, Lead and Reviewer are `null` while they follow the next rung: the planner
 * plans on the execution model, the lead and the reviewer judge on the planning one
 * (`resolveRoleModel`). An effort is `null` while it follows the app's `defaultEfforts`, and
 * only an effort the human picked in this form is written — saving the shown default would pin
 * the project to today's app setting.
 */
export interface ProjectRoles {
  models: Record<Exclude<AgentRole, 'workers'>, ClaudeModel | null> & { workers: ClaudeModel };
  efforts: Record<AgentRole, Effort | null>;
  /** The roles whose effort was picked in this form. */
  touched: readonly AgentRole[];
}

/** The project's own role choices, or a new project's from the app defaults. */
export function seedProjectRoles(
  project: Project | null,
  defaults: { defaultModel: ClaudeModel; defaultPlanningModel: ClaudeModel | null },
): ProjectRoles {
  if (!project) {
    return {
      models: {
        lead: null,
        planner: defaults.defaultPlanningModel,
        workers: defaults.defaultModel,
        reviewer: null,
      },
      efforts: { lead: null, planner: null, workers: null, reviewer: null },
      touched: [],
    };
  }
  return {
    models: {
      lead: project.leadModel,
      planner: project.planningModel,
      workers: project.defaultModel,
      reviewer: project.reviewModel,
    },
    efforts: {
      lead: project.leadEffort,
      planner: project.planningEffort,
      workers: project.workerEffort,
      reviewer: project.reviewEffort,
    },
    touched: [],
  };
}

/**
 * How a role's "follow the next rung" option reads; `undefined` for Workers, which has no
 * next rung. It names the rung, not the model: the model is the row above, and a label that
 * spelled it out wrapped in the table's 170px dropdown.
 */
export function projectRoleSentinel(role: AgentRole): string | undefined {
  switch (role) {
    case 'workers':
      return undefined;
    case 'planner':
      return 'Same as execution';
    case 'lead':
    case 'reviewer':
      return 'Same as planning';
  }
}

/** The effort a row shows picked: the project's own, else the app's default for the role. */
export function projectRoleEffort(
  role: AgentRole,
  roles: ProjectRoles,
  defaultEfforts: Readonly<Record<AgentRole, Effort>>,
): Effort {
  return roles.efforts[role] ?? defaultEfforts[role];
}

/** One role's model changed. Workers can never go `null`, so a `null` for it is ignored. */
export function setProjectRoleModel(
  roles: ProjectRoles,
  role: AgentRole,
  model: ClaudeModel | null,
): ProjectRoles {
  if (role === 'workers' && model === null) return roles;
  return { ...roles, models: { ...roles.models, [role]: model } };
}

/** One role's effort picked — and so, from now on, written. */
export function setProjectRoleEffort(
  roles: ProjectRoles,
  role: AgentRole,
  effort: Effort,
): ProjectRoles {
  return {
    ...roles,
    efforts: { ...roles.efforts, [role]: effort },
    touched: roles.touched.includes(role) ? roles.touched : [...roles.touched, role],
  };
}

/** The project fields the roles table owns — the same on `project:add` and `project:update`. */
export type ProjectRoleWrites = Pick<
  AddProjectInput,
  | 'defaultModel'
  | 'planningModel'
  | 'leadModel'
  | 'reviewModel'
  | 'leadEffort'
  | 'planningEffort'
  | 'workerEffort'
  | 'reviewEffort'
>;

const PROJECT_EFFORT_WRITE = {
  lead: 'leadEffort',
  planner: 'planningEffort',
  workers: 'workerEffort',
  reviewer: 'reviewEffort',
} as const satisfies Record<AgentRole, keyof ProjectRoleWrites>;

/** The table as `project:add` / `project:update` input: every model, and the touched efforts. */
export function projectRoleWrites(roles: ProjectRoles): ProjectRoleWrites {
  const writes: ProjectRoleWrites = {
    defaultModel: roles.models.workers,
    planningModel: roles.models.planner,
    leadModel: roles.models.lead,
    reviewModel: roles.models.reviewer,
  };
  for (const role of AGENT_ROLES) {
    if (roles.touched.includes(role)) writes[PROJECT_EFFORT_WRITE[role]] = roles.efforts[role];
  }
  return writes;
}
