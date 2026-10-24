/**
 * The **steps** half of the My Tasks detail pane (Phase 11).
 *
 * Two views on the same chain, both used by `TaskDetail`:
 *
 *  - `TaskSteps` — a card's steps in execution order, the plan they came from, and a
 *    form to write one by hand. The runner executes them one at a time, each in its
 *    own session, so this list is also the card's progress bar.
 *  - `StepBrief` — a single step's brief: the *only* context its session is given, so
 *    it is editable here right up until that step starts. Its files sit inside the same
 *    fold, for the reason the card's do: a file is the part of the brief that is not prose.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { WindowConsoleRegular } from '@fluentui/react-icons';
import type { AttentionItem } from '@tm/shared/attention';
import type { Task, TaskActivityEntry } from '@tm/shared/model';
import { isAgentRunning } from '@tm/shared/board';
import {
  attachmentsInScope,
  insertAttachmentRef,
  type TaskAttachment,
} from '@tm/shared/attachments';
import { AttachmentStrip } from './AttachmentStrip';
import type { AttentionIndex } from './attentionIndex';
import { gateStepView } from './gateStepView';
import { useGateTrustHost } from './gateTrustHost';
import { splitStepPhases, subtaskProgress } from './board/boardColumns';
import { draftKey, useDraft } from './drafts';
import { SkillPicker } from './SkillPicker';
import type { SkillOption } from './skillPickerState';
import { canReplan, REFUSAL_HINT } from './taskChat';
import { STATUS_LABEL } from './taskStatus';
import { FLUO_VAR, STATUS_INDICATOR_VAR } from './tokens';
import { FoldToggle } from './FoldToggle';
import { useSkillOptions } from './useSkillOptions';
import { useTransport } from './transport';
import { usePasteAttachments } from './usePasteAttachments';

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
  /**
   * A step the inbox is holding something for — the same tint the card's own step rows used
   * to wear (`var(--tm-attention-tint)`), so a step that wants you says so here exactly as it
   * did on the card before F13.24 moved the list into the peek.
   */
  rowLoud: { backgroundColor: 'var(--tm-attention-tint)' },
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
    color: FLUO_VAR.cyan,
  },
  /** A gate's own lines — monochrome: the status badge is the row's only colour. */
  gateIcon: { color: tokens.colorNeutralForeground3, flexShrink: 0, fontSize: '16px' },
  gateCommand: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '40%',
  },
  gateOutput: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: '12px',
    whiteSpace: 'pre-wrap',
    maxHeight: '220px',
    overflowY: 'auto',
    padding: '8px 10px',
    margin: '0 4px 6px 30px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground2,
  },
  /** 7px, matching the pane's pipeline-stage dots exactly — this is the same signal. */
  dot: { width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0 },
  /**
   * The blink, between the spinner's two cyans — the same keyframes the card's step and
   * stage dots and the agent glyph use, so "working" looks like one thing everywhere.
   */
  dotRunning: {
    animationName: {
      '0%, 100%': { backgroundColor: FLUO_VAR.cyanDeep },
      '50%': { backgroundColor: FLUO_VAR.cyan },
    },
    animationDuration: '1s',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'ease-in-out',
    // Without motion the dot must still read as the live one, so hold it at the bright end.
    '@media (prefers-reduced-motion: reduce)': {
      animationName: 'none',
      backgroundColor: FLUO_VAR.cyan,
    },
  },
});

/** A step is the runner's while it is live — no editing under a live session. */
function isLive(task: Task): boolean {
  return task.status === 'running' || task.status === 'waiting-input';
}

/**
 * Why a live step's brief is frozen — one sentence for BOTH controls it turns off.
 *
 * Editing the words and attaching a file are the same act at different granularity, and
 * they are refused for the same reason: the prompt this step's session was handed is
 * already built, so anything added now would be added to nothing.
 */
const LIVE_HINT = 'The step is running — its prompt is already built.';

