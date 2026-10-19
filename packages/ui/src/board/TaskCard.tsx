/**
 * TaskCard — one draggable card on the My Tasks Kanban board, drawn in the v9 mockup's own
 * four-row anatomy (`docs/plan/feature-roadmap/F13-design-system-and-shell.md`'s Board
 * bullet, `mockups/v9-7-board-light.svg`): a header (key + owner), the title, one status
 * line, and a footer (epic chip + MR ref or due date). `cardParts` (F13.22) decides WHICH of
 * those optional pieces are present; this component only draws what it is handed.
 *
 * The Steps and Merge requests sections, the chain/link chips' old home in a footer row, and
 * the sprint/points/label chips are gone — F13.24 moves what is still needed into the F12
 * peek. What survives unchanged: the attention ring, selection, the link handle and drop
 * states, drag, dimmed, the hover-revealed "More actions" menu with Stop/Resume, the variants
 * badge, the automation-origin flash, the needs/unblocks row, and the tracker link on the key.
 *
 * The card itself has NO frame — the fill is brighter than the column, which is edge enough.
 * The only frames are rings painted outside the box: orange for unread ticket comments or an
 * agent waiting on an answer, brand for the selected card, both when both.
 */
import {
  Button,
  Caption1,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Text,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowRightRegular,
  BeakerRegular,
  BookmarkRegular,
  BugRegular,
  CircleRegular,
  ClockRegular,
  DocumentMultipleRegular,
  FlagRegular,
  FlashRegular,
  LinkAddRegular,
  LinkRegular,
  MoreHorizontalRegular,
  NoteRegular,
  PersonRegular,
  PlayCircleRegular,
  PresenceBlockedRegular,
  QuestionCircleRegular,
  RecordStopRegular,
  SparkleRegular,
  TaskListSquareLtrRegular,
} from '@fluentui/react-icons';
import type { Person, Task } from '@tm/shared/model';
import {
  canResumeWork,
  canStopWork,
  chainNeedsAttention,
  hasUnreadJira,
  needsAgentInput,
  restingStatus,
  runPhase,
} from '@tm/shared/board';
import { formatElapsed } from '@tm/shared/elapsed';
import { MAX_SHOWN_FILES } from '@tm/shared/fileOverlap';
import type { ChainDecline } from '@tm/shared/taskChain';
import type { ChainFileHold } from './chainStates';
import type { LinkChips } from './linkChips';
import type { RunPurpose } from '@tm/shared/scheduler';
import { delegatedAgentName } from '@tm/shared/tickets';
import type { VariantGroupState } from '@tm/shared/variants';
import { AgentGlyph } from '../AgentGlyph';
import { STATUS_LABEL } from '../taskStatus';
import { automationOriginTitle, type AutomationOrigin } from './automationOrigin';
import { cardParts, type CardInk } from './cardParts';
import type { ChainPosition } from './chainPosition';
import {
  CHAIN_LINK_MIME,
  TASK_ID_ATTR,
  dropEffectFor,
  isChainLinkDrag,
  type LinkDropState,
} from './chainDrag';
import { ACCENT, RING } from '../theme';
import { FLUO_VAR } from '../tokens';
import { AssigneeDisplay } from '../projects/AssigneeDisplay';
import { ticketLinkTitle } from '../tracker';
import type { MergeRequest } from '@tm/shared/mergeRequest';
import { useElapsedClock } from '../useElapsedClock';

/** The delegation glyph, sized to sit with the owner slot rather than tower over it. */
const AGENT_ICON_SIZE = '16px';

/** The group every card that never started variants carries — see the `variants` prop. */
const NO_VARIANTS: VariantGroupState = { state: 'none', rows: [] };

/** `CardStatusLine.ink`/`CardTrailing`'s flagged colour, resolved to an actual CSS value —
 *  `cyan` is the only one with a dedicated `--tm-*` var (`FLUO_VAR.cyan`, the running state's
 *  own colour); the rest fall back to the same tokens the rest of the shell already uses for
 *  the same meaning (`IssueRow.dueFlagged`, `DiffView`'s added/deleted). */
