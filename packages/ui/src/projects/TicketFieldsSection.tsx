/**
 * The twelve ticket-only fields of a native ticket — type, epic, milestone, labels, story
 * points, estimate, start, due, assignee and reporter — plus the label and milestone
 * managers and the read-only delegated-agent indicator. Lives apart from `TicketDrawer` so
 * the same section is also what `TaskTicketSection` renders inside `TaskDetail`'s own band
 * (F12.4), behind its fold, without the drawer's chrome coming with it.
 *
 * **Each field saves itself**, on change for a picker and on blur for text, through
 * `ticket:update` with a one-field patch from {@link ticketPatchFor} (`ticketFields.ts`) —
 * there is no Save button here, the same discipline the description already follows in
 * `TaskDetailsCell`. A refused save is shown inline under the field that sent it
 * (`Field.validationMessage`), and the field itself keeps whatever the ticket's prop still
 * says, exactly like a refused ticket link stays unlinked.
 *
 * The picker fields (type, epic, milestone, assignee, reporter) read straight from `ticket`
 * rather than mirroring it into local state — once a save lands, the caller's list is
 * rebroadcast (`project:tasksChanged`) and flows back down as a new `ticket` prop, so the
 * dropdown is never out of step with what was actually written and a refused save needs no
 * revert. Only the TEXT fields are a `useDraft` (`../drafts`), keyed on the ticket's id —
 * `TaskDetail`'s own rule: switching to a different row and back must not have eaten
 * whatever was half typed.
 */
import { useState } from 'react';
import {
  Badge,
  Button,
  Dropdown,
  Field,
  Input,
  Option,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Subtitle2,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { SettingsRegular } from '@fluentui/react-icons';
import type { Milestone, Person, Project, Task, TicketLabel } from '@tm/shared/model';
import { delegatedAgentName, isEpic } from '@tm/shared/tickets';
import { draftKey, useDraft } from '../drafts';
import { useTransport } from '../transport';
import { AssigneeDisplay } from './AssigneeDisplay';
import { LabelRegistry } from './LabelRegistry';
import { MilestoneList } from './MilestoneList';
import { PersonAvatar } from './PersonAvatar';
import { dateToInput, splitLabels, ticketPatchFor, type TicketDraft } from './ticketFields';
import { TicketTypeFields } from './TicketTypeFields';

const NONE = '';

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: '12px' },
  row: { display: 'flex', gap: '12px' },
  cell: { flex: 1, minWidth: 0 },
  labelsRow: { display: 'flex', alignItems: 'flex-end', gap: '6px' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: '4px' },
  optionRow: { display: 'flex', alignItems: 'center', gap: '6px' },
  agentRow: { display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px' },
  agentSep: { color: tokens.colorNeutralForeground3 },
});

export interface TicketFieldsSectionProps {
  ticket: Task;
  /** This project's other tickets — epic candidates. */
  tickets: Task[];
  /** App-wide roster, for the assignee/reporter pickers. */
  people: Person[];
  /** The repos a ticket can be delegated to — resolves `ticket.agentProjectId` to a name
   *  for the read-only agent indicator beside the (still human-editable) Assignee field. */
  agentProjects: Project[];
  /** This project's label registry. */
  labels: TicketLabel[];
  /** This project's milestones. */
  milestones: Milestone[];
}

function labelColor(labels: TicketLabel[], name: string): string | undefined {
  return labels.find((l) => l.name.toLowerCase() === name.toLowerCase())?.color || undefined;
}

