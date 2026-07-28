/**
 * TaskAgentPanel — the "Agent" section of the My Tasks detail pane.
 *
 * Everything a human does with a delegated card lives here: assign it to an agent
 * project (or reassign it, which restarts the run with fresh settings), stop the
 * agent, and — while a run is parked — **answer it inline**, without a detour to the
 * Attention inbox. The pending item is read from `attention:list` filtered to this
 * task and kept current over `attention:new` / `attention:resolved`, so a question
 * that arrives while you're reading the card appears on its own.
 *
 * Model and permission mode are shown read-only: both are captured when the run
 * starts, so changing them means reassigning (the button says so).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Caption1,
  Field,
  MessageBar,
  MessageBarBody,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { AgentsRegular } from '@fluentui/react-icons';
import type { AttentionAnswer } from '@shared/attention';
import { parkedStep } from '@shared/board';
import type { Project, Task } from '@shared/model';
import { PERMISSION_MODE_LABELS } from '@shared/session';
import { AssignAgentDialog } from './AssignAgentDialog';
import { stepPosition } from './board/boardColumns';
import { STATUS_LABEL } from './taskStatus';
import { usePendingAttention } from './usePendingAttention';
import { UNREAD_ORANGE as ASK_ORANGE } from '@shared/accent';

const useStyles = makeStyles({
  /**
   * A **section** of the pane's details cell, not a card of its own — the cell owns the
   * shade and the border. The parked-ask block below keeps its orange frame: that one is
   * an alert, and it is meant to interrupt.
   */
  box: { display: 'flex', flexDirection: 'column', gap: '8px' },
  head: { display: 'flex', alignItems: 'center', gap: '8px' },
  // White, matching the board card's delegation glyph.
  icon: { fontSize: '18px', display: 'flex', color: '#ffffff' },
  grow: { flex: 1, minWidth: 0 },
  hint: { color: tokens.colorNeutralForeground3 },
  ask: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '10px',
    borderRadius: tokens.borderRadiusMedium,
    border: `2px solid ${ASK_ORANGE}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  prompt: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: '12px',
    whiteSpace: 'pre-wrap',
    maxHeight: '160px',
    overflowY: 'auto',
  },
  /** The plan itself: longer than a prompt, so it gets its own scroll box. */
  plan: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: '12px',
    whiteSpace: 'pre-wrap',
    maxHeight: '260px',
    overflowY: 'auto',
    padding: '8px 10px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  steps: { display: 'flex', flexDirection: 'column', gap: '2px' },
  step: { display: 'flex', gap: '6px' },
  stepIndex: { color: tokens.colorNeutralForeground4, minWidth: '18px' },
  choices: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
  /** Whose ask this is, when it belongs to a step rather than to the card. */
  stepOwner: { color: ASK_ORANGE },
  answerRow: { display: 'flex', alignItems: 'flex-end', gap: '8px' },
});

export interface TaskAgentPanelProps {
  task: Task;
  /** This card's steps, in order — the chain whose parked step the panel must surface. */
  subtasks?: Task[];
  /** Every agent project (`agentProject:list`), owned by the board so it's fetched once. */
  agentProjects: Project[];
  /** Open another task in the pane (used to jump to the step that stopped the chain). */
  onOpenTask?: (taskId: string) => void;
  /** Called with the updated task after an assign/stop so the board can patch the card. */
  onTaskChanged: (task: Task) => void;
}

export function TaskAgentPanel({
  task,
  subtasks = [],
  agentProjects,
  onOpenTask,
  onTaskChanged,
}: TaskAgentPanelProps): JSX.Element {
  const styles = useStyles();
  const [assignOpen, setAssignOpen] = useState(false);
  // The card's own ask, or one belonging to a step: a card executing a plan stays
  // `in-progress` while a STEP holds the run, so its inbox item is keyed to the step and
  // was unreachable from here before Phase 12.
  const [item, setItem] = usePendingAttention([task.id, ...subtasks.map((s) => s.id)]);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const taskId = task.id;
  // Which step (if any) the shown item belongs to, and which step has stopped the chain
  // when there is no item at all — the case a restart leaves behind, since items live in
  // the scheduler's memory and the step's status is all that survives.
  const itemStep =
    item && item.taskId !== taskId ? (subtasks.find((s) => s.id === item.taskId) ?? null) : null;
  const itemStepPosition = itemStep ? stepPosition(subtasks, itemStep.id) : null;
  const stuck = parkedStep(subtasks);
  const stuckPosition = stuck ? stepPosition(subtasks, stuck.id) : null;
  const isStep = Boolean(task.parentTaskId);
  const live = task.status === 'running' || task.status === 'waiting-input';
  // A limit-parked card has no process to kill, but Stop still unparks it so it
  // doesn't silently resume when the limit lifts.
  const stoppable = live || task.status === 'blocked-by-limit';
  const assigned = agentProjects.find((p) => p.id === task.agentProjectId) ?? null;

  // The pending ask itself is `usePendingAttention`; only the draft reply is local.
  useEffect(() => {
    setReply('');
  }, [taskId]);

  const answer = useCallback(
    async (a: AttentionAnswer): Promise<void> => {
      if (!item) return;
      setBusy(true);
      setError(null);
      try {
        await window.api.invoke('attention:answer', item.id, a);
        setItem(null); // the engine also emits `attention:resolved`; clear now for snappiness
        setReply('');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [item],
  );

  /** Re-enter a chain that stopped: run the parked step again in the card's worktree. */
  async function runStep(stepId: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await window.api.invoke('task:run', stepId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function stop(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onTaskChanged(await window.api.invoke('task:stopAgent', taskId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.box}>
      <div className={styles.head}>
        <span className={styles.icon}>
          <AgentsRegular />
        </span>
        <Text weight="semibold">Agent</Text>
        {assigned ? (
          <Badge appearance="tint" color="informative">
            {assigned.name}
          </Badge>
        ) : task.agentProjectId ? (
          <Badge appearance="tint" color="danger">
            project removed
          </Badge>
        ) : (
          <Caption1 className={styles.hint}>Not assigned</Caption1>
        )}
        <span className={styles.grow} />
        {stoppable && (
          <Button size="small" disabled={busy} onClick={() => void stop()}>
            Stop
          </Button>
        )}
        {/* A step is never delegated on its own: it inherits the card's agent project
            and runs in the card's worktree, in its turn. Stop is still offered. */}
        {isStep ? (
          <Caption1 className={styles.hint}>Runs with its card</Caption1>
        ) : (
          <Button
            size="small"
            appearance={task.agentProjectId ? 'secondary' : 'primary'}
            disabled={live}
            title={live ? 'Stop the agent before reassigning this card.' : undefined}
            onClick={() => setAssignOpen(true)}
          >
            {task.agentProjectId ? 'Reassign…' : 'Assign to an agent…'}
          </Button>
        )}
      </div>

      {task.agentProjectId && (
        <Caption1 className={styles.hint}>
          {task.agentModel ?? assigned?.defaultModel ?? 'project default'} ·{' '}
          {
            PERMISSION_MODE_LABELS[
              task.agentMode ?? assigned?.defaultPermissionMode ?? 'acceptEdits'
            ]
          }
          {assigned ? ` · ${assigned.path}` : ''}
        </Caption1>
      )}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {/* The chain stopped and its inbox item is gone (items live in the scheduler, so a
          restart loses them). Nothing here can resolve it, but the step can be re-run —
          and saying so beats a card that silently never finishes. */}
      {!item && stuck && (
        <div className={styles.ask}>
          <Text weight="semibold">
            {stuckPosition !== null
              ? `The plan stopped at step ${stuckPosition} of ${subtasks.length}`
              : 'The plan has stopped'}
          </Text>
          <Caption1 className={styles.hint}>
            {stuck.title} is {STATUS_LABEL[stuck.status].toLowerCase()}, so the remaining steps are
            waiting. Open it to read what happened, or run it again — it picks up in this
            card&apos;s worktree.
          </Caption1>
          <div className={styles.choices}>
            <Button appearance="primary" disabled={busy} onClick={() => void runStep(stuck.id)}>
              Run this step again
            </Button>
            <Button disabled={busy} onClick={() => onOpenTask?.(stuck.id)}>
              Open step
            </Button>
          </div>
        </div>
      )}

      {item && (
        <div className={styles.ask}>
          {itemStep && (
            <Caption1 className={styles.stepOwner}>
              {itemStepPosition !== null
                ? `Step ${itemStepPosition} of ${subtasks.length} — ${itemStep.title}`
                : itemStep.title}
            </Caption1>
          )}
          <div className={styles.head}>
            <Text weight="semibold">
              {item.kind === 'permission'
                ? 'The agent needs permission'
                : item.kind === 'merge-conflict'
                  ? 'Merge conflict — resolve it in the worktree'
                  : item.kind === 'plan-approval'
                    ? 'The agent finished planning — approve to run it'
                    : item.kind === 'task-failed'
                      ? // A failure has resolutions, not answers — saying "question" here
                        // (as this did before Phase 12) hid what the buttons below do.
                        `The run failed — pick how to continue${itemStep ? ', and the chain resumes' : ''}`
                      : 'The agent has a question'}
            </Text>
          </div>
          <div className={styles.prompt}>{item.prompt}</div>
          {item.reason && (
            <Caption1 className={styles.hint}>Held because it {item.reason}.</Caption1>
          )}
          {item.worktreePath && (
            <Caption1 className={styles.hint} title={item.worktreePath}>
              Worktree: {item.worktreePath}
            </Caption1>
          )}

          {item.kind === 'plan-approval' && (
            <>
              {item.plan && <div className={styles.plan}>{item.plan}</div>}
              {(item.steps?.length ?? 0) > 0 ? (
                <>
                  <Caption1 className={styles.hint}>
                    Approving creates {item.steps!.length} step
                    {item.steps!.length === 1 ? '' : 's'}, run one at a time in their own sessions
                    on this card&apos;s branch:
                  </Caption1>
                  <div className={styles.steps}>
                    {item.steps!.map((step, i) => (
                      <div key={`${i}-${step}`} className={styles.step}>
                        <Caption1 className={styles.stepIndex}>{i + 1}.</Caption1>
                        <Caption1>{step}</Caption1>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <Caption1 className={styles.hint}>
                  No plan text was captured, so approving would leave this card with nothing to run
                  — re-plan instead.
                </Caption1>
              )}
            </>
          )}

          {item.kind === 'permission' ||
          item.kind === 'merge-conflict' ||
          item.kind === 'plan-approval' ? (
            <div className={styles.answerRow}>
              <Field className={styles.grow} label="Optional note to the agent">
                <Textarea
                  value={reply}
                  resize="vertical"
                  onChange={(_e, d) => setReply(d.value)}
                  placeholder="Add guidance (optional)…"
                />
              </Field>
              <Button
                appearance="primary"
                disabled={busy}
                onClick={() =>
                  void answer({ decision: 'approve', note: reply.trim() || undefined })
                }
              >
                {item.kind === 'merge-conflict'
                  ? 'Resolved — finish merge'
                  : item.kind === 'plan-approval'
                    ? 'Approve plan'
                    : 'Approve'}
              </Button>
              <Button
                disabled={busy}
                onClick={() => void answer({ decision: 'deny', note: reply.trim() || undefined })}
              >
                {item.kind === 'merge-conflict'
                  ? 'Abandon'
                  : item.kind === 'plan-approval'
                    ? 'Re-plan'
                    : 'Deny'}
              </Button>
            </div>
          ) : (
            <>
              {item.options.length > 0 && (
                <div className={styles.choices}>
                  {item.options.map((option) => (
                    <Button
                      key={option}
                      appearance={option === item.options[0] ? 'primary' : 'secondary'}
                      disabled={busy}
                      onClick={() =>
                        void answer({
                          decision: 'reply',
                          text: option,
                          note: reply.trim() || undefined,
                        })
                      }
                    >
                      {option}
                    </Button>
                  ))}
                </div>
              )}
              <div className={styles.answerRow}>
                <Field
                  className={styles.grow}
                  label={
                    item.kind === 'task-failed'
                      ? 'Optional note (sent with the resolution you pick)'
                      : item.options.length > 0
                        ? 'Or answer in your own words'
                        : 'Your answer'
                  }
                >
                  <Textarea
                    value={reply}
                    resize="vertical"
                    onChange={(_e, d) => setReply(d.value)}
                    placeholder="Type your reply…"
                  />
                </Field>
                {/* A failure is resolved by choosing one of the buttons above; free text
                    would only re-park it, so there is no Send here. */}
                {item.kind !== 'task-failed' && (
                  <Button
                    appearance="primary"
                    disabled={busy || reply.trim().length === 0}
                    onClick={() => void answer({ decision: 'reply', text: reply.trim() })}
                  >
                    Send
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      <AssignAgentDialog
        open={assignOpen}
        task={task}
        agentProjects={agentProjects}
        onClose={() => setAssignOpen(false)}
        onAssigned={onTaskChanged}
      />
    </div>
  );
}