const INK_COLOR: Record<CardInk, string> = {
  cyan: FLUO_VAR.cyan,
  attention: `var(--tm-attention, ${tokens.colorPaletteDarkOrangeForeground1})`,
  danger: tokens.colorPaletteRedForeground1,
  success: tokens.colorPaletteGreenForeground1,
  faint: `var(--tm-text-faint, ${tokens.colorNeutralForeground3})`,
};

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    borderRadius: tokens.borderRadiusMedium,
    // The link handle costs nothing at rest and appears when you reach for it. Written as
    // one combined selector rather than a `:hover` nesting a descendant rule, so there is
    // exactly one atomic class deciding the handle's opacity and no insertion-order race
    // with the base rule on the handle itself.
    '&:hover [data-chain-handle]': { opacity: 1, pointerEvents: 'auto' },
    // `dimmed` toggles opacity alone; the transition lives here so it plays whichever
    // direction the state changes, same split `AgentGlyph.layer`/`.hidden` makes.
    transitionProperty: 'opacity',
    transitionDuration: '160ms',
    transitionTimingFunction: 'ease-in-out',
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0ms' },
    // Brighter than the board it sits on: a card is the object, the column is the space
    // between objects, and the old darker fill had that backwards. That contrast is the
    // whole edge — there is no frame, because a frame was saying a second time what the
    // fill already said, and it fought the rings below for the same pixels.
    backgroundColor: tokens.colorNeutralBackground1,
    position: 'relative',
    overflow: 'hidden',
    // `overflow: hidden` drops this flex item's automatic minimum size to zero, so inside
    // the column's scrolling list the card would shrink and clip its own content instead of
    // making the column scroll. Never shrink a card.
    flexShrink: 0,
    cursor: 'pointer',
    userSelect: 'none',
    // The column header is opaque and pinned (`KanbanColumn.header`), so a card scrolled
    // into view would stop UNDER it and lose its top edge — which is exactly where the
    // attention ring lives. Stop below the header instead.
    scrollMarginTop: '36px',
  },
  body: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px' },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    // A crushed column leaves no room for the key and the trailing glyphs on one line —
    // wrapping to a second row (with a little vertical breathing room) beats clipping
    // either one, or forcing the whole card wider than the column.
    flexWrap: 'wrap',
    rowGap: '4px',
  },
  key: {
    flexShrink: 0,
    fontFamily: `var(--tm-mono, ${tokens.fontFamilyMonospace})`,
    fontSize: tokens.fontSizeBase200,
    color: `var(--tm-text-faint, ${tokens.colorNeutralForeground3})`,
    textDecoration: 'none',
  },
  /**
   * The card's footer badge used to carry the unread signal; the header key takes it over
   * now there is no badge left to wear it — same tint, `ACCENT.unread`/`unreadInk`.
   */
  keyUnread: {
    color: ACCENT.unreadInk,
    backgroundColor: ACCENT.unread,
    borderRadius: '3px',
    padding: '0 3px',
  },
  /** The dashed-ring placeholder for a card with neither an assignee nor a delegated agent —
   *  the one owner state `cardParts` leaves to the component, since "nothing to draw" and
   *  "explicitly unassigned" are different facts the mockup draws differently. */
  ownerPlaceholder: {
    flexShrink: 0,
    width: '18px',
    height: '18px',
    borderRadius: '50%',
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
  },
  /** The `Tooltip`'s wrapper span around the owner glyph — a plain `<span>` is inline and
   *  has no box of its own, so in a wrapping `headerTrail` it could not hold `flexShrink`
   *  or sit as its own flex item. */
  agentGlyphWrap: { display: 'inline-flex', flexShrink: 0 },
  /**
   * Everything the header carries besides the key and the title: the variant badge, the
   * automation-origin glyph, Stop/Resume, the More menu, and finally the owner glyph itself
   * (right-most, matching the mockup). Pulled out of `titleRow` so the title can wrap to two
   * lines without dragging these down with it, and `flexWrap` here lets them spill onto the
   * header's second row rather than clipping or widening the card.
   */
  headerTrail: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    marginLeft: 'auto',
    minWidth: 0,
  },
  /** The title alone now — the variant badge, origin glyph, Stop/Resume and More menu moved
   *  to `headerTrail` so a crushed column's title can wrap without dragging them down with
   *  it. */
  titleRow: { display: 'flex' },
  /** Clamped to two lines — the point of a column you can scan at a glance is that no card
   *  grows to fit a whole sentence; the full title is in the tooltip and the peek.
   *  `overflowWrap: 'anywhere'` so a long key-like token with no spaces (a ticket id pasted
   *  into the title) breaks instead of overflowing a crushed column. */
  title: {
    minWidth: 0,
    lineHeight: '18px',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    overflowWrap: 'anywhere',
  },
  /** The "×N" a leader wears once it has started variants (F10.5) — monochrome: how many
   *  rows exist is a standing fact about the card, not something in motion. */
  variantBadge: {
    color: tokens.colorNeutralForeground3,
    fontSize: '11px',
    fontWeight: 600,
    flexShrink: 0,
  },
  /**
   * The automation-origin glyph: a neutral token, no new colour (memory
   * *board-colour-budget* — colour is for things that MOVE, and "an automation started
   * this" is a standing fact about the card, not an event in progress).
   */
  originIcon: {
    fontSize: AGENT_ICON_SIZE,
    flexShrink: 0,
    display: 'flex',
    color: tokens.colorNeutralForeground3,
  },
  /**
   * Stop/Resume/"More actions" — icon only, no wider than its glyph. Subtle by default so it
   * does not compete with the title, full contrast on hover.
   */
  runButton: {
    flexShrink: 0,
    minWidth: '20px',
    maxWidth: '20px',
    height: '20px',
    padding: 0,
    color: tokens.colorNeutralForeground3,
    ':hover': { color: tokens.colorNeutralForeground1 },
  },
  /** The card's one status line — see `cardParts.CardStatusLine`. */
  statusLine: { display: 'flex', flexDirection: 'column', gap: '4px' },
  runRow: { display: 'flex', alignItems: 'center', gap: '6px' },
  runDot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    flexShrink: 0,
    backgroundColor: FLUO_VAR.cyan,
    animationName: {
      '0%, 100%': { backgroundColor: FLUO_VAR.cyanDeep },
      '50%': { backgroundColor: FLUO_VAR.cyan },
    },
    animationDuration: '1s',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'ease-in-out',
    '@media (prefers-reduced-motion: reduce)': {
      animationName: 'none',
      backgroundColor: FLUO_VAR.cyan,
    },
  },
  runText: {
    color: FLUO_VAR.cyan,
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  elapsed: { color: `var(--tm-text-faint, ${tokens.colorNeutralForeground3})`, flexShrink: 0 },
  /** The run row's progress track — 3px, `FLUO_VAR.cyan` fill over a faint rest. */
  progressTrack: {
    height: '3px',
    borderRadius: '2px',
    backgroundColor: tokens.colorNeutralBackground4,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: FLUO_VAR.cyan, borderRadius: '2px' },
  /** A non-running status line — one line, clipped; the ink comes from `INK_COLOR` inline,
   *  since it varies per state rather than per class. */
  statusText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /**
   * Where this card sits in its chain — "waiting on VIP-3", or "ready". Monochrome: a
   * dependency is a standing fact, not something in motion (memory *board-colour-budget*).
   * The icon carries the distinction the colour would otherwise have made.
   */
  chainChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    backgroundColor: tokens.colorNeutralBackground4,
    color: tokens.colorNeutralForeground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    fontSize: '11px',
    fontWeight: 600,
    padding: '1px 7px',
    borderRadius: '4px',
    maxWidth: '100%',
    minWidth: 0,
    overflow: 'hidden',
  },
  chainChipText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  /** The "+2" tail — outside the truncating span and unshrinkable, so a long first title
   *  cannot eat the only part of the chip that says there is more than one dependency. */
  chainChipMore: { flexShrink: 0, whiteSpace: 'nowrap' },
  /** The waiting chip's tooltip: one `waitReason` line per arrow still holding the card. */
  waitReasons: { display: 'flex', flexDirection: 'column', gap: '2px' },
  /** The chip for a card whose turn has come and which the chain could not start — emphasis
   *  by WEIGHT rather than hue, so it does not compete with the things that move. */
  chainChipHeld: {
    color: tokens.colorNeutralForeground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  chainChipIcon: { fontSize: '12px', flexShrink: 0, display: 'flex' },
  /** The file-hold chip wraps rather than truncating: the paths ARE the explanation, and an
   *  ellipsis would cut exactly the part that says which files. */
  fileHoldChip: { alignItems: 'flex-start' },
  /** Down to the first line's centre, now the chip can be taller than one line. */
  fileHoldIcon: { marginTop: '2px' },
  fileHoldText: { whiteSpace: 'normal', overflowWrap: 'anywhere' },
  /**
   * "Make this an arrow" inside the file-hold chip — subtle, so the chip still reads as a
   * standing fact, and unshrinkable, so a long file list cannot squeeze the one action out.
   */
  fileHoldArrow: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    padding: '0 2px',
    marginRight: '-4px',
    border: 'none',
    borderRadius: '3px',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground3,
    cursor: 'pointer',
    fontSize: '12px',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      color: tokens.colorNeutralForeground1,
    },
    ':focus-visible': { outline: `1px solid ${tokens.colorStrokeFocus2}` },
  },
  /** The needs/unblocks row (F13.20) — what `chainChip` says with an arrow and a chip, said
   *  instead in plain words once Off has turned that arrow off. */
  linkChipsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
    color: tokens.colorNeutralForeground3,
  },
  linkChipsIcon: { fontSize: '12px', flexShrink: 0, display: 'flex' },
  /** The one predecessor whose finishing releases this card right now — cyan, the overlay's
   *  own "starting next", and the only colour this row spends. */
  linkChipReleasing: { color: FLUO_VAR.cyan },
  footer: { display: 'flex', alignItems: 'center', gap: '8px' },
  grow: { flex: 1, minWidth: 0 },
  /** The epic/feature chip — a flag glyph and a truncated label, monochrome like every other
   *  standing fact on the footer. */
  epicChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    minWidth: 0,
    color: `var(--tm-text-faint, ${tokens.colorNeutralForeground3})`,
    fontSize: tokens.fontSizeBase200,
  },
  epicIcon: { fontSize: '12px', flexShrink: 0, display: 'flex' },
  epicText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  trailingMr: {
    flexShrink: 0,
    fontFamily: `var(--tm-mono, ${tokens.fontFamilyMonospace})`,
    fontSize: tokens.fontSizeBase200,
    color: `var(--tm-text-faint, ${tokens.colorNeutralForeground3})`,
    textDecoration: 'none',
  },
  trailingDue: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase200,
    color: `var(--tm-text-faint, ${tokens.colorNeutralForeground3})`,
  },
  trailingDueFlagged: {
    fontWeight: tokens.fontWeightSemibold,
    color: `var(--tm-attention, ${tokens.colorPaletteDarkOrangeForeground1})`,
  },
  /**
   * **"Wants you" is a ring; "is selected" is a brighter card.**
   *
   * The ring is `box-shadow`, not `border`: a border is part of the box, so adding one
   * would reflow the card's own text by a pixel. 3px, because the orange is painted OUTSIDE
   * the card against a dark column, where a good half of its apparent weight is lost to the
   * contrast; at 2px it read as a hairline.
   */
  cardUnread: { boxShadow: `0 0 0 ${RING.attention}px ${ACCENT.unread}` },
  /** One step up the neutral ladder from the card's own fill — the whole card, not just the
   *  body, so the lift runs to the card's edges rather than stopping at a seam. */
  cardSelected: { backgroundColor: tokens.colorNeutralBackground1Selected },
  /**
   * **The link handle** — a dot on the card's right edge, which is where the arrows leave.
   * Hidden until you hover the card or tab to it; `pointerEvents: none` while hidden matters
   * as much as the opacity does, or a transparent target on every card's edge would quietly
   * eat clicks meant for the card underneath it.
   */
  linkHandle: {
    position: 'absolute',
    right: '3px',
    top: '50%',
    transform: 'translateY(-50%)',
    width: '10px',
    height: '10px',
    padding: 0,
    borderRadius: '50%',
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground3,
    cursor: 'grab',
    opacity: 0,
    pointerEvents: 'none',
    ':hover': {
      backgroundColor: tokens.colorBrandStroke1,
      border: `1px solid ${tokens.colorBrandStroke1}`,
    },
    ':focus-visible': { opacity: 1, pointerEvents: 'auto' },
  },
  /** The handle of the card the link is being drawn FROM: filled, and it stays put. */
  linkHandleActive: {
    backgroundColor: tokens.colorBrandStroke1,
    border: `1px solid ${tokens.colorBrandStroke1}`,
  },
  /** A card the drop would land on. An `outline`, not the `boxShadow` the attention ring
   *  uses, so the two compose instead of one replacing the other. */
  linkValid: { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '2px' },
  /** Already joined — dashed and neutral, because nothing is wrong, it is simply already said. */
  linkExisting: {
    outline: `2px dashed ${tokens.colorNeutralStroke1}`,
    outlineOffset: '2px',
  },
  /** A step, or a loop. Dimmed, and the drop bounces — see `dropEffectFor`. */
  linkRefused: { opacity: 0.35 },
  dragging: { opacity: 0.5 },
  /** Focus mode's "non-neighbour" cards (`linkMode.linkView`'s `dimmedTaskIds`). */
  dimmed: { opacity: 0.45 },
});

