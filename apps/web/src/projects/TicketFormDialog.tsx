/**
 * Create a native ticket — the Backlog and Epics views' own "New ticket"/"New epic".
 *
 * A quick-add dialog, not the whole ticket editor: title, type, priority, epic and labels
 * are the fields worth deciding at the moment of typing a ticket in five seconds (the same
 * bargain `TicketInput`'s own doc states); everything else — description, story points,
 * status — is the ticket-detail page's job (`TicketDetailPage`), for the ticket that already
 * exists by the time anyone wants to fill them in.
 *
 * Always a CREATE, unlike `ProjectFormDialog`'s create-or-edit: editing an existing ticket
 * happens on its own page, which is the one place `title` and every other field already
 * live together.
 */
import { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Textarea,
  makeStyles,
} from '@fluentui/react-components';
import type { IssueType, Task } from '@tm/shared/model';
import { DEFAULT_PRIORITIES } from '@tm/shared/priority';
import { ISSUE_TYPES } from '@tm/shared/tickets';
import { createTicket, type ProjectsApiDeps } from './projectsApi';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '360px' },
});

const ISSUE_TYPE_LABEL: Record<IssueType, string> = {
  epic: 'Epic',
  story: 'Story',
  task: 'Task',
  bug: 'Bug',
  subtask: 'Subtask',
};

const NO_EPIC_OPTION = '';
const NO_PRIORITY_OPTION = '';

export interface TicketFormDialogProps {
  open: boolean;
  projectId: string;
  /** Preset when opened from the Epics view's "New epic" — hidden from the picker there,
   *  since an epic cannot itself hang under another. */
  issueType?: IssueType;
  /** This project's epics, for the epic picker. Empty when creating an epic itself. */
  epics: Task[];
  apiDeps: ProjectsApiDeps;
  onClose: () => void;
  /** The row the server actually stored — merged into the mirror ahead of the next poll. */
  onCreated: (task: Task) => void;
}

export function TicketFormDialog({
  open,
  projectId,
  issueType: fixedIssueType,
  epics,
  apiDeps,
  onClose,
  onCreated,
}: TicketFormDialogProps): JSX.Element {
  const styles = useStyles();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [issueType, setIssueType] = useState<IssueType>(fixedIssueType ?? 'task');
  const [priority, setPriority] = useState('');
  const [epicTaskId, setEpicTaskId] = useState('');
  const [labels, setLabels] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reseed on every open, exactly like `ProjectFormDialog` — a half-typed ticket from a
  // cancelled create must not reappear the next time this opens.
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setDescription('');
    setIssueType(fixedIssueType ?? 'task');
    setPriority('');
    setEpicTaskId('');
    setLabels('');
    setError(null);
  }, [open, fixedIssueType]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const created = await createTicket(apiDeps, projectId, {
        title,
        description: description.trim() || null,
        issueType,
        priority: priority || null,
        epicTaskId: epicTaskId || null,
        labels: labels
          .split(',')
          .map((l) => l.trim())
          .filter(Boolean),
      });
      onCreated(created);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{fixedIssueType === 'epic' ? 'New epic' : 'New ticket'}</DialogTitle>
          <DialogContent className={styles.body}>
            {error && (
              <MessageBar intent="error">
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}
            <Field label="Title" required>
              <Input
                value={title}
                onChange={(_e, d) => setTitle(d.value)}
                placeholder="e.g. Fix the header on mobile"
              />
            </Field>
            <Field label="Description">
              <Textarea
                value={description}
                onChange={(_e, d) => setDescription(d.value)}
                resize="vertical"
              />
            </Field>
            {!fixedIssueType && (
              <Field label="Type">
                <Dropdown
                  value={ISSUE_TYPE_LABEL[issueType]}
                  selectedOptions={[issueType]}
                  onOptionSelect={(_e, d) => {
                    if (d.optionValue) setIssueType(d.optionValue as IssueType);
                  }}
                >
                  {ISSUE_TYPES.map((t) => (
                    <Option key={t} value={t}>
                      {ISSUE_TYPE_LABEL[t]}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
            )}
            <Field label="Priority">
              <Dropdown
                value={priority || 'None'}
                selectedOptions={[priority || NO_PRIORITY_OPTION]}
                onOptionSelect={(_e, d) => setPriority(d.optionValue ?? '')}
              >
                <Option value={NO_PRIORITY_OPTION}>None</Option>
                {DEFAULT_PRIORITIES.map((p) => (
                  <Option key={p} value={p}>
                    {p}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            {issueType !== 'epic' && epics.length > 0 && (
              <Field label="Epic">
                <Dropdown
                  value={epics.find((e) => e.id === epicTaskId)?.title ?? 'None'}
                  selectedOptions={[epicTaskId || NO_EPIC_OPTION]}
                  onOptionSelect={(_e, d) => setEpicTaskId(d.optionValue ?? '')}
                >
                  <Option value={NO_EPIC_OPTION}>None</Option>
                  {epics.map((e) => (
                    <Option key={e.id} value={e.id}>
                      {e.title}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
            )}
            <Field label="Labels" hint="Comma-separated.">
              <Input
                value={labels}
                onChange={(_e, d) => setLabels(d.value)}
                placeholder="backend, urgent"
              />
            </Field>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              disabled={saving || !title.trim()}
              onClick={() => void save()}
            >
              Create
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
