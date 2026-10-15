import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@tm/shared/settings';
import type { LinearStateOption } from '@tm/shared/ipc';
import {
  buildLinearTargetRows,
  clampRetentionDays,
  LINEAR_STATE_TYPE_ORDER,
  patchLinear,
  setColumnTargetState,
  toggleStateType,
  toggleTeamKey,
  validateAdvancedFilter,
} from './linearSettingsForm';

function state(name: string, position: number): LinearStateOption {
  return { id: name, name, type: 'started', position, column: 'in-progress' };
}

describe('patchLinear', () => {
  it('merges the change into settings.linear, leaving the rest untouched', () => {
    const next = patchLinear(DEFAULT_SETTINGS, { enabled: true });
    expect(next.linear).toEqual({ ...DEFAULT_SETTINGS.linear, enabled: true });
    expect(next.defaultModel).toBe(DEFAULT_SETTINGS.defaultModel);
  });

  it('never mutates the settings it was given', () => {
    const before = JSON.stringify(DEFAULT_SETTINGS);
    patchLinear(DEFAULT_SETTINGS, { enabled: true });
    expect(JSON.stringify(DEFAULT_SETTINGS)).toBe(before);
  });
});

describe('toggleTeamKey', () => {
  it('adds a key, upper-cased', () => {
    expect(toggleTeamKey([], 'eng')).toEqual(['ENG']);
  });

  it('removes a key already present, matched case-insensitively', () => {
    expect(toggleTeamKey(['ENG'], 'eng')).toEqual([]);
  });

  it('dedupes the existing list even when the toggle adds a new key', () => {
    expect(toggleTeamKey(['eng', 'ENG'], 'des')).toEqual(['ENG', 'DES']);
  });

  it('leaves the list untouched for a blank key', () => {
    expect(toggleTeamKey(['ENG'], '   ')).toEqual(['ENG']);
  });
});

describe('toggleStateType', () => {
  it('adds a type, sorted back into canonical order', () => {
    expect(toggleStateType(['started'], 'backlog')).toEqual(['backlog', 'started']);
  });

  it('removes a type already present', () => {
    expect(toggleStateType(['triage', 'started'], 'triage')).toEqual(['started']);
  });

  it('matches LINEAR_STATE_TYPE_ORDER', () => {
    expect(LINEAR_STATE_TYPE_ORDER).toEqual([
      'triage',
      'backlog',
      'unstarted',
      'started',
      'completed',
      'canceled',
    ]);
  });
});

describe('validateAdvancedFilter', () => {
  it('treats blank text as "nothing extra"', () => {
    expect(validateAdvancedFilter('')).toEqual({ ok: true, value: undefined });
    expect(validateAdvancedFilter('   ')).toEqual({ ok: true, value: undefined });
  });

  it('accepts a JSON object, trimmed', () => {
    expect(validateAdvancedFilter('  { "priority": { "gte": 2 } }  ')).toEqual({
      ok: true,
      value: '{ "priority": { "gte": 2 } }',
    });
  });

  it('rejects invalid JSON', () => {
    const result = validateAdvancedFilter('{ not json');
    expect(result.ok).toBe(false);
  });

  it('rejects a JSON array', () => {
    expect(validateAdvancedFilter('[1, 2]')).toEqual({
      ok: false,
      message: 'Linear advanced filter must be a JSON object.',
    });
  });

  it('rejects a JSON primitive', () => {
    expect(validateAdvancedFilter('"eng"')).toEqual({
      ok: false,
      message: 'Linear advanced filter must be a JSON object.',
    });
  });

  it('rejects JSON null', () => {
    expect(validateAdvancedFilter('null')).toEqual({
      ok: false,
      message: 'Linear advanced filter must be a JSON object.',
    });
  });
});

describe('clampRetentionDays', () => {
  it('rounds to the nearest integer', () => {
    expect(clampRetentionDays(3.6)).toBe(4);
  });

  it('floors negative values at zero', () => {
    expect(clampRetentionDays(-5)).toBe(0);
  });
});

