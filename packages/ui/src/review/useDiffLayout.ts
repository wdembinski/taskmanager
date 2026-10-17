/**
 * The reviewer's own Unified/Split preference, remembered per device the same way
 * {@link import('../projects/deviceFold').useDeviceFold} remembers a fold: one key under
 * `DIFF_LAYOUT_STORAGE_KEY`, read once through {@link parseDiffLayout} and written on every
 * change — both sides wrapped in `try` so a browser that refuses storage (private mode, a
 * quota already full) just means the choice is not remembered, never a crash.
 */
import { useState } from 'react';
import { DIFF_LAYOUT_STORAGE_KEY, parseDiffLayout, type DiffLayout } from './reviewView';

export function useDiffLayout(): [preferred: DiffLayout, setPreferred: (next: DiffLayout) => void] {
  const [preferred, setPreferredState] = useState<DiffLayout>(() => {
    try {
      return parseDiffLayout(localStorage.getItem(DIFF_LAYOUT_STORAGE_KEY));
    } catch {
      return 'unified';
    }
  });

  function setPreferred(next: DiffLayout): void {
    setPreferredState(next);
    try {
      localStorage.setItem(DIFF_LAYOUT_STORAGE_KEY, next);
    } catch {
      // Storage unavailable — the choice just is not remembered next time.
    }
  }

  return [preferred, setPreferred];
}
