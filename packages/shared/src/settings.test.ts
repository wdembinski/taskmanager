import { describe, expect, it } from 'vitest';
import {
  clampSyncInterval,
  DEFAULT_BOARD_DISPLAY,
  DEFAULT_JIRA_SETTINGS,
  DEFAULT_SETTINGS,
  GLOBAL_SETTINGS_KEYS,
  MAX_SYNC_INTERVAL_MINUTES,
  mergeAppSettings,
  pickGlobalSettings,
  resolveSyncInterval,
  type AppSettings,
} from './settings';

describe('clampSyncInterval', () => {
  it('rounds and floors at 0, as before', () => {
    expect(clampSyncInterval(2.4)).toBe(2);
    expect(clampSyncInterval(2.5)).toBe(3);
    expect(clampSyncInterval(-5)).toBe(0);
  });

  // The actual bug: a value past the 32-bit `setInterval` delay overflows silently to a
  // ~1ms timer instead of throwing, so an unbounded interval reads as "sync continuously"
  // rather than "sync rarely". Anything past the UI's own max must be capped here too.
  it('caps at MAX_SYNC_INTERVAL_MINUTES rather than passing an oversized value through', () => {
    expect(clampSyncInterval(MAX_SYNC_INTERVAL_MINUTES + 1)).toBe(MAX_SYNC_INTERVAL_MINUTES);
    expect(clampSyncInterval(999_999_999)).toBe(MAX_SYNC_INTERVAL_MINUTES);
  });

  // Non-finite input cannot mean an actual cadence, and `setInterval` clamps it to ~1ms the
  // same as an overflow would — so it reads as "off", not "as fast as possible".
  it('treats non-finite input as off, not as fast as possible', () => {
    expect(clampSyncInterval(NaN)).toBe(0);
    expect(clampSyncInterval(Infinity)).toBe(0);
    expect(clampSyncInterval(-Infinity)).toBe(0);
  });
});

describe('resolveSyncInterval', () => {
  it('leaves an already-migrated blob alone', () => {
    expect(resolveSyncInterval({ syncIntervalMinutes: 7 })).toBe(7);
    // Including an explicit 0, which means "auto-sync off" and is not a missing value.
    expect(resolveSyncInterval({ syncIntervalMinutes: 0 })).toBe(0);
  });

  // The safe direction for a setting nobody asked to have changed: a user who had GitLab on
  // 2 minutes must not silently drop to JIRA's 5 because the two timers became one.
  it('takes the SHORTER of the two it replaces, so nothing gets staler', () => {
    expect(
      resolveSyncInterval({ jira: { pollIntervalMinutes: 5 }, gitlab: { pollIntervalMinutes: 2 } }),
    ).toBe(2);
    expect(
      resolveSyncInterval({ jira: { pollIntervalMinutes: 1 }, gitlab: { pollIntervalMinutes: 9 } }),
    ).toBe(1);
  });

  // A 0 on one side is "that integration was switched off", not "never sync" — letting it
  // win the minimum would silently disable background sync for the one still in use.
  it('ignores a switched-off integration rather than letting its 0 win', () => {
    expect(
      resolveSyncInterval({ jira: { pollIntervalMinutes: 0 }, gitlab: { pollIntervalMinutes: 2 } }),
    ).toBe(2);
    expect(
      resolveSyncInterval({ jira: { pollIntervalMinutes: 5 }, gitlab: { pollIntervalMinutes: 0 } }),
    ).toBe(5);
  });

  it('keeps auto-sync off when BOTH were off', () => {
    expect(
      resolveSyncInterval({ jira: { pollIntervalMinutes: 0 }, gitlab: { pollIntervalMinutes: 0 } }),
    ).toBe(0);
  });

  it('falls back to the shipped default for a blob that predates either setting', () => {
    expect(resolveSyncInterval({})).toBe(DEFAULT_SETTINGS.syncIntervalMinutes);
    expect(resolveSyncInterval({ jira: {}, gitlab: {} })).toBe(
      DEFAULT_SETTINGS.syncIntervalMinutes,
    );
  });

  it('never returns a negative interval', () => {
    expect(resolveSyncInterval({ syncIntervalMinutes: -5 })).toBe(0);
  });
});

