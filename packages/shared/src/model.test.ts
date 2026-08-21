import { describe, expect, it } from 'vitest';
import { isFilingProject, MODELS, ownsBoard, resolveRunModel, type Project } from './model';
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
