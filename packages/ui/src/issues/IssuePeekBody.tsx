/**
 * The Tickets screen's peek, read-only (`TaskDetail`'s `layout="peek"`), after
 * `v9-1-issues-list-light.svg` / `v9-3-issues-list-dark.svg`: key · epic, the title, the
 * description, four label/value rows (Status, Assignee, Milestone, Due — a row with nothing to
 * say is left out; the first three with their `PropertyGlyph`, Assignee as "Agent on <machine>"
 * for a delegated card), the open decision and the visual sign-off when they apply, the "Agent run"
 * checklist with a timer on the running step, the conversation, and one Reply box.
 *
 * Nothing here edits the ticket. Every dropdown, the agent controls, the merge buttons and the
 * composer's toolbar stay on the full-screen page (`layout="full"`), one click away through the
 * peek header's "Open full screen" — the peek is for reading a ticket beside the list, and the
 * board's own pane (`layout` unset) keeps the stacked editor. The only writes left are the two
 * blocks that exist to be answered (`DecisionBanner`, `VisualSignOff`) and Reply, which posts
 * through the composer's own default — the agent when it can be talked to, a note otherwise.
 *
 * Fed entirely by what `TaskDetail` already holds, so opening a peek loads nothing new.
 */
import type { KeyboardEvent } from 'react';
import {
  Button,
  Caption1,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { CheckmarkCircleFilled, CircleRegular, SendRegular } from '@fluentui/react-icons';
import { formatElapsed } from '@tm/shared/elapsed';
import type { Person, Task, TaskActivityEntry } from '@tm/shared/model';
import type { TaskAttachment } from '@tm/shared/attachments';
import type { StatusKeyword } from '@tm/shared/statusKeywords';
import { Markdown } from '../chat/MarkdownView';
import type { Turn } from '../chat/turns';
import { DecisionBanner } from '../DecisionBanner';
import { STATUS_INDICATOR_VAR } from '../tokens';
import { useElapsedClock } from '../useElapsedClock';
import { VisualSignOff } from '../VisualSignOff';
import type { PropertyRow } from './issuePropertyRows';
import { PeekTimeline } from './PeekTimeline';
import { PropertyGlyph } from './PropertyGlyph';

const useStyles = makeStyles({
  root: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
  scroll: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    padding: '4px 20px 16px',
    // Every block keeps its own height and the column scrolls instead — a shrunk decision
    // banner drew under the sign-off below it.
    '& > *': { flexShrink: 0 },
  },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
    overflowWrap: 'anywhere',
  },
  head: { display: 'flex', flexDirection: 'column', gap: '4px' },
  props: {
    display: 'grid',
    gridTemplateColumns: '92px minmax(0, 1fr)',
    rowGap: '8px',
    columnGap: '8px',
    margin: 0,
  },
  propLabel: { color: `var(--tm-text-muted, ${tokens.colorNeutralForeground3})` },
  // The glyph, then the value — v9-1 draws Status, Assignee and Milestone with one; Due without.
  propValue: {
    margin: 0,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    overflowWrap: 'anywhere',
  },
  section: { display: 'flex', flexDirection: 'column', gap: '6px' },
  // v9-1's 1px rule above the Agent run checklist and above the conversation.
  divided: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: '16px',
  },
  sectionHead: { fontWeight: tokens.fontWeightSemibold },
  steps: { listStyleType: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' },
  step: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', minWidth: 0 },
  stepTitle: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
  // Colour only for the step that MOVES — done and pending stay monochrome.
  glyphDone: { color: tokens.colorNeutralForeground2, flexShrink: 0, fontSize: '16px' },
  glyphPending: { color: tokens.colorNeutralForeground4, flexShrink: 0, fontSize: '16px' },
  glyphRunning: {
    flexShrink: 0,
    width: '16px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: STATUS_INDICATOR_VAR.running,
  },
  timer: { color: STATUS_INDICATOR_VAR.running, fontVariantNumeric: 'tabular-nums', flexShrink: 0 },
  reply: {
    flex: '0 0 auto',
    padding: '8px 20px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  // v9-1's Reply: a 40px pill on the subtle neutral fill, no border, the send icon inside it.
  // Fluent's focus underline is a straight bottom stroke, which a pill cannot carry — focus
  // shows as a ring instead.
  replyBox: {
    width: '100%',
    height: '40px',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground3,
    border: 'none',
    paddingLeft: '8px',
    '::after': { display: 'none' },
    ':focus-within': { outline: `1px solid ${tokens.colorNeutralStroke1}` },
  },
  send: { color: tokens.colorBrandForeground1 },
});

export interface IssuePeekBodyProps {
  task: Task;
  /** The label/value rows to print, in order — already narrowed to the four the peek shows. */
  rows: readonly PropertyRow[];
  /** App-wide roster and the delegated agent's name — the rows' glyphs (`PropertyGlyph`). */
  people?: readonly Person[];
  agentName?: string;
  /** The card's steps, in chain order. */
  subtasks: readonly Task[];
  /** Tasks with a live run right now — a step in it is the running one. */
  liveRunTaskIds?: ReadonlySet<string>;
  /** When each live run started, by task id — the running step's timer. */
  runStartedAt?: ReadonlyMap<string, number>;
  /** The conversation, already folded (`foldTurns`) — drawn bubble-free by `PeekTimeline`. */
  turns: Turn[];
  /**
   * Accepted for `TaskDetail`'s one call shape, but the peek's timeline reads neither: a
   * status note prints as text, and deleting a note stays on the full page.
   */
  statusKeywords?: readonly StatusKeyword[];
  onDeleteNote?: (commentId: number) => void;
  /** The card's own attachments and timeline — the visual sign-off reads them. */
  attachments: readonly TaskAttachment[];
  activity: readonly TaskActivityEntry[];
  /** Flagging visual changes starts a reply with this line. */
  onNeedsChanges: (text: string) => void;
  /** The host is unreachable — the decision banner reads but does not answer. */
  readOnly?: boolean;
  onTaskChanged?: (task: Task) => void;
  /** An answer or a reply landed — re-read the conversation. */
  onAnswered?: () => void;
  /** The Reply box's text, its setter, and its one send. */
  reply: string;
  onReplyChange: (text: string) => void;
  onSend: () => void;
  /** Who a reply reaches — the placeholder says so. */
  replyToAgent: boolean;
  sending?: boolean;
  error?: string | null;
}

