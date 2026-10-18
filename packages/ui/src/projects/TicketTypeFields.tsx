/**
 * The Issue-type + Epic pickers, shared between every place a ticket's type is chosen — the
 * shared ticket panel (`TicketFieldsSection.tsx`, editing an existing ticket) and the
 * Add-task dialog (creating one straight onto a ticket board). Both need the exact same
 * rule for the two fields to ever agree: an epic cannot itself hang under another epic
 * (`assertTicketRefs` in `ipc.ts`), so the Epic picker is disabled — and cleared, so a value
 * picked before switching to Epic is never silently carried into a create/update call the
 * store would refuse — the moment Type reads `epic`.
 *
 * Fully controlled, like `ProjectBasicsFields`: no fetching, no local state, just the two
 * `Field`s. The caller owns `epicCandidates` because who is eligible differs by context — the
 * drawer excludes the ticket being edited, the Add-task dialog has no ticket yet to exclude.
 */
import { Dropdown, Field, Option, makeStyles } from '@fluentui/react-components';
import type { IssueType, Task } from '@tm/shared/model';
import { ISSUE_TYPES } from '@tm/shared/tickets';

/** Sentinel for "no epic" in the Epic dropdown (an `Option` needs a value). */
const NO_EPIC = '';

/** Fluent's `Dropdown` sizes its trigger to its widest option by default — an epic's title
 *  can run far longer than the `Field` wrapping it, which is how the Epic picker overflowed
 *  the panel's right edge (border cut off) while the shorter `issueType` list never visibly
 *  did. `width: 100%` plus `minWidth: 0` makes both pickers obey the `Field`'s own width
 *  instead of their content's. */
const useStyles = makeStyles({
  dropdown: { width: '100%', minWidth: 0 },
});

export interface TicketTypeFieldsProps {
  issueType: IssueType;
  /** `''` for none — a `Dropdown` cannot carry `null`. */
  epicTaskId: string;
  /** Epics this ticket may be filed under — already filtered to `isEpic` and, where the
   *  caller has one, excluding the ticket being edited. */
  epicCandidates: Task[];
  onIssueTypeChange: (issueType: IssueType) => void;
  onEpicTaskIdChange: (epicTaskId: string) => void;
  /** Applied to both `Field`s, so a caller laying them out in a row can size them evenly. */
  className?: string;
  /** Disables both pickers — a read-only host, not the epic-under-epic rule below. */
  disabled?: boolean;
}

export function TicketTypeFields({
  issueType,
  epicTaskId,
  epicCandidates,
  onIssueTypeChange,
  onEpicTaskIdChange,
  className,
  disabled = false,
}: TicketTypeFieldsProps): JSX.Element {
  const styles = useStyles();
  return (
    <>
      <Field label="Type" className={className}>
        <Dropdown
          className={styles.dropdown}
          value={issueType}
          selectedOptions={[issueType]}
          disabled={disabled}
          onOptionSelect={(_e, d) => {
            if (!d.optionValue) return;
            const next = d.optionValue as IssueType;
            onIssueTypeChange(next);
            // See the doc comment: an epic cannot hang under another epic, so a value
            // picked while Type was something else cannot survive the switch.
            if (next === 'epic' && epicTaskId) onEpicTaskIdChange(NO_EPIC);
          }}
        >
          {ISSUE_TYPES.map((t) => (
            <Option key={t} value={t}>
              {t}
            </Option>
          ))}
        </Dropdown>
      </Field>

      <Field label="Epic" className={className}>
        <Dropdown
          className={styles.dropdown}
          disabled={disabled || issueType === 'epic'}
          value={epicCandidates.find((e) => e.id === epicTaskId)?.title ?? 'None'}
          selectedOptions={[epicTaskId || NO_EPIC]}
          onOptionSelect={(_e, d) => {
            if (d.optionValue !== undefined) onEpicTaskIdChange(d.optionValue);
          }}
        >
          {epicCandidates.map((e) => (
            <Option key={e.id} value={e.id} text={e.title}>
              {e.title}
            </Option>
          ))}
          <Option value={NO_EPIC}>None</Option>
        </Dropdown>
      </Field>
    </>
  );
}
