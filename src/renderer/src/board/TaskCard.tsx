/**
 * TaskCard — one draggable card on the My Tasks Kanban board.
 *
 * Mirrors the product mockup: a stripe of its project's colour along the top, a type
 * icon + title, an optional label chip, its progress note, the card's "Project:" line,
 * and a footer with the JIRA source badge and a priority square. A small status badge
 * appears only for the "unusual" states bucketed into a column (an AI run, or a
 * failed/stopped/cancelled task in Done).
 *
 * The card itself has NO frame — the fill is brighter than the column, which is edge
 * enough. The only frames are rings painted outside the box: orange for unread JIRA
 * comments or an agent waiting on an answer, brand for the selected card, both when
 * both. Outside, so clicking a card never moves its own text.
 *
 * Steps (Phase 11) and merge requests each render as a **section** of the card: one
 * hairline above the group, a quiet caption naming it, and the card's own fill
 * continuing underneath. They are part of the card, not strips floating on it. A step is
 * never a card of its own — it travels with its parent between columns — so the rows are
 * not draggable; clicking one selects that step in the detail pane.
 *
 * Phase 17 changed three things about what the card can say:
 *
 *   - The ring is driven by the INBOX (`attentionTaskIds`), not inferred from status and
 *     JIRA timestamps, so an item raised without a status flip no longer goes unshown.
 *   - The spinner comes from `runPhase`, which can see a run that has spawned but is not
 *     yet persisted as `running`, and it is accompanied by words — "Running step 2 of 5"
 *     rather than bare motion.
 *   - A row that wants you takes a TINT and the ticket badge takes the JIRA signal, so
 *     the card's one orange ring keeps its meaning and the reason stays legible.
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
  BeakerFilled,
  BookmarkFilled,
  BugFilled,
  CheckmarkCircleFilled,
  CheckmarkCircleRegular,
  CircleFilled,
  DismissCircleFilled,
  NoteFilled,
  PersonFilled,
  SparkleFilled,
  TaskListSquareLtrFilled,
} from '@fluentui/react-icons';
import type { Task } from '@shared/model';
import {
  cardRunLabel,
  chainNeedsAttention,
  hasUnreadJira,
  isAgentAssigned,
  needsAgentInput,
  parkedStep,
  runPhase,
} from '@shared/board';
import { priorityColor } from '@shared/priority';
import { statusNoteColor, type StatusKeyword } from '@shared/statusKeywords';
import { DEFAULT_BOARD_DISPLAY, type BoardDisplaySettings } from '@shared/settings';
import { AgentGlyph } from '../AgentGlyph';
import { STATUS_COLOR, STATUS_LABEL } from '../taskStatus';
import { columnForTask, statusForColumn, subtaskProgress } from './boardColumns';
import {
  ACCENT,
  ATTENTION_TINT,
  FLUO,
  PIPELINE_COLOR,
  RING,
  STATUS_INDICATOR_COLOR,
} from '../theme';
import { JiraMark } from '../JiraMark';
import {
  approvalSummary,
  mrApprovalState,
  mrAttentionReason,
  mrLabel,
  type MergeRequest,
} from '@shared/mergeRequest';

/**
 * The delegation glyph, white so a card an agent owns reads at a glance. Sized to sit
 * with the card's type icon rather than tower over it.
 */
const AGENT_ICON_SIZE = '16px';

/**
 * The running band's geometry — see `runningBand` for what it draws.
 *
 * The band is a repeating gradient tilted `ANGLE` off vertical, swept along its OWN axis
 * rather than straight sideways. CSS measures a gradient angle clockwise from "to top", so a
 * θ gradient points along `(sin θ, −cos θ)` in screen coordinates (y growing downwards) —
 * which is where `DX`/`DY` come from. One cycle travels exactly `PERIOD` along that axis, so
 * the last frame is identical to the first and the loop has no seam.
 *
 * Derived rather than typed out: an angle and a travel vector that disagree would show up as
 * a slow drift with a jump once per cycle, which is precisely the artefact this is built to
 * avoid, and is not a thing anyone would spot by reading two number literals.
 *
 * `PERIOD` is one crest PLUS the dark stretch behind it, so it and `animationDuration` are
 * the two halves of one decision — the band is a flash that passes, not a light that stays on:
 *
 *     speed          = PERIOD / duration        ≈ 404 px/s
 *     flash, at a point = crest / speed         ≈ 1.2s   (a quick sweep across)
 *     dark, between     = (PERIOD − crest)/speed ≈ 4.0s   (a real pause, not a blink)
 *
 * Lengthening the pause has to be done in `PERIOD` rather than by slowing the animation: the
 * duration governs how fast the crest MOVES, and the two ask for opposite things.
 */
