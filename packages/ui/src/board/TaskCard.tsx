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
  Button,
  Caption1,
  Text,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  BeakerRegular,
  BookmarkRegular,
  BranchRequestClosedFilled,
  BugRegular,
  CheckmarkCircleFilled,
  CheckmarkCircleRegular,
  ChevronDownRegular,
  ChevronRightRegular,
  CircleRegular,
  DismissCircleFilled,
  LinkRegular,
  MergeFilled,
  PlayCircleRegular,
  NoteRegular,
  PersonFilled,
  PersonRegular,
  PresenceBlockedRegular,
  RecordStopRegular,
  SparkleRegular,
  TaskListSquareLtrRegular,
} from '@fluentui/react-icons';
import type { Task } from '@tm/shared/model';
import {
  canStopWork,
  cardRunLabel,
  chainNeedsAttention,
  hasUnreadJira,
  isAgentAssigned,
  needsAgentInput,
  parkedStep,
  runPhase,
} from '@tm/shared/board';
import { priorityIndicatorShown } from '@tm/shared/priority';
import { statusNoteColor, type StatusKeyword } from '@tm/shared/statusKeywords';
import { DEFAULT_BOARD_DISPLAY, type BoardDisplaySettings } from '@tm/shared/settings';
import { AgentGlyph } from '../AgentGlyph';
import { STATUS_COLOR, STATUS_LABEL } from '../taskStatus';
import { columnForTask, splitEarlierSteps, statusForColumn, subtaskProgress } from './boardColumns';
import {
  CHAIN_LINK_MIME,
  TASK_ID_ATTR,
  dropEffectFor,
  isChainLinkDrag,
  type LinkDropState,
} from './chainDrag';
import {
  ACCENT,
  ATTENTION_TINT,
  FLUO,
  PIPELINE_COLOR,
  RING,
  STATUS_INDICATOR_COLOR,
} from '../theme';
import { JiraMark } from '../JiraMark';
import { PriorityGlyph } from '../PriorityGlyph';
import {
  mrAttentionReason,
  mrLabel,
  mrVerdict,
  verdictSummary,
  type MergeRequest,
  type MrVerdict,
} from '@tm/shared/mergeRequest';

/**
 * The delegation glyph, white so a card an agent owns reads at a glance. Sized to sit
 * with the card's type icon rather than tower over it.
 */
const AGENT_ICON_SIZE = '16px';

