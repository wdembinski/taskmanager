/**
 * "Review model" picker — which model a project's AI review runs (F16) use, the rung in front
 * of `planningModel` on the ladder `reviewModel ?? planningModel ?? defaultModel`.
 *
 * The same two-state shape as {@link PlanningModelField}, for the same reason: `null` means
 * "don't decide this separately", and a form that spelled that choice its own way would
 * eventually disagree about what it stores. The empty choice is the FIRST option and names the
 * model it defers to, so the dropdown answers "what will a review actually run on?".
 */
import { ModelField } from './ModelField';
import type { ClaudeModel } from '@tm/shared/session';

/**
 * The option value standing for `null` — Dropdown can't carry one. The leading `..` keeps
 * it out of the model namespace, so a future model name can never collide with it.
 */
export const SAME_AS_PLANNING = '..same-as-planning';

/**
 * What the dropdown's chosen option means as a stored value: the sentinel and a Dropdown
 * that hands back nothing both mean `null` — "review on whatever this project plans with".
 */
export function reviewModelFromOption(optionValue: string | undefined): ClaudeModel | null {
  return optionValue && optionValue !== SAME_AS_PLANNING ? (optionValue as ClaudeModel) : null;
}

export interface ReviewModelFieldProps {
  label: string;
  /** The chosen model, or `null` to review on whatever this project plans with. */
  value: ClaudeModel | null;
  onChange: (model: ClaudeModel | null) => void;
  /**
   * The model `null` falls through to — the project's planning model, or its execution model
   * when planning isn't decided separately either — so the empty choice can name it.
   */
  planningModel: ClaudeModel;
  hint?: string;
  className?: string;
}

/** How the empty choice reads, naming the model it defers to. */
function sameLabel(planningModel: ClaudeModel): string {
  return `Same as planning (${planningModel})`;
}

export function ReviewModelField({
  label,
  value,
  onChange,
  planningModel,
  hint,
  className,
}: ReviewModelFieldProps): JSX.Element {
  return (
    <ModelField
      label={label}
      hint={hint}
      className={className}
      value={value ?? SAME_AS_PLANNING}
      onChange={(v) => onChange(reviewModelFromOption(v))}
      sentinel={{ value: SAME_AS_PLANNING, label: sameLabel(planningModel) }}
    />
  );
}
