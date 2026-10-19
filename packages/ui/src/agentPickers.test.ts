/**
 * The seeding `AssignAgentDialog` and `AddTaskDialog`'s Run-it section share.
 *
 * `seedNewCardAssign` has to agree with `AssignAgentDialog`'s own seeding (`seedAssignProject`)
 * on a card that doesn't exist yet — otherwise a card pre-filled as it's being created would
 * seed differently from the same card seeded a moment later, once it's real. The mode
 * precedence (card beats project beats default) and a project pick's effect on it are the
 * other thing both dialogs must read identically.
 */
import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Project, type Task } from '@tm/shared/model';
import { LOCAL_TARGET } from '@tm/shared/execTarget';
import {
  DEFAULT_PERMISSION_MODE,
  modeForPickedProject,
  NO_AGENT_PROJECTS_MESSAGE,
  PERMISSION_MODES,
  seedNewCardAssign,
  seedPermissionMode,
} from './agentPickers';

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
  autoMergeOnGreen: false,
  autoMergeMethod: 'squash',
  autoMergeRequiredChecks: [],
  autoIntegrate: null,
  autoApprovePlans: false,
  autoApproveMaxSteps: 6,
  readyLanes: 3,
  autoDoneOnLand: false,
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

describe('PERMISSION_MODES / DEFAULT_PERMISSION_MODE', () => {
  it('offers every mode, with the default among them', () => {
    expect(PERMISSION_MODES).toEqual(['acceptEdits', 'plan', 'manual', 'bypassPermissions']);
    expect(PERMISSION_MODES).toContain(DEFAULT_PERMISSION_MODE);
  });
});

describe('seedPermissionMode', () => {
  it("the card's own mode beats the project's", () => {
    const card = task({ agentMode: 'bypassPermissions' });
    const proj = project({ defaultPermissionMode: 'plan' });
    expect(seedPermissionMode(card, proj)).toBe('bypassPermissions');
  });

  it("the project's mode beats the default", () => {
    const proj = project({ defaultPermissionMode: 'plan' });
    expect(seedPermissionMode(task(), proj)).toBe('plan');
  });

  it('falls back to the default with neither a card nor a project', () => {
    expect(seedPermissionMode(null, null)).toBe(DEFAULT_PERMISSION_MODE);
    expect(seedPermissionMode(task(), null)).toBe(DEFAULT_PERMISSION_MODE);
  });
});

describe('modeForPickedProject', () => {
  it("switches to the picked project's own default", () => {
    const projects = [project({ id: 'a', defaultPermissionMode: 'manual' })];
    expect(modeForPickedProject(projects, 'a', 'plan')).toBe('manual');
  });

  it('keeps the current mode when the picked id matches nothing', () => {
    const projects = [project({ id: 'a', defaultPermissionMode: 'manual' })];
    expect(modeForPickedProject(projects, 'gone', 'plan')).toBe('plan');
  });
});

describe('NO_AGENT_PROJECTS_MESSAGE', () => {
  it('names the desktop app, under Projects', () => {
    expect(NO_AGENT_PROJECTS_MESSAGE).toMatch(/desktop app, under Projects/);
  });
});

describe('seedNewCardAssign', () => {
  const web = project({ id: 'p-web', name: 'Web', jiraEpicKeys: ['ABC-1'] });
  // A board that is itself a repo project — its own id is also the board id.
  const repoBoard = project({ id: 'p-board', name: 'Board', ticketPrefix: 'BRD' });
  // Same shape, but no repo of its own — a ticket-only board, which is exactly what makes
  // room for the epic match below instead of the board resolving to itself.
  const ticketOnlyBoard = project({
    id: 'p-board-norepo',
    name: 'Ticket board',
    path: '',
    ticketPrefix: 'BRD',
  });

  it("pre-fills from the epic: on a ticket board, the epic matches a repo project's keys", () => {
    const result = seedNewCardAssign(
      { boardId: 'p-board-norepo', epic: { externalKey: 'ABC-1' } },
      [web, ticketOnlyBoard],
    );
    expect(result.agentProjectId).toBe('p-web');
  });

  it('seeds a board that is itself a repo project as itself', () => {
    const result = seedNewCardAssign({ boardId: 'p-board', epic: null }, [web, repoBoard]);
    expect(result.agentProjectId).toBe('p-board');
  });

  it('seeds nothing for Personal with no epic', () => {
    const result = seedNewCardAssign({ boardId: PERSONAL_PROJECT_ID, epic: null }, [
      web,
      repoBoard,
    ]);
    expect(result.agentProjectId).toBe('');
  });

  it('seeds nothing for a board with no repo and an epic nothing matches', () => {
    const tagOnly = project({ id: 'p-tagonly', name: 'Tag only', path: '' });
    const result = seedNewCardAssign({ boardId: 'p-tagonly', epic: { externalKey: 'NOPE-1' } }, [
      web,
      tagOnly,
    ]);
    expect(result.agentProjectId).toBe('');
  });

  it('always seeds a null model — it follows the project', () => {
    expect(
      seedNewCardAssign({ boardId: 'p-board', epic: { externalKey: 'ABC-1' } }, [web, repoBoard])
        .model,
    ).toBeNull();
    expect(seedNewCardAssign({ boardId: PERSONAL_PROJECT_ID, epic: null }, [web]).model).toBeNull();
  });

  it("seeds the resolved project's own default permission mode", () => {
    const strict = project({ id: 'p-strict', name: 'Strict', defaultPermissionMode: 'manual' });
    const result = seedNewCardAssign({ boardId: 'p-strict', epic: null }, [strict]);
    expect(result.mode).toBe('manual');
  });

  it('falls back to the default mode when nothing resolves', () => {
    const result = seedNewCardAssign({ boardId: PERSONAL_PROJECT_ID, epic: null }, [web]);
    expect(result.mode).toBe(DEFAULT_PERMISSION_MODE);
  });
});
