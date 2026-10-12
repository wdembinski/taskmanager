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

/**
 * How long ago `createdAt` (epoch ms) was, as "now", "3m", "2h" or "5d" — the compact
 * Inbox row's age, next to the countdown above rather than a full timestamp.
 */
export function formatAge(createdAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
