/**
 * NextRunsRail — the next 10 firings across every enabled, schedule-kind automation
 * (`automationsViewModel.nextRuns`), shown beside either of `AutomationsView`'s two readings
 * (List or Week) rather than owned by one of them.
 */
import { Caption1, Text, makeStyles, tokens } from '@fluentui/react-components';
import type { Automation } from '@tm/shared/automation';
import { formatCountdown } from '../countdown';
import { nextRuns } from './automationsViewModel';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '10px' },
  row: { display: 'flex', flexDirection: 'column', gap: '2px' },
  meta: { display: 'flex', justifyContent: 'space-between', gap: '8px' },
  hint: { color: tokens.colorNeutralForeground3 },
});

export interface NextRunsRailProps {
  automations: Automation[];
  now: number;
}

export function NextRunsRail({ automations, now }: NextRunsRailProps): JSX.Element {
  const styles = useStyles();
  const runs = nextRuns(automations, now, 10);

  return (
    <div className={styles.root}>
      <Text weight="semibold">Next runs</Text>
      {runs.length === 0 ? (
        <Caption1 className={styles.hint}>Nothing scheduled.</Caption1>
      ) : (
        runs.map((r, i) => (
          <div key={`${r.automationId}-${r.at}-${i}`} className={styles.row}>
            <Text>{r.name}</Text>
            <div className={styles.meta}>
              <Caption1 className={styles.hint}>in {formatCountdown(r.at - now)}</Caption1>
              <Caption1 className={styles.hint}>{new Date(r.at).toLocaleString()}</Caption1>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
