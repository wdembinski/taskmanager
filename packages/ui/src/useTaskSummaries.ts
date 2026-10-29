/**
 * One board's card summaries, loaded and kept current (F29.2) — what every list on screen
 * draws from: the board, the issue list, the sidebar tree, the timeline and the graph.
 *
 * It loads `board:tasks(scope)` once per scope and then never re-reads it on an event:
 * `tasks:changed` is merged in with `applyTaskDelta` and `task:changed` with
 * `patchTaskSummary` (`taskSummaryStore.ts`, the pure half, tested there). Each surface
 * still holds its own copy — there is no shared store — but they all take a change the
 * same way now.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { TaskDelta, TaskSummary } from '@tm/shared/taskSummary';
import { useTransport } from './transport';
import { useInitialLoad, type InitialLoad } from './useInitialLoad';
import { applyTaskDelta, patchTaskSummary, type TaskListScope } from './taskSummaryStore';

export interface UseTaskSummariesOptions {
  /**
   * Narrows which boards' deltas the list takes, on top of the scope rule — the All scope
   * takes every board's otherwise. Read through a ref, so an inline closure is fine.
   */
  accepts?: (projectId: string) => boolean;
  /** Called with every delta the list took — e.g. to re-read what a removal may have moved. */
  onDelta?: (delta: TaskDelta) => void;
  /**
   * Drop the list to `null` the moment the scope changes, rather than keeping the outgoing
   * board's cards on screen until the new board's load lands.
   */
  clearOnScopeChange?: boolean;
}

export interface TaskSummaries extends Pick<InitialLoad, 'error' | 'retry'> {
  /** The scope's cards, or `null` before the first load (and while `scope` is `null`). */
  tasks: TaskSummary[] | null;
  /** For a caller's optimistic edit, or an answer that already carries the list. */
  setTasks: Dispatch<SetStateAction<TaskSummary[] | null>>;
  /** Re-read `board:tasks(scope)` — for an action that pushes nothing of its own. */
  reload: () => Promise<void>;
}

/**
 * @param scope one board's project id, `'all'` for every board, or `null` to load nothing
 *   yet (a caller still reading which board to show).
 */
export function useTaskSummaries(
  scope: TaskListScope | null,
  options: UseTaskSummariesOptions = {},
): TaskSummaries {
  const transport = useTransport();
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // The scope the newest load was asked for — an older load landing late is dropped.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const reload = useCallback(async () => {
    if (scope === null) return;
    const next = await transport.invoke('board:tasks', scope);
    if (scopeRef.current === scope) setTasks(next);
  }, [transport, scope]);
  const initial = useInitialLoad(reload);

  const clearOnScopeChange = options.clearOnScopeChange ?? false;
  useEffect(() => {
    if (clearOnScopeChange) setTasks(null);
  }, [scope, clearOnScopeChange]);

  useEffect(() => {
    if (scope === null) return;
    const inScope = (projectId: string): boolean => {
      const accepts = optionsRef.current.accepts;
      if (accepts && !accepts(projectId)) return false;
      return scope === 'all' || scope === projectId;
    };
    const offDelta = transport.on('tasks:changed', (delta) => {
      if (!inScope(delta.projectId)) return;
      setTasks((prev) => (prev ? applyTaskDelta(prev, delta, scope) : prev));
      optionsRef.current.onDelta?.(delta);
    });
    const offTask = transport.on('task:changed', ({ task }) =>
      setTasks((prev) => (prev ? patchTaskSummary(prev, task) : prev)),
    );
    return () => {
      offDelta();
      offTask();
    };
  }, [transport, scope]);

  return { tasks, setTasks, reload, error: initial.error, retry: initial.retry };
}

/**
 * Every board's deltas, for a caller that holds no list of its own but must know when one
 * of its cards changed — the open card (`TaskDetailHost`), which re-reads `task:get` only
 * when a delta touches it. Read through a ref, so an inline handler is fine.
 */
export function useTaskDeltas(enabled: boolean, onDelta: (delta: TaskDelta) => void): void {
  const transport = useTransport();
  const onDeltaRef = useRef(onDelta);
  onDeltaRef.current = onDelta;
  useEffect(() => {
    if (!enabled) return;
    return transport.on('tasks:changed', (delta) => onDeltaRef.current(delta));
  }, [transport, enabled]);
}
