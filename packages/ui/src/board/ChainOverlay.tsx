/**
 * The chain of execution, drawn over the board — one arrow per link, "this card runs after
 * that one".
 *
 * ONE `<svg>` for the whole board rather than a line per pair of cards, absolutely
 * positioned inside `MyTasks.columns`. That container is the single scrolling element, so
 * the layer shares the cards' coordinate space and simply scrolls with them; a per-column
 * overlay would have to be stitched back together at every seam, and per-card lines would
 * be clipped by their own column. `useCardAnchors` supplies the geometry, `chainArrows`
 * the routing and the states; this file only decides what each state looks like.
 *
 * **The ink budget.** An arrow is furniture until you ask about it, so at rest it is a
 * 1px neutral hairline and nothing else. Everything louder is earned by something MOVING:
 *
 *   - **lit** — you selected or hovered one of its cards. 2px in the accent, along the
 *     whole route upstream and downstream of that card, so one glance answers "what does
 *     this wait for, and what waits on it" rather than just naming the next card along.
 *     A board FOCUSED on one chain (`focusTaskIds`) is lit throughout: the budget the
 *     hairline was kept to is a budget against noise, and focus removed the noise.
 *   - **blocked** — the target is still waiting on this predecessor. Dashed, which is the
 *     one thing a line can say without a colour.
 *   - **releasing** — and the predecessor is running right now, so the dash travels toward
 *     the target. Cyan, because cyan is already what this app means by "moving": the
 *     card's running band, the step dots, every spinner.
 *   - **stacked** — the loose gate, drawn as a DOUBLE hairline. Two gates need telling
 *     apart, and spending a second colour on a fact that never changes would break the
 *     budget the rest of the board is kept to.
 *
 *   - **selected** — you clicked it. Thicker again, with a dot at each end so there is no
 *     doubt which two cards it joins, and wearing the gate popover. The one state you put
 *     it in yourself, so it outranks lit.
 *
 * The layer takes no pointer events; each path takes them on its STROKE, so an arrow can be
 * hovered and clicked without the layer eating a single click meant for a card — and the
 * whole layer goes inert while a link is being DRAGGED, because then the cards underneath
 * are the targets and an arrow lying across one must not intercept the drop (see `inert`).
 */
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { Task } from '@tm/shared/model';
import type { TaskLink } from '@tm/shared/taskChain';
import { FLUO } from '../theme';
import {
  CHIP_SIZE,
  buildChainDrawing,
  rubberBandPath,
  type AnchorRect,
  type ChainArrow,
} from './chainArrows';
import type { LinkDragState } from './chainDrag';

/** Marker ids. One overlay per board, but namespaced so they cannot collide with anything. */
const MARKER = {
  rest: 'chain-head-rest',
  lit: 'chain-head-lit',
  live: 'chain-head-live',
} as const;

/**
 * How far apart the two strokes of a `stacked` link sit, in px.
 *
 * The pair is the SAME curve translated vertically, not two offset curves — a translation
 * cannot make them cross however tight the bend gets, and the arrow leaves and enters
 * horizontally, so vertical is exactly perpendicular at both ends where it shows most.
 */
const DOUBLE_GAP = 1.5;

