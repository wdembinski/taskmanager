import { describe, expect, it } from 'vitest';
import { agentProjectsOf, normalizeEpicKey, resolveAgentProject } from './agentProjects';
import { PERSONAL_PROJECT_ID, type Project, type Task } from './model';

const project = (over: Partial<Project>): Project => ({
  id: 'p1',
  name: 'Repo',
  path: 'C:/repos/repo',
  planPath: '',
  defaultModel: 'sonnet',
  defaultPermissionMode: 'acceptEdits',
  concurrency: 1,
  useWorktrees: true,
  writeBackPlan: false,
  planAligned: true,
  kind: 'agent',
  jiraEpicKeys: [],
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

  it('matches the ticket epic against a project\'s epic keys', () => {
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