/**
 * The running band's geometry — see `runningBand` for what it draws.
 *
 * The band is a repeating gradient swept along its OWN axis rather than straight sideways.
 * CSS measures a gradient angle clockwise from "to top", so a θ gradient points along
 * `(sin θ, −cos θ)` in screen coordinates (y growing downwards) — which is where `DX`/`DY`
 * come from. One cycle travels exactly `PERIOD` along that axis, so the last frame is
 * identical to the first and the loop has no seam.
 *
 * `ANGLE` is that CSS angle, NOT the lean you see: the band tilts `ANGLE − 90` off vertical
 * and its travel runs the same `ANGLE − 90` below horizontal. Worth stating because the two
 * numbers are ten apart at 100 and twenty at 110, and reading `110` as "110° of lean" is
 * exactly the mistake this block exists to prevent.
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
// 20° of lean. At 10° the sweep was geometrically correct — travel perpendicular to the band,
// tilted by the same 10° — but read as plain sideways motion: the lean was too shallow to see,
// and an edge-to-edge band offers no ends to track its direction by. Doubling it is the one
// lever that changes what actually reaches the eye.
const RUN_BAND_ANGLE = 110;
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
 * the card's near-black fill, where 0.30 landed on a greyish teal.
 *
 * It used to be paired with a `runningText` rule that lifted every line of the card to pure
 * white so this number could be contrast-checked against something. That trade was the wrong
 * way round: the crest is over any given word for about 1.2s in every 5.2 (see the geometry
 * block above), and the white stayed on for the whole run — so a running card spent four
 * seconds out of five looking like an ordinary card whose title someone had bolded and
 * whitened for no reason. The board's text is #CCCCCC everywhere on purpose (see
 * `main.tsx`), and a card that quietly opts out of that is the more visible defect: it reads
 * as a styling bug on the board, where the dip reads as the sweep passing.
 *
 * So the text under the band is now left alone, and this number is the only lever left. At
 * 0.45 the crest takes the card's #CCCCCC from 11.3:1 down to 2.98:1 for the ~1.2s it is
 * overhead. If that ever reads as washing the title out rather than as light crossing it,
 * lower the peak — not the text: 0.28 puts #CCCCCC back over 4.5:1, at the cost of the fluo.
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
    // The link handle costs nothing at rest and appears when you reach for it. Written as
    // one combined selector rather than a `:hover` nesting a descendant rule, so there is
    // exactly one atomic class deciding the handle's opacity and no insertion-order race
    // with the base rule on the handle itself.
    '&:hover [data-chain-handle]': { opacity: 1, pointerEvents: 'auto' },
    // Brighter than the board it sits on: a card is the object, the column is the space
    // between objects, and the old darker fill had that backwards. That contrast is the
    // whole edge — there is no frame, because a frame was saying a second time what the
    // fill already said, and it fought the rings below for the same pixels.
    backgroundColor: tokens.colorNeutralBackground1,
    // The project notch is absolutely positioned against this box.
    position: 'relative',
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
   * The card's project, as a **notch in the top-left corner**.
   *
   * It was a stripe across the whole top edge, and full width was more ink than the fact
   * deserved: a board of thirty cards became thirty coloured rules, and the things actually
   * worth a colour — the step dots, the pipeline dots, the running band — had to compete
   * with them. A 12px corner is the same information at a sixth of the ink.
   *
   * Top-LEFT, and a triangle rather than a square: it reads as a corner fold on the card,
   * which is unmistakably a marker, where a square in the corner reads as something clipped.
   * `pointerEvents: none` so it never eats a click meant for the card, and the card's own
   * `overflow: hidden` + radius rounds its outer corner to match the frame.
   */
  projectNotch: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '12px',
    height: '12px',
    clipPath: 'polygon(0 0, 100% 0, 0 100%)',
    pointerEvents: 'none',
  },
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
  /**
   * The Steps caption, once it also folds the section away.
   *
   * The heading IS the control — there is no separate chevron button — so the whole row is a
   * `<button>` and the reset below is what stops it looking like one. Kept as a second class
   * composed onto `sectionHead` rather than a copy of it, so the two headings on a card (Steps
   * and Merge requests) cannot drift apart in weight, colour or inset.
   *
   * `width: 100%` because a button shrink-wraps its content: without it the target would stop
   * at the word "Steps" and the count at the far end — the part of the header your eye is
   * actually on when you decide to fold — would not be clickable.
   */
  sectionToggle: {
    background: 'none',
    border: 'none',
    width: '100%',
    fontFamily: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
    ':hover': { color: tokens.colorNeutralForeground2 },
  },
  /**
   * The chevron. Larger than the 10px caption it sits in — a glyph at caption size reads as a
   * speck rather than as an affordance — and `flexShrink: 0` so it survives a long count.
   */
  sectionChevron: { fontSize: '12px', display: 'flex', flexShrink: 0 },
  /**
   * The heading's inset once it is the last thing in the card. `sectionHead`'s 2px bottom is
   * the gap to the first STEP ROW, not a margin — with the rows folded away it left the
   * caption sitting on the card's bottom edge, which read as a card that had been cut off.
   */
  sectionHeadAlone: { paddingBottom: '8px' },
  // No row border: the section owns the one hairline, and a rule per row turned a card
  // with four steps into a ledger.
  step: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '5px 12px',
    // Transparent, so the row shows whatever the CARD is filled with — including the lift a
    // selected card gets (`cardSelected`). It used to name `colorNeutralBackground1`
    // explicitly, which was the same colour right up until selection changed it, and then
    // every step row stayed behind as an unlit band across the bottom of a lit card.
    backgroundColor: 'transparent',
  },
  /**
   * The "4 earlier steps" row. A step row that happens to be a button, so a reset is all this
   * class adds — the row's geometry and rhythm are the step rows' own, which is the point: it
   * stands in for the rows behind it and should read as one of them.
   */
  earlierRow: {
    background: 'none',
    border: 'none',
    width: '100%',
    fontFamily: 'inherit',
    textAlign: 'left',
    color: tokens.colorNeutralForeground4,
    ':hover': { color: tokens.colorNeutralForeground2 },
  },
  /**
   * A step row that is itself the selected task. Brighter than `cardSelected`, and it has to
   * be: selecting a step does NOT select its card, so this row is lit against an unlit card
   * — but a card selected a moment earlier sits at `…1Selected`, and a step matching that
   * exactly would vanish into it.
   */
  stepSelected: { backgroundColor: tokens.colorNeutralBackground1Hover },
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
   * **A dot that is live**, blinking between the spinner's two cyans — the same pair
   * `MergeRequests.stageDotRunning` and the agent glyph use, so "working" looks like one
   * thing whether you are reading the card or the pane.
   *
   * Worn by a pipeline STAGE and by a running STEP alike. The step row used to put a
   * `Spinner` in its dot slot instead, which made one card carry two unrelated shapes for
   * the same fact — a turning arc on the step and a blinking dot two rows below it on the
   * merge request. Sets nothing but the colour, so it composes over either dot size.
   */
  dotRunning: {
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
   * The Stop button on a working card: icon only, the height of the title line, and no
   * wider than its glyph. Subtle by default so it does not compete with the title — a card
   * has one loud thing at a time and that is the ring — and it comes up to full contrast on
   * hover, which is where a button that ends a run ought to look like one.
   */
  stopButton: {
    flexShrink: 0,
    minWidth: '20px',
    maxWidth: '20px',
    height: '20px',
    padding: 0,
    color: tokens.colorNeutralForeground3,
    ':hover': { color: tokens.colorNeutralForeground1 },
  },
  /**
   * **"Wants you" is a ring; "is selected" is a brighter card.**
   *
   * The ring is `box-shadow`, not `border`: a border is part of the box, so adding one
   * would reflow the card's own text by a pixel — a visible twitch every time a card
   * started shouting. A shadow costs no layout at all. 3px, because the orange is painted
   * OUTSIDE the card against a dark column, where a good half of its apparent weight is
   * lost to the contrast; at 2px it read as a hairline.
   *
   * Selection used to be a second, blue ring inside it, and that was two problems. Every
   * card on the board is a rectangle with an outline, so a *third* outline state had almost
   * nowhere left to be read; and both states wrote `boxShadow`, so they could not simply be
   * composed — Griffel lets the later class REPLACE the property, which would have deleted
   * the orange from the very card that was shouting. A whole extra `cardUnreadSelected`
   * class existed only to stack the two by hand.
   *
   * Lifting the fill instead separates the two channels completely: the ring says *this one
   * wants you*, the brightness says *this is the one you are reading*. They are now
   * different CSS properties, so they compose by themselves and the third class is gone.
   */
  cardUnread: { boxShadow: `0 0 0 ${RING.attention}px ${ACCENT.unread}` },
  /**
   * One step up the neutral ladder from the card's own fill. Deliberately slight: it has to
   * be unmistakable when you scan the column for the card the pane is showing, and invisible
   * as a *distraction* on the thirty cards around it.
   *
   * This is the whole card, not just the body — the step and merge-request rows are
   * transparent (see `step`) precisely so the lift runs to the card's edges rather than
   * stopping at a seam halfway down.
   */
  cardSelected: { backgroundColor: tokens.colorNeutralBackground1Selected },
  /**
   * **The link handle** — a dot on the card's right edge, which is where the arrows leave.
   *
   * Hidden until you hover the card or tab to it, so a board of forty cards is not a board
   * of forty dots. `pointerEvents: none` while hidden matters as much as the opacity does:
   * a transparent 10px target sitting on every card's right edge would quietly eat clicks
   * meant for the card underneath it, and "the card sometimes doesn't select" is a far
   * worse bug than a missing affordance.
   *
   * A real `<button>`, so it is reachable by keyboard and announces itself. Enter or Space
   * ARMS the link (the next card you pick becomes the successor) — a focusable control that
   * only worked with a mouse would be a trap rather than an affordance, and the armed path
   * reuses the drag's own states, so the two cannot disagree about what is a valid target.
   */
  linkHandle: {
    position: 'absolute',
    right: '3px',
    // Level with where the arrows themselves leave and land — the card's vertical middle.
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
    // The whole `border`, not `borderColor`: Griffel rejects the four-sided shorthand.
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
  /**
   * A card the drop would land on. An `outline`, not the `boxShadow` the attention ring
   * uses: Griffel would have the later class REPLACE `boxShadow`, so a card that both wants
   * you and is a valid target would lose its orange ring at exactly the wrong moment. Two
   * different properties compose by themselves.
   */
  linkValid: { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '2px' },
  /** Already joined — dashed and neutral, because nothing is wrong, it is simply already said. */
  linkExisting: {
    outline: `2px dashed ${tokens.colorNeutralStroke1}`,
    outlineOffset: '2px',
  },
  /** A step, or a loop. Dimmed, and the drop bounces — see `dropEffectFor`. */
  linkRefused: { opacity: 0.35 },
  agentIcon: { fontSize: AGENT_ICON_SIZE, flexShrink: 0, display: 'flex', color: '#ffffff' },
  dragging: { opacity: 0.5 },
  /**
   * `flex-start`, not `center`: a two-line title would otherwise push the type glyph and the
   * agent glyph down to its middle, so the same two icons sat at a different height on every
   * card and the column lost the vertical rhythm you scan it by. Pinned to the top, they line
   * up across the whole board however long the titles run — and everything else on the row
   * (the step counter, the run label, the status badge) lines up with the title's FIRST line,
   * which is the line they are about.
   *
   * It costs nothing on a one-line card: the glyph box is 18px and so is the title's
   * `lineHeight`, so top-aligned and centre-aligned are the same pixel there.
   */
  titleRow: { display: 'flex', alignItems: 'flex-start', gap: '8px' },
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
   * with very little cyan left in it. **The text underneath is not rewritten to pay for
   * that**: the band is what moves, so the band is what has to carry the change, and a card
   * whose title turns white for the whole run is a permanent mark bought for a transient
   * one. See `RUN_BAND_BELL` for the contrast the crest costs and which knob buys it back.
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
  // The same white the agent glyph wears — see `typeIcon` for why the type is no longer
  // one of the things the board spends colour on.
  icon: { fontSize: '18px', flexShrink: 0, display: 'flex', color: '#ffffff' },
  /**
   * The card's headline. Sets no `color`, deliberately: it takes
   * `colorNeutralForeground1` — the editor grey `main.tsx` picks over Fluent's white — and it
   * takes it on EVERY card, whatever the card is doing. There used to be a `runningText`
   * rule that lifted a running card's whole top section to #FFFFFF, and the result was a
   * board where some titles were white and bold and some were not, with nothing on screen
   * to say why for the four seconds in five the running band spends dark.
   *
   * Nothing here should ever say "this card is working": the band, the pulsing agent glyph,
   * the step counter and the run label all say it already, and all four stop when it stops.
   */
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
  /**
   * Where this card sits in its chain — "waiting on VIP-3", or "ready".
   *
   * **Monochrome, and that is the point.** Everything the board spends colour on is
   * something in MOTION: the cyan band of a live run, the orange ring of a card that wants
   * you, a red pipeline. A dependency is none of those — it is a standing fact about the
   * card that will read the same tomorrow — so it takes the same neutral treatment as the
   * sprint chip beside it and lets the moving things keep the eye.
   *
   * The icon carries the distinction the colour would otherwise have made: a chain link for
   * blocked, a play mark for released-but-not-started.
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
  /** The names inside the chip — the chip's border stays put however long they run. */
  chainChipText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  /**
   * The "+2" tail. Outside the truncating span and unshrinkable on purpose: it is the only
   * part of the chip that says the card waits on MORE than the one card it names, so it is
   * the last thing that may be ellipsised away. Inside `chainChipText` a long first title
   * ate it, and the chip then read as a single dependency — the exact lie the tooltip
   * below exists to prevent.
   */
  chainChipMore: { flexShrink: 0, whiteSpace: 'nowrap' },
  chainChipIcon: { fontSize: '12px', flexShrink: 0, display: 'flex' },
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
});

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
 *
 * **Outline, and uncoloured.** These used to be solid and each in its own hue — a red bug,
 * a green story, a violet epic — which meant every card on the board opened with a saturated
 * shape whatever was happening to it. A card's type is the least urgent thing about it: it
 * never changes, and it is the same on the forty cards beside it. Colour is spent instead on
 * the things that MOVE — the step dots, the pipeline dots, the running band — and the type
 * reads as the same quiet white the agent glyph does. The colour is inherited from the
 * wrapping span, so the pane and the card cannot drift apart.
 */
