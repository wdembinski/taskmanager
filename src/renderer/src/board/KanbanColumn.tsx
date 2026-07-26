/**
 * KanbanColumn — one column of the My Tasks board: a header with a live count and
 * a drop zone holding its cards. Uses native HTML5 drag-and-drop (no library):
 * the dragged task id travels in `dataTransfer`, set by each `TaskCard`.
 */
import { useState } from 'react';
import { Caption1, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { Task } from '@shared/model';
import { TaskCard } from './TaskCard';
import type { BoardColumn } from './boardColumns';

const useStyles = makeStyles({
  column: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    flex: '1 1 0',
    minWidth: 0,
    minHeight: 0,
    padding: '4px',
    borderRadius: tokens.borderRadiusMedium,
    border: '1px solid transparent',
  },
  columnOver: {
    border: `1px dashed ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  header: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '0 4px' },
  headerLabel: { color: tokens.colorNeutralForeground2, letterSpacing: '0.04em' },
  count: { color: tokens.colorNeutralForeground3 },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    overflowY: 'auto',
    minHeight: '40px',
    flex: 1,
  },
  empty: { color: tokens.colorNeutralForeground4, padding: '8px 4px' },
});

export interface KanbanColumnProps {
  column: BoardColumn;
  label: string;
  tasks: Task[];
  projectNameOf: (task: Task) => string | undefined;
  /** Name of the agent project a delegated card runs in (tooltip on the agent glyph). */
  agentNameOf: (task: Task) => string | undefined;
  canDrag: (task: Task) => boolean;
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
        <Caption1 className={styles.count}>({props.tasks.length})</Caption1>
      </div>
      <div className={styles.list}>
        {props.tasks.length === 0 ? (
          <Caption1 className={styles.empty}>—</Caption1>
        ) : (
          props.tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              projectName={props.projectNameOf(task)}
              agentName={props.agentNameOf(task)}
              selected={task.id === props.selectedTaskId}
              draggable={props.canDrag(task)}
              dragging={task.id === props.draggingId}
              onSelect={() => props.onSelectTask(task.id)}
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
