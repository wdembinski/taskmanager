import { describe, expect, it } from 'vitest';
import type { Automation, AutomationRun } from '@tm/shared/automation';
import { wallToUtc } from '@tm/shared/automationSchedule';
import { layoutWeek, outcomeTone, weekStartOf } from './weekCalendarLayout';

const WARSAW = 'Europe/Warsaw';
const NEW_YORK = 'America/New_York';

const iso = (s: string): number => new Date(s).getTime();
const HOUR_MS = 60 * 60_000;

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

describe('weekStartOf', () => {
  it('resolves to Monday 00:00 in viewTz from any day in that week', () => {
    // 2026-01-07 is a Wednesday.
    const wednesday = iso('2026-01-07T12:00:00Z');
    expect(weekStartOf(wednesday, WARSAW)).toBe(wallToUtc(2026, 1, 5, 0, 0, WARSAW));
  });

  it('a DST week is 167 hours, not 168', () => {
    // The week of 2026-03-23 .. 2026-03-30 contains Warsaw's spring-forward gap.
    const thisWeek = weekStartOf(iso('2026-03-25T12:00:00Z'), WARSAW);
    const nextWeek = weekStartOf(iso('2026-04-01T12:00:00Z'), WARSAW);
    expect(thisWeek).toBe(wallToUtc(2026, 3, 23, 0, 0, WARSAW));
    expect(nextWeek).toBe(wallToUtc(2026, 3, 30, 0, 0, WARSAW));
    expect(nextWeek - thisWeek).toBe(167 * HOUR_MS);
  });

  it('a fall-back week is 169 hours, not 168', () => {
    // The week of 2026-10-19 .. 2026-10-26 contains Warsaw's fall-back.
    const thisWeek = weekStartOf(iso('2026-10-21T12:00:00Z'), WARSAW);
    const nextWeek = weekStartOf(iso('2026-10-28T12:00:00Z'), WARSAW);
    expect(nextWeek - thisWeek).toBe(169 * HOUR_MS);
  });
});

