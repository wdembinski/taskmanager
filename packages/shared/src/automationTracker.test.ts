import { describe, expect, it } from 'vitest';
import {
  detectTrackerEvents,
  matchesTrackerTrigger,
  trackerReceiptKey,
  type TrackerEvent,
} from './automationTracker';
import type { TrackerTrigger } from './automation';
import type { Task } from './model';

const card = (over: Partial<Task> = {}): Task => ({
  id: 'task-1',
  projectId: 'proj-1',
  phase: '',
  title: 'Fix the thing',
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'jira',
  isContract: false,
  isScaffold: false,
  externalKey: 'TM-1',
  externalStatus: 'To Do',
  labels: [],
  ...over,
});

const NOW = 1_000;

describe('detectTrackerEvents', () => {
  it('fires appeared for a key absent from before, and nothing else in the same sweep', () => {
    const events = detectTrackerEvents(
      [],
      [card({ externalStatus: 'To Do', labels: ['bug'] })],
      NOW,
    );
    expect(events).toEqual([
      {
        kind: 'appeared',
        source: 'jira',
        taskId: 'task-1',
        externalKey: 'TM-1',
        value: null,
        labels: ['bug'],
        at: NOW,
      },
    ]);
  });

  it('fires entered-status when externalStatus differs, with value = the new status', () => {
    const before = [card({ externalStatus: 'To Do' })];
    const after = [card({ externalStatus: 'In Progress' })];
    const events = detectTrackerEvents(before, after, NOW);
    expect(events).toEqual([
      {
        kind: 'entered-status',
        source: 'jira',
        taskId: 'task-1',
        externalKey: 'TM-1',
        value: 'In Progress',
        labels: [],
        at: NOW,
      },
    ]);
  });

  it('a trigger watching entered-status matches "to do" against "To Do"', () => {
    const event: TrackerEvent = {
      kind: 'entered-status',
      source: 'jira',
      taskId: 'task-1',
      externalKey: 'TM-1',
      value: 'To Do',
      labels: [],
      at: NOW,
    };
    const trigger: TrackerTrigger = { source: 'jira', event: 'entered-status', status: 'to do' };
    expect(matchesTrackerTrigger(event, trigger, 0)).toBe(true);
  });

  it('treats a case-only status change as no change', () => {
    const before = [card({ externalStatus: 'To Do' })];
    const after = [card({ externalStatus: '  TO DO  ' })];
    expect(detectTrackerEvents(before, after, NOW)).toEqual([]);
  });

  it('does not fire entered-status when the new status is empty', () => {
    const before = [card({ externalStatus: 'To Do' })];
    const after = [card({ externalStatus: null })];
    expect(detectTrackerEvents(before, after, NOW)).toEqual([]);
  });

  it('fires labeled for each label added, case-insensitively, but not for one removed', () => {
    const before = [card({ labels: ['bug'] })];
    const after = [card({ labels: ['Bug', 'needs-agent'] })];
    const events = detectTrackerEvents(before, after, NOW);
    expect(events).toEqual([
      {
        kind: 'labeled',
        source: 'jira',
        taskId: 'task-1',
        externalKey: 'TM-1',
        value: 'needs-agent',
        labels: ['Bug', 'needs-agent'],
        at: NOW,
      },
    ]);
  });

  it('fires nothing for a removed label', () => {
    const before = [card({ labels: ['bug', 'needs-agent'] })];
    const after = [card({ labels: ['bug'] })];
    expect(detectTrackerEvents(before, after, NOW)).toEqual([]);
  });

  it('fires nothing for an unchanged card', () => {
    const before = [card()];
    const after = [card()];
    expect(detectTrackerEvents(before, after, NOW)).toEqual([]);
  });

  it('fires nothing for a card only in before (a removal)', () => {
    expect(detectTrackerEvents([card()], [], NOW)).toEqual([]);
  });

  it('ignores plan, adhoc and ticket sources', () => {
    for (const source of ['plan', 'adhoc', 'ticket'] as const) {
      const after = [card({ source, externalKey: 'TM-1' })];
      expect(detectTrackerEvents([], after, NOW)).toEqual([]);
    }
  });

  it('ignores a tracker card with no externalKey', () => {
    const after = [card({ externalKey: null })];
    expect(detectTrackerEvents([], after, NOW)).toEqual([]);
  });
});