export function typeIcon(task: Task): JSX.Element {
  if (task.externalSource !== 'jira') {
    if (task.type === 'bug') return <BugRegular />;
    if (task.type === 'feature') return <BeakerRegular />;
    return <NoteRegular />;
  }
  const t = (task.externalType ?? '').toLowerCase();
  if (t.includes('bug')) return <BugRegular />;
  if (t.includes('story')) return <BookmarkRegular />;
  if (t.includes('epic')) return <SparkleRegular />;
  if (t.includes('feature') || t.includes('improvement')) return <BeakerRegular />;
  if (t.includes('sub')) return <PersonRegular />;
  if (t.includes('task')) return <TaskListSquareLtrRegular />;
  return <CircleRegular />;
}

/**
 * The glyph at the end of a merge-request row — the MR's **verdict**.
 *
 * The first two are outcomes and the rest are review states, which is why they share a slot:
 * once an MR has landed, "who approved it" is a question about a queue nobody is standing in
 * any more. A merged MR used to keep wearing its approval tick right up until the next sync
 * deleted the row out from under it; now it says `merged` and stays.
 *
 * FILLED green means a human approved it; the OUTLINE means nothing is blocking the merge but
 * nobody has actually looked — a project that requires zero approvals. The verdict comes from
 * `mrVerdict`, the same one the pane's badge reads.
 *
 * `blocked` is the newest and the one that had been missing: GitLab refusing the merge
 * outright — conflicts, a branch needing a rebase, another MR in the way. An approved MR in
 * that state used to wear the green tick, which is true about the review and badly
 * misleading about the merge.
 */
