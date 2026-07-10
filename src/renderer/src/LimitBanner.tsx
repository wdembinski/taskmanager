/**
 * Global usage-limit banner (Phase 5).
 *
 * When Claude hits a usage limit the engine parks ALL work behind one account-wide
 * gate and schedules an automatic resume at reset time. This banner is the visible
 * half of that: a single strip across the top of the app with a **live countdown**
 * to the resume, a label distinguishing the 5-hour rolling limit from the weekly
 * cap, and how many tasks are parked.
 *
 * It reads the current gate once (`limit:current`) to seed itself, then follows
 * the `limit:changed` event — a `LimitState` engages/updates it, `null` clears it.
 * A 1s interval re-renders the countdown while a limit is in force.
 */
import { useEffect, useState } from 'react';
import {
  Button,
  makeStyles,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
} from '@fluentui/react-components';
import type { LimitState } from '@shared/limit';

const useStyles = makeStyles({
  countdown: { fontVariantNumeric: 'tabular-nums', fontWeight: 600 },
});

/** Human label for each limit type — the wording docs/03 uses. */
const LIMIT_LABEL: Record<LimitState['limitType'], string> = {
  rolling: '5-hour usage limit reached',
  weekly: 'Weekly usage cap reached',
};

/** Format a millisecond gap as a compact countdown (e.g. "1d 03:12:45", "04:59"). */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (days > 0) return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

export function LimitBanner(): JSX.Element | null {
  const styles = useStyles();
  const [limit, setLimit] = useState<LimitState | null>(null);
  // A ticking clock so the countdown re-renders every second while a limit is up.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void window.api.invoke('limit:current').then(setLimit);
    return window.api.on('limit:changed', setLimit);
  }, []);

  useEffect(() => {
    if (!limit) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [limit]);

  if (!limit) return null;

  const remaining = limit.resumeAt - now;
  const parked = limit.parkedTaskIds.length;
  const resumeText =
    remaining <= 0
      ? 'resuming now…'
      : `resuming in ${formatCountdown(remaining)} (${new Date(limit.resumeAt).toLocaleTimeString()})`;

  return (
    <MessageBar intent={limit.limitType === 'weekly' ? 'error' : 'warning'} politeness="assertive">
      <MessageBarBody>
        <MessageBarTitle>{LIMIT_LABEL[limit.limitType]}</MessageBarTitle>{' '}
        All work is paused — <span className={styles.countdown}>{resumeText}</span>.{' '}
        {parked > 0 && `${parked} task${parked === 1 ? '' : 's'} parked, resuming automatically.`}
      </MessageBarBody>
      <MessageBarActions>
        {/* Escape hatch for a false trip / an already-cleared limit: lift the gate
            now and resume parked tasks. The banner clears via `limit:changed`→null. */}
        <Button size="small" onClick={() => void window.api.invoke('limit:resumeNow')}>
          Resume now
        </Button>
      </MessageBarActions>
    </MessageBar>
  );
}
