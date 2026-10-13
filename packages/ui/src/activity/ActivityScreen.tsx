/**
 * The Activity tab (F2.13 on the desktop; F2.14 mounts it on the web) — the tiles row on
 * top, and below it the feed beside the needs-you/trend rail. Host-agnostic: `lastSeen` and
 * `onSeen` are a prop pair the host backs however it likes (the desktop's `app_state`; the
 * browser's own localStorage), exactly as `ActivityFeed` already takes `lastSeen`/
 * `onNewestSeen` for its own divider.
 *
 * Two design decisions worth restating here (full reasoning in the plan's
 * `F2-activity-dashboard.md`):
 * - The divider is PINNED at mount. `dividerAt` snapshots `lastSeen` once and feeds that
 *   snapshot to `ActivityFeed`, never the live `lastSeen` prop `onSeen` is busy advancing —
 *   otherwise the divider would disappear the moment it renders. It adopts the first
 *   non-null value if `lastSeen` is still loading when this mounts.
 * - `sinceMs` is memoized on `period` alone, so a re-render for an unrelated reason never
 *   resets the feed's own page-one load.
 * - Below `MEDIUM_MIN_PX` (`MEDIA.compact`, `MEDIA.medium` — medium counts as narrow on the
 *   web too, since a tablet-width browser window still can't fit two columns) `grid` drops
 *   to one column with a bounded first row, and `root` scrolls as a whole, because source
 *   order already is tiles → feed → rail with no `order:` CSS to undo.
 */
import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { makeStyles } from '@fluentui/react-components';
import { ACTIVITY_PERIOD_MS, type ActivityCursor, type ActivityPeriod } from '@tm/shared/activity';
import { MEDIA } from '../layout/viewport';
import { ActivityFeed } from './ActivityFeed';
import { ActivityRail } from './ActivityRail';
import { EMPTY_FEED_FILTER, type FeedFilter } from './activityFeedModel';
import { OutcomeTiles } from './OutcomeTilesRow';

const narrowRoot = { overflowY: 'auto' } as const;
const narrowGrid = {
  gridTemplateColumns: 'minmax(0, 1fr)',
  gridTemplateRows: 'min(70vh, 640px) auto',
  flex: 'none',
} as const;

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    minHeight: 0,
    height: '100%',
    [MEDIA.compact]: narrowRoot,
    [MEDIA.medium]: narrowRoot,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(260px, 320px)',
    gap: '16px',
    minHeight: 0,
    flex: 1,
    [MEDIA.compact]: narrowGrid,
    [MEDIA.medium]: narrowGrid,
  },
});

export interface ActivityScreenProps {
  lastSeen: ActivityCursor | null;
  onSeen: (cursor: ActivityCursor) => void;
  onOpenTask?: (taskId: string) => void;
}

export function ActivityScreen({ lastSeen, onSeen, onOpenTask }: ActivityScreenProps): JSX.Element {
  const styles = useStyles();
  const [period, setPeriod] = useState<ActivityPeriod>('24h');
  const [filter, setFilter] = useState<FeedFilter>(EMPTY_FEED_FILTER);
  const [dividerAt, setDividerAt] = useState<ActivityCursor | null>(() => lastSeen);

  useEffect(() => {
    if (dividerAt === null && lastSeen !== null) setDividerAt(lastSeen);
  }, [lastSeen, dividerAt]);

  // Deliberately memoized on `period` alone: re-deriving `sinceMs` from "now" on every
  // render would reset the feed's page-one load every time anything else on screen did.
  const sinceMs = useMemo(() => Date.now() - ACTIVITY_PERIOD_MS[period], [period]);

  return (
    <div className={styles.root}>
      <OutcomeTiles
        period={period}
        onPeriodChange={setPeriod}
        filter={filter}
        onFilterChange={setFilter}
      />
      <div className={styles.grid}>
        <ActivityFeed
          sinceMs={sinceMs}
          filter={filter}
          onFilterChange={setFilter}
          lastSeen={dividerAt}
          onNewestSeen={onSeen}
          onOpenTask={onOpenTask}
        />
        <ActivityRail />
      </div>
    </div>
  );
}
