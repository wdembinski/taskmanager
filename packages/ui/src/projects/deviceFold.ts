/**
 * The codec for a section's fold state as it round-trips through per-device storage
 * (`localStorage`), which only ever holds strings. Kept pure so the "what counts as true"
 * rule is testable without a DOM.
 */
import { useState } from 'react';

/** `'1'`/`'0'` as booleans; anything else — including a never-written key — is `fallback`. */
export function parseFold(raw: string | null | undefined, fallback: boolean): boolean {
  if (raw === '1') return true;
  if (raw === '0') return false;
  return fallback;
}

/**
 * A section's fold state, remembered per DEVICE rather than per card — one flag under
 * `storageKey`, not one row per task. Reads `localStorage` once, through {@link parseFold},
 * and writes on every toggle; both sides are wrapped in `try` so a browser that refuses
 * storage (private mode, a quota already full) just means the fold is not remembered —
 * never a crash.
 */
export function useDeviceFold(
  storageKey: string,
  defaultOpen: boolean,
): [open: boolean, toggle: () => void] {
  const [open, setOpen] = useState(() => {
    try {
      return parseFold(localStorage.getItem(storageKey), defaultOpen);
    } catch {
      return defaultOpen;
    }
  });

  function toggle(): void {
    setOpen((was) => {
      const next = !was;
      try {
        localStorage.setItem(storageKey, next ? '1' : '0');
      } catch {
        // Storage unavailable — the fold just is not remembered next time.
      }
      return next;
    });
  }

  return [open, toggle];
}
