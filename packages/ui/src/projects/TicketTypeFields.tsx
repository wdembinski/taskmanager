/**
 * The Issue-type + Epic pickers, shared between every place a ticket's type is chosen — the
 * drawer (`TicketDrawer.tsx`, editing an existing ticket) and the Add-task dialog (creating
 * one straight onto a ticket board). Both need the exact same rule for the two fields to
 * ever agree: an epic cannot itself hang under another epic (`assertTicketRefs` in
 * `ipc.ts`), so the Epic picker is disabled — and cleared, so a value picked before switching
 * to Epic is never silently carried into a create/update call the store would refuse — the
 * moment Type reads `epic`.
 *
 * Fully controlled, like `ProjectBasicsFields`: no fetching, no local state, just the two
 * `Field`s. The caller owns `epicCandidates` because who is eligible differs by context — the
 * drawer excludes the ticket being edited, the Add-task dialog has no ticket yet to exclude.
 */
import { Dropdown, Field, Option } from '@fluentui/react-components';
import type { IssueType, Task } from '@tm/shared/model';
import { ISSUE_TYPES } from '@tm/shared/tickets';

/** Sentinel for "no epic" in the Epic dropdown (an `Option` needs a value). */
const NO_EPIC = '';

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
}

export function TicketTypeFields({
  issueType,
  epicTaskId,
  epicCandidates,
  onIssueTypeChange,
  onEpicTaskIdChange,
  className,
}: TicketTypeFieldsProps): JSX.Element {
  return (
    <>
      <Field label="Type" className={className}>
        <Dropdown
          value={issueType}
          selectedOptions={[issueType]}
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
          disabled={issueType === 'epic'}
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
