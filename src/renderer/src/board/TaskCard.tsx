/**
 * TaskCard — one draggable card on the My Tasks Kanban board.
 *
 * Mirrors the product mockup: a type icon + title, an optional label chip, the
 * card's "Project:" line, and a footer with the JIRA source badge and a priority
 * square. A small status badge appears only for the "unusual" states bucketed into a
 * column (an AI run, or a failed/stopped/cancelled task in Done). An orange border
 * flags unread JIRA comments — or an agent waiting on an answer.
 *
 * A card that has **steps** (Phase 11) renders them as rows flush inside its own
 * frame, separated by hairlines, with a "2/5" progress caption in the header. A step
 * is never a card of its own — it travels with its parent between columns — so the
 * rows are not draggable; clicking one selects that step in the detail pane.
 */
import {
  Badge,
  Caption1,
  Spinner,
  Text,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  AgentsRegular,
  BeakerFilled,
  BookmarkFilled,
  BugFilled,
  CircleFilled,
  NoteFilled,
  PersonFilled,
  SparkleFilled,
  TaskListSquareLtrFilled,
} from '@fluentui/react-icons';
import type { Task, TaskStatus } from '@shared/model';
import {
  chainNeedsAttention,
  isAgentAssigned,
  isAgentRunning,
  needsAgentInput,
  parkedStep,
} from '@shared/board';
import { STATUS_COLOR, STATUS_LABEL } from '../taskStatus';
import { columnForStatus, statusForColumn, subtaskProgress } from './boardColumns';

/** "Wants you" accent — unread JIRA comments and agents parked on a question. */
const UNREAD_ORANGE = '#F2A900';

/**
 * The delegation glyph, white so a card an agent owns reads at a glance. Sized to sit
 * with the card's type icon rather than tower over it.
 */
const AGENT_ICON_SIZE = '16px';

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    borderRadius: tokens.borderRadiusMedium,
    // Brighter than the board it sits on: a card is the object, the column is the space
    // between objects, and the old darker fill had that backwards.
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    // Step rows sit flush against the frame, so they must be clipped by its radius.
    overflow: 'hidden',
    // ...but `overflow: hidden` also drops this flex item's automatic minimum size to
    // zero, so inside the column's scrolling list the card would shrink and clip its
    // own step rows instead of making the column scroll. Never shrink a card.
    flexShrink: 0,
    cursor: 'pointer',
    userSelect: 'none',
  },
  body: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px' },
  // No container border: each row carries the hairline above it, so the first row's
  // divider is what separates the steps from the card body — no gap between them.
  step: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 12px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  stepSelected: { backgroundColor: tokens.colorNeutralBackground1Selected },
  // The spinner (16px) and the dot (8px) share this slot so every row's title starts
  // at the same x, whichever glyph the row is showing.
  stepSlot: {
    width: '16px',
    height: '16px',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepDot: { width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0 },
  spinner: { display: 'flex', alignItems: 'center', flexShrink: 0 },
  stepTitle: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: tokens.colorNeutralForeground2,
  },
  stepDone: { color: tokens.colorNeutralForeground4, textDecoration: 'line-through' },
  progress: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  /** A stopped chain reads in the frame's colour, so the two say one thing. */
  progressStopped: { color: UNREAD_ORANGE },
  cardUnread: { border: `2px solid ${UNREAD_ORANGE}` },
  agentIcon: { fontSize: AGENT_ICON_SIZE, flexShrink: 0, display: 'flex', color: '#ffffff' },
  cardSelected: { border: `1px solid ${tokens.colorBrandStroke1}` },
  dragging: { opacity: 0.5 },
  titleRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  icon: { fontSize: '18px', flexShrink: 0, display: 'flex' },
  title: { lineHeight: '18px', flex: 1, minWidth: 0 },
  project: { color: tokens.colorNeutralForeground3 },
  chip: {
    alignSelf: 'flex-start',
    backgroundColor: '#12836b',
    color: '#ffffff',
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.03em',
    padding: '2px 8px',
    borderRadius: '4px',
  },
  footer: { display: 'flex', alignItems: 'center', gap: '8px' },
  grow: { flex: 1, minWidth: 0 },
  jiraLink: { textDecoration: 'none' },
  prioritySquare: { width: '14px', height: '14px', borderRadius: '3px', flexShrink: 0 },
});

