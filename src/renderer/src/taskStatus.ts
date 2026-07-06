/**
 * Shared mapping from a task's status to a Fluent Badge color, used by both the
 * Projects list and the Board so a `running` task looks the same everywhere.
 */
import type { TaskStatus } from '@shared/model';

export type BadgeColor =
  'brand' | 'danger' | 'important' | 'informative' | 'severe' | 'subtle' | 'success' | 'warning';

export const STATUS_COLOR: Record<TaskStatus, BadgeColor> = {
  pending: 'informative',
  running: 'brand',
  'waiting-input': 'warning',
  'blocked-by-limit': 'severe',
  done: 'success',
  failed: 'danger',
  stopped: 'subtle',
};
