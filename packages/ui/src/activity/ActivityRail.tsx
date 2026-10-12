/**
 * The activity rail: `NeedsYouRail` stacked above `DailyTrendChart`. The single export
 * F2.13 drops into `ActivityScreen`'s right column — the rail owns its own layout so
 * the screen doesn't have to know what's inside it.
 */
import { makeStyles } from '@fluentui/react-components';
import { DailyTrendChart } from './DailyTrendChart';
import { NeedsYouRail } from './NeedsYouRail';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '16px', minHeight: 0 },
});

export function ActivityRail(): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <NeedsYouRail />
      <DailyTrendChart />
    </div>
  );
}
