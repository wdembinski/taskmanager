/**
 * TicketDrawer — the one place every field of a native ticket has to be edited (Phase 24).
 *
 * Title, description and priority are deliberately absent: they go through the channels
 * every other card already uses (`task:setDescription`, `task:setPriority`), same as
 * `TicketPatch`'s own doc comment says. What is here is the twelve ticket-only fields that
 * channel edits, plus the two registries a ticket draws from (labels, milestones) and the
 * relationships it can have to other tickets — bundled into one drawer rather than three
 * separate screens, because a label or milestone only ever needs editing from the ticket
 * that is about to wear it.
 *
 * `ticket`/`onClose` make this a controlled drawer: the caller (`BacklogTable`) owns which
 * ticket is selected, and passes the live row straight through — after a save,
 * `ticket:update`'s `project:tasksChanged` broadcast updates the caller's list, which flows
 * back down as a new `ticket` prop, with no callback needed here.
 *
 * Every TEXT field is a `useDraft` (`../drafts`), keyed on the ticket's id — `TaskDetail`'s
 * own rule: switching to a different row and back must not have eaten whatever was half
 * typed. The picker fields (type, epic, milestone, assignee, reporter) are plain state,
 * reseeded per ticket — losing an unsaved click is a far smaller loss than losing typed
 * text, and giving all nine fields the full draft machinery would not buy back much more.
 */
import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Caption1,
  Divider,
  Dropdown,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerHeaderTitle,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  OverlayDrawer,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Subtitle2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { DismissRegular, SettingsRegular } from '@fluentui/react-icons';
import type { IssueType, Milestone, Person, Task, TicketLabel } from '@tm/shared/model';
import { ISSUE_TYPES } from '@tm/shared/tickets';
import { draftKey, useDraft } from '../drafts';
import { useTransport } from '../transport';
import { LabelRegistry } from './LabelRegistry';
import { MilestoneList } from './MilestoneList';
import { PersonAvatar } from './PersonAvatar';
import { dateToInput, splitLabels, ticketPatchFrom, type TicketDraft } from './ticketFields';
import { TicketLinksEditor } from './TicketLinksEditor';

const NONE = '';

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '420px' },
  row: { display: 'flex', gap: '12px' },
  cell: { flex: 1, minWidth: 0 },
  labelsRow: { display: 'flex', alignItems: 'flex-end', gap: '6px' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: '4px' },
  saved: { color: tokens.colorPaletteGreenForeground1 },
  optionRow: { display: 'flex', alignItems: 'center', gap: '6px' },
  key: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    color: tokens.colorNeutralForeground3,
  },
});

export interface TicketDrawerProps {
  /** The ticket being edited; `null` means the drawer is closed. */
  ticket: Task | null;
  /** This project's other tickets — epic candidates and ticket-link candidates. */
  tickets: Task[];
  /** App-wide roster, for the assignee/reporter pickers. */
  people: Person[];
  /** This project's label registry. */
  labels: TicketLabel[];
  /** This project's milestones. */
  milestones: Milestone[];
  onClose: () => void;
}

function labelColor(labels: TicketLabel[], name: string): string | undefined {
  return labels.find((l) => l.name.toLowerCase() === name.toLowerCase())?.color || undefined;
}

