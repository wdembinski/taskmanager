import { describe, expect, it } from 'vitest';
import { DEFAULT_LINEAR_SETTINGS } from '@tm/shared/settings';
import type { LinearSettings } from '@tm/shared/settings';
import { describeLinearSettings } from './linearSettingsView';

function row(rows: ReturnType<typeof describeLinearSettings>, label: string): string | undefined {
  return rows.find((r) => r.label === label)?.value;
}

describe('describeLinearSettings', () => {
  it('reads the defaults — off, no teams, scoped to your own open issues', () => {
    const rows = describeLinearSettings(DEFAULT_LINEAR_SETTINGS);
    expect(row(rows, 'Sync')).toBe('Off');
    expect(row(rows, 'Teams')).toBe('None — nothing is mirrored');
    expect(row(rows, 'Assignee')).toBe('Me');
    expect(row(rows, 'Included state types')).toBe('Triage, Backlog, Unstarted, Started');
    expect(row(rows, 'Advanced filter')).toBe('None');
    expect(row(rows, 'Keep finished cards for')).toBe('14 days');
    expect(row(rows, 'Column overrides')).toBe('0');
  });

  it('joins teamKeys when some are configured', () => {
    const linear: LinearSettings = { ...DEFAULT_LINEAR_SETTINGS, teamKeys: ['ENG', 'DES'] };
    expect(row(describeLinearSettings(linear), 'Teams')).toBe('ENG, DES');
  });

  it('orders included state types by LINEAR_STATE_TYPE_ORDER, not insertion order', () => {
    const linear: LinearSettings = {
      ...DEFAULT_LINEAR_SETTINGS,
      includeStateTypes: ['completed', 'triage', 'started'],
    };
    expect(row(describeLinearSettings(linear), 'Included state types')).toBe(
      'Triage, Started, Completed',
    );
  });

  it('reads "None" for a blank advanced filter', () => {
    expect(
      row(
        describeLinearSettings({ ...DEFAULT_LINEAR_SETTINGS, advancedFilter: '' }),
        'Advanced filter',
      ),
    ).toBe('None');
    expect(
      row(
        describeLinearSettings({ ...DEFAULT_LINEAR_SETTINGS, advancedFilter: undefined }),
        'Advanced filter',
      ),
    ).toBe('None');
  });

  it('shows the raw advanced filter text when set', () => {
    const linear: LinearSettings = {
      ...DEFAULT_LINEAR_SETTINGS,
      advancedFilter: '{"priority": 1}',
    };
    expect(row(describeLinearSettings(linear), 'Advanced filter')).toBe('{"priority": 1}');
  });

  it('adds a per-team column targets row for a populated columnTargetStates', () => {
    const linear: LinearSettings = {
      ...DEFAULT_LINEAR_SETTINGS,
      columnTargetStates: {
        ENG: { 'in-progress': 'In Progress', done: 'Done' },
      },
    };
    const rows = describeLinearSettings(linear);
    expect(row(rows, 'ENG column targets')).toBe('in-progress: In Progress, done: Done');
  });
});
