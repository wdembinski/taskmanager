import { describe, expect, it, vi } from 'vitest';
import type { AutoArchivableTicket } from '@shared/autoArchive';
import type { Milestone } from '@shared/model';
import type { ArchiveResult } from '@shared/trackerArchive';
import {
  runAutoArchiveSweep,
  startAutoArchiveSweep,
  type AutoArchiveSweepDeps,
} from './autoArchiveSweep';

const NOW = Date.UTC(2026, 9, 17);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function milestone(over: Partial<Milestone> & { id: string }): Milestone {
  return {
    projectId: 'p1',
    name: 'M1',
    description: '',
    dueAt: null,
    color: '',
    closed: false,
    archivedAt: null,
    createdAt: NOW,
    ...over,
  };
}

function ticket(
  over: Partial<AutoArchivableTicket> & { id: string; milestoneId: string },
): AutoArchivableTicket {
  return { status: 'done', updatedAt: NOW - 10 * WEEK_MS, ...over };
}

function okResult(projectId = 'p1'): ArchiveResult {
  return { ok: true, projectId, changedTaskIds: [], milestonesChanged: true };
}

function baseDeps(overrides: Partial<AutoArchiveSweepDeps> = {}): AutoArchiveSweepDeps {
  return {
    getSettings: () => ({ ticketAutoArchiveWeeks: 2 }),
    listMilestones: () => [],
    listMilestoneTickets: () => [],
    ticketDoneTimes: () => new Map(),
    archiveMilestone: vi.fn(() => okResult()),
    appendActivity: vi.fn((row) => ({ id: 1, ...row })),
    onMilestonesChanged: vi.fn(),
    log: vi.fn(),
    ...overrides,
  };
}

describe('runAutoArchiveSweep', () => {
  it('off (ticketAutoArchiveWeeks: null) makes no store writes', () => {
    const archiveMilestone = vi.fn();
    const appendActivity = vi.fn();
    const onMilestonesChanged = vi.fn();
    const deps = baseDeps({
      getSettings: () => ({ ticketAutoArchiveWeeks: null }),
      listMilestones: () => [milestone({ id: 'm1' })],
      listMilestoneTickets: () => [ticket({ id: 't1', milestoneId: 'm1' })],
      archiveMilestone,
      appendActivity,
      onMilestonesChanged,
    });

    expect(runAutoArchiveSweep(deps, NOW)).toEqual([]);
    expect(archiveMilestone).not.toHaveBeenCalled();
    expect(appendActivity).not.toHaveBeenCalled();
    expect(onMilestonesChanged).not.toHaveBeenCalled();
  });

  it('archives one due milestone, records one activity row, pushes once', () => {
    const archiveMilestone = vi.fn(() => okResult('p1'));
    const appendActivity = vi.fn((row) => ({ id: 1, ...row }));
    const onMilestonesChanged = vi.fn();
    const deps = baseDeps({
      listMilestones: () => [milestone({ id: 'm1', name: 'Launch', projectId: 'p1' })],
      listMilestoneTickets: () => [ticket({ id: 't1', milestoneId: 'm1' })],
      archiveMilestone,
      appendActivity,
      onMilestonesChanged,
    });

    expect(runAutoArchiveSweep(deps, NOW)).toEqual(['m1']);
    expect(archiveMilestone).toHaveBeenCalledWith('m1', { kind: 'backlog' }, NOW);
    expect(appendActivity).toHaveBeenCalledWith({
      at: NOW,
      projectId: 'p1',
      taskId: null,
      runId: null,
      kind: 'milestone-archived',
      outcome: null,
      origin: null,
      title: 'Launch',
      costUsd: null,
      detail: { reason: 'auto', milestoneId: 'm1' },
    });
    expect(onMilestonesChanged).toHaveBeenCalledTimes(1);
  });

  it('a refusal writes no activity row and never pushes', () => {
    const archiveMilestone = vi.fn((): ArchiveResult => ({
      ok: false,
      reason: 'already-archived',
      message: 'already archived',
    }));
    const appendActivity = vi.fn();
    const onMilestonesChanged = vi.fn();
    const log = vi.fn();
    const deps = baseDeps({
      listMilestones: () => [milestone({ id: 'm1' })],
      listMilestoneTickets: () => [ticket({ id: 't1', milestoneId: 'm1' })],
      archiveMilestone,
      appendActivity,
      onMilestonesChanged,
      log,
    });

    expect(runAutoArchiveSweep(deps, NOW)).toEqual([]);
    expect(appendActivity).not.toHaveBeenCalled();
    expect(onMilestonesChanged).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it('an append failure on one milestone does not stop the next from archiving', () => {
    const archiveMilestone = vi.fn(() => okResult());
    const appendActivity = vi.fn(() => {
      throw new Error('db is locked');
    });
    const onMilestonesChanged = vi.fn();
    const log = vi.fn();
    const deps = baseDeps({
      listMilestones: () => [milestone({ id: 'm1' }), milestone({ id: 'm2' })],
      listMilestoneTickets: () => [
        ticket({ id: 't1', milestoneId: 'm1' }),
        ticket({ id: 't2', milestoneId: 'm2' }),
      ],
      archiveMilestone,
      appendActivity,
      onMilestonesChanged,
      log,
    });

    expect(runAutoArchiveSweep(deps, NOW)).toEqual(['m1', 'm2']);
    expect(archiveMilestone).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalled();
    expect(onMilestonesChanged).toHaveBeenCalledTimes(1);
  });

  it('a sweep error (a dep throwing) never escapes', () => {
    const deps = baseDeps({
      listMilestones: () => {
        throw new Error('store is gone');
      },
    });
    expect(runAutoArchiveSweep(deps, NOW)).toEqual([]);
    expect(deps.log).toHaveBeenCalled();
  });
});

describe('startAutoArchiveSweep', () => {
  it('runs once immediately, then again on the hour, and stops when told to', () => {
    vi.useFakeTimers();
    try {
      const archiveMilestone = vi.fn(() => okResult());
      const deps = baseDeps({
        listMilestones: () => [milestone({ id: 'm1' })],
        listMilestoneTickets: () => [ticket({ id: 't1', milestoneId: 'm1' })],
        archiveMilestone,
      });

      const stop = startAutoArchiveSweep(deps);
      expect(archiveMilestone).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(archiveMilestone).toHaveBeenCalledTimes(2);

      stop();
      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(archiveMilestone).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
