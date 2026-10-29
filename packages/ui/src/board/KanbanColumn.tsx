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
import {
  Button,
  Caption1,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { AddRegular } from '@fluentui/react-icons';
import type { Person, Task } from '@tm/shared/model';
import type { RunPurpose } from '@tm/shared/scheduler';
import { STATUS_GLYPH } from '../issues/IssueRow';
import { TaskCard } from './TaskCard';
import type { AutomationOrigin } from './automationOrigin';
import type { BoardCard, BoardColumn } from './boardColumns';
import { isChainLinkDrag, type LinkDragState } from './chainDrag';
import type { ChainState } from './chainStates';
import type { LinkChips } from './linkChips';

const useStyles = makeStyles({
  // A grid item of the board's scroll container (`boardLayout`'s `columns`): it stretches to
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
    // A faint lane over the canvas, not a surface of its own — `SEMANTIC.lane` (`tokens.ts`),
    // taken straight from the v9 mockup's own lane rects. The sticky header above stays
    // opaque canvas (`KanbanColumn.header`), so this never shows through it.
    backgroundColor: 'var(--tm-lane)',
  },
  columnOver: {
    border: `1px dashed ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  // Sticky: the board scrolls as a whole, so without this every column's label would
  // scroll away and you'd lose track of which column you are looking at.
  // The v9 mockup's header: state glyph, Title-case name, a bare count, and the column's
  // own "+" pushed to the right edge (`addButton`).
  header: {
    display: 'flex',
    alignItems: 'center',
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
  // The SHAPE carries the column's state, so the glyph spends no colour — the same faint ink
  // `IssueRow` draws `STATUS_GLYPH` in.
  glyph: {
    display: 'flex',
    flexShrink: 0,
    fontSize: '14px',
    color: `var(--tm-text-faint, ${tokens.colorNeutralForeground3})`,
  },
  headerLabel: { color: tokens.colorNeutralForeground1, fontSize: '13px' },
  count: { color: `var(--tm-text-faint, ${tokens.colorNeutralForeground3})` },
  addButton: { marginLeft: 'auto', color: tokens.colorNeutralForeground3 },
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
  /**
   * While a chain's links are being drawn over the board, the space between the sticky
   * header and the first card IS the bus band `chainRoute` routes distant links through —
   * `useCardAnchors`' `busTop`/`busBottom`. ~18px holds two lanes (`LANE_GAP`, `chainRoute.ts`)
   * clear of both the header above and the first card's own top edge below.
   */
  listLinked: { paddingTop: '18px' },
  empty: { color: tokens.colorNeutralForeground4, padding: '8px 4px' },
  /**
   * The compact board's one visible column (F3.5) — no sticky header (there is only one
   * column on screen, so a label pinned above it says nothing a `ColumnSwitcher` tab above
   * it hasn't already), and full-width rather than a grid track sized by its siblings, since
   * it has none.
   */
  columnCompact: { padding: 0, width: '100%' },
  listCompact: { width: '100%' },
});

export interface KanbanColumnProps {
  column: BoardColumn;
  label: string;
  /** The column's cards, each carrying the steps that render inside it. */
  cards: BoardCard[];
  /**
   * `'compact'` drops the sticky column header and stretches the list full-width — the
   * compact board's single-column view (`BoardScreen`'s `compact` prop), which already says
   * which column this is in its own `ColumnSwitcher` tab. Absent on every wide caller, so
   * wide rendering is unchanged.
   */
  layout?: 'compact';
  /** Name of the agent project a delegated card runs in (tooltip on the agent glyph). */
  agentNameOf: (task: Task) => string | undefined;
  /**
   * A native ticket's parent epic, by NAME (Phase 24) — resolved by whoever holds the whole
   * board (`task.epicTaskId` names another card) and asked per card, the same shape as
   * `agentNameOf`. Absent on a board with no epics to resolve, which is also what leaves the
   * footer's epic chip falling back to a mirrored card's own `externalEpicName`.
   */
  epicNameOf?: (task: Task) => string | undefined;
  /** A native ticket's assignee (Phase 24), for the avatar in its footer. Same shape as
   *  `agentNameOf`: asked per card rather than passed as a lookup map. */
  assigneeOf?: (task: Task) => Pick<Person, 'name' | 'initials' | 'color'> | undefined;
  /**
   * What started a card whose `originAutomationId` names an automation (F1.18), same shape
   * as `assigneeOf`. Absent on every caller before the automation list reaches the renderer
   * (F1.11/F1.15), which is also what leaves the glyph's tooltip on its generic fallback.
   */
  originAutomationOf?: (task: Task) => AutomationOrigin | undefined;
  /** Task ids the inbox holds an item for — the ring's authoritative signal. */
  attentionTaskIds?: ReadonlySet<string>;
  /** Task ids the engine has a live run for, so a spawning run still spins. */
  liveRunTaskIds?: ReadonlySet<string>;
  /** Why the engine is running an agent on a task, when it is a remediation — see `RunPurpose`. */
  runPurposes?: ReadonlyMap<string, RunPurpose>;
  /** When each live run started (epoch ms), for the card's elapsed-time chip — see
   *  `ActiveRun.startedAt`. */
  runStartedAt?: ReadonlyMap<string, number>;
  /** Task ids whose branch is being merged, so the card says so while git works. */
  mergingTaskIds?: ReadonlySet<string>;
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
  /**
   * At least one chain link is actually being drawn over the board (`links.length > 0` and
   * the Off/Focus/All switch is not Off — `linkMode.linkView(...).drawn`). Widens the gap
   * above the first card (`listLinked`) so the bus band `chainRoute` routes distant links
   * through has somewhere to be; absent or false leaves the column exactly as it was before
   * this ticket.
   */
  linksDrawn?: boolean;
  /**
   * Links Focus mode dims — neither the selection nor one of its direct links
   * (`linkMode.linkView`'s `dimmedTaskIds`). Asked per card like `attentionTaskIds`: the
   * answer lives in one place (the board) and every card here asks the same copy of it.
   */
  dimmedTaskIds?: ReadonlySet<string>;
  onLinkStart?: (taskId: string) => void;
  onLinkEnd?: () => void;
  onLinkTo?: (fromTaskId: string, toTaskId: string) => void;
  onLinkArm?: (taskId: string) => void;
  /**
   * Where a card stands in its chain — what it is still waiting on, and whether its turn
   * has come. Asked per card rather than passed as a map for the same reason the names and
   * colours above are: the column holds no board-wide index of its own, and the board
   * already has one (see `MyTasks`). Undefined for a card nobody chained.
   */
  chainStateOf?: (task: Task) => ChainState | undefined;
  /**
   * Turn a card's file hold (`ChainState.fileHold`) into an after-merge arrow from the card it
   * waits for. Absent on a board that cannot draw arrows, which hides the card's button.
   */
  onMakeArrow?: (fromTaskId: string, toTaskId: string) => void;
  /**
   * Needs/unblocks (`linkChips.ts`), asked per card like `chainStateOf` — the board holds no
   * index of its own, and the column asks it fresh per card. Absent everywhere the Off/Focus/
   * All switch is not Off, which is also what leaves each card's `chainChip` drawing exactly
   * as it always did.
   */
  linkChipsOf?: (task: Task) => LinkChips | undefined;
  selectedTaskId: string | null;
  draggingId: string | null;
  /**
   * Stop the agent working a card, from the card itself. Passed straight through like the
   * link callbacks: the column neither knows what is running nor decides whether the
   * button is drawn — the card asks `canStopWork` for that.
   */
  onStopTask?: (id: string) => void;
  /**
   * Pick a card's stopped work back up, from the card itself. Passed through exactly as
   * `onStopTask` is, and for the same reason: the column decides nothing about the button
   * — the card asks `canResumeWork`.
   */
  onResumeTask?: (id: string) => void;
  /**
   * Move a card onto the shelf, from the card's own menu. Passed through like
   * `onStopTask`: the column decides nothing about the menu item's presence — its absence
   * is what hides it, whether the board has no shelf UI at all or `settings.features.shelf`
   * is off.
   */
  onToggleShelved?: (id: string) => void;
  /**
   * Open the compact board's "Move to" sheet for a card, from the card's own menu (F3.6).
   * Passed through like `onToggleShelved`: the column decides nothing about the menu
   * item's presence, and this is also what the wide board never passes, since it still
   * has drag.
   */
  onMoveTask?: (id: string) => void;
  onSelectTask: (id: string) => void;
  onDragStartTask: (id: string) => void;
  onDragEndTask: () => void;
  onDropInColumn: (taskId: string, column: BoardColumn) => void;
  /**
   * Add a card straight into this column, from the "+" at the right of its header. Absent
   * draws no button — and the compact layout draws no header at all, so it never gets one.
   * The host opens its own `AddTaskDialog` with `column` set; the column adds nothing itself.
   */
  onAddCard?: (column: BoardColumn) => void;
}

export function KanbanColumn(props: KanbanColumnProps): JSX.Element {
  const styles = useStyles();
  const [over, setOver] = useState(false);

  const compact = props.layout === 'compact';

  return (
    <div
      // The router's own anchor (`useCardAnchors`/`chainRoute`): its content-space left/right
      // is one column's gutter wall, and a card's nearest ancestor with this attribute is how
      // its column index is read back, without threading a second index through every card.
      data-board-column={props.column}
      className={mergeClasses(
        styles.column,
        over && styles.columnOver,
        compact && styles.columnCompact,
      )}
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
      {!compact && (
        <div className={styles.header} data-board-column-header="">
          <span className={styles.glyph} aria-hidden>
            {STATUS_GLYPH[props.column]}
          </span>
          <Text weight="semibold" size={300} className={styles.headerLabel}>
            {props.label}
          </Text>
          <Caption1 className={styles.count}>{props.cards.length}</Caption1>
          {props.onAddCard && (
            <Button
              appearance="subtle"
              size="small"
              icon={<AddRegular />}
              className={styles.addButton}
              aria-label={`Add a task to ${props.label}`}
              title={`Add a task to ${props.label}`}
              onClick={() => props.onAddCard?.(props.column)}
            />
          )}
        </div>
      )}
      <div
        className={mergeClasses(
          styles.list,
          compact && styles.listCompact,
          props.linksDrawn && styles.listLinked,
        )}
      >
        {props.cards.length === 0 ? (
          <Caption1 className={styles.empty}>—</Caption1>
        ) : (
          props.cards.map(({ task, subtasks, mergeRequests, variants }) => (
            <TaskCard
              key={task.id}
              task={task}
              epicName={props.epicNameOf?.(task)}
              assignee={props.assigneeOf?.(task)}
              agentName={props.agentNameOf(task)}
              originAutomation={props.originAutomationOf?.(task)}
              subtasks={subtasks}
              variants={variants}
              mergeRequests={mergeRequests}
              attentionTaskIds={props.attentionTaskIds}
              liveRunTaskIds={props.liveRunTaskIds}
              runPurposes={props.runPurposes}
              runStartedAt={props.runStartedAt}
              mergingTaskIds={props.mergingTaskIds}
              selected={task.id === props.selectedTaskId}
              dimmed={props.dimmedTaskIds?.has(task.id)}
              anchorRef={props.anchorRef?.(task.id)}
              linkState={props.linkDrag?.states.get(task.id)}
              // Absent when the board is not wired for chains, which is also what decides
              // whether the card grows a handle at all.
              onLinkStart={props.onLinkStart && (() => props.onLinkStart?.(task.id))}
              onLinkEnd={props.onLinkEnd}
              onLinkTo={(fromTaskId) => props.onLinkTo?.(fromTaskId, task.id)}
              onLinkArm={() => props.onLinkArm?.(task.id)}
              onStop={props.onStopTask && (() => props.onStopTask?.(task.id))}
              onResume={props.onResumeTask && (() => props.onResumeTask?.(task.id))}
              onToggleShelved={props.onToggleShelved && (() => props.onToggleShelved?.(task.id))}
              onMoveTo={props.onMoveTask && (() => props.onMoveTask?.(task.id))}
              waitingOn={props.chainStateOf?.(task)?.waitingOn}
              mergeHeld={props.chainStateOf?.(task)?.mergeHeld}
              waitReasons={props.chainStateOf?.(task)?.waitReasons}
              chainReady={props.chainStateOf?.(task)?.ready}
              chainQueued={props.chainStateOf?.(task)?.queued}
              chainBlocked={props.chainStateOf?.(task)?.blocked}
              fileHold={props.chainStateOf?.(task)?.fileHold}
              onMakeArrow={
                props.onMakeArrow && ((fromTaskId) => props.onMakeArrow?.(fromTaskId, task.id))
              }
              linkChips={props.linkChipsOf?.(task)}
              // A chain says what runs after what, never where a card belongs; and a run
              // only BORROWS the card's status (`cardStatusGuard`), so not even a live agent
              // or a live step takes a card out of the human's hands — there is no state in
              // which a card refuses to be filed. Compact is the one exception: touch has no
              // drag gesture at all, so the card is not draggable there and the "Move to"
              // sheet (F3.6) is the only way to file it.
              draggable={!compact}
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