export interface TaskStepsProps {
  /** The card whose chain this is (never a step itself). */
  task: Task;
  /** Its steps, in execution order. */
  subtasks: Task[];
  /** Open a step in the detail pane. */
  onOpen: (taskId: string) => void;
  /** Called after a step is added, so the board can reload. */
  onChanged: () => void;
  /**
   * The board's inbox index — a gate row reads its failure output and "awaiting trust" off
   * the item parked on it. Optional: without it a gate still shows its status and attempts.
   */
  attention?: AttentionIndex;
  /**
   * Start unfolded — the full-screen issue page, which has the room the capped pane lacks
   * and where the checklist is the page's own "Sub-issues" block. Absent: folded, as below.
   */
  defaultOpen?: boolean;
}

export function TaskSteps({
  task,
  subtasks,
  onOpen,
  onChanged,
  attention,
  defaultOpen = false,
}: TaskStepsProps): JSX.Element {
  const transport = useTransport();
  const styles = useStyles();
  const [adding, setAdding] = useState(false);
  /**
   * The step being written by hand — its title and its brief — as DRAFTS (`./drafts`), so
   * checking another card mid-sentence no longer empties the form. Both belong to the card
   * the step is being added to, hence the key.
   */
  const stepTitle = useDraft(draftKey(task.id, 'newStepTitle'), '');
  const stepBrief = useDraft(draftKey(task.id, 'newStepBrief'), '');
  const title = stepTitle.value;
  const description = stepBrief.value;
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
  const [open, setOpen] = useState(defaultOpen);
  /** The re-plan brief box, and the "it's thinking" banner once a turn has started. */
  const [planning, setPlanning] = useState(false);
  /** The re-plan note, drafted per card for the same reason the add-step form is. */
  const planNoteDraft = useDraft(draftKey(task.id, 'planNote'), '');
  const planNote = planNoteDraft.value;
  const [planStarted, setPlanStarted] = useState(false);
  /**
   * Which round the planning form is asking about — `null` for the ordinary "plan the next
   * round" ask, a round number when it was opened from a LATER phase's own "Re-plan…"
   * button (Phase 20). One form serves both: only its label and what it sends differ.
   */
  const [replanTarget, setReplanTarget] = useState<number | null>(null);
  /**
   * Which non-current phases the human has opened — earlier ones and later ones share this
   * one set, since a round number is never both. The current phase is never in here: it is
   * always open on its own (see the render below).
   */
  const [openRounds, setOpenRounds] = useState<ReadonlySet<number>>(new Set());
  /** Repo skills follow the CARD's agent project — every step runs in the same worktree. */
  const skillOptionsState = useSkillOptions(task.agentProjectId ?? null);

  // Switching cards closes whatever was open on the previous one. What was TYPED into those
  // forms is not cleared here any more — each field is a draft, parked under the card it was
  // written for and put back when you return to it.
  useEffect(() => {
    setAdding(false);
    setShowPlan(false);
    setError(null);
    // Folded again on a new card: the fold is the resting state, not a preference to carry.
    setOpen(defaultOpen);
    setPlanning(false);
    setPlanStarted(false);
    setReplanTarget(null);
    setOpenRounds(new Set());
  }, [task.id]);

  // The planner's turn is over once the card stops running — drop the banner rather than
  // leave it claiming work is in flight. The plan itself arrives as an inbox item above.
  useEffect(() => {
    if (planStarted && !isLive(task)) setPlanStarted(false);
  }, [planStarted, task.status]);

  const progress = subtaskProgress(subtasks);
  const replan = canReplan(task, subtasks);
  const { earlier, current, later } = splitStepPhases(subtasks);
  const phases = [...earlier, ...(current ? [current] : []), ...later];
  const grouped = phases.length > 1;

  async function add(): Promise<void> {
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await transport.invoke('task:addSubtask', task.id, {
        title: title.trim(),
        description: description.trim() || null,
      });
      // The step exists now, so the form's drafts have been spent.
      stepTitle.reset();
      stepBrief.reset();
      setAdding(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** A step's own `skillRefs` — never the card's, which the picker never lets you toggle. */
  async function saveStepSkillRefs(stepId: string, nextOwn: string[]): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await transport.invoke('task:setSkillRefs', stepId, nextOwn);
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
      const result = await transport.invoke(
        'task:replan',
        task.id,
        planNote.trim() || undefined,
        replanTarget !== null ? { replaceRound: replanTarget } : undefined,
      );
      if (result.status === 'refused') {
        setError(REFUSAL_HINT[result.reason]);
        return;
      }
      setPlanning(false);
      setReplanTarget(null);
      planNoteDraft.reset();
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
            onClick={() => {
              setReplanTarget(null);
              setPlanning(true);
            }}
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
            label={
              replanTarget !== null
                ? `What should replace phase ${replanTarget}?`
                : 'What should the next steps cover?'
            }
            hint={
              replanTarget !== null
                ? 'Optional — the agent is told which steps in this phase are being replaced.'
                : 'Optional — the agent is already told which steps this card has finished.'
            }
          >
            <Textarea
              value={planNote}
              resize="vertical"
              onChange={(_e, d) => planNoteDraft.set(d.value)}
              placeholder="The remaining work, anything to leave alone, what “done” looks like…"
            />
          </Field>
          <div className={styles.formRow}>
            {/* Cancel throws the note away — a draft is kept for the human who WANDERED
                off, not for the one who said no. */}
            <Button
              size="small"
              disabled={busy}
              onClick={() => {
                planNoteDraft.reset();
                setPlanning(false);
                setReplanTarget(null);
              }}
            >
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
        phases.map((group) => {
          // The current phase is the one being worked (or the one to resume into), so it is
          // always open — and its header is plain text, not a toggle: with `shown` forced to
          // `true` below, a chevron here would be dead, clickable but unable to do anything.
          // Earlier and later phases fold away — a card re-planned three times, or one whose
          // plan already covers phases it hasn't reached, would otherwise push the
          // conversation off-screen with work that is finished or hasn't started.
          const isCurrent = group.round === current?.round;
          const isLater = !isCurrent && later.some((l) => l.round === group.round);
          const shown = isCurrent || openRounds.has(group.round);
          const done = group.steps.filter((s) => s.step.status === 'done').length;
          return (
            <div key={group.round} className={styles.box}>
              {grouped &&
                (isCurrent ? (
                  <Caption1 className={styles.hint}>Phase {group.round}</Caption1>
                ) : (
                  <div className={styles.head}>
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
                      summary={
                        isLater
                          ? `0/${group.steps.length} · upcoming`
                          : `${done}/${group.steps.length}`
                      }
                    >
                      <Caption1 className={styles.hint}>Phase {group.round}</Caption1>
                    </FoldToggle>
                    <span className={styles.grow} />
                    {/* Only a LATER phase can be re-planned in place — the current one is
                        already being worked (or is next to resume), and an earlier one is
                        already behind the chain. Same `canReplan` rules as "Plan more
                        steps…" above: this is the identical ask, aimed at one existing
                        round instead of a new one after it. */}
                    {isLater && replan.offered && (
                      <Button
                        size="small"
                        appearance="transparent"
                        disabled={!replan.can || busy || planning}
                        title={replan.hint}
                        onClick={() => {
                          setReplanTarget(group.round);
                          setPlanning(true);
                        }}
                      >
                        Re-plan…
                      </Button>
                    )}
                  </div>
                ))}
              {shown && (
                <div className={styles.list}>
                  {group.steps.map(({ step, index }) =>
                    step.stepSpec?.kind === 'gate' ? (
                      <GateRow
                        key={step.id}
                        step={step}
                        index={index}
                        attention={attention?.itemsFor([step.id]) ?? []}
                        onOpen={onOpen}
                      />
                    ) : (
                      <StepRow
                        key={step.id}
                        step={step}
                        index={index}
                        wantsAttention={attention?.taskIds.has(step.id) ?? false}
                        skillOptions={skillOptionsState.options}
                        skillOptionsLoading={skillOptionsState.loading}
                        inheritedSkillRefs={task.skillRefs ?? undefined}
                        busy={busy}
                        onSaveSkillRefs={(next) => void saveStepSkillRefs(step.id, next)}
                        onOpen={onOpen}
                      />
                    ),
                  )}
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
              onChange={(_e, d) => stepTitle.set(d.value)}
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
              onChange={(_e, d) => stepBrief.set(d.value)}
              placeholder="Files to touch, the acceptance check, anything it must not do…"
            />
          </Field>
          <div className={styles.formRow}>
            {/* Cancel empties the form: the drafts are there for the card you wandered away
                from, not for the step you decided against. Without this the text would now
                outlive the "no" that dismissed it, since nothing else clears it any more. */}
            <Button
              size="small"
              disabled={busy}
              onClick={() => {
                stepTitle.reset();
                stepBrief.reset();
                setAdding(false);
              }}
            >
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

export interface StepRowProps {
  step: Task;
  /** The step's place in the whole chain. */
  index: number;
  /** Whether the inbox is holding an item for this step — the row's attention tint. */
  wantsAttention: boolean;
  skillOptions: SkillOption[];
  skillOptionsLoading: boolean;
  /** The parent card's own `skillRefs`, shown checked and captioned "from card". */
  inheritedSkillRefs?: string[];
  busy: boolean;
  onSaveSkillRefs: (next: string[]) => void;
  onOpen: (taskId: string) => void;
}

/**
 * An ordinary agent step's row: its place in the chain, title, skill picker, and either the
 * blinking "Running" dot or its status badge. Pulled out of `TaskSteps`' own render — same
 * split `GateRow` below already makes — so the attention tint and the running dot (F13.24,
 * carried over from the board card's own step rows) are testable without going through the
 * section's fold.
 */
export function StepRow({
  step,
  index,
  wantsAttention,
  skillOptions,
  skillOptionsLoading,
  inheritedSkillRefs,
  busy,
  onSaveSkillRefs,
  onOpen,
}: StepRowProps): JSX.Element {
  const styles = useStyles();
  return (
    <div
      className={mergeClasses(
        styles.row,
        isLive(step) && styles.rowLive,
        wantsAttention && styles.rowLoud,
      )}
      onClick={() => onOpen(step.id)}
    >
      {/* The step's place in the WHOLE chain, so the numbers never restart and never
          contradict the card's own counter. */}
      <Caption1 className={styles.index}>{index + 1}.</Caption1>
      <Text className={styles.title}>{step.title}</Text>
      <SkillPicker
        options={skillOptions}
        own={step.skillRefs ?? []}
        inherited={inheritedSkillRefs}
        onChange={onSaveSkillRefs}
        disabled={busy}
        loading={skillOptionsLoading}
      />
      {/* A running step wears a blinking cyan dot, exactly as a running pipeline stage does
          two sections below it — the app says "this is moving" with one shape everywhere,
          and this row used to say it with a turning spinner instead. The word stays: the
          rows around it carry a status word, and a bare dot here would be the only row
          saying nothing. */}
      {isAgentRunning(step) ? (
        <span className={styles.running}>
          <span className={mergeClasses(styles.dot, styles.dotRunning)} />
          <Caption1>Running</Caption1>
        </span>
      ) : (
        /* Outline + the shared indicator colour rather than Fluent's `color` prop: its named
         palette bottoms out at mid-dark fills, so "done" and "pending" were two shades of
         the same grey-green at this size. Same colour as the card's step dot, so one step
         never looks like two states. */
        <Badge
          appearance="outline"
          style={{
            color: STATUS_INDICATOR_VAR[step.status],
            borderColor: STATUS_INDICATOR_VAR[step.status],
          }}
        >
          {STATUS_LABEL[step.status]}
        </Badge>
      )}
    </div>
  );
}

export interface GateRowProps {
  step: Task;
  /** The step's place in the whole chain. */
  index: number;
  /** Inbox items parked on this step. */
  attention: readonly AttentionItem[];
  onOpen: (taskId: string) => void;
}

/**
 * A gate step's row (F8.10): a terminal icon and the command where an agent step has its
 * skills, the attempt chip once it has looped back, and an expander with the newest output
 * the engine recorded. Everything but the status badge is monochrome — the badge is the
 * only part of a gate that moves. What it says comes from `gateStepView`, never from here.
 */
export function GateRow({ step, index, attention, onOpen }: GateRowProps): JSX.Element | null {
  const transport = useTransport();
  const trustHost = useGateTrustHost();
  const styles = useStyles();
  const [showOutput, setShowOutput] = useState(false);
  /** The step's own timeline, read when the expander opens — null until then. */
  const [activity, setActivity] = useState<TaskActivityEntry[] | null>(null);

  // A gate that changed state since the expander last read its timeline has new notes on it.
  useEffect(() => {
    setActivity(null);
  }, [step.id, step.status, step.gateAttempts]);

  useEffect(() => {
    if (!showOutput || activity !== null) return;
    let cancelled = false;
    void transport
      .invoke('task:activity', step.id)
      .catch(() => [])
      .then((entries) => {
        if (!cancelled) setActivity(entries);
      });
    return () => {
      cancelled = true;
    };
  }, [showOutput, activity, step.id, transport]);

  const view = gateStepView({ step, attention, activity: activity ?? [], trustHost });
  if (!view) return null;
  return (
    <div>
      <div
        className={mergeClasses(
          styles.row,
          isLive(step) && styles.rowLive,
          attention.length > 0 && styles.rowLoud,
        )}
        onClick={() => onOpen(step.id)}
      >
        <Caption1 className={styles.index}>{index + 1}.</Caption1>
        <WindowConsoleRegular className={styles.gateIcon} aria-label="Gate step" />
        <Text className={styles.title}>{step.title}</Text>
        <span className={styles.gateCommand} title={view.command}>
          {view.command}
        </span>
        {view.attempt && (
          <Badge appearance="outline" color="subtle">
            {view.attempt}
          </Badge>
        )}
        {/* Its own click, not the row's: unfolding the output must not also open the step. */}
        <span onClick={(e) => e.stopPropagation()}>
          <FoldToggle open={showOutput} onToggle={() => setShowOutput((v) => !v)}>
            <Caption1 className={styles.hint}>Output</Caption1>
          </FoldToggle>
        </span>
        {view.state === 'running' ? (
          <span className={styles.running}>
            <span className={mergeClasses(styles.dot, styles.dotRunning)} />
            <Caption1>{view.label}</Caption1>
          </span>
        ) : (
          <Badge
            appearance="outline"
            style={{
              color: STATUS_INDICATOR_VAR[view.tone],
              borderColor: STATUS_INDICATOR_VAR[view.tone],
            }}
          >
            {view.label}
          </Badge>
        )}
        {/* This host cannot press Trust itself (F8.13) — say so beside the badge rather
            than leaving "Awaiting trust" to read as a desktop that is simply slow. */}
        {view.waiting && <Caption1 className={styles.hint}>{view.waiting}</Caption1>}
      </div>
      {showOutput &&
        (view.output ? (
          <div className={styles.gateOutput}>{view.output}</div>
        ) : (
          <Caption1 className={mergeClasses(styles.hint, styles.gateOutput)}>
            {activity === null ? 'Loading…' : 'No output recorded yet.'}
          </Caption1>
        ))}
    </div>
  );
}

export interface StepBriefProps {
  /** The step being shown (has a `parentTaskId`). */
  task: Task;
  /** This STEP's own files, sliced out of the board's attachment list. */
  attachments?: readonly TaskAttachment[];
  /**
   * The parent CARD's files. A step sees them too — the mockup is attached once, to the
   * card, and every step that has to match it says `@mockup.png`; attaching it again per
   * step would be a copy per step, and copies drift. See {@link attachmentsInScope}.
   */
  parentAttachments?: readonly TaskAttachment[];
  /** Called with the updated step after an edit. */
  onChanged: (task: Task) => void;
}

/** A step's brief and its files, editable until its session starts. */
export function StepBrief({
  task,
  attachments = [],
  parentAttachments = [],
  onChanged,
}: StepBriefProps): JSX.Element {
  const transport = useTransport();
  const styles = useStyles();
  const [editing, setEditing] = useState(false);
  /** The brief being written, as a draft — see `./drafts` and the card's description. */
  const brief = useDraft(draftKey(task.id, 'brief'), task.description ?? '');
  const draft = brief.value;
  const setDraft = brief.set;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The brief field, so an attachment can be cited where the caret actually is. */
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /**
   * Folded to start with, like Steps and Description. A brief is the whole prompt a step's
   * session gets, so it can run to many paragraphs — and on a step you have opened to read
   * the transcript of, all of it sits between you and the conversation.
   */
  const [open, setOpen] = useState(false);

  // Keyed on the step's ID alone: it used to depend on the brief's TEXT as well, so anything
  // that rewrote the step row while you were editing — a sync, a run's own update — folded
  // the section shut and threw the edit away. The text is the draft's business now.
  useEffect(() => {
    setEditing(false);
    setError(null);
    // Folded again per step, for the same reason Steps is.
    setOpen(false);
  }, [task.id]);

  const live = isLive(task);

  /**
   * What this step may name: its own files, then whatever the card adds that it has not
   * already shadowed. The same list the prompt builder will resolve `@name` against, from
   * the same function, so what the chips offer and what the agent gets cannot disagree.
   */
  const scope = useMemo(
    () => attachmentsInScope(attachments, parentAttachments),
    [attachments, parentAttachments],
  );

  /**
   * Write `@name` for each of `names` into the draft, where the caret is — the card's
   * `insertRefs` verbatim, and folded rather than looped for the reason given there: every
   * call reads the SAME `draft` from this render, so five separate inserts would leave only
   * the fifth file cited.
   */
  function insertRefs(names: readonly string[]): void {
    let text = draft;
    let caret = textareaRef.current?.selectionStart ?? draft.length;
    for (const name of names) ({ text, caret } = insertAttachmentRef(text, caret, name));
    setDraft(text);
    // After React has written the new value, or the browser puts the caret back at the end
    // of the old one and the next thing typed lands somewhere else entirely.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  }

  /** Paste a screenshot straight into the brief — the strip's drop, at the caret. */
  const paste = usePasteAttachments({
    taskId: task.id,
    attachments: scope,
    onInsertRefs: insertRefs,
    disabled: busy || live,
    onError: setError,
  });

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onChanged(
        await transport.invoke('task:updateSubtask', task.id, {
          description: draft.trim() || null,
        }),
      );
      // Saved: the step says this now, so there is nothing left to restore.
      brief.commit();
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
            spelled out on `open` above.

            The summary counts the FILES when there are any, exactly as the card's
            Description fold does: a brief you have read is worth leaving shut, and the one
            thing still worth knowing about what is behind it is whether this step is
            carrying something. The count is the SCOPE, not just the step's own — a mockup
            inherited from the card is as much a part of this step's material as one
            attached to it. `none` survives for the step that has neither. */}
        <FoldToggle
          open={open}
          onToggle={() => setOpen((v) => !v)}
          summary={
            scope.length > 0
              ? `${scope.length} file${scope.length === 1 ? '' : 's'}`
              : task.description
                ? undefined
                : 'none'
          }
        >
          <Text weight="semibold">Brief</Text>
        </FoldToggle>
        <span className={styles.grow} />
        {open && !editing && (
          <Button
            size="small"
            appearance="transparent"
            disabled={live}
            title={live ? LIVE_HINT : undefined}
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

      {open && (
        <>
          {editing ? (
            <div className={styles.form}>
              <Textarea
                value={draft}
                resize="vertical"
                textarea={{ ref: textareaRef }}
                onChange={(_e, d) => setDraft(d.value)}
                onPaste={paste.onPaste}
                placeholder="What this step must deliver…"
              />
              <div className={styles.formRow}>
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() => {
                    // Abandoned: the step's own words come back and the draft goes.
                    brief.reset();
                    setEditing(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="small"
                  appearance="primary"
                  disabled={busy}
                  onClick={() => void save()}
                >
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

          {/* The step's files, under its words and inside the same fold — the card's
              Description does exactly this, because a file is a part of the brief and not a
              separate thing to browse. `onInsertRefs` only while EDITING, for the reason
              given there: citing at a caret needs a caret.

              Disabled by the same `live` guard the Edit button carries, and with its
              sentence: a running step's prompt is already built, so a file attached now
              would be attached to nothing it can still read. */}
          <AttachmentStrip
            taskId={task.id}
            attachments={scope}
            disabled={busy || live || paste.busy}
            disabledHint={live ? LIVE_HINT : undefined}
            onInsertRefs={editing ? insertRefs : undefined}
          />
        </>
      )}
    </div>
  );
}
