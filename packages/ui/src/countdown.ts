/**
 * A millisecond gap as a compact countdown — "1d 03:12:45", "4:59:00", "04:59", "now".
 *
 * Lifted out of `LimitBanner` (apps/client) when the second host needed it: the usage bars
 * and the Performance screen both say "window resets in …", and both are shared components
 * now. `LimitBanner` itself stays in apps/client — it subscribes to `window.api` directly
 * and is a desktop banner — and imports this back, so there is one way to write a countdown
 * rather than two that could disagree about whether to show days.
 */
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
