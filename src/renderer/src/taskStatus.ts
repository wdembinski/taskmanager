/**
 * Shared mapping from a task's status to a Fluent Badge color and a human label,
 * used by the Projects list, the Board, and the My Tasks screen so a status looks
 * and reads the same everywhere.
 */
import { MANUAL_STATUSES, type ManualStatus, type TaskStatus } from '@shared/model';

export type BadgeColor =
  'brand' | 'danger' | 'important' | 'informative' | 'severe' | 'subtle' | 'success' | 'warning';

export const STATUS_COLOR: Record<TaskStatus, BadgeColor> = {
  pending: 'informative',
  'in-progress': 'brand',
  blocked: 'important',
  running: 'brand',
  'waiting-input': 'warning',
  'blocked-by-limit': 'severe',
  done: 'success',
  failed: 'danger',
  stopped: 'subtle',
  cancelled: 'subtle',
};

/** Human-friendly label for each status ("pending" reads as "To Do"). */
export const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: 'To Do',
  'in-progress': 'In Progress',
  blocked: 'Blocked',
  running: 'Running',
  'waiting-input': 'Waiting',
  'blocked-by-limit': 'Limit',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  cancelled: 'Cancelled',
};

/** The manual statuses paired with their labels, for status dropdowns/menus. */
export const MANUAL_STATUS_OPTIONS: ReadonlyArray<{ value: ManualStatus; label: string }> =
  MANUAL_STATUSES.map((value) => ({ value, label: STATUS_LABEL[value] }));
