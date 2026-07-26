/**
 * AssignAgentDialog — delegate one My Tasks card to an agent.
 *
 * The card never leaves the Personal board; what this picks is the **agent project**
 * (a repo directory, managed in Settings → Agents) the run happens in, plus the model
 * and permission mode that run uses. The project is pre-filled from the ticket's epic
 * (`resolveAgentProject`), so for a linked epic the whole dialog is usually one click.
 *
 * Confirming calls `task:assignAgent`, which records the instructions on the task's
 * timeline and starts the agent immediately — there is no queue.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Body1,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  MessageBar,
  MessageBarBody,
  Option,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { PERMISSION_MODE_LABELS } from '@shared/session';
import type { ClaudeModel, PermissionMode } from '@shared/session';
import type { Project, Task } from '@shared/model';
import { resolveAgentProject } from '@shared/agentProjects';

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '440px' },
  row: { display: 'flex', gap: '8px' },
  grow: { flex: 1 },
  hint: { color: tokens.colorNeutralForeground3 },
  ticket: { color: tokens.colorNeutralForeground2 },
});

const MODELS: ClaudeModel[] = ['haiku', 'sonnet', 'opus'];
const MODES: PermissionMode[] = ['acceptEdits', 'plan', 'manual', 'bypassPermissions'];

export interface AssignAgentDialogProps {
  open: boolean;
  /** The card being delegated (null closes the dialog's content). */
  task: Task | null;
  /** Every agent project (from `agentProject:list`), for the picker. */
  agentProjects: Project[];
  onClose: () => void;
  /** The updated task, so the board can patch the card without a refresh. */
  onAssigned: (task: Task) => void;
}

export function AssignAgentDialog({
  open,
  task,
  agentProjects,
  onClose,
  onAssigned,
}: AssignAgentDialogProps): JSX.Element {
  const styles = useStyles();
  const [projectId, setProjectId] = useState<string>('');
  const [model, setModel] = useState<ClaudeModel>('sonnet');
  const [mode, setMode] = useState<PermissionMode>('acceptEdits');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed once per opening — keyed on the card, not the task object, so a background
  // JIRA sync replacing it can't wipe what the user is halfway through typing.
  const latest = useRef({ task, agentProjects });
  latest.current = { task, agentProjects };
  useEffect(() => {
    if (!open) return;
    const { task: card, agentProjects: projects } = latest.current;
    if (!card) return;
    setError(null);
    setNotes('');
    const resolved = resolveAgentProject(card, projects) ?? projects[0] ?? null;
    setProjectId(resolved?.id ?? '');
    setModel(card.agentModel ?? resolved?.defaultModel ?? 'sonnet');
    setMode(card.agentMode ?? resolved?.defaultPermissionMode ?? 'acceptEdits');
  }, [open, task?.id]);

  /** Switching repo also switches to that repo's defaults — they're per-project settings. */
  function pickProject(id: string): void {
    setProjectId(id);
    const picked = agentProjects.find((p) => p.id === id);
    if (picked) {
      setModel(picked.defaultModel);
      setMode(picked.defaultPermissionMode);
    }
  }

  async function assign(): Promise<void> {
    if (!task || !projectId) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await window.api.invoke('task:assignAgent', task.id, {
        agentProjectId: projectId,
        mode,
        model,
        notes: notes.trim() || undefined,
      });
      onAssigned(updated);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const selected = agentProjects.find((p) => p.id === projectId) ?? null;
  const ticket = task?.externalKey ? `${task.externalKey} — ${task.title}` : (task?.title ?? '');

  return (
    <Dialog open={open} onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Assign to an agent</DialogTitle>
          <DialogContent>
            <div className={styles.form}>
              <Body1 className={styles.ticket}>{ticket}</Body1>

              {error && (
                <MessageBar intent="error">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              )}

              {agentProjects.length === 0 ? (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    No agent projects yet. Add one in Settings → Agents (a repository folder, plus
                    the JIRA epics it owns) and then assign this card.
                  </MessageBarBody>
                </MessageBar>
              ) : (
                <>
                  <Field
                    label="Agent project"
                    required
                    hint={selected ? selected.path : 'The repository the agent works in.'}
                  >
                    <Dropdown
                      value={selected?.name ?? ''}
                      selectedOptions={projectId ? [projectId] : []}
                      onOptionSelect={(_e, d) => d.optionValue && pickProject(d.optionValue)}
                    >
                      {agentProjects.map((p) => (
                        <Option key={p.id} value={p.id} text={p.name}>
                          {p.name}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>

                  <div className={styles.row}>
                    <Field label="Model" className={styles.grow}>
                      <Dropdown
                        value={model}
                        selectedOptions={[model]}
                        onOptionSelect={(_e, d) => setModel(d.optionValue as ClaudeModel)}
                      >
                        {MODELS.map((m) => (
                          <Option key={m} value={m}>
                            {m}
                          </Option>
                        ))}
                      </Dropdown>
                    </Field>
                    <Field label="Permission mode" className={styles.grow}>
                      <Dropdown
                        value={PERMISSION_MODE_LABELS[mode]}
                        selectedOptions={[mode]}
                        onOptionSelect={(_e, d) => setMode(d.optionValue as PermissionMode)}
                      >
                        {MODES.map((m) => (
                          <Option key={m} value={m} text={PERMISSION_MODE_LABELS[m]}>
                            {PERMISSION_MODE_LABELS[m]}
                          </Option>
                        ))}
                      </Dropdown>
                    </Field>
                  </div>

                  <Field
                    label="Instructions (optional)"
                    hint="Added to the task's timeline and handed to the agent with the ticket."
                  >
                    <Textarea
                      value={notes}
                      resize="vertical"
                      onChange={(_e, d) => setNotes(d.value)}
                      placeholder="Anything the ticket doesn't say — where to start, what to avoid…"
                    />
                  </Field>

                  <Body1 className={styles.hint}>
                    The agent starts immediately on its own branch in a separate worktree, and never
                    writes anything back to JIRA.
                  </Body1>
                </>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              onClick={() => void assign()}
              disabled={busy || !projectId}
            >
              {busy ? 'Starting…' : 'Assign & start'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
