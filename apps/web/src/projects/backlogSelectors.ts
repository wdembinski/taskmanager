/**
 * Pure filtering/grouping for the backlog and epics views (this step) — the JIRA-style
 * screens beside a project's Kanban board (`ProjectBoardRoute`). Kept apart from the
 * board's own selectors (`../board/boardSelectors.ts`) because these read fields the
 * Kanban board never filters on (labels, epic, issue type) and must not change what the
 * board itself shows.
 *
 * A **step** — a task with `parentTaskId` set — is excluded here the same way
 * `groupSubtasks` excludes it from the board's own cards: it travels with its parent card
 * rather than standing as a backlog row of its own. `epicTaskId` grouping is unrelated to
 * `parentTaskId` on purpose (see `Task.epicTaskId`'s own doc), so a ticket's epic survives
 * this filter untouched.
 */
import type { Task } from '@tm/shared/model';
import { isEpic } from '@tm/shared/tickets';
import { selectBoardTasks, type BoardTaskState } from '../board/boardSelectors';

/** The epic filter's "no epic assigned" option — no task id can ever equal this. */
export const NO_EPIC = '__no-epic__';

export interface BacklogFilters {
  /** Empty set = every status. */
  statuses: ReadonlySet<string>;
  /** null = every label. */
  label: string | null;
  /** null = every epic; {@link NO_EPIC} = tickets with none. */
  epicId: string | null;
}

export const EMPTY_BACKLOG_FILTERS: BacklogFilters = {
  statuses: new Set(),
  label: null,
  epicId: null,
};

/** The rows a project's backlog draws: its own top-level tickets, not the steps that
 *  travel with an agent card. See the module doc for why `parentTaskId` is the test. */
export function selectBacklogTasks(state: BoardTaskState, projectId: string): Task[] {
  return selectBoardTasks(state, projectId).filter((task) => !task.parentTaskId);
}

/** Whether a task passes every active filter — unset filters always pass. */
export function matchesBacklogFilters(task: Task, filters: BacklogFilters): boolean {
  if (filters.statuses.size > 0 && !filters.statuses.has(task.status)) return false;
  if (filters.label !== null && !(task.labels ?? []).includes(filters.label)) return false;
  if (filters.epicId === NO_EPIC) {
    if (task.epicTaskId) return false;
  } else if (filters.epicId !== null && task.epicTaskId !== filters.epicId) {
    return false;
  }
  return true;
}

export function filterBacklogTasks(tasks: readonly Task[], filters: BacklogFilters): Task[] {
  return tasks.filter((task) => matchesBacklogFilters(task, filters));
}

/** Every label in use across these tasks, alphabetical — the label filter's own options. */
export function backlogLabels(tasks: readonly Task[]): string[] {
  const seen = new Set<string>();
  for (const task of tasks) for (const label of task.labels ?? []) seen.add(label);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** This set's epics, in board order — the epic filter's own options, and the Epics view's
 *  own groups. */
export function backlogEpics(tasks: readonly Task[]): Task[] {
  return tasks.filter(isEpic);
}

/** The tickets hanging under one epic. An epic never nests under another, so `isEpic` is
 *  excluded even if a row's `epicTaskId` somehow pointed at one. */
export function epicChildren(tasks: readonly Task[], epicId: string): Task[] {
  return tasks.filter((task) => task.epicTaskId === epicId && !isEpic(task));
}

/** How many of an epic's children are `done` — the epic row's own progress count. */
export function epicProgress(children: readonly Task[]): { done: number; total: number } {
  return { done: children.filter((task) => task.status === 'done').length, total: children.length };
}
