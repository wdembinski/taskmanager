/**
 * Shared attention vocabulary (Phase 4).
 *
 * Two things pause a running task and need a human: a **permission request**
 * (Claude wants to do something our risk policy won't auto-approve — a git push,
 * a delete, anything touching secrets) and a **clarifying question** (Claude
 * genuinely needs information to proceed). Both surface in the **Attention inbox**
 * as an `AttentionItem`; answering one pushes the reply back into the SAME live
 * session (over its open input stream) so the task continues without a restart.
 *
 * These types cross the UI↔engine boundary — the engine raises items, the UI
 * lists and answers them — so they live in `shared`.
 */

/**
 * Why a task is parked: awaiting approval for a tool, an answer to a question, or —
 * for the team-orchestrator feature — a human to resolve a git **merge conflict**
 * that arose while integrating the task's branch back into the base.
 */
export type AttentionKind = 'permission' | 'question' | 'merge-conflict';

/** One thing waiting on a human, tied to the live run (and task) that raised it. */
export interface AttentionItem {
  /** Stable id for this item (so the UI can answer/resolve exactly one). */
  id: string;
  /** The live run awaiting input — the target of `session:answer`. */
  runId: string;
  /** The task this run is executing (attention is task-scoped in Phase 4). */
  taskId: string;
  /** The task's project, so the inbox can group/label without extra lookups. */
  projectId: string;
  /** The task title, shown as the item's heading. */
  taskTitle: string;
  kind: AttentionKind;
  /** Human-readable text: the question asked, or the tool use awaiting approval. */
  prompt: string;
  /**
   * For `question` items, the discrete choices Claude offered (empty = free-text
   * only). The inbox renders each as a one-click button; picking one sends that
   * text back as the reply. Always empty for `permission` items.
   */
  options: string[];
  /** For `permission` items, the tool Claude wanted to use (e.g. "Bash"). */
  toolName: string | null;
  /** For `permission` items, why the risk policy routed it to a human. */
  reason: string | null;
  /**
   * For `merge-conflict` items, the worktree the human resolves the conflict in
   * (absolute path). Null for other kinds. The conflicted files live here — the
   * user opens it, fixes the markers, and answers to finish integration.
   */
  worktreePath?: string | null;
  /** For `merge-conflict` items, the task's branch being integrated. Null otherwise. */
  branch?: string | null;
  /** Epoch ms when the item was raised (inbox sorts oldest-first). */
  createdAt: number;
}

/**
 * The human's response to an inbox item.
 *   - `permission` items expect `approve`/`deny` (the tool is truly blocked until
 *     then); an optional `note` becomes guidance to Claude (the deny reason, or
 *     an extra instruction on approve).
 *   - `question` items expect `reply` with the answer text.
 *   - `merge-conflict` items expect `approve` ("I resolved it — finish the merge",
 *     which continues the rebase and fast-forwards base) or `deny` ("abandon" —
 *     mark the task failed and keep the branch/worktree for later).
 */
export type AttentionAnswer =
  | { decision: 'approve'; note?: string }
  | { decision: 'deny'; note?: string }
  | { decision: 'reply'; text: string };
