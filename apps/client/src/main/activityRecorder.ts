/**
 * A thin, safe wrapper over `store.appendActivity` (F2.4) that the scheduler calls at the
 * moments it already knows a run started or how it ended
 * (`docs/plan/feature-roadmap/F2-activity-dashboard.md`). Activity is observability, never
 * a reason a run fails — every method here swallows its own errors and logs instead.
 */
import type { ActivityOrigin, ActivityOutcome, ActivityRow } from '@shared/activity';
import { logMain } from './log';

/** The run-identifying fields every row needs, `title` being a card-title SNAPSHOT. */
interface RunRef {
  projectId: string;
  taskId: string;
  runId: string;
  title: string;
}

export interface ActivityRecorder {
  /** A general entry for a non-run kind (parks, merges, moves — F2.7/F2.8's territory). */
  record(row: Omit<ActivityRow, 'id'>): void;
  runStarted(r: RunRef & { origin: ActivityOrigin }): void;
  runFinished(
    r: RunRef & { origin: ActivityOrigin; outcome: ActivityOutcome; costUsd: number | null },
  ): void;
}

export function createActivityRecorder(deps: {
  append: (row: Omit<ActivityRow, 'id'>) => ActivityRow | null;
  /** Fires only for a non-null (non-duplicate) row — F2.9 wires this to `activity:appended`. */
  onAppended?: (row: ActivityRow) => void;
  log?: (message: string, err?: unknown) => void;
  now?: () => number;
}): ActivityRecorder {
  const log = deps.log ?? logMain;
  const now = deps.now ?? Date.now;

  function append(kind: string, row: Omit<ActivityRow, 'id'>): void {
    try {
      const appended = deps.append(row);
      if (appended) deps.onAppended?.(appended);
    } catch (err) {
      log(`activity: could not record ${kind}`, err);
    }
  }

  return {
    record(row) {
      append(row.kind, row);
    },
    runStarted(r) {
      append('run-started', {
        at: now(),
        projectId: r.projectId,
        taskId: r.taskId,
        runId: r.runId,
        kind: 'run-started',
        outcome: null,
        origin: r.origin,
        title: r.title,
        costUsd: null,
        detail: null,
      });
    },
    runFinished(r) {
      append('run-finished', {
        at: now(),
        projectId: r.projectId,
        taskId: r.taskId,
        runId: r.runId,
        kind: 'run-finished',
        outcome: r.outcome,
        origin: r.origin,
        title: r.title,
        costUsd: r.costUsd,
        detail: null,
      });
    },
  };
}

/** No recorder wired yet (before `ipc.ts` calls `setActivityRecorder`) — every call is a no-op. */
export const NULL_ACTIVITY_RECORDER: ActivityRecorder = {
  record() {},
  runStarted() {},
  runFinished() {},
};
