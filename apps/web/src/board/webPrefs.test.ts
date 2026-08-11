/**
 * The board preferences this browser remembers. The rule under test is that reading them can
 * never fail: the store is a JSON blob under a key anything can leave in any shape, and the
 * board has to open either way — with whatever was legible, and the defaults for the rest.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_BOARD_DISPLAY } from '@tm/shared/settings';
import { DEFAULT_WEB_BOARD_PREFS, loadBoardPrefs, saveBoardPrefs } from './webPrefs';

const KEY = 'tm.cloud.boardPrefs';

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe('loadBoardPrefs / saveBoardPrefs', () => {
  it('round-trips everything the toolbar can change', () => {
    const storage = fakeStorage();
    const prefs = {
      showDone: true,
      display: { ...DEFAULT_BOARD_DISPLAY, showEpicName: true, priorityDisplay: 'mono' as const },
      showDetail: false,
    };
    saveBoardPrefs(storage, prefs);
    expect(loadBoardPrefs(storage)).toEqual(prefs);
  });

  it('opens with the desktop’s defaults for a browser that has never been here', () => {
    expect(loadBoardPrefs(fakeStorage())).toEqual(DEFAULT_WEB_BOARD_PREFS);
    expect(DEFAULT_WEB_BOARD_PREFS.showDone).toBe(false);
    expect(DEFAULT_WEB_BOARD_PREFS.showDetail).toBe(true);
    expect(DEFAULT_WEB_BOARD_PREFS.display).toEqual(DEFAULT_BOARD_DISPLAY);
  });

  it('falls back to the defaults for a blob that is not JSON at all', () => {
    const storage = fakeStorage();
    storage.setItem(KEY, '{"showDone":tru');
    expect(loadBoardPrefs(storage)).toEqual(DEFAULT_WEB_BOARD_PREFS);
  });

  it('falls back for JSON that is not an object', () => {
    const storage = fakeStorage();
    for (const raw of ['null', '7', '"showDone"', '[]']) {
      storage.setItem(KEY, raw);
      // `[]` is an object, and every field it can be asked for is missing — same answer.
      expect(loadBoardPrefs(storage)).toEqual(DEFAULT_WEB_BOARD_PREFS);
    }
  });

  it('keeps the fields it can read and defaults the ones it cannot', () => {
    const storage = fakeStorage();
    // Each bad value is chosen to be TRUTHY where its default is false, and falsy where its
    // default is true — so a reader that coerced instead of checking the type would answer
    // differently on both, and this test would say so.
    storage.setItem(KEY, JSON.stringify({ showDone: 'yes', showDetail: 0, display: null }));
    const prefs = loadBoardPrefs(storage);
    expect(prefs.showDone).toBe(false);
    expect(prefs.showDetail).toBe(true);
    // `display: null` is the one that would take the board down rather than merely lie: the
    // first card to ask it what to draw would read a property off null.
    expect(prefs.display).toEqual(DEFAULT_BOARD_DISPLAY);
  });

  it('reads the Display menu switch by switch', () => {
    const storage = fakeStorage();
    storage.setItem(
      KEY,
      // `showLabels` is legible and the opposite of its default, so it has to have been
      // READ; the other two are the truthy/falsy pair a coercing reader would get wrong.
      JSON.stringify({ display: { showLabels: false, showProjectName: 0, showEpicName: 'yes' } }),
    );
    expect(loadBoardPrefs(storage).display).toEqual({
      showLabels: false,
      showProjectName: DEFAULT_BOARD_DISPLAY.showProjectName,
      showEpicName: DEFAULT_BOARD_DISPLAY.showEpicName,
      priorityDisplay: DEFAULT_BOARD_DISPLAY.priorityDisplay,
    });
  });

  it('keeps this browser’s preferences apart from the desktop’s settings blob', () => {
    // The shape a settings blob would arrive in if anything ever wrote one here. Nothing in
    // it is a preference this toolbar owns, and every field falls back rather than half of
    // the board coming up configured by a stranger.
    const storage = fakeStorage();
    storage.setItem(KEY, JSON.stringify({ jira: { showDoneColumn: true }, showTaskDetail: false }));
    expect(loadBoardPrefs(storage)).toEqual(DEFAULT_WEB_BOARD_PREFS);
  });

  it('refuses a priority display the cards have no drawing for', () => {
    const storage = fakeStorage();
    storage.setItem(KEY, JSON.stringify({ display: { priorityDisplay: 'rainbow' } }));
    expect(loadBoardPrefs(storage).display.priorityDisplay).toBe(
      DEFAULT_BOARD_DISPLAY.priorityDisplay,
    );
  });

  it('does not throw when the browser refuses to store anything', () => {
    const storage = {
      ...fakeStorage(),
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    } as unknown as Storage;
    expect(() => saveBoardPrefs(storage, DEFAULT_WEB_BOARD_PREFS)).not.toThrow();
  });
});
