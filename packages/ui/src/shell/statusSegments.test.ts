import { describe, expect, it } from 'vitest';
import type { Task } from '@tm/shared/model';
import type { UsageQuota, UsageQuotas } from '@tm/shared/usage';
import { agentsRunningLabel, statusSegments, type StatusSegmentsInput } from './statusSegments';

/** A minimal task fixture — only the fields this module reads are worth naming. */
function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    projectId: 'proj',
    phase: '',
    title: id,
    status: 'pending',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'adhoc',
    isContract: false,
    isScaffold: false,
    ...overrides,
  };
}

function quota(id: UsageQuota['id']): UsageQuota {
  return {
    id,
    windowStart: 0,
    windowEnd: 1,
    resetAt: null,
    tokens: 0,
    limit: 0,
    pct: 40,
    pctSource: 'claude',
  };
}

const QUOTAS: UsageQuotas = { session: quota('session'), weekly: quota('weekly') };

function input(overrides: Partial<StatusSegmentsInput> = {}): StatusSegmentsInput {
  return { host: 'desktop', tasks: [], selectedTaskId: null, quotas: QUOTAS, ...overrides };
}

const HOSTS = [
  { host: 'desktop', desktopOnline: undefined },
  { host: 'web', desktopOnline: true },
] as const;

describe('statusSegments', () => {
  for (const { host, desktopOnline } of HOSTS) {
    describe(`on the ${host}`, () => {
      const on = (o: Partial<StatusSegmentsInput>) =>
        statusSegments(input({ host, desktopOnline, ...o }));

      it('counts running cards and steps, ignoring archived and non-running ones', () => {
        const tasks = [
          task('a', { status: 'running', workedAt: 1 }),
          task('b', { workedAt: 1 }),
          task('b-1', { parentTaskId: 'b', status: 'running', workedAt: 2 }),
          task('c', { status: 'running', archivedAt: 5, workedAt: 1 }),
          task('d', { status: 'done', workedAt: 1 }),
          task('e', { status: 'pending' }),
        ];
        expect(on({ tasks }).agentsRunning).toBe(2);
      });

      it('shows no agents segment when nothing runs', () => {
        expect(on({ tasks: [task('a', { status: 'done', workedAt: 1 })] }).agentsRunning).toBe(
          null,
        );
      });

      it("resolves a selected step to its parent card's agentBranch", () => {
        const tasks = [
          task('p', { agentBranch: 'tm-71-linear-identifiers', workedAt: 1 }),
          task('p-1', { parentTaskId: 'p', status: 'running', workedAt: 2 }),
        ];
        expect(on({ tasks, selectedTaskId: 'p-1' }).branch).toBe('tm-71-linear-identifiers');
      });

      it('falls back to the legacy orch/<id> branch on a card that has run', () => {
        const tasks = [
          task('p', { agentBranch: null, workedAt: 1 }),
          task('p-1', { parentTaskId: 'p' }),
        ];
        expect(on({ tasks, selectedTaskId: 'p-1' }).branch).toBe('orch/p');
      });

      it('shows no branch for a card that never ran', () => {
        expect(on({ tasks: [task('a')], selectedTaskId: 'a' }).branch).toBe(null);
      });

      it('shows no branch when the selection is unknown', () => {
        expect(on({ tasks: [task('a', { workedAt: 1 })], selectedTaskId: 'gone' }).branch).toBe(
          null,
        );
      });

      it('with no selection, uses the most recently started running task', () => {
        const tasks = [
          task('old', { status: 'running', workedAt: 10, agentBranch: 'old-branch' }),
          task('new', { workedAt: 5, agentBranch: 'new-branch' }),
          task('new-1', { parentTaskId: 'new', status: 'running', workedAt: 20 }),
          task('idle', { status: 'done', workedAt: 99, agentBranch: 'idle-branch' }),
        ];
        expect(on({ tasks }).branch).toBe('new-branch');
      });

      it('with no selection and nothing running, shows no branch', () => {
        expect(on({ tasks: [task('a', { workedAt: 1, agentBranch: 'x' })] }).branch).toBe(null);
      });

      it('passes the quotas through', () => {
        expect(on({}).quotas).toBe(QUOTAS);
      });
    });
  }

  describe('on the web with no live desktop', () => {
    const tasks = [task('a', { status: 'running', workedAt: 1, agentBranch: 'a-branch' })];

    for (const desktopOnline of [false, undefined]) {
      it(`hides agents and quotas but keeps the branch (desktopOnline: ${desktopOnline})`, () => {
        const out = statusSegments(
          input({ host: 'web', desktopOnline, tasks, selectedTaskId: 'a' }),
        );
        expect(out).toEqual({ agentsRunning: null, branch: 'a-branch', quotas: null });
      });
    }
  });

  it('ignores desktopOnline on the desktop', () => {
    const tasks = [task('a', { status: 'running', workedAt: 1 })];
    const out = statusSegments(input({ host: 'desktop', desktopOnline: false, tasks }));
    expect(out.agentsRunning).toBe(1);
    expect(out.quotas).toBe(QUOTAS);
  });
});

describe('agentsRunningLabel', () => {
  it('pluralises', () => {
    expect(agentsRunningLabel(1)).toBe('1 agent running');
    expect(agentsRunningLabel(2)).toBe('2 agents running');
    expect(agentsRunningLabel(12)).toBe('12 agents running');
  });
});
