/**
 * The compare view's (F10.5) pure model: turns the `variants:summary` channel's rows
 * (F10.4, `VariantSummaryRow`) into exactly what one column shows, in the order columns are
 * drawn. No React, no IPC — `TaskDetail`'s compare pane just renders what this returns.
 */
import { isRunStatus } from '@tm/shared/board';
import type { TaskStatus } from '@tm/shared/model';
import { sortVariantRows, type VariantSummaryRow } from '@tm/shared/variants';
import { formatCost } from './activity/activityFeedModel';
import { STATUS_LABEL } from './taskStatus';

/** Settled statuses a variant row ends in — mirrors `variants.ts`'s own `SETTLED` set. */
const SETTLED_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'done',
  'failed',
  'stopped',
  'cancelled',
]);

/** One column of the compare view — everything it shows, derived from one summary row. */
export interface CompareColumn {
  id: string;
  /** `'Variant A'` … ; `'Variant ?'` when the row's label is null. */
  heading: string;
  status: TaskStatus;
  statusLabel: string;
  failed: boolean;
  /** `'$1.23'`, or `'—'` when `costUsd` is null — never a fake `$0.00`. */
  costText: string;
  /** `'3 files · +10 −2'`, or `'No changes'` when the row touched no files. */
  diffText: string;
  /** The row's own summary, or a status-based fallback when it never got one. */
  summary: string;
  /** Whether this row's diff can be picked as the winner right now. */
  pickable: boolean;
  /** Why `pickable` is false, or null when it is true. */
  pickHint: string | null;
}

function diffText(diffStat: VariantSummaryRow['diffStat']): string {
  if (diffStat.files === 0) return 'No changes';
  return `${diffStat.files} file${diffStat.files === 1 ? '' : 's'} · +${diffStat.added} −${diffStat.removed}`;
}

function fallbackSummary(status: TaskStatus): string {
  return SETTLED_STATUSES.has(status) ? 'Ended without a result' : 'No result yet';
}

/**
 * The compare view's columns, in display order (`sortVariantRows` — A, B, C, unlabelled
 * last; the channel's own row order is not trusted).
 */
export function compareColumns(summary: readonly VariantSummaryRow[]): CompareColumn[] {
  return sortVariantRows(summary).map((row) => {
    const pickable = row.diffStat.files > 0 && !isRunStatus(row.status);
    return {
      id: row.id,
      heading: row.label ? `Variant ${row.label}` : 'Variant ?',
      status: row.status,
      statusLabel: STATUS_LABEL[row.status],
      failed: row.status === 'failed',
      costText: formatCost(row.costUsd),
      diffText: diffText(row.diffStat),
      summary: row.summary || fallbackSummary(row.status),
      pickable,
      pickHint: pickable ? null : isRunStatus(row.status) ? 'Still running' : 'No changes to pick',
    };
  });
}
