/**
 * The Gantt's header — month bands, day ticks, and the milestones lane (Phase 24 step 6).
 *
 * Milestones are drawn HERE, as vertical markers with labels, and not as rows of their own:
 * a milestone is an instant, and giving it a row the way a ticket gets one would waste a lane
 * on something with no duration to show. `TimelinePane` draws the matching guide LINE down
 * through the chart body at the same `x` this lane places the label at — both read the same
 * `GanttMarker[]`, so the two can never disagree about which day a milestone falls on.
 *
 * Purely presentational: every `x`/`width` here already came out of `ganttLayout.ts`, so this
 * component only maps numbers onto elements — see that module's header for why the split
 * matters in a workspace with no DOM test harness.
 */
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { GanttMarker, GanttTicks } from './ganttLayout';

/** How tall one stacked milestone label is — see {@link GanttMarker.stackIndex}. */
const MILESTONE_ROW_H = 16;

const useStyles = makeStyles({
  root: {
    position: 'relative',
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  months: {
    position: 'relative',
    height: '22px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  monthBand: {
    position: 'absolute',
    top: 0,
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    paddingLeft: '4px',
    boxSizing: 'border-box',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    fontSize: '12px',
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
    borderLeft: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  days: {
    position: 'relative',
    height: '18px',
  },
  day: {
    position: 'absolute',
    top: 0,
    transform: 'translateX(-50%)',
    fontSize: '10px',
    color: tokens.colorNeutralForeground3,
  },
  weekend: { color: tokens.colorNeutralForeground4 },
  milestones: {
    position: 'relative',
  },
  milestone: {
    position: 'absolute',
    display: 'flex',
    alignItems: 'center',
    gap: '3px',
    transform: 'translateX(-50%)',
    whiteSpace: 'nowrap',
    fontSize: '10px',
    color: tokens.colorNeutralForeground2,
  },
  milestoneDot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    flexShrink: 0,
    backgroundColor: tokens.colorNeutralForeground2,
  },
});

export interface GanttHeaderProps {
  ticks: GanttTicks;
  markers: GanttMarker[];
  /** The chart's own width in px — the label column sits to the left of this, in the caller. */
  width: number;
}

export function GanttHeader({ ticks, markers, width }: GanttHeaderProps): JSX.Element {
  const styles = useStyles();
  const stackDepth = markers.reduce((max, m) => Math.max(max, m.stackIndex), -1) + 1;
  const milestonesHeight = stackDepth > 0 ? stackDepth * MILESTONE_ROW_H + 4 : 0;

  return (
    <div className={styles.root} style={{ width: `${width}px` }}>
      <div className={styles.months}>
        {ticks.months.map((m) => (
          <div
            key={`${m.label}-${m.x}`}
            className={styles.monthBand}
            style={{ left: `${m.x}px`, width: `${m.width}px` }}
          >
            {m.label}
          </div>
        ))}
      </div>
      <div className={styles.days}>
        {ticks.days.map((d) => (
          <span
            key={d.ms}
            className={mergeClasses(styles.day, d.weekend && styles.weekend)}
            style={{ left: `${d.x}px` }}
          >
            {d.label}
          </span>
        ))}
      </div>
      {milestonesHeight > 0 && (
        <div className={styles.milestones} style={{ height: `${milestonesHeight}px` }}>
          {markers.map((m) => (
            <div
              key={m.milestoneId}
              className={styles.milestone}
              style={{ left: `${m.x}px`, top: `${m.stackIndex * MILESTONE_ROW_H + 2}px` }}
              title={m.label}
            >
              <span className={styles.milestoneDot} />
              {m.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
