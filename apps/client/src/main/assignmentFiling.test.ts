import { describe, expect, it } from 'vitest';
import { assignmentFilingPatch } from './assignmentFiling';
import { LOCAL_TARGET } from '@shared/execTarget';
import { PERSONAL_PROJECT_ID, type Project, type Task } from '@shared/model';

/** A top-level card of the Personal board — the thing a human drags between columns. */
function card(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    projectId: PERSONAL_PROJECT_ID,
    phase: '',
    title: 'Fix the export dialog',
    status: 'pending',
    sessionId: null,
    order: 0,
    source: 'jira',
    dependsOn: [],
    isContract: false,
    isScaffold: false,
    projectTagId: null,
    agentProjectId: null,
    ...overrides,
  } as Task;
}

const project = (over: Partial<Project> = {}): Project => ({
  id: 'alpha',
  name: 'Alpha',
  path: 'C:/repos/alpha',
  planPath: '',
  defaultModel: 'sonnet',
  planningModel: null,
  defaultPermissionMode: 'acceptEdits',
  concurrency: 1,
  useWorktrees: true,
  baseBranch: '',
  writeBackPlan: false,
  autoRelease: false,
  autoCreatePr: false,
  autoIntegrate: null,
  planAligned: true,
  jiraEpicKeys: [],
  ticketPrefix: '',
  target: LOCAL_TARGET,
  instructions: '',
  color: '',
  createdAt: 0,
  ...over,
});

describe('assignmentFilingPatch — moving the filing along with a reassignment', () => {
  it('files an unfiled card under the repo it is delegated to', () => {
    const task = card({ projectTagId: null, agentProjectId: null });
    const beta = project({ id: 'beta', path: 'C:/repos/beta' });
    expect(assignmentFilingPatch(task, beta)).toEqual({ projectTagId: 'beta' });
  });

  it("a reassignment moves a filing that is only the last assignment's back-fill", () => {
    // Delegated to Alpha, and Alpha's own back-fill gave it projectTagId 'alpha' too.
    const task = card({ projectTagId: 'alpha', agentProjectId: 'alpha' });
    const beta = project({ id: 'beta', path: 'C:/repos/beta' });
    expect(assignmentFilingPatch(task, beta)).toEqual({ projectTagId: 'beta' });
  });

  it('a filing made before any delegation outranks the assignment', () => {
    const task = card({ projectTagId: 'gamma', agentProjectId: null });
    const beta = project({ id: 'beta', path: 'C:/repos/beta' });
    expect(assignmentFilingPatch(task, beta)).toEqual({});
  });

  it('...and survives a reassignment, and the one after it', () => {
    let task = card({ projectTagId: 'gamma', agentProjectId: null });

    const beta = project({ id: 'beta', path: 'C:/repos/beta' });
    let patch = assignmentFilingPatch(task, beta);
    expect(patch).toEqual({});
    task = { ...task, ...patch, agentProjectId: beta.id };

    const delta = project({ id: 'delta', path: 'C:/repos/delta' });
    patch = assignmentFilingPatch(task, delta);
    expect(patch).toEqual({});
    task = { ...task, ...patch, agentProjectId: delta.id };

    expect(task.projectTagId).toBe('gamma');
  });

  it('a re-filing made after a delegation is respected', () => {
    // Delegated to Alpha (back-filled tag 'alpha'), then a human re-filed it under Gamma.
    const task = card({ projectTagId: 'gamma', agentProjectId: 'alpha' });
    const beta = project({ id: 'beta', path: 'C:/repos/beta' });
    expect(assignmentFilingPatch(task, beta)).toEqual({});
  });

  it('a card explicitly unfiled is re-filed by the next assignment (matches today)', () => {
    const task = card({ projectTagId: null, agentProjectId: 'alpha' });
    const beta = project({ id: 'beta', path: 'C:/repos/beta' });
    expect(assignmentFilingPatch(task, beta)).toEqual({ projectTagId: 'beta' });
  });

  it('a legacy pre-split row (tag === delegation) follows the reassignment', () => {
    const task = card({ projectTagId: 'alpha', agentProjectId: 'alpha' });
    const beta = project({ id: 'beta', path: 'C:/repos/beta' });
    expect(assignmentFilingPatch(task, beta)).toEqual({ projectTagId: 'beta' });
  });

  it('reassigning to the same repo is idempotent', () => {
    const task = card({ projectTagId: 'alpha', agentProjectId: 'alpha' });
    const alpha = project({ id: 'alpha', path: 'C:/repos/alpha' });
    expect(assignmentFilingPatch(task, alpha)).toEqual({ projectTagId: 'alpha' });
  });

  it('no filing written for a target the dropdown could never offer (plan file + repo)', () => {
    const task = card({ projectTagId: null, agentProjectId: null });
    const planProject = project({ id: 'planner', path: 'C:/repos/planner', planPath: 'PLAN.md' });
    expect(assignmentFilingPatch(task, planProject)).toEqual({});
  });
});