describe('layoutWeek — placing occurrences', () => {
  it('a plain daily schedule gets one cell per day, Monday first', () => {
    const weekStartMs = wallToUtc(2026, 1, 5, 0, 0, WARSAW);
    const result = layoutWeek({
      automations: [scheduleAutomation()],
      runs: [],
      weekStartMs,
      nowMs: weekStartMs,
      viewTz: WARSAW,
    });

    expect(result.days).toHaveLength(7);
    expect(result.days[0].isoDay).toBe(1);
    expect(result.days[6].isoDay).toBe(7);
    expect(result.cells).toHaveLength(7);
    expect(result.cells.map((c) => c.day)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const cell of result.cells) expect(cell.hour).toBe(4);
  });

  it('places an occurrence by the VIEWER time zone, not the automation’s own', () => {
    // America/New_York daily 09:00 in January (EST, UTC-5) fires at 14:00 UTC, which reads
    // as 15:00 in Warsaw (CET, UTC+1) — a 6-hour difference, not the New York hour.
    const automation = scheduleAutomation({
      timeZone: NEW_YORK,
      trigger: { kind: 'schedule', schedule: { type: 'daily', hour: 9, minute: 0 } },
    });
    const weekStartMs = wallToUtc(2026, 1, 5, 0, 0, WARSAW);
    const result = layoutWeek({
      automations: [automation],
      runs: [],
      weekStartMs,
      nowMs: weekStartMs,
      viewTz: WARSAW,
    });

    expect(result.cells).toHaveLength(7);
    for (const cell of result.cells) expect(cell.hour).toBe(15);
  });

  it('a wall time inside the spring-forward gap lands on the post-gap hour', () => {
    const automation = scheduleAutomation({
      trigger: { kind: 'schedule', schedule: { type: 'daily', hour: 2, minute: 30 } },
    });
    const weekStartMs = wallToUtc(2026, 3, 23, 0, 0, WARSAW);
    const result = layoutWeek({
      automations: [automation],
      runs: [],
      weekStartMs,
      nowMs: weekStartMs,
      viewTz: WARSAW,
    });

    expect(result.cells).toHaveLength(7);
    // Sunday 2026-03-29 is this week's day index 6 — see automationSchedule.test.ts's own
    // fixture for why this resolves to 03:00, not 02:30.
    const gapDayCell = result.cells.find((c) => c.day === 6);
    expect(gapDayCell?.at).toBe(iso('2026-03-29T01:00:00Z'));
    expect(gapDayCell?.hour).toBe(3);
  });

  it('marks a past occurrence’s outcome from its receipt, "missed" with none, null if future', () => {
    const automation = scheduleAutomation();
    const weekStartMs = wallToUtc(2026, 1, 5, 0, 0, WARSAW);
    // Occurrences: Mon 03:00Z, Tue 03:00Z, Wed 03:00Z, ... (04:00 Warsaw = 03:00 UTC in Jan).
    const monday = run({ occurrenceKey: 'schedule:2026-01-05T03:00:00.000Z', status: 'started' });
    const nowMs = iso('2026-01-06T12:00:00Z'); // after Monday and Tuesday's occurrences, before Wednesday's

    const result = layoutWeek({
      automations: [automation],
      runs: [monday],
      weekStartMs,
      nowMs,
      viewTz: WARSAW,
    });

    const byDay = new Map(result.cells.map((c) => [c.day, c]));
    expect(byDay.get(0)).toMatchObject({ past: true, outcome: 'started' });
    expect(byDay.get(1)).toMatchObject({ past: true, outcome: 'missed' });
    expect(byDay.get(2)).toMatchObject({ past: false, outcome: null });
  });

  it('still draws a disabled automation’s cells, flagged enabled: false', () => {
    const weekStartMs = wallToUtc(2026, 1, 5, 0, 0, WARSAW);
    const result = layoutWeek({
      automations: [scheduleAutomation({ enabled: false })],
      runs: [],
      weekStartMs,
      nowMs: weekStartMs,
      viewTz: WARSAW,
    });

    expect(result.cells).toHaveLength(7);
    for (const cell of result.cells) expect(cell.enabled).toBe(false);
  });

  it('routes tracker-kind automations to the strip, enabled or not, with no cells', () => {
    const weekStartMs = wallToUtc(2026, 1, 5, 0, 0, WARSAW);
    const result = layoutWeek({
      automations: [trackerAutomation(), trackerAutomation({ id: 'auto-3', enabled: false })],
      runs: [],
      weekStartMs,
      nowMs: weekStartMs,
      viewTz: WARSAW,
    });

    expect(result.cells).toHaveLength(0);
    expect(result.trackerStrip.map((a) => a.id)).toEqual(['auto-2', 'auto-3']);
  });

  it('a fall-back week still gets exactly one entry on the ambiguous day', () => {
    // 2026-10-25 is Warsaw's fall-back Sunday (03:00 CEST → 02:00 CET), so wall time 02:30
    // happens twice in real time. occurrencesBetween de-duplicates across that repeat
    // (automationSchedule.ts); this only proves the week layout doesn't reintroduce a
    // second cell for the day on top of it.
    const automation = scheduleAutomation({
      trigger: { kind: 'schedule', schedule: { type: 'daily', hour: 2, minute: 30 } },
    });
    const weekStartMs = wallToUtc(2026, 10, 19, 0, 0, WARSAW);
    const result = layoutWeek({
      automations: [automation],
      runs: [],
      weekStartMs,
      nowMs: weekStartMs,
      viewTz: WARSAW,
    });

    expect(result.cells).toHaveLength(7);
    const fallBackDayCells = result.cells.filter((c) => c.day === 6); // Sunday 2026-10-25
    expect(fallBackDayCells).toHaveLength(1);
  });

  it('an hours/6 schedule gets the same count per day through a DST week', () => {
    const automation = scheduleAutomation({
      trigger: { kind: 'schedule', schedule: { type: 'hours', every: 6 } },
    });
    const weekStartMs = wallToUtc(2026, 3, 23, 0, 0, WARSAW); // contains the spring-forward gap
    const result = layoutWeek({
      automations: [automation],
      runs: [],
      weekStartMs,
      nowMs: weekStartMs,
      viewTz: WARSAW,
    });

    expect(result.cells).toHaveLength(28); // 4 a day (00/06/12/18) × 7 days
    for (let day = 0; day < 7; day++) {
      expect(result.cells.filter((c) => c.day === day)).toHaveLength(4);
    }
  });

  it('skips an automation whose time zone is unresolvable instead of throwing', () => {
    const weekStartMs = wallToUtc(2026, 1, 5, 0, 0, WARSAW);
    const result = layoutWeek({
      automations: [
        scheduleAutomation({ timeZone: 'Not/AZone' }),
        scheduleAutomation({ id: 'auto-3' }),
      ],
      runs: [],
      weekStartMs,
      nowMs: weekStartMs,
      viewTz: WARSAW,
    });

    expect(result.cells.every((c) => c.automationId === 'auto-3')).toBe(true);
    expect(result.cells).toHaveLength(7);
  });
});

describe('outcomeTone', () => {
  it('maps each outcome to its tone', () => {
    expect(outcomeTone('started')).toBe('brand');
    expect(outcomeTone('reserved')).toBe('brand');
    expect(outcomeTone('parked')).toBe('warning');
    expect(outcomeTone('missed')).toBe('warning');
    expect(outcomeTone('refused')).toBe('danger');
    expect(outcomeTone('error')).toBe('danger');
    expect(outcomeTone('skipped')).toBe('neutral');
    expect(outcomeTone('duplicate')).toBe('neutral');
    expect(outcomeTone(null)).toBe('neutral');
  });
});
