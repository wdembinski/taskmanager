/**
 * A millisecond duration as the board's compact elapsed-time chip — "42s" under a minute,
 * "4m 12s" under an hour, "1h 03m" beyond that (seconds drop once there are hours to show).
 * Floors to whole seconds and never goes negative, so a renderer whose clock lags its
 * `startedAt` by a tick reads "0s" rather than a negative duration.
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (hours > 0) return `${hours}h ${pad(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}