describe('mergeAppSettings', () => {
  it('keeps a field the caller did not send', () => {
    const current = { ...DEFAULT_SETTINGS, branchPrefix: 'learned/' };
    const merged = mergeAppSettings(current, { concurrency: 4 });
    expect(merged.concurrency).toBe(4);
    expect(merged.branchPrefix).toBe('learned/');
  });

  it('merges a nested group field-by-field rather than replacing it', () => {
    // The realistic staleness: the engine learned a JIRA base URL after the tab loaded, and
    // the tab is saving a `jira` block that predates it.
    const current = {
      ...DEFAULT_SETTINGS,
      jira: { ...DEFAULT_JIRA_SETTINGS, baseUrl: 'https://jira.example.com', enabled: true },
    };
    const merged = mergeAppSettings(current, { jira: { showDoneColumn: true } });
    expect(merged.jira.showDoneColumn).toBe(true);
    expect(merged.jira.baseUrl).toBe('https://jira.example.com');
    expect(merged.jira.enabled).toBe(true);
  });

  it('replaces an array wholesale, so a removal is not undone', () => {
    const current = { ...DEFAULT_SETTINGS, foldedStepCards: ['a', 'b', 'c'] };
    const merged = mergeAppSettings(current, { foldedStepCards: ['a'] });
    expect(merged.foldedStepCards).toEqual(['a']);
  });

  it('ignores an explicit undefined rather than clearing the field', () => {
    const current = { ...DEFAULT_SETTINGS, branchPrefix: 'keep/' };
    const merged = mergeAppSettings(current, { branchPrefix: undefined });
    expect(merged.branchPrefix).toBe('keep/');
  });

  it('applies a null, which is a real value for the nullable fields', () => {
    const current = { ...DEFAULT_SETTINGS, defaultPlanningModel: 'opus' as const };
    const merged = mergeAppSettings(current, { defaultPlanningModel: null });
    expect(merged.defaultPlanningModel).toBeNull();
  });

  it('ignores something that is not an object at all', () => {
    // It arrived over HTTP as JSON — partially applying a string would be worse than nothing.
    expect(mergeAppSettings(DEFAULT_SETTINGS, 'nonsense')).toEqual(DEFAULT_SETTINGS);
    expect(mergeAppSettings(DEFAULT_SETTINGS, null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeAppSettings(DEFAULT_SETTINGS, [1, 2])).toEqual(DEFAULT_SETTINGS);
  });

  it('does not mutate the settings it was given', () => {
    const current = { ...DEFAULT_SETTINGS, jira: { ...DEFAULT_JIRA_SETTINGS } };
    mergeAppSettings(current, { concurrency: 9, jira: { enabled: true } });
    expect(current.concurrency).toBe(DEFAULT_SETTINGS.concurrency);
    expect(current.jira.enabled).toBe(false);
  });

  // `boardScopeId` replaces wholesale like every other plain string field — a save that
  // switches boards must apply the new value, not be mistaken for a field the caller omitted.
  it('applies a new boardScopeId, switching boards', () => {
    const current = { ...DEFAULT_SETTINGS, boardScopeId: 'ticket-project-1' };
    const merged = mergeAppSettings(current, { boardScopeId: 'all' });
    expect(merged.boardScopeId).toBe('all');
  });
});

// A blob written before Phase 24 (native tickets) has no `board.showAssignee`/`showPoints`
// and no `boardScopeId` at all — the defaults below are what such a blob fills in as, and
// they are what keeps a board with no ticket project drawing exactly as it always has.
describe('DEFAULT_SETTINGS / DEFAULT_BOARD_DISPLAY (Phase 24 fields)', () => {
  it('scopes to every board out of the box', () => {
    expect(DEFAULT_SETTINGS.boardScopeId).toBe('all');
  });

  it('draws no assignee avatar or points chip out of the box', () => {
    expect(DEFAULT_BOARD_DISPLAY.showAssignee).toBe(false);
    expect(DEFAULT_BOARD_DISPLAY.showPoints).toBe(false);
  });
});

// The Gantt timeline's own settings group (Phase 24 step 6) — a blob written before it has
// no `gantt` field at all, and this is what a missing field fills in as.
describe('DEFAULT_SETTINGS.gantt', () => {
  it('opens every epic expanded out of the box', () => {
    expect(DEFAULT_SETTINGS.gantt.collapsedEpicIds).toEqual([]);
  });

  it('merges field-by-field and replaces its array wholesale, like every other nested group', () => {
    const current = { ...DEFAULT_SETTINGS, gantt: { collapsedEpicIds: ['e1', 'e2'] } };
    const merged = mergeAppSettings(current, { gantt: { collapsedEpicIds: ['e1'] } });
    expect(merged.gantt.collapsedEpicIds).toEqual(['e1']);
  });
});

/**
 * The machine-local / per-surface keys — the complement of {@link GLOBAL_SETTINGS_KEYS}.
 * Spelled out rather than derived, so the "every key is classified" test below is a real gate:
 * a field added to `AppSettings` and to neither list fails the suite until it is classified.
 */
const LOCAL_SETTINGS_KEYS: ReadonlyArray<keyof AppSettings> = [
  'defaultExecTarget',
  'fontSizePx',
  'toastsEnabled',
  'cloud',
  'boardScopeId',
  'foldedStepCards',
  'shownEarlierStepCards',
  'gantt',
];

describe('pickGlobalSettings', () => {
  it('keeps account-scoped fields', () => {
    const picked = pickGlobalSettings(DEFAULT_SETTINGS);
    expect(picked.defaultModel).toBe(DEFAULT_SETTINGS.defaultModel);
    expect(picked.jira).toEqual(DEFAULT_SETTINGS.jira);
    expect(picked.board).toEqual(DEFAULT_SETTINGS.board);
    expect(picked.statusKeywords).toEqual(DEFAULT_SETTINGS.statusKeywords);
  });

  it('strips every machine-local and per-surface field — they never cross the wire', () => {
    const picked = pickGlobalSettings({
      ...DEFAULT_SETTINGS,
      fontSizePx: 20,
      boardScopeId: 'proj-1',
      foldedStepCards: ['t1'],
      cloud: { ...DEFAULT_SETTINGS.cloud, baseUrl: 'https://mine.example' },
    });
    for (const key of LOCAL_SETTINGS_KEYS) {
      expect(picked, `local key ${String(key)} must be absent`).not.toHaveProperty(String(key));
    }
  });

  it('copies only keys that are present — a partial patch stays partial', () => {
    const picked = pickGlobalSettings({ branchPrefix: 'wd', fontSizePx: 18 });
    expect(picked).toEqual({ branchPrefix: 'wd' });
  });

  it('ignores unknown keys and non-objects', () => {
    expect(pickGlobalSettings({ nonsense: 1, defaultModel: 'opus' })).toEqual({
      defaultModel: 'opus',
    });
    expect(pickGlobalSettings(null)).toEqual({});
    expect(pickGlobalSettings('nope')).toEqual({});
    expect(pickGlobalSettings(['a'])).toEqual({});
  });

  it('classifies every AppSettings key exactly once — global XOR local', () => {
    const global = new Set<string>(GLOBAL_SETTINGS_KEYS);
    const local = new Set<string>(LOCAL_SETTINGS_KEYS.map(String));
    const allKeys = Object.keys(DEFAULT_SETTINGS);

    for (const key of global) {
      expect(local.has(key), `${key} is in both global and local`).toBe(false);
    }
    expect(new Set([...global, ...local])).toEqual(new Set(allKeys));
  });
});
