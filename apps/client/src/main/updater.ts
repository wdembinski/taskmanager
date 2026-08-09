/**
 * Auto-update driver.
 *
 * Wraps `electron-updater` so the rest of the app never touches it: the class owns the
 * whole lifecycle (`start` / `checkNow` / `install` / `dispose`, deliberately the same
 * shape as `JiraPoller`) and folds every one of the updater's half-dozen events into a
 * single `UpdateState` pushed to the UI on `update:changed`.
 *
 * Two rules it exists to enforce:
 *
 *  1. **It no-ops unless this install can actually update itself** (`updateSupport.ts`).
 *     Pointing electron-updater at a `.deb` makes it error on every single launch, which
 *     is worse than not offering updates at all.
 *  2. **A failure is never a dialog.** An unreachable feed, a rate-limited GitHub, a
 *     corporate proxy — none of those are the user's problem mid-task. They land in the
 *     log and in the state, where Settings can show them if anyone looks.
 *
 * Downloads happen in the background and install on quit, so the app is never interrupted
 * by an update it decided to apply.
 */
import { app } from 'electron';
// electron-updater is CommonJS. Under our ESM main bundle a named import is not reliably
// detected, so take the default export and destructure it — the documented interop path.
import electronUpdater from 'electron-updater';
import type { UpdateMode, UpdateState } from '@shared/update';
import { logMain } from './log';
import { updateMode } from './updateSupport';

const { autoUpdater } = electronUpdater;

/** Wait a beat after boot before hitting the network — the first paint matters more. */
const FIRST_CHECK_DELAY_MS = 15_000;
/** A desktop app stays open for days; re-check periodically or it only ever sees launch-day. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export class Updater {
  private readonly mode: UpdateMode;
  private state: UpdateState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstCheck: ReturnType<typeof setTimeout> | null = null;
  private wired = false;

  constructor(private readonly push: (state: UpdateState) => void) {
    this.mode = updateMode(process.platform, process.env, app.isPackaged);
    this.state = { status: this.mode === 'auto' ? 'idle' : 'unsupported', mode: this.mode };
  }

  /** The current snapshot, for seeding a freshly-mounted UI (`update:get`). */
  current(): UpdateState {
    return this.state;
  }

  /** Wire the updater up and schedule its checks. No-op unless the mode is `auto`. */
  start(): void {
    if (this.mode !== 'auto' || this.wired) return;
    this.wired = true;

    // Downloading without asking is the point: by the time the user quits, the update is
    // already there. `autoInstallOnAppQuit` then applies it with no extra click.
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    // electron-updater logs through electron-log if it finds it; we don't ship one, so
    // give it our own file logger and keep the chatty levels out of it.
    //
    // `UPDATE_LOG_VERBOSE` opens the chatty levels back up, because their absence hides
    // the one failure this class of bug produces: electron-updater declines to check at
    // all — "Skip checkForUpdates because application is not packed" and friends — at
    // `info`, so a completely inert updater looks exactly like an up-to-date one. Set it
    // alongside UPDATE_CONFIG_PATH when a local feed appears to do nothing.
    const verbose = Boolean(process.env['UPDATE_LOG_VERBOSE']);
    autoUpdater.logger = {
      info: verbose ? (message: unknown) => logMain('Updater', message) : () => {},
      debug: verbose ? (message: unknown) => logMain('Updater debug', message) : () => {},
      warn: (message: unknown) => logMain('Updater warning', message),
      error: (message: unknown) => logMain('Updater error', message),
    };
    // Escape hatch for testing a real installed build against a local feed without
    // cutting a release (see docs/07): point this at a generic-provider yml.
    const configPath = process.env['UPDATE_CONFIG_PATH'];
    if (configPath) autoUpdater.updateConfigPath = configPath;

    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking' }));
    autoUpdater.on('update-available', (info: { version: string }) =>
      this.set({ status: 'available', version: info.version }),
    );
    autoUpdater.on('update-not-available', (info: { version: string }) =>
      this.set({ status: 'idle', version: info.version }),
    );
    autoUpdater.on('download-progress', (progress: { percent: number }) =>
      this.set({ status: 'downloading', percent: progress.percent }),
    );
    autoUpdater.on('update-downloaded', (info: { version: string }) =>
      this.set({ status: 'downloaded', version: info.version }),
    );
    autoUpdater.on('error', (err: Error) => this.fail(err));

    this.firstCheck = setTimeout(() => void this.checkNow(), FIRST_CHECK_DELAY_MS);
    this.timer = setInterval(() => void this.checkNow(), CHECK_INTERVAL_MS);
  }

  /** Check the feed now (the Settings button, and the scheduled ticks). */
  async checkNow(): Promise<UpdateState> {
    if (this.mode !== 'auto') return this.state;
    // Already downloading or downloaded: a second check would restart the download.
    if (this.state.status === 'downloading' || this.state.status === 'downloaded') {
      return this.state;
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      // Also reported via the 'error' event in most cases, but not all paths emit it.
      this.fail(err);
    }
    return this.state;
  }

  /**
   * Record a failure. Every updater error lands here so the log line and the state say the
   * same thing, and so one distinction is made consistently: a failure that arrives while
   * an update is being fetched is a failed *install*, and only then does the version
   * identify what failed. Outside that window `version` is merely whatever the last check
   * reported, and carrying it into the error would read as "this update won't install"
   * when the truth is "we couldn't reach the feed".
   */
  private fail(err: unknown): void {
    const fetching = this.state.status === 'available' || this.state.status === 'downloading';
    logMain(fetching ? 'Update download failed' : 'Update check failed', err);
    const code = (err as { code?: unknown } | null)?.code;
    this.set({
      status: 'error',
      version: fetching ? this.state.version : undefined,
      message: err instanceof Error ? err.message : String(err),
      code: typeof code === 'string' ? code : undefined,
    });
  }

  /**
   * Quit and apply a downloaded update. Deliberately does nothing until the download has
   * finished — `quitAndInstall` on a half-downloaded update just closes the app.
   */
  install(): void {
    if (this.mode !== 'auto' || this.state.status !== 'downloaded') return;
    // `isSilent: false` shows the NSIS progress; `isForceRunAfter: true` relaunches us.
    autoUpdater.quitAndInstall(false, true);
  }

  /** Stop for good (app shutdown). */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.firstCheck) clearTimeout(this.firstCheck);
    this.timer = null;
    this.firstCheck = null;
    if (this.wired) autoUpdater.removeAllListeners();
  }

  /** Merge a change into the state and push the whole thing (the UI replaces wholesale). */
  private set(change: Partial<UpdateState>): void {
    // Moving to any non-error status drops the previous failure's detail. Without this a
    // stale message or ERR_ code rides along into "Checking…", where it describes nothing.
    const cleared =
      change.status && change.status !== 'error' ? { message: undefined, code: undefined } : {};
    this.state = { ...this.state, mode: this.mode, ...cleared, ...change };
    this.push(this.state);
  }
}
