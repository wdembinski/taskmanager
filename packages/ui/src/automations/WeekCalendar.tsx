/**
 * WeekCalendar — the Automations tab's Week view (F1.15): 7 columns × 24 hour rows of
 * schedule-kind automations, laid out by the pure `layoutWeek` (`./weekCalendarLayout`) so
 * the DST-aware placement is tested without a DOM. Tracker-kind automations have no clock, so
 * they sit in a side strip instead of a column of their own.
 *
 * Colour budget (memory: *board-colour-budget*): a cell earns colour only for what
 * `outcomeTone` says is worth it — a firing under way, a gap, a drop. A future occurrence and
 * a benign no-op are flat, same as every other empty hour.
 */
import { Fragment, useMemo, useState } from 'react';
import { Badge, Button, Caption1, Text, makeStyles, tokens } from '@fluentui/react-components';
import { ChevronLeftRegular, ChevronRightRegular } from '@fluentui/react-icons';
import type { Automation, AutomationRun } from '@tm/shared/automation';
import { type BadgeColor } from '../taskStatus';
import {
  type OutcomeTone,
  gridPositionOf,
  layoutWeek,
  outcomeTone,
  weekStartOf,
} from './weekCalendarLayout';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOURS = Array.from({ length: 24 }, (_unused, i) => i);
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const TONE_COLOR: Record<OutcomeTone, string> = {
  brand: tokens.colorBrandForeground1,
  warning: tokens.colorPaletteYellowForeground1,
  danger: tokens.colorPaletteRedForeground1,
  neutral: tokens.colorNeutralForeground4,
};

const TONE_BADGE_COLOR: Record<OutcomeTone, BadgeColor> = {
  brand: 'brand',
  warning: 'warning',
  danger: 'danger',
  neutral: 'subtle',
};

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0 },
  nav: { display: 'flex', alignItems: 'center', gap: '8px' },
  body: { display: 'flex', gap: '16px', minHeight: 0, flex: 1, overflow: 'auto' },
  grid: {
    display: 'grid',
    gridTemplateColumns: '48px repeat(7, minmax(90px, 1fr))',
    flex: 1,
    minWidth: 0,
  },
  corner: {
    position: 'sticky',
    top: 0,
    left: 0,
    zIndex: 2,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  dayHeader: {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: '4px',
    textAlign: 'center',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  hourLabel: {
    color: tokens.colorNeutralForeground3,
    textAlign: 'right',
    paddingRight: '6px',
    fontSize: '11px',
  },
  cellSlot: {
    position: 'relative',
    minHeight: '28px',
    borderTop: `1px solid ${tokens.colorNeutralStroke3}`,
    borderLeft: `1px solid ${tokens.colorNeutralStroke3}`,
    padding: '2px',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  occurrence: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '11px',
    lineHeight: '14px',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  },
  dot: { width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0 },
  muted: { opacity: 0.55 },
  nowLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: '2px',
    backgroundColor: tokens.colorBrandForeground1,
  },
  strip: {
    flex: '0 0 220px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingLeft: '12px',
  },
  stripItem: { display: 'flex', flexDirection: 'column', gap: '2px' },
  hint: { color: tokens.colorNeutralForeground3 },
});

export interface WeekCalendarProps {
  automations: Automation[];
  runs: AutomationRun[];
  now: number;
  viewTz: string;
}

