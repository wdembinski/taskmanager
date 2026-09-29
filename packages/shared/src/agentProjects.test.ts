import { describe, expect, it } from 'vitest';
import {
  agentProjectsOf,
  normalizeEpicKey,
  resolveAgentProject,
  resolveOwningBoardProject,
  seedAssignProject,
} from './agentProjects';
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
  it('keeps only projects with a repo', () => {
    const projects = [project({ id: 'a' }), project({ id: 'b', path: '' })];
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

  it('never resolves to a project with no repo, even on an epic-key match', () => {
    const noRepo = project({ id: 'no-repo', path: '', jiraEpicKeys: ['ABC-100'] });
    expect(resolveAgentProject(task({ externalParentKey: 'ABC-100' }), [noRepo])).toBeNull();
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

describe('resolveOwningBoardProject', () => {
  // A ticket-only project: owns a board (ticket prefix, no plan) but no repo — exactly the
  // shape `agentProjectsOf`'s `hasRepo` filter would hide from `resolveAgentProject`.
  const board = project({ id: 'board', path: '', ticketPrefix: 'BRD', jiraEpicKeys: ['ABC-100'] });
  // An ordinary agent project: has a repo, owns no board of its own.
  const repoOnly = project({ id: 'repo', jiraEpicKeys: ['ABC-200'] });

  it('resolves an epic match to the board project when it owns a board', () => {
    const t = task({ externalParentKey: 'ABC-100' });
    expect(resolveOwningBoardProject(t, [board, repoOnly])?.id).toBe('board');
  });

  it('returns null when the epic-matched project does not own a board', () => {
    const t = task({ externalParentKey: 'ABC-200' });
    expect(resolveOwningBoardProject(t, [board, repoOnly])).toBeNull();
  });

  it('matches a repo-less ticket board that resolveAgentProject would filter out', () => {
    const t = task({ externalParentKey: 'ABC-100' });
    expect(resolveAgentProject(t, [board])).toBeNull();
    expect(resolveOwningBoardProject(t, [board])?.id).toBe('board');
  });

  it('honours an explicit filing over the epic match, same precedence as resolveAgentProject', () => {
    const filed = task({ projectTagId: 'board', externalParentKey: 'ABC-200' });
    expect(resolveOwningBoardProject(filed, [board, repoOnly])?.id).toBe('board');
  });

  it('returns null when nothing owns the epic, or the task has none', () => {
    expect(resolveOwningBoardProject(task({ externalParentKey: 'NOPE-1' }), [board])).toBeNull();
    expect(resolveOwningBoardProject(task(), [board])).toBeNull();
  });
});

describe('seedAssignProject', () => {
  const billing = project({ id: 'p-billing', name: 'Billing' });
  const web = project({ id: 'p-web', name: 'Web', jiraEpicKeys: ['ABC-1'] });
  // Filed under, but the project has no directory — nothing an agent could run in.
  const tagOnly = project({ id: 'p-tagonly', name: 'Tag only', path: '' });
  // A native ticket's own board, which also happens to be a repo.
  const repoBoard = project({ id: 'p-board', name: 'Board', ticketPrefix: 'BRD' });
  // Same shape, but no repo — the board is ticket-only.
  const ticketOnlyBoard = project({
    id: 'p-board-norepo',
    name: 'Ticket board',
    path: '',
    ticketPrefix: 'BRD',
  });

  it('seeds the filed project', () => {
    const t = task({ projectTagId: 'p-billing' });
    expect(seedAssignProject(t, [billing, web])?.id).toBe('p-billing');
  });

  it('lets an explicit delegation beat the filing', () => {
    const t = task({ projectTagId: 'p-web', agentProjectId: 'p-billing' });
    expect(seedAssignProject(t, [billing, web])?.id).toBe('p-billing');
  });

  it('returns null rather than guessing when the filed project has no repo', () => {
    const t = task({ projectTagId: 'p-tagonly' });
    expect(seedAssignProject(t, [billing, tagOnly])).toBeNull();
  });

  it('returns null when the delegated project was deleted and nothing else owns it', () => {
    const t = task({ agentProjectId: 'p-deleted' });
    expect(seedAssignProject(t, [billing, web])).toBeNull();
  });

  it('seeds a native ticket from the repo board it lives on', () => {
    const t = task({ projectId: 'p-board' });
    expect(seedAssignProject(t, [repoBoard, billing])?.id).toBe('p-board');
  });

  it('does not seed from a repo-less ticket board', () => {
    const t = task({ projectId: 'p-board-norepo' });
    expect(seedAssignProject(t, [ticketOnlyBoard, billing])).toBeNull();
  });

  it('seeds nothing for an unfiled card even when there is exactly one agent project', () => {
    // The deliberate behaviour change: this used to fall back to `projects[0]`.
    expect(seedAssignProject(task(), [billing])).toBeNull();
  });

  it('answers identically to resolveAgentProject for a card filed under a repo', () => {
    // The guess lived in the dialog, not the resolver — resolveAgentProject is untouched.
    const t = task({ projectTagId: 'p-billing' });
    expect(seedAssignProject(t, [billing, web])?.id).toBe(
      resolveAgentProject(t, [billing, web])?.id,
    );
  });
});
