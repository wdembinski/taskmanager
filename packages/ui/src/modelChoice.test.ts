/**
 * What the card-side model controls store, and what they claim.
 *
 * Both fail silently. A sentinel mapped the wrong way pins a model the human declined — and
 * every control redisplays it as a deliberate choice, so the card quietly stops following
 * its project. A caption that names one model where the project has two hides the very split
 * these screens exist to make, and reads as a complete answer while doing it.
 *
 * The captions also take an optional `labelOf` — a model id to the CLI's own display name —
 * so a project that has actually split planning from execution can read `Opus 4.7 planning ·
 * Haiku 4.5 steps` instead of two raw ids. Every test above this point calls with no `labelOf`
 * at all, which is the point: every existing caller, not yet wired to a catalog, must keep
 * reading exactly as it did before that lookup existed.
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

describe('label-aware captions', () => {
  const labelOf = (id: string): string =>
    ({ sonnet: 'Sonnet 5', opus: 'Opus 4.7', haiku: 'Haiku 4.5' })[id] ?? id;

  it('modelCaption labels the one model while planning follows execution', () => {
    expect(modelCaption({ defaultModel: 'sonnet', planningModel: null }, labelOf)).toBe('Sonnet 5');
  });

  it('modelCaption labels both once they differ, exactly as the ids would read unlabelled', () => {
    expect(modelCaption({ defaultModel: 'haiku', planningModel: 'opus' }, labelOf)).toBe(
      'Opus 4.7 planning · Haiku 4.5 steps',
    );
  });

  it('projectDefaultLabel carries the label through', () => {
    expect(projectDefaultLabel({ defaultModel: 'haiku', planningModel: 'opus' }, labelOf)).toBe(
      'Project default · Opus 4.7 planning · Haiku 4.5 steps',
    );
  });

  it("cardModelCaption labels the card's own override too, not just the project fallback", () => {
    expect(
      cardModelCaption(
        { agentModel: 'opus' },
        { defaultModel: 'sonnet', planningModel: null },
        labelOf,
      ),
    ).toBe('Opus 4.7');
  });

  it('cardModelCaption labels the project split when the card has no override', () => {
    expect(
      cardModelCaption(
        { agentModel: null },
        { defaultModel: 'haiku', planningModel: 'opus' },
        labelOf,
      ),
    ).toBe('Opus 4.7 planning · Haiku 4.5 steps');
  });

  it('a model id the lookup does not know about reads back unchanged', () => {
    expect(modelCaption({ defaultModel: 'claude-opus-4-9', planningModel: null }, labelOf)).toBe(
      'claude-opus-4-9',
    );
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
