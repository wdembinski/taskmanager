/**
 * One ticket, as a dense backlog/epics-view row — the same identity a card wears
 * (`typeIcon`, `PriorityGlyph`, the status vocabulary from `@tm/ui/taskStatus`) read off
 * `packages/ui/src/board/*` rather than redrawn here, so a ticket cannot look like one
 * thing on the Kanban board and another in the backlog.
 *
 * Deliberately not `TaskCard`: a Kanban card is built for a column a few of it fit in and
 * carries the run/chain machinery a backlog row has no use for (no agent, no chain, no
 * live run — a native ticket may have none of those). This is JIRA's own backlog row
 * instead: one line, click through to the ticket page.
 */
import { Badge, makeStyles, tokens } from '@fluentui/react-components';
import type { Task } from '@tm/shared/model';
import { typeIcon } from '@tm/ui/board/TaskCard';
import { PriorityGlyph } from '@tm/ui/PriorityGlyph';
import { STATUS_COLOR, STATUS_LABEL } from '@tm/ui/taskStatus';

const useStyles = makeStyles({
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 8px',
    borderRadius: '4px',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  icon: { display: 'flex', flexShrink: 0, color: tokens.colorNeutralForeground3 },
  key: {
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
    fontSize: '12px',
    fontWeight: 600,
    minWidth: '52px',
  },
  title: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  chips: { display: 'flex', gap: '4px', flexShrink: 0, flexWrap: 'wrap' },
});

export interface TicketRowProps {
  task: Task;
  /** The epic this ticket hangs under, when the view isn't already grouped by it. */
  epicName?: string;
  onOpen: (taskId: string) => void;
}

export function TicketRow({ task, epicName, onOpen }: TicketRowProps): JSX.Element {
  const styles = useStyles();
  return (
    <div
      className={styles.row}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(task.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(task.id);
        }
      }}
    >
      <span className={styles.icon}>{typeIcon(task)}</span>
      {task.ticketKey && <span className={styles.key}>{task.ticketKey}</span>}
      <span className={styles.title}>{task.title}</span>
      <div className={styles.chips}>
        {epicName && (
          <Badge appearance="outline" color="informative">
            {epicName}
          </Badge>
        )}
        {(task.labels ?? []).map((label) => (
          <Badge key={label} appearance="tint" color="informative">
            {label}
          </Badge>
        ))}
      </div>
      <PriorityGlyph mode="color" priority={task.externalPriority} size={16} />
      <Badge appearance="tint" color={STATUS_COLOR[task.status]}>
        {STATUS_LABEL[task.status]}
      </Badge>
    </div>
  );
}
