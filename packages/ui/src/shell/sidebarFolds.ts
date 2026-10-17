/**
 * The sidebar tree's fold state, remembered per DEVICE (`localStorage`) rather than per
 * card — the whole tree's folded node ids under one key, same shape `sidebarModel.ts`'s own
 * `SidebarInput.folds` takes. Modelled on `projects/deviceFold.ts`'s single-flag codec: a pure
 * parse/serialise pair kept testable without a DOM, plus a hook that reads once and writes on
 * every toggle, wrapped in `try` so a browser that refuses storage (private mode, a full quota)
 * just means folds are not remembered — never a crash.
 */
import { useState } from 'react';

/** `raw`'s folded ids — `[]` for anything that is not a JSON array of strings, including a
 *  never-written key, invalid JSON, or an array holding something other than a string. */
export function parseFolds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

/** The inverse of {@link parseFolds} — plain JSON, so the two round-trip through
 *  `localStorage` without the codec needing to agree on anything fancier than that. */
export function serializeFolds(folds: readonly string[]): string {
  return JSON.stringify(folds);
}

/**
 * This device's folded tree-node ids under `storageKey`, plus a toggle that flips one id's
 * membership and persists the result. Reads `localStorage` once, through {@link parseFolds}.
 */
export function useDeviceFolds(
  storageKey: string,
): [folds: string[], toggleFold: (id: string) => void] {
  const [folds, setFolds] = useState<string[]>(() => {
    try {
      return parseFolds(localStorage.getItem(storageKey));
    } catch {
      return [];
    }
  });

  function toggleFold(id: string): void {
    setFolds((was) => {
      const next = was.includes(id) ? was.filter((existing) => existing !== id) : [...was, id];
      try {
        localStorage.setItem(storageKey, serializeFolds(next));
      } catch {
        // Storage unavailable — the fold just is not remembered next time.
      }
      return next;
    });
  }

  return [folds, toggleFold];
}
