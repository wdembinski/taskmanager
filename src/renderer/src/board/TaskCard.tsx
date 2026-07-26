/**
 * TaskCard — one draggable card on the My Tasks Kanban board.
 *
 * Mirrors the product mockup: a type icon + title, an optional label chip, the
 * card's "Project:" line, and a footer with the JIRA source badge and a priority
 * square. A small status badge appears only for the "unusual" states bucketed into a
 * column (an AI run, or a failed/stopped/cancelled task in Done). An orange border
 * flags unread JIRA comments — or an agent waiting on an answer.
 */
import {
  Badge,
  Caption1,
  Text,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  BeakerFilled,
  BookmarkFilled,
  BotSparkleFilled,
  BugFilled,
  CircleFilled,
  NoteFilled,
  PersonFilled,
  SparkleFilled,
  TaskListSquareLtrFilled,
} from '@fluentui/react-icons';
import type { Task } from '@shared/model';
import { hasUnreadJira, isAgentAssigned, needsAgentInput } from '@shared/board';
import { STATUS_COLOR, STATUS_LABEL } from '../taskStatus';
import { columnForStatus, statusForColumn } from './boardColumns';

/** "Wants you" accent — unread JIRA comments and agents parked on a question. */
const UNREAD_ORANGE = '#F2A900';

/** Agent-delegation glyph tint (matches the Attention inbox's "an agent is on it" feel). */
const AGENT_PURPLE = '#8E4EC6';

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '12px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    cursor: 'pointer',
    userSelect: 'none',
  },
  cardUnread: { border: `2px solid ${UNREAD_ORANGE}` },
  agentIcon: { fontSize: '16px', flexShrink: 0, display: 'flex', color: AGENT_PURPLE },
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
function typeIcon(task: Task): JSX.Element {
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
  selected: boolean;
  draggable: boolean;
  onSelect: () => void;
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
  selected,
  draggable,
  onSelect,
  onDragStart,
  onDragEnd,
  dragging,
}: TaskCardProps): JSX.Element {
  const styles = useStyles();
  const badge = secondaryStatus(task);
  const isJira = task.externalSource === 'jira';
  const squareColor = priorityColor(task.externalPriority);
  // Both mean "this card wants you", so they share the orange frame.
  const wantsAttention = hasUnreadJira(task) || needsAgentInput(task);

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
      <div className={styles.titleRow}>
        <span className={styles.icon}>{typeIcon(task)}</span>
        <Text weight="semibold" className={styles.title}>
          {task.title}
        </Text>
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
              <BotSparkleFilled />
            </span>
          </Tooltip>
        )}
        {badge && (
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
  );
}
