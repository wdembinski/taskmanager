/**
 * `task:get`'s answer (`TaskBundle`, `packages/shared/src/taskSummary.ts`) built from a list
 * of full fixture rows: the card, its parent (for a step) and its own steps by `order`. Main
 * reads the same three from its store (F29.2); the ui-shots stubs answer from the fixture's
 * `board:tasks` instead, so an open card draws its plan and ticket text as it does in the app.
 */
export function taskBundle(tasks, id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;
  const parent = task.parentTaskId
    ? (tasks.find((t) => t.id === task.parentTaskId) ?? null)
    : null;
  const steps = tasks
    .filter((t) => t.parentTaskId === task.id)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return { task, parent, steps };
}

/** Every row's bundle keyed by id — a `{ byArgTable, fallback }` spec for `task:get`. */
export function taskGetSpec(tasks) {
  const byArgTable = {};
  for (const t of tasks) byArgTable[t.id] = taskBundle(tasks, t.id);
  return { byArgTable, fallback: null };
}
