/**
 * Add-task dialog (Phase 8, Deliverable C1).
 *
 * Create an ad-hoc task directly in a project — no plan file required. This makes
 * plan-less projects usable and lets you add work on the fly; the task is tagged
 * `source: 'adhoc'`, so plan re-syncs never remove it. An optional phase groups it
 * under a milestone (reuse an existing one or type a new one).
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
} from '@fluentui/react-components';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '440px' },
});

export interface AddTaskDialogProps {
  open: boolean;
  projectId: string | null;
  /** Existing phase names in the project, offered as a hint. */
  phases: string[];
  onClose: () => void;
  onCreated: () => void;
}

export function AddTaskDialog({
  open,
  projectId,
  phases,
  onClose,
  onCreated,
}: AddTaskDialogProps): JSX.Element {
  const styles = useStyles();
  const [title, setTitle] = useState('');
  const [phase, setPhase] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTitle('');
      setPhase('');
      setError(null);
    }
  }, [open]);

  async function save(): Promise<void> {
    if (!projectId || !title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await window.api.invoke('task:create', projectId, {
        title: title.trim(),
        phase: phase.trim() || undefined,
      });
      onCreated();
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
          <DialogTitle>Add task</DialogTitle>
          <DialogContent>
            <div className={styles.body}>
              {error && (
                <MessageBar intent="error">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              )}
              <Field label="Task" required>
                <Input
                  value={title}
                  onChange={(_e, d) => setTitle(d.value)}
                  placeholder="What should Claude do?"
                />
              </Field>
              <Field
                label="Phase / milestone (optional)"
                hint={phases.length ? `Existing: ${phases.join(' · ')}` : 'e.g. "Phase 1 — Setup"'}
              >
                <Input
                  value={phase}
                  onChange={(_e, d) => setPhase(d.value)}
                  placeholder="(ungrouped)"
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
              Add task
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
