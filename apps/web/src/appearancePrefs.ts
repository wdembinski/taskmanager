/**
 * The web's own copy of `appearance`/`transparency` — backed by `localStorage` rather than
 * the desktop's SQLite settings row, since a browser tab has no store of its own to read
 * them from. Read, write and the change subscription all live here so the eventual
 * Settings UI that lets a browser user change them (a later step) has exactly one place to
 * do it from, the same shape `webLastSeen.ts` gives the Activity tab's own localStorage key.
 */
import type { AppearanceSetting, TransparencySetting } from '@tm/shared/settings';

export interface AppearancePrefs {
  appearance: AppearanceSetting;
  transparency: TransparencySetting;
}

/** No stored prefs yet reads as the OS's own preference for both — the same answer a
 *  fresh desktop install gets from `DEFAULT_SETTINGS`. */
export const DEFAULT_APPEARANCE_PREFS: AppearancePrefs = {
  appearance: 'system',
  transparency: 'system',
};

const STORAGE_KEY = 'tm.appearancePrefs';

/** `localStorage`'s own `storage` event never fires in the tab that made the write — this
 *  is the same-tab half of the signal, dispatched by {@link writeAppearancePrefs}. */
const CHANGE_EVENT = 'tm:appearancePrefs';

function isAppearanceSetting(value: unknown): value is AppearanceSetting {
  return value === 'system' || value === 'light' || value === 'dark';
}

function isTransparencySetting(value: unknown): value is TransparencySetting {
  return value === 'system' || value === 'reduced' || value === 'full';
}

/**
 * Reads the saved prefs, or the default — a first visit, a corrupt stored value, or a
 * `Storage` that throws on `getItem` (private browsing, a disabled store) all read as the
 * default rather than throwing. Each field is validated on its own, so a blob that is
 * otherwise fine but carries a garbage `appearance` still keeps a valid `transparency`.
 */
export function readAppearancePrefs(storage: Storage): AppearancePrefs {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_APPEARANCE_PREFS;
    const parsed = JSON.parse(raw) as Partial<AppearancePrefs>;
    return {
      appearance: isAppearanceSetting(parsed.appearance)
        ? parsed.appearance
        : DEFAULT_APPEARANCE_PREFS.appearance,
      transparency: isTransparencySetting(parsed.transparency)
        ? parsed.transparency
        : DEFAULT_APPEARANCE_PREFS.transparency,
    };
  } catch {
    return DEFAULT_APPEARANCE_PREFS;
  }
}

/**
 * Persists the prefs and fires {@link CHANGE_EVENT} so any reader mounted in THIS tab picks
 * it up immediately. A `Storage` whose `setItem` throws loses the persistence, not the
 * notification — callers still learn their own change, same reasoning as `webLastSeen.ts`'s
 * `saveWebLastSeen`.
 */
export function writeAppearancePrefs(storage: Storage, prefs: AppearancePrefs): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Swallowed on purpose — see this function's own docstring.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * Subscribes to every way the prefs can change: this tab's own writes ({@link CHANGE_EVENT})
 * and another tab's (the native `storage` event — `key` is `null` on a `localStorage.clear()`,
 * which must also be treated as a change rather than ignored). Returns the unsubscribe
 * function, the same shape `window.api.on` returns on the desktop.
 */
export function onAppearancePrefsChange(listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === STORAGE_KEY) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}