export function verdictIcon(verdict: MrVerdict): JSX.Element {
  switch (verdict) {
    case 'merged':
      return <MergeFilled style={{ color: FLUO.violet }} aria-label="Merged" />;
    case 'blocked':
      return <PresenceBlockedRegular style={{ color: FLUO.red }} aria-label="Cannot be merged" />;
    case 'closed':
      return (
        <BranchRequestClosedFilled
          style={{ color: tokens.colorNeutralForeground4 }}
          aria-label="Closed without merging"
        />
      );
    case 'approved':
      return <CheckmarkCircleFilled style={{ color: FLUO.green }} aria-label="Approved" />;
    case 'unopposed':
      return (
        <CheckmarkCircleRegular
          style={{ color: FLUO.green }}
          aria-label="Nothing blocking the merge — but no approval was required, and none was given"
        />
      );
    case 'changes-requested':
      return <DismissCircleFilled style={{ color: FLUO.red }} aria-label="Changes requested" />;
    case 'awaiting':
      return (
        <PersonFilled
          style={{ color: tokens.colorNeutralForeground4 }}
          aria-label="Awaiting approval"
        />
      );
  }
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
   * Whether the Steps section is folded away — the rows hidden, the heading and its counter
   * kept. A card carrying a nine-step plan is most of a column on its own, and the steps are
   * detail you have usually already read; the counter in the title row is what the fold
   * leaves you with, and it is the part you actually scan for.
   *
   * Nothing here ever unfolds a card by itself, not even for a step that is running or one
   * that has parked the chain: the card still rings, still counts and still says what it is
   * doing, and a section that reopened on its own would be the app overruling a decision the
   * human made about their own board.
   */
  stepsFolded?: boolean;
  /**
   * Fold or unfold this card's steps. **Absent means the section does not fold** — the
   * heading stays a plain caption, which is what the web board (`@tm/ui` has no store of its
   * own) still gets.
   */
  onToggleSteps?: () => void;
  /**
   * Whether the steps from **earlier planning rounds** are on screen. Default false, and that
   * default is the feature: a card that has just been re-planned shows the bunch it was just
   * given, with everything before it behind one quiet row.
   */
  earlierStepsShown?: boolean;
  /**
   * Show or hide those earlier rounds. **Absent means the card never hides them** — the whole
   * chain renders, exactly as it did before there were rounds, which is what the web board
   * (no store of its own to remember the answer) still gets.
   */
  onToggleEarlierSteps?: () => void;
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
  /**
   * The task ids whose branch is being merged, so the card says "Merging branch…" for the
   * minute git takes. Nothing about the task itself moves in that window, so without this
   * a card that had just been sent to merge looked identical to one nobody had touched.
   */
  mergingTaskIds?: ReadonlySet<string>;
  /** Which optional context lines to draw. Defaults to the shipped defaults. */
  display?: BoardDisplaySettings;
  selected: boolean;
  /** Id of the selected task, so a selected *step* row can highlight itself. */
  selectedTaskId?: string | null;
  /**
   * The chain overlay's tap on this card's root element — it measures where the card is so
   * the arrows in and out of it land on its edges. A callback ref rather than a forwarded
   * `ref` because the overlay keeps one per task id and needs the *unmount* call too; see
   * `useCardAnchors`. Absent everywhere the board is not drawing a chain.
   */
  anchorRef?: (el: HTMLDivElement | null) => void;
  /**
   * What this card would do with the link currently being drawn, or undefined when no link
   * gesture is in the air. Computed once per gesture for the whole board (`linkDropStates`)
   * rather than per card per `dragover`.
   */
  linkState?: LinkDropState;
  /**
   * Called when a link drag starts from this card's handle — the card has already put its
   * own id on the `DataTransfer`; this is only so the board can light the targets up.
   * Absent on a board that is not drawing chains, which is also what hides the handle.
   */
  onLinkStart?: () => void;
  /** The drag ended, however it ended — dropped, escaped, or dropped on nothing. */
  onLinkEnd?: () => void;
  /** A link was dropped ON this card: `fromTaskId` runs first, this card runs after. */
  onLinkTo?: (fromTaskId: string) => void;
  /** Enter/Space on the handle — arm a link from this card, for anyone not using a mouse. */
  onLinkArm?: () => void;
  /**
   * The predecessors this card is still waiting on (`blockedBy`), for its chip.
   *
   * The cards themselves rather than a count, because "waiting on VIP-3" sends you
   * somewhere and "waiting on 1 card" sends you hunting for the arrow. Empty or absent for
   * every card nobody has chained, which is most of them.
   */
  waitingOn?: readonly Task[];
  /**
   * The subset of {@link waitingOn} that is waiting on nothing but a **human** pressing
   * Merge (`awaitingMerge`), so the chip can say so.
   *
   * Worth the extra word: "waiting on VIP-3" reads identically whether VIP-3 has not been
   * started or finished days ago and is sitting in review, and only one of those is
   * something the person reading the card can act on.
   */
  mergeHeld?: readonly Task[];
  /**
   * Every predecessor has finished and nothing has started yet — the window between the
   * chain opening and the card actually moving. Worth saying out loud because it is exactly
   * when a card looks abandoned: it sits in To Do like any other, and the only thing that
   * distinguishes it is that its turn has come.
   */
  chainReady?: boolean;
  /**
   * Stop the agent working this card — absent on a board that does not offer it, which is
   * also what hides the button.
   *
   * On the CARD and not only in the detail pane, because the card is where you watch the
   * agent work: the pane's Stop was the only one there was, so stopping meant selecting the
   * card first and finding a button in a panel — and for a card executing a plan there was
   * no button at all (see `canStopWork`). One click, from the place you noticed.
   */
  onStop?: () => void;
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
  stepsFolded = false,
  onToggleSteps,
  earlierStepsShown = false,
  onToggleEarlierSteps,
  mergeRequests = [],
  statusKeywords,
  attentionTaskIds,
  liveRunTaskIds,
  mergingTaskIds,
  display = DEFAULT_BOARD_DISPLAY,
  selected,
  selectedTaskId,
  anchorRef,
  linkState,
  onLinkStart,
  onLinkEnd,
  waitingOn = [],
  mergeHeld = [],
  chainReady = false,
  onLinkTo,
  onLinkArm,
  onStop,
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
  /**
   * Whether the priority indicator will draw anything — asked here so the footer row is not
   * created for a mark that turns out to be nothing. The same predicate `PriorityGlyph`
   * itself asks, which is what keeps the row and its contents in step.
   */
  const showsPriority = priorityIndicatorShown(display.priorityDisplay, task.externalPriority);
  /**
   * Where this card stands in its chain, as one chip — or null, which is the answer for
   * every card nobody has drawn an arrow to.
   *
   * Waiting beats ready, because they cannot both be true and the blocked case is the one
   * that explains why nothing is happening. The chip NAMES what it waits on; the tooltip
   * spells the list out when there is more than one, since a diamond waits for all of them
   * (`readyToRelease` is an AND-join) and a chip that showed only the first would be lying
   * about how much is left.
   *
   * **`to merge`** is appended when the card it names has finished writing and is only
   * waiting to be merged — one word, still monochrome, still the same link icon. That is
   * the whole point of the treatment above: a dependency is a standing fact, and "not
   * merged yet" is exactly that, however much you would like it pressed.
   */
  const waitingNames = waitingOn.map((t) => t.externalKey || t.title);
  // Only about the card the chip actually NAMES, so its noun and its verb agree; the
  // tooltip is what covers the rest of a diamond.
  const namedIsMergeHeld = waitingOn.length > 0 && mergeHeld.some((t) => t.id === waitingOn[0].id);
  const chainChip = waitingOn.length ? (
    <span
      className={styles.chainChip}
      title={
        waitingOn.length > 1
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
    </span>
  ) : chainReady ? (
    <span
      className={styles.chainChip}
      title="Everything this card waits for has finished — it can start."
    >
      <PlayCircleRegular className={styles.chainChipIcon} />
      <span className={styles.chainChipText}>ready</span>
    </span>
  ) : null;
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
  const run = runPhase(task, subtasks, liveRunTaskIds, mergingTaskIds);
  // What is worth saying in WORDS, once the pulsing glyph and the step counter have had their
  // say. Null while the agent is visibly working.
  const cardLabel = cardRunLabel(run, isAgentAssigned(task));
  /**
   * Whether this card has agent work a click could stop — the same predicate the detail
   * pane asks, so the card and the pane can never disagree about whether there is anything
   * to stop. A merge is deliberately not one of them: `stopTask` kills sessions, and git is
   * not a session — offering a Stop over a rebase would promise something it cannot do.
   */
  const stoppable = Boolean(onStop) && canStopWork(task, subtasks, liveRunTaskIds);
  /** Whether that click reaches into the card's PLAN — one Stop covers the whole chain. */
  const stopsChain = subtasks.some(
    (s) => s.status === 'running' || s.status === 'waiting-input' || s.status === 'pending',
  );
  // Only the ticket badge carries the JIRA signal, so the ring's reason is legible.
  const jiraUnread = hasUnreadJira(task);
  /**
   * Whether the Steps heading is a control — and, therefore, whether `stepsFolded` counts.
   *
   * A fold with no way back would be a section that had simply disappeared, so a card handed
   * the flag but no handler (there is no such caller today; there could be tomorrow) draws its
   * steps rather than hiding them behind a chevron that does nothing.
   */
  const stepsFoldable = Boolean(onToggleSteps);
  const stepsHidden = stepsFoldable && stepsFolded;
  /**
   * The card's steps, cut at the newest planning round — and then the rows actually drawn.
   *
   * The **automatic** half of the fold: re-planning a card files its new steps under a round
   * of their own, and everything before that round drops behind one row saying how much of it
   * there is. It is a fold nobody had to press, because the moment new steps arrive is exactly
   * the moment the old ones stop being what you are looking at. A step typed by hand joins the
   * round in progress (`store.addSubtask`), so writing one never folds the bunch you wrote it
   * into.
   *
   * Gated on the handler for the same reason the section fold is: a board with nowhere to
   * remember the answer draws the whole chain rather than hiding half of it behind a control
   * that cannot remember being pressed.
   */
  const { earlier, latest } = splitEarlierSteps(subtasks);
  const earlierFoldable = Boolean(onToggleEarlierSteps) && earlier.length > 0;
  const earlierHidden = earlierFoldable && !earlierStepsShown;
  const stepRows = earlierHidden ? latest : [...earlier, ...latest];
  const earlierDone = earlier.filter((s) => s.step.status === 'done').length;
  /**
   * What the folded row has to say on behalf of the rows behind it.
   *
   * A fold may hide detail; it may not hide a signal. Steps run in chain order, so an earlier
   * round's unfinished step runs BEFORE the newest bunch — the row that is folded away can be
   * the very one that is working, or the one that has parked the chain and is waiting for an
   * answer. So the summary row takes the blinking dot and the attention tint itself, and
   * opening it is one click from either.
   */
  const earlierRunning = earlier.some(
    ({ step }) => runPhase(step, [], liveRunTaskIds, mergingTaskIds).spinner,
  );
  const earlierWants = earlier.some(({ step }) => attentionTaskIds?.has(step.id) ?? false);

  return (
    <div
      ref={anchorRef}
      // How a drag event names the card it happened over — see `taskIdUnder`.
      {...{ [TASK_ID_ATTR]: task.id }}
      className={mergeClasses(
        styles.card,
        // Composed, not chosen between: the ring and the fill are different properties now,
        // so a card that both wants you and is selected simply gets both.
        wantsAttention && styles.cardUnread,
        selected && styles.cardSelected,
        dragging && styles.dragging,
        linkState === 'valid' && styles.linkValid,
        linkState === 'linked' && styles.linkExisting,
        linkState === 'refused' && styles.linkRefused,
      )}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      // A link being drawn, not a card being moved. Two gestures share one mechanism and
      // are told apart by the `DataTransfer`'s TYPE — a card drag falls straight through
      // to the column, which is the only thing that should ever act on it.
      onDragOver={(e) => {
        if (!isChainLinkDrag(e.dataTransfer.types)) return;
        e.preventDefault();
        // `'none'` on an invalid target cancels the drop in the browser itself, so the
        // refusal is in the cursor before you let go. No `stopPropagation`: the board
        // above still needs this event to move the rubber band's loose end.
        e.dataTransfer.dropEffect = dropEffectFor(linkState);
      }}
      onDrop={(e) => {
        if (!isChainLinkDrag(e.dataTransfer.types)) return;
        e.preventDefault();
        // Consumed here — the column below must not also read it as a card being moved.
        e.stopPropagation();
        const fromTaskId = e.dataTransfer.getData(CHAIN_LINK_MIME);
        if (fromTaskId) onLinkTo?.(fromTaskId);
      }}
      onClick={onSelect}
    >
      {projectColor && (
        <div className={styles.projectNotch} style={{ backgroundColor: projectColor }} />
      )}
      {onLinkStart && (
        <button
          type="button"
          // What the card's `:hover` rule reaches for. A data attribute rather than the
          // generated class name, which Griffel does not let a sibling rule name.
          data-chain-handle=""
          className={mergeClasses(
            styles.linkHandle,
            linkState === 'source' && styles.linkHandleActive,
          )}
          // The source card's handle has to stay put for the whole gesture, and an inline
          // style is the one thing that outranks the card's hover rule either way.
          style={linkState === 'source' ? { opacity: 1, pointerEvents: 'auto' } : undefined}
          draggable
          aria-label={`Chain from ${task.title} — drag onto another card to run that card after this one`}
          title="Drag onto another card to run that card after this one"
          onDragStart={(e) => {
            // The card's own `onDragStart` is an ancestor handler and would otherwise ALSO
            // fire, putting this id on `text/plain` and turning the gesture into a move.
            e.stopPropagation();
            e.dataTransfer.setData(CHAIN_LINK_MIME, task.id);
            e.dataTransfer.effectAllowed = 'link';
            onLinkStart();
          }}
          onDragEnd={(e) => {
            e.stopPropagation();
            onLinkEnd?.();
          }}
          // A button's Enter and Space arrive here as a click, so the keyboard path costs
          // no handler of its own.
          onClick={(e) => {
            e.stopPropagation();
            onLinkArm?.();
          }}
        />
      )}
      <div className={mergeClasses(styles.body, run.spinner && styles.runningBand)}>
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
            <Caption1 className={styles.runLabel} title={cardLabel}>
              {cardLabel}
            </Caption1>
          )}
          {/* A running card's badge would only repeat what the label just said. */}
          {badge && !run.spinner && (
            <Badge appearance="tint" color={STATUS_COLOR[badge]}>
              {STATUS_LABEL[badge]}
            </Badge>
          )}
          {/* Stop, on the card that is working — the click the board had nowhere to put.
              Drawn only while there IS something to stop, so it is not one more control
              every card carries; on the few cards that have one it is always visible
              rather than hidden behind a hover, since a button you cannot find is the
              complaint this exists to answer. */}
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
                className={styles.stopButton}
                size="small"
                appearance="subtle"
                icon={<RecordStopRegular />}
                // The card is a drop target and a click target; this button is neither.
                // Without this the click selects the card as well, and dragging from it
                // would try to move the card it is stopping.
                draggable={false}
                onDragStart={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onStop?.();
                }}
              />
            </Tooltip>
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
            className={styles.statusNote}
            // A note with a status colour keeps it: the inline style outranks the class, and
            // that colour is the note's meaning rather than its styling.
            style={noteColor ? { color: noteColor } : undefined}
            title={task.statusNote}
          >
            {task.statusNote}
          </Caption1>
        )}

        {display.showProjectName && projectName && (
          <Caption1 className={styles.project}>Project: {projectName}</Caption1>
        )}

        {/* The name when the sync has it, the key until then — a key is still an answer
            to "which epic", where an empty line looks like the toggle is broken. */}
        {display.showEpicName && (task.externalEpicName || task.externalParentKey) && (
          <Caption1
            className={styles.project}
            title={`Epic: ${task.externalEpicName ?? task.externalParentKey}`}
          >
            Epic: {task.externalEpicName ?? task.externalParentKey}
          </Caption1>
        )}

        {(isJira || showsPriority || chainChip !== null) && (
          <div className={styles.footer}>
            {/* First in the row, ahead of the ticket badge: it is the reason this card is
                not moving, and that outranks where it came from. */}
            {chainChip}
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
            {/* Square, chevron or nothing — whichever this board is set to. */}
            <PriorityGlyph
              mode={display.priorityDisplay}
              priority={task.externalPriority}
              size={18}
            />
          </div>
        )}
      </div>

      {subtasks.length > 0 && (
        <div className={styles.section}>
          {/* The heading, which is also the fold — see `sectionToggle`. It keeps the counter
              whichever way it is pointing: the whole bargain of a fold is that the header
              still tells you what is behind it, and `2/9` is exactly that. Rendered as a
              plain caption where nothing can fold it, so a board without somewhere to save
              the fold (the web one) is unchanged rather than wearing a dead chevron. */}
          {stepsFoldable ? (
            <button
              type="button"
              className={mergeClasses(
                styles.sectionHead,
                styles.sectionToggle,
                stepsHidden && styles.sectionHeadAlone,
              )}
              aria-expanded={!stepsHidden}
              title={
                stepsHidden
                  ? `Show this card's steps (${progress.done}/${progress.total} done)`
                  : 'Fold the steps away — the card keeps its counter'
              }
              // The card is a drag source and a click target; its heading is neither. Without
              // this, folding also selects the card, and a drag begun on the heading would
              // move a card you were only trying to tidy.
              draggable={false}
              onDragStart={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
                onToggleSteps?.();
              }}
            >
              <span className={styles.sectionChevron}>
                {stepsHidden ? <ChevronRightRegular /> : <ChevronDownRegular />}
              </span>
              <span>Steps</span>
              <span className={styles.grow} />
              <span>
                {progress.done}/{progress.total}
              </span>
            </button>
          ) : (
            <div className={styles.sectionHead}>
              <span>Steps</span>
              <span className={styles.grow} />
              <span>
                {progress.done}/{progress.total}
              </span>
            </div>
          )}
          {/* The rounds before the newest, as one row. It reads as a step row on purpose —
              same slot, same rhythm — because that is what is behind it, and it carries its
              own `4/4` so a folded round still says whether it finished. Drawn above the
              rows, which is where those steps actually are in the chain. */}
          {!stepsHidden && earlierFoldable && (
            <button
              type="button"
              className={mergeClasses(
                styles.step,
                styles.earlierRow,
                earlierHidden && earlierWants && styles.stepLoud,
              )}
              aria-expanded={!earlierHidden}
              title={
                !earlierHidden
                  ? 'Fold the earlier rounds away again'
                  : earlierWants
                    ? `One of the ${earlier.length} steps planned before this round needs you`
                    : earlierRunning
                      ? `One of the ${earlier.length} steps planned before this round is running`
                      : `Show the ${earlier.length} steps planned before this round`
              }
              draggable={false}
              onDragStart={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
                onToggleEarlierSteps?.();
              }}
            >
              <span className={styles.stepSlot}>
                {earlierHidden ? <ChevronRightRegular /> : <ChevronDownRegular />}
              </span>
              <Caption1 className={styles.stepTitle}>
                {earlier.length} earlier step{earlier.length === 1 ? '' : 's'}
              </Caption1>
              {/* The same blinking dot a running step row wears, because that is exactly what
                  is behind this row when it blinks — the chain runs in order, so an unfinished
                  earlier step runs before the newest bunch does. */}
              {earlierHidden && earlierRunning && (
                <span className={mergeClasses(styles.stepDot, styles.dotRunning)} />
              )}
              <Caption1 className={styles.progress}>
                {earlierDone}/{earlier.length}
              </Caption1>
            </button>
          )}
          {!stepsHidden &&
            stepRows.map(({ step }) => {
              const stepRun = runPhase(step, [], liveRunTaskIds, mergingTaskIds);
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
                  {/* One dot, whatever the step is doing — it just blinks while the step is
                    live. The slot keeps its fixed width so every row's title starts at the
                    same x. This used to be a spinner, which meant a card said "working" with
                    a turning arc here and with a blinking dot on the merge-request rows
                    below: two shapes for one fact, on one card. */}
                  <span className={styles.stepSlot}>
                    <span
                      className={mergeClasses(styles.stepDot, stepRun.spinner && styles.dotRunning)}
                      // The keyframes own the colour while it blinks, so setting it here too
                      // would only be the value they immediately override.
                      style={
                        stepRun.spinner
                          ? undefined
                          : { backgroundColor: STATUS_INDICATOR_COLOR[step.status] }
                      }
                    />
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
            const verdict = mrVerdict(mr);
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
                title={reason ?? `!${mr.iid} ${mr.title} · ${verdictSummary(mr)}`}
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
                          stage.status === 'running' && styles.dotRunning,
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
                {/* The row's verdict — see `verdictIcon`. */}
                <span className={styles.approval} title={verdictSummary(mr)}>
                  {verdictIcon(verdict)}
                </span>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
