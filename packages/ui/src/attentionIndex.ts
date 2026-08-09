/**
 * The shape of the board's inbox index, passed into `TaskDetail` as a prop.
 *
 * Only the type moved here — `useAttentionIndex` itself (`apps/client/src/renderer/src/
 * useAttentionIndex.ts`) subscribes over `window.api` directly and stays in apps/client,
 * mounted once in `MyTasks` the way it always was. `TaskDetail` only ever reads the
 * index it is handed; it never mounts its own subscription (that used to be two
 * subscriptions holding state that could disagree — see that hook's own comment).
 */
import type { AttentionItem } from '@tm/shared/attention';

export interface AttentionIndex {
  /** Items per task id, newest last. Only tasks with at least one item appear. */
  byTask: ReadonlyMap<string, AttentionItem[]>;
  /** Every task id the inbox is holding something for — the ring's authoritative signal. */
  taskIds: ReadonlySet<string>;
  /** Total open items, for the nav rail's badge. */
  count: number;
  /**
   * The items parked on any of `ids`, in the order the ids were given, so a card's own
   * ask outranks a step's.
   */
  itemsFor: (ids: readonly (string | null | undefined)[]) => AttentionItem[];
}