export function TicketDrawer({
  ticket,
  tickets,
  people,
  labels,
  milestones,
  onClose,
}: TicketDrawerProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();

  const draftId = ticket?.id ?? null;

  const [issueType, setIssueType] = useState<IssueType>('task');
  const [epicTaskId, setEpicTaskId] = useState(NONE);
  const [milestoneId, setMilestoneId] = useState(NONE);
  const [assigneeId, setAssigneeId] = useState(NONE);
  const [reporterId, setReporterId] = useState(NONE);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Reseed the picker fields whenever the drawer opens on a (possibly different) ticket.
  // Keyed on the id alone — the same discipline `TaskDetailsCell` follows for its own open
  // effect — so a background sync rewriting the ticket under an open drawer does not yank a
  // picker back to the stored value while it is mid-edit.
  useEffect(() => {
    setError(null);
    setSaved(false);
    if (!ticket) return;
    setIssueType(ticket.issueType ?? 'task');
    setEpicTaskId(ticket.epicTaskId ?? NONE);
    setMilestoneId(ticket.milestoneId ?? NONE);
    setAssigneeId(ticket.assigneeId ?? NONE);
    setReporterId(ticket.reporterId ?? NONE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  const labelsDraft = useDraft(
    draftId ? draftKey(draftId, 'labelsText') : null,
    (ticket?.labels ?? []).join(', '),
  );
  const storyPointsDraft = useDraft(
    draftId ? draftKey(draftId, 'storyPoints') : null,
    ticket?.storyPoints == null ? '' : String(ticket.storyPoints),
  );
  const estimateDaysDraft = useDraft(
    draftId ? draftKey(draftId, 'estimateDays') : null,
    ticket?.estimateDays == null ? '' : String(ticket.estimateDays),
  );
  const startAtDraft = useDraft(
    draftId ? draftKey(draftId, 'startAt') : null,
    dateToInput(ticket?.startAt ?? null),
  );
  const dueAtDraft = useDraft(
    draftId ? draftKey(draftId, 'dueAt') : null,
    dateToInput(ticket?.dueAt ?? null),
  );

  const epicCandidates = tickets.filter((t) => t.issueType === 'epic' && t.id !== ticket?.id);
  const otherTickets = tickets.filter((t) => t.id !== ticket?.id);
  const previewLabels = splitLabels(labelsDraft.value);

  async function save(): Promise<void> {
    if (!ticket) return;
    const draft: TicketDraft = {
      issueType,
      epicTaskId,
      milestoneId,
      labelsText: labelsDraft.value,
      storyPointsText: storyPointsDraft.value,
      estimateDaysText: estimateDaysDraft.value,
      startAtInput: startAtDraft.value,
      dueAtInput: dueAtDraft.value,
      assigneeId,
      reporterId,
    };
    const patch = ticketPatchFrom(draft, ticket);
    if (Object.keys(patch).length === 0) {
      setSaved(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await transport.invoke('ticket:update', ticket.id, patch);
      labelsDraft.commit();
      storyPointsDraft.commit();
      estimateDaysDraft.commit();
      startAtDraft.commit();
      dueAtDraft.commit();
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <OverlayDrawer
      open={ticket !== null}
      position="end"
      size="medium"
      onOpenChange={(_e, d) => !d.open && onClose()}
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button
              appearance="subtle"
              icon={<DismissRegular />}
              aria-label="Close"
              onClick={onClose}
            />
          }
        >
          {ticket && (
            <>
              {ticket.ticketKey && <span className={styles.key}>{ticket.ticketKey}</span>}{' '}
              {ticket.title}
            </>
          )}
        </DrawerHeaderTitle>
      </DrawerHeader>
      {ticket && (
        <>
          <DrawerBody>
            <div className={styles.form}>
              {error && (
                <MessageBar intent="error">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              )}

              <div className={styles.row}>
                <Field label="Type" className={styles.cell}>
                  <Dropdown
                    value={issueType}
                    selectedOptions={[issueType]}
                    onOptionSelect={(_e, d) => {
                      if (d.optionValue) setIssueType(d.optionValue as IssueType);
                    }}
                  >
                    {ISSUE_TYPES.map((t) => (
                      <Option key={t} value={t}>
                        {t}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>

                <Field label="Epic" className={styles.cell}>
                  <Dropdown
                    value={epicCandidates.find((e) => e.id === epicTaskId)?.title ?? 'None'}
                    selectedOptions={[epicTaskId || NONE]}
                    onOptionSelect={(_e, d) => {
                      if (d.optionValue !== undefined) setEpicTaskId(d.optionValue);
                    }}
                  >
                    {epicCandidates.map((e) => (
                      <Option key={e.id} value={e.id} text={e.title}>
                        {e.title}
                      </Option>
                    ))}
                    <Option value={NONE}>None</Option>
                  </Dropdown>
                </Field>
              </div>

              <div className={styles.row}>
                <Field label="Milestone" className={styles.cell}>
                  <div className={styles.labelsRow}>
                    <Dropdown
                      className={styles.cell}
                      value={milestones.find((m) => m.id === milestoneId)?.name ?? 'None'}
                      selectedOptions={[milestoneId || NONE]}
                      onOptionSelect={(_e, d) => {
                        if (d.optionValue !== undefined) setMilestoneId(d.optionValue);
                      }}
                    >
                      {milestones
                        .filter((m) => !m.closed || m.id === milestoneId)
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

              <Field label="Labels" hint="Comma-separated.">
                <div className={styles.labelsRow}>
                  <Input
                    className={styles.cell}
                    value={labelsDraft.value}
                    onChange={(_e, d) => labelsDraft.set(d.value)}
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
                <Field label="Story points" className={styles.cell}>
                  <Input
                    value={storyPointsDraft.value}
                    onChange={(_e, d) => storyPointsDraft.set(d.value)}
                    placeholder="Not estimated"
                  />
                </Field>
                <Field label="Estimate (days)" className={styles.cell}>
                  <Input
                    value={estimateDaysDraft.value}
                    onChange={(_e, d) => estimateDaysDraft.set(d.value)}
                    placeholder="Not estimated"
                  />
                </Field>
              </div>

              <div className={styles.row}>
                <Field label="Start" className={styles.cell}>
                  <Input
                    type="date"
                    value={startAtDraft.value}
                    onChange={(_e, d) => startAtDraft.set(d.value)}
                  />
                </Field>
                <Field label="Due" className={styles.cell}>
                  <Input
                    type="date"
                    value={dueAtDraft.value}
                    onChange={(_e, d) => dueAtDraft.set(d.value)}
                  />
                </Field>
              </div>

              <div className={styles.row}>
                <Field label="Assignee" className={styles.cell}>
                  <Dropdown
                    value={people.find((p) => p.id === assigneeId)?.name ?? 'Unassigned'}
                    selectedOptions={[assigneeId || NONE]}
                    onOptionSelect={(_e, d) => {
                      if (d.optionValue !== undefined) setAssigneeId(d.optionValue);
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
                </Field>
                <Field label="Reporter" className={styles.cell}>
                  <Dropdown
                    value={people.find((p) => p.id === reporterId)?.name ?? 'None'}
                    selectedOptions={[reporterId || NONE]}
                    onOptionSelect={(_e, d) => {
                      if (d.optionValue !== undefined) setReporterId(d.optionValue);
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

              <Divider />

              <Subtitle2>Linked tickets</Subtitle2>
              <TicketLinksEditor ticket={ticket} candidates={otherTickets} />
            </div>
          </DrawerBody>
          <DrawerFooter>
            {saved && !saving && <Caption1 className={styles.saved}>Saved.</Caption1>}
            <Button appearance="secondary" onClick={onClose} disabled={saving}>
              Close
            </Button>
            <Button appearance="primary" onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DrawerFooter>
        </>
      )}
    </OverlayDrawer>
  );
}
