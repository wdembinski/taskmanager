/**
 * The repository's commit graph, beside the board.
 *
 * The board says what there is to do and the chain says in what order; neither can say what
 * actually HAPPENED in the repo. Which branches exist, which forked from where, which have
 * merged back into base — that lives in git, and until this pane the only way to see it was
 * to leave the app. `git:graph` reads it (`src/main/gitGraph.ts`) and `@shared/gitGraph` lays
 * it out in lanes; this file only draws what comes back.
 *
 * **The lanes are one `<svg>` behind the rows**, exactly the way `ChainOverlay` is one `<svg>`
 * over the board's columns and for the same reason: a line per row would be clipped by its own
 * row, and a line that has to cross four commits to reach its parent has nowhere to be drawn
 * but in a layer that spans all of them. The list and the layer share a coordinate space
 * because both take their geometry from `gitGraphView` — `ROW_HEIGHT` is the row's CSS height
 * and the SVG's row pitch at once, so a dot can only land on its own commit.
 *
 * **Refreshed on demand and on `task:changed`, never on a timer.** A `git log` is a process
 * spawned on a machine that may be a WSL distro, and a graph that re-read itself every few
 * seconds would spend that for a picture that changes when a run finishes and at no other
 * time. A run finishing is precisely what `task:changed` announces.
 *
 * The colour budget is stated once, in `GRAPH_INK`: everything here is monochrome except the
 * branch of a card whose agent is running right now.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Dropdown,
  Option,
  Spinner,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { ArrowClockwiseRegular } from '@fluentui/react-icons';
import type { GitGraph } from '@shared/gitGraph';
import type { Project, Task } from '@shared/model';
import { GRAPH_INK, MONO, fontPx } from '@ui/theme';
import {
  DOT_RADIUS,
  ROW_HEIGHT,
  defaultGraphProjectId,
  edgePath,
  gutterWidth,
  laneX,
  refLabel,
  relativeAge,
  rowY,
  visibleRefs,
} from './gitGraphView';

/** How many commits the pane asks for. A view, not an export — see `DEFAULT_GRAPH_LIMIT`. */
const GRAPH_LIMIT = 150;

