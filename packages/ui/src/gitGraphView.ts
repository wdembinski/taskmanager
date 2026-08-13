/**
 * The drawing half of the commit graph: geometry, labels and dates, with no React in it.
 *
 * `@tm/shared/gitGraph` already answered the hard question — which LANE every commit sits in,
 * and which lanes each parent link joins. What is left is turning those integers into pixels
 * and into words, and that is exactly the kind of thing worth having on its own: a bezier
 * that bends the wrong way, or a branch labelled with the wrong card, is a bug you can write
 * a test for, and `GitGraphPane.tsx` is a component you cannot.
 *
 * The same split `board/chainArrows.ts` makes for the chain's arrows, for the same reason.
 */
import type { GitGraphEdge, GitRef } from '@tm/shared/gitGraph';
import type { Project, Task } from '@tm/shared/model';

/**
 * One commit row's height in px, and the horizontal pitch between lanes.
 *
 * The row height is shared by the SVG and the list: the lanes are drawn as ONE `<svg>` behind
 * the rows (the way `ChainOverlay` lies over the board's columns), so a dot lands on its own
 * row only for as long as these two agree. Stating it once is what makes that impossible to
 * get wrong — see `GitGraphPane`, whose rows set their height from this constant.
 */
export const ROW_HEIGHT = 26;

/** Distance between two lanes' centres. Narrow: a lane is a 7px dot, not a column of text. */
export const LANE_WIDTH = 14;

/** Where lane 0's centre sits, measured from the left edge of the graph gutter. */
export const LANE_ORIGIN = 9;

/** The commit dot's radius. */
export const DOT_RADIUS = 3.5;

/** The x of a lane's centre, in the SVG's (and the row list's) shared coordinate space. */
export function laneX(lane: number): number {
  return LANE_ORIGIN + lane * LANE_WIDTH;
}

/** The y of a row's centre — the vertical middle of the commit's own row. */
export function rowY(row: number): number {
  return row * ROW_HEIGHT + ROW_HEIGHT / 2;
}

/**
 * How wide the graph gutter has to be to hold `laneCount` lanes.
 *
 * The rows' text is indented by exactly this, so the two never overlap however many branches
 * the repository happens to have open. A graph with no lanes at all still gets nothing.
 */
export function gutterWidth(laneCount: number): number {
  return laneCount === 0 ? 0 : laneX(laneCount - 1) + LANE_ORIGIN;
}

/**
 * One parent link as an SVG path.
 *
 * Three shapes, and which one you get says what kind of link it is without spending a colour
 * on the distinction:
 *
 *   - **Straight down** when child and parent share a lane — the ordinary case, a branch
 *     continuing down its own column.
 *   - **Down, then bending in at the bottom** for a FIRST parent in another lane: the branch
 *     keeps its own column for as long as it exists and only converges at the commit it
 *     actually joins, which is where the join happened.
 *   - **Out, then straight down** for a merge's later parents: the line leaves the merge
 *     commit sideways at once and then runs down the lane the merged branch occupies, so the
 *     fan-out reads at the top where the merge is.
 *
 * The corner is a quadratic whose control point is the corner itself, which is the cheapest
 * way to get a tangent-continuous bend — the line leaves and arrives along the axis it is
 * travelling on, so no join ever shows a kink.
 */
export function edgePath(edge: GitGraphEdge): string {
  const x1 = laneX(edge.fromLane);
  const y1 = rowY(edge.fromRow);
  const x2 = laneX(edge.toLane);
  const y2 = rowY(edge.toRow);
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;

  // Never more than half the vertical run, so a link between adjacent rows bends inside its
  // own gap instead of overshooting the commit at the other end.
  const bend = Math.min(ROW_HEIGHT / 2, Math.abs(y2 - y1) / 2);
  if (edge.parentIndex === 0) {
    return `M ${x1} ${y1} L ${x1} ${y2 - bend} Q ${x1} ${y2} ${x2} ${y2}`;
  }
  return `M ${x1} ${y1} Q ${x2} ${y1} ${x2} ${y1 + bend} L ${x2} ${y2}`;
}

