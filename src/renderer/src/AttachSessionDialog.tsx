/**
 * Attach-existing-session dialog (Phase 8, Deliverables B1 + B2).
 *
 * Adopt a Claude conversation you already have: pick one of the conversations the
 * CLI has on disk for this project's folder (B2), or paste a session-id by hand
 * (B1), and the task takes it on (`task:attachSession`) so the next Run RESUMES
 * that conversation (`claude --resume`) instead of starting fresh.
 *
 * The pick-list reads an UNDOCUMENTED CLI layout, so it is offered as a
 * convenience over the manual field rather than replacing it: when the listing
 * comes back empty — no such folder, a CLI that reorganized itself, a project
 * whose sessions ran somewhere else — the field is still right there, and typing
 * into it always wins over whatever is selected above.
 */
import { useEffect, useRef, useState } from 'react';
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
  makeStyles,
  MessageBar,
  MessageBarBody,
  Option,
  Spinner,
  Text,
  tokens,
} from '@fluentui/react-components';
import type { ClaudeSessionSummary } from '@shared/ipc';
import type { Project, Task } from '@shared/model';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '440px' },
  mono: { fontFamily: 'ui-monospace, Consolas, monospace' },
  option: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '2px' },
  optionPreview: { overflow: 'hidden', textOverflow: 'ellipsis' },
  optionWhen: { color: tokens.colorNeutralForeground3, fontSize: '11px' },
  loading: { display: 'flex', alignItems: 'center', gap: '8px' },
});

/** A plausible session-id: the UUID the CLI uses for a conversation. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Compactly, e.g. "Jul 29, 07:35". */
function fmtWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** What a row says when the conversation's opening prompt could not be read. */
function labelFor(session: ClaudeSessionSummary): string {
  return session.preview || `(no preview) ${session.sessionId.slice(0, 8)}`;
}

export interface AttachSessionDialogProps {
  open: boolean;
  task: Task | null;
  /**
   * The task's project — its `path` is the working directory whose conversations
   * we list, and its `target` says which machine ran them. Null disables the
   * pick-list and leaves the manual field.
   */
  project: Project | null;
  onClose: () => void;
  onSaved: () => void;
}

export function AttachSessionDialog({
  open,
  task,
  project,
  onClose,
  onSaved,
}: AttachSessionDialogProps): JSX.Element {
  const styles = useStyles();
  const [sessionId, setSessionId] = useState('');
  const [sessions, setSessions] = useState<ClaudeSessionSummary[]>([]);
  const [listing, setListing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed once per opening, keyed on the card rather than the task object, so a
  // background sync replacing it cannot wipe a half-typed id.
  const latest = useRef({ task, project });
  latest.current = { task, project };

  useEffect(() => {
    if (!open) return;
    const { task: card, project: proj } = latest.current;
    setSessionId(card?.sessionId ?? '');
    setError(null);
    setSessions([]);

    if (!proj) return;
    setListing(true);
    // A slow listing must not land in a later opening of the dialog.
    let current = true;
    void window.api
      .invoke('claude:listSessions', proj.path, proj.target)
      .then((found) => {
        if (current) setSessions(found);
      })
      // The main side already fails soft; this is the IPC itself going wrong,
      // and it costs the user nothing — the manual field still works.
      .catch(() => {
        if (current) setSessions([]);
      })
      .finally(() => {
        if (current) setListing(false);
      });
    return () => {
      current = false;
    };
  }, [open, task?.id]);

  const trimmed = sessionId.trim();
  const looksValid = UUID_RE.test(trimmed);
  const picked = sessions.find((session) => session.sessionId === trimmed) ?? null;

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

              {project && (
                <Field
                  label="Conversation"
                  hint={
                    listing
                      ? undefined
                      : `Found in ${project.path}. Newest first — pick one, or type an id below.`
                  }
                >
                  {listing ? (
                    <div className={styles.loading}>
                      <Spinner size="tiny" />
                      <Text size={200}>Looking for conversations…</Text>
                    </div>
                  ) : sessions.length === 0 ? (
                    <MessageBar intent="info">
                      <MessageBarBody>
                        No conversations found on disk for this folder. Paste the session id below
                        instead.
                      </MessageBarBody>
                    </MessageBar>
                  ) : (
                    <Dropdown
                      value={picked ? labelFor(picked) : ''}
                      selectedOptions={picked ? [picked.sessionId] : []}
                      placeholder="Choose a conversation"
                      onOptionSelect={(_e, d) => d.optionValue && setSessionId(d.optionValue)}
                    >
                      {sessions.map((session) => (
                        <Option
                          key={session.sessionId}
                          value={session.sessionId}
                          text={labelFor(session)}
                        >
                          <span className={styles.option}>
                            <span className={styles.optionPreview}>{labelFor(session)}</span>
                            <span className={styles.optionWhen}>
                              {fmtWhen(session.lastAt)} · {session.sessionId.slice(0, 8)}
                            </span>
                          </span>
                        </Option>
                      ))}
                    </Dropdown>
                  )}
                </Field>
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
