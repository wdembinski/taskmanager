/**
 * What closing the window should actually do (F1.10) — pure, unit-tested, and
 * deliberately ignorant of Electron. `index.ts`'s `window-all-closed` handler today
 * hard-codes "quit everywhere but darwin"; this is the decision table that behaviour
 * expands into once a `runInBackground` setting and a tray exist, kept here so the
 * logic can be tested without a `BrowserWindow`.
 *
 * `AppSettings` is not imported: the `runInBackground` field doesn't exist there yet
 * (next step adds it). `BackgroundModeSettings` is the structural subset this module
 * needs — once the real field lands, `AppSettings` satisfies it without this file
 * changing.
 */

/** What happens when the user closes the last window. */
export type CloseAction = 'quit' | 'keep-open' | 'hide-to-tray' | 'minimize';

/** The one setting this decision depends on. */
export interface BackgroundModeSettings {
  runInBackground: boolean;
}

/**
 * Decide what a window close should do.
 *
 * `runInBackground` off keeps today's behaviour exactly: `darwin` stays open with no
 * window (the dock icon re-opens one), everywhere else quits. On, the app instead
 * keeps running — behind a tray icon where one is available, or just minimized to
 * the taskbar/dock where it isn't (so there's still a way back to the window).
 */
export function closeAction(
  platform: NodeJS.Platform,
  settings: BackgroundModeSettings,
  trayAvailable: boolean,
): CloseAction {
  if (!settings.runInBackground) return platform === 'darwin' ? 'keep-open' : 'quit';
  return trayAvailable ? 'hide-to-tray' : 'minimize';
}

/** Whether `closeAction` resolves to an actual quit — the one case with no window left to return to. */
export function shouldQuitOnClose(
  platform: NodeJS.Platform,
  settings: BackgroundModeSettings,
  trayAvailable: boolean,
): boolean {
  return closeAction(platform, settings, trayAvailable) === 'quit';
}

/**
 * Whether a tray icon is likely to work on this machine, before anyone has tried to
 * create one. WSLg — the Linux GUI layer WSL ships — forwards windows through a
 * Wayland/X compositor with no status-notifier host behind it, so `new Tray()` either
 * throws or produces an icon nothing can ever show. Detected the same way the rest of
 * the app tells WSL apart from a real Linux desktop: the environment variables WSL
 * sets for every process running under it.
 *
 * This is a prediction, not a guarantee — real Linux desktops vary too. The caller
 * still has to treat a throwing `new Tray()` as unavailable; this just avoids trying
 * in the one case known to be hopeless.
 */
export function trayLikelyAvailable(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform === 'linux' && (env.WSL_DISTRO_NAME ?? env.WSL_INTEROP)) return false;
  return true;
}

/** One row of the tray's right-click menu. */
export interface TrayMenuItem {
  id: 'open' | 'pause' | 'quit' | 'separator';
  label?: string;
  enabled?: boolean;
  checked?: boolean;
}

/**
 * The tray menu's contents, as data `appTray.ts` turns into an Electron `Menu`.
 * Separated out so the menu's shape — what's in it, when "Pause automations" is
 * enabled/checked — is a pure function of state instead of being buried in Electron
 * menu-template code nothing can unit-test.
 */
export function trayMenuModel(state: {
  canPauseAutomations: boolean;
  automationsPaused: boolean;
}): ReadonlyArray<TrayMenuItem> {
  return [
    { id: 'open', label: 'Open' },
    { id: 'separator' },
    {
      id: 'pause',
      label: 'Pause automations',
      enabled: state.canPauseAutomations,
      checked: state.automationsPaused,
    },
    { id: 'separator' },
    { id: 'quit', label: 'Quit' },
  ];
}