export interface TaskCardProps {
  task: Task;
  /**
   * The parent epic's name, for the footer chip — a native ticket (Phase 24) carries only
   * `epicTaskId`, a reference to another card, so the name is resolved by whoever holds the
   * whole board and passed down. Falls back to `task.externalEpicName`/`externalParentKey`
   * for a mirrored card — see `cardParts.epicLabel`.
   */
  epicName?: string;
  /** The person this ticket is assigned to (Phase 24), for the header's owner glyph. */
  assignee?: Pick<Person, 'name' | 'initials' | 'color'>;
  /** Name of the agent project this card is delegated to, for the owner glyph's tooltip. */
  agentName?: string;
  /**
   * What started this card, when `task.originAutomationId` names an automation. Nothing
   * fills this until the automation list reaches the renderer (F1.11/F1.15); without it the
   * glyph's tooltip falls back to the generic "Started by an automation".
   */
  originAutomation?: AutomationOrigin;
  /** This card's steps in execution order — not rendered, but read for its run state,
   *  progress fraction and the ring's `chainNeedsAttention`. */
  subtasks?: Task[];
  /** The merge requests filed under this card — read for the status line's verdict, the
   *  footer's MR ref, and the ring. */
  mergeRequests?: MergeRequest[];
  /**
   * This card's variant group (F10.5) — `{state: 'none', rows: []}` for every card that
   * never started one. `state !== 'none'` draws the "×N" badge.
   */
  variants?: VariantGroupState;
  /**
   * The task ids the inbox is holding an item for — the AUTHORITATIVE "wants you" signal.
   */
  attentionTaskIds?: ReadonlySet<string>;
  /** The task ids the engine currently has a run for, so a run that has spawned but is not
   *  yet persisted as `running` still turns the owner glyph's pulse. */
  liveRunTaskIds?: ReadonlySet<string>;
  /** Why the engine has an agent working a task, when it is a remediation rather than the
   *  card's own work (`ActiveRun.purpose`) — folded into the status line by `cardParts`. */
  runPurposes?: ReadonlyMap<string, RunPurpose>;
  /** When each live run started (epoch ms) — `ActiveRun.startedAt`, keyed by task id, for
   *  the run row's elapsed-time chip. */
  runStartedAt?: ReadonlyMap<string, number>;
  /** The task ids whose branch is being merged, so the status line says "Merging branch…". */
  mergingTaskIds?: ReadonlySet<string>;
  selected: boolean;
  /**
   * The chain overlay's tap on this card's root element — a callback ref rather than a
   * forwarded `ref` because the overlay keeps one per task id and needs the *unmount* call
   * too; see `useCardAnchors`. Absent everywhere the board is not drawing a chain.
   */
  anchorRef?: (el: HTMLDivElement | null) => void;
  /**
   * What this card would do with the link currently being drawn, or undefined when no link
   * gesture is in the air. Computed once per gesture for the whole board (`linkDropStates`).
   */
  linkState?: LinkDropState;
  /** Called when a link drag starts from this card's handle. Absent on a board that is not
   *  drawing chains, which is also what hides the handle. */
  onLinkStart?: () => void;
  /** The drag ended, however it ended — dropped, escaped, or dropped on nothing. */
  onLinkEnd?: () => void;
  /** A link was dropped ON this card: `fromTaskId` runs first, this card runs after. */
  onLinkTo?: (fromTaskId: string) => void;
  /** Enter/Space on the handle — arm a link from this card, for anyone not using a mouse. */
  onLinkArm?: () => void;
  /** The predecessors this card is still waiting on (`blockedBy`), for its chip. */
  waitingOn?: readonly Task[];
  /** The subset of {@link waitingOn} that is waiting on nothing but a **human** pressing
   *  Merge (`awaitingMerge`), so the chip can say so. */
  mergeHeld?: readonly Task[];
  /** Why each arrow still holds this card, one line each (`waitReason`, via `chainStates`)
   *  — the waiting chip's tooltip. Absent, the chip falls back to naming the cards. */
  waitReasons?: readonly string[];
  /** Every predecessor has finished and nothing has started yet. */
  chainReady?: boolean;
  /** Its turn has come and the engine would start it, but its project's ready lanes are all
   *  taken (`readyLanes`) — never true together with {@link chainReady}. */
  chainQueued?: boolean;
  /** Its turn has come and the engine would **not** start it, with the reason. */
  chainBlocked?: ChainDecline | null;
  /** Another active card in its project touches the same files (`ChainState.fileHold`), so
   *  neither auto-start path starts this one until that card is done. */
  fileHold?: ChainFileHold;
  /** Turn {@link fileHold} into a permanent after-merge arrow from the holder to this card.
   *  Absent on a board that cannot draw arrows, which is also what hides the button. */
  onMakeArrow?: (fromTaskId: string) => void;
  /** Where this card sits in its chain — folded into the status line as the lowest-priority
   *  fallback by `cardParts` when nothing else is worth a line. */
  chainPosition?: ChainPosition;
  /** Stop the agent working this card — absent on a board that does not offer it, which is
   *  also what hides the button. */
  onStop?: () => void;
  /** Pick this card's stopped work back up — absent on a board that does not offer it, which
   *  is also what hides the button. */
  onResume?: () => void;
  /** Whether this card is on the shelf rather than in a column. */
  shelved?: boolean;
  /** Move this card onto the shelf, or back off it. Absent hides the menu item entirely. */
  onToggleShelved?: () => void;
  /** Open the compact board's "Move to" sheet for this card (F3.6) — touch's stand-in for
   *  dragging it to another column. */
  onMoveTo?: () => void;
  draggable: boolean;
  onSelect: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  dragging: boolean;
  /** Links Focus mode dims — the card is neither the selection nor one of its direct links. */
  dimmed?: boolean;
  /**
   * Needs/unblocks, pre-computed (`linkChips.ts`) — the card's own stand-in for the gutter
   * arrow while Off has turned the arrow off. Present (even with both lists empty)
   * SUPPRESSES the ordinary `chainChip` — the two say the same thing about the same
   * predecessor. Absent on every caller not in Off mode.
   */
  linkChips?: LinkChips;
}

