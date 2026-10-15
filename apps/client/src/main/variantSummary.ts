/**
 * Assembles `variants:summary` (F10.4): one row per live variant of a leader, for the
 * compare view — status, total cost, diff stat and a one-line gist of its last result.
 *
 * Kept off `ipc.ts` so it is testable: ipc handlers run inside `registerIpcHandlers` and are
 * unreachable from a unit test (memory *headless-scenario-harness-traps*). `ipc.ts` wires
 * `VariantSummaryDeps` to the real `store`/`DiffService`; a test wires fakes instead.
 */
import type { Task } from '@shared/model';
import type { SessionEvent } from '@shared/session';
import {
  sortVariantRows,
  variantCost,
  variantSummaryLine,
  type VariantDiffStat,
  type VariantSummaryRow,
} from '@shared/variants';

export interface VariantSummaryDeps {
  getTask(id: string): Task | undefined;
  /** Every live variant row of one leader — `store.listVariantRows(leaderId)`. */
  listVariantRows(leaderId: string): Task[];
  getTaskHistory(taskId: string): SessionEvent[];
  /** `DiffService.stat` — a row's diff against base, `{0,0,0}` for anything not an ordinary diff. */
  diffStat(taskId: string): Promise<VariantDiffStat>;
}

/**
 * The leader's rows, each summarized for the compare view, sorted A, B, C (unlabelled
 * last). Throws `'Task not found.'` for an unknown leader; `[]` for a leader with no live
 * rows — a card nobody has started variants on yet, not an error.
 */
export async function buildVariantSummary(
  deps: VariantSummaryDeps,
  leaderId: string,
): Promise<VariantSummaryRow[]> {
  const leader = deps.getTask(leaderId);
  if (!leader) throw new Error('Task not found.');
  const rows = deps.listVariantRows(leaderId);
  if (rows.length === 0) return [];

  const summaries = await Promise.all(
    rows.map(async (row): Promise<VariantSummaryRow> => {
      const history = deps.getTaskHistory(row.id);
      const lastResult = history.filter((e) => e.kind === 'result').at(-1);
      return {
        id: row.id,
        label: row.variantLabel ?? null,
        status: row.status,
        costUsd: variantCost(history),
        diffStat: await deps.diffStat(row.id),
        summary:
          lastResult && lastResult.kind === 'result'
            ? variantSummaryLine(lastResult.resultText)
            : '',
      };
    }),
  );
  return sortVariantRows(summaries);
}