const RUN_BAND_ANGLE = 100;
const RUN_BAND_PERIOD = 2100;
const RUN_BAND_RAD = (RUN_BAND_ANGLE * Math.PI) / 180;
const RUN_BAND_DX = (RUN_BAND_PERIOD * Math.sin(RUN_BAND_RAD)).toFixed(2);
const RUN_BAND_DY = (RUN_BAND_PERIOD * -Math.cos(RUN_BAND_RAD)).toFixed(2);

/** `FLUO.cyan` (#22E4FF) as channels, so the band can vary only its alpha. */
const RUN_BAND_RGB = '34, 228, 255';
const runBandCyan = (alpha: number): string => `rgba(${RUN_BAND_RGB}, ${alpha})`;

/**
 * The crest, sampled as a RAISED COSINE — `0.5 · (1 − cos 2πt)` at each eighth — instead of
 * the three stops it had before.
 *
 * This is the fix for the line you could see in the middle of the sweep. A gradient with few
 * stops is piecewise LINEAR, so its slope changes abruptly at each stop, and vision
 * exaggerates exactly that into a bright edge (Mach banding) — the crest read as a drawn line
 * rather than as light. A raised cosine has zero slope where it meets the transparent gap and
 * turns over smoothly at the peak, so there is no step in the slope left to exaggerate.
 *
 * The peak is 0.45 — bright enough that the crest still reads as cyan once composited over
 * the card's near-black fill, where 0.30 landed on a greyish teal. It is paired with
 * `runningText`, and the two must not be changed apart: this number is what the white text
 * under the band is contrast-checked against.
 */
const RUN_BAND_BELL = [0, 0.066, 0.225, 0.384, 0.45, 0.384, 0.225, 0.066, 0];
/**
 * Where the crest starts, and how far apart its eight samples sit — so the lit part is
 * `8 × STEP` and everything else in `PERIOD` is the pause between flashes.
 */
