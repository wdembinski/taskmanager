/**
 * The Activity dashboard's tiles row (F2.10/F2.13) — four clickable tiles (Running now ·
 * Needs you · Completed · Failed) plus the 24h/7d/30d period picker, driving `outcomeTiles.ts`'s
 * pure mapping functions. This file owns only the IPC poll and the markup; which tile is
 * active and what clicking one does to the feed's filter are `activeFeedTile`/
 * `applyTileToFeedFilter`'s job, not this component's.
 *
 * Named `OutcomeTilesRow` rather than `OutcomeTiles` — on a case-insensitive filesystem
 * (Windows, default macOS) that would collide with `outcomeTiles.ts`, the pure module this
 * component drives, and TypeScript refuses to typecheck two same-cased file names at once.
 *
 * Counts are polled on the same cadence `ActivityFeed` already uses (`CADENCE_MS`), rather
 * than pushed — `activity:overview` has no event behind it, same as the feed's own head page.
 */
import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import {
  Caption1,
  Tab,
  TabList,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  CheckmarkCircleRegular,
  DismissCircleRegular,
  PlayCircleRegular,
  QuestionCircleRegular,
} from '@fluentui/react-icons';
import { CADENCE_MS } from '@tm/protocol/cadence';
import { ACTIVITY_PERIODS, type ActivityOverview, type ActivityPeriod } from '@tm/shared/activity';
import { useTransport } from '../transport';
import type { FeedFilter } from './activityFeedModel';
import {
  OUTCOME_TILES,
  activeFeedTile,
  applyTileToFeedFilter,
  tileCount,
  type OutcomeTile,
} from './outcomeTiles';

const TILE_LABEL: Record<OutcomeTile, string> = {
  running: 'Running now',
  needsYou: 'Needs you',
  completed: 'Completed',
  failed: 'Failed',
};

type IconComponent = typeof PlayCircleRegular;

const TILE_ICON: Record<OutcomeTile, IconComponent> = {
  running: PlayCircleRegular,
  needsYou: QuestionCircleRegular,
  completed: CheckmarkCircleRegular,
  failed: DismissCircleRegular,
};

/**
 * The two tiles whose count is read LIVE off the engine rather than the settled log (see
 * `outcomeTiles.ts`'s own docstring) — the only two numbers here that are ever actually
 * moving. Colour is reserved for those, and for the active tile — see `board-colour-budget`:
 * colour is for things that move, and a settled outcome count is a standing fact.
 */
const LIVE_TILES: ReadonlySet<OutcomeTile> = new Set(['running', 'needsYou']);

const PERIOD_LABEL: Record<ActivityPeriod, string> = { '24h': '24h', '7d': '7d', '30d': '30d' };

const useStyles = makeStyles({
  root: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' },
  tiles: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '4px',
    minWidth: '112px',
    padding: '10px 14px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground1,
    cursor: 'pointer',
    font: 'inherit',
    textAlign: 'left',
    color: 'inherit',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  tileActive: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
  },
  tileIcon: { fontSize: '16px', color: tokens.colorNeutralForeground3 },
  count: { fontSize: '22px', fontWeight: 600, lineHeight: 1 },
  countLive: { color: tokens.colorBrandForeground1 },
  label: { color: tokens.colorNeutralForeground3 },
});

export interface OutcomeTilesProps {
  period: ActivityPeriod;
  onPeriodChange: (period: ActivityPeriod) => void;
  filter: FeedFilter;
  onFilterChange: (filter: FeedFilter) => void;
}

export function OutcomeTiles({
  period,
  onPeriodChange,
  filter,
  onFilterChange,
}: OutcomeTilesProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [overview, setOverview] = useState<ActivityOverview | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const load = (): void => {
      transport.invoke('activity:overview', period).then(
        (next) => {
          if (!cancelled) setOverview(next);
        },
        () => undefined,
      );
    };
    const schedule = (): void => {
      const delay = document.visibilityState === 'visible' ? CADENCE_MS.active : CADENCE_MS.idle;
      timer = setTimeout(tick, delay);
    };
    const tick = (): void => {
      if (cancelled) return;
      load();
      schedule();
    };

    load();
    schedule();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [transport, period]);

  const active = activeFeedTile(filter);

  return (
    <div className={styles.root}>
      <div className={styles.tiles}>
        {OUTCOME_TILES.map((tile) => {
          const Icon = TILE_ICON[tile];
          const isActive = active === tile;
          const count = overview ? tileCount(overview, tile) : null;
          return (
            <button
              key={tile}
              type="button"
              className={mergeClasses(styles.tile, isActive && styles.tileActive)}
              aria-pressed={isActive}
              onClick={() => onFilterChange(applyTileToFeedFilter(filter, tile))}
            >
              <Icon className={styles.tileIcon} />
              <span
                className={mergeClasses(styles.count, LIVE_TILES.has(tile) && styles.countLive)}
              >
                {count ?? '—'}
              </span>
              <Caption1 className={styles.label}>{TILE_LABEL[tile]}</Caption1>
            </button>
          );
        })}
      </div>
      <TabList
        size="small"
        selectedValue={period}
        onTabSelect={(_e, data) => onPeriodChange(data.value as ActivityPeriod)}
      >
        {ACTIVITY_PERIODS.map((p) => (
          <Tab key={p} value={p}>
            {PERIOD_LABEL[p]}
          </Tab>
        ))}
      </TabList>
    </div>
  );
}
