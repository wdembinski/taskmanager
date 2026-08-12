/**
 * "Base branch" picker — which branch a project's task branches start from and are
 * merged back into.
 *
 * Shared by the plan-project dialog and the agent-project drawer because the answer has
 * to be the same in both: the alternative is two forms that disagree about what an empty
 * value means, on a field whose whole point is that merges land where you expect.
 *
 * The list comes from the folder's git preflight, which the forms already run, so no extra
 * round trip. Two things it deliberately does NOT do:
 *   - hide the current value when the list is empty. A preflight that hasn't answered yet
 *     (or a folder git can't be reached on) must not make a saved branch look unset, so
 *     whatever is selected is always an option.
 *   - offer remote branches. Integration is a local ref move; a name only `origin` knows
 *     would fail at run time, which is a worse place to find out than this form.
 */
import { Dropdown, Field, Option } from '@fluentui/react-components';
import type { GitPreflight } from '@tm/shared/model';

/**
 * The option value standing for "don't pin one" — Dropdown can't carry an empty string.
 * `..` makes it a name git rejects for a ref, so no real branch can ever collide with it.
 */
const FOLLOW_CHECKOUT = '..follow-checkout';

export interface BaseBranchFieldProps {
  /** The chosen branch, or `''` to follow whatever the checkout has out. */
  value: string;
  onChange: (branch: string) => void;
  /** The folder's git state, for the branch list. `null` while it's still being read. */
  preflight: GitPreflight | null;
}

/** How the "follow the checkout" choice reads, naming the branch when we know it. */
function followLabel(preflight: GitPreflight | null): string {
  const branch = preflight?.branch;
  return branch ? `Current branch of the checkout (${branch})` : 'Current branch of the checkout';
}

export function BaseBranchField({ value, onChange, preflight }: BaseBranchFieldProps): JSX.Element {
  const listed = preflight?.branches ?? [];
  // The saved value first, so it survives a preflight that hasn't answered (or can't).
  const branches = [...new Set([...(value ? [value] : []), ...listed])];

  return (
    <Field
      label="Base branch"
      hint={
        'Tasks branch from this and are merged back into it. Leave it following the checkout ' +
        'to keep the old behaviour. Pinning a branch you do NOT keep checked out is the ' +
        'sturdier setup: merging then only moves the branch pointer, so your uncommitted work ' +
        'in the folder can never block it.'
      }
    >
      <Dropdown
        value={value || followLabel(preflight)}
        selectedOptions={[value || FOLLOW_CHECKOUT]}
        onOptionSelect={(_e, d) =>
          onChange(d.optionValue === FOLLOW_CHECKOUT ? '' : (d.optionValue ?? ''))
        }
      >
        <Option value={FOLLOW_CHECKOUT}>{followLabel(preflight)}</Option>
        {branches.map((branch) => (
          <Option key={branch} value={branch}>
            {branch}
          </Option>
        ))}
      </Dropdown>
    </Field>
  );
}
