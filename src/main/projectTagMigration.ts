/**
 * Splitting `agentProjectId` into "what this card is about" and "where it runs".
 *
 * Those two meanings shared one column, so filing a card under a project — a purely
 * organisational act — marked it as delegated to an agent: the card grew the agent
 * glyph, the pane offered to *reassign* something nobody had assigned, and
 * `resolveAgentProject` treated the filing as an explicit human assignment that
 * outranked epic matching.
 *
 * The back-fill has to guess which of the two every existing value meant, and the only
 * honest evidence is whether a run ever actually happened on that card. So: everything
 * becomes a project TAG (that reading is always true — you cannot delegate a card
 * without also saying what it is about), and the delegation is kept only where the card
 * carries a trace of a real run.
 *
 * **It must run exactly once.** A second pass would re-evaluate a card the user
 * delegated *after* the first pass and, finding no run on it yet, quietly clear the
 * assignment. The caller guards it with an `app_state` key; the predicate itself is
 * pure so it can be tested, which the store cannot be.
 */
import type { Task } from '@shared/model';

/**
 * Whether a card shows evidence that it was really delegated, as opposed to merely
 * filed under a project.
 *
 * Each signal is something only a delegated run produces:
 *  - `sessionId`   — a Claude session was started for it.
 *  - `agentMode` / `agentModel` — the assign dialog wrote a per-card override.
 *  - `agentPlan`  — a plan-mode run got as far as proposing a plan.
 *
 * A card that was only filed has none of them.
 */
export function wasDelegated(task: Task): boolean {
  return Boolean(task.sessionId || task.agentMode || task.agentModel || task.agentPlan);
}

/** What one task's split should become. */
export interface ProjectTagSplit {
  projectTagId: string | null;
  agentProjectId: string | null;
}

/**
 * The new values for a task whose `agentProjectId` predates the split.
 *
 * The filing is always kept: whatever the value meant, the card IS about that project.
 * The delegation survives only with evidence.
 */
export function splitProjectTag(task: Task): ProjectTagSplit {
  const existing = task.agentProjectId ?? null;
  if (!existing) return { projectTagId: task.projectTagId ?? null, agentProjectId: null };
  return {
    // Never overwrite a tag that already exists — a second source of truth would be a
    // worse bug than the one this fixes.
    projectTagId: task.projectTagId ?? existing,
    agentProjectId: wasDelegated(task) ? existing : null,
  };
}