describe('matchesTrackerTrigger', () => {
  const statusTrigger: TrackerTrigger = {
    source: 'jira',
    event: 'entered-status',
    status: 'To Do',
  };
  const labelTrigger: TrackerTrigger = { source: 'jira', event: 'labeled', label: 'needs-agent' };

  const statusEvent = (over: Partial<TrackerEvent> = {}): TrackerEvent => ({
    kind: 'entered-status',
    source: 'jira',
    taskId: 'task-1',
    externalKey: 'TM-1',
    value: 'To Do',
    labels: [],
    at: 100,
    ...over,
  });

  it('is false when enabledAt is null', () => {
    expect(matchesTrackerTrigger(statusEvent(), statusTrigger, null)).toBe(false);
  });

  it('is false when the event predates enabledAt', () => {
    expect(matchesTrackerTrigger(statusEvent({ at: 100 }), statusTrigger, 100)).toBe(true);
    expect(matchesTrackerTrigger(statusEvent({ at: 99 }), statusTrigger, 100)).toBe(false);
  });

  it('is false on a mismatched source', () => {
    expect(matchesTrackerTrigger(statusEvent({ source: 'github' }), statusTrigger, 0)).toBe(false);
  });

  it('is false on a mismatched kind', () => {
    const labeled: TrackerEvent = { ...statusEvent(), kind: 'labeled', value: 'needs-agent' };
    expect(matchesTrackerTrigger(labeled, statusTrigger, 0)).toBe(false);
  });

  it('is false on a mismatched status', () => {
    expect(matchesTrackerTrigger(statusEvent({ value: 'Done' }), statusTrigger, 0)).toBe(false);
  });

  it('is false on a mismatched label', () => {
    const labeled: TrackerEvent = { ...statusEvent(), kind: 'labeled', value: 'other-label' };
    expect(matchesTrackerTrigger(labeled, labelTrigger, 0)).toBe(false);
  });

  it('anyLabels passes once at least one listed label is present', () => {
    const trigger: TrackerTrigger = { ...statusTrigger, anyLabels: ['urgent', 'bug'] };
    expect(matchesTrackerTrigger(statusEvent({ labels: ['bug'] }), trigger, 0)).toBe(true);
    expect(matchesTrackerTrigger(statusEvent({ labels: ['other'] }), trigger, 0)).toBe(false);
  });

  it('allLabels requires every listed label to be present', () => {
    const trigger: TrackerTrigger = { ...statusTrigger, allLabels: ['urgent', 'bug'] };
    expect(
      matchesTrackerTrigger(statusEvent({ labels: ['urgent', 'bug', 'extra'] }), trigger, 0),
    ).toBe(true);
    expect(matchesTrackerTrigger(statusEvent({ labels: ['urgent'] }), trigger, 0)).toBe(false);
  });

  it('excludeLabels fails when any listed label is present', () => {
    const trigger: TrackerTrigger = { ...statusTrigger, excludeLabels: ['wontfix'] };
    expect(matchesTrackerTrigger(statusEvent({ labels: ['bug'] }), trigger, 0)).toBe(true);
    expect(matchesTrackerTrigger(statusEvent({ labels: ['bug', 'wontfix'] }), trigger, 0)).toBe(
      false,
    );
  });

  it('label filters compare case-insensitively and pass when empty or undefined', () => {
    const trigger: TrackerTrigger = { ...statusTrigger, anyLabels: ['URGENT'] };
    expect(matchesTrackerTrigger(statusEvent({ labels: ['urgent'] }), trigger, 0)).toBe(true);
    expect(matchesTrackerTrigger(statusEvent({ labels: [] }), statusTrigger, 0)).toBe(true);
  });
});

describe('trackerReceiptKey', () => {
  it('is stable across a status change in case only', () => {
    const a: TrackerEvent = {
      kind: 'entered-status',
      source: 'jira',
      taskId: 'task-1',
      externalKey: 'TM-1',
      value: 'To Do',
      labels: [],
      at: 1,
    };
    const b: TrackerEvent = { ...a, value: 'TO DO', at: 2 };
    expect(trackerReceiptKey(a)).toBe(trackerReceiptKey(b));
    expect(trackerReceiptKey(a)).toBe('tracker:task-1:entered-status:to do');
  });

  it('uses an empty value for appeared', () => {
    const event: TrackerEvent = {
      kind: 'appeared',
      source: 'jira',
      taskId: 'task-1',
      externalKey: 'TM-1',
      value: null,
      labels: [],
      at: 1,
    };
    expect(trackerReceiptKey(event)).toBe('tracker:task-1:appeared:');
  });
});
