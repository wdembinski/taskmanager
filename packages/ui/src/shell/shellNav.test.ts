import { describe, expect, it } from 'vitest';
import { SHELL_NAV, type ShellNavEntry } from './shellNav';

describe('SHELL_NAV', () => {
  it('has unique ids', () => {
    const ids = SHELL_NAV.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('groups its entries bar → foot, with no group out of order', () => {
    const order: Record<ShellNavEntry['group'], number> = { bar: 0, foot: 1 };
    const groups = SHELL_NAV.map((entry) => order[entry.group]);
    const sorted = [...groups].sort((a, b) => a - b);
    expect(groups).toEqual(sorted);
  });

  it('puts exactly the bar destinations in the bar group', () => {
    const bar = SHELL_NAV.filter((entry) => entry.group === 'bar').map((entry) => entry.id);
    expect(bar).toEqual([
      'tickets',
      'mytasks',
      'activity',
      'reviews',
      'performance',
      'automations',
    ]);
  });

  it('F13.11 carries no interim-group tile — those five destinations reach their screen through the sidebar now', () => {
    const ids = SHELL_NAV.map((entry) => entry.id);
    for (const moved of ['attention', 'projects', 'issues', 'fleet', 'scratch']) {
      expect(ids.includes(moved as ShellNavEntry['id']), `${moved} still has a rail tile`).toBe(
        false,
      );
    }
  });

  it('puts exactly settings in the foot group', () => {
    const foot = SHELL_NAV.filter((entry) => entry.group === 'foot').map((entry) => entry.id);
    expect(foot).toEqual(['settings']);
  });

  it('F15.14b puts the Reviews tile third, after Activity — tickets, mytasks, activity, reviews, performance, automations | settings', () => {
    const rail = SHELL_NAV.map((entry) => `${entry.group}:${entry.id}`);
    expect(rail).toEqual([
      'bar:tickets',
      'bar:mytasks',
      'bar:activity',
      'bar:reviews',
      'bar:performance',
      'bar:automations',
      'foot:settings',
    ]);
  });

  it('gives every entry a non-empty label', () => {
    for (const entry of SHELL_NAV) {
      expect(entry.label.length, `${entry.id} has an empty label`).toBeGreaterThan(0);
    }
  });
});
