/**
 * The one decision the planning-model UI makes that is not the dropdown's own doing: what a
 * chosen option MEANS as a stored value.
 *
 * It is silent when wrong. A sentinel mapped the wrong way stores a model the human
 * declined — and the form redisplays it as a deliberate choice, so nothing looks amiss.
 * How the pair then READS back is `modelChoice.test.ts`.
 *
 * The project form no longer renders this field — its Planner row is the roles table's
 * (`RolesTable`, `ROLE_DEFAULT`) — but the settings screen still does, and the two sentinels
 * must mean the same stored value: `null`, "plan on whatever you execute on".
 */
import { describe, expect, it } from 'vitest';
import { planningModelFromOption, SAME_AS_EXECUTION } from './PlanningModelField';
import { ROLE_DEFAULT, roleModelFromOption } from './rolesTableModel';

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

describe("the project form's Planner row", () => {
  it('stores its sentinel as null, the same as SAME_AS_EXECUTION does', () => {
    expect(roleModelFromOption(ROLE_DEFAULT)).toBeNull();
    expect(roleModelFromOption(ROLE_DEFAULT)).toBe(planningModelFromOption(SAME_AS_EXECUTION));
  });

  it('stores a picked model as itself, the same as this field does', () => {
    expect(roleModelFromOption('opus')).toBe(planningModelFromOption('opus'));
  });
});