describe('setColumnTargetState', () => {
  it('sets a state for a team and column', () => {
    expect(setColumnTargetState({}, 'ENG', 'todo', 'Backlog')).toEqual({
      ENG: { todo: 'Backlog' },
    });
  });

  it('trims the state name', () => {
    expect(setColumnTargetState({}, 'ENG', 'todo', '  Backlog  ')).toEqual({
      ENG: { todo: 'Backlog' },
    });
  });

  it("clears one column without touching the team's other columns", () => {
    const map = { ENG: { todo: 'Backlog', done: 'Done' } };
    expect(setColumnTargetState(map, 'ENG', 'todo', '')).toEqual({ ENG: { done: 'Done' } });
  });

  it('drops the team entirely once its last column is cleared', () => {
    const map = { ENG: { todo: 'Backlog' } };
    expect(setColumnTargetState(map, 'ENG', 'todo', '')).toEqual({});
  });

  it('never mutates the map it was given', () => {
    const map = { ENG: { todo: 'Backlog' } };
    const before = JSON.stringify(map);
    setColumnTargetState(map, 'ENG', 'done', 'Done');
    expect(JSON.stringify(map)).toBe(before);
  });

  it('leaves other teams untouched', () => {
    const map = { ENG: { todo: 'Backlog' }, DES: { done: 'Shipped' } };
    expect(setColumnTargetState(map, 'ENG', 'todo', '')).toEqual({ DES: { done: 'Shipped' } });
  });
});

describe('buildLinearTargetRows', () => {
  const states = [state('In Review', 2), state('In Progress', 1)];

  it('returns one row per board column, in board order', () => {
    const rows = buildLinearTargetRows('ENG', states, {}, undefined);
    expect(rows.map((r) => r.column)).toEqual([
      'todo',
      'in-progress',
      'in-review',
      'blocked',
      'done',
    ]);
  });

  it('marks blocked local-only with no selection', () => {
    const rows = buildLinearTargetRows('ENG', states, {}, undefined);
    const blocked = rows.find((r) => r.column === 'blocked')!;
    expect(blocked.localOnly).toBe(true);
    expect(blocked.selected).toBe('');
    expect(blocked.fromLearned).toBe(false);
  });

  it('prefers the explicitly configured state over anything learned', () => {
    const rows = buildLinearTargetRows(
      'ENG',
      states,
      { ENG: { 'in-progress': 'In Progress' } },
      { 'In Review': 'in-progress' },
    );
    const row = rows.find((r) => r.column === 'in-progress')!;
    expect(row.selected).toBe('In Progress');
    expect(row.fromLearned).toBe(false);
  });

  it('falls back to a learned state when nothing is configured', () => {
    const rows = buildLinearTargetRows('ENG', states, {}, { 'In Review': 'in-progress' });
    const row = rows.find((r) => r.column === 'in-progress')!;
    expect(row.selected).toBe('In Review');
    expect(row.fromLearned).toBe(true);
  });

  it('picks the lowest-position state when more than one was learned for a column', () => {
    const rows = buildLinearTargetRows(
      'ENG',
      states,
      {},
      {
        'In Review': 'in-progress',
        'In Progress': 'in-progress',
      },
    );
    const row = rows.find((r) => r.column === 'in-progress')!;
    expect(row.selected).toBe('In Progress');
    expect(row.fromLearned).toBe(true);
  });

  it('leaves a column unselected when nothing is configured or learned for it', () => {
    const rows = buildLinearTargetRows('ENG', states, {}, undefined);
    const row = rows.find((r) => r.column === 'todo')!;
    expect(row.selected).toBe('');
    expect(row.fromLearned).toBe(false);
  });

  it("is scoped to the given team, ignoring another team's configuration", () => {
    const rows = buildLinearTargetRows(
      'ENG',
      states,
      { DES: { 'in-progress': 'In Progress' } },
      undefined,
    );
    const row = rows.find((r) => r.column === 'in-progress')!;
    expect(row.selected).toBe('');
  });
});