const useStyles = makeStyles({
  /** One surface for the whole pane, like the detail pane's — the shade is the seam. */
  root: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    minWidth: 0,
    width: '100%',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 12px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  /** The repo picker takes whatever is left; the refresh button keeps its own width. */
  picker: { flex: 1, minWidth: 0 },
  /**
   * The only scrolling element in the pane, and therefore the containing block the lane
   * layer is positioned against — same arrangement as the board's `columns`.
   */
  scroll: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 0' },
  /** Holds the rows AND the lane layer, sized by the rows so the layer can span them all. */
  canvas: { position: 'relative' },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    height: `${ROW_HEIGHT}px`,
    paddingRight: '12px',
    // Rows are read left to right and the gutter is drawn under their left edge, so the text
    // is indented past it rather than the gutter being a column of its own — a flex column
    // would have to be re-measured every time the lane count changed.
    boxSizing: 'border-box',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  /**
   * The lane layer. It sits OVER the rows rather than under them, despite being "behind" them
   * to read: a row's hover tint is painted on the row's own background, and a layer genuinely
   * underneath would have its lines wiped out by exactly the row you are pointing at. It
   * takes no pointer events, so it is invisible to every hover and click that matters.
   */
  lanes: { position: 'absolute', top: 0, left: 0, pointerEvents: 'none', overflow: 'visible' },
  line: { fill: 'none', strokeWidth: '1.5px', stroke: GRAPH_INK.line },
  /** A merge's incoming lines — the ones you read past while following a branch down. */
  lineMerge: { stroke: GRAPH_INK.merge },
  /** The one moving thing on the drawing. See `GRAPH_INK`. */
  lineLive: { stroke: GRAPH_INK.live, strokeWidth: '2px' },
  dot: { fill: tokens.colorNeutralBackground1, stroke: GRAPH_INK.dot, strokeWidth: '2px' },
  dotLive: { stroke: GRAPH_INK.live },
  /** A merge commit reads as a filled dot: two lines arrive at it and one leaves. */
  dotMerge: { fill: GRAPH_INK.dot },
  subject: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** Author and date: facts about a finished commit, so they read at the quietest weight. */
  meta: { color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap', flexShrink: 0 },
  author: {
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'nowrap',
    flexShrink: 0,
    maxWidth: '110px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  sha: { fontFamily: MONO, fontSize: fontPx(11), color: tokens.colorNeutralForeground4 },
  /**
   * A ref on a commit. Monochrome by default — a branch that exists is not news — and never
   * allowed to squeeze the subject out: the chips shrink, the subject does not.
   */
  chip: {
    flexShrink: 0,
    maxWidth: '140px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    padding: '0 6px',
    borderRadius: tokens.borderRadiusSmall,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground2,
    fontSize: fontPx(11),
    lineHeight: '16px',
  },
  /** The integration branch. Heavier ink, still no colour — it is where things LAND. */
  // The whole `border` shorthand rather than `borderColor`: Griffel refuses the partial
  // shorthands, since they cannot be flattened into the atomic classes it emits.
  chipBase: {
    color: tokens.colorNeutralForeground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  chipLive: { color: GRAPH_INK.live, border: `1px solid ${GRAPH_INK.live}` },
  /** The reason there is no graph, and the "older history" footer. */
  notice: { padding: '12px', color: tokens.colorNeutralForeground3 },
  footer: {
    padding: '8px 12px',
    color: tokens.colorNeutralForeground4,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
});

export interface GitGraphPaneProps {
  /** The repos a graph can be read from — the board's agent projects. */
  projects: readonly Project[];
  /** The selected card, which is what the pane opens on. See `defaultGraphProjectId`. */
  selectedTask: Task | null;
  /** Every card on the board, so a branch can be labelled with the CARD it carries. */
  tasksById: ReadonlyMap<string, Task>;
  /** The engine's live runs — the one thing on this drawing allowed a colour. */
  runningTaskIds: ReadonlySet<string>;
}

export function GitGraphPane({
  projects,
  selectedTask,
  tasksById,
  runningTaskIds,
}: GitGraphPaneProps): JSX.Element {
  const styles = useStyles();
  /**
   * The repo the human PICKED, or null while they haven't. Kept separate from the default so
   * a pick survives selecting another card: switching cards would otherwise drag the graph
   * to that card's repo and silently throw away the answer you asked for.
   */
  const [picked, setPicked] = useState<string | null>(null);
  const [graph, setGraph] = useState<GitGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectId = picked ?? defaultGraphProjectId(projects, selectedTask);
  const project = projects.find((p) => p.id === projectId) ?? null;

  /**
   * One clock reading for the whole graph, taken when the graph is, so every row's age is
   * measured from the same instant — and so the dates don't creep on an unrelated re-render.
   */
  const [readAt, setReadAt] = useState(() => Date.now());

  /**
   * Only the NEWEST read may land. Two refreshes can be in flight at once (the button, and a
   * `task:changed` arriving while it works), and their promises are not guaranteed to settle
   * in request order — the same rule `useActiveRuns` keeps, and for the same reason.
   */
  const issued = useRef(0);
  const applied = useRef(0);

  const load = useCallback(async (id: string | null) => {
    if (!id) {
      setGraph(null);
      return;
    }
    const seq = ++issued.current;
    setLoading(true);
    try {
      const next = await window.api.invoke('git:graph', id, GRAPH_LIMIT);
      if (seq <= applied.current) return;
      applied.current = seq;
      setGraph(next);
      setReadAt(Date.now());
      setError(null);
    } catch (e: unknown) {
      if (seq <= applied.current) return;
      applied.current = seq;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // The repo changed (picked, or the selection moved the default): read the new one.
  useEffect(() => {
    void load(projectId);
  }, [load, projectId]);

  /**
   * A run finishing is the only thing that changes this picture, and `task:changed` is what
   * announces it — a commit, a merge and a released tag all land through one. No timer:
   * see the note at the top of the file.
   */
  useEffect(() => {
    if (!projectId) return;
    return window.api.on('task:changed', () => void load(projectId));
  }, [load, projectId]);

  const rows = graph?.commits ?? [];
  const gutter = gutterWidth(graph?.laneCount ?? 0);

  /**
   * The rows that belong to a branch an agent is on RIGHT NOW — so the line down a running
   * branch is lit, not just the chip on its tip.
   *
   * Found by walking down from each live ref along first parents, and stopping where the
   * branch's line changes lane: that is the commit it converges into, i.e. the point it forked
   * from, and everything below belongs to the branch it joined rather than to this card. Two
   * facts make one pass enough — a parent is always below its child in the list, and a first
   * parent keeps its child's lane for as long as the branch has one of its own.
   */
  const liveRows = useMemo(() => {
    const lit = new Set<number>();
    if (!graph) return lit;
    const continues = new Map<number, number>();
    for (const edge of graph.edges) {
      if (edge.parentIndex === 0 && edge.fromLane === edge.toLane) {
        continues.set(edge.fromRow, edge.toRow);
      }
    }
    graph.commits.forEach((commit, row) => {
      const tip = commit.refs.some(
        (r) => r.role === 'card' && r.taskId && runningTaskIds.has(r.taskId),
      );
      if (!tip && !lit.has(row)) return;
      lit.add(row);
      const next = continues.get(row);
      if (next !== undefined) lit.add(next);
    });
    return lit;
  }, [graph, runningTaskIds]);

  /** A link is live when it is a live branch's OWN line — never a merge's incoming one. */
  const liveEdge = (edge: {
    fromRow: number;
    fromLane: number;
    toLane: number;
    parentIndex: number;
  }): boolean =>
    edge.parentIndex === 0 && edge.fromLane === edge.toLane && liveRows.has(edge.fromRow);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Dropdown
          className={styles.picker}
          size="small"
          placeholder="Pick a repository"
          value={project?.name ?? ''}
          selectedOptions={projectId ? [projectId] : []}
          onOptionSelect={(_e, d) => setPicked(d.optionValue ?? null)}
        >
          {projects.map((p) => (
            <Option key={p.id} value={p.id}>
              {p.name}
            </Option>
          ))}
        </Dropdown>
        {loading ? (
          <Spinner size="extra-tiny" />
        ) : (
          <Button
            size="small"
            appearance="subtle"
            icon={<ArrowClockwiseRegular />}
            title="Re-read this repository’s history"
            aria-label="Refresh the commit graph"
            disabled={!projectId}
            onClick={() => void load(projectId)}
          />
        )}
      </div>

      {!projectId && (
        <Body1 className={styles.notice}>
          {projects.length === 0
            ? 'No agent projects yet — add a repository and its history shows up here.'
            : 'Pick a repository, or select a card that has an agent on it.'}
        </Body1>
      )}
      {error && <Body1 className={styles.notice}>{error}</Body1>}
      {/* The engine's own sentence for a folder that isn't a repo, has no commits, or has
          gone missing. Not an error: those are all perfectly normal projects. */}
      {!error && graph?.reason && <Body1 className={styles.notice}>{graph.reason}</Body1>}

      {rows.length > 0 && (
        <div className={styles.scroll}>
          <div className={styles.canvas} style={{ height: `${rows.length * ROW_HEIGHT}px` }}>
            {/* The lane layer, spanning every row — see the note at the top of the file. */}
            <svg
              className={styles.lanes}
              width={gutter}
              height={rows.length * ROW_HEIGHT}
              // The rows beside it say all of this in words; the lines are a picture OF them.
              aria-hidden="true"
            >
              {graph?.edges.map((edge) => (
                <path
                  key={`${edge.fromSha}-${edge.toSha}-${edge.parentIndex}`}
                  d={edgePath(edge)}
                  className={mergeClasses(
                    styles.line,
                    edge.parentIndex > 0 && styles.lineMerge,
                    liveEdge(edge) && styles.lineLive,
                  )}
                />
              ))}
              {rows.map((commit, row) => (
                <circle
                  key={commit.sha}
                  cx={laneX(graph?.lanes[row] ?? 0)}
                  cy={rowY(row)}
                  r={DOT_RADIUS}
                  className={mergeClasses(
                    styles.dot,
                    commit.parents.length > 1 && styles.dotMerge,
                    liveRows.has(row) && styles.dotLive,
                  )}
                />
              ))}
            </svg>

            {rows.map((commit) => (
              <div
                key={commit.sha}
                className={styles.row}
                style={{ paddingLeft: `${gutter + 4}px` }}
                title={`${commit.shortSha} · ${commit.subject}`}
              >
                {visibleRefs(commit.refs).map((ref) => {
                  const label = refLabel(ref, tasksById, runningTaskIds);
                  return (
                    <span
                      key={ref.name}
                      className={mergeClasses(
                        styles.chip,
                        label.isBase && styles.chipBase,
                        label.live && styles.chipLive,
                      )}
                      title={label.title}
                    >
                      {label.name}
                    </span>
                  );
                })}
                <Caption1 className={styles.subject}>{commit.subject}</Caption1>
                <Caption1 className={styles.sha}>{commit.shortSha}</Caption1>
                <Caption1 className={styles.author}>{commit.author}</Caption1>
                <Caption1 className={styles.meta}>
                  {relativeAge(commit.authoredAt, readAt)}
                </Caption1>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Said out loud rather than left to be inferred from a list that simply stops: the
          graph reads every branch at once, so "the oldest row" is not the repo's first commit
          and a fork whose point is off the bottom would otherwise look like a root. */}
      {graph?.truncated && (
        <Caption1 className={styles.footer}>
          The newest {rows.length} commits across every branch — there is older history than this.
        </Caption1>
      )}
    </div>
  );
}
