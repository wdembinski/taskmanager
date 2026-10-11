import { describe, expect, it } from 'vitest';
import type { Automation, AutomationRun } from '@tm/shared/automation';
import { lastRunByAutomation, nextRuns, triggerLabel } from './automationsViewModel';

const WARSAW = 'Europe/Warsaw';
const iso = (s: string): number => new Date(s).getTime();

const scheduleAutomation = (over: Partial<Automation> = {}): Automation => ({
  id: 'auto-1',
  revision: 1,
  name: 'Nightly triage',
  enabled: true,
  ownerClientId: null,
  timeZone: WARSAW,
  trigger: { kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 } },
  action: {
    agentProjectId: 'proj-1',
    titleTemplate: 'Nightly triage — {{date}}',
    briefTemplate: '',
    mode: 'acceptEdits',
  },
  enabledAt: 0,
  nextRunAt: null,
  consecutiveFailures: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const trackerAutomation = (over: Partial<Automation> = {}): Automation => ({
  id: 'auto-2',
  revision: 1,
  name: 'Work agent-labelled tickets',
  enabled: true,
  ownerClientId: null,
  timeZone: WARSAW,
  trigger: {
    kind: 'tracker',
    tracker: { source: 'jira', event: 'entered-status', status: 'To Do' },
  },
  action: { agentProjectId: 'proj-1', titleTemplate: '', briefTemplate: '', mode: 'acceptEdits' },
  enabledAt: 0,
  nextRunAt: null,
  consecutiveFailures: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const run = (over: Partial<AutomationRun> = {}): AutomationRun => ({
  id: 'run-1',
  automationId: 'auto-1',
  revision: 1,
  occurrenceKey: 'schedule:2026-01-05T03:00:00.000Z',
  kind: 'scheduled',
  status: 'started',
  taskId: 'task-1',
  runId: 'run-live-1',
  refusal: null,
  skippedCount: 0,
  note: null,
  at: iso('2026-01-05T03:00:00Z'),
  ...over,
});

describe('nextRuns', () => {
  const now = iso('2026-01-05T00:00:00Z');

  it('merges multiple automations’ occurrences, sorted ascending', () => {
    const daily = scheduleAutomation({
      id: 'daily',
      trigger: { kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 } },
    });
    const hourly = scheduleAutomation({
      id: 'hourly',
      trigger: { kind: 'schedule', schedule: { type: 'hours', every: 6 } },
    });

    const result = nextRuns([daily, hourly], now, 10);

    expect(result).toHaveLength(10);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].at).toBeGreaterThanOrEqual(result[i - 1].at);
    }
    expect(result.some((r) => r.automationId === 'daily')).toBe(true);
    expect(result.some((r) => r.automationId === 'hourly')).toBe(true);
  });

  it('ignores disabled automations and tracker triggers', () => {
    const disabled = scheduleAutomation({ id: 'off', enabled: false });
    const tracker = trackerAutomation({ id: 'tracker' });

    expect(nextRuns([disabled, tracker], now, 10)).toEqual([]);
  });

  it('caps at count even with many contributing automations', () => {
    const automations = [scheduleAutomation({ id: 'a' }), scheduleAutomation({ id: 'b' })];
    expect(nextRuns(automations, now, 3)).toHaveLength(3);
  });

  it('skips an automation whose time zone is unresolvable instead of throwing', () => {
    const bad = scheduleAutomation({ id: 'bad', timeZone: 'Not/AZone' });
    const good = scheduleAutomation({ id: 'good' });
    const result = nextRuns([bad, good], now, 5);
    expect(result.every((r) => r.automationId === 'good')).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('lastRunByAutomation', () => {
  it('picks the latest run per automation regardless of input order', () => {
    const earlier = run({ automationId: 'a', at: 1000, status: 'started' });
    const later = run({ automationId: 'a', at: 2000, status: 'refused' });
    const other = run({ automationId: 'b', at: 500, status: 'skipped' });

    const result = lastRunByAutomation([earlier, later, other]);

    expect(result.get('a')).toEqual(later);
    expect(result.get('b')).toEqual(other);
    expect(result.size).toBe(2);
  });

  it('is empty for no runs', () => {
    expect(lastRunByAutomation([]).size).toBe(0);
  });
});

describe('triggerLabel', () => {
  it('renders a schedule trigger as its label plus the time zone', () => {
    const automation = scheduleAutomation({
      timeZone: WARSAW,
      trigger: { kind: 'schedule', schedule: { type: 'weekdays', hour: 4, minute: 0 } },
    });
    expect(triggerLabel(automation)).toBe('weekdays at 04:00 · Europe/Warsaw');
  });

  it('renders each tracker event kind', () => {
    expect(
      triggerLabel(
        trackerAutomation({
          trigger: { kind: 'tracker', tracker: { source: 'jira', event: 'appeared' } },
        }),
      ),
    ).toBe('Jira · new ticket appears');

    expect(
      triggerLabel(
        trackerAutomation({
          trigger: {
            kind: 'tracker',
            tracker: { source: 'github', event: 'entered-status', status: 'To Do' },
          },
        }),
      ),
    ).toBe('GitHub · entered "To Do"');

    expect(
      triggerLabel(
        trackerAutomation({
          trigger: {
            kind: 'tracker',
            tracker: { source: 'jira', event: 'labeled', label: 'agent' },
          },
        }),
      ),
    ).toBe('Jira · label agent');
  });
});