const RUN_BAND_CREST_START = 120;
const RUN_BAND_STEP = 60;
const RUN_BAND_STOPS = [
  `${runBandCyan(0)} 0px`,
  ...RUN_BAND_BELL.map(
    (alpha, i) => `${runBandCyan(alpha)} ${RUN_BAND_CREST_START + i * RUN_BAND_STEP}px`,
  ),
  `${runBandCyan(0)} ${RUN_BAND_PERIOD}px`,
].join(', ');

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    borderRadius: tokens.borderRadiusMedium,
    // Brighter than the board it sits on: a card is the object, the column is the space
    // between objects, and the old darker fill had that backwards. That contrast is the
    // whole edge — there is no frame, because a frame was saying a second time what the
    // fill already said, and it fought the rings below for the same pixels.
    backgroundColor: tokens.colorNeutralBackground1,
    // Step rows sit flush against the frame, so they must be clipped by its radius.
    overflow: 'hidden',
    // ...but `overflow: hidden` also drops this flex item's automatic minimum size to
    // zero, so inside the column's scrolling list the card would shrink and clip its
    // own step rows instead of making the column scroll. Never shrink a card.
    flexShrink: 0,
    cursor: 'pointer',
    userSelect: 'none',
    // The column header is opaque and pinned (`KanbanColumn.header`), so a card scrolled
    // into view would stop UNDER it and lose its top edge — which is exactly where the
    // project stripe and the attention ring live. Stop below the header instead.
    // Un-pinning the header would cost the column labels on every scroll: a worse trade.
    scrollMarginTop: '36px',
  },
  body: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px' },
  /**
   * The card's project, as a stripe along the top edge. Top rather than left so it can
   * never be confused with — or crowd — the ring that says a card wants you, and so it
   * stays put however tall the card's step rows make it. Clipped into the corners by
   * the card's own `overflow: hidden` + radius.
   */
  projectBar: { height: '3px', flexShrink: 0 },
  /**
   * A group of rows (steps, or merge requests) as a SECTION of the card rather than a
   * strip floating on it: one hairline above the group, a quiet caption naming it, and
   * the card's own fill continuing underneath.
   */
  section: { borderTop: `1px solid ${tokens.colorNeutralStroke2}` },
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '6px 12px 2px',
    color: tokens.colorNeutralForeground4,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    fontSize: '10px',
    fontWeight: 600,
  },
  // No row border: the section owns the one hairline, and a rule per row turned a card
  // with four steps into a ledger.
  step: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '5px 12px',
    // The card's own fill, NOT the board's. These rows are part of the card; painting
    // them in the column's colour made them read as holes punched through it.
    backgroundColor: tokens.colorNeutralBackground1,
  },
  stepSelected: { backgroundColor: tokens.colorNeutralBackground1Selected },
  /**
   * A row that wants you: a TINT and nothing else.
   *
   * Not a border — the card already carries the orange ring, and a second orange edge a
   * few pixels inside it made the two compete for the same glance. Not a fourth card
   * boxShadow variant either: Griffel would have the later class REPLACE `boxShadow`,
   * removing the ring from exactly the card that needs it.
   */
  stepLoud: { backgroundColor: ATTENTION_TINT },
  /** An MR row is a link, but it must look exactly like the step rows above it. */
  mrRow: { textDecoration: 'none', color: 'inherit' },
  /** The approval glyph, at the row's trailing edge opposite the pipeline dot. */
  approval: { display: 'flex', alignItems: 'center', fontSize: '14px', flexShrink: 0 },
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
  /**
   * The pipeline's stages on an MR row, one dot each.
   *
   * `minWidth` is the fixed slot the single dot used to occupy, so a one-stage pipeline
   * still starts its title exactly where every step row above it does; more stages grow
   * rightwards from there. `flexShrink: 0` because the title beside it is the elastic
   * element — a pipeline that lost a dot to make room for two more characters of a branch
   * name would be lying about the pipeline.
   */
  stageDots: {
    display: 'flex',
    alignItems: 'center',
    gap: '3px',
    minWidth: '16px',
    flexShrink: 0,
  },
  /** 6px, against the step dot's 8px: several in a row read as a group, not as a queue. */
  stageDot: { width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0 },
  /**
   * A stage the runners are on, blinking between the spinner's two cyans — the same pair
   * `MergeRequests.stageDotRunning` and the agent glyph use, so "working" looks like one
   * thing whether you are reading the card or the pane.
   */
  stageDotRunning: {
    animationName: {
      '0%, 100%': { backgroundColor: FLUO.cyanDeep },
      '50%': { backgroundColor: FLUO.cyan },
    },
    animationDuration: '1s',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'ease-in-out',
    '@media (prefers-reduced-motion: reduce)': {
      animationName: 'none',
      backgroundColor: FLUO.cyan,
    },
  },
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
  progressStopped: { color: ACCENT.unread },
  /**
   * What the card is doing, in words, next to the spinner. The spinner alone says
   * "something is happening"; this says WHICH something, which is the difference
   * between a card you trust and one you keep clicking to check.
   */
  runLabel: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  /**
   * "Wants you" and "is selected", as rings PAINTED OUTSIDE the card.
   *
   * `box-shadow`, not `border`: a border is part of the box, so adding one on click
   * reflowed the card's own text by a pixel — a visible twitch on every selection.
   * A shadow costs no layout at all. It is also stackable, which is why the third
   * class exists: with two separate classes Griffel would have the later one REPLACE
   * `boxShadow`, and the orange would vanish the moment you clicked the card that was
   * shouting for you — exactly the card you most need to keep flagged.
   */
  // 3px for the alarm, 2px for mere selection. The orange is painted OUTSIDE the card
  // against a dark column, so a good half of its apparent weight is lost to the
  // contrast — at 2px it read as a hairline. Selection stays 2px: only the alarm is
  // worth more ink, and widening both would flatten the difference between them.
  cardUnread: { boxShadow: `0 0 0 ${RING.attention}px ${ACCENT.unread}` },
  cardSelected: { boxShadow: `0 0 0 ${RING.selected}px ${tokens.colorBrandStroke1}` },
  cardUnreadSelected: {
    boxShadow:
      `0 0 0 ${RING.attention}px ${ACCENT.unread}, ` +
      `0 0 0 ${RING.attention + RING.selected}px ${tokens.colorBrandStroke1}`,
  },
  agentIcon: { fontSize: AGENT_ICON_SIZE, flexShrink: 0, display: 'flex', color: '#ffffff' },
  dragging: { opacity: 0.5 },
  titleRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  /**
   * "An agent is working on this card", as a slow fluo-cyan sweep behind the card's whole top
   * section — title, chips, note, project, epic, and the JIRA/priority footer. It sits on
   * `body`, which already ends exactly where the Steps and Merge requests sections begin,
   * so the band needs no wrapper and no negative margins: the sweep runs edge to edge and
   * the card's own `overflow: hidden` + radius clip it into the corners.
   *
   * **It travels along the gradient's own axis**, not straight sideways. `RUN_BAND_DX/DY`
   * are the angle resolved into a screen vector, so one cycle is a diagonal slide of exactly
   * one `RUN_BAND_PERIOD` down-and-right — the direction the gradient points.
   *
   * **No tiling.** The earlier version repeated a fixed-width tile, which meant a tile
   * boundary existed at all and only stayed invisible because the card was short enough to
   * keep the seam inside the gradient's transparent ends. A `repeating-linear-gradient` has
   * no boundary to hide: the stripes are absolute px along the gradient line, so the pattern
   * is defined everywhere and its phase cannot depend on how tall the card grew. The image is
   * simply oversized by the travel vector and slid back to `0 0`, so it always covers the
   * card and the last frame is identical to the first.
   *
   * The peak is 45% cyan, which is what makes it read as fluo rather than as a grey-teal
   * wash — 30% composited over the card's near-black fill lands on rgb(39,97,105), a colour
   * with very little cyan left in it. That brightening is only affordable because
   * `runningText` lifts every line under the band to white for as long as it runs: white on
   * the crest is 4.79:1, against 4.35:1 for the old #CCCCCC on the old dimmer crest. Both the
   * band and the text got brighter, and the card is more legible running than it was.
   */
  runningBand: {
    backgroundImage: `repeating-linear-gradient(${RUN_BAND_ANGLE}deg, ${RUN_BAND_STOPS})`,
    // Oversized by exactly the travel, so the image still covers the card at both ends of
    // the slide and `no-repeat` is safe — which is what removes the tile seam entirely.
    backgroundSize: `calc(100% + ${RUN_BAND_DX}px) calc(100% + ${RUN_BAND_DY}px)`,
    backgroundRepeat: 'no-repeat',
    animationName: {
      from: { backgroundPosition: `${-Number(RUN_BAND_DX)}px ${-Number(RUN_BAND_DY)}px` },
      to: { backgroundPosition: '0px 0px' },
    },
    // With PERIOD, this is the flash: ~404px/s, so the crest crosses in about 1.2s and the
    // card then sits dark for 4. Faster AND rarer — see the geometry block for why those
    // pull in opposite directions and which knob owns which.
    animationDuration: '5.2s',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'linear',
    // The state still has to be visible without motion, so it becomes an even wash — at the
    // bell's midpoint rather than its peak, since a still surface is read, not glanced at.
    '@media (prefers-reduced-motion: reduce)': {
      animationName: 'none',
      backgroundImage: `linear-gradient(${runBandCyan(0.26)}, ${runBandCyan(0.26)})`,
    },
  },
  /**
   * Every line of text sitting on the band, while it runs.
   *
   * Not decoration — it is what pays for the crest being bright enough to look fluo. The card
   * is at its most colourful exactly where its text is, so the two have to move together: at
   * 45% cyan, #CCCCCC would fall to 2.98:1 and the #ADADAD captions to 2.13:1, both far below
   * AA. White holds 4.79:1 at the very peak and 7.84:1 through the body of the bell.
   *
   * Applied per element with `mergeClasses` rather than as a `& > *` rule on the band: the
   * captions set their own `color`, and a descendant selector would tie with theirs on
   * specificity and be settled by whichever class Griffel happened to insert last.
   */
  runningText: { color: '#FFFFFF' },
  icon: { fontSize: '18px', flexShrink: 0, display: 'flex' },
  title: { lineHeight: '18px', flex: 1, minWidth: 0 },
  project: { color: tokens.colorNeutralForeground3 },
  /**
   * The card's progress note: one line, clipped. One line on purpose — the point is
   * that a column of cards can be read at a glance, and a card that grew to fit a
   * paragraph would defeat that. The full text is in the tooltip and the pane.
   */
  statusNote: {
    color: tokens.colorNeutralForeground2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  chipRow: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
  chip: {
    backgroundColor: '#12836b',
    color: '#ffffff',
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.03em',
    padding: '2px 8px',
    borderRadius: '4px',
  },
  // Quieter than the label chip on purpose: the sprint is context, not the headline.
  // The 1px padding offsets the border so both chips sit at the same height.
  sprintChip: {
    backgroundColor: tokens.colorNeutralBackground4,
    color: tokens.colorNeutralForeground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.03em',
    padding: '1px 7px',
    borderRadius: '4px',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  footer: { display: 'flex', alignItems: 'center', gap: '8px' },
  grow: { flex: 1, minWidth: 0 },
  jiraLink: { textDecoration: 'none' },
  /** The ticket badge: the JIRA mark, then the key. */
  jiraBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    padding: '2px 7px',
    borderRadius: '4px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground2,
    fontSize: '11px',
    fontWeight: 600,
  },
  /**
   * The same badge, carrying the unread signal itself.
   *
   * The card's ring says "this wants you" but never why, so a new JIRA comment and an
   * agent's question looked identical. Tinting the badge that OWNS the reason is the
   * same move the merge-request rows make, and it costs the card no extra furniture.
   */
  // The whole `border`, not `borderColor`: Griffel rejects the four-sided shorthand.
  jiraBadgeUnread: {
    backgroundColor: ACCENT.unread,
    border: `1px solid ${ACCENT.unread}`,
    color: ACCENT.unreadInk,
  },
  prioritySquare: { width: '14px', height: '14px', borderRadius: '3px', flexShrink: 0 },
});

