import { describe, expect, it } from 'vitest';
import { MODELS, resolveRunModel } from './model';
import type { ClaudeModel } from './session';

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
