import { describe, expect, it } from 'vitest';
import type { Automation, ScheduleShape } from '@tm/shared/automation';
import { occurrencesBetween } from '@tm/shared/automationSchedule';
import {
  automationFromDraft,
  automationModeOptions,
  draftErrors,
  draftFromAutomation,
  MANUAL_MODE_EXPLANATION,
  newAutomationDraft,
  nextRunsPreview,
  templatePreview,
  type AutomationDraft,
} from './automationEditorModel';

const WARSAW = 'Europe/Warsaw';
const DAY_MS = 24 * 60 * 60 * 1000;

const iso = (s: string): number => new Date(s).getTime();

describe('draft/automation round trip', () => {
  it('is stable for a schedule draft: draft -> automation -> draft', () => {
    const draft: AutomationDraft = {
      ...newAutomationDraft({
        timeZone: WARSAW,
        agentProjectId: 'proj-1',
        boardProjectId: 'board-1',
      }),
      name: 'Nightly triage',
      triggerKind: 'schedule',
      scheduleType: 'weekly',
      hour: 9,
      minute: 15,
      day: 3,
      titleTemplate: '{{automation.name}} — {{date}}',
      briefTemplate: 'Triage brief',
      mode: 'acceptEdits',
      model: 'opus',
      planningModel: 'sonnet',
      autoCreatePr: true,
      autoIntegrate: false,
    };

    const roundTripped = draftFromAutomation(automationFromDraft(draft, null));
    expect(roundTripped).toEqual(draft);
  });

  it('is stable for a tracker draft: draft -> automation -> draft', () => {
    const draft: AutomationDraft = {
      ...newAutomationDraft({ timeZone: 'UTC', agentProjectId: 'proj-2' }),
      name: 'Label watch',
      triggerKind: 'tracker',
      source: 'github',
      event: 'labeled',
      label: 'urgent',
      anyLabels: 'bug, regression',
      allLabels: 'triaged',
      excludeLabels: 'wontfix',
      titleTemplate: '',
      briefTemplate: 'Handle the label',
      mode: 'bypassPermissions',
      autoCreatePr: null,
      autoIntegrate: true,
    };

    const roundTripped = draftFromAutomation(automationFromDraft(draft, null));
    expect(roundTripped).toEqual(draft);
  });
});

describe('automation/draft round trip', () => {
  const SCHEDULE_AUTOMATION: Automation = {
    id: 'auto-1',
    revision: 3,
    name: 'Nightly triage',
    enabled: true,
    ownerClientId: 'client-1',
    timeZone: WARSAW,
    trigger: { kind: 'schedule', schedule: { type: 'weekly', day: 3, hour: 9, minute: 15 } },
    action: {
      boardProjectId: 'board-1',
      agentProjectId: 'proj-1',
      titleTemplate: '{{automation.name}} — {{date}}',
      briefTemplate: 'Triage brief',
      mode: 'acceptEdits',
      model: 'opus',
      planningModel: 'sonnet',
      autoCreatePr: true,
      autoIntegrate: false,
    },
    enabledAt: 1000,
    nextRunAt: 2000,
    consecutiveFailures: 1,
    createdAt: 500,
    updatedAt: 1500,
  };

  const TRACKER_AUTOMATION: Automation = {
    id: 'auto-2',
    revision: 7,
    name: 'Label watch',
    enabled: false,
    ownerClientId: null,
    timeZone: 'UTC',
    trigger: {
      kind: 'tracker',
      tracker: {
        source: 'github',
        event: 'labeled',
        label: 'urgent',
        anyLabels: ['bug', 'regression'],
        allLabels: ['triaged'],
        excludeLabels: ['wontfix'],
      },
    },
    action: {
      agentProjectId: 'proj-2',
      titleTemplate: '',
      briefTemplate: 'Handle the label',
      mode: 'bypassPermissions',
      autoCreatePr: false,
      autoIntegrate: true,
    },
    enabledAt: null,
    nextRunAt: null,
    consecutiveFailures: 0,
    createdAt: 100,
    updatedAt: 200,
  };

  it('deep-equals a canonical schedule automation', () => {
    const a = SCHEDULE_AUTOMATION;
    expect(automationFromDraft(draftFromAutomation(a), a)).toEqual(a);
  });

  it('deep-equals a canonical tracker automation', () => {
    const a = TRACKER_AUTOMATION;
    expect(automationFromDraft(draftFromAutomation(a), a)).toEqual(a);
  });
});

