/**
 * Needs-you rail — the Attention inbox, shrunk to fit above `DailyTrendChart` in the
 * activity rail. Reuses `useAttentionItems`/`InboxItem` from `Attention.tsx` verbatim,
 * so this is a different shape around the SAME live list rather than a second
 * subscription that could drift from the full inbox screen.
 */
import { Body1, Caption1, CounterBadge, makeStyles, tokens } from '@fluentui/react-components';
import { CheckmarkCircleRegular } from '@fluentui/react-icons';
import { InboxItem, useAttentionItems } from '../Attention';
import { PaneLoading } from '../PaneLoading';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '8px', minHeight: 0 },
  header: { display: 'flex', alignItems: 'center', gap: '8px' },
  title: { fontSize: '12px', fontWeight: 600, color: tokens.colorNeutralForeground2 },
  list: { display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto', minHeight: 0 },
  caughtUp: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '6px',
    padding: '24px 12px',
    color: tokens.colorNeutralForeground3,
  },
  caughtUpIcon: { fontSize: '28px' },
  caughtUpSub: { color: tokens.colorNeutralForeground3 },
});

export function NeedsYouRail(): JSX.Element {
  const styles = useStyles();
  const { items, initial, answer, dismiss } = useAttentionItems();

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>Needs you</span>
        {items && items.length > 0 && (
          <CounterBadge count={items.length} color="danger" size="small" appearance="filled" />
        )}
      </div>

      {items === null ? (
        <PaneLoading
          label="Loading inbox…"
          error={initial.error}
          onRetry={initial.retry}
          shape="rows"
        />
      ) : items.length === 0 ? (
        <div className={styles.caughtUp}>
          <CheckmarkCircleRegular className={styles.caughtUpIcon} />
          <Body1>All caught up</Body1>
          <Caption1 className={styles.caughtUpSub}>Nothing is waiting on you.</Caption1>
        </div>
      ) : (
        <div className={styles.list}>
          {items.map((item) => (
            <InboxItem key={item.id} item={item} onAnswer={answer} onDismiss={dismiss} />
          ))}
        </div>
      )}
    </div>
  );
}
