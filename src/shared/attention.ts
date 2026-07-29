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
 * that arose while integrating the task's branch back into the base, to decide
 * how to handle a **failed task** (after auto-retries were exhausted): retry, retry
 * fresh, AI-assisted fix, clean up, or mark done, or to break a tie on a
 * **proposal** — one agent wanted to change the shared CONTRACT.md and its
 * in-flight teammates did not unanimously agree, so the human picks accept-vs-keep.
 * The `options` list carries the available actions and the human picks one (a
 * `reply` answer with that text).
 *
 * **plan-approval** (Phase 11) — a card delegated in `plan` mode finished researching
 * and called `ExitPlanMode`. The tool is held (the agent cannot slide from planning
 * into implementing) while the human reads the plan: approving turns each of its steps
 * into a subtask and runs them one session at a time; rejecting hands a note back so
 * the same session re-plans.
 *
 * **agent-question** (Phase 17) — the CLI's own `AskUserQuestion` tool, held before it
 * runs. Distinct from `question` (which is a sentinel the agent writes into its prose):
 * this one arrives as a structured tool call carrying real options with descriptions, and
 * it MUST be held, because a headless CLI with no terminal answers its own question by
 * picking its recommended option. That silent self-answer is the reason this kind exists.
 */
export type AttentionKind =
  | 'permission'
  | 'question'
  | 'merge-conflict'
  | 'task-failed'
  | 'proposal'
  | 'plan-approval'
  | 'agent-question';

/** One choice the agent offered, in the CLI's own `input.questions[].options[]` shape. */
export interface AttentionOption {
  label: string;
  /**
   * Why the agent offered it, and what happens if you pick it. Carried because it is the
   * whole reason a structured question beats free text — and it is what makes an option
   * legible without reading the transcript.
   */
  description?: string;
}

/** One question from an `AskUserQuestion` call. */
export interface AttentionQuestion {
  /** The CLI's short chip label ("Auth method"). May be empty. */
  header: string;
  /** The question itself, as markdown — agents write backticked identifiers in these. */
  question: string;
  /** Whether more than one option may be chosen. */
  multiSelect: boolean;
  options: AttentionOption[];
}

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
  /**
   * For `plan-approval` items, the plan markdown the agent produced — rendered for
   * the human to read before approving. Null for other kinds.
   */
  plan?: string | null;
  /**
   * For `plan-approval` items, the titles of the subtasks approving would create (in
   * order), so the human sees the breakdown they are signing off on rather than
   * having to derive it from the prose. Empty for other kinds.
   */
  steps?: string[];
  /**
   * For `agent-question` items, the structured questions the agent asked, with their real
   * options and descriptions.
   *
   * Deliberately separate from the flat `options: string[]` above rather than folded into
   * it: that field is one list of one question's choices, and squeezing a multi-question,
   * multi-select call with per-option descriptions through it would throw away exactly the
   * information that makes the form readable. Empty for every other kind, so the sentinel
   * `question` path is untouched.
   */
  questions?: AttentionQuestion[];
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
 *   - `task-failed` and `proposal` items expect `reply` with the chosen action
 *     text (one of the item's `options`), plus an optional free-text `note`.
 *   - `plan-approval` items expect `approve` ("run this plan" — the steps become
 *     subtasks and the first one starts; an optional `note` is filed on the card) or
 *     `deny` ("re-plan", with the note handed back to the planning agent as the
 *     reason). Approving never lets the planning session implement the plan itself.
 *   - `agent-question` items expect `answers`, one entry per question. A `deny` there
 *     means "I'm not choosing — use your judgement", which is the ONLY way the agent
 *     ever gets to decide: it must be an explicit act, never a timeout.
 */
export type AttentionAnswer =
  | { decision: 'approve'; note?: string }
  | { decision: 'deny'; note?: string }
  // `text` is the reply (a question answer, or a chosen `task-failed` action). `note`
  // is optional extra guidance (e.g. instructions for an "AI fix & retry").
  | { decision: 'reply'; text: string; note?: string }
  /**
   * An `agent-question` answer. Positional against the item's `questions`:
   * `selections[i]` are the chosen labels for question `i` (one entry unless it is
   * `multiSelect`), and `freeText[i]` is what the human typed instead of picking.
   */
  | {
      decision: 'answers';
      selections: string[][];
      freeText?: (string | null)[];
      note?: string;
    };
