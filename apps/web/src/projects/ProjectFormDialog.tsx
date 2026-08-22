/**
 * Create or edit a `kind: 'ticket'` project — the one kind a browser may originate at all
 * (see `projectsApi.ts`, `test/shell-parity.test.ts`'s "the one configuration the web
 * deliberately does not mirror").
 *
 * One dialog for both acts, the way `AddTaskDialog` is one dialog for a task and a step: a
 * `project` prop of `null` is "new", a `Project` is "editing that one", and the only thing
 * that changes between them is which endpoint `save` calls and the dialog's own title.
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
  MessageBar,
  MessageBarBody,
  makeStyles,
} from '@fluentui/react-components';
import type { Project } from '@tm/shared/model';
import { createProject, updateProject, type ProjectsApiDeps } from './projectsApi';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '360px' },
});

export interface ProjectFormDialogProps {
  open: boolean;
  /** The project being edited, or `null` while this creates a new one. */
  project: Project | null;
  apiDeps: ProjectsApiDeps;
  onClose: () => void;
  /** The row the server actually stored — merge it into the mirror ahead of the next poll. */
  onSaved: (project: Project) => void;
}

export function ProjectFormDialog({
  open,
  project,
  apiDeps,
  onClose,
  onSaved,
}: ProjectFormDialogProps): JSX.Element {
  const styles = useStyles();
  const [name, setName] = useState('');
  const [ticketPrefix, setTicketPrefix] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reseed the form every time it opens — for a fresh create as much as for an edit, so a
  // dialog left with a half-typed name from a cancelled create doesn't reappear on the next.
  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? '');
    setTicketPrefix(project?.ticketPrefix ?? '');
    setError(null);
  }, [open, project]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const saved = project
        ? await updateProject(apiDeps, project.id, { name, ticketPrefix })
        : await createProject(apiDeps, { name, path: '', kind: 'ticket', ticketPrefix });
      onSaved(saved);
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
          <DialogTitle>{project ? 'Edit project' : 'New ticket project'}</DialogTitle>
          <DialogContent className={styles.body}>
            {error && (
              <MessageBar intent="error">
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}
            <Field label="Name" required>
              <Input
                value={name}
                onChange={(_e, d) => setName(d.value)}
                placeholder="e.g. Website redesign"
              />
            </Field>
            <Field
              label="Ticket prefix"
              hint="Tickets are keyed off this, e.g. TM-1, TM-2… Letters and numbers only."
            >
              <Input
                value={ticketPrefix}
                onChange={(_e, d) => setTicketPrefix(d.value)}
                placeholder="TM"
              />
            </Field>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              disabled={saving || !name.trim()}
              onClick={() => void save()}
            >
              {project ? 'Save' : 'Create'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
