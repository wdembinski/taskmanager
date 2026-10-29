import { describe, expect, it } from 'vitest';
import type { AgentRole, Effort, Project, Task } from '@tm/shared/model';
import {
  ROLE_DEFAULT,
  emptyRoles,
  fallbackModel,
  roleModelFromOption,
  roleModelOption,
  roleWrites,
  seedRoles,
  setRoleEffort,
  setRoleModel,
  shownEffort,
} from './rolesTableModel';

const APP_EFFORTS: Record<AgentRole, Effort> = {
  lead: 'high',
  planner: 'high',
  workers: 'high',
  reviewer: 'high',
};

const project = (over: Partial<Project> = {}): Project =>
  ({
    defaultModel: 'sonnet',
    planningModel: 'opus',
    reviewModel: null,
    leadModel: null,
    leadEffort: null,
    planningEffort: null,
    workerEffort: null,
    reviewEffort: null,
    ...over,
  }) as Project;

describe('seedRoles', () => {
  it('seeds every role to null for a card with nothing of its own', () => {
    expect(seedRoles({} as Partial<Task>)).toEqual(emptyRoles());
    expect(seedRoles(null)).toEqual(emptyRoles());
  });

  it("reads the card's own model and effort for each role", () => {
    const roles = seedRoles({
      agentLeadModel: 'opus',
      agentPlanningModel: 'fable',
      agentModel: 'haiku',
      agentReviewModel: null,
      agentLeadEffort: 'max',
      agentPlanningEffort: null,
      agentEffort: 'low',
      agentReviewEffort: 'xhigh',
    });
    expect(roles).toEqual({
      lead: { model: 'opus', effort: 'max' },
      planner: { model: 'fable', effort: null },
      workers: { model: 'haiku', effort: 'low' },
      reviewer: { model: null, effort: 'xhigh' },
    });
  });
});

describe('shownEffort', () => {
  it('shows the card, else the project, else the app default', () => {
    const app = { ...APP_EFFORTS, reviewer: 'medium' as const };
    const roles = setRoleEffort(emptyRoles(), 'lead', 'max');
    const p = project({ planningEffort: 'low' });
    expect(shownEffort('lead', roles, p, app)).toBe('max');
    expect(shownEffort('planner', roles, p, app)).toBe('low');
    expect(shownEffort('workers', roles, p, app)).toBe('high');
    expect(shownEffort('reviewer', roles, p, app)).toBe('medium');
  });

  it('falls straight to the app default with no project picked', () => {
    expect(shownEffort('workers', emptyRoles(), null, APP_EFFORTS)).toBe('high');
  });
});

describe('fallbackModel', () => {
  it("names the project's rung for a role left on the default", () => {
    const p = project();
    expect(fallbackModel('workers', emptyRoles(), p)).toBe('sonnet');
    expect(fallbackModel('planner', emptyRoles(), p)).toBe('opus');
    expect(fallbackModel('lead', emptyRoles(), p)).toBe('opus');
    expect(fallbackModel('reviewer', emptyRoles(), project({ reviewModel: 'fable' }))).toBe(
      'fable',
    );
  });

  it("ignores the role's own pick, and honours the other roles' choices", () => {
    let roles = setRoleModel(emptyRoles(), 'planner', 'haiku');
    expect(fallbackModel('planner', roles, project())).toBe('opus');
    // A planner on the default follows the card's own workers model.
    roles = setRoleModel(emptyRoles(), 'workers', 'haiku');
    expect(fallbackModel('planner', roles, project())).toBe('haiku');
  });
});

describe('the sentinel', () => {
  it('reads back as null, and null shows as the sentinel', () => {
    expect(roleModelFromOption(ROLE_DEFAULT)).toBeNull();
    expect(roleModelFromOption(undefined)).toBeNull();
    expect(roleModelFromOption('')).toBeNull();
    expect(roleModelFromOption('opus')).toBe('opus');
    expect(roleModelOption(null)).toBe(ROLE_DEFAULT);
    expect(roleModelOption('opus')).toBe('opus');
  });
});

describe('roleWrites', () => {
  it('writes nothing for an untouched card, even though the table shows values', () => {
    expect(roleWrites(emptyRoles())).toEqual({});
  });

  it('writes only what was touched or already the card’s own', () => {
    let roles = seedRoles({ agentModel: 'haiku', agentReviewEffort: 'xhigh' });
    roles = setRoleEffort(roles, 'lead', 'low');
    roles = setRoleModel(roles, 'planner', 'opus');
    expect(roleWrites(roles)).toEqual({
      model: 'haiku',
      reviewEffort: 'xhigh',
      leadEffort: 'low',
      planningModel: 'opus',
    });
  });

  it('drops a model set back to the sentinel', () => {
    let roles = setRoleModel(emptyRoles(), 'lead', 'opus');
    roles = setRoleModel(roles, 'lead', roleModelFromOption(ROLE_DEFAULT));
    expect(roleWrites(roles)).toEqual({});
  });
});
