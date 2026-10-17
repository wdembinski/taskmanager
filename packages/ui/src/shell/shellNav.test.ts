import { describe, expect, it } from 'vitest';
import { SHELL_NAV, type ShellNavEntry } from './shellNav';

describe('SHELL_NAV', () => {
  it('has unique ids', () => {
    const ids = SHELL_NAV.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('groups its entries bar → interim → foot, with no group out of order', () => {
    const order: Record<ShellNavEntry['group'], number> = { bar: 0, interim: 1, foot: 2 };
    const groups = SHELL_NAV.map((entry) => order[entry.group]);
    const sorted = [...groups].sort((a, b) => a - b);
    expect(groups).toEqual(sorted);
  });

  it('puts exactly the bar destinations in the bar group', () => {
    const bar = SHELL_NAV.filter((entry) => entry.group === 'bar').map((entry) => entry.id);
    expect(bar).toEqual(['tickets', 'mytasks', 'activity', 'performance', 'automations']);
  });

  it('puts exactly the interim destinations in the interim group', () => {
    const interim = SHELL_NAV.filter((entry) => entry.group === 'interim').map((entry) => entry.id);
    expect(interim).toEqual(['attention', 'projects', 'issues', 'fleet', 'scratch']);
  });

  it('puts exactly settings in the foot group', () => {
    const foot = SHELL_NAV.filter((entry) => entry.group === 'foot').map((entry) => entry.id);
    expect(foot).toEqual(['settings']);
  });

  it('has no reviews entry yet — F15 adds it', () => {
    const ids: readonly string[] = SHELL_NAV.map((entry) => entry.id);
    expect(ids.includes('reviews')).toBe(false);
  });

  it('gives every entry a non-empty label', () => {
    for (const entry of SHELL_NAV) {
      expect(entry.label.length, `${entry.id} has an empty label`).toBeGreaterThan(0);
    }
  });
});
