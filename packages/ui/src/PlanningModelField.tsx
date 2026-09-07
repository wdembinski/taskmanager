/**
 * "Planning model" picker — which model a project *plans* with, beside the
 * `defaultModel` its steps *execute* with.
 *
 * Shared by the settings screen, the plan-project dialog and the agent-project drawer for
 * the same reason `BaseBranchField` is: three forms that each spelled the "same as
 * execution" choice their own way would eventually disagree about what it stores, on a
 * field whose whole point is that `null` means "don't decide this separately".
 *
 * The empty choice is the FIRST option and names the model it defers to, so the dropdown
 * answers "what will planning actually run on?" without the reader having to look at the
 * field next to it.
 *
 * Renders through {@link ModelField} for the catalog, the CLI-probed captions and the custom-id
 * box — `SAME_AS_EXECUTION` and the "Same as steps execution (…)" wording are this file's own
 * sentinel, passed through as {@link ModelFieldSentinel} rather than `ModelField` inventing one.
 */
import { ModelField } from './ModelField';
import type { ClaudeModel } from '@tm/shared/session';

/**
 * The option value standing for `null` — Dropdown can't carry one. The leading `..` keeps
 * it out of the model namespace, so a future model name can never collide with it.
 */
export const SAME_AS_EXECUTION = '..same-as-execution';

/**
 * What the dropdown's chosen option means as a stored value: the sentinel and a Dropdown
 * that hands back nothing both mean `null` — "don't decide planning separately".
 *
 * Exported so the round trip can be asserted without a DOM: getting this backwards would
 * store a model the human never picked, and the form would look right either way.
 */
export function planningModelFromOption(optionValue: string | undefined): ClaudeModel | null {
  return optionValue && optionValue !== SAME_AS_EXECUTION ? (optionValue as ClaudeModel) : null;
}

export interface PlanningModelFieldProps {
  label: string;
  /** The chosen model, or `null` to plan on whatever this project executes with. */
  value: ClaudeModel | null;
  onChange: (model: ClaudeModel | null) => void;
  /** The execution model `null` falls through to, so the empty choice can name it. */
  executionModel: ClaudeModel;
  hint?: string;
  className?: string;
}

/** How the empty choice reads, naming the model it defers to. */
function sameLabel(executionModel: ClaudeModel): string {
  return `Same as steps execution (${executionModel})`;
}

export function PlanningModelField({
  label,
  value,
  onChange,
  executionModel,
  hint,
  className,
}: PlanningModelFieldProps): JSX.Element {
  return (
    <ModelField
      label={label}
      hint={hint}
      className={className}
      value={value ?? SAME_AS_EXECUTION}
      onChange={(v) => onChange(planningModelFromOption(v))}
      sentinel={{ value: SAME_AS_EXECUTION, label: sameLabel(executionModel) }}
    />
  );
}
