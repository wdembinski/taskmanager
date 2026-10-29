import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settings';
import { saveAndBroadcastSettings, type SettingsSaveDeps } from './settingsSave';

/**
 * A fake store over one blob plus a call log, so a test can ask both WHAT was broadcast and
 * WHEN — the broadcast must follow the save, never precede it.
 */
function harness(initial: AppSettings) {
  let blob = structuredClone(initial);
  const calls: string[] = [];
  const emitted: AppSettings[] = [];
  const deps: SettingsSaveDeps = {
    store: {
      getSettings: () => structuredClone(blob),
      saveSettings: (next) => {
        calls.push('save');
        blob = structuredClone(next);
      },
    },
    send: (channel, payload) => {
      calls.push(channel);
      emitted.push(payload);
    },
    syncPoller: { reschedule: () => calls.push('syncPoller') },
    cloudPoller: { reschedule: () => calls.push('cloudPoller') },
    cloudBoardPuller: { reschedule: () => calls.push('cloudBoardPuller') },
    pushSyncState: () => calls.push('pushSyncState'),
  };
  return { deps, calls, emitted, stored: () => blob };
}

const stored: AppSettings = {
  ...structuredClone(DEFAULT_SETTINGS),
  trustedGateCommands: ['machine-local-hash'],
};

describe('saveAndBroadcastSettings', () => {
  it('broadcasts the stored blob exactly once, after the save', () => {
    const h = harness(stored);
    const incoming: AppSettings = {
      ...structuredClone(stored),
      appearance: 'light',
      jira: { ...stored.jira, baseUrl: 'acme.atlassian.net/jira/your-work' },
      trustedGateCommands: ['from-a-relayed-blob'],
    };

    saveAndBroadcastSettings(h.deps, incoming);

    expect(h.calls.filter((c) => c === 'settings:changed')).toHaveLength(1);
    expect(h.calls.indexOf('save')).toBeLessThan(h.calls.indexOf('settings:changed'));
    expect(h.calls.at(-1)).toBe('settings:changed');
    const [payload] = h.emitted;
    expect(payload).toEqual(h.stored());
    expect(payload.appearance).toBe('light');
    expect(payload.jira.baseUrl).toBe('https://acme.atlassian.net');
    expect(payload.trustedGateCommands).toEqual(['machine-local-hash']);
  });

  it('still reschedules every poller and pushes the sync state', () => {
    const h = harness(stored);
    saveAndBroadcastSettings(h.deps, structuredClone(stored));
    expect(h.calls).toEqual([
      'save',
      'syncPoller',
      'cloudPoller',
      'cloudBoardPuller',
      'pushSyncState',
      'settings:changed',
    ]);
  });

  it.each([
    ['defaultModel', { defaultModel: 'not a model!' }],
    ['defaultPlanningModel', { defaultPlanningModel: 'rm -rf /' }],
  ] as const)('refuses an unusable %s without saving or broadcasting', (_field, patch) => {
    const h = harness(stored);
    expect(() =>
      saveAndBroadcastSettings(h.deps, { ...structuredClone(stored), ...patch }),
    ).toThrow(/Not a usable model/);
    expect(h.calls).toEqual([]);
    expect(h.emitted).toEqual([]);
  });

  it.each([
    ['an unknown effort', { ...DEFAULT_SETTINGS.defaultEfforts, workers: 'ultra' }],
    ['a non-object', 'high'],
  ])('refuses %s in defaultEfforts without saving', (_case, defaultEfforts) => {
    const h = harness(stored);
    expect(() =>
      saveAndBroadcastSettings(h.deps, {
        ...structuredClone(stored),
        defaultEfforts: defaultEfforts as unknown as AppSettings['defaultEfforts'],
      }),
    ).toThrow(/Not a usable/);
    expect(h.calls).toEqual([]);
  });

  it('saves a chosen set of default efforts', () => {
    const h = harness(stored);
    const defaultEfforts = {
      lead: 'max',
      planner: 'xhigh',
      workers: 'medium',
      reviewer: 'low',
    } as const;
    saveAndBroadcastSettings(h.deps, { ...structuredClone(stored), defaultEfforts });
    expect(h.stored().defaultEfforts).toEqual(defaultEfforts);
  });
});
