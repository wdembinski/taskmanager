/**
 * The roles table's state (F28.1, mockup v11-4) — what each of a card's four roles runs on,
 * and how hard it thinks — kept pure so the seeding and the writes are testable without a DOM.
 *
 * Every value here is the card's OWN choice, and `null` means "follow the next rung" — the
 * same rule `AssignAgentDialog` already keeps for its models. The table SHOWS the resolved
 * value (the project's, else the app default's) but only ever WRITES what the card had already
 * chosen or what the human touched in this dialog: seeding the resolved value into the state
 * would save an override nobody asked for, pinning the card to today's project setting.
 */
import {
  AGENT_ROLES,
  resolveRoleEffort,
  resolveRoleModel,
  type AgentRole,
  type AssignAgentInput,
  type Effort,
  type Project,
  type Task,
} from '@tm/shared/model';
import type { ClaudeModel } from '@tm/shared/session';

/**
 * The model dropdown's "follow the next rung" option — a Dropdown can't carry `null`. The
 * leading `..` keeps it out of the model namespace, like `PROJECT_DEFAULT`.
 */
export const ROLE_DEFAULT = '..role-default';

/** One role's own choice; `null` = follow the next rung. */
export interface RoleChoice {
  model: ClaudeModel | null;
  effort: Effort | null;
}

export type RolesState = Record<AgentRole, RoleChoice>;

/** The card's model field for each role. */
const TASK_MODEL_FIELD = {
  lead: 'agentLeadModel',
  planner: 'agentPlanningModel',
  workers: 'agentModel',
  reviewer: 'agentReviewModel',
} as const satisfies Record<AgentRole, keyof Task>;

/** The card's effort field for each role. */
const TASK_EFFORT_FIELD = {
  lead: 'agentLeadEffort',
  planner: 'agentPlanningEffort',
  workers: 'agentEffort',
  reviewer: 'agentReviewEffort',
} as const satisfies Record<AgentRole, keyof Task>;

/** Which `AssignAgentInput` field carries each role's model, and each role's effort. */
const INPUT_MODEL_FIELD = {
  lead: 'leadModel',
  planner: 'planningModel',
  workers: 'model',
  reviewer: 'reviewModel',
} as const satisfies Record<AgentRole, keyof AssignAgentInput>;

const INPUT_EFFORT_FIELD = {
  lead: 'leadEffort',
  planner: 'planningEffort',
  workers: 'effort',
  reviewer: 'reviewEffort',
} as const satisfies Record<AgentRole, keyof AssignAgentInput>;

/** Every role following its next rung — a card nobody has set anything on. */
export function emptyRoles(): RolesState {
  return {
    lead: { model: null, effort: null },
    planner: { model: null, effort: null },
    workers: { model: null, effort: null },
    reviewer: { model: null, effort: null },
  };
}

/** The card's own choices, and nothing the project or the app would have filled in. */
export function seedRoles(task: Partial<Task> | null): RolesState {
  const roles = emptyRoles();
  if (!task) return roles;
  for (const role of AGENT_ROLES) {
    roles[role] = {
      model: task[TASK_MODEL_FIELD[role]] ?? null,
      effort: task[TASK_EFFORT_FIELD[role]] ?? null,
    };
  }
  return roles;
}

/** The state as card fields, for the shared ladders to read. */
function asTask(roles: RolesState): Partial<Task> {
  const task: Partial<Task> = {};
  for (const role of AGENT_ROLES) {
    task[TASK_MODEL_FIELD[role]] = roles[role].model;
    task[TASK_EFFORT_FIELD[role]] = roles[role].effort;
  }
  return task;
}

/**
 * What a role's model falls back to when it is left on {@link ROLE_DEFAULT} — the model the
 * sentinel option names. The OTHER roles' choices still count: a planner left on the default
 * follows the card's own workers model, exactly as `resolveRoleModel` says it does.
 */
export function fallbackModel(
  role: AgentRole,
  roles: RolesState,
  project: Parameters<typeof resolveRoleModel>[2],
): ClaudeModel {
  return resolveRoleModel(
    role,
    asTask({ ...roles, [role]: { ...roles[role], model: null } }),
    project,
  );
}

/** The effort the control shows selected: the card's own, else the project's, else the app's. */
export function shownEffort(
  role: AgentRole,
  roles: RolesState,
  project: Partial<Project> | null,
  defaultEfforts: Readonly<Record<AgentRole, Effort>>,
): Effort {
  return resolveRoleEffort(role, asTask(roles), project ?? {}, { defaultEfforts });
}

/** What a picked dropdown option means as a stored value: the sentinel (or nothing) is `null`. */
export function roleModelFromOption(optionValue: string | undefined): ClaudeModel | null {
  return optionValue && optionValue !== ROLE_DEFAULT ? (optionValue as ClaudeModel) : null;
}

/** The dropdown value for a stored one — `null` shows as the sentinel. */
export function roleModelOption(model: ClaudeModel | null): string {
  return model ?? ROLE_DEFAULT;
}

/** One role's model changed; every other value untouched. */
export function setRoleModel(
  roles: RolesState,
  role: AgentRole,
  model: ClaudeModel | null,
): RolesState {
  return { ...roles, [role]: { ...roles[role], model } };
}

/** One role's effort picked; every other value untouched. */
export function setRoleEffort(roles: RolesState, role: AgentRole, effort: Effort): RolesState {
  return { ...roles, [role]: { ...roles[role], effort } };
}

/** The assign fields the roles table writes. */
export type RoleWrites = Pick<
  AssignAgentInput,
  | 'leadModel'
  | 'planningModel'
  | 'model'
  | 'reviewModel'
  | 'leadEffort'
  | 'planningEffort'
  | 'effort'
  | 'reviewEffort'
>;

/**
 * The state as `task:assignAgent` / `task:startVariants` input. A `null` is omitted rather
 * than sent: the assign maps a missing field to `null`, the same "follow the next rung".
 */
export function roleWrites(roles: RolesState): RoleWrites {
  const writes: RoleWrites = {};
  for (const role of AGENT_ROLES) {
    const { model, effort } = roles[role];
    if (model !== null) writes[INPUT_MODEL_FIELD[role]] = model;
    if (effort !== null) writes[INPUT_EFFORT_FIELD[role]] = effort;
  }
  return writes;
}
