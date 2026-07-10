/**
 * Shared app settings (Phase 6).
 *
 * A small bag of global preferences the user can edit on the Settings screen and
 * that the engine reads at runtime: the defaults applied to newly added projects,
 * plus two scheduler knobs (how many tasks run at once, and how much random jitter
 * to add before resuming after a usage limit resets). Persisted as one JSON blob
 * in the store's `app_state` table; it crosses the UI↔engine boundary, so it lives
 * in `shared`.
 */
import type { ClaudeModel, PermissionMode } from './session';

export interface AppSettings {
  /** Model applied to a newly added project (its tasks run with this unless changed). */
  defaultModel: ClaudeModel;
  /** Permission mode applied to a newly added project. */
  defaultPermissionMode: PermissionMode;
  /** Max tasks a single project runs at once (scheduler concurrency; 1 = sequential). */
  concurrency: number;
  /**
   * Upper bound on the random jitter (ms) added to a usage limit's reset time
   * before resuming, so many parked apps don't all retry the same instant (Phase 5).
   */
  limitJitterMs: number;
  /** Whether newly added projects tick completed checkboxes back into their plan file. */
  writeBackPlan: boolean;
  /**
   * How many times the scheduler auto-retries a task whose agent run failed before
   * parking it for the human to resolve (team orchestrator). 0 = never auto-retry
   * (park on the first failure). Integration/merge failures are never auto-retried —
   * they always park, since the fix is human-side (commit/stash the base, etc.).
   */
  maxAutoRetries: number;
}

/** The out-of-the-box settings, also used to fill any field missing from storage. */
export const DEFAULT_SETTINGS: AppSettings = {
  defaultModel: 'sonnet',
  defaultPermissionMode: 'acceptEdits',
  concurrency: 1,
  limitJitterMs: 60_000,
  writeBackPlan: false,
  maxAutoRetries: 1,
};
