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
  Text,
  Textarea,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import type { Task } from '@shared/model';
import { isAgentRunning } from '@shared/board';
import { subtaskProgress } from './board/boardColumns';
import { canReplan, REFUSAL_HINT } from './taskChat';
import { STATUS_LABEL } from './taskStatus';
import { FLUO, STATUS_INDICATOR_COLOR } from './theme';
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
  /** The live row's marker: the dot, then the word, on one baseline. */
  running: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexShrink: 0,
    color: FLUO.cyan,
  },
  /** 7px, matching the pane's pipeline-stage dots exactly — this is the same signal. */
  dot: { width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0 },
  /**
   * The blink, between the spinner's two cyans — the same keyframes the card's step and
   * stage dots and the agent glyph use, so "working" looks like one thing everywhere.
   */
  dotRunning: {
    animationName: {
      '0%, 100%': { backgroundColor: FLUO.cyanDeep },
      '50%': { backgroundColor: FLUO.cyan },
    },
    animationDuration: '1s',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'ease-in-out',
    // Without motion the dot must still read as the live one, so hold it at the bright end.
    '@media (prefers-reduced-motion: reduce)': {
      animationName: 'none',
      backgroundColor: FLUO.cyan,
    },
  },
});

/** A step is the runner's while it is live — no editing under a live session. */
function isLive(task: Task): boolean {
  return task.status === 'running' || task.status === 'waiting-input';
}

/** One planning round's steps, with the index each holds in the card's whole chain. */
interface StepRound {
  round: number;
  steps: Array<{ step: Task; index: number }>;
}

/**
 * Split a chain into its planning rounds, in order (Phase 18).
 *
 * The chain itself stays one sequence — `index` is the step's position across the WHOLE
 * card, so the numbering the human reads never restarts and never disagrees with the
 * card's `3/7` counter. Rounds only decide what can be folded away.
 *
 * Steps that predate re-planning carry no round at all, which `rowToTask` already reads
 * as round 1; the `?? 1` here is the same answer for a task that never went through it.
 */
