/**
 * "How much of this window have I spent?" — two progress bars, in two places.
 *
 * Claude meters an account against two windows: the **current session** (the rolling
 * 5 hours) and the **week**. This file owns both readings and renders them twice over:
 *
 *   - {@link UsageQuotaBars} — the labelled pair on the Performance screen, above the
 *     range selector's territory, because these two windows are fixed and do NOT follow
 *     the 5h/24h/7d/all selector below them;
 *   - {@link UsageQuotaStatus} — the same two numbers as ambient furniture in the status
 *     bar, beside the sync rings, so the answer is on screen without opening a tab.
 *
 * The percentage is, whenever the CLI has one to give, **Claude's own `/usage` reading**
 * — the exact number the human would see typing `/usage` themselves (see
 * `claudeUsage.ts`). Until that first reading lands (or if the CLI is unreachable), the
 * bar falls back to measured spend against a budget the human set in Settings, and says
 * so — see `UsageQuota.pctSource` and doc 08's rule that a fallback has to be built on
 * `token_usage`, not on a guess.
 *
 * The standard live-data idiom, at a gentler cadence than the dashboard's: seed via
 * `invoke`, then refresh on the `usage:sample` push plus a slow tick (the windows are
 * hours and days wide — a second's resolution would buy nothing and cost two SQL sums a
 * second in every open copy of the pair).
 */
import { useEffect, useState } from 'react';
import { makeStyles, ProgressBar, Tooltip, tokens } from '@fluentui/react-components';
import type { UsageQuota, UsageQuotas } from '@shared/usage';
import { formatCountdown } from './LimitBanner';
import { ACCENT } from './theme';
import { formatPct, formatTokens } from './usageFormat';

/** How often the pair re-reads its two sums when nothing is being spent. */
const REFRESH_MS = 15_000;

/** Above this share of the budget the bar goes amber; see {@link CRITICAL_PCT}. */
const WARNING_PCT = 75;
/** …and above this, red. Both are about the bar's colour only — nothing is refused. */
const CRITICAL_PCT = 90;

/** Full name of each window, for the label and the tooltip's first words. */
const QUOTA_LABEL: Record<UsageQuota['id'], string> = {
  session: 'Current session (5h)',
  weekly: 'This week (7d)',
};

/** The status bar has room for a word, not a phrase. */
const QUOTA_SHORT: Record<UsageQuota['id'], string> = {
  session: 'Session',
  weekly: 'Week',
};

const useStyles = makeStyles({
  /** The Performance screen's pair: two stacked rows, each label over bar over numbers. */
  panel: { display: 'flex', flexDirection: 'column', gap: '10px' },
  row: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 10px', alignItems: 'center' },
  rowLabel: { fontSize: '13px' },
  rowNums: {
    fontVariantNumeric: 'tabular-nums',
    fontSize: '12px',
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'nowrap',
  },
  rowBar: { gridColumn: '1 / -1' },

  /** The status-bar pair: label, a short bar, a percent — three times per window. */
  status: { display: 'flex', alignItems: 'center', gap: '10px' },
  statusItem: { display: 'flex', alignItems: 'center', gap: '5px', cursor: 'default' },
  statusPct: { fontVariantNumeric: 'tabular-nums' },
  /**
   * The bar is drawn in the bar's OWN ink rather than Fluent's brand palette, for the
   * same reason the live/dead dot is: the strip is blue at rest and the app's orange
   * under attention, and one fixed colour cannot read on both. A translucent-white track
   * with a solid fill keeps the reading where it belongs — fill against track — on either.
   */
  statusTrack: {
    width: '56px',
    height: '4px',
    borderRadius: '2px',
    backgroundColor: 'rgba(255, 255, 255, 0.35)',
    overflow: 'hidden',
  },
  statusFill: { height: '100%', borderRadius: '2px' },
});

/** Fluent's colour for a bar at this share of its budget. */
function quotaColor(pct: number): 'brand' | 'warning' | 'error' {
  if (pct >= CRITICAL_PCT) return 'error';
  if (pct >= WARNING_PCT) return 'warning';
  return 'brand';
}

/**
 * The same three states in the status bar's own ink. White at rest reads on the blue and
 * on the orange alike; the two alarm colours are the dot's, picked for both fills.
 */
function statusInk(pct: number): string {
  if (pct >= CRITICAL_PCT) return ACCENT.liveRed;
  if (pct >= WARNING_PCT) return '#FFC107';
  return '#FFFFFF';
}

/** A bar's value in Fluent's 0–1 terms, full (never past it) once the budget is gone. */
function barValue(quota: UsageQuota): number {
  return Math.max(0, Math.min(1, quota.pct / 100));
}

/**
 * "19% used (from Claude) · this app spent 12.3M of 100M tokens", plus the reset when
 * the CLI has told us one.
 *
 * Read at render rather than off a ticking clock: it is a tooltip and a screen-reader
 * label, both of which are read the moment they appear, and the pair re-renders on every
 * refresh anyway. A second ticker per bar would buy a countdown nobody is watching.
 */
