/**
 * A card's colour stripe — the one thing both `MyTasks` (desktop) and `BoardScreen` (web)
 * must draw identically, so this is the one place either computes it.
 *
 * The filed project's colour wins first (`task.projectTagId`, over the FILING list —
 * `isFilingProject`'s wider set, not the repo-only `agentProjectsOf` one: a project with no
 * repo of its own can still be filed under, and its colour must resolve too). Failing that,
 * on the All scope only, the card's own board project lends its colour — a card added
 * straight onto a project's board carries no tag at all, and its board is the only project
 * it names. The Personal board never lends a colour; a single-board scope already says which
 * project every card is on, so no card there draws a stripe.
 */
import type { BoardScope } from './ipc';
import { PERSONAL_PROJECT_ID, type Project, type Task } from './model';

export interface BoardColorSource {
  /** `'all'`, or one board's own project id — mirrors the scope picker. */
  scope: string;
  boardsById: ReadonlyMap<string, Pick<BoardScope, 'id' | 'color'>>;
}

export function cardProjectColor(
  task: Pick<Task, 'projectId' | 'projectTagId'>,
  filingProjects: readonly Pick<Project, 'id' | 'color'>[],
  boards: BoardColorSource,
): string | undefined {
  const tagColor = filingProjects.find((p) => p.id === task.projectTagId)?.color;
  if (tagColor) return tagColor;
  if (boards.scope !== 'all') return undefined;
  const board = boards.boardsById.get(task.projectId);
  return board && board.id !== PERSONAL_PROJECT_ID ? board.color || undefined : undefined;
}
