/**
 * A ticket's own page — `/projects/:projectId/tickets/:ticketId` (`TicketDetailRoute`).
 *
 * Beyond the inline `TaskDetail` pane (the Board tab's right-hand sidebar, chat and all):
 * this is the JIRA-style ticket screen, every field on one page with its own bookmarkable
 * URL. It edits over the REST ticket API (`projectsApi.ts`'s `updateTicket`), not the
 * `task:setStatus`/`task:update` transport calls `TaskDetail` sends — those are relayed to
 * a desktop Client, and a ticket project may have none online at all; the whole point of a
 * native ticket is that the server is the ticket's own source of truth.
 *
 * Explicit Save rather than autosave-on-blur, the same bargain `ProjectFormDialog` and
 * `TicketFormDialog` strike: a half-finished edit should not land the instant focus leaves
 * a field, and the dirty check is what lets the button say so.
 */
import { useEffect, useState } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ChevronLeftRegular } from '@fluentui/react-icons';
import { isManualStatus, type IssueType, type ManualStatus, type Task } from '@tm/shared/model';
import { restingStatus } from '@tm/shared/board';
import { DEFAULT_PRIORITIES } from '@tm/shared/priority';
import { ISSUE_TYPES, isEpic } from '@tm/shared/tickets';
import { typeIcon } from '@tm/ui/board/TaskCard';
import { MANUAL_STATUS_OPTIONS } from '@tm/ui/taskStatus';
import { AssignAgentSection } from '../agents/AssignAgentSection';
import { updateTicket, type ProjectsApiDeps } from './projectsApi';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '12px 16px',
    maxWidth: '720px',
  },
  back: { alignSelf: 'flex-start' },
  head: { display: 'flex', alignItems: 'center', gap: '10px' },
  icon: { display: 'flex', fontSize: '20px', color: tokens.colorNeutralForeground3 },
  key: { color: tokens.colorNeutralForeground3, fontWeight: 600 },
  titleField: { flex: 1 },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' },
  actions: { display: 'flex', alignItems: 'center', gap: '8px' },
});

const NO_EPIC_OPTION = '';
const NO_PRIORITY_OPTION = '';

const ISSUE_TYPE_LABEL: Record<IssueType, string> = {
  epic: 'Epic',
  story: 'Story',
  task: 'Task',
  bug: 'Bug',
  subtask: 'Subtask',
};

export interface TicketDetailPageProps {
  task: Task;
  /** This project's epics, for the epic picker — excludes the ticket itself (an epic
   *  cannot hang under another, and a ticket cannot hang under itself). */
  epics: Task[];
  apiDeps: ProjectsApiDeps;
  onSaved: (task: Task) => void;
  onBack: () => void;
}

interface FormState {
  title: string;
  description: string;
  status: ManualStatus;
  issueType: IssueType;
  priority: string;
  epicTaskId: string;
  labels: string;
  storyPoints: string;
}

/** Where the ticket RESTS, not `status` — which a live run may have borrowed (see
 *  `restingStatus`). A ticket with no manual resting status (unreachable for a native
 *  ticket, since nothing but a human sets one) falls back to `pending` rather than
 *  crashing the dropdown. */
function manualStatusOf(task: Task): ManualStatus {
  const resting = restingStatus(task);
  return isManualStatus(resting) ? resting : 'pending';
}

function formStateOf(task: Task): FormState {
  return {
    title: task.title,
    description: task.externalDescription ?? '',
    status: manualStatusOf(task),
    issueType: task.issueType ?? 'task',
    priority: task.externalPriority ?? '',
    epicTaskId: task.epicTaskId ?? '',
    labels: (task.labels ?? []).join(', '),
    storyPoints: task.storyPoints != null ? String(task.storyPoints) : '',
  };
}