function describeQuota(quota: UsageQuota): string {
  const spend =
    quota.limit > 0
      ? `this app spent ${formatTokens(quota.tokens)} of ${formatTokens(quota.limit)} tokens`
      : `this app spent ${formatTokens(quota.tokens)} tokens · no budget set`;
  const head =
    quota.pctSource === 'claude'
      ? `${QUOTA_LABEL[quota.id]}: ${formatPct(quota.pct)} used (from Claude) · ${spend}`
      : `${QUOTA_LABEL[quota.id]}: ${spend}${
          quota.limit > 0 ? ` · ${formatPct(quota.pct)} (estimate, no Claude reading yet)` : ''
        }`;
  const now = Date.now();
  if (quota.resetAt == null || quota.resetAt <= now) return head;
  return `${head} · window resets in ${formatCountdown(quota.resetAt - now)}`;
}

/**
 * Both readings, kept live. Returns null until the first read lands.
 *
 * Failures are swallowed on purpose: this pair is ambient, and a backend that is down is
 * already being reported by the boot error, the Claude bar and every pane on screen. A
 * status bar that turned into an error report would be the fourth voice saying it.
 */
export function useUsageQuotas(): UsageQuotas | null {
  const [quotas, setQuotas] = useState<UsageQuotas | null>(null);

  useEffect(() => {
    const read = (): void =>
      void window.api.invoke('usage:quotas').then(setQuotas, () => undefined);
    read();
    const off = window.api.on('usage:sample', read);
    const id = setInterval(read, REFRESH_MS);
    return () => {
      off();
      clearInterval(id);
    };
  }, []);

  return quotas;
}

/** One labelled row of the Performance screen's pair. */
function QuotaRow({ quota }: { quota: UsageQuota }): JSX.Element {
  const styles = useStyles();
  // A Claude reading always has a percentage to draw; the budget fallback only does
  // once a budget is set, so an unset budget with no reading yet reads empty rather
  // than pretending to a denominator nobody gave it.
  const hasReading = quota.pctSource === 'claude' || quota.limit > 0;
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{QUOTA_LABEL[quota.id]}</span>
      <span className={styles.rowNums}>
        {quota.pctSource === 'claude'
          ? `${formatPct(quota.pct)} used`
          : quota.limit > 0
            ? `${formatTokens(quota.tokens)} / ${formatTokens(quota.limit)} · ${formatPct(quota.pct)} (est.)`
            : `${formatTokens(quota.tokens)} · no budget set`}
      </span>
      <div className={styles.rowBar}>
        <ProgressBar
          thickness="large"
          max={1}
          value={hasReading ? barValue(quota) : 0}
          color={quotaColor(quota.pct)}
          aria-label={describeQuota(quota)}
        />
      </div>
    </div>
  );
}

/** The Performance screen's pair: current session over current week. */
export function UsageQuotaBars({ quotas }: { quotas: UsageQuotas | null }): JSX.Element | null {
  const styles = useStyles();
  if (!quotas) return null;
  return (
    <div className={styles.panel}>
      <QuotaRow quota={quotas.session} />
      <QuotaRow quota={quotas.weekly} />
    </div>
  );
}

/** One compact reading in the status bar: a word, a bar, a percent. */
function StatusQuota({ quota }: { quota: UsageQuota }): JSX.Element {
  const styles = useStyles();
  return (
    <Tooltip content={describeQuota(quota)} relationship="label" positioning="above">
      <div className={styles.statusItem}>
        <span>{QUOTA_SHORT[quota.id]}</span>
        <div
          className={styles.statusTrack}
          role="progressbar"
          aria-label={describeQuota(quota)}
          aria-valuenow={Math.round(quota.pct)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={styles.statusFill}
            style={{ width: `${barValue(quota) * 100}%`, backgroundColor: statusInk(quota.pct) }}
          />
        </div>
        <span className={styles.statusPct}>{formatPct(quota.pct)}</span>
      </div>
    </Tooltip>
  );
}

/**
 * The status bar's pair. Nothing at all until there is something to say: a real Claude
 * reading, or (until one lands) a budget the human set — "0%" against a budget nobody
 * chose is two items of furniture saying nothing.
 */
export function UsageQuotaStatus({ quotas }: { quotas: UsageQuotas | null }): JSX.Element | null {
  const styles = useStyles();
  if (!quotas) return null;
  const shown = [quotas.session, quotas.weekly].filter(
    (q) => q.pctSource === 'claude' || q.limit > 0,
  );
  if (shown.length === 0) return null;
  return (
    <div className={styles.status}>
      {shown.map((quota) => (
        <StatusQuota key={quota.id} quota={quota} />
      ))}
    </div>
  );
}
