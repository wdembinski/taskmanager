/**
 * KanbanColumn — one column of the My Tasks board: a header with a live count and
 * a drop zone holding its cards. Uses native HTML5 drag-and-drop (no library):
 * the dragged task id travels in `dataTransfer`, set by each `TaskCard`.
 *
 * Two different gestures now ride that one mechanism — a card moving between columns, and
 * a link being drawn from one card to another — and they are told apart by the type on the
 * `DataTransfer`, never by where the pointer is. This column owns the first and must stay
 * completely out of the second's way; see `chainDrag`.
 */
import { useState } from 'react';
import { Caption1, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { Task } from '@shared/model';
import type { StatusKeyword } from '@shared/statusKeywords';
import type { BoardDisplaySettings } from '@shared/settings';
import { TaskCard } from './TaskCard';
import type { BoardCard, BoardColumn } from './boardColumns';
import { isChainLinkDrag, type LinkDragState } from './chainDrag';

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
    // 12px, not 10: the attention ring is 3px on each card, so two adjacent shouting
    // cards leave only `gap - 6` between their rings. At 10 that read as one thick band.
    gap: '12px',
    // Room for the FIRST card's rings, which are painted outside its box and so sit in
    // the list's padding, not the card's. A selected card that also wants you stacks 3px
    // of orange and 2px of brand — 5px — and with no inset here the top of that stack was
    // clipped by the column's own bounds, which is why selecting the top card of a column
    // looked like a truncated border. 6px is the stack plus a pixel.
    paddingTop: '6px',
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
  /** Whether cards show their sprint chip (false while the sprint filter is on). */
  showSprint?: boolean;
  /** The user's status-note vocabulary, which colours each card's progress line. */
  statusKeywords?: readonly StatusKeyword[];
  /** Task ids the inbox holds an item for — the ring's authoritative signal. */
  attentionTaskIds?: ReadonlySet<string>;
  /** Task ids the engine has a live run for, so a spawning run still spins. */
  liveRunTaskIds?: ReadonlySet<string>;
  /** Which optional context lines each card draws. */
  display?: BoardDisplaySettings;
  canDrag: (card: BoardCard) => boolean;
  /**
   * The chain overlay's measuring tap, handed to each card's root element. The column
   * only passes it through — it knows nothing about links, and the overlay is drawn once
   * over the whole board rather than per column (see `ChainOverlay`).
   */
  anchorRef?: (taskId: string) => (el: HTMLDivElement | null) => void;
  /**
   * The link gesture in flight, if any — each card asks it what IT would do with the drop.
   * Passed through like `anchorRef`: the column neither starts one nor acts on one.
   */
  linkDrag?: LinkDragState | null;
  onLinkStart?: (taskId: string) => void;
  onLinkEnd?: () => void;
  onLinkTo?: (fromTaskId: string, toTaskId: string) => void;
  onLinkArm?: (taskId: string) => void;
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
        // A link being drawn is not this column's business. Without this the column would
        // accept the drop as well, so drawing an arrow ACROSS a column would also move the
        // card into it — and it must not even highlight, or it would be offering to.
        if (isChainLinkDrag(e.dataTransfer.types)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!over) setOver(true);
      }}
      onDragLeave={(e) => {
        // Only clear when the pointer actually leaves the column, not on child enter.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(e) => {
        // Belt and braces: a card consumes its own link drop, and `dragover` never accepted
        // one anyway — but `text/plain` is empty on a link drag, so read the type first
        // rather than relying on the id coming back blank.
        if (isChainLinkDrag(e.dataTransfer.types)) return;
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
          props.cards.map(({ task, subtasks, mergeRequests }) => (
            <TaskCard
              key={task.id}
              task={task}
              projectName={props.projectNameOf(task)}
              agentName={props.agentNameOf(task)}
              projectColor={props.projectColorOf(task)}
              showSprint={props.showSprint}
              subtasks={subtasks}
              mergeRequests={mergeRequests}
              statusKeywords={props.statusKeywords}
              attentionTaskIds={props.attentionTaskIds}
              liveRunTaskIds={props.liveRunTaskIds}
              display={props.display}
              selected={task.id === props.selectedTaskId}
              selectedTaskId={props.selectedTaskId}
              anchorRef={props.anchorRef?.(task.id)}
              linkState={props.linkDrag?.states.get(task.id)}
              // Absent when the board is not wired for chains, which is also what decides
              // whether the card grows a handle at all.
              onLinkStart={props.onLinkStart && (() => props.onLinkStart?.(task.id))}
              onLinkEnd={props.onLinkEnd}
              onLinkTo={(fromTaskId) => props.onLinkTo?.(fromTaskId, task.id)}
              onLinkArm={() => props.onLinkArm?.(task.id)}
              draggable={props.canDrag({ task, subtasks, mergeRequests })}
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
