import { describe, expect, it } from 'vitest';
import {
  AGENT_ROLES,
  EFFORTS,
  familyOfAlias,
  isEffort,
  isFilingProject,
  isUsableModel,
  MODEL_CATALOG,
  MODELS,
  ownsBoard,
  resolveRoleEffort,
  resolveRoleModel,
  resolveRunModel,
  ROLE_CAPTIONS,
  type AgentRole,
  type Effort,
  type Project,
  type Task,
} from './model';
import type { ClaudeModel } from './session';

/** A project literal with just the fields these two predicates read. */
const proj = (overrides: Partial<Project> = {}) =>
  ({ planPath: '', path: '', ticketPrefix: '', ...overrides }) as Pick<
    Project,
    'planPath' | 'path' | 'ticketPrefix'
  >;

/** The two models a project carries: what it runs on, and what it plans on. */
const repo = (defaultModel: ClaudeModel, planningModel: ClaudeModel | null) => ({
  defaultModel,
  planningModel,
});

describe('MODELS', () => {
  it('lists every model a run may be launched on, cheapest first', () => {
    expect([...MODELS]).toEqual(['haiku', 'sonnet', 'opus']);
  });
});

describe('resolveRunModel', () => {
  it('runs a step on the project execution model when nothing else is said', () => {
    expect(resolveRunModel({ agentModel: null }, repo('sonnet', null), false)).toBe('sonnet');
    // A card that predates the field carries no `agentModel` key at all.
    expect(resolveRunModel({}, repo('sonnet', null), false)).toBe('sonnet');
  });

  it('plans on the planning model and executes on the other one', () => {
    const project = repo('haiku', 'opus');
    expect(resolveRunModel({ agentModel: null }, project, true)).toBe('opus');
    expect(resolveRunModel({ agentModel: null }, project, false)).toBe('haiku');
  });

  it('plans on the execution model when the project has named no planning model', () => {
    // `null` is "same as execution" — the default, and every project that predates it.
    expect(resolveRunModel({ agentModel: null }, repo('sonnet', null), true)).toBe('sonnet');
  });

  it("lets the card's own choice outrank both project models, planning or not", () => {
    const project = repo('haiku', 'opus');
    expect(resolveRunModel({ agentModel: 'sonnet' }, project, true)).toBe('sonnet');
    expect(resolveRunModel({ agentModel: 'sonnet' }, project, false)).toBe('sonnet');
  });

  it('still resolves correctly with a full version id in every slot', () => {
    const project = repo('claude-haiku-4-5', 'claude-opus-4-8');
    expect(resolveRunModel({ agentModel: null }, project, true)).toBe('claude-opus-4-8');
    expect(resolveRunModel({ agentModel: null }, project, false)).toBe('claude-haiku-4-5');
    expect(resolveRunModel({ agentModel: 'claude-sonnet-5' }, project, true)).toBe(
      'claude-sonnet-5',
    );
  });

  it("lets the card's own planning override outrank the project's planning model", () => {
    const project = repo('haiku', 'opus');
    expect(resolveRunModel({ agentModel: null, agentPlanningModel: 'sonnet' }, project, true)).toBe(
      'sonnet',
    );
    // A steps run never falls back to the planning override.
    expect(
      resolveRunModel({ agentModel: null, agentPlanningModel: 'sonnet' }, project, false),
    ).toBe('haiku');
  });

  it('falls back through agentModel, then the project ladder, when only agentPlanningModel is unset', () => {
    const project = repo('haiku', 'opus');
    expect(resolveRunModel({ agentModel: 'sonnet', agentPlanningModel: null }, project, true)).toBe(
      'sonnet',
    );
    expect(
      resolveRunModel({ agentModel: 'sonnet', agentPlanningModel: null }, project, false),
    ).toBe('sonnet');
  });

  it('resolves planning and steps independently when a card sets both to different models', () => {
    const project = repo('haiku', 'opus');
    const task = { agentModel: 'sonnet' as ClaudeModel, agentPlanningModel: 'opus' as ClaudeModel };
    expect(resolveRunModel(task, project, true)).toBe('opus');
    expect(resolveRunModel(task, project, false)).toBe('sonnet');
  });

  it('still pins both kinds of run to a lone agentModel, unchanged from before the split', () => {
    const project = repo('haiku', 'opus');
    expect(resolveRunModel({ agentModel: 'sonnet' }, project, true)).toBe('sonnet');
    expect(resolveRunModel({ agentModel: 'sonnet' }, project, false)).toBe('sonnet');
    // No `agentPlanningModel` key at all, as on every card that predates the field.
    expect(resolveRunModel({ agentModel: 'sonnet' }, project, true)).toBe('sonnet');
  });
});

describe('MODEL_CATALOG', () => {
  it('has no duplicate ids', () => {
    const ids = MODEL_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every entry passes isUsableModel', () => {
    for (const entry of MODEL_CATALOG) {
      expect(isUsableModel(entry.id)).toBe(true);
    }
  });
});

