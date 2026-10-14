/**
 * "Subagent model" picker — which model every subagent a session spawns runs on,
 * beside the model the session itself runs on.
 *
 * Shaped exactly like `PlanningModelField` (same empty-choice-first, same `null`
 * means "don't decide this separately"), but with a STATIC sentinel label rather
 * than one naming a concrete model: `AppSettings.subagentModel` is a single global
 * setting applied to every session, not a per-project seed with one fixed model to
 * defer to — so "Same as the session" is as specific as the empty choice can be.
 *
 * Renders through `ModelField` for the catalog, the CLI-probed captions and the
 * custom-id box, same as `PlanningModelField`.
 */
import { ModelField } from './ModelField';

/**
 * The option value standing for `null` — Dropdown can't carry one. The leading `..`
 * keeps it out of the model namespace, same trick as `PlanningModelField`'s
 * `SAME_AS_EXECUTION`.
 */
export const SAME_AS_SESSION = '..same-as-session';

/**
 * What the dropdown's chosen option means as a stored value: the sentinel and a
 * Dropdown that hands back nothing both mean `null` — "subagents inherit the
 * session's own model".
 */
export function subagentModelFromOption(optionValue: string | undefined): string | null {
  return optionValue && optionValue !== SAME_AS_SESSION ? optionValue : null;
}

export interface SubagentModelFieldProps {
  label: string;
  /** The chosen model, or `null` for every subagent to inherit the session's own. */
  value: string | null;
  onChange: (model: string | null) => void;
  hint?: string;
  className?: string;
}

export function SubagentModelField({
  label,
  value,
  onChange,
  hint,
  className,
}: SubagentModelFieldProps): JSX.Element {
  return (
    <ModelField
      label={label}
      hint={hint}
      className={className}
      value={value ?? SAME_AS_SESSION}
      onChange={(v) => onChange(subagentModelFromOption(v))}
      sentinel={{ value: SAME_AS_SESSION, label: 'Same as the session' }}
    />
  );
}
