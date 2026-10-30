import { describe, expect, it } from 'vitest';
import type { Project } from '@tm/shared/model';
import {
  projectRoleEffort,
  projectRoleSentinel,
  projectRoleWrites,
  seedProjectRoles,
  setProjectRoleEffort,
  setProjectRoleModel,
  ticketModeOf,
  ticketPrefixError,
} from './projectBasics';

let seq = 0;
/** A minimal project fixture — only the fields this module reads are worth naming. */
function project(overrides: Partial<Project> = {}): Project {
  seq += 1;
  return {
    id: `p${seq}`,
    name: 'Untitled',
    path: '',
    planPath: '',
    defaultModel: 'sonnet',
    planningModel: null,
    reviewModel: null,
    leadModel: null,
    leadEffort: null,
    planningEffort: null,
    workerEffort: null,
    reviewEffort: null,
    defaultPermissionMode: 'acceptEdits',
    concurrency: 1,
    useWorktrees: true,
    baseBranch: '',
    writeBackPlan: false,
    autoRelease: false,
    autoCreatePr: false,
    autoMergeOnGreen: false,
    autoMergeMethod: 'squash',
    autoMergeBy: 'forge',
    autoMergeRequiredChecks: [],
    autoIntegrate: null,
    autoApprovePlans: false,
    autoApproveMaxSteps: 6,
    readyLanes: 3,
    autoDoneOnLand: false,
    autoVisualSignOff: false,
    autoVisualSignOffMaxRounds: 2,
    planAligned: true,
    jiraEpicKeys: [],
    ticketPrefix: '',
    target: { kind: 'local' },
    instructions: '',
    uiVerifyCommand: '',
    color: '',
    createdAt: 0,
    ...overrides,
  };
}

describe('ticketModeOf', () => {
  it('reads a project with no prefix as personal', () => {
    expect(ticketModeOf(project({ ticketPrefix: '' }))).toBe('personal');
  });

  it('reads a project with a prefix as tickets', () => {
    expect(ticketModeOf(project({ ticketPrefix: 'TM' }))).toBe('tickets');
  });
});

describe('ticketPrefixError', () => {
  it('is always null in personal mode, even for an unusable prefix', () => {
    expect(ticketPrefixError({ mode: 'personal', prefix: '', projects: [] })).toBeNull();
    expect(ticketPrefixError({ mode: 'personal', prefix: '123', projects: [] })).toBeNull();
  });

  it('leaves an empty prefix in tickets mode for the store to derive one', () => {
    expect(ticketPrefixError({ mode: 'tickets', prefix: '', projects: [] })).toBeNull();
    expect(ticketPrefixError({ mode: 'tickets', prefix: '   ', projects: [] })).toBeNull();
  });

  it('rejects a prefix with no letters', () => {
    expect(ticketPrefixError({ mode: 'tickets', prefix: '123', projects: [] })).toBe(
      'Not a usable prefix — needs at least one letter, and cannot be just digits.',
    );
  });

  it('rejects a prefix already used by another project', () => {
    const other = project({ ticketPrefix: 'TM', name: 'Task Manager' });
    expect(ticketPrefixError({ mode: 'tickets', prefix: 'tm', projects: [other] })).toBe(
      'Already used by Task Manager.',
    );
  });

  it('does not collide with the project being edited', () => {
    const mine = project({ id: 'mine', ticketPrefix: 'TM' });
    expect(
      ticketPrefixError({
        mode: 'tickets',
        prefix: 'TM',
        projects: [mine],
        editingId: 'mine',
      }),
    ).toBeNull();
  });

  it('accepts a usable, unclaimed prefix', () => {
    expect(ticketPrefixError({ mode: 'tickets', prefix: 'TM', projects: [] })).toBeNull();
  });
});

/**
 * The project form's roles table — it replaced the Planning model / Steps execution model pair,
 * so the two writes that pair made (`defaultModel`, `planningModel`) must come out the same,
 * and the new rows must never save a default the human did not pick.
 */
describe('project roles', () => {
  const APP = { defaultModel: 'opus', defaultPlanningModel: null } as const;
  const HIGH = { lead: 'high', planner: 'high', workers: 'high', reviewer: 'high' } as const;

  it("seeds an edited project's own fields, nulls kept as nulls", () => {
    const roles = seedProjectRoles(
      project({ defaultModel: 'sonnet', planningModel: 'opus', workerEffort: 'low' }),
      APP,
    );
    expect(roles.models).toEqual({
      lead: null,
      planner: 'opus',
      workers: 'sonnet',
      reviewer: null,
    });
    expect(roles.efforts).toEqual({ lead: null, planner: null, workers: 'low', reviewer: null });
  });

  it('seeds a new project from the app defaults', () => {
    const roles = seedProjectRoles(null, { defaultModel: 'haiku', defaultPlanningModel: 'opus' });
    expect(roles.models.workers).toBe('haiku');
    expect(roles.models.planner).toBe('opus');
  });

  it('names the rung each sentinel follows; Workers has none', () => {
    expect(projectRoleSentinel('workers')).toBeUndefined();
    expect(projectRoleSentinel('planner')).toBe('Same as execution');
    expect(projectRoleSentinel('lead')).toBe('Same as planning');
    expect(projectRoleSentinel('reviewer')).toBe('Same as planning');
  });

  it('writes every model, the sentinel as null, and Workers to defaultModel', () => {
    let roles = seedProjectRoles(project({ planningModel: 'opus', leadModel: 'opus' }), APP);
    roles = setProjectRoleModel(roles, 'workers', 'haiku');
    roles = setProjectRoleModel(roles, 'lead', null);
    expect(projectRoleWrites(roles)).toEqual({
      defaultModel: 'haiku',
      planningModel: 'opus',
      leadModel: null,
      reviewModel: null,
    });
  });

  it('never lets Workers go null', () => {
    const roles = seedProjectRoles(project({ defaultModel: 'sonnet' }), APP);
    expect(setProjectRoleModel(roles, 'workers', null).models.workers).toBe('sonnet');
  });

  it('shows the app default for an unset effort but writes only touched ones', () => {
    let roles = seedProjectRoles(project({ reviewEffort: 'max' }), APP);
    expect(projectRoleEffort('lead', roles, HIGH)).toBe('high');
    expect(projectRoleEffort('reviewer', roles, HIGH)).toBe('max');
    expect(projectRoleWrites(roles)).not.toHaveProperty('reviewEffort');
    expect(projectRoleWrites(roles)).not.toHaveProperty('leadEffort');

    roles = setProjectRoleEffort(roles, 'workers', 'xhigh');
    roles = setProjectRoleEffort(roles, 'workers', 'low');
    expect(roles.touched).toEqual(['workers']);
    expect(projectRoleWrites(roles)).toMatchObject({ workerEffort: 'low' });
    expect(projectRoleWrites(roles)).not.toHaveProperty('planningEffort');
  });
});
