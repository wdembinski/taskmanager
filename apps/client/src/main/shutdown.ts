/**
 * shutdown — running every teardown step, even when one of them throws.
 *
 * The `before-quit` handler is a list of disposers ending in `store.close()`, and that
 * last one is the reason the handler exists: closing the SQLite handle is what
 * checkpoints the WAL. Written as a straight line, ANY earlier disposer that throws
 * skips the rest — the sessions stay unkilled, and the database is left with an
 * un-checkpointed WAL beside it. The one place that hurts most is an auto-update
 * restart, where the installer replaces the app while its database sits half-written.
 *
 * So teardown is a LIST, not a sequence of statements: every step runs, in order, each
 * inside its own try/catch, and a failure is reported to the caller rather than thrown.
 * Order still matters — the caller supplies it — but a step no longer gets to veto the
 * steps behind it.
 *
 * Deliberately Electron-free and engine-free (plain named callbacks) so it can be
 * unit-tested, in the style of `windowFlush.ts`; `index.ts` supplies the real disposers.
 */

export interface ShutdownStep {
  /** Identifies the step in the log when it fails. */
  name: string;
  run: () => void;
}

/**
 * Run every step in order. Never throws: a step that fails is passed to `onError` and
 * the remaining steps run anyway.
 */
export function runShutdownSteps(
  steps: readonly ShutdownStep[],
  onError: (name: string, err: unknown) => void,
): void {
  for (const step of steps) {
    try {
      step.run();
    } catch (err) {
      // `onError` is our own logger, but a reporter that throws must not become the
      // very failure this function exists to contain.
      try {
        onError(step.name, err);
      } catch {
        /* nothing left to report it to */
      }
    }
  }
}
