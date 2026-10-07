import { describe, expect, it } from 'vitest';
import {
  HOUR_INTERVALS,
  validateAutomation,
  type Automation,
  type ScheduleShape,
} from './automation';

const scheduleAutomation = (over: Partial<Automation> = {}): Automation => ({
  id: 'auto-1',
  revision: 1,
  name: 'Nightly triage',
  enabled: true,
  ownerClientId: null,
  timeZone: 'Europe/Warsaw',
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
  timeZone: 'Europe/Warsaw',
  trigger: {
    kind: 'tracker',
    tracker: { source: 'jira', event: 'entered-status', status: 'To Do' },
  },
  action: {
    agentProjectId: 'proj-1',
    titleTemplate: '',
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

describe('validateAutomation', () => {
  it('passes a valid schedule automation', () => {
    expect(validateAutomation(scheduleAutomation())).toEqual([]);
  });

  it('passes a valid tracker automation', () => {
    expect(validateAutomation(trackerAutomation())).toEqual([]);
  });

  it('rejects a blank name', () => {
    expect(validateAutomation(scheduleAutomation({ name: '   ' }))).toContain('Name is required.');
  });

  it('rejects an unknown time zone', () => {
    const errors = validateAutomation(scheduleAutomation({ timeZone: 'Not/AZone' }));
    expect(errors.some((e) => e.includes('Unknown time zone'))).toBe(true);
  });

  it('rejects a blank agent project', () => {
    const t = scheduleAutomation();
    t.action.agentProjectId = '   ';
    expect(validateAutomation(t)).toContain('An agent project is required.');
  });

  it('rejects mode: manual — a headless run cannot answer a permission prompt', () => {
    const t = scheduleAutomation();
    t.action.mode = 'manual';
    expect(validateAutomation(t).some((e) => e.includes('Manual permission mode'))).toBe(true);
  });

  describe('schedule trigger', () => {
    it('rejects a missing schedule', () => {
      const t = scheduleAutomation();
      (t.trigger as { schedule?: ScheduleShape }).schedule = undefined;
      expect(validateAutomation(t)).toContain('A schedule is required.');
    });

    it('rejects an out-of-range hour', () => {
      const t = scheduleAutomation({
        trigger: { kind: 'schedule', schedule: { type: 'daily', hour: 24, minute: 0 } },
      });
      expect(validateAutomation(t).some((e) => e.includes('Hour'))).toBe(true);
    });

    it('rejects a non-integer hour', () => {
      const t = scheduleAutomation({
        trigger: { kind: 'schedule', schedule: { type: 'daily', hour: 1.5, minute: 0 } },
      });
      expect(validateAutomation(t).some((e) => e.includes('Hour'))).toBe(true);
    });

    it('rejects a bad minute', () => {
      const t = scheduleAutomation({
        trigger: { kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 60 } },
      });
      expect(validateAutomation(t).some((e) => e.includes('Minute'))).toBe(true);
    });

    it('rejects a bad weekly day', () => {
      const t = scheduleAutomation({
        trigger: {
          kind: 'schedule',
          schedule: { type: 'weekly', day: 8, hour: 4, minute: 0 } as unknown as ScheduleShape,
        },
      });
      expect(validateAutomation(t).some((e) => e.includes('Weekly day'))).toBe(true);
    });

    it('rejects an hours interval outside HOUR_INTERVALS', () => {
      const t = scheduleAutomation({
        trigger: {
          kind: 'schedule',
          schedule: { type: 'hours', every: 5 } as unknown as ScheduleShape,
        },
      });
      expect(validateAutomation(t).some((e) => e.includes('Hour interval'))).toBe(true);
    });

    it('accepts every value in HOUR_INTERVALS', () => {
      for (const every of HOUR_INTERVALS) {
        const t = scheduleAutomation({
          trigger: { kind: 'schedule', schedule: { type: 'hours', every } },
        });
        expect(validateAutomation(t)).toEqual([]);
      }
    });

    it('rejects a blank title template', () => {
      const t = scheduleAutomation();
      t.action.titleTemplate = '   ';
      expect(validateAutomation(t)).toContain(
        'A title template is required for a schedule automation.',
      );
    });
  });

  describe('tracker trigger', () => {
    it('rejects a missing tracker', () => {
      const t = trackerAutomation();
      (t.trigger as { tracker?: unknown }).tracker = undefined;
      expect(validateAutomation(t)).toContain('A tracker trigger is required.');
    });

    it('requires a status for entered-status', () => {
      const t = trackerAutomation({
        trigger: { kind: 'tracker', tracker: { source: 'jira', event: 'entered-status' } },
      });
      expect(validateAutomation(t)).toContain(
        'A status is required for an "entered status" trigger.',
      );
    });

    it('requires a label for labeled', () => {
      const t = trackerAutomation({
        trigger: { kind: 'tracker', tracker: { source: 'github', event: 'labeled' } },
      });
      expect(validateAutomation(t)).toContain('A label is required for a "labeled" trigger.');
    });

    it('needs neither status nor label for appeared', () => {
      const t = trackerAutomation({
        trigger: { kind: 'tracker', tracker: { source: 'github', event: 'appeared' } },
      });
      expect(validateAutomation(t)).toEqual([]);
    });
  });
});
