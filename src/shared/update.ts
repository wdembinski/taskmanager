/**
 * Shared auto-update vocabulary (Phase 16.3).
 *
 * The app updates itself from its own GitHub Releases: `electron-updater` reads the
 * `latest.yml` feed published alongside the installers, downloads a newer build in the
 * background, and applies it on quit. These types describe that progress as it crosses
 * the UI↔engine boundary — the engine drives the updater and pushes state, the UI shows
 * a line in the status bar and a block in Settings — so they live in `shared`.
 *
 * Not every install can update itself, which is why `mode` exists rather than a bare
 * on/off: a `.deb` is owned by apt and must never be overwritten from inside the app,
 * and an AppImage can only replace itself when it is actually being run as one. Those
 * installs get a link to the releases page instead of a button that could not work.
 */

/**
 * Whether this install can update itself.
 *
 * - `auto`   — the updater runs: checks, downloads, installs on quit.
 * - `manual` — updating is possible but not from in here (deb, unsigned macOS); the UI
 *              points at the releases page.
 * - `off`    — a development run. Nothing to update; the updater is never constructed.
 */
export type UpdateMode = 'auto' | 'manual' | 'off';

/**
 * Where the update currently stands.
 *
 * `unsupported` is the resting state for a `manual`/`off` install — distinct from `idle`,
 * which means "we can update, we just aren't doing anything right now".
 */
export type UpdateStatus =
  'unsupported' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';

/** One snapshot of the updater, seeded by `update:get` and pushed on `update:changed`. */
export interface UpdateState {
  status: UpdateStatus;
  mode: UpdateMode;
  /** The version being offered/downloaded, once the feed has been read. */
  version?: string;
  /** Download progress, 0-100, while `status === 'downloading'`. */
  percent?: number;
  /** Human-readable detail — the error text on failure, otherwise a short note. */
  message?: string;
  /**
   * electron-updater's machine-readable error code, when it supplied one
   * (`ERR_UPDATER_INVALID_SIGNATURE`, `ERR_UPDATER_LATEST_VERSION_NOT_FOUND`, …). Shown
   * verbatim because these names are searchable in a way the prose message is not.
   */
  code?: string;
}

/**
 * One line describing where the update stands. Lives here rather than in the renderer
 * because the same sentence is the honest answer in Settings, in a log line, and in
 * anything else that later wants to say what the updater is doing.
 */
export function describeUpdate(state: UpdateState): string {
  const version = state.version ? ` ${state.version}` : '';
  switch (state.status) {
    case 'unsupported':
      return state.mode === 'off'
        ? 'Updates are off in a development run.'
        : 'This install updates through its package manager, not from in here.';
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return `Update${version} found — downloading…`;
    case 'downloading':
      // The feed can omit progress on a fast link; don't render "NaN%".
      return typeof state.percent === 'number'
        ? `Downloading update${version} — ${Math.round(state.percent)}%`
        : 'Downloading update…';
    case 'downloaded':
      return `Update${version} ready — restart to install`;
    case 'error': {
      // A known version means the feed was read and the download had already started, so
      // this is a failed *install*, not a failed check. Saying "check failed" there sent
      // three releases' worth of ERR_UPDATER_INVALID_SIGNATURE looking like flaky network.
      const detail = [state.code, state.message].filter(Boolean).join(' — ');
      const what = state.version
        ? `Update ${state.version} could not be installed`
        : 'Update check failed';
      return detail ? `${what}: ${detail}` : `${what}.`;
    }
    case 'idle':
    default:
      return version ? `Up to date (${state.version}).` : 'Up to date.';
  }
}
