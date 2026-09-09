/**
 * NewTicketDialog — the backlog's own create dialog. Title, an optional brief, and the same
 * Type+Epic pickers `TicketDrawer` and the Add-task dialog share (`TicketTypeFields`), so a
 * ticket typed straight into the backlog answers the one question either of those two forms
 * also asks first: what kind of ticket is this, and does it hang under an epic.
 *
 * Reached two ways from `BacklogTable`: the toolbar's "New ticket" button (no epic preset)
 * and an epic group header's "Add child" button (`defaultEpicTaskId` preset to that epic).
 * Neither caller needs to pass an `onCreated` — `ticket:create`'s `project:tasksChanged`
 * broadcast already refreshes `BacklogTable`'s own list, the same way a `TicketDrawer` save
 * flows back down without a callback.
 *
 * Everything else a ticket can carry — milestone, labels, assignee, dates — is deliberately
 * absent here, for the same reason `TicketDrawer`'s own doc comment gives for leaving out
 * title/description/priority there: those are a second pass, made from the drawer once there
 * is a row worth refining, not a decision a five-second "file this" has to make up front.
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
  Field,
  Input,
  makeStyles,
  MessageBar,
  MessageBarBody,
  Textarea,
} from '@fluentui/react-components';
import type { IssueType, Task } from '@tm/shared/model';
import { isEpic } from '@tm/shared/tickets';
import { useTransport } from '../transport';
import { TicketTypeFields } from './TicketTypeFields';

const NO_EPIC = '';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '420px' },
  fieldsRow: { display: 'flex', gap: '12px' },
  fieldsCell: { flex: 1, minWidth: 0 },
});

export interface NewTicketDialogProps {
  open: boolean;
  projectId: string;
  /** This project's other tickets — epic candidates, filtered the same way `TicketDrawer`
   *  filters its own (there is no ticket yet here to exclude, unlike editing one). */
  tickets: Task[];
  /** Preset when opened from an epic's own "Add child" button — that epic, already filed
   *  in. `null`/omitted for the toolbar's plain "New ticket". */
  defaultEpicTaskId?: string | null;
  onClose: () => void;
}

export function NewTicketDialog({
  open,
  projectId,
  tickets,
  defaultEpicTaskId = null,
  onClose,
}: NewTicketDialogProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [issueType, setIssueType] = useState<IssueType>('task');
  const [epicTaskId, setEpicTaskId] = useState(NO_EPIC);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reseed on every open — a dialog reopened for a different epic (or none) must not carry
  // the last one's picks, the same discipline `TicketDrawer`'s own open effect follows.
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setDescription('');
    setIssueType('task');
    setEpicTaskId(defaultEpicTaskId ?? NO_EPIC);
    setError(null);
  }, [open, defaultEpicTaskId]);

  const epicCandidates = tickets.filter(isEpic);

  async function save(): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      await transport.invoke('ticket:create', projectId, {
        title: trimmed,
        description: description.trim() || undefined,
        issueType,
        epicTaskId: epicTaskId || null,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>New ticket</DialogTitle>
          <DialogContent>
            <div className={styles.body}>
              {error && (
                <MessageBar intent="error">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              )}
              <Field label="Title" required>
                <Input
                  value={title}
                  onChange={(_e, d) => setTitle(d.value)}
                  placeholder="What needs doing?"
                />
              </Field>
              <div className={styles.fieldsRow}>
                <TicketTypeFields
                  issueType={issueType}
                  epicTaskId={epicTaskId}
                  epicCandidates={epicCandidates}
                  onIssueTypeChange={setIssueType}
                  onEpicTaskIdChange={setEpicTaskId}
                  className={styles.fieldsCell}
                />
              </div>
              <Field label="Description (optional)">
                <Textarea
                  value={description}
                  resize="vertical"
                  onChange={(_e, d) => setDescription(d.value)}
                  placeholder="What this ticket is about…"
                />
              </Field>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              onClick={() => void save()}
              disabled={saving || !title.trim()}
            >
              {saving ? 'Creating…' : 'Create'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
