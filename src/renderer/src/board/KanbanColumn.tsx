/**
 * KanbanColumn — one column of the My Tasks board: a header with a live count and
 * a drop zone holding its cards. Uses native HTML5 drag-and-drop (no library):
 * the dragged task id travels in `dataTransfer`, set by each `TaskCard`.
 */
import { useState } from 'react';
import { Caption1, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { Task } from '@shared/model';
import type { StatusKeyword } from '@shared/statusKeywords';
import { TaskCard } from './TaskCard';
import type { BoardCard, BoardColumn } from './boardColumns';

const useStyles = makeStyles({
  // A grid item of the board's scroll container (`MyTasks.columns`): it stretches to
  // the tallest column, so the drop zone always reaches the bottom of the board.
  column: {
    display: 'flex',
    flexDirection: 'column',
    // No gap here: the sticky header carries the space below it as padding, so a card
    // scrolling under it disappears at the header's edge instead of through a gap.
    minWidth: 0,
    padding: '4px',
    borderRadius: tokens.borderRadiusMedium,
    border: '1px solid transparent',
  },
  columnOver: {
    border: `1px dashed ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  // Sticky: the board scrolls as a whole, so without this every column's label would
  // scroll away and you'd lose track of which column you are looking at.
  header: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '8px',
    // A deeper bottom inset than it looks like it needs: the header is OPAQUE and
    // pinned, so a card sliding under it loses its top edge first — and the top edge is
    // exactly where the project stripe and the attention ring live.
    padding: '2px 4px 12px',
    position: 'sticky',
    top: 0,
    zIndex: 1,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  headerLabel: { color: tokens.colorNeutralForeground2, letterSpacing: '0.04em' },
  count: { color: tokens.colorNeutralForeground3 },
  // No scroll of its own — the board's column container owns that. `flex: 1` keeps the
  // empty space below the last card inside the drop zone.
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    minHeight: '40px',
    flex: 1,
  },
  empty: { color: tokens.colorNeutralForeground4, padding: '8px 4px' },
});

export interface KanbanColumnProps {
  column: BoardColumn;
  label: string;
  /** The column's cards, each carrying the steps that render inside it. */
  cards: BoardCard[];
  projectNameOf: (task: Task) => string | undefined;
  /** Name of the agent project a delegated card runs in (tooltip on the agent glyph). */
  agentNameOf: (task: Task) => string | undefined;
  /** The card's project colour, for the stripe along its top edge. */
  projectColorOf: (task: Task) => string | undefined;
  /** The user's status-note vocabulary, which colours each card's progress line. */
  statusKeywords?: readonly StatusKeyword[];
  canDrag: (card: BoardCard) => boolean;
  selectedTaskId: string | null;
  draggingId: string | null;
  onSelectTask: (id: string) => void;
  onDragStartTask: (id: string) => void;
  onDragEndTask: () => void;
  onDropInColumn: (taskId: string, column: BoardColumn) => void;
}

export function KanbanColumn(props: KanbanColumnProps): JSX.Element {
  const styles = useStyles();
  const [over, setOver] = useState(false);

  return (
    <div
      className={mergeClasses(styles.column, over && styles.columnOver)}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!over) setOver(true);
      }}
      onDragLeave={(e) => {
        // Only clear when the pointer actually leaves the column, not on child enter.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData('text/plain');
        if (id) props.onDropInColumn(id, props.column);
      }}
    >
      <div className={styles.header}>
        <Text weight="semibold" size={200} className={styles.headerLabel}>
          {props.label}
        </Text>
        <Caption1 className={styles.count}>({props.cards.length})</Caption1>
      </div>
      <div className={styles.list}>
        {props.cards.length === 0 ? (
          <Caption1 className={styles.empty}>—</Caption1>
        ) : (
          props.cards.map(({ task, subtasks }) => (
            <TaskCard
              key={task.id}
              task={task}
              projectName={props.projectNameOf(task)}
              agentName={props.agentNameOf(task)}
              projectColor={props.projectColorOf(task)}
              subtasks={subtasks}
              statusKeywords={props.statusKeywords}
              selected={task.id === props.selectedTaskId}
              selectedTaskId={props.selectedTaskId}
              draggable={props.canDrag({ task, subtasks })}
              dragging={task.id === props.draggingId}
              onSelect={() => props.onSelectTask(task.id)}
              onSelectSubtask={props.onSelectTask}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', task.id);
                e.dataTransfer.effectAllowed = 'move';
                props.onDragStartTask(task.id);
              }}
              onDragEnd={() => props.onDragEndTask()}
            />
          ))
        )}
      </div>
    </div>
  );
}
