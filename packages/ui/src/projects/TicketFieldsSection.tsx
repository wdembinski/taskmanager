/**
 * The twelve ticket-only fields of a native ticket — type, epic, milestone, labels, story
 * points, estimate, start, due, assignee and reporter — plus the label and milestone
 * managers and the read-only delegated-agent indicator. Its own component, apart from
 * whatever renders it, so the same section is what `TaskTicketSection` renders inside
 * `TaskDetail`'s own band (F12.4), behind its fold — the one place every one of these
 * fields is edited, on every screen (F12.8).
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
  MessageBar,
  MessageBarBody,
  Option,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Subtitle2,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ArchiveRegular, SettingsRegular } from '@fluentui/react-icons';
import type { Milestone, Person, Project, Task, TicketLabel } from '@tm/shared/model';
import { delegatedAgentName, isEpic } from '@tm/shared/tickets';
import { pickableEpics, pickableMilestones } from '@tm/shared/trackerArchive';
import { draftKey, useDraft } from '../drafts';
import { useTransport } from '../transport';
import { AssigneeDisplay } from './AssigneeDisplay';
import { LabelRegistry } from './LabelRegistry';
import { MilestoneList } from './MilestoneList';
import { PersonAvatar } from './PersonAvatar';
import { dateToInput, splitLabels, ticketPatchFor, type TicketDraft } from './ticketFields';
import { offeredMilestones } from './ticketRegistries';
import { TicketTypeFields } from './TicketTypeFields';
import { useArchiveAction } from './useArchiveAction';

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
  epicArchiveRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    alignItems: 'flex-start',
  },
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
  /** Set when the host relaying ticket writes is unreachable — every field is disabled and
   *  the label/milestone manager popovers hidden, but the values are still shown. */
  readOnly?: boolean;
  /** Fields another surface already edits — the full-screen issue's property column carries
   *  Milestone and Assignee (and shows Estimate and Due), so its "More fields" fold leaves
   *  them out rather than offering a second control for the same value. */
  omit?: readonly OmittableTicketField[];
}

/** The fields {@link TicketFieldsSectionProps.omit} can leave out. */
export type OmittableTicketField = 'milestone' | 'assignee' | 'estimate' | 'due';

/**
 * One ticket field's save, and the inline message a refusal leaves — shared by this section
 * and the property column, which each mount one so a refused save outlives the editor that
 * sent it.
 */
export function useTicketFieldSave(ticket: Task): {
  errors: Partial<Record<keyof TicketDraft, string>>;
  saveField: <K extends keyof TicketDraft>(field: K, value: TicketDraft[K]) => Promise<boolean>;
  saveDraft: (field: keyof TicketDraft, draft: { value: string; commit: () => void }) => void;
} {
  const transport = useTransport();
  /** One inline message per field, cleared on the next attempt or the next success. */
  const [errors, setErrors] = useState<Partial<Record<keyof TicketDraft, string>>>({});

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

  return { errors, saveField, saveDraft };
}