// Type-icon colors, now from the one palette (`theme.ts`) rather than four literals the
// card owned privately. Aliased so the maps below read the same as they always did.
const BUG_RED = ACCENT.bugRed;
const FEATURE_BLUE = ACCENT.featureBlue;
const STORY_GREEN = ACCENT.storyGreen;
const EPIC_PURPLE = ACCENT.epicPurple;

/**
 * Step-row dot color per status — the row's whole status display, since a badge per
 * row would drown the card. Deliberately the same vocabulary as `STATUS_COLOR`'s
 * badges: green done, red failed, brand while running, orange while it wants you.
 * `in-review` borrows the epic violet: it is the one column that is neither work in
 * flight nor work finished.
 */

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
  /** The card's project colour (`''`/undefined = no stripe). */
  projectColor?: string;
  /**
   * Whether to show the sprint chip. False while the board is filtered to the current
   * sprint: every card would carry the same word, so the name moves to the status bar
   * and is said once. With the filter off the chip is back, because that is when it
   * actually tells one card from another.
   */
  showSprint?: boolean;
  /** This card's steps in execution order — rendered inside the card. */
  subtasks?: Task[];
  /**
   * The merge requests filed under this card. Rendered as rows beneath the steps, and
   * folded into `chainNeedsAttention` — so the ring and the card ordering agree.
   */
  mergeRequests?: MergeRequest[];
  /** The user's status-note vocabulary, which colours the card's progress line. */
  statusKeywords?: readonly StatusKeyword[];
  /**
   * The task ids the inbox is holding an item for. The AUTHORITATIVE "wants you" signal:
   * without it the ring is inferred from status plus JIRA timestamps, so an item raised
   * without the engine also flipping the task to `waiting-input` — or one restored from
   * disk after a restart — left the card sitting there silently.
   */
  attentionTaskIds?: ReadonlySet<string>;
  /**
   * The task ids the engine currently has a run for, so a run that has spawned but is
   * not yet persisted as `running` still turns a spinner.
   */
  liveRunTaskIds?: ReadonlySet<string>;
  /** Which optional context lines to draw. Defaults to the shipped defaults. */
  display?: BoardDisplaySettings;
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

