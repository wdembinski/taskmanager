import { describe, expect, it } from 'vitest';
import { agentProjectsOf, normalizeEpicKey, resolveAgentProject } from './agentProjects';
import { isAgentAssigned } from './board';
import { LOCAL_TARGET } from './execTarget';
import { PERSONAL_PROJECT_ID, type Project, type Task } from './model';

const project = (over: Partial<Project>): Project => ({
  id: 'p1',
  name: 'Repo',
  path: 'C:/repos/repo',
  planPath: '',
  defaultModel: 'sonnet',
  planningModel: null,
  defaultPermissionMode: 'acceptEdits',
  concurrency: 1,
  useWorktrees: true,
  baseBranch: '',
  writeBackPlan: false,
  autoRelease: false,
  autoIntegrate: null,
  planAligned: true,
  kind: 'agent',
  jiraEpicKeys: [],
  target: LOCAL_TARGET,
  instructions: '',
  color: '',
  createdAt: 0,
  ...over,
});

const task = (over: Partial<Task> = {}): Task => ({
  id: 'jira-1',
  projectId: PERSONAL_PROJECT_ID,
  phase: 'proj',
  title: 'Do a thing',
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'jira',
  isContract: false,
  isScaffold: false,
  ...over,
});

describe('normalizeEpicKey', () => {
  it('trims and upper-cases', () => {
    expect(normalizeEpicKey('  abc-100 ')).toBe('ABC-100');
  });
});

describe('agentProjectsOf', () => {
  it('keeps only agent projects', () => {
    const projects = [project({ id: 'a' }), project({ id: 'b', kind: 'plan' })];
    expect(agentProjectsOf(projects).map((p) => p.id)).toEqual(['a']);
  });
});

describe('resolveAgentProject', () => {
  const alpha = project({ id: 'alpha', jiraEpicKeys: ['ABC-100'] });
  const beta = project({ id: 'beta', jiraEpicKeys: ['ABC-200', 'XYZ-1'] });

  it('honours an explicit assignment over the epic match', () => {
    const t = task({ agentProjectId: 'beta', externalParentKey: 'ABC-100' });
    expect(resolveAgentProject(t, [alpha, beta])?.id).toBe('beta');
  });

  it("matches the ticket epic against a project's epic keys", () => {
    const t = task({ externalParentKey: 'XYZ-1' });
    expect(resolveAgentProject(t, [alpha, beta])?.id).toBe('beta');
  });

  it('compares keys case-insensitively', () => {
    const t = task({ externalParentKey: 'abc-100' });
    const loose = project({ id: 'loose', jiraEpicKeys: ['abc-100'] });
    expect(resolveAgentProject(t, [loose])?.id).toBe('loose');
    expect(resolveAgentProject(t, [alpha])?.id).toBe('alpha');
  });

  it('never resolves to a plan project, even on an epic-key match', () => {
    const legacy = project({ id: 'legacy', kind: 'plan', jiraEpicKeys: ['ABC-100'] });
    expect(resolveAgentProject(task({ externalParentKey: 'ABC-100' }), [legacy])).toBeNull();
  });

  it('falls back to the epic match when the assigned project no longer exists', () => {
    const t = task({ agentProjectId: 'deleted', externalParentKey: 'ABC-100' });
    expect(resolveAgentProject(t, [alpha, beta])?.id).toBe('alpha');
  });

  it('returns null when nothing owns the epic, or the task has none', () => {
    expect(resolveAgentProject(task({ externalParentKey: 'NOPE-1' }), [alpha, beta])).toBeNull();
    expect(resolveAgentProject(task(), [alpha, beta])).toBeNull();
  });

  it('picks the first claimant when two projects list the same epic', () => {
    const dup = project({ id: 'dup', jiraEpicKeys: ['ABC-100'] });
    expect(resolveAgentProject(task({ externalParentKey: 'ABC-100' }), [alpha, dup])?.id).toBe(
      'alpha',
    );
  });
});

describe('resolveAgentProject — filing vs delegating', () => {
  const billing = project({ id: 'p-billing', name: 'Billing' });
  const web = project({ id: 'p-web', name: 'Web', jiraEpicKeys: ['ABC-1'] });

  it('resolves a merely-FILED card to the project it is filed under', () => {
    const filed = task({ projectTagId: 'p-billing' });
    expect(resolveAgentProject(filed, [billing, web])?.id).toBe('p-billing');
  });

  it('but a filed card is not agent-assigned — no glyph, no “Reassign…”', () => {
    expect(isAgentAssigned(task({ projectTagId: 'p-billing' }))).toBe(false);
    expect(isAgentAssigned(task({ agentProjectId: 'p-billing' }))).toBe(true);
  });

  it('lets an explicit delegation outrank the filing', () => {
    const both = task({ projectTagId: 'p-web', agentProjectId: 'p-billing' });
    expect(resolveAgentProject(both, [billing, web])?.id).toBe('p-billing');
  });

  it('lets the filing outrank an epic match', () => {
    const filed = task({ projectTagId: 'p-billing', externalParentKey: 'ABC-1' });
    expect(resolveAgentProject(filed, [billing, web])?.id).toBe('p-billing');
  });

  it('falls through to the epic when the filed project is gone', () => {
    const filed = task({ projectTagId: 'p-deleted', externalParentKey: 'ABC-1' });
    expect(resolveAgentProject(filed, [billing, web])?.id).toBe('p-web');
  });
});
