/**
 * The Inbox's open owner decisions, grouped under their projects (`InboxDecisions.tsx`).
 *
 * Pure, so `decisionsIndex.test.ts` covers the grouping and both orders without a transport:
 * groups sort by project name, and each group's decisions run oldest first — the question
 * that has held its card longest is the one at the top.
 *
 * A card's project is the one it is **about** (`projectTagId`), then the one it was delegated
 * to (`agentProjectId`), then its own board (`projectId`) — so a Personal card filed under
 * Billing lists under Billing, not under Personal.
 */
import type { Task } from '@tm/shared/model';

export interface DecisionRow {
  taskId: string;
  title: string;
  question: string;
  /** `Task.decisionAskedAt`; null for a decision raised before the column carried a time. */
  askedAt: number | null;
}

export interface DecisionGroup {
  projectId: string;
  projectName: string;
  decisions: DecisionRow[];
}

/** The project a card's decision lists under — see this file's own header. */
export function decisionProjectId(task: Task): string {
  return task.projectTagId ?? task.agentProjectId ?? task.projectId;
}

/** Oldest first; a decision with no time sorts after every timed one, then by title. */
function byAge(a: DecisionRow, b: DecisionRow): number {
  if (a.askedAt !== b.askedAt) {
    if (a.askedAt == null) return 1;
    if (b.askedAt == null) return -1;
    return a.askedAt - b.askedAt;
  }
  return a.title.localeCompare(b.title);
}

/**
 * Every card with an open decision (`decisionQuestion` non-null), grouped by project. An
 * archived card is left out: it is off the board, and nothing would ever start it anyway.
 */
export function groupDecisions(
  tasks: readonly Task[],
  projectName: (projectId: string) => string,
): DecisionGroup[] {
  const groups = new Map<string, DecisionGroup>();
  for (const task of tasks) {
    if (task.decisionQuestion == null || task.archivedAt != null) continue;
    const projectId = decisionProjectId(task);
    let group = groups.get(projectId);
    if (!group) {
      group = { projectId, projectName: projectName(projectId), decisions: [] };
      groups.set(projectId, group);
    }
    group.decisions.push({
      taskId: task.id,
      title: task.title,
      question: task.decisionQuestion,
      askedAt: task.decisionAskedAt ?? null,
    });
  }
  const sorted = [...groups.values()].sort(
    (a, b) => a.projectName.localeCompare(b.projectName) || a.projectId.localeCompare(b.projectId),
  );
  for (const group of sorted) group.decisions.sort(byAge);
  return sorted;
}