/**
 * How a ref reads on the graph, and whether it is the one thing allowed a colour.
 *
 * A branch the app put there is named `orch/1f3c…` or `wd/feat/DEMO-101/add-sso`, neither of
 * which tells you anything you came to the graph to find out. When the engine has marked a
 * ref as a card's (`role: 'card'`), the CARD's title is what goes on the chip and the branch
 * name moves to the tooltip — the graph is being read beside the board, and the board says
 * titles.
 *
 * `live` is true only when that card's agent is running THIS SECOND. See `GRAPH_INK`: a
 * finished branch is history like everything else around it, and history gets no colour.
 */
export interface RefLabel {
  name: string;
  /** The full branch name, when {@link name} is showing something else instead. */
  title: string;
  /** Marks the project's integration branch — worth naming, never worth colouring. */
  isBase: boolean;
  live: boolean;
}

export function refLabel(
  ref: GitRef,
  tasksById: ReadonlyMap<string, Task>,
  runningTaskIds: ReadonlySet<string>,
): RefLabel {
  const base = { name: ref.name, title: ref.name, isBase: ref.role === 'base', live: false };
  if (ref.role !== 'card' || !ref.taskId) return base;
  const task = tasksById.get(ref.taskId);
  return {
    // The card may not be on THIS board (a delegated card lives on the Personal one, and the
    // graph pane is handed only what the screen it sits on holds) — then the branch name it
    // already had is still the best thing to show.
    name: task?.title || ref.name,
    title: task ? `${ref.name} — ${task.title}` : ref.name,
    isBase: false,
    live: runningTaskIds.has(ref.taskId),
  };
}

/**
 * The refs worth drawing on a commit, in the order they should read.
 *
 * Remote-tracking branches are dropped: `origin/main` is the same commit as `main` and would
 * put the same chip on the same row twice. A detached `HEAD` is dropped for the same reason —
 * it names no branch and is already implied by the commit it sits on.
 *
 * Cards first, then the base branch, then everything else, because a row with four refs on it
 * has room for two and the two that matter are the ones the app has an opinion about.
 */
export function visibleRefs(refs: readonly GitRef[]): GitRef[] {
  const rank = (ref: GitRef): number => (ref.role === 'card' ? 0 : ref.role === 'base' ? 1 : 2);
  return refs
    .filter((ref) => ref.kind !== 'remote' && ref.name !== 'HEAD')
    .sort((a, b) => rank(a) - rank(b));
}

/**
 * A commit's age, in the shortest form that is still unambiguous.
 *
 * Relative while relative is the useful reading ("2h" answers "is this from this session?"),
 * absolute once it stops being one — nobody counts back 43 days. The switch is at a week,
 * which is roughly where a person stops holding the calendar in their head.
 *
 * `authoredAt` is UNIX **seconds** (git's `%at`), not milliseconds; `now` is milliseconds,
 * because that is what `Date.now()` hands you. Passed in rather than read here so the
 * function is pure and the pane can re-date a whole graph from one clock reading.
 */
export function relativeAge(authoredAt: number, now: number): string {
  const seconds = Math.max(0, Math.round(now / 1000) - authoredAt);
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;

  const date = new Date(authoredAt * 1000);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    // The year only when it is not this one: on a graph of last week's work it is noise on
    // every row, and on a five-year-old commit its absence is a lie.
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/**
 * Which repository the graph opens on before the human picks one.
 *
 * The selected card's agent project, because that is the repo whose history you are already
 * looking at the work of; failing that, the ONLY agent project, because with one repo there
 * is no choice to make and asking for one is a click that can only have one answer. With
 * several repos and nothing selected it returns null and the pane asks.
 *
 * A card filed under a project it is not delegated to does not count: `agentProjectId` is
 * where the work RUNS, and the graph is a picture of a working copy.
 */
export function defaultGraphProjectId(
  projects: readonly Project[],
  selectedTask: Task | null,
): string | null {
  const assigned = selectedTask?.agentProjectId;
  if (assigned && projects.some((p) => p.id === assigned)) return assigned;
  return projects.length === 1 ? projects[0].id : null;
}