export function groupStepsByRound(subtasks: Task[]): StepRound[] {
  const rounds: StepRound[] = [];
  subtasks.forEach((step, index) => {
    const round = step.planRound ?? 1;
    const last = rounds[rounds.length - 1];
    // Grouped by ADJACENCY, not by collecting equal round numbers: steps are appended in
    // round order, and a list that reordered them would put the chain's numbering out of
    // step with the order it actually runs in.
    if (last && last.round === round) last.steps.push({ step, index });
    else rounds.push({ round, steps: [{ step, index }] });
  });
  return rounds;
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
  /** The re-plan brief box, and the "it's thinking" banner once a turn has started. */
  const [planning, setPlanning] = useState(false);
  const [planNote, setPlanNote] = useState('');
  const [planStarted, setPlanStarted] = useState(false);
  /** Which earlier rounds the human has opened. The current one is never in here. */
  const [openRounds, setOpenRounds] = useState<ReadonlySet<number>>(new Set());

  // Switching cards closes whatever was open on the previous one.
  useEffect(() => {
    setAdding(false);
    setTitle('');
    setDescription('');
    setShowPlan(false);
    setError(null);
    // Folded again on a new card: the fold is the resting state, not a preference to carry.
    setOpen(false);
    setPlanning(false);
    setPlanNote('');
    setPlanStarted(false);
    setOpenRounds(new Set());
  }, [task.id]);

  // The planner's turn is over once the card stops running — drop the banner rather than
  // leave it claiming work is in flight. The plan itself arrives as an inbox item above.
  useEffect(() => {
    if (planStarted && !isLive(task)) setPlanStarted(false);
  }, [planStarted, task.status]);

  const progress = subtaskProgress(subtasks);
  const replan = canReplan(task, subtasks);
  const rounds = groupStepsByRound(subtasks);

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

  /**
   * Ask the agent for the next round. A refusal is a normal answer here, not an error —
   * the scheduler's guards are stricter than this component can see (a run reserved but
   * not yet spawned, say), so its reason is shown rather than a thrown string.
   */
  async function startReplan(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await window.api.invoke('task:replan', task.id, planNote.trim() || undefined);
      if (result.status === 'refused') {
        setError(REFUSAL_HINT[result.reason]);
        return;
      }
      setPlanning(false);
      setPlanNote('');
      setPlanStarted(true);
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
        {/* Deliberately OUTSIDE the `open &&` gate the other controls sit behind. The section
            starts folded, and a card whose chain has finished shows `3/3` and nothing else —
            so a re-plan control you can only reach by unfolding first is the very "there is
            no way to ask for more work" this exists to fix. */}
        {replan.offered && (
          <Button
            size="small"
            disabled={!replan.can || busy || planning}
            title={replan.hint}
            onClick={() => setPlanning(true)}
          >
            Plan more steps…
          </Button>
        )}
        {open && (
          <Button size="small" disabled={adding} onClick={() => setAdding(true)}>
            Add step…
          </Button>
        )}
      </div>

      {planStarted && (
        <MessageBar intent="info">
          <MessageBarBody>
            Planning… the agent will propose the next steps; approve them above when it asks.
          </MessageBarBody>
        </MessageBar>
      )}

      {planning && (
        <div className={styles.form}>
          <Field
            label="What should the next steps cover?"
            hint="Optional — the agent is already told which steps this card has finished."
          >
            <Textarea
              value={planNote}
              resize="vertical"
              onChange={(_e, d) => setPlanNote(d.value)}
              placeholder="The remaining work, anything to leave alone, what “done” looks like…"
            />
          </Field>
          <div className={styles.formRow}>
            <Button size="small" disabled={busy} onClick={() => setPlanning(false)}>
              Cancel
            </Button>
            <Button
              size="small"
              appearance="primary"
              disabled={busy}
              onClick={() => void startReplan()}
            >
              Plan
            </Button>
          </div>
        </div>
      )}

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

      {open &&
        rounds.map((group, gi) => {
          // The newest round is the one being worked, so it is always open. Earlier rounds
          // fold away — a card re-planned three times would otherwise push the conversation
          // off-screen with work that is already finished.
          const current = gi === rounds.length - 1;
          const grouped = rounds.length > 1;
          const shown = current || openRounds.has(group.round);
          const done = group.steps.filter((s) => s.step.status === 'done').length;
          return (
            <div key={group.round} className={styles.box}>
              {grouped && (
                <FoldToggle
                  open={shown}
                  onToggle={() =>
                    setOpenRounds((prev) => {
                      const next = new Set(prev);
                      if (next.has(group.round)) next.delete(group.round);
                      else next.add(group.round);
                      return next;
                    })
                  }
                  summary={`${done}/${group.steps.length}`}
                >
                  <Caption1 className={styles.hint}>Round {group.round}</Caption1>
                </FoldToggle>
              )}
              {shown && (
                <div className={styles.list}>
                  {group.steps.map(({ step, index }) => (
                    <div
                      key={step.id}
                      className={mergeClasses(styles.row, isLive(step) && styles.rowLive)}
                      onClick={() => onOpen(step.id)}
                    >
                      {/* The step's place in the WHOLE chain, so the numbers never restart
                          and never contradict the card's own counter. */}
                      <Caption1 className={styles.index}>{index + 1}.</Caption1>
                      <Text className={styles.title}>{step.title}</Text>
                      {/* A running step wears a blinking cyan dot, exactly as a running
                          pipeline stage does two sections below it — the app says "this is
                          moving" with one shape everywhere, and this row used to say it with
                          a turning spinner instead. The word stays: the rows around it carry
                          a status word, and a bare dot here would be the only row saying
                          nothing. */}
                      {isAgentRunning(step) ? (
                        <span className={styles.running}>
                          <span className={mergeClasses(styles.dot, styles.dotRunning)} />
                          <Caption1>Running</Caption1>
                        </span>
                      ) : (
                        /* Outline + the shared indicator colour rather than Fluent's `color`
                           prop: its named palette bottoms out at mid-dark fills, so "done"
                           and "pending" were two shades of the same grey-green at this size.
                           Same colour as the card's step dot, so one step never looks like
                           two states. */
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
            </div>
          );
        })}

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