/**
 * The status worth badging on the card, or null when the column already says it.
 *
 * Measured against the column the card is actually IN (`columnForTask`), not against the
 * one its raw status would imply. Those two part company the moment a run borrows the
 * status: a card sitting in TO DO with a live agent is `running`, and the badge is then
 * the card's own way of saying so — without the card going anywhere.
 */
function secondaryStatus(task: Task): Task['status'] | null {
  const canonical = statusForColumn(columnForTask(task));
  return task.status === canonical ? null : task.status;
}

export function TaskCard({
  task,
  projectName,
  agentName,
  projectColor,
  showSprint = true,
  subtasks = [],
  mergeRequests = [],
  statusKeywords,
  attentionTaskIds,
  liveRunTaskIds,
  display = DEFAULT_BOARD_DISPLAY,
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
  const sprintShown = showSprint;
  const isJira = task.externalSource === 'jira';
  const squareColor = priorityColor(task.externalPriority);
  // Null when the note matched no keyword — the line then keeps the card's ordinary
  // secondary text colour, so an uncoloured note reads as text rather than as a state.
  const noteColor = statusNoteColor(task.statusNote, statusKeywords);
  // An unread comment, the card's own agent asking, or a step that has parked the
  // chain (question or failure) — all mean "this card wants you", and a step has no
  // frame of its own to say it with.
  const wantsAttention = chainNeedsAttention(task, subtasks, mergeRequests, attentionTaskIds);
  const progress = subtaskProgress(subtasks);
  // A parked chain looks exactly like one between steps unless the card says so.
  const stopped = parkedStep(subtasks) !== null;
  // The one answer to "what is this card doing", shared with the detail pane and the
  // composer strip so the three can never disagree. It replaces a spinner derived from
  // `status === 'running'`, which could not see a run that had spawned but not yet been
  // persisted — the "it's clearly working but there's no spinner" complaint.
  const run = runPhase(task, subtasks, liveRunTaskIds);
  // What is worth saying in WORDS, once the pulsing glyph and the step counter have had their
  // say. Null while the agent is visibly working.
  const cardLabel = cardRunLabel(run, isAgentAssigned(task));
  // Only the ticket badge carries the JIRA signal, so the ring's reason is legible.
  const jiraUnread = hasUnreadJira(task);
  // Applied to every line the band runs behind, and gated on the SAME flag that draws it, so
  // the text can never be lifted onto a band that isn't there (or left dim on one that is).
  const onBand = run.spinner && styles.runningText;

  return (
    <div
      className={mergeClasses(
        styles.card,
        // One of three, never two: see `cardUnreadSelected`.
        wantsAttention && selected
          ? styles.cardUnreadSelected
          : wantsAttention
            ? styles.cardUnread
            : selected && styles.cardSelected,
        dragging && styles.dragging,
      )}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onSelect}
    >
      {projectColor && (
        <div className={styles.projectBar} style={{ backgroundColor: projectColor }} />
      )}
      <div className={mergeClasses(styles.body, run.spinner && styles.runningBand)}>
        <div className={styles.titleRow}>
          <span className={styles.icon}>{typeIcon(task)}</span>
          <Text weight="semibold" className={mergeClasses(styles.title, onBand)}>
            {task.title}
          </Text>
          {progress.total > 0 && (
            <Caption1
              className={mergeClasses(
                styles.progress,
                stopped && styles.progressStopped,
                // Not while stopped: that word is orange because the chain needs a human, and
                // whitening it would delete the signal to make the band look tidier.
                !stopped && onBand,
              )}
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
          {/* The glyph pulses while the agent works — it replaced a spinner that sat right
              here saying the same thing the words and the counter beside it already said.
              The tooltip still spells the state out for anyone who hovers. */}
          {isAgentAssigned(task) && (
            <Tooltip
              relationship="label"
              content={
                needsAgentInput(task)
                  ? `Agent needs your input${agentName ? ` · ${agentName}` : ''}`
                  : run.spinner
                    ? `${run.label || 'The agent is working'}${agentName ? ` · ${agentName}` : ''}`
                    : `Assigned to an agent${agentName ? ` · ${agentName}` : ''}`
              }
            >
              <AgentGlyph running={run.spinner} size={AGENT_ICON_SIZE} />
            </Tooltip>
          )}
          {/* Only the states the pulse cannot express — see `cardRunLabel`. */}
          {cardLabel && (
            <Caption1 className={mergeClasses(styles.runLabel, onBand)} title={cardLabel}>
              {cardLabel}
            </Caption1>
          )}
          {/* A running card's badge would only repeat what the label just said. */}
          {badge && !run.spinner && (
            <Badge appearance="tint" color={STATUS_COLOR[badge]}>
              {STATUS_LABEL[badge]}
            </Badge>
          )}
        </div>

        {((display.showLabels && task.externalLabel) || (sprintShown && task.externalSprint)) && (
          <div className={styles.chipRow}>
            {display.showLabels && task.externalLabel && (
              <span className={styles.chip}>{task.externalLabel}</span>
            )}
            {sprintShown && task.externalSprint && (
              <span className={styles.sprintChip} title={`Sprint: ${task.externalSprint}`}>
                {task.externalSprint}
              </span>
            )}
          </div>
        )}

        {/* Where the card actually is, in your words. Above the "Project:" line
            because it is the thing that changes, and the thing you scan for. */}
        {task.statusNote && (
          <Caption1
            className={mergeClasses(styles.statusNote, onBand)}
            // A note with a status colour keeps it: the inline style outranks both classes, and
            // that colour is the note's meaning rather than its styling.
            style={noteColor ? { color: noteColor } : undefined}
            title={task.statusNote}
          >
            {task.statusNote}
          </Caption1>
        )}

        {display.showProjectName && projectName && (
          <Caption1 className={mergeClasses(styles.project, onBand)}>
            Project: {projectName}
          </Caption1>
        )}

        {/* The name when the sync has it, the key until then — a key is still an answer
            to "which epic", where an empty line looks like the toggle is broken. */}
        {display.showEpicName && (task.externalEpicName || task.externalParentKey) && (
          <Caption1
            className={mergeClasses(styles.project, onBand)}
            title={`Epic: ${task.externalEpicName ?? task.externalParentKey}`}
          >
            Epic: {task.externalEpicName ?? task.externalParentKey}
          </Caption1>
        )}

        {(isJira || squareColor) && (
          <div className={styles.footer}>
            {isJira && task.externalKey && (
              <a
                className={styles.jiraLink}
                href={task.externalUrl ?? undefined}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                title={
                  jiraUnread
                    ? `${task.externalKey} — new comments on the ticket`
                    : (task.externalKey ?? undefined)
                }
              >
                <span
                  className={mergeClasses(styles.jiraBadge, jiraUnread && styles.jiraBadgeUnread)}
                >
                  {/* `currentColor` when tinted, so the mark flips to near-black with the
                      badge's text instead of sitting brand-blue on orange. */}
                  <JiraMark size={12} color={jiraUnread ? 'currentColor' : undefined} />
                  {task.externalKey}
                </span>
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

      {subtasks.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <span>Steps</span>
            <span className={styles.grow} />
            <span>
              {progress.done}/{progress.total}
            </span>
          </div>
          {subtasks.map((step) => {
            const stepRun = runPhase(step, [], liveRunTaskIds);
            const stepWants = attentionTaskIds?.has(step.id) ?? false;
            return (
              <div
                key={step.id}
                className={mergeClasses(
                  styles.step,
                  stepWants && styles.stepLoud,
                  step.id === selectedTaskId && styles.stepSelected,
                )}
                title={`${step.title} · ${stepRun.label || STATUS_LABEL[step.status]}`}
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
                  {stepRun.spinner ? (
                    <Spinner size="extra-tiny" />
                  ) : (
                    <span
                      className={styles.stepDot}
                      style={{ backgroundColor: STATUS_INDICATOR_COLOR[step.status] }}
                    />
                  )}
                </span>
                <Caption1
                  className={mergeClasses(
                    styles.stepTitle,
                    step.status === 'done' && styles.stepDone,
                  )}
                >
                  {step.title}
                </Caption1>
              </div>
            );
          })}
        </div>
      )}

      {/* Merge requests, in the same row vocabulary as the steps. Pipeline and approval
          are now SEPARATE glyphs: one dot conflated "the build is green" with "a human
          said yes", which are the two different things you actually wait on. */}
      {mergeRequests.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <span>{mergeRequests.length === 1 ? 'Merge request' : 'Merge requests'}</span>
          </div>
          {mergeRequests.map((mr) => {
            const reason = mrAttentionReason(mr);
            const approval = mrApprovalState(mr);
            return (
              <a
                key={mr.id}
                href={mr.webUrl}
                target="_blank"
                rel="noreferrer"
                className={mergeClasses(
                  styles.step,
                  styles.mrRow,
                  reason !== null && styles.stepLoud,
                )}
                title={reason ?? `!${mr.iid} ${mr.title} · ${approvalSummary(mr)}`}
                onDragStart={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                // The shell's window-open handler sends target=_blank to the real browser;
                // stopPropagation keeps the click from also selecting the card behind it.
                onClick={(e) => e.stopPropagation()}
              >
                {/* One dot per pipeline STAGE, in pipeline order — the same reading the
                    detail pane gives, at the size a card row can afford. A single dot said
                    whether CI was green; these say how far it got and which part broke,
                    which is the question you have while an MR sits there. Names don't fit
                    on this row, so they live in the tooltip.

                    Falls back to the one overall dot when the stages are empty — that means
                    the jobs endpoint was permission-gated, NOT that a pipeline has no
                    stages, so inventing dots from the overall status would be a claim we
                    cannot make. */}
                {mr.pipelineStages.length > 0 ? (
                  <span
                    className={styles.stageDots}
                    title={mr.pipelineStages.map((s) => `${s.name}: ${s.status}`).join('\n')}
                  >
                    {mr.pipelineStages.map((stage) => (
                      <span
                        key={stage.name}
                        className={mergeClasses(
                          styles.stageDot,
                          stage.status === 'running' && styles.stageDotRunning,
                        )}
                        // The keyframes own the colour while running, so setting it here
                        // too would only be the value they immediately override.
                        style={
                          stage.status === 'running'
                            ? undefined
                            : { backgroundColor: PIPELINE_COLOR[stage.status] }
                        }
                      />
                    ))}
                  </span>
                ) : (
                  <span className={styles.stepSlot} title={`Pipeline: ${mr.pipelineStatus}`}>
                    <span
                      className={styles.stepDot}
                      style={{ backgroundColor: PIPELINE_COLOR[mr.pipelineStatus] }}
                    />
                  </span>
                )}
                {/* The MR's own name, clipped by `stepTitle`'s ellipsis — what it IS. The
                    source branch used to sit here, which answers where it lives instead.
                    `mrLabel` prefers the local rename when there is one; the tooltip always
                    carries the upstream title and the branch. */}
                <Caption1
                  className={styles.stepTitle}
                  title={`!${mr.iid} ${mr.title}\n${mr.sourceBranch} → ${mr.targetBranch}`}
                >
                  {`!${mr.iid} ${mrLabel(mr)}`}
                </Caption1>
                {mr.draft && <Caption1 className={styles.progress}>draft</Caption1>}
                {/* FILLED means a human approved it; the OUTLINE means nothing is blocking
                    the merge but nobody has actually looked — a project that requires zero
                    approvals. This row used to render `approvalsGiven >= approvalsRequired`,
                    which is `0 >= 0` there, so every green MR on a rule-less project wore a
                    solid green tick it had not earned. The verdict now comes from
                    `mrApprovalState`, the same one the pane's "ready to merge" badge reads. */}
                <span className={styles.approval} title={approvalSummary(mr)}>
                  {approval === 'approved' ? (
                    <CheckmarkCircleFilled style={{ color: FLUO.green }} aria-label="Approved" />
                  ) : approval === 'unopposed' ? (
                    <CheckmarkCircleRegular
                      style={{ color: FLUO.green }}
                      aria-label="Nothing blocking the merge — but no approval was required, and none was given"
                    />
                  ) : approval === 'changes-requested' ? (
                    <DismissCircleFilled
                      style={{ color: FLUO.red }}
                      aria-label="Changes requested"
                    />
                  ) : (
                    <PersonFilled
                      style={{ color: tokens.colorNeutralForeground4 }}
                      aria-label="Awaiting approval"
                    />
                  )}
                </span>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
