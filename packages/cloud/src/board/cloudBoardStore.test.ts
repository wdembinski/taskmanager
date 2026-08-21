import { describe, expect, it } from 'vitest';
import type { BoardResponse } from '@tm/protocol/wire';
import type { Task } from '@tm/shared/model';
import {
  EMPTY_BOARD_STATE,
  PENDING_STATUS_TIMEOUT_MS,
  applyBoardResponse,
  displayStatus,
  expirePendingStatusChanges,
  isTaskPending,
  queuePendingStatusChange,
} from './cloudBoardStore';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    projectId: 'p1',
    phase: '',
    title: 'A task',
    status: 'pending',
    order: 0,
    ...overrides,
  } as Task;
}

function boardResponse(overrides: Partial<BoardResponse> = {}): BoardResponse {
  return {
    cursor: 'c1',
    cadence: { tier: 'active', intervalMs: 2500, reason: 'web-focused' },
    deltas: { tasks: [], projects: [], deletedTaskIds: [], deletedProjectIds: [] },
    clients: [],
    ...overrides,
  };
}

describe('applyBoardResponse', () => {
  it('upserts tasks and projects by id', () => {
    const state = applyBoardResponse(
      EMPTY_BOARD_STATE,
      boardResponse({
        deltas: { tasks: [task()], projects: [], deletedTaskIds: [], deletedProjectIds: [] },
      }),
    );
    expect(state.tasks['t1']?.title).toBe('A task');
    expect(state.cursor).toBe('c1');
  });

  it('drops deleted ids', () => {
    const seeded = applyBoardResponse(
      EMPTY_BOARD_STATE,
      boardResponse({
        deltas: { tasks: [task()], projects: [], deletedTaskIds: [], deletedProjectIds: [] },
      }),
    );
    const state = applyBoardResponse(
      seeded,
      boardResponse({
        deltas: { tasks: [], projects: [], deletedTaskIds: ['t1'], deletedProjectIds: [] },
      }),
    );
    expect(state.tasks['t1']).toBeUndefined();
  });

  it('carries the clients list through untouched', () => {
    const state = applyBoardResponse(
      EMPTY_BOARD_STATE,
      boardResponse({ clients: [{ id: 'desktop-1', lastSeen: 500 }] }),
    );
    expect(state.clients).toEqual([{ id: 'desktop-1', lastSeen: 500 }]);
  });

  it('drops a pending status change once the polled task matches what it asked for', () => {
    const seeded = applyBoardResponse(
      EMPTY_BOARD_STATE,
      boardResponse({
        deltas: {
          tasks: [task({ status: 'pending' })],
          projects: [],
          deletedTaskIds: [],
          deletedProjectIds: [],
        },
      }),
    );
    const withPending = queuePendingStatusChange(seeded, {
      commandId: 'cmd-1',
      taskId: 't1',
      status: 'in-progress',
      issuedAt: 0,
    });
    expect(isTaskPending(withPending, 't1')).toBe(true);

    // Poll comes back before the desktop Client has applied it — status unchanged, still pending.
    const stillPending = applyBoardResponse(
      withPending,
      boardResponse({
        deltas: {
          tasks: [task({ status: 'pending' })],
          projects: [],
          deletedTaskIds: [],
          deletedProjectIds: [],
        },
      }),
    );
    expect(isTaskPending(stillPending, 't1')).toBe(true);

    // Poll comes back after the desktop Client applied it — reconciled, no longer pending.
    const reconciled = applyBoardResponse(
      stillPending,
      boardResponse({
        deltas: {
          tasks: [task({ status: 'in-progress' })],
          projects: [],
          deletedTaskIds: [],
          deletedProjectIds: [],
        },
      }),
    );
    expect(isTaskPending(reconciled, 't1')).toBe(false);
  });

  it('leaves an unrelated task´s pending change alone', () => {
    const withPending = queuePendingStatusChange(EMPTY_BOARD_STATE, {
      commandId: 'cmd-1',
      taskId: 't1',
      status: 'in-progress',
      issuedAt: 0,
    });
    const state = applyBoardResponse(
      withPending,
      boardResponse({
        deltas: {
          tasks: [task({ id: 't2', status: 'done' })],
          projects: [],
          deletedTaskIds: [],
          deletedProjectIds: [],
        },
      }),
    );
    expect(isTaskPending(state, 't1')).toBe(true);
  });
});

describe('displayStatus', () => {
  it('is the mirrored status with nothing pending', () => {
    expect(displayStatus(EMPTY_BOARD_STATE, task({ status: 'done' }))).toBe('done');
  });

  it('is the pending status while a change is in flight', () => {
    const state = queuePendingStatusChange(EMPTY_BOARD_STATE, {
      commandId: 'cmd-1',
      taskId: 't1',
      status: 'blocked',
      issuedAt: 0,
    });
    expect(displayStatus(state, task({ status: 'pending' }))).toBe('blocked');
  });

  it('shows the most recently issued pending change when a card is dragged twice', () => {
    let state = queuePendingStatusChange(EMPTY_BOARD_STATE, {
      commandId: 'cmd-1',
      taskId: 't1',
      status: 'blocked',
      issuedAt: 0,
    });
    state = queuePendingStatusChange(state, {
      commandId: 'cmd-2',
      taskId: 't1',
      status: 'done',
      issuedAt: 100,
    });
    expect(displayStatus(state, task({ status: 'pending' }))).toBe('done');
  });
});

describe('expirePendingStatusChanges', () => {
  it('drops a change older than the timeout', () => {
    const state = queuePendingStatusChange(EMPTY_BOARD_STATE, {
      commandId: 'cmd-1',
      taskId: 't1',
      status: 'blocked',
      issuedAt: 0,
    });
    const expired = expirePendingStatusChanges(state, PENDING_STATUS_TIMEOUT_MS + 1);
    expect(isTaskPending(expired, 't1')).toBe(false);
  });

  it('keeps a change still inside the timeout', () => {
    const state = queuePendingStatusChange(EMPTY_BOARD_STATE, {
      commandId: 'cmd-1',
      taskId: 't1',
      status: 'blocked',
      issuedAt: 0,
    });
    const kept = expirePendingStatusChanges(state, PENDING_STATUS_TIMEOUT_MS - 1);
    expect(isTaskPending(kept, 't1')).toBe(true);
  });
});
