/**
 * The web tab's own `FocusSignal` — `document.visibilitychange`, per the "visible tab" half
 * of docs/plan/README.md Phase 25's own wording ("The Client reports itself as the
 * foreground window (desktop) or **visible tab** (web)"). Deliberately tab visibility, not
 * `document.hasFocus()`: a background tab that is merely scrolled to (visible, unfocused —
 * two tabs of the app side by side) still counts, and the harder case — the browser itself
 * minimised or another app in front — is exactly what `visibilitychange` fires `hidden` for.
 */
import type { FocusSignal } from './BoardPoller';

export function createBrowserFocusSignal(doc: Document = document): FocusSignal {
  const listeners = new Set<(focused: boolean) => void>();

  const handler = (): void => {
    const focused = doc.visibilityState === 'visible';
    for (const cb of listeners) cb(focused);
  };
  doc.addEventListener('visibilitychange', handler);

  return {
    isFocused: () => doc.visibilityState === 'visible',
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