describe('isUsableModel', () => {
  it('accepts an alias, a full version id, and a plausible custom id', () => {
    expect(isUsableModel('sonnet')).toBe(true);
    expect(isUsableModel('claude-opus-4-8')).toBe(true);
    expect(isUsableModel('my-custom-model_v2.1')).toBe(true);
  });

  it('rejects empty and whitespace-only ids', () => {
    expect(isUsableModel('')).toBe(false);
    expect(isUsableModel('   ')).toBe(false);
  });

  it('rejects an id over 64 characters', () => {
    expect(isUsableModel('a'.repeat(65))).toBe(false);
    expect(isUsableModel('a'.repeat(64))).toBe(true);
  });

  it('rejects shell metacharacters and injection attempts', () => {
    expect(isUsableModel(';rm -rf /')).toBe(false);
    expect(isUsableModel('opus; rm -rf /')).toBe(false);
    expect(isUsableModel('opus && echo hi')).toBe(false);
    expect(isUsableModel('../../etc/passwd')).toBe(false);
  });
});

describe('ownsBoard', () => {
  it('is false for a personal-space project — no plan, but no ticket prefix either', () => {
    expect(ownsBoard(proj())).toBe(false);
  });

  it('is true for a project that owns a ticket prefix, repo or not', () => {
    expect(ownsBoard(proj({ ticketPrefix: 'TM' }))).toBe(true);
    expect(ownsBoard(proj({ ticketPrefix: 'TM', path: '/repos/tm' }))).toBe(true);
  });

  it('is false for a plan-driven project even one carrying a leftover ticket prefix', () => {
    // A migrated plan project can carry a `ticketPrefix` set before this rule existed —
    // `ticket:create` refuses it ahead of `ownsTickets` for the same reason.
    expect(ownsBoard(proj({ planPath: '/repo/plan.md', ticketPrefix: 'TM' }))).toBe(false);
  });
});

describe('familyOfAlias', () => {
  it('names the family for each bare alias', () => {
    expect(familyOfAlias('haiku')).toBe('haiku');
    expect(familyOfAlias('sonnet')).toBe('sonnet');
    expect(familyOfAlias('opus')).toBe('opus');
    expect(familyOfAlias('fable')).toBe('fable');
  });

  it('is null for a non-model mode, even one sharing a family name as a literal prefix', () => {
    expect(familyOfAlias('opusplan')).toBeNull();
    expect(familyOfAlias('default')).toBeNull();
    expect(familyOfAlias('best')).toBeNull();
  });

  it('is null for a context-length variant', () => {
    expect(familyOfAlias('sonnet[1m]')).toBeNull();
    expect(familyOfAlias('opus[1m]')).toBeNull();
    expect(familyOfAlias('fable[1m]')).toBeNull();
  });

  it('is null for a dated version id — those are named by MODEL_CATALOG, not inferred', () => {
    expect(familyOfAlias('claude-sonnet-4-5')).toBeNull();
  });

  it('is null for an empty or unrelated string', () => {
    expect(familyOfAlias('')).toBeNull();
    expect(familyOfAlias('gpt-4')).toBeNull();
  });
});

describe('isFilingProject', () => {
  it('accepts a personal-space project — no repo, no ticket prefix', () => {
    expect(isFilingProject(proj())).toBe(true);
  });

  it('accepts a bare repo with no ticket prefix, the pre-existing agent-project set', () => {
    expect(isFilingProject(proj({ path: '/repos/agent' }))).toBe(true);
  });

  it('accepts a repo that also owns a ticket board', () => {
    expect(isFilingProject(proj({ path: '/repos/agent', ticketPrefix: 'TM' }))).toBe(true);
  });

  it('rejects a ticket board with no repo of its own — that project already IS a board', () => {
    expect(isFilingProject(proj({ ticketPrefix: 'TM' }))).toBe(false);
  });

  it('rejects a plan-driven project, repo or not', () => {
    expect(isFilingProject(proj({ planPath: '/repo/plan.md', path: '/repo' }))).toBe(false);
  });
});

