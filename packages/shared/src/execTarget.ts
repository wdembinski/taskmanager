/**
 * Which machine a project's work runs on (Phase: WSL execution target).
 *
 * Lives in `shared` because both sides need it: the main process uses it to pick an
 * `ExecHost`, and the renderer renders the picker and the readiness panel.
 *
 * Stored as ONE text column rather than a pair of columns, so the whole value moves
 * atomically and reads plainly in the database: `local`, or `wsl:Ubuntu-20.04`.
 * Anything unrecognized parses back to `local` — a database written by a newer build,
 * or a distro string that got mangled, degrades to "runs where the GUI runs" instead
 * of failing to open the project at all.
 */

export type ExecTarget = { kind: 'local' } | { kind: 'wsl'; distro: string };

/** The default for every project: run where the GUI runs. */
export const LOCAL_TARGET: ExecTarget = { kind: 'local' };

const WSL_PREFIX = 'wsl:';

/** Serialize for storage. */
export function formatExecTarget(target: ExecTarget): string {
  return target.kind === 'wsl' ? `${WSL_PREFIX}${target.distro}` : 'local';
}

/**
 * Parse a stored value. Never throws — an unknown shape means `local`, which is
 * always runnable, rather than a target that cannot be reached.
 */
export function parseExecTarget(raw: string | null | undefined): ExecTarget {
  if (typeof raw !== 'string') return LOCAL_TARGET;
  if (!raw.startsWith(WSL_PREFIX)) return LOCAL_TARGET;
  // Distro names may contain spaces, so everything after the prefix is the name.
  const distro = raw.slice(WSL_PREFIX.length).trim();
  return distro ? { kind: 'wsl', distro } : LOCAL_TARGET;
}

/** True when two targets name the same machine. */
export function sameExecTarget(a: ExecTarget, b: ExecTarget): boolean {
  return formatExecTarget(a) === formatExecTarget(b);
}

/** How the target reads in the UI. */
export function execTargetLabel(target: ExecTarget): string {
  return target.kind === 'wsl' ? `WSL · ${target.distro}` : 'This computer';
}

/** One thing that has to be true before a target can run tasks. */
export interface ReadinessCheck {
  id: string;
  label: string;
  ok: boolean;
  /** What was found — a version, a path, or why the check failed. */
  detail?: string;
  /** Present when `ok` is false: what the user should do about it. */
  fix?: string;
}

/**
 * Whether a target can actually run work, and why not if it can't.
 *
 * This matters more than usual here because the target may be a machine the app has
 * never touched — a distro with no `claude`, or one where interop is switched off.
 * Reporting that in Settings beats discovering it when a task fails.
 */
export interface TargetReadiness {
  target: ExecTarget;
  ok: boolean;
  checks: ReadinessCheck[];
}
