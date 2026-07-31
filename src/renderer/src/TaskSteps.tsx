/**
 * The **steps** half of the My Tasks detail pane (Phase 11).
 *
 * Two views on the same chain, both used by `TaskDetail`:
 *
 *  - `TaskSteps` — a card's steps in execution order, the plan they came from, and a
 *    form to write one by hand. The runner executes them one at a time, each in its
 *    own session, so this list is also the card's progress bar.
 *  - `StepBrief` — a single step's brief: the *only* context its session is given, so
 *    it is editable here right up until that step starts.
 */
import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Caption1,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  Textarea,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import type { Task } from '@shared/model';
import { isAgentRunning } from '@shared/board';
import { subtaskProgress } from './board/boardColumns';
import { STATUS_LABEL } from './taskStatus';
import { STATUS_INDICATOR_COLOR } from './theme';
import { FoldToggle } from './FoldToggle';

const useStyles = makeStyles({
  /**
   * A **section**, not a card: the detail pane wraps the agent controls, the details
   * and the steps in one shaded cell, so each of them owning a border would draw three
   * boxes inside a box.
   */
  box: { display: 'flex', flexDirection: 'column', gap: '8px' },
  head: { display: 'flex', alignItems: 'center', gap: '8px' },
  grow: { flex: 1, minWidth: 0 },
  hint: { color: tokens.colorNeutralForeground3 },
  list: { display: 'flex', flexDirection: 'column' },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 4px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    cursor: 'pointer',
  },
  /** The step the runner is on — the one row worth picking out of the list. */
  rowLive: { backgroundColor: tokens.colorNeutralBackground1Selected },
  index: { color: tokens.colorNeutralForeground4, minWidth: '18px' },
  title: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
  form: { display: 'flex', flexDirection: 'column', gap: '6px' },
  formRow: { display: 'flex', justifyContent: 'flex-end', gap: '8px' },
  plan: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: '12px',
    whiteSpace: 'pre-wrap',
    maxHeight: '220px',
    overflowY: 'auto',
    padding: '8px 10px',
    borderRadius: tokens.borderRadiusMedium,
    // Recessed against the pane it sits in.
    backgroundColor: tokens.colorNeutralBackground2,
  },
  brief: { whiteSpace: 'pre-wrap', color: tokens.colorNeutralForeground2, fontSize: '12px' },
});

/** A step is the runner's while it is live — no editing under a live session. */
function isLive(task: Task): boolean {
  return task.status === 'running' || task.status === 'waiting-input';
}

export interface TaskStepsProps {
  /** The card whose chain this is (never a step itself). */
  task: Task;
  /** Its steps, in execution order. */
  subtasks: Task[];
  /** Open a step in the detail pane. */
  onOpen: (taskId: string) => void;
  /** Called after a step is added, so the board can reload. */
  onChanged: () => void;
}

