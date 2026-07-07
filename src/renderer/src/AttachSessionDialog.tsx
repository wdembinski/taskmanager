/**
 * Attach-existing-session dialog (Phase 8, Deliverable B1).
 *
 * Adopt a Claude conversation you already have: paste its session-id and the task
 * takes it on (`task:attachSession`), so the next Run RESUMES that conversation
 * (`claude --resume`) instead of starting fresh. This is the manual path — it needs
 * no knowledge of the CLI's on-disk layout; the session-id picker (B2) will layer
 * on top of the same `task:attachSession` call.
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
  Text,
} from '@fluentui/react-components';
import type { Task } from '@shared/model';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '440px' },
  mono: { fontFamily: 'ui-monospace, Consolas, monospace' },
});

/** A plausible session-id: the UUID the CLI uses for a conversation. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AttachSessionDialogProps {
  open: boolean;
  task: Task | null;
  onClose: () => void;
  onSaved: () => void;
}

export function AttachSessionDialog({
  open,
  task,
  onClose,
  onSaved,
}: AttachSessionDialogProps): JSX.Element {
  const styles = useStyles();
  const [sessionId, setSessionId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSessionId(task?.sessionId ?? '');
      setError(null);
    }
  }, [open, task]);

  const trimmed = sessionId.trim();
  const looksValid = UUID_RE.test(trimmed);

  async function save(): Promise<void> {
    if (!task) return;
    setSaving(true);
    setError(null);
    try {
      await window.api.invoke('task:attachSession', task.id, trimmed);
      onSaved();
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
          <DialogTitle>Attach existing session</DialogTitle>
          <DialogContent>
            <div className={styles.body}>
              {task && (
                <Text>
                  Adopt a Claude conversation for <strong>{task.title}</strong>. Running the task
                  will resume it instead of starting fresh.
                </Text>
              )}
              {error && (
                <MessageBar intent="error">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              )}
              <Field
                label="Session id"
                hint="The conversation's UUID (from `claude --resume`, or a *.jsonl filename under ~/.claude/projects/…)."
                validationState={trimmed && !looksValid ? 'warning' : 'none'}
                validationMessage={
                  trimmed && !looksValid ? 'That does not look like a session UUID.' : undefined
                }
              >
                <Input
                  className={styles.mono}
                  value={sessionId}
                  onChange={(_e, d) => setSessionId(d.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
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
              disabled={saving || !looksValid}
            >
              Attach
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
