/**
 * Whether the Issues screen's hand-off panel (F5.8) offers its agent pickers and "Hand to
 * agent" button for one issue, or something else instead — kept as a pure function so the one
 * rule that matters is a plain thing to test rather than a render branch to eyeball.
 *
 * Deliberately narrow: it answers for the AGENT half of the panel only. "Add to board" needs
 * no agent project at all (it is a plain import), so `IssuesScreen.tsx` offers that button
 * regardless of what this says — only the project/model/mode pickers and "Hand to agent" are
 * gated here.
 */
import { agentProjectsOf } from '@tm/shared/agentProjects';
import type { IssueSummary } from '@tm/shared/issues';
import type { Project } from '@tm/shared/model';
import { NO_AGENT_PROJECTS_MESSAGE } from '../agentPickers';

export type HandOffAvailability =
  /** Already on the board — the panel shows "On board" and an Open button instead. */
  | { kind: 'on-board'; taskId: string }
  /** No agent project exists anywhere — the same explanation `AssignAgentDialog` shows, since
   *  the fix (add one in the desktop app) is identical regardless of which screen asked. */
  | { kind: 'no-agent-projects'; message: string }
  /** The pickers and "Hand to agent" are live. */
  | { kind: 'available' };

export function handOffAvailability(
  issue: Pick<IssueSummary, 'onBoardTaskId'>,
  projects: readonly Project[],
): HandOffAvailability {
  if (issue.onBoardTaskId !== null) return { kind: 'on-board', taskId: issue.onBoardTaskId };
  if (agentProjectsOf([...projects]).length === 0) {
    return { kind: 'no-agent-projects', message: NO_AGENT_PROJECTS_MESSAGE };
  }
  return { kind: 'available' };
}
