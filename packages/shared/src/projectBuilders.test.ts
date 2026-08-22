import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './settings';
import { buildProject, normalizeEpicKeys, toProjectKind } from './projectBuilders';

describe('buildProject', () => {
  it('builds a plan project from a path, seeding unspecified fields from defaults', () => {
    const project = buildProject({ path: 'C:\\Repositories\\my-app' }, DEFAULT_SETTINGS);
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project.name).toBe('my-app');
    expect(project.path).toBe('C:\\Repositories\\my-app');
    expect(project.planPath).toBe('C:\\Repositories\\my-app\\plan.md');
    expect(project.kind).toBe('plan');
    expect(project.defaultModel).toBe(DEFAULT_SETTINGS.defaultModel);
    expect(project.planningModel).toBeNull();
    expect(project.useWorktrees).toBe(true);
    expect(project.baseBranch).toBe('');
    expect(project.writeBackPlan).toBe(DEFAULT_SETTINGS.writeBackPlan);
    expect(project.autoRelease).toBe(false);
    expect(project.autoIntegrate).toBeNull();
    expect(project.planAligned).toBe(true);
    expect(project.jiraEpicKeys).toEqual([]);
    expect(project.ticketPrefix).toBe('');
    expect(project.target).toEqual(DEFAULT_SETTINGS.defaultExecTarget);
    expect(project.instructions).toBe('');
    expect(project.color).toBe('');
  });

  it('honors an explicit `null` planningModel instead of falling back to the default', () => {
    const withSeed = buildProject(
      { path: '/home/me/app' },
      { ...DEFAULT_SETTINGS, defaultPlanningModel: 'opus' },
    );
    expect(withSeed.planningModel).toBe('opus');

    const declined = buildProject(
      { path: '/home/me/app', planningModel: null },
      { ...DEFAULT_SETTINGS, defaultPlanningModel: 'opus' },
    );
    expect(declined.planningModel).toBeNull();
  });

  it('forces an agent project to worktrees-on, plan-less and path-less-planPath', () => {
    const project = buildProject({ path: '/home/me/repo', kind: 'agent' }, DEFAULT_SETTINGS);
    expect(project.kind).toBe('agent');
    expect(project.path).toBe('/home/me/repo');
    expect(project.planPath).toBe('');
    expect(project.useWorktrees).toBe(true);
    expect(project.writeBackPlan).toBe(false);
  });

  it('forces a ticket project to have no path, no planPath, no worktrees, and names it after the prefix', () => {
    const project = buildProject(
      { path: '/wherever', kind: 'ticket', ticketPrefix: 'tm' },
      DEFAULT_SETTINGS,
    );
    expect(project.kind).toBe('ticket');
    expect(project.path).toBe('');
    expect(project.planPath).toBe('');
    expect(project.useWorktrees).toBe(false);
    expect(project.baseBranch).toBe('');
    expect(project.writeBackPlan).toBe(false);
    expect(project.ticketPrefix).toBe('TM');
    expect(project.name).toBe('TM');
  });

  it('trims a caller-given name, instructions and color, and prefers an explicit name over the path', () => {
    const project = buildProject(
      { path: '/home/me/app', name: '  My App  ', instructions: '  do X  ', color: '  #0091FF  ' },
      DEFAULT_SETTINGS,
    );
    expect(project.name).toBe('My App');
    expect(project.instructions).toBe('do X');
    expect(project.color).toBe('#0091FF');
  });

  it('mints a fresh id every call', () => {
    const a = buildProject({ path: '/a' }, DEFAULT_SETTINGS);
    const b = buildProject({ path: '/b' }, DEFAULT_SETTINGS);
    expect(a.id).not.toBe(b.id);
  });
});

describe('normalizeEpicKeys', () => {
  it('trims, upper-cases and de-duplicates', () => {
    expect(normalizeEpicKeys(['  abc-1 ', 'ABC-1', 'def-2', '', '  '])).toEqual(['ABC-1', 'DEF-2']);
  });

  it('returns an empty array for undefined', () => {
    expect(normalizeEpicKeys(undefined)).toEqual([]);
  });
});

describe('toProjectKind', () => {
  it('whitelists known kinds and degrades anything else to plan', () => {
    expect(toProjectKind('agent')).toBe('agent');
    expect(toProjectKind('ticket')).toBe('ticket');
    expect(toProjectKind('plan')).toBe('plan');
    expect(toProjectKind('bogus')).toBe('plan');
  });
});