export function TaskSteps({ task, subtasks, onOpen, onChanged }: TaskStepsProps): JSX.Element {
  const styles = useStyles();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [showPlan, setShowPlan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Folded to start with, like Description and Brief.
   *
   * The pane is capped at half the screen and everything in it competes with the
   * conversation underneath — which is the half you actually work in. The card's progress
   * is already on the CARD (the `3/5` counter and a row per step), so the list here is
   * detail you open when you want it, not the first thing to push the chat off-screen. The
   * count rides in the header, so a folded section still says whether opening it is worth it.
   */
  const [open, setOpen] = useState(false);

  // Switching cards closes whatever was open on the previous one.
  useEffect(() => {
    setAdding(false);
    setTitle('');
    setDescription('');
    setShowPlan(false);
    setError(null);
    // Folded again on a new card: the fold is the resting state, not a preference to carry.
    setOpen(false);
  }, [task.id]);

  const progress = subtaskProgress(subtasks);

  async function add(): Promise<void> {
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await window.api.invoke('task:addSubtask', task.id, {
        title: title.trim(),
        description: description.trim() || null,
      });
      setTitle('');
      setDescription('');
      setAdding(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.box}>
      <div className={styles.head}>
        {/* Folds like Description and Brief do, and starts folded for the same reason — see
            `open` above. The count rides along in the header, so a folded section still says
            whether it is worth opening. */}
        <FoldToggle
          open={open}
          onToggle={() => setOpen((v) => !v)}
          summary={progress.total > 0 ? `${progress.done}/${progress.total}` : undefined}
        >
          <Text weight="semibold">Steps</Text>
        </FoldToggle>
        {open && progress.total > 0 && (
          <Badge appearance="tint" color="informative">
            {progress.done}/{progress.total}
          </Badge>
        )}
        <span className={styles.grow} />
        {open && task.agentPlan && (
          <Button size="small" appearance="transparent" onClick={() => setShowPlan((v) => !v)}>
            {showPlan ? 'Hide plan' : 'Approved plan'}
          </Button>
        )}
        {open && (
          <Button size="small" disabled={adding} onClick={() => setAdding(true)}>
            Add step…
          </Button>
        )}
      </div>

      {open && subtasks.length === 0 && !adding && (
        <Caption1 className={styles.hint}>
          No steps yet — approve an agent&apos;s plan, or add them by hand to run this card one
          session at a time.
        </Caption1>
      )}

      {open && showPlan && task.agentPlan && <div className={styles.plan}>{task.agentPlan}</div>}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {open && subtasks.length > 0 && (
        <div className={styles.list}>
          {subtasks.map((step, i) => (
            <div
              key={step.id}
              className={mergeClasses(styles.row, isLive(step) && styles.rowLive)}
              onClick={() => onOpen(step.id)}
            >
              <Caption1 className={styles.index}>{i + 1}.</Caption1>
              <Text className={styles.title}>{step.title}</Text>
              {/* A running step spins instead of wearing a static badge; the highlight
                  says which row, the spinner says it is actually moving. */}
              {isAgentRunning(step) ? (
                <Spinner size="extra-tiny" label="Running" labelPosition="after" />
              ) : (
                /* Outline + the shared indicator colour rather than Fluent's `color` prop:
                   its named palette bottoms out at mid-dark fills, so "done" and "pending"
                   were two shades of the same grey-green at this size. Same colour as the
                   card's step dot, so one step never looks like two states. */
                <Badge
                  appearance="outline"
                  style={{
                    color: STATUS_INDICATOR_COLOR[step.status],
                    borderColor: STATUS_INDICATOR_COLOR[step.status],
                  }}
                >
                  {STATUS_LABEL[step.status]}
                </Badge>
              )}
            </div>
          ))}
        </div>
      )}

      {open && adding && (
        <div className={styles.form}>
          <Field label="Step" required>
            <Input
              value={title}
              onChange={(_e, d) => setTitle(d.value)}
              placeholder="What this step delivers…"
            />
          </Field>
          <Field
            label="Brief"
            hint="The only context this step's session gets — say what “done” means."
          >
            <Textarea
              value={description}
              resize="vertical"
              onChange={(_e, d) => setDescription(d.value)}
              placeholder="Files to touch, the acceptance check, anything it must not do…"
            />
          </Field>
          <div className={styles.formRow}>
            <Button size="small" disabled={busy} onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              size="small"
              appearance="primary"
              disabled={busy || !title.trim()}
              onClick={() => void add()}
            >
              Add step
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export interface StepBriefProps {
  /** The step being shown (has a `parentTaskId`). */
  task: Task;
  /** Called with the updated step after an edit. */
  onChanged: (task: Task) => void;
}

/** A step's brief, editable until its session starts. */
export function StepBrief({ task, onChanged }: StepBriefProps): JSX.Element {
  const styles = useStyles();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Folded to start with, like Steps and Description. A brief is the whole prompt a step's
   * session gets, so it can run to many paragraphs — and on a step you have opened to read
   * the transcript of, all of it sits between you and the conversation.
   */
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setEditing(false);
    setDraft(task.description ?? '');
    setError(null);
    // Folded again per step, for the same reason Steps is.
    setOpen(false);
  }, [task.id, task.description]);

  const live = isLive(task);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onChanged(
        await window.api.invoke('task:updateSubtask', task.id, {
          description: draft.trim() || null,
        }),
      );
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.box}>
      <div className={styles.head}>
        {/* Same fold as Steps and Description, and folded to start with for the reason
            spelled out on `open` above. */}
        <FoldToggle
          open={open}
          onToggle={() => setOpen((v) => !v)}
          summary={task.description ? undefined : 'none'}
        >
          <Text weight="semibold">Brief</Text>
        </FoldToggle>
        <span className={styles.grow} />
        {open && !editing && (
          <Button
            size="small"
            appearance="transparent"
            disabled={live}
            title={live ? 'The step is running — its prompt is already built.' : undefined}
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        )}
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {!open ? null : editing ? (
        <div className={styles.form}>
          <Textarea
            value={draft}
            resize="vertical"
            onChange={(_e, d) => setDraft(d.value)}
            placeholder="What this step must deliver…"
          />
          <div className={styles.formRow}>
            <Button
              size="small"
              disabled={busy}
              onClick={() => {
                setDraft(task.description ?? '');
                setEditing(false);
              }}
            >
              Cancel
            </Button>
            <Button size="small" appearance="primary" disabled={busy} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      ) : task.description ? (
        <div className={styles.brief}>{task.description}</div>
      ) : (
        <Caption1 className={styles.hint}>
          No brief — the step will run on its title alone.
        </Caption1>
      )}
    </div>
  );
}
