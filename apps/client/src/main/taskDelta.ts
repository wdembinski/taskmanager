/**
 * Only the cards that changed (F29.2) — what replaced the old whole-board push, which sent a
 * board's WHOLE list of full rows after every action (27 MB per Approve on the 5,000-card
 * fixture, `docs/plan/feature-roadmap/F29-performance-at-scale.md`).
 *
 * Many senders do not know which ids an action touched — the plan watcher, a tracker sweep,
 * a relayed cloud command — so the pusher never asks them. It keeps a snapshot of the
 * summaries each board last showed, re-reads the board on `push(projectId)`, and sends the
 * difference as one `tasks:changed` delta: the cards that are new or differ, and the ids that
 * left. Nothing differs, nothing is sent.
 *
 * The snapshot is seeded by `board:tasks` (what the renderer just loaded) and refreshed by
 * every push. A board with no snapshot yet sends every card as an upsert — correct for any
 * list, because an upsert of a card a list already holds replaces it in place.
 *
 * `noteChanged` keeps the snapshot honest about `task:changed`: that event already carried
 * the card's new summary, so the next push must not send it again. It only touches the board
 * the snapshot already holds the card on — a card that MOVED boards still needs its removal
 * from the source and its upsert on the destination, because a one-board list never patches
 * a card it does not hold.
 */
import {
  sameTaskSummary,
  toTaskSummary,
  type TaskDelta,
  type TaskSummary,
} from '@shared/taskSummary';

export interface TaskDeltaPusherDeps {
  /** One board's cards as `board:tasks(projectId)` returns them — archived rows excluded. */
  readBoard: (projectId: string) => TaskSummary[];
  /** `send('tasks:changed', delta)`. */
  send: (delta: TaskDelta) => void;
}

export interface TaskDeltaPusher {
  /** Record what a board shows now, e.g. the rows `board:tasks` just answered with. */
  seed: (projectId: string, summaries: readonly TaskSummary[]) => void;
  /** Re-read one board and send what changed since its snapshot, if anything did. */
  push: (projectId: string) => void;
  /** A `task:changed` just carried this card; fold it into its board's snapshot. */
  noteChanged: (task: TaskSummary) => void;
}

export function createTaskDeltaPusher({ readBoard, send }: TaskDeltaPusherDeps): TaskDeltaPusher {
  const snapshots = new Map<string, Map<string, TaskSummary>>();

  const toSnapshot = (rows: readonly TaskSummary[]): Map<string, TaskSummary> =>
    new Map(rows.map((row) => [row.id, toTaskSummary(row)]));

  return {
    seed(projectId, summaries) {
      snapshots.set(projectId, toSnapshot(summaries));
    },

    push(projectId) {
      const before = snapshots.get(projectId);
      const after = toSnapshot(readBoard(projectId));
      snapshots.set(projectId, after);

      const upserted: TaskSummary[] = [];
      for (const [id, row] of after) {
        const prev = before?.get(id);
        if (!prev || !sameTaskSummary(prev, row)) upserted.push(row);
      }
      const removed: string[] = [];
      if (before) for (const id of before.keys()) if (!after.has(id)) removed.push(id);

      if (upserted.length === 0 && removed.length === 0) return;
      send({ projectId, upserted, removed });
    },

    noteChanged(task) {
      const snapshot = snapshots.get(task.projectId);
      if (snapshot?.has(task.id)) snapshot.set(task.id, toTaskSummary(task));
    },
  };
}