describe('switching trigger kind', () => {
  it('keeps the other kind’s fields in the draft but emits only the active one', () => {
    const base: AutomationDraft = {
      ...newAutomationDraft({ timeZone: WARSAW, agentProjectId: 'proj-1' }),
      triggerKind: 'schedule',
      scheduleType: 'weekly',
      day: 5,
      hour: 10,
      minute: 30,
      source: 'github',
      event: 'labeled',
      label: 'urgent',
      anyLabels: 'a, b',
      allLabels: 'c',
      excludeLabels: 'd',
    };

    const scheduleTrigger = automationFromDraft(base, null).trigger;
    expect(scheduleTrigger).toEqual({
      kind: 'schedule',
      schedule: { type: 'weekly', day: 5, hour: 10, minute: 30 },
    });

    const asTracker: AutomationDraft = { ...base, triggerKind: 'tracker' };
    // Nothing about the schedule fields was wiped by switching.
    expect(asTracker.scheduleType).toBe('weekly');
    expect(asTracker.day).toBe(5);
    expect(asTracker.hour).toBe(10);
    expect(asTracker.minute).toBe(30);

    const trackerTrigger = automationFromDraft(asTracker, null).trigger;
    expect(trackerTrigger).toEqual({
      kind: 'tracker',
      tracker: {
        source: 'github',
        event: 'labeled',
        label: 'urgent',
        anyLabels: ['a', 'b'],
        allLabels: ['c'],
        excludeLabels: ['d'],
      },
    });

    const backToSchedule: AutomationDraft = { ...asTracker, triggerKind: 'schedule' };
    // Nothing about the tracker fields was wiped by switching either.
    expect(backToSchedule.source).toBe('github');
    expect(backToSchedule.label).toBe('urgent');
    expect(automationFromDraft(backToSchedule, null).trigger).toEqual(scheduleTrigger);
  });
});

describe('nextRunsPreview', () => {
  function scheduleDraft(shape: ScheduleShape, timeZone: string): AutomationDraft {
    return {
      ...newAutomationDraft({ timeZone }),
      triggerKind: 'schedule',
      scheduleType: shape.type,
      hour: shape.type !== 'hours' ? shape.hour : 0,
      minute: shape.type !== 'hours' ? shape.minute : 0,
      day: shape.type === 'weekly' ? shape.day : 1,
      every: shape.type === 'hours' ? shape.every : 1,
    };
  }

  it.each<[string, ScheduleShape, number, number]>([
    ['daily', { type: 'daily', hour: 4, minute: 0 }, iso('2026-01-10T12:00:00Z'), 10 * DAY_MS],
    [
      'weekly',
      { type: 'weekly', day: 3, hour: 9, minute: 15 },
      iso('2026-01-01T00:00:00Z'),
      60 * DAY_MS,
    ],
    ['hours', { type: 'hours', every: 6 }, iso('2026-01-10T22:30:00Z'), 5 * DAY_MS],
    // A DST (spring-forward) week in Europe/Warsaw.
    [
      'daily across Warsaw DST',
      { type: 'daily', hour: 2, minute: 30 },
      iso('2026-03-27T10:00:00Z'),
      10 * DAY_MS,
    ],
  ])('matches the first 5 of occurrencesBetween for %s', (_label, shape, now, horizonSpan) => {
    const draft = scheduleDraft(shape, WARSAW);
    const expected = occurrencesBetween(shape, now + 1, now + horizonSpan, WARSAW).slice(0, 5);
    expect(expected.length).toBe(5);
    expect(nextRunsPreview(draft, now).map((p) => p.at)).toEqual(expected);
  });

  it('is empty for a tracker draft', () => {
    const draft: AutomationDraft = {
      ...newAutomationDraft({ timeZone: WARSAW }),
      triggerKind: 'tracker',
    };
    expect(nextRunsPreview(draft, Date.now())).toEqual([]);
  });

  it('is empty for a bad time zone, without throwing', () => {
    const draft: AutomationDraft = {
      ...newAutomationDraft({ timeZone: 'Not/ARealZone' }),
      triggerKind: 'schedule',
    };
    expect(() => nextRunsPreview(draft, Date.now())).not.toThrow();
    expect(nextRunsPreview(draft, Date.now())).toEqual([]);
  });
});

describe('manual mode', () => {
  const manualDraft: AutomationDraft = {
    ...newAutomationDraft({ timeZone: 'UTC', agentProjectId: 'proj-1' }),
    name: 'Nightly triage',
    mode: 'manual',
  };

  it('surfaces the validator’s explanation in draftErrors', () => {
    expect(draftErrors(manualDraft)).toContain(MANUAL_MODE_EXPLANATION);
  });

  it('marks the manual option disabled with MANUAL_MODE_EXPLANATION', () => {
    const manualOption = automationModeOptions().find((o) => o.value === 'manual');
    expect(manualOption?.disabled).toBe(true);
    expect(manualOption?.explanation).toBe(MANUAL_MODE_EXPLANATION);
  });
});

describe('templatePreview', () => {
  it('renders {{automation.name}} and {{date}} in the draft’s time zone', () => {
    const draft: AutomationDraft = {
      ...newAutomationDraft({ timeZone: WARSAW }),
      name: 'Nightly triage',
      titleTemplate: '{{automation.name}} — {{date}}',
      briefTemplate: '{{date}}',
    };
    const now = iso('2026-03-15T23:30:00Z'); // 2026-03-16 00:30 in Warsaw (CET, UTC+1)

    expect(templatePreview(draft, now)).toEqual({
      title: 'Nightly triage — 2026-03-16',
      brief: '2026-03-16',
    });
  });

  it('leaves unknown variables verbatim', () => {
    const draft: AutomationDraft = {
      ...newAutomationDraft({ timeZone: 'UTC' }),
      name: 'Nightly triage',
      titleTemplate: '{{automation.name}} {{nope}} {{ticket.bogus}}',
      briefTemplate: '',
    };

    expect(templatePreview(draft, Date.now()).title).toBe(
      'Nightly triage {{nope}} {{ticket.bogus}}',
    );
  });
});
