/**
 * The board preferences this tab remembers: whether DONE is open, which optional lines the
 * cards draw, and whether the detail pane is showing.
 *
 * The desktop keeps all three in its settings blob and writes them through `settings:save`
 * (see `MyTasks.tsx`'s `setShowDone`/`saveDisplay`/`setShowDetail`). There is no such round
 * trip here — they are not mirrored, and no `CommandEnvelope` kind carries a setting — so
 * they live in `localStorage`, which `clientId.ts` already established as this app's small
 * per-browser store. That also happens to be the right home for them: these are facts about
 * one browser's view of the board, not about the account, and a Display menu toggled on a
 * laptop has no business changing what the desktop draws.
 *
 * Everything is read defensively. This is a JSON blob under a key any extension, any earlier
 * build of this app, or a half-finished write can leave in a shape that no longer matches —
 * and a board that throws on boot because a preference is a string would be a far worse
 * outcome than a board that opens with the defaults.
 */
import { DEFAULT_BOARD_DISPLAY, type BoardDisplaySettings } from '@tm/shared/settings';

/** The key this blob lives under. Namespaced like `clientId`'s, for the same reason. */
const STORAGE_KEY = 'tm.cloud.boardPrefs';

export interface WebBoardPrefs {
  /** The DONE column, open or shut. Shut by default, exactly as on the desktop. */
  showDone: boolean;
  /** Which optional lines the cards draw — the Display menu's value. */
  display: BoardDisplaySettings;
  /** The detail pane, showing or folded away. Showing by default, as on the desktop. */
  showDetail: boolean;
}

/** What a browser that has never been here sees — the desktop's own defaults. */
export const DEFAULT_WEB_BOARD_PREFS: WebBoardPrefs = {
  showDone: false,
  display: DEFAULT_BOARD_DISPLAY,
  showDetail: true,
};

/** The three values `priorityDisplay` can hold — anything else came from somewhere else. */
const PRIORITY_DISPLAY = new Set<BoardDisplaySettings['priorityDisplay']>(['color', 'mono', 'off']);

/**
 * The stored preferences, or the defaults for anything missing, malformed or absent.
 *
 * Field by field rather than `{...DEFAULT, ...parsed}`: a spread would happily install
 * `showDone: 'yes'` and `display: null`, and the first would make the DONE column depend on
 * a truthy string while the second would crash the first card that asked what to draw.
 */
export function loadBoardPrefs(storage: Storage): WebBoardPrefs {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_WEB_BOARD_PREFS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Someone else's key, a truncated write, a hand-edited value: the defaults are a
    // complete answer, and there is nothing here worth reporting to whoever opened the tab.
    return DEFAULT_WEB_BOARD_PREFS;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_WEB_BOARD_PREFS;
  const blob = parsed as Partial<Record<keyof WebBoardPrefs, unknown>>;
  return {
    showDone: bool(blob.showDone, DEFAULT_WEB_BOARD_PREFS.showDone),
    display: display(blob.display),
    showDetail: bool(blob.showDetail, DEFAULT_WEB_BOARD_PREFS.showDetail),
  };
}

/**
 * Write them back. Failures are swallowed on purpose: `setItem` throws when storage is full
 * or blocked (Safari's private mode, a locked-down profile), and a preference that cannot be
 * remembered must not take the click that changed it down with it — the switch still works
 * for this session, it just won't survive a reload.
 */
export function saveBoardPrefs(storage: Storage, prefs: WebBoardPrefs): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* not remembered, still applied */
  }
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** The Display menu's value, each switch read on its own so one bad field costs one field. */
function display(value: unknown): BoardDisplaySettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_BOARD_DISPLAY;
  const blob = value as Partial<Record<keyof BoardDisplaySettings, unknown>>;
  const priority = blob.priorityDisplay as BoardDisplaySettings['priorityDisplay'];
  return {
    showLabels: bool(blob.showLabels, DEFAULT_BOARD_DISPLAY.showLabels),
    showProjectName: bool(blob.showProjectName, DEFAULT_BOARD_DISPLAY.showProjectName),
    showEpicName: bool(blob.showEpicName, DEFAULT_BOARD_DISPLAY.showEpicName),
    priorityDisplay: PRIORITY_DISPLAY.has(priority)
      ? priority
      : DEFAULT_BOARD_DISPLAY.priorityDisplay,
  };
}