/** Priority-name → square color. Unknown/none → neutral. */
function priorityColor(priority: string | null | undefined): string | null {
  if (!priority) return null;
  const p = priority.toLowerCase();
  if (p.includes('highest') || p.includes('high') || p.includes('critical') || p.includes('block'))
    return '#E5484D';
  if (p.includes('medium') || p.includes('major')) return '#F5A623';
  if (p.includes('low') || p.includes('minor') || p.includes('trivial')) return '#30A46C';
  return tokens.colorNeutralForeground4;
}

/**
 * Step-row dot color per status — the row's whole status display, since a badge per
 * row would drown the card. Deliberately the same vocabulary as `STATUS_COLOR`'s
 * badges: green done, red failed, brand while running, orange while it wants you.
 */
const STEP_DOT_COLOR: Record<TaskStatus, string> = {
  pending: tokens.colorNeutralForeground4,
  'in-progress': tokens.colorBrandBackground,
  running: tokens.colorBrandBackground,
  'waiting-input': UNREAD_ORANGE,
  'blocked-by-limit': UNREAD_ORANGE,
  blocked: UNREAD_ORANGE,
  done: tokens.colorPaletteGreenBackground3,
  failed: tokens.colorPaletteRedBackground3,
  stopped: tokens.colorNeutralForeground4,
  cancelled: tokens.colorNeutralForeground4,
};

// Type-icon colors (shared by internal and JIRA tasks).
const BUG_RED = '#E5484D';
const FEATURE_BLUE = '#0091FF';
const STORY_GREEN = '#30A46C';
const EPIC_PURPLE = '#8E4EC6';

/**
 * Pick a card icon for the task's type. Internal tasks use their user-chosen
 * `type` (bug/feature); JIRA tasks map their issue-type name onto the same glyphs.
 * A typeless internal task (legacy) falls back to a neutral note.
 */
export function typeIcon(task: Task): JSX.Element {
  if (task.externalSource !== 'jira') {
    if (task.type === 'bug') return <BugFilled style={{ color: BUG_RED }} />;
    if (task.type === 'feature') return <BeakerFilled style={{ color: FEATURE_BLUE }} />;
    return <NoteFilled />;
  }
  const t = (task.externalType ?? '').toLowerCase();
  if (t.includes('bug')) return <BugFilled style={{ color: BUG_RED }} />;
  if (t.includes('story')) return <BookmarkFilled style={{ color: STORY_GREEN }} />;
  if (t.includes('epic')) return <SparkleFilled style={{ color: EPIC_PURPLE }} />;
  if (t.includes('feature') || t.includes('improvement'))
    return <BeakerFilled style={{ color: FEATURE_BLUE }} />;
  if (t.includes('sub')) return <PersonFilled />;
  if (t.includes('task')) return <TaskListSquareLtrFilled style={{ color: FEATURE_BLUE }} />;
  return <CircleFilled style={{ color: FEATURE_BLUE }} />;
}

export interface TaskCardProps {
  task: Task;
  /** The card's "Project:" label (the JIRA project name for JIRA tasks). */
  projectName?: string;
  /** Name of the agent project this card is delegated to, for the glyph's tooltip. */
  agentName?: string;
  /** This card's steps in execution order — rendered inside the card. */
  subtasks?: Task[];
  selected: boolean;
  /** Id of the selected task, so a selected *step* row can highlight itself. */
  selectedTaskId?: string | null;
  draggable: boolean;
  onSelect: () => void;
  /** Open a step in the detail pane (the row never drags or moves the card). */
  onSelectSubtask?: (taskId: string) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  dragging: boolean;
}

/** The status worth badging on the card, or null when the column already says it. */
function secondaryStatus(task: Task): Task['status'] | null {
  const canonical = statusForColumn(columnForStatus(task.status));
  return task.status === canonical ? null : task.status;
}

