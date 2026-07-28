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
import type { ManualStatus, Project, Task } from '@shared/model';
import { DEFAULT_PRIORITIES, priorityColor } from '@shared/priority';
import { MANUAL_STATUS_OPTIONS, STATUS_LABEL } from './taskStatus';

/** The dropdown entry for "no priority" — a real option, since clearing must be possible. */
const NO_PRIORITY = 'None';
/** Ditto for "no project". A sentinel value, since a Dropdown option cannot carry null. */
const NO_PROJECT = '__none__';

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
  /** The same square the board card wears, so the two read as one control's two views. */
  prioritySquare: { width: '12px', height: '12px', borderRadius: '3px', flexShrink: 0 },
  picker: { minWidth: '116px' },
});

export interface TaskDetailsCellProps {
  task: Task;
  /** The projects a card can be filed under (Settings → Agents). */
  agentProjects?: Project[];
  /** True while the scheduler owns the task — status is not hand-settable then. */
  managedByAI: boolean;
  /** Called with the updated task after a status or description change. */
  onTaskChanged: (task: Task) => void;
  /** Called after a description edit, so the timeline/pane can refresh. */
  onEdited?: () => void;
}

export function TaskDetailsCell({
  task,
  agentProjects = [],
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
  const [jiraPriorities, setJiraPriorities] = useState<string[]>([]);

  // Switching cards closes whatever was open on the previous one.
  useEffect(() => {
    setOpen(false);
    setEditing(false);
    setDraft(task.externalDescription ?? '');
    setError(null);
  }, [task.id, task.externalDescription]);

  const isJira = task.externalSource === 'jira';

  // A JIRA card may only be given a priority this instance actually has — anything
  // else is rejected by the PUT. Main caches the list, so this costs one IPC round
  // trip per pane; an empty answer (JIRA off, or the call failed) falls back to the
  // built-in scale rather than leaving the dropdown unusable.
  useEffect(() => {
    if (!isJira) return;
    let live = true;
    void window.api
      .invoke('jira:priorities')
      .then((names) => live && setJiraPriorities(names))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [isJira]);

  const priorities = (
    isJira && jiraPriorities.length ? jiraPriorities : DEFAULT_PRIORITIES
  ).slice();
  const priority = task.externalPriority ?? null;
  const squareColor = priorityColor(priority);
  const project = agentProjects.find((p) => p.id === task.agentProjectId) ?? null;

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

  async function setPriority(next: string | null): Promise<void> {
    if (next === priority) return;
    setError(null);
    setBusy(true);
    try {
      onTaskChanged(await window.api.invoke('task:setPriority', task.id, next));
      onEdited?.();
    } catch (e) {
      // The card keeps its old priority: main writes JIRA first and only then the row.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** File the card under a project. Tagging only — this never starts an agent. */
  async function setProject(next: string | null): Promise<void> {
    if (next === (task.agentProjectId ?? null)) return;
    setError(null);
    setBusy(true);
    try {
      onTaskChanged(await window.api.invoke('task:setProject', task.id, next));
      onEdited?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
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

      {/* Priority sits under the status because it is the other thing you change about
          a card without touching its text — and for a JIRA card this one really does
          leave the app: the issue is updated, and a rejection leaves the card alone. */}
      <div className={styles.row}>
        <Caption1 className={styles.hint}>Priority</Caption1>
        <span className={styles.grow} />
        {squareColor && (
          <span className={styles.prioritySquare} style={{ backgroundColor: squareColor }} />
        )}
        <Dropdown
          className={styles.picker}
          size="small"
          value={priority ?? NO_PRIORITY}
          selectedOptions={[priority ?? NO_PRIORITY]}
          disabled={busy}
          title={isJira ? 'Also updates the linked JIRA issue' : 'Priority'}
          onOptionSelect={(_e, d) => {
            if (d.optionValue)
              void setPriority(d.optionValue === NO_PRIORITY ? null : d.optionValue);
          }}
        >
          {priorities.map((p) => (
            <Option key={p} value={p}>
              {p}
            </Option>
          ))}
          <Option value={NO_PRIORITY}>{NO_PRIORITY}</Option>
        </Dropdown>
      </div>

      {/* Which project this card is about. Setting it files the card — starting an
          agent on it is the separate act in the panel above. */}
      {agentProjects.length > 0 && (
        <div className={styles.row}>
          <Caption1 className={styles.hint}>Project</Caption1>
          <span className={styles.grow} />
          {project?.color && (
            <span className={styles.prioritySquare} style={{ backgroundColor: project.color }} />
          )}
          <Dropdown
            className={styles.picker}
            size="small"
            value={project?.name ?? 'None'}
            selectedOptions={[task.agentProjectId ?? NO_PROJECT]}
            disabled={busy}
            title="The repo this card is about — filing it here does not start an agent"
            onOptionSelect={(_e, d) => {
              if (d.optionValue)
                void setProject(d.optionValue === NO_PROJECT ? null : d.optionValue);
            }}
          >
            {agentProjects.map((p) => (
              <Option key={p.id} value={p.id} text={p.name}>
                {p.name}
              </Option>
            ))}
            <Option value={NO_PROJECT} text="None">
              None
            </Option>
          </Dropdown>
        </div>
      )}

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
