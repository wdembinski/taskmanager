import { describe, expect, it } from 'vitest';
import {
  isFilingProject,
  isUsableModel,
  MODEL_CATALOG,
  MODELS,
  ownsBoard,
  resolveRunModel,
  type Project,
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