describe('EFFORTS / isEffort', () => {
  it('lists the CLI --effort values, lowest first', () => {
    expect([...EFFORTS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('accepts only those values', () => {
    for (const effort of EFFORTS) expect(isEffort(effort)).toBe(true);
    expect(isEffort('HIGH')).toBe(false);
    expect(isEffort('')).toBe(false);
    expect(isEffort(null)).toBe(false);
    expect(isEffort(3)).toBe(false);
  });
});

describe('AGENT_ROLES / ROLE_CAPTIONS', () => {
  it('lists the four roles in the order the Start dialog shows them, each captioned', () => {
    expect([...AGENT_ROLES]).toEqual(['lead', 'planner', 'workers', 'reviewer']);
    expect(ROLE_CAPTIONS).toEqual({
      lead: 'orchestrates and reviews',
      planner: 'writes the plan',
      workers: 'build the parts',
      reviewer: 'final code review',
    });
  });
});

/** The card field, and the project field, each role's model ladder reads first. */
const MODEL_FIELDS: Record<AgentRole, [keyof Task, keyof Project | null]> = {
  lead: ['agentLeadModel', 'leadModel'],
  planner: ['agentPlanningModel', 'planningModel'],
  workers: ['agentModel', null],
  reviewer: ['agentReviewModel', 'reviewModel'],
};

/** A project with every model rung empty but the execution model. */
const bareProject = {
  defaultModel: 'haiku' as ClaudeModel,
  planningModel: null,
  reviewModel: null,
  leadModel: null,
};

describe('resolveRoleModel', () => {
  for (const role of AGENT_ROLES) {
    const [taskField, projectField] = MODEL_FIELDS[role];

    it(`${role}: the card's choice wins over the project's`, () => {
      const project = projectField ? { ...bareProject, [projectField]: 'sonnet' } : bareProject;
      expect(resolveRoleModel(role, { [taskField]: 'opus' }, project)).toBe('opus');
    });

    it(`${role}: the project's choice wins when the card says nothing`, () => {
      const project = projectField
        ? { ...bareProject, [projectField]: 'sonnet' }
        : { ...bareProject, defaultModel: 'sonnet' };
      expect(resolveRoleModel(role, { [taskField]: null }, project)).toBe('sonnet');
      expect(resolveRoleModel(role, null, project)).toBe('sonnet');
    });

    it(`${role}: falls to the execution model when nothing else is set`, () => {
      expect(resolveRoleModel(role, {}, bareProject)).toBe('haiku');
      expect(resolveRoleModel(role, null, bareProject)).toBe('haiku');
    });
  }

  it('lead and reviewer fall to the planning model before the execution model', () => {
    const project = { ...bareProject, planningModel: 'opus' };
    expect(resolveRoleModel('lead', null, project)).toBe('opus');
    expect(resolveRoleModel('reviewer', null, project)).toBe('opus');
    expect(resolveRoleModel('workers', null, project)).toBe('haiku');
  });

  it("the planner falls to the card's own execution model before the project's planning one", () => {
    const project = { ...bareProject, planningModel: 'opus' };
    expect(resolveRoleModel('planner', { agentModel: 'sonnet' }, project)).toBe('sonnet');
    // …but the lead and the reviewer never read the card's execution model.
    expect(resolveRoleModel('lead', { agentModel: 'sonnet' }, project)).toBe('opus');
    expect(resolveRoleModel('reviewer', { agentModel: 'sonnet' }, project)).toBe('opus');
  });

  it('matches resolveRunModel for planning and steps', () => {
    const project = { ...bareProject, planningModel: 'opus' };
    const task = { agentModel: 'sonnet', agentPlanningModel: null };
    expect(resolveRoleModel('planner', task, project)).toBe(resolveRunModel(task, project, true));
    expect(resolveRoleModel('workers', task, project)).toBe(resolveRunModel(task, project, false));
  });
});

/** The card field, and the project field, each role's effort ladder reads. */
const EFFORT_FIELDS: Record<AgentRole, [keyof Task, keyof Project]> = {
  lead: ['agentLeadEffort', 'leadEffort'],
  planner: ['agentPlanningEffort', 'planningEffort'],
  workers: ['agentEffort', 'workerEffort'],
  reviewer: ['agentReviewEffort', 'reviewEffort'],
};

const settings: { defaultEfforts: Record<AgentRole, Effort> } = {
  defaultEfforts: { lead: 'max', planner: 'xhigh', workers: 'medium', reviewer: 'low' },
};

describe('resolveRoleEffort', () => {
  for (const role of AGENT_ROLES) {
    const [taskField, projectField] = EFFORT_FIELDS[role];

    it(`${role}: the card's effort wins over the project's`, () => {
      expect(
        resolveRoleEffort(role, { [taskField]: 'high' }, { [projectField]: 'low' }, settings),
      ).toBe('high');
    });

    it(`${role}: the project's effort wins when the card says nothing`, () => {
      expect(
        resolveRoleEffort(role, { [taskField]: null }, { [projectField]: 'high' }, settings),
      ).toBe('high');
      expect(resolveRoleEffort(role, null, { [projectField]: 'high' }, settings)).toBe('high');
    });

    it(`${role}: falls to the app default for that role`, () => {
      expect(resolveRoleEffort(role, {}, { [projectField]: null }, settings)).toBe(
        settings.defaultEfforts[role],
      );
      expect(resolveRoleEffort(role, null, {}, settings)).toBe(settings.defaultEfforts[role]);
    });
  }

  it("never reads another role's rung", () => {
    const task = { agentEffort: 'high' as Effort };
    const project = { workerEffort: 'high' as Effort };
    expect(resolveRoleEffort('planner', task, project, settings)).toBe('xhigh');
    expect(resolveRoleEffort('lead', task, project, settings)).toBe('max');
    expect(resolveRoleEffort('reviewer', task, project, settings)).toBe('low');
  });
});