export function WeekCalendar({ automations, runs, now, viewTz }: WeekCalendarProps): JSX.Element {
  const styles = useStyles();
  const [weekStartMs, setWeekStartMs] = useState(() => weekStartOf(now, viewTz));

  const layout = useMemo(
    () => layoutWeek({ automations, runs, weekStartMs, nowMs: now, viewTz }),
    [automations, runs, weekStartMs, now, viewTz],
  );

  function shiftWeek(deltaWeeks: number): void {
    // Land a few days inside the target week, then re-resolve its own Monday by wall clock —
    // see weekStartOf's own header for why a fixed +/- 7*24h is wrong across a DST week.
    const probe = weekStartMs + deltaWeeks * 7 * DAY_MS + 3 * DAY_MS;
    setWeekStartMs(weekStartOf(probe, viewTz));
  }

  const nowMarker = gridPositionOf(now, weekStartMs, viewTz);
  const showNowLine = nowMarker.day >= 0 && nowMarker.day <= 6;

  const cellsByDayHour = new Map<string, typeof layout.cells>();
  for (const cell of layout.cells) {
    const key = `${cell.day}:${cell.hour}`;
    const existing = cellsByDayHour.get(key);
    if (existing) existing.push(cell);
    else cellsByDayHour.set(key, [cell]);
  }

  return (
    <div className={styles.root}>
      <div className={styles.nav}>
        <Button
          size="small"
          appearance="subtle"
          icon={<ChevronLeftRegular />}
          aria-label="Previous week"
          onClick={() => shiftWeek(-1)}
        />
        <Button
          size="small"
          appearance="subtle"
          onClick={() => setWeekStartMs(weekStartOf(now, viewTz))}
        >
          This week
        </Button>
        <Button
          size="small"
          appearance="subtle"
          icon={<ChevronRightRegular />}
          aria-label="Next week"
          onClick={() => shiftWeek(1)}
        />
        <Text weight="semibold">
          {new Date(layout.days[0].date).toLocaleDateString()} –{' '}
          {new Date(layout.days[6].date).toLocaleDateString()}
        </Text>
      </div>

      <div className={styles.body}>
        <div className={styles.grid}>
          <div className={styles.corner} />
          {layout.days.map((day, i) => (
            <div key={day.date} className={styles.dayHeader}>
              <Text weight="semibold">{DAY_LABELS[i]}</Text>{' '}
              <Caption1 className={styles.hint}>{new Date(day.date).toLocaleDateString()}</Caption1>
            </div>
          ))}

          {HOURS.map((hour) => (
            <Fragment key={hour}>
              <div className={styles.hourLabel}>{String(hour).padStart(2, '0')}:00</div>
              {DAY_LABELS.map((_label, day) => {
                const cells = cellsByDayHour.get(`${day}:${hour}`) ?? [];
                return (
                  <div key={`${day}-${hour}`} className={styles.cellSlot}>
                    {showNowLine && nowMarker.day === day && nowMarker.hour === hour && (
                      <div
                        className={styles.nowLine}
                        style={{ top: `${(nowMarker.minute / 60) * 100}%` }}
                      />
                    )}
                    {cells.map((cell) => (
                      <div
                        key={cell.automationId + cell.at}
                        className={`${styles.occurrence} ${cell.enabled ? '' : styles.muted}`}
                        title={`${cell.name} — ${new Date(cell.at).toLocaleString()}`}
                      >
                        <span
                          className={styles.dot}
                          style={{ backgroundColor: TONE_COLOR[outcomeTone(cell.outcome)] }}
                        />
                        <span>{cell.name}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>

        <div className={styles.strip}>
          <Text weight="semibold">Trackers</Text>
          {layout.trackerStrip.length === 0 ? (
            <Caption1 className={styles.hint}>No tracker-triggered automations.</Caption1>
          ) : (
            layout.trackerStrip.map((automation) => {
              const lastHere = runs.filter((r) => r.automationId === automation.id);
              const last = lastHere.length > 0 ? lastHere[0] : null;
              return (
                <div
                  key={automation.id}
                  className={`${styles.stripItem} ${automation.enabled ? '' : styles.muted}`}
                >
                  <Text>{automation.name}</Text>
                  {last && (
                    <Badge
                      appearance="tint"
                      color={TONE_BADGE_COLOR[outcomeTone(last.status)]}
                      size="small"
                    >
                      {last.status}
                    </Badge>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