/**
 * Whether this step is the one working now. Its status or a live run, not `isAgentRunning`:
 * a step runs on its card's agent, so it carries no `agentProjectId` of its own to test.
 */
function stepRunning(step: Task, live: ReadonlySet<string> | undefined): boolean {
  return step.status === 'running' || live?.has(step.id) === true;
}

function StepGlyph({ step, running }: { step: Task; running: boolean }): JSX.Element {
  const styles = useStyles();
  if (running) {
    return (
      <span className={styles.glyphRunning} data-step-glyph="running">
        <span className={styles.dot} />
      </span>
    );
  }
  if (step.status === 'done') {
    return <CheckmarkCircleFilled className={styles.glyphDone} data-step-glyph="done" />;
  }
  return <CircleRegular className={styles.glyphPending} data-step-glyph="pending" />;
}

export function IssuePeekBody({
  task,
  rows,
  people = [],
  agentName,
  subtasks,
  liveRunTaskIds,
  runStartedAt,
  turns,
  attachments,
  activity,
  onNeedsChanges,
  readOnly = false,
  onTaskChanged,
  onAnswered,
  reply,
  onReplyChange,
  onSend,
  replyToAgent,
  sending = false,
  error,
}: IssuePeekBodyProps): JSX.Element {
  const styles = useStyles();
  const running = subtasks.find((s) => stepRunning(s, liveRunTaskIds));
  const now = useElapsedClock(running !== undefined);
  const startedAt = running ? runStartedAt?.get(running.id) : undefined;
  const description = task.externalDescription ?? task.description ?? '';

  const canSend = !sending && reply.trim().length > 0;

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    // Enter sends — one line, so there is no newline to keep Shift+Enter for.
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) onSend();
    }
  }

  return (
    <div className={styles.root} data-issue-peek-body>
      <div className={styles.scroll}>
        {/* No key line: IssuePeek's header already prints the key and its crumbs. */}
        <div className={styles.head}>
          <h2 className={styles.title}>{task.title}</h2>
        </div>
        {description.trim() && (
          <div data-peek-description>
            <Markdown source={description} />
          </div>
        )}
        {rows.length > 0 && (
          <dl className={styles.props} data-peek-props>
            {rows.map((row) => (
              <div key={row.key} style={{ display: 'contents' }}>
                <dt className={styles.propLabel}>
                  <Caption1>{row.label}</Caption1>
                </dt>
                <dd className={styles.propValue}>
                  <PropertyGlyph
                    rowKey={row.key}
                    task={task}
                    people={people}
                    agentName={agentName}
                  />
                  <Text size={200}>{row.value}</Text>
                </dd>
              </div>
            ))}
          </dl>
        )}
        {task.decisionQuestion != null && (
          <DecisionBanner
            task={task}
            readOnly={readOnly}
            onTaskChanged={onTaskChanged}
            onAnswered={onAnswered}
          />
        )}
        {!task.parentTaskId && (
          <VisualSignOff
            attachments={attachments}
            activity={activity}
            onNeedsChanges={onNeedsChanges}
          />
        )}
        {subtasks.length > 0 && (
          <section
            className={mergeClasses(styles.section, styles.divided)}
            aria-label="Agent run"
            data-peek-steps
          >
            <Text className={styles.sectionHead}>Agent run</Text>
            <ol className={styles.steps}>
              {subtasks.map((step) => (
                <li key={step.id} className={styles.step}>
                  <StepGlyph step={step} running={step === running} />
                  <Text size={200} className={styles.stepTitle}>
                    {step.title}
                  </Text>
                  {step === running && startedAt !== undefined && (
                    <Caption1 className={styles.timer} data-step-timer>
                      {formatElapsed(now - startedAt)}
                    </Caption1>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}
        {turns.length > 0 && (
          <div role="log" aria-label="Conversation" className={styles.divided}>
            <PeekTimeline turns={turns} now={now} />
          </div>
        )}
      </div>
      <div className={styles.reply}>
        {error && (
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        )}
        <Input
          className={styles.replyBox}
          aria-label="Reply"
          placeholder={replyToAgent ? 'Reply to the agent…' : 'Reply…'}
          value={reply}
          disabled={sending}
          onChange={(_e, d) => onReplyChange(d.value)}
          onKeyDown={onKeyDown}
          contentAfter={
            sending ? (
              <Spinner size="tiny" />
            ) : (
              <Button
                appearance="subtle"
                shape="circular"
                size="small"
                className={styles.send}
                icon={<SendRegular />}
                aria-label="Send"
                title="Send"
                disabled={!canSend}
                onClick={onSend}
              />
            )
          }
        />
      </div>
    </div>
  );
}
