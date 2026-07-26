/**
 * The card's **details cell** — the block above the conversation in the detail pane.
 *
 * Deliberately one shaded slab rather than a second tab: what a card *is* (status, the
 * ticket text, its steps) is context you read **while** talking to the agent, not an
 * alternative to it. The description folds away because on a JIRA card it is often
 * twenty lines of reproduction steps you have already read.
 *
 * Editing the description edits the app's **copy**. That copy is what the agent's
 * prompt quotes, so the edit is real work — but a JIRA sync will replace it with the
 * issue's text, and nothing here writes back to the tracker (see `docs/03`).
 */
import { useEffect, useState } from 'react';
import {
  Button,
  Caption1,
  Dropdown,
  MessageBar,
  MessageBarBody,
  Option,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ChevronDownRegular, ChevronRightRegular } from '@fluentui/react-icons';
import type { ManualStatus, Task } from '@shared/model';
import { MANUAL_STATUS_OPTIONS, STATUS_LABEL } from './taskStatus';

const useStyles = makeStyles({
  /** A section of the pane's details cell — the cell owns the shade and the border. */
  cell: { display: 'flex', flexDirection: 'column', gap: '8px' },
  row: { display: 'flex', alignItems: 'center', gap: '8px' },
  grow: { flex: 1, minWidth: 0 },
  hint: { color: tokens.colorNeutralForeground3 },
  fold: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    background: 'none',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    color: tokens.colorNeutralForeground2,
  },
  body: {
    whiteSpace: 'pre-wrap',
    maxHeight: '200px',
    overflowY: 'auto',
    padding: '8px 10px',
    borderRadius: tokens.borderRadiusMedium,
    // Recessed against the pane, so the ticket's own words read as quoted material.
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground2,
    fontSize: '12px',
  },
  editRow: { display: 'flex', justifyContent: 'flex-end', gap: '8px' },
});

export interface TaskDetailsCellProps {
  task: Task;
  /** True while the scheduler owns the task — status is not hand-settable then. */
  managedByAI: boolean;
  /** Called with the updated task after a status or description change. */
  onTaskChanged: (task: Task) => void;
  /** Called after a description edit, so the timeline/pane can refresh. */
  onEdited?: () => void;
}

export function TaskDetailsCell({
  task,
  managedByAI,
  onTaskChanged,
  onEdited,
}: TaskDetailsCellProps): JSX.Element {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.externalDescription ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Switching cards closes whatever was open on the previous one.
  useEffect(() => {
    setOpen(false);
    setEditing(false);
    setDraft(task.externalDescription ?? '');
    setError(null);
  }, [task.id, task.externalDescription]);

  const isJira = task.externalSource === 'jira';

  async function setStatus(next: ManualStatus): Promise<void> {
    if (next === task.status) return;
    setError(null);
    try {
      onTaskChanged(await window.api.invoke('task:setStatus', task.id, next));
      onEdited?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onTaskChanged(await window.api.invoke('task:setDescription', task.id, draft));
      setEditing(false);
      onEdited?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.cell}>
      <div className={styles.row}>
        <Text weight="semibold">Details</Text>
        <span className={styles.grow} />
        <Dropdown
          size="small"
          value={STATUS_LABEL[task.status]}
          selectedOptions={[task.status]}
          disabled={managedByAI}
          title={managedByAI ? 'Stop the session to change status.' : 'Status'}
          onOptionSelect={(_e, d) => {
            if (d.optionValue) void setStatus(d.optionValue as ManualStatus);
          }}
        >
          {MANUAL_STATUS_OPTIONS.map((o) => (
            <Option key={o.value} value={o.value}>
              {o.label}
            </Option>
          ))}
        </Dropdown>
      </div>

      {task.dependsOn?.length > 0 && (
        <Caption1 className={styles.hint}>Depends on: {task.dependsOn.join(', ')}</Caption1>
      )}

      <div className={styles.row}>
        <button type="button" className={styles.fold} onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDownRegular /> : <ChevronRightRegular />}
          <Caption1>Description</Caption1>
        </button>
        <span className={styles.grow} />
        {open && !editing && (
          <Button size="small" appearance="subtle" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {open &&
        (editing ? (
          <>
            <Textarea
              value={draft}
              resize="vertical"
              onChange={(_e, d) => setDraft(d.value)}
              placeholder="What this card is, and what done means…"
            />
            {isJira && (
              <Caption1 className={styles.hint}>
                Edits the app&apos;s copy — the agent reads this, but nothing is written back to
                JIRA and the next sync replaces it with the ticket&apos;s text.
              </Caption1>
            )}
            <div className={styles.editRow}>
              <Button
                size="small"
                disabled={busy}
                onClick={() => {
                  setDraft(task.externalDescription ?? '');
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
              <Button size="small" appearance="primary" disabled={busy} onClick={() => void save()}>
                Save
              </Button>
            </div>
          </>
        ) : task.externalDescription ? (
          <div className={styles.body}>{task.externalDescription}</div>
        ) : (
          <Caption1 className={styles.hint}>
            No description yet — Edit adds one, and the agent&apos;s prompt quotes it.
          </Caption1>
        ))}
    </div>
  );
}