/**
 * Pick a card icon for the task's type — used by `TaskDetail`'s own title row; the v9 board
 * card no longer draws a type glyph of its own (the mockup leaves type unmarked, matching
 * the board's colour budget: type is a standing fact that never changes).
 */
export function typeIcon(task: Task): JSX.Element {
  if (task.externalSource == null) {
    if (task.type === 'bug') return <BugRegular />;
    if (task.type === 'feature') return <BeakerRegular />;
    return <NoteRegular />;
  }
  const t = (task.externalType ?? '').toLowerCase();
  if (t.includes('bug')) return <BugRegular />;
  if (t.includes('story')) return <BookmarkRegular />;
  if (t.includes('epic')) return <SparkleRegular />;
  // `enhancement` is GitHub's word, and its half of the only two type names that sync writes
  // (`githubIssueSync.issueTypeFrom`) — the other, `Bug`, JIRA's vocabulary already covered.
  // The same ladder, in the same order, lives in `@tm/shared/tickets`'s `typeIconKeyFor`.
  if (t.includes('feature') || t.includes('improvement') || t.includes('enhancement')) {
    return <BeakerRegular />;
  }
  if (t.includes('sub')) return <PersonRegular />;
  if (t.includes('task')) return <TaskListSquareLtrRegular />;
  return <CircleRegular />;
}

