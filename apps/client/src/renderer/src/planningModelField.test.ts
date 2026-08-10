/**
 * The one decision the planning-model UI makes that is not the dropdown's own doing: what a
 * chosen option MEANS as a stored value.
 *
 * It is silent when wrong. A sentinel mapped the wrong way stores a model the human
 * declined — and the form redisplays it as a deliberate choice, so nothing looks amiss.
 * How the pair then READS back is `modelChoice.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { planningModelFromOption, SAME_AS_EXECUTION } from './PlanningModelField';

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
