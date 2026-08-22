import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './settings';
import { buildProject, normalizeEpicKeys } from './projectBuilders';

describe('buildProject', () => {
  it('builds a plan project from a path, seeding unspecified fields from defaults', () => {
    const project = buildProject({ path: 'C:\\Repositories\\my-app' }, DEFAULT_SETTINGS);
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project.name).toBe('my-app');
    expect(project.path).toBe('C:\\Repositories\\my-app');
    expect(project.planPath).toBe('C:\\Repositories\\my-app\\plan.md');
    expect(project.defaultModel).toBe(DEFAULT_SETTINGS.defaultModel);
    expect(project.planningModel).toBeNull();
    expect(project.useWorktrees).toBe(true);
    expect(project.baseBranch).toBe('');
    expect(project.writeBackPlan).toBe(DEFAULT_SETTINGS.writeBackPlan);
    expect(project.autoRelease).toBe(false);
    expect(project.autoCreatePr).toBe(false);
    expect(project.autoIntegrate).toBeNull();
    expect(project.planAligned).toBe(true);
    expect(project.jiraEpicKeys).toEqual([]);
    // A plan project has a plan file, so the ticket-prefix guarantee never fires.
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

  it('guarantees a bare repo (an explicit empty planPath) a ticket prefix derived from its name', () => {
    const project = buildProject({ path: '/home/me/repo', planPath: '' }, DEFAULT_SETTINGS);
    expect(project.path).toBe('/home/me/repo');
    expect(project.planPath).toBe('');
    expect(project.ticketPrefix).toBe('REPO');
    expect(project.useWorktrees).toBe(true);
  });

  it('builds a ticket project (no path) from an explicit prefix, and names it after the prefix', () => {
    const project = buildProject({ ticketPrefix: 'tm' }, DEFAULT_SETTINGS);
    expect(project.path).toBe('');
    expect(project.planPath).toBe('');
    expect(project.baseBranch).toBe('');
    expect(project.ticketPrefix).toBe('TM');
    expect(project.name).toBe('TM');
  });

  it('leaves a Personal-space project (`personal: true`) with no ticket prefix even though it is plan-less', () => {
    const project = buildProject({ personal: true }, DEFAULT_SETTINGS);
    expect(project.ticketPrefix).toBe('');
    expect(project.planPath).toBe('');
  });

  it('avoids colliding with an already-taken ticket prefix', () => {
    const project = buildProject({ path: '/home/me/repo', planPath: '' }, DEFAULT_SETTINGS, [
      'REPO',
    ]);
    expect(project.ticketPrefix).toBe('REPO2');
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