export function TaskCard({
  task,
  projectName,
  agentName,
  subtasks = [],
  selected,
  selectedTaskId,
  draggable,
  onSelect,
  onSelectSubtask,
  onDragStart,
  onDragEnd,
  dragging,
}: TaskCardProps): JSX.Element {
  const styles = useStyles();
  const badge = secondaryStatus(task);
  const isJira = task.externalSource === 'jira';
  const squareColor = priorityColor(task.externalPriority);
  // An unread comment, the card's own agent asking, or a step that has parked the
  // chain (question or failure) — all mean "this card wants you", and a step has no
  // frame of its own to say it with.
  const wantsAttention = chainNeedsAttention(task, subtasks);
  const progress = subtaskProgress(subtasks);
  // A parked chain looks exactly like one between steps unless the card says so.
  const stopped = parkedStep(subtasks) !== null;
  // A live agent session gets a spinner rather than a static "Running" badge — the
  // motion is the point: it says work is happening now. The card itself runs when it
  // was delegated without steps; with steps it stays `in-progress` while one of them
  // runs, so a live step also makes the card read as live.
  const running = isAgentRunning(task);
  const runningStep = subtasks.some(isAgentRunning);

  return (
    <div
      className={mergeClasses(
        styles.card,
        wantsAttention && styles.cardUnread,
        selected && styles.cardSelected,
        dragging && styles.dragging,
      )}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onSelect}
    >
      <div className={styles.body}>
        <div className={styles.titleRow}>
          <span className={styles.icon}>{typeIcon(task)}</span>
          <Text weight="semibold" className={styles.title}>
            {task.title}
          </Text>
          {progress.total > 0 && (
            <Caption1
              className={mergeClasses(styles.progress, stopped && styles.progressStopped)}
              title={
                stopped
                  ? `${progress.done} of ${progress.total} steps done — the chain has stopped at a step that needs you`
                  : `${progress.done} of ${progress.total} steps done`
              }
            >
              {progress.done}/{progress.total}
              {stopped && ' · stopped'}
            </Caption1>
          )}
          {isAgentAssigned(task) && (
            <Tooltip
              relationship="label"
              content={
                needsAgentInput(task)
                  ? `Agent needs your input${agentName ? ` · ${agentName}` : ''}`
                  : `Assigned to an agent${agentName ? ` · ${agentName}` : ''}`
              }
            >
              <span className={styles.agentIcon}>
                <AgentsRegular />
              </span>
            </Tooltip>
          )}
          {/* Bare on purpose, and identical whether the card itself runs or one of its
              steps does: on a board those look like the same thing, so labelling one
              "Running" and not the other reads as an inconsistency rather than as the
              distinction it is. The word lives in the tooltip and the detail pane. */}
          {(running || runningStep) && (
            <span
              className={styles.spinner}
              title={running ? 'The agent is working on this card' : 'A step is running'}
            >
              <Spinner size="extra-tiny" />
            </span>
          )}
          {/* A running card's badge would only repeat the spinner. */}
          {badge && !running && (
            <Badge appearance="tint" color={STATUS_COLOR[badge]}>
              {STATUS_LABEL[badge]}
            </Badge>
          )}
        </div>

        {task.externalLabel && <span className={styles.chip}>{task.externalLabel}</span>}

        {projectName && <Caption1 className={styles.project}>Project: {projectName}</Caption1>}

        {(isJira || squareColor) && (
          <div className={styles.footer}>
            {isJira && task.externalKey && (
              <a
                className={styles.jiraLink}
                href={task.externalUrl ?? undefined}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                <Badge appearance="outline" color="informative">
                  Jira {task.externalKey}
                </Badge>
              </a>
            )}
            <span className={styles.grow} />
            {squareColor && (
              <span
                className={styles.prioritySquare}
                style={{ backgroundColor: squareColor }}
                title={task.externalPriority ?? undefined}
              />
            )}
          </div>
        )}
      </div>

      {subtasks.map((step) => (
        <div
          key={step.id}
          className={mergeClasses(styles.step, step.id === selectedTaskId && styles.stepSelected)}
          title={`${step.title} · ${STATUS_LABEL[step.status]}`}
          // A step never travels on its own: a drag started on a row is cancelled
          // rather than dragging the parent out from under the pointer.
          onDragStart={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onSelectSubtask?.(step.id);
          }}
        >
          {/* One fixed-width slot for the status glyph, so the running row's spinner
              doesn't shove its title out of line with its siblings' dots. */}
          <span className={styles.stepSlot}>
            {isAgentRunning(step) ? (
              <Spinner size="extra-tiny" />
            ) : (
              <span
                className={styles.stepDot}
                style={{ backgroundColor: STEP_DOT_COLOR[step.status] }}
              />
            )}
          </span>
          <Caption1
            className={mergeClasses(styles.stepTitle, step.status === 'done' && styles.stepDone)}
          >
            {step.title}
          </Caption1>
        </div>
      ))}
    </div>
  );
}
