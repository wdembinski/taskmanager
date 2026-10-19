import { describe, expect, it } from 'vitest';
import { LOCAL_TARGET } from '@tm/shared/execTarget';
import type { IssueSummary } from '@tm/shared/issues';
import type { Project } from '@tm/shared/model';
import { NO_AGENT_PROJECTS_MESSAGE } from '../agentPickers';
import { handOffAvailability } from './issueHandOff';

const project = (over: Partial<Project> = {}): Project => ({
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

const issue = (over: Partial<IssueSummary> = {}): IssueSummary => ({
  provider: 'jira',
  key: 'A-1',
  title: 'Title',
  url: 'https://example.test/A-1',
  state: 'Open',
  labels: [],
  updatedAt: 1,
  onBoardTaskId: null,
  ...over,
});

describe('handOffAvailability', () => {
  it('reads "on-board" for an issue already imported, regardless of agent projects', () => {
    expect(handOffAvailability(issue({ onBoardTaskId: 'task-1' }), [])).toEqual({
      kind: 'on-board',
      taskId: 'task-1',
    });
  });

  it('is disabled with the desktop-only explanation when no agent project exists', () => {
    // A repo-less project (path: '') does not count — same rule as AssignAgentDialog.
    const tagOnly = project({ id: 'p-tagonly', path: '' });
    expect(handOffAvailability(issue(), [tagOnly])).toEqual({
      kind: 'no-agent-projects',
      message: NO_AGENT_PROJECTS_MESSAGE,
    });
    expect(handOffAvailability(issue(), [])).toEqual({
      kind: 'no-agent-projects',
      message: NO_AGENT_PROJECTS_MESSAGE,
    });
  });

  it('is available once at least one agent project exists', () => {
    expect(handOffAvailability(issue(), [project()])).toEqual({ kind: 'available' });
  });
});