/** What the two pickers the property column borrows share. */
interface TicketPickerProps {
  ticket: Task;
  readOnly?: boolean;
  /** A refused save's message, from the caller's {@link useTicketFieldSave}. */
  error?: string;
  onSave: (value: string) => void;
  className?: string;
  /**
   * The property column's editor: the bare Dropdown, no Field label or manager popover (the
   * column's own label names it, and a popover would take the focus the editor closes on),
   * focused the moment it is swapped in.
   */
  bare?: boolean;
  autoFocus?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function TicketMilestoneField({
  ticket,
  tickets,
  milestones,
  readOnly = false,
  error,
  onSave,
  className,
  bare = false,
  autoFocus,
  onOpenChange,
}: TicketPickerProps & { tickets: Task[]; milestones: Milestone[] }): JSX.Element {
  const styles = useStyles();
  const dropdown = (
    <Dropdown
      className={styles.cell}
      value={milestones.find((m) => m.id === ticket.milestoneId)?.name ?? 'None'}
      selectedOptions={[ticket.milestoneId ?? NONE]}
      disabled={readOnly}
      autoFocus={autoFocus}
      onOpenChange={onOpenChange && ((_e, d) => onOpenChange(d.open))}
      onOptionSelect={(_e, d) => {
        if (d.optionValue !== undefined) onSave(d.optionValue);
      }}
    >
      {pickableMilestones(
        offeredMilestones(milestones, ticket.milestoneId),
        ticket.milestoneId,
      ).map((m) => (
        <Option key={m.id} value={m.id} text={m.name}>
          {m.name}
          {m.closed ? ' (closed)' : ''}
        </Option>
      ))}
      <Option value={NONE}>None</Option>
    </Dropdown>
  );
  if (bare) return dropdown;
  return (
    <Field
      label="Milestone"
      className={className}
      validationState={error ? 'error' : 'none'}
      validationMessage={error}
    >
      <div className={styles.labelsRow}>
        {dropdown}
        {!readOnly && (
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
              <MilestoneList
                projectId={ticket.projectId}
                milestones={milestones}
                tickets={tickets}
              />
            </PopoverSurface>
          </Popover>
        )}
      </div>
    </Field>
  );
}

export function TicketAssigneeField({
  ticket,
  people,
  agentName,
  readOnly = false,
  error,
  onSave,
  className,
  bare = false,
  autoFocus,
  onOpenChange,
}: TicketPickerProps & { people: Person[]; agentName?: string }): JSX.Element {
  const styles = useStyles();
  const dropdown = (
    <Dropdown
      value={people.find((p) => p.id === ticket.assigneeId)?.name ?? 'Unassigned'}
      selectedOptions={[ticket.assigneeId ?? NONE]}
      disabled={readOnly}
      autoFocus={autoFocus}
      onOpenChange={onOpenChange && ((_e, d) => onOpenChange(d.open))}
      onOptionSelect={(_e, d) => {
        if (d.optionValue !== undefined) onSave(d.optionValue);
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
  );
  if (bare) return dropdown;
  return (
    <Field
      label="Assignee"
      className={className}
      validationState={error ? 'error' : 'none'}
      validationMessage={error}
    >
      {dropdown}
      {agentName && (
        <div className={styles.agentRow}>
          <Text className={styles.agentSep}>/</Text>
          <AssigneeDisplay agentName={agentName} variant="text" size={20} />
        </div>
      )}
    </Field>
  );
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
  readOnly = false,
  omit = [],
}: TicketFieldsSectionProps): JSX.Element {
  const styles = useStyles();
  const { archive } = useArchiveAction();
  const { errors, saveField, saveDraft } = useTicketFieldSave(ticket);
  const shown = (field: OmittableTicketField): boolean => !omit.includes(field);
  const [epicArchiveError, setEpicArchiveError] = useState<string | null>(null);
  const [epicArchiveBusy, setEpicArchiveBusy] = useState(false);

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

  const epicCandidates = pickableEpics(
    tickets.filter((t) => isEpic(t) && t.id !== ticket.id),
    ticket.epicTaskId,
  );
  const previewLabels = splitLabels(labelsDraft.value);
  // Read-only — delegation happens from the assign dialog, not this dropdown, so this
  // section only ever displays `agentProjectId`, never edits it.
  const agentName = delegatedAgentName(
    ticket,
    agentProjects.find((p) => p.id === ticket.agentProjectId)?.name,
  );

  /** One click, Undo included — an epic has no open-ticket choice to make, unlike a
   *  milestone: archiving it never moves anything, it only hides the epic itself. */
  async function archiveEpic(): Promise<void> {
    setEpicArchiveError(null);
    setEpicArchiveBusy(true);
    try {
      const result = await archive(
        { kind: 'epic', id: ticket.id },
        ticket.ticketKey ?? ticket.title,
      );
      if (!result.ok) setEpicArchiveError(result.message);
    } finally {
      setEpicArchiveBusy(false);
    }
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
          disabled={readOnly}
        />
      </div>

      {shown('milestone') && (
        <div className={styles.row}>
          <TicketMilestoneField
            className={styles.cell}
            ticket={ticket}
            tickets={tickets}
            milestones={milestones}
            readOnly={readOnly}
            error={errors.milestoneId}
            onSave={(v) => void saveField('milestoneId', v)}
          />
        </div>
      )}

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
            disabled={readOnly}
            onChange={(_e, d) => labelsDraft.set(d.value)}
            onBlur={() => saveDraft('labelsText', labelsDraft)}
            placeholder="backend, needs-design"
          />
          {!readOnly && (
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
          )}
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
            disabled={readOnly}
            onChange={(_e, d) => storyPointsDraft.set(d.value)}
            onBlur={() => saveDraft('storyPointsText', storyPointsDraft)}
            placeholder="Not estimated"
          />
        </Field>
        {shown('estimate') && (
          <Field
            label="Estimate (days)"
            className={styles.cell}
            validationState={errors.estimateDaysText ? 'error' : 'none'}
            validationMessage={errors.estimateDaysText}
          >
            <Input
              value={estimateDaysDraft.value}
              disabled={readOnly}
              onChange={(_e, d) => estimateDaysDraft.set(d.value)}
              onBlur={() => saveDraft('estimateDaysText', estimateDaysDraft)}
              placeholder="Not estimated"
            />
          </Field>
        )}
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
            disabled={readOnly}
            onChange={(_e, d) => startAtDraft.set(d.value)}
            onBlur={() => saveDraft('startAtInput', startAtDraft)}
          />
        </Field>
        {shown('due') && (
          <Field
            label="Due"
            className={styles.cell}
            validationState={errors.dueAtInput ? 'error' : 'none'}
            validationMessage={errors.dueAtInput}
          >
            <Input
              type="date"
              value={dueAtDraft.value}
              disabled={readOnly}
              onChange={(_e, d) => dueAtDraft.set(d.value)}
              onBlur={() => saveDraft('dueAtInput', dueAtDraft)}
            />
          </Field>
        )}
      </div>

      <div className={styles.row}>
        {shown('assignee') && (
          <TicketAssigneeField
            className={styles.cell}
            ticket={ticket}
            people={people}
            agentName={agentName}
            readOnly={readOnly}
            error={errors.assigneeId}
            onSave={(v) => void saveField('assigneeId', v)}
          />
        )}
        <Field
          label="Reporter"
          className={styles.cell}
          validationState={errors.reporterId ? 'error' : 'none'}
          validationMessage={errors.reporterId}
        >
          <Dropdown
            value={people.find((p) => p.id === ticket.reporterId)?.name ?? 'None'}
            selectedOptions={[ticket.reporterId ?? NONE]}
            disabled={readOnly}
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

      {isEpic(ticket) && !readOnly && ticket.trackerArchivedAt == null && (
        <div className={styles.epicArchiveRow}>
          {epicArchiveError && (
            <MessageBar intent="error">
              <MessageBarBody>{epicArchiveError}</MessageBarBody>
            </MessageBar>
          )}
          <Button
            appearance="outline"
            size="small"
            icon={<ArchiveRegular />}
            disabled={epicArchiveBusy}
            onClick={() => void archiveEpic()}
          >
            Archive epic
          </Button>
        </div>
      )}
    </div>
  );
}