const useStyles = makeStyles({
  /**
   * `pointerEvents: none` on the layer, `overflow: visible` so a stub clamped against the
   * frame is never quietly cut in half. No z-index: the sticky column headers carry one,
   * so an arrow slides under them on scroll instead of over the labels.
   */
  layer: {
    position: 'absolute',
    top: 0,
    left: 0,
    pointerEvents: 'none',
    overflow: 'visible',
  },
  /** `pointerEvents: 'stroke'` — the arrow itself is hit-testable, the box around it is not. */
  path: {
    fill: 'none',
    strokeLinecap: 'round',
    pointerEvents: 'stroke',
  },
  resting: { stroke: tokens.colorNeutralStroke2, strokeWidth: '1px' },
  lit: { stroke: tokens.colorBrandStroke1, strokeWidth: '2px' },
  /** Waiting. The dash is the whole signal — no colour is spent on standing still. */
  blocked: { strokeDasharray: '4 4' },
  /**
   * Waiting on something that is running. The dash walks toward the target: a decreasing
   * `strokeDashoffset` moves the pattern ALONG the path, and the path is drawn source-first.
   *
   * Linear and endless like the card's running band, with the same reduced-motion contract —
   * the state has to survive the motion being switched off, so it falls back to the plain
   * dash rather than to nothing.
   */
  releasing: {
    stroke: FLUO.cyan,
    strokeDasharray: '6 6',
    animationName: { from: { strokeDashoffset: 12 }, to: { strokeDashoffset: 0 } },
    animationDuration: '0.6s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },
  /**
   * The arrow you have SELECTED — thicker again than lit, plus a dot at each end.
   *
   * The dots are not decoration. Three arrows can leave one card's edge within a few
   * pixels of each other, and a heavier stroke alone leaves "which two cards is this one
   * actually joining" unanswered — which is the first thing you want to know before
   * pressing Delete on it.
   */
  selected: { stroke: tokens.colorBrandStroke1, strokeWidth: '3px' },
  endpoint: { fill: tokens.colorBrandStroke1, stroke: 'none' },
  /**
   * An invisible stroke under each arrow, purely to be clicked.
   *
   * A 1px hairline is an unhittable target — you would be aiming at a line thinner than
   * the pointer's own tip. This one is 14px wide and completely transparent, so the arrow
   * looks exactly as thin as it should and behaves as if it were a band.
   */
  hit: {
    fill: 'none',
    stroke: 'transparent',
    strokeWidth: '14px',
    pointerEvents: 'stroke',
    cursor: 'pointer',
  },
  /**
   * The rubber band, from the handle to the pointer.
   *
   * Dashed and brand-coloured while the drop would land, neutral and dimmed while it would
   * not — so the line itself carries the same verdict the target card's outline does. It
   * takes no pointer events at all: it is under the cursor for the whole gesture, and a
   * shape that hit-tests there would steal every `dragover` from the card beneath it.
   */
  band: {
    fill: 'none',
    strokeWidth: '2px',
    strokeDasharray: '5 4',
    strokeLinecap: 'round',
    pointerEvents: 'none',
  },
  bandValid: { stroke: tokens.colorBrandStroke1 },
  bandRefused: { stroke: tokens.colorNeutralStroke1 },
  /**
   * Every stroke on this layer, made inert for the duration of a link drag.
   *
   * The layer sits OVER the cards, and its paths take pointer events on their stroke so an
   * arrow can be hovered and clicked. During a drag that is exactly wrong: an arrow that
   * happens to cross a card would swallow the `dragover` meant for the card beneath it, so
   * the card would neither light up nor accept the drop — and the arrows a chain already
   * has are precisely the ones lying across the cards you are about to chain to.
   *
   * Declared AFTER `path` and `hit`, so Griffel inserts it later and its `pointerEvents`
   * wins over theirs — the same ordering `releasing` relies on above.
   */
  inert: { pointerEvents: 'none' },
  headRest: { fill: tokens.colorNeutralStroke2 },
  headLit: { fill: tokens.colorBrandStroke1 },
  headLive: { fill: FLUO.cyan },
  /** The dangling-end count: quiet, because it is a fact about the FILTER, not about work. */
  chipBox: {
    fill: tokens.colorNeutralBackground3,
    stroke: tokens.colorNeutralStroke2,
    strokeWidth: '1px',
  },
  chipText: {
    fill: tokens.colorNeutralForeground3,
    fontSize: '10px',
    fontWeight: 600,
    // The chip is a label on a line, not a target: never let a drag select its digits.
    userSelect: 'none',
  },
});

/** The arrowhead, drawn once per colour — SVG markers do not inherit their path's stroke. */
function Head({ id, className }: { id: string; className: string }): JSX.Element {
  return (
    <marker
      id={id}
      viewBox="0 0 8 8"
      // The tip sits exactly on the path's last point, which is the card's own edge.
      refX="8"
      refY="4"
      markerWidth="8"
      markerHeight="8"
      orient="auto"
      // Fixed size: a lit arrow is twice as thick, and a head that doubled with it would
      // read as a different arrow rather than the same one lit.
      markerUnits="userSpaceOnUse"
    >
      <path d="M 0 0 L 8 4 L 0 8 z" className={className} />
    </marker>
  );
}

export interface ChainOverlayProps {
  links: readonly TaskLink[];
  /** Where each card is, in the scroll container's content space. */
  anchors: ReadonlyMap<string, AnchorRect>;
  /** Every task on the board — the gates read the predecessor's own state. */
  tasksById: ReadonlyMap<string, Task>;
  /** The engine's live runs, so an arrow says "releasing" as soon as the session spawns. */
  runningTaskIds?: ReadonlySet<string>;
  selectedTaskId?: string | null;
  hoveredTaskId?: string | null;
  /**
   * The chain the board has been FOCUSED on, when it has (`MyTasks.focusIds`) — every card
   * it is showing, so every arrow among them is lit rather than resting.
   *
   * The hairline is a budget kept against a board full of cards that have nothing to do with
   * this chain. In focus mode there are none: the noise the arrows were quiet for is gone,
   * and what is left is the one thing you asked to look at.
   */
  focusTaskIds?: ReadonlySet<string> | null;
  /** The arrow being edited — drawn heavier, with its two ends marked. */
  selectedLinkId?: string | null;
  /** Click an arrow to select it; click its own stroke again is still just a select. */
  onSelectLink?: (linkId: string) => void;
  /** The link currently being drawn, for the rubber band. */
  linkDrag?: LinkDragState | null;
  width: number;
  height: number;
}

export function ChainOverlay(props: ChainOverlayProps): JSX.Element | null {
  const styles = useStyles();
  // The band is drawn even with no links at all — the first link on a board has to be
  // draggable, and that is precisely the board where `links` is empty.
  const band = bandFor(props);
  if ((props.links.length === 0 && !band) || props.width === 0) return null;

  // Seeded with the focused chain, so a focused board's arrows are lit throughout: every
  // card on it is on the route, and `litLinkIds` reaching up and down from all of them
  // lights exactly the arrows between them.
  const litTaskIds = new Set<string>(props.focusTaskIds ?? []);
  if (props.selectedTaskId) litTaskIds.add(props.selectedTaskId);
  if (props.hoveredTaskId) litTaskIds.add(props.hoveredTaskId);

  const { arrows, stubs } = buildChainDrawing({
    links: props.links,
    anchors: props.anchors,
    tasksById: props.tasksById,
    runningTaskIds: props.runningTaskIds,
    litTaskIds,
    boardWidth: props.width,
  });
  if (arrows.length === 0 && stubs.length === 0 && !band) return null;

  // A drag is in the air: the whole layer stands aside so the cards under it can be
  // dropped on. `at` rather than `linkDrag` — an armed link has no pointer over the board.
  const dragging = props.linkDrag?.at != null;

  /** The stroke for one state, and the head that matches it. */
  const strokeOf = (
    a: Pick<ChainArrow, 'lit' | 'blocked' | 'releasing'>,
    selected: boolean,
  ): string =>
    mergeClasses(
      styles.path,
      // Selection outranks lit — you asked for this one specifically, where lit is merely
      // everything on the route of whatever the pointer happens to be over.
      selected ? styles.selected : a.lit ? styles.lit : styles.resting,
      a.blocked && styles.blocked,
      // After `blocked`, so its cyan and its longer dash win on a link that is both.
      a.releasing && styles.releasing,
      dragging && styles.inert,
    );
  const headOf = (a: Pick<ChainArrow, 'lit' | 'releasing'>): string =>
    `url(#${a.releasing ? MARKER.live : a.lit ? MARKER.lit : MARKER.rest})`;

  return (
    <svg
      className={styles.layer}
      width={props.width}
      height={props.height}
      // Decoration over a board that says all of this in words elsewhere; the `<title>`s
      // are there for the pointer, not for a screen reader to wade through.
      aria-hidden="true"
    >
      <defs>
        <Head id={MARKER.rest} className={styles.headRest} />
        <Head id={MARKER.lit} className={styles.headLit} />
        <Head id={MARKER.live} className={styles.headLive} />
      </defs>

      {arrows.map((a) => {
        const selected = a.linkId === props.selectedLinkId;
        const stroke = strokeOf(a, selected);
        return (
          <g key={a.linkId} data-link-id={a.linkId}>
            <title>{a.title}</title>
            {/* First, so it sits UNDER the visible stroke and cannot be what a click lands
                on when the pointer is dead on the line — and so the hairline stays crisp.
                Gone entirely mid-drag: a 14px invisible band across the cards is the worst
                possible thing to have lying over a drop target. */}
            {!dragging && (
              <path
                d={a.d}
                className={styles.hit}
                onClick={(e) => {
                  // The board below clears the selection on any click that reaches it.
                  e.stopPropagation();
                  props.onSelectLink?.(a.linkId);
                }}
              />
            )}
            {a.gate === 'stacked' ? (
              <>
                <path
                  d={a.d}
                  className={stroke}
                  markerEnd={headOf(a)}
                  transform={`translate(0 ${-DOUBLE_GAP})`}
                />
                {/* No second head: one arrow, drawn twice, still points once. */}
                <path d={a.d} className={stroke} transform={`translate(0 ${DOUBLE_GAP})`} />
              </>
            ) : (
              <path d={a.d} className={stroke} markerEnd={headOf(a)} />
            )}
            {selected && (
              <>
                <circle cx={a.start.x} cy={a.start.y} r={3.5} className={styles.endpoint} />
                <circle cx={a.end.x} cy={a.end.y} r={3.5} className={styles.endpoint} />
              </>
            )}
          </g>
        );
      })}

      {stubs.map((s) => (
        <g key={s.key}>
          <title>{s.title}</title>
          <path
            d={s.d}
            className={mergeClasses(
              styles.path,
              s.lit ? styles.lit : styles.resting,
              dragging && styles.inert,
            )}
            markerEnd={headOf({ lit: s.lit, releasing: false })}
          />
          {s.chip && (
            <>
              <rect
                x={s.chip.cx - CHIP_SIZE.width / 2}
                y={s.chip.cy - CHIP_SIZE.height / 2}
                width={CHIP_SIZE.width}
                height={CHIP_SIZE.height}
                rx={CHIP_SIZE.height / 2}
                className={styles.chipBox}
              />
              <text
                x={s.chip.cx}
                y={s.chip.cy}
                textAnchor="middle"
                dominantBaseline="central"
                className={styles.chipText}
              >
                {s.count}
              </text>
            </>
          )}
        </g>
      ))}

      {/* Last, so the line you are dragging is never hidden behind an arrow that already
          exists — the one shape on this layer that follows your hand. */}
      {band && (
        <path
          d={band.d}
          className={mergeClasses(styles.band, band.valid ? styles.bandValid : styles.bandRefused)}
        />
      )}
    </svg>
  );
}

/**
 * The rubber band's shape and its verdict, or null when no link is being dragged.
 *
 * The verdict is read off the card the pointer is actually over, so the line and that
 * card's outline are two views of one answer rather than two calculations that could
 * drift. Over no card at all it reads neutral: nothing is being refused yet, there is
 * simply nothing there to accept.
 */
function bandFor(props: ChainOverlayProps): { d: string; valid: boolean } | null {
  const drag = props.linkDrag;
  // `at` is null for a keyboard-armed link, which has no pointer to follow.
  if (!drag?.at) return null;
  const from = props.anchors.get(drag.fromTaskId);
  if (!from) return null;
  const over = drag.overTaskId ? drag.states.get(drag.overTaskId) : undefined;
  return { d: rubberBandPath(from, drag.at), valid: over === 'valid' };
}