export function TicketDetailPage({
  task,
  epics,
  apiDeps,
  onSaved,
  onBack,
}: TicketDetailPageProps): JSX.Element {
  const styles = useStyles();
  const [form, setForm] = useState<FormState>(() => formStateOf(task));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed whenever a DIFFERENT ticket is shown (navigating from one row to the next
  // re-mounts the route param but not this component), and whenever a save round-trips —
  // never mid-edit on some unrelated poll, or the field a human is mid-sentence in would
  // jump back to the mirror's word for it.
  useEffect(() => {
    setForm(formStateOf(task));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on identity, not content:
    // see the comment above for why a same-id poll must NOT re-seed a field mid-edit.
  }, [task.id]);

  const dirty = JSON.stringify(form) !== JSON.stringify(formStateOf(task));
  const epicOptions = epics.filter((e) => e.id !== task.id);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const storyPoints = form.storyPoints.trim() === '' ? null : Number(form.storyPoints);
      const saved = await updateTicket(apiDeps, task.id, {
        title: form.title,
        description: form.description.trim() || null,
        status: form.status,
        issueType: form.issueType,
        priority: form.priority || null,
        epicTaskId: form.epicTaskId || null,
        labels: form.labels
          .split(',')
          .map((l) => l.trim())
          .filter(Boolean),
        storyPoints: storyPoints === null || Number.isNaN(storyPoints) ? null : storyPoints,
      });
      onSaved(saved);
      setForm(formStateOf(saved));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.root}>
      <Button
        className={styles.back}
        appearance="subtle"
        icon={<ChevronLeftRegular />}
        onClick={onBack}
      >
        Back to backlog
      </Button>

      <div className={styles.head}>
        <span className={styles.icon}>{typeIcon(task)}</span>
        {task.ticketKey && <Caption1 className={styles.key}>{task.ticketKey}</Caption1>}
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <Field label="Title" required className={styles.titleField}>
        <Input
          size="large"
          value={form.title}
          onChange={(_e, d) => setForm((f) => ({ ...f, title: d.value }))}
        />
      </Field>

      <Field label="Description">
        <Textarea
          value={form.description}
          onChange={(_e, d) => setForm((f) => ({ ...f, description: d.value }))}
          resize="vertical"
          rows={6}
        />
      </Field>

      <div className={styles.grid}>
        <Field label="Status">
          <Dropdown
            value={MANUAL_STATUS_OPTIONS.find((o) => o.value === form.status)?.label ?? form.status}
            selectedOptions={[form.status]}
            onOptionSelect={(_e, d) => {
              if (d.optionValue) setForm((f) => ({ ...f, status: d.optionValue as ManualStatus }));
            }}
          >
            {MANUAL_STATUS_OPTIONS.map((o) => (
              <Option key={o.value} value={o.value}>
                {o.label}
              </Option>
            ))}
          </Dropdown>
        </Field>

        <Field label="Type">
          <Dropdown
            value={ISSUE_TYPE_LABEL[form.issueType]}
            selectedOptions={[form.issueType]}
            onOptionSelect={(_e, d) => {
              if (d.optionValue) setForm((f) => ({ ...f, issueType: d.optionValue as IssueType }));
            }}
          >
            {ISSUE_TYPES.map((t) => (
              <Option key={t} value={t}>
                {ISSUE_TYPE_LABEL[t]}
              </Option>
            ))}
          </Dropdown>
        </Field>

        <Field label="Priority">
          <Dropdown
            value={form.priority || 'None'}
            selectedOptions={[form.priority || NO_PRIORITY_OPTION]}
            onOptionSelect={(_e, d) => setForm((f) => ({ ...f, priority: d.optionValue ?? '' }))}
          >
            <Option value={NO_PRIORITY_OPTION}>None</Option>
            {DEFAULT_PRIORITIES.map((p) => (
              <Option key={p} value={p}>
                {p}
              </Option>
            ))}
          </Dropdown>
        </Field>

        {!isEpic(task) && (
          <Field label="Epic">
            <Dropdown
              value={epicOptions.find((e) => e.id === form.epicTaskId)?.title ?? 'None'}
              selectedOptions={[form.epicTaskId || NO_EPIC_OPTION]}
              onOptionSelect={(_e, d) =>
                setForm((f) => ({ ...f, epicTaskId: d.optionValue ?? '' }))
              }
            >
              <Option value={NO_EPIC_OPTION}>None</Option>
              {epicOptions.map((e) => (
                <Option key={e.id} value={e.id}>
                  {e.title}
                </Option>
              ))}
            </Dropdown>
          </Field>
        )}

        <Field label="Labels" hint="Comma-separated.">
          <Input
            value={form.labels}
            onChange={(_e, d) => setForm((f) => ({ ...f, labels: d.value }))}
          />
        </Field>

        <Field label="Story points">
          <Input
            type="number"
            value={form.storyPoints}
            onChange={(_e, d) => setForm((f) => ({ ...f, storyPoints: d.value }))}
          />
        </Field>
      </div>

      <div className={styles.actions}>
        <Button appearance="primary" disabled={!dirty || saving} onClick={() => void save()}>
          Save changes
        </Button>
        {dirty && (
          <Button appearance="subtle" disabled={saving} onClick={() => setForm(formStateOf(task))}>
            Discard
          </Button>
        )}
        {!dirty && <Body1 style={{ color: tokens.colorNeutralForeground3 }}>Up to date</Body1>}
      </div>

      <AssignAgentSection task={task} apiDeps={apiDeps} />
    </div>
  );
}
