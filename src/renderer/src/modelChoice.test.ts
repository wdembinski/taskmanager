/**
 * What the card-side model controls store, and what they claim.
 *
 * Both fail silently. A sentinel mapped the wrong way pins a model the human declined — and
 * every control redisplays it as a deliberate choice, so the card quietly stops following
 * its project. A caption that names one model where the project has two hides the very split
 * these screens exist to make, and reads as a complete answer while doing it.
 */
import { describe, expect, it } from 'vitest';
import {
  cardModelCaption,
  cardModelFromOption,
  modelCaption,
  projectDefaultLabel,
  PROJECT_DEFAULT,
} from './modelChoice';

describe('cardModelFromOption', () => {
  it('maps the sentinel to null — "follow the project"', () => {
    expect(cardModelFromOption(PROJECT_DEFAULT)).toBeNull();
  });

  it('maps a model name to itself', () => {
    expect(cardModelFromOption('opus')).toBe('opus');
    expect(cardModelFromOption('haiku')).toBe('haiku');
  });

  it('treats a Dropdown that hands back nothing as the empty choice, not a crash', () => {
    expect(cardModelFromOption(undefined)).toBeNull();
  });

  it('uses a sentinel no model can collide with', () => {
    expect(cardModelFromOption(PROJECT_DEFAULT)).not.toBe(PROJECT_DEFAULT);
    expect(PROJECT_DEFAULT.startsWith('..')).toBe(true);
  });
});

describe('modelCaption', () => {
  it('names one model while planning follows execution', () => {
    expect(modelCaption({ defaultModel: 'sonnet', planningModel: null })).toBe('sonnet');
  });

  it('still names one when the planning model merely repeats it', () => {
    expect(modelCaption({ defaultModel: 'sonnet', planningModel: 'sonnet' })).toBe('sonnet');
  });

  it('names both, labelled, once they differ', () => {
    expect(modelCaption({ defaultModel: 'sonnet', planningModel: 'opus' })).toBe(
      'opus planning · sonnet steps',
    );
  });
});

describe('projectDefaultLabel', () => {
  it('names what it defers to', () => {
    expect(projectDefaultLabel({ defaultModel: 'sonnet', planningModel: null })).toBe(
      'Project default · sonnet',
    );
  });

  it('names both when the project splits them', () => {
    expect(projectDefaultLabel({ defaultModel: 'sonnet', planningModel: 'opus' })).toBe(
      'Project default · opus planning · sonnet steps',
    );
  });

  it('quotes nothing for a card with no agent project — there is no default to quote', () => {
    expect(projectDefaultLabel(null)).toBe('Project default');
  });
});

describe('cardModelCaption', () => {
  it("prints the card's own override, whatever the project says", () => {
    expect(
      cardModelCaption({ agentModel: 'haiku' }, { defaultModel: 'sonnet', planningModel: 'opus' }),
    ).toBe('haiku');
  });

  it('falls through to the project — both models, when they differ', () => {
    expect(
      cardModelCaption({ agentModel: null }, { defaultModel: 'sonnet', planningModel: 'opus' }),
    ).toBe('opus planning · sonnet steps');
  });

  it('reads an unassigned card as following a project it does not have yet', () => {
    expect(cardModelCaption({ agentModel: null }, null)).toBe('project default');
  });
});
