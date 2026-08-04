/**
 * The two decisions the planning-model UI makes that are not the dropdown's own doing:
 * what a chosen option MEANS as a stored value, and how a project's pair of models reads
 * back in the agent-project list.
 *
 * Both are silent when wrong. A sentinel mapped the wrong way stores a model the human
 * declined — and the form redisplays it as a deliberate choice, so nothing looks amiss.
 * A caption that always prints one model hides the very split the field exists to make.
 */
import { describe, expect, it } from 'vitest';
import { planningModelFromOption, SAME_AS_EXECUTION } from './PlanningModelField';
import { modelCaption } from './AgentProjects';

describe('planningModelFromOption', () => {
  it('maps the sentinel to null — "plan on whatever you execute on"', () => {
    expect(planningModelFromOption(SAME_AS_EXECUTION)).toBeNull();
  });

  it('maps a model name to itself', () => {
    expect(planningModelFromOption('opus')).toBe('opus');
    expect(planningModelFromOption('haiku')).toBe('haiku');
  });

  it('treats a Dropdown that hands back nothing as the empty choice, not a crash', () => {
    expect(planningModelFromOption(undefined)).toBeNull();
  });

  it('uses a sentinel no model can collide with', () => {
    expect(planningModelFromOption(SAME_AS_EXECUTION)).not.toBe(SAME_AS_EXECUTION);
    expect(SAME_AS_EXECUTION.startsWith('..')).toBe(true);
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
