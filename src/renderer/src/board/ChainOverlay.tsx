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
 *   - **blocked** — the target is still waiting on this predecessor. Dashed, which is the
 *     one thing a line can say without a colour.
 *   - **releasing** — and the predecessor is running right now, so the dash travels toward
 *     the target. Cyan, because cyan is already what this app means by "moving": the
 *     card's running band, the step dots, every spinner.
 *   - **stacked** — the loose gate, drawn as a DOUBLE hairline. Two gates need telling
 *     apart, and spending a second colour on a fact that never changes would break the
 *     budget the rest of the board is kept to.
 *
 * The layer takes no pointer events, but each path takes them on its STROKE — so an arrow
 * can be hovered for its tooltip today and clicked to re-gate or erase it in Phase 3,
 * without the layer eating a single click meant for a card.
 */
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { Task } from '@shared/model';
import type { TaskLink } from '@shared/taskChain';
import { FLUO } from '../theme';
import { CHIP_SIZE, buildChainDrawing, type AnchorRect, type ChainArrow } from './chainArrows';

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
  width: number;
  height: number;
}

export function ChainOverlay(props: ChainOverlayProps): JSX.Element | null {
  const styles = useStyles();
  if (props.links.length === 0 || props.width === 0) return null;

  const litTaskIds = new Set<string>();
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
  if (arrows.length === 0 && stubs.length === 0) return null;

  /** The stroke for one state, and the head that matches it. */
  const strokeOf = (a: Pick<ChainArrow, 'lit' | 'blocked' | 'releasing'>): string =>
    mergeClasses(
      styles.path,
      a.lit ? styles.lit : styles.resting,
      a.blocked && styles.blocked,
      // After `blocked`, so its cyan and its longer dash win on a link that is both.
      a.releasing && styles.releasing,
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
        const stroke = strokeOf(a);
        return (
          <g key={a.linkId} data-link-id={a.linkId}>
            <title>{a.title}</title>
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
          </g>
        );
      })}

      {stubs.map((s) => (
        <g key={s.key}>
          <title>{s.title}</title>
          <path
            d={s.d}
            className={mergeClasses(styles.path, s.lit ? styles.lit : styles.resting)}
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
    </svg>
  );
}