export function TaskCard({
  task,
  epicName,
  assignee,
  agentName,
  originAutomation,
  subtasks = [],
  mergeRequests = [],
  variants = NO_VARIANTS,
  attentionTaskIds,
  liveRunTaskIds,
  runPurposes,
  runStartedAt,
  mergingTaskIds,
  selected,
  anchorRef,
  linkState,
  onLinkStart,
  onLinkEnd,
  waitingOn = [],
  mergeHeld = [],
  waitReasons = [],
  chainReady = false,
  chainQueued = false,
  chainBlocked = null,
  fileHold,
  onMakeArrow,
  chainPosition,
  onLinkTo,
  onLinkArm,
  onStop,
  onResume,
  shelved = false,
  onToggleShelved,
  onMoveTo,
  draggable,
  onSelect,
  onDragStart,
  onDragEnd,
  dragging,
  dimmed = false,
  linkChips,
}: TaskCardProps): JSX.Element {
  const styles = useStyles();
  /**
   * Whether the agent assigned to this ticket is meaningful FOR this ticket — only a native
   * ticket's own delegation counts (`task.agentProjectId`); a mirrored card's `agentName`
   * would otherwise come back resolved from nothing. See `cardParts.owner`.
   */
  const assigneeAgentName = delegatedAgentName(task, agentName);
  const run = runPhase(task, subtasks, liveRunTaskIds, mergingTaskIds);
  const now = useElapsedClock(run.spinner);
  const parts = cardParts(task, {
    now,
    subtasks,
    liveRunTaskIds,
    mergingTaskIds,
    mergeRequests,
    assignee,
    agentName: assigneeAgentName,
    runPurposes,
    epicName,
    chainPosition,
  });
  const elapsed = parts.statusLine?.kind === 'running' ? runStartedAt?.get(task.id) : undefined;
  const elapsedLabel = elapsed != null ? formatElapsed(now - elapsed) : undefined;
  /**
   * Whether this card is a MIRROR of something in a tracker — the key stays plain text for a
   * native ticket (this app IS the tracker, Phase 24), and becomes a link out for a mirrored
   * one, wearing the unread tint when the thread has moved.
   */
  const isExternal = task.externalSource != null;
  const ticketUnread = hasUnreadJira(task);
  // An unread comment, the card's own agent asking, or a step that has parked the chain
  // (question or failure) — all mean "this card wants you".
  const wantsAttention = chainNeedsAttention(task, subtasks, mergeRequests, attentionTaskIds);
  /**
   * Whether this card has agent work a click could stop — the same predicate the detail
   * pane asks, so the card and the pane can never disagree about whether there is anything
   * to stop.
   */
  const stoppable = Boolean(onStop) && canStopWork(task, subtasks, liveRunTaskIds);
  /** Whether that click reaches into the card's PLAN — one Stop covers the whole chain. */
  const stopsChain = subtasks.some(
    (s) => s.status === 'running' || s.status === 'waiting-input' || s.status === 'pending',
  );
  /** Whether this card has stopped work a click could pick back up — never true at the same
   *  time as {@link stoppable}, which is what lets both share one slot. */
  const resumable = Boolean(onResume) && canResumeWork(task, subtasks, liveRunTaskIds);
  /** Whether that click also re-queues the card's PLAN, which the tooltip should say. */
  const resumesChain = subtasks.some((s) => s.status === 'stopped');

  /**
   * Where this card stands in its chain, as one chip — or null, for every card nobody has
   * drawn an arrow to. Waiting beats ready, because they cannot both be true and the blocked
   * case is the one that explains why nothing is happening. Suppressed whenever `linkChips`
   * is present — see that prop's doc.
   */
  const waitingNames = waitingOn.map((t) => t.externalKey || t.title);
  const namedIsMergeHeld = waitingOn.length > 0 && mergeHeld.some((t) => t.id === waitingOn[0].id);
  // One line per arrow saying whom it waits for and why — "(Done, not landed)" included,
  // the one hold no column on the board explains. The names-only sentence is the fallback
  // for a caller that passes no reasons.
  const withWaitReasons = (chip: JSX.Element): JSX.Element =>
    waitReasons.length ? (
      <Tooltip
        relationship="description"
        content={
          <div className={styles.waitReasons}>
            {waitReasons.map((r) => (
              <span key={r}>{r}</span>
            ))}
          </div>
        }
      >
        {chip}
      </Tooltip>
    ) : (
      chip
    );
  const chainChip = linkChips ? null : waitingOn.length ? (
    withWaitReasons(
      <span
        className={styles.chainChip}
        data-waiting-on=""
        title={
          waitReasons.length
            ? undefined
            : waitingOn.length > 1
              ? `Waiting on all of: ${waitingOn.map((t) => t.title).join(', ')}`
              : namedIsMergeHeld
                ? `${waitingNames[0]} has finished — merge its branch and this card starts by itself.`
                : `Waiting on ${waitingOn[0].title} — chained to run after it`
        }
      >
        <LinkRegular className={styles.chainChipIcon} />
        <span className={styles.chainChipText}>
          waiting on {waitingNames[0]}
          {namedIsMergeHeld && ' to merge'}
        </span>
        {waitingNames.length > 1 && (
          <span className={styles.chainChipMore}>+{waitingNames.length - 1}</span>
        )}
      </span>,
    )
  ) : fileHold ? (
    // After `waitingOn` — an arrow still unsatisfied is the stronger reason — and ahead of
    // `ready`, which a held card never is. Monochrome at held weight like the lane chip: the
    // overlap is a standing fact until the holder is done (memory *board-colour-budget*).
    <span
      className={mergeClasses(styles.chainChip, styles.chainChipHeld, styles.fileHoldChip)}
      title={
        `${fileHold.byKey} is working on the same files (${fileHold.files.join(', ')}) — ` +
        'this card starts once it is done, so the two branches cannot conflict.'
      }
      data-file-hold=""
    >
      <DocumentMultipleRegular
        className={mergeClasses(styles.chainChipIcon, styles.fileHoldIcon)}
      />
      <span className={styles.fileHoldText}>
        waits for {fileHold.byKey} (same files:{' '}
        {fileHold.files.slice(0, MAX_SHOWN_FILES).join(', ')}
        {fileHold.files.length > MAX_SHOWN_FILES && ', …'})
      </span>
      {onMakeArrow && (
        <button
          type="button"
          className={styles.fileHoldArrow}
          title={`Turn this into a permanent after-merge arrow from ${fileHold.byKey}`}
          aria-label="Make this an arrow"
          data-file-hold-arrow=""
          draggable={false}
          // The card selects on click and Enter — the button is not a way into the card.
          onClick={(e) => {
            e.stopPropagation();
            onMakeArrow(fileHold.byTaskId);
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <LinkAddRegular />
        </button>
      )}
    </span>
  ) : chainReady ? (
    <span
      className={styles.chainChip}
      title="Everything this card waits for has finished — it can start."
    >
      <PlayCircleRegular className={styles.chainChipIcon} />
      <span className={styles.chainChipText}>ready</span>
    </span>
  ) : chainQueued ? (
    <span
      className={mergeClasses(styles.chainChip, styles.chainChipHeld)}
      title={
        'Everything this card waits for has finished, but every ready lane of its project ' +
        'is taken — it becomes ready when one frees up. The number of lanes is the ' +
        "project's Ready lanes setting."
      }
      data-chain-queued=""
    >
      <ClockRegular className={styles.chainChipIcon} />
      <span className={styles.chainChipText}>queued (lane limit)</span>
    </span>
  ) : chainBlocked === 'no-agent' ? (
    <span
      className={mergeClasses(styles.chainChip, styles.chainChipHeld)}
      title={
        'Everything this card waits for has finished, but nobody has said who does the ' +
        'work — assign an agent and it starts by itself.'
      }
    >
      <PersonRegular className={styles.chainChipIcon} />
      <span className={styles.chainChipText}>needs an agent</span>
    </span>
  ) : chainBlocked === 'resting' ? (
    <span
      className={mergeClasses(styles.chainChip, styles.chainChipHeld)}
      title={
        `Everything this card waits for has finished. It is ${STATUS_LABEL[restingStatus(task)]}, ` +
        `and the chain never takes a card off a column you put it in — move it back to ` +
        `To Do and it starts.`
      }
    >
      <PresenceBlockedRegular className={styles.chainChipIcon} />
      <span className={styles.chainChipText}>its turn — held</span>
    </span>
  ) : null;
  /**
   * The card's open owner decision (`cardParts.decision`), as its own chip — not a branch of
   * `chainChip`, because a decision holds a card whether or not anybody chained it, and a
   * card can be waiting on a predecessor AND a decision at once. Monochrome, held weight:
   * a standing fact, like the chain's own held chips (memory *board-colour-budget*).
   */
  const decisionChip = parts.decision ? (
    <span
      className={mergeClasses(styles.chainChip, styles.chainChipHeld)}
      title={`Waiting on a decision: ${parts.decision.question} Answer it on the card or in the Inbox.`}
      data-decision-chip=""
    >
      <QuestionCircleRegular className={styles.chainChipIcon} />
      <span className={styles.chainChipText}>Needs decision</span>
    </span>
  ) : null;
  /**
   * The needs/unblocks row `linkChips` draws in place of `chainChip` — see that prop's doc.
   */
  const needsUnblocksRow =
    linkChips && (linkChips.needs.length > 0 || linkChips.unblocks.length > 0) ? (
      <Caption1 className={styles.linkChipsRow}>
        {linkChips.needs.length > 0 && (
          <span title={`Needs ${linkChips.needs.map((n) => n.key).join(', ')} to run first`}>
            <ArrowRightRegular className={styles.linkChipsIcon} /> needs{' '}
            {linkChips.needs.map((n, i) => (
              <span key={n.key}>
                {i > 0 && ', '}
                <span className={n.tone === 'releasing' ? styles.linkChipReleasing : undefined}>
                  {n.key}
                </span>
              </span>
            ))}
          </span>
        )}
        {linkChips.unblocks.length > 0 && (
          <span title={`Unblocks ${linkChips.unblocks.map((u) => u.key).join(', ')} once done`}>
            unblocks {linkChips.unblocks.map((u) => u.key).join(', ')}
          </span>
        )}
      </Caption1>
    ) : null;

  const keyLink = isExternal && task.externalUrl ? task.externalUrl : null;
  const keyTitle = ticketUnread
    ? `${parts.key} — new comments on the ticket`
    : (ticketLinkTitle(task) ?? undefined);
  const keyNode = keyLink ? (
    <a
      className={mergeClasses(styles.key, ticketUnread && styles.keyUnread)}
      href={keyLink}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={keyTitle}
    >
      {parts.key}
    </a>
  ) : (
    <Text className={styles.key}>{parts.key}</Text>
  );

  const ownerTooltip = parts.owner
    ? needsAgentInput(task)
      ? `Agent needs your input${agentName ? ` · ${agentName}` : ''}`
      : run.spinner
        ? `${run.label || 'The agent is working'}${agentName ? ` · ${agentName}` : ''}`
        : parts.owner.avatar.title
    : 'Unassigned';
  const ownerNode = parts.owner ? (
    parts.owner.avatar.agentName ? (
      <Tooltip relationship="label" content={ownerTooltip}>
        <span className={styles.agentGlyphWrap}>
          <AgentGlyph running={parts.owner.running} size={AGENT_ICON_SIZE} />
        </span>
      </Tooltip>
    ) : (
      <AssigneeDisplay
        assignee={parts.owner.avatar.assignee}
        title={parts.owner.avatar.title}
        size={20}
      />
    )
  ) : (
    <span className={styles.ownerPlaceholder} title="Unassigned" />
  );

  return (
    <div
      ref={anchorRef}
      // How a drag event names the card it happened over — see `taskIdUnder`.
      {...{ [TASK_ID_ATTR]: task.id }}
      className={mergeClasses(
        styles.card,
        // Composed, not chosen between: the ring and the fill are different properties, so
        // a card that both wants you and is selected simply gets both.
        wantsAttention && styles.cardUnread,
        selected && styles.cardSelected,
        dragging && styles.dragging,
        dimmed && styles.dimmed,
        linkState === 'valid' && styles.linkValid,
        linkState === 'linked' && styles.linkExisting,
        linkState === 'refused' && styles.linkRefused,
      )}
      // Keyboard-reachable for the same reason it is clickable — F13.13's "Space opens the
      // peek" applies to a board card exactly as it does to an issue row, and a plain `div`
      // gets neither focus nor a role for free.
      tabIndex={0}
      role="button"
      aria-label={task.title}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      // A link being drawn, not a card being moved. Two gestures share one mechanism and
      // are told apart by the TYPE on the `DataTransfer`, never by where the pointer is.
      onDragOver={(e) => {
        if (!isChainLinkDrag(e.dataTransfer.types)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = dropEffectFor(linkState);
      }}
      onDrop={(e) => {
        if (!isChainLinkDrag(e.dataTransfer.types)) return;
        e.preventDefault();
        e.stopPropagation();
        const fromTaskId = e.dataTransfer.getData(CHAIN_LINK_MIME);
        if (fromTaskId) onLinkTo?.(fromTaskId);
      }}
      onClick={onSelect}
      // Only when the CARD itself holds focus — a button inside it (Stop/Resume, the link
      // handle) already answers Space on its own, and the keydown would otherwise bubble up
      // here too and select the card a second time.
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      {onLinkStart && (
        <button
          type="button"
          data-chain-handle=""
          className={mergeClasses(
            styles.linkHandle,
            linkState === 'source' && styles.linkHandleActive,
          )}
          style={linkState === 'source' ? { opacity: 1, pointerEvents: 'auto' } : undefined}
          draggable
          aria-label={`Chain from ${task.title} — drag onto another card to run that card after this one`}
          title="Drag onto another card to run that card after this one"
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer.setData(CHAIN_LINK_MIME, task.id);
            e.dataTransfer.effectAllowed = 'link';
            onLinkStart();
          }}
          onDragEnd={(e) => {
            e.stopPropagation();
            onLinkEnd?.();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onLinkArm?.();
          }}
        />
      )}
      <div className={styles.body}>
        <div className={styles.header}>
          {keyNode}
          <div className={styles.headerTrail}>
            {variants.state !== 'none' && (
              <Caption1
                className={styles.variantBadge}
                title={`${variants.rows.length} variants started`}
              >
                ×{variants.rows.length}
              </Caption1>
            )}
            {task.originAutomationId && (
              <Tooltip relationship="label" content={automationOriginTitle(originAutomation)}>
                <span className={styles.originIcon}>
                  <FlashRegular />
                </span>
              </Tooltip>
            )}
            {stoppable && (
              <Tooltip
                relationship="label"
                content={
                  stopsChain
                    ? "Stop the agent: the step that is running is stopped and the steps queued behind it are cancelled. The card's branch and worktree are kept."
                    : 'Stop the agent working on this card. Its branch and worktree are kept, so the work can be picked up again.'
                }
              >
                <Button
                  className={styles.runButton}
                  size="small"
                  appearance="subtle"
                  icon={<RecordStopRegular />}
                  draggable={false}
                  onDragStart={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onStop?.();
                  }}
                />
              </Tooltip>
            )}
            {resumable && (
              <Tooltip
                relationship="label"
                content={
                  resumesChain
                    ? "Pick the work up in the same conversation: the agent carries on from where it stopped, in this card's worktree, and the steps queued behind it are queued again."
                    : "Pick the work up in the same conversation: the agent carries on from where it stopped, in this card's worktree."
                }
              >
                <Button
                  className={styles.runButton}
                  size="small"
                  appearance="subtle"
                  icon={<PlayCircleRegular />}
                  draggable={false}
                  onDragStart={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onResume?.();
                  }}
                />
              </Tooltip>
            )}
            {(onToggleShelved || onMoveTo) && (
              <Menu>
                <MenuTrigger disableButtonEnhancement>
                  <Button
                    className={styles.runButton}
                    size="small"
                    appearance="subtle"
                    icon={<MoreHorizontalRegular />}
                    title="More actions"
                    draggable={false}
                    onDragStart={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                  />
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    {onMoveTo && (
                      <MenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          onMoveTo();
                        }}
                      >
                        Move to…
                      </MenuItem>
                    )}
                    {onToggleShelved && (
                      <MenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleShelved();
                        }}
                      >
                        {shelved ? 'Return to board' : 'Move to shelf'}
                      </MenuItem>
                    )}
                  </MenuList>
                </MenuPopover>
              </Menu>
            )}
            {ownerNode}
          </div>
        </div>

        <div className={styles.titleRow}>
          <Text weight="semibold" className={styles.title}>
            {task.title}
          </Text>
        </div>

        {parts.statusLine && (
          <div className={styles.statusLine}>
            {parts.statusLine.kind === 'running' ? (
              <>
                <div className={styles.runRow}>
                  <span className={styles.runDot} />
                  <Caption1 className={styles.runText} title={parts.statusLine.label}>
                    {parts.statusLine.label}
                  </Caption1>
                  {elapsedLabel && <Caption1 className={styles.elapsed}>{elapsedLabel}</Caption1>}
                </div>
                {parts.progress && (
                  <div
                    className={styles.progressTrack}
                    title={`${parts.progress.done} of ${parts.progress.total} steps done`}
                  >
                    <div
                      className={styles.progressFill}
                      style={{ width: `${(parts.progress.done / parts.progress.total) * 100}%` }}
                    />
                  </div>
                )}
              </>
            ) : (
              <Caption1
                className={styles.statusText}
                style={{ color: INK_COLOR[parts.statusLine.ink] }}
                title={parts.statusLine.label}
              >
                {parts.statusLine.label}
              </Caption1>
            )}
          </div>
        )}

        {decisionChip && <div>{decisionChip}</div>}
        {(chainChip || needsUnblocksRow) && <div>{chainChip ?? needsUnblocksRow}</div>}

        {(parts.epic || parts.trailing) && (
          <div className={styles.footer}>
            {parts.epic && (
              <span className={styles.epicChip} title={`Epic: ${parts.epic}`}>
                <FlagRegular className={styles.epicIcon} />
                <span className={styles.epicText}>{parts.epic}</span>
              </span>
            )}
            <span className={styles.grow} />
            {parts.trailing &&
              (parts.trailing.kind === 'mr' ? (
                <a
                  className={styles.trailingMr}
                  href={parts.trailing.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  {parts.trailing.ref}
                </a>
              ) : (
                <Caption1
                  className={mergeClasses(
                    styles.trailingDue,
                    parts.trailing.flagged && styles.trailingDueFlagged,
                  )}
                >
                  {parts.trailing.label}
                </Caption1>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
