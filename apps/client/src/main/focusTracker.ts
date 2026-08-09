/**
 * Whether THIS window counts as "the user is looking at this app right now" — the one
 * signal `cloudPoller.ts` needs that nothing in the app has ever tracked before. JIRA and
 * GitLab don't care whether anyone is looking; the cloud mirror's whole cadence policy
 * does (`@tm/protocol/cadence`'s `CadenceTier`), so this is greenfield.
 *
 * Two inputs, folded into one boolean:
 *
 *  - `BrowserWindow`'s `focus`/`blur` — the same window this app already tracks
 *    `maximize`/`unmaximize` on (`ipc.ts`), just two more events on it.
 *  - `powerMonitor`'s `suspend`/`resume` and `lock-screen`/`unlock-screen` — a window can
 *    stay `isFocused() === true` right up to (and immediately after) the machine sleeping
 *    or the session locking, and polling a server every 2.5s from behind a lock screen
 *    would be reporting presence nobody is providing.
 *
 * `resume` doesn't assume focus is back — it re-reads `window.isFocused()`, since the
 * window that comes back is not necessarily the one on top.
 */
import { powerMonitor, type BrowserWindow } from 'electron';

export class FocusTracker {
  private focused: boolean;
  private suspended = false;
  private lastEmitted: boolean;
  private readonly listeners = new Set<(focused: boolean) => void>();

  constructor(private readonly window: BrowserWindow) {
    this.focused = window.isFocused();
    this.lastEmitted = this.effective();
    window.on('focus', this.handleFocus);
    window.on('blur', this.handleBlur);
    powerMonitor.on('suspend', this.handleSuspend);
    powerMonitor.on('lock-screen', this.handleSuspend);
    powerMonitor.on('resume', this.handleResume);
    powerMonitor.on('unlock-screen', this.handleResume);
  }

  /** Focused window AND an unlocked, awake machine. */
  isFocused(): boolean {
    return this.effective();
  }

  /** Fires only when the effective (window ∧ awake) state actually flips. Returns an
   * unsubscribe function. */
  onChange(cb: (focused: boolean) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  dispose(): void {
    this.window.off('focus', this.handleFocus);
    this.window.off('blur', this.handleBlur);
    powerMonitor.off('suspend', this.handleSuspend);
    powerMonitor.off('lock-screen', this.handleSuspend);
    powerMonitor.off('resume', this.handleResume);
    powerMonitor.off('unlock-screen', this.handleResume);
    this.listeners.clear();
  }

  private effective(): boolean {
    return this.focused && !this.suspended && !this.window.isDestroyed();
  }

  private emit(): void {
    const next = this.effective();
    if (next === this.lastEmitted) return;
    this.lastEmitted = next;
    for (const cb of this.listeners) cb(next);
  }

  private readonly handleFocus = (): void => {
    this.focused = true;
    this.emit();
  };

  private readonly handleBlur = (): void => {
    this.focused = false;
    this.emit();
  };

  private readonly handleSuspend = (): void => {
    this.suspended = true;
    this.emit();
  };

  private readonly handleResume = (): void => {
    this.suspended = false;
    // The window that resumes is not necessarily the one on top — re-read rather than
    // assume the pre-suspend focus state still holds.
    if (!this.window.isDestroyed()) this.focused = this.window.isFocused();
    this.emit();
  };
}