export function TicketFieldsSection({
  ticket,
  tickets,
  people,
  agentProjects,
  labels,
  milestones,
}: TicketFieldsSectionProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();

  /** One inline message per field, cleared on the next attempt or the next success. */
  const [errors, setErrors] = useState<Partial<Record<keyof TicketDraft, string>>>({});

  const labelsDraft = useDraft(draftKey(ticket.id, 'labelsText'), (ticket.labels ?? []).join(', '));
  const storyPointsDraft = useDraft(
    draftKey(ticket.id, 'storyPoints'),
    ticket.storyPoints == null ? '' : String(ticket.storyPoints),
  );
  const estimateDaysDraft = useDraft(
    draftKey(ticket.id, 'estimateDays'),
    ticket.estimateDays == null ? '' : String(ticket.estimateDays),
  );
  const startAtDraft = useDraft(
    draftKey(ticket.id, 'startAt'),
    dateToInput(ticket.startAt ?? null),
  );
  const dueAtDraft = useDraft(draftKey(ticket.id, 'dueAt'), dateToInput(ticket.dueAt ?? null));

  const epicCandidates = tickets.filter((t) => isEpic(t) && t.id !== ticket.id);
  const previewLabels = splitLabels(labelsDraft.value);
  // Read-only — delegation happens from the assign dialog, not this dropdown, so this
  // section only ever displays `agentProjectId`, never edits it.
  const agentName = delegatedAgentName(
    ticket,
    agentProjects.find((p) => p.id === ticket.agentProjectId)?.name,
  );

  /** Save one field's new value, or do nothing when it did not actually change. */
  async function saveField<K extends keyof TicketDraft>(
    field: K,
    value: TicketDraft[K],
  ): Promise<boolean> {
    const patch = ticketPatchFor(field, value, ticket);
    if (Object.keys(patch).length === 0) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
      return true;
    }
    try {
      await transport.invoke('ticket:update', ticket.id, patch);
      setErrors((prev) => ({ ...prev, [field]: undefined }));
      return true;
    } catch (e) {
      setErrors((prev) => ({ ...prev, [field]: e instanceof Error ? e.message : String(e) }));
      return false;
    }
  }

  /** A text draft's blur handler: save, and only forget the parked draft on success — a
   *  refusal leaves the typed text on screen, with the error shown under the field. */
  function saveDraft(field: keyof TicketDraft, draft: { value: string; commit: () => void }): void {
    void saveField(field, draft.value).then((ok) => {
      if (ok) draft.commit();
    });
  }

  return (
    <div className={styles.form}>
      <div className={styles.row}>
        <TicketTypeFields
          issueType={ticket.issueType ?? 'task'}
          epicTaskId={ticket.epicTaskId ?? NONE}
          epicCandidates={epicCandidates}
          onIssueTypeChange={(v) => void saveField('issueType', v)}
          onEpicTaskIdChange={(v) => void saveField('epicTaskId', v)}
          className={styles.cell}
        />
      </div>

      <div className={styles.row}>
        <Field
          label="Milestone"
          className={styles.cell}
          validationState={errors.milestoneId ? 'error' : 'none'}
          validationMessage={errors.milestoneId}
        >
          <div className={styles.labelsRow}>
            <Dropdown
              className={styles.cell}
              value={milestones.find((m) => m.id === ticket.milestoneId)?.name ?? 'None'}
              selectedOptions={[ticket.milestoneId ?? NONE]}
              onOptionSelect={(_e, d) => {
                if (d.optionValue !== undefined) void saveField('milestoneId', d.optionValue);
              }}
            >
              {milestones
                .filter((m) => !m.closed || m.id === ticket.milestoneId)
                .map((m) => (
                  <Option key={m.id} value={m.id} text={m.name}>
                    {m.name}
                    {m.closed ? ' (closed)' : ''}
                  </Option>
                ))}
              <Option value={NONE}>None</Option>
            </Dropdown>
            <Popover trapFocus>
              <PopoverTrigger disableButtonEnhancement>
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<SettingsRegular />}
                  title="Manage milestones"
                  aria-label="Manage milestones"
                />
              </PopoverTrigger>
              <PopoverSurface>
                <Subtitle2>Milestones</Subtitle2>
                <MilestoneList projectId={ticket.projectId} milestones={milestones} />
              </PopoverSurface>
            </Popover>
          </div>
        </Field>
      </div>

      <Field
        label="Labels"
        hint="Comma-separated."
        validationState={errors.labelsText ? 'error' : 'none'}
        validationMessage={errors.labelsText}
      >
        <div className={styles.labelsRow}>
          <Input
            className={styles.cell}
            value={labelsDraft.value}
            onChange={(_e, d) => labelsDraft.set(d.value)}
            onBlur={() => saveDraft('labelsText', labelsDraft)}
            placeholder="backend, needs-design"
          />
          <Popover trapFocus>
            <PopoverTrigger disableButtonEnhancement>
              <Button
                size="small"
                appearance="subtle"
                icon={<SettingsRegular />}
                title="Manage labels"
                aria-label="Manage labels"
              />
            </PopoverTrigger>
            <PopoverSurface>
              <Subtitle2>Labels</Subtitle2>
              <LabelRegistry projectId={ticket.projectId} labels={labels} />
            </PopoverSurface>
          </Popover>
        </div>
        {previewLabels.length > 0 && (
          <div className={styles.chips}>
            {previewLabels.map((name) => (
              <Badge
                key={name}
                appearance="tint"
                style={
                  labelColor(labels, name)
                    ? { backgroundColor: labelColor(labels, name) }
                    : undefined
                }
              >
                {name}
              </Badge>
            ))}
          </div>
        )}
      </Field>

      <div className={styles.row}>
        <Field
          label="Story points"
          className={styles.cell}
          validationState={errors.storyPointsText ? 'error' : 'none'}
          validationMessage={errors.storyPointsText}
        >
          <Input
            value={storyPointsDraft.value}
            onChange={(_e, d) => storyPointsDraft.set(d.value)}
            onBlur={() => saveDraft('storyPointsText', storyPointsDraft)}
            placeholder="Not estimated"
          />
        </Field>
        <Field
          label="Estimate (days)"
          className={styles.cell}
          validationState={errors.estimateDaysText ? 'error' : 'none'}
          validationMessage={errors.estimateDaysText}
        >
          <Input
            value={estimateDaysDraft.value}
            onChange={(_e, d) => estimateDaysDraft.set(d.value)}
            onBlur={() => saveDraft('estimateDaysText', estimateDaysDraft)}
            placeholder="Not estimated"
          />
        </Field>
      </div>

      <div className={styles.row}>
        <Field
          label="Start"
          className={styles.cell}
          validationState={errors.startAtInput ? 'error' : 'none'}
          validationMessage={errors.startAtInput}
        >
          <Input
            type="date"
            value={startAtDraft.value}
            onChange={(_e, d) => startAtDraft.set(d.value)}
            onBlur={() => saveDraft('startAtInput', startAtDraft)}
          />
        </Field>
        <Field
          label="Due"
          className={styles.cell}
          validationState={errors.dueAtInput ? 'error' : 'none'}
          validationMessage={errors.dueAtInput}
        >
          <Input
            type="date"
            value={dueAtDraft.value}
            onChange={(_e, d) => dueAtDraft.set(d.value)}
            onBlur={() => saveDraft('dueAtInput', dueAtDraft)}
          />
        </Field>
      </div>

      <div className={styles.row}>
        <Field
          label="Assignee"
          className={styles.cell}
          validationState={errors.assigneeId ? 'error' : 'none'}
          validationMessage={errors.assigneeId}
        >
          <Dropdown
            value={people.find((p) => p.id === ticket.assigneeId)?.name ?? 'Unassigned'}
            selectedOptions={[ticket.assigneeId ?? NONE]}
            onOptionSelect={(_e, d) => {
              if (d.optionValue !== undefined) void saveField('assigneeId', d.optionValue);
            }}
          >
            {people.map((p) => (
              <Option key={p.id} value={p.id} text={p.name}>
                <div className={styles.optionRow}>
                  <PersonAvatar person={p} size={20} />
                  {p.name}
                </div>
              </Option>
            ))}
            <Option value={NONE}>Unassigned</Option>
          </Dropdown>
          {agentName && (
            <div className={styles.agentRow}>
              <Text className={styles.agentSep}>/</Text>
              <AssigneeDisplay agentName={agentName} variant="text" size={20} />
            </div>
          )}
        </Field>
        <Field
          label="Reporter"
          className={styles.cell}
          validationState={errors.reporterId ? 'error' : 'none'}
          validationMessage={errors.reporterId}
        >
          <Dropdown
            value={people.find((p) => p.id === ticket.reporterId)?.name ?? 'None'}
            selectedOptions={[ticket.reporterId ?? NONE]}
            onOptionSelect={(_e, d) => {
              if (d.optionValue !== undefined) void saveField('reporterId', d.optionValue);
            }}
          >
            {people.map((p) => (
              <Option key={p.id} value={p.id} text={p.name}>
                <div className={styles.optionRow}>
                  <PersonAvatar person={p} size={20} />
                  {p.name}
                </div>
              </Option>
            ))}
            <Option value={NONE}>None</Option>
          </Dropdown>
        </Field>
      </div>
    </div>
  );
}
