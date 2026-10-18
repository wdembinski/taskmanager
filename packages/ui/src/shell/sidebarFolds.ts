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
 * Whether `id` is folded, given a node that may default to folded or unfolded on its own
 * (a finished milestone, say). An explicit `id` entry overrides the default to folded, an
 * explicit `!id` entry overrides it to unfolded; with neither present, `defaultFolded` wins.
 */
export function isFolded(stored: ReadonlySet<string>, id: string, defaultFolded: boolean): boolean {
  if (stored.has(id)) return true;
  if (stored.has(`!${id}`)) return false;
  return defaultFolded;
}

/**
 * `stored` with `id`'s fold toggled, against a node whose own default may already be folded
 * or unfolded. Drops whatever `id`/`!id` entry was already there, then adds back only the one
 * that makes the new state differ from `defaultFolded` — so a toggle that lands back on the
 * default leaves no trace, and the stored list never grows past what overrides the default.
 */
export function toggleStoredFold(
  stored: readonly string[],
  id: string,
  defaultFolded: boolean,
): string[] {
  const wasFolded = isFolded(new Set(stored), id, defaultFolded);
  const next = stored.filter((entry) => entry !== id && entry !== `!${id}`);
  const nowFolded = !wasFolded;
  if (nowFolded !== defaultFolded) next.push(nowFolded ? id : `!${id}`);
  return next;
}

/**
 * This device's folded tree-node ids under `storageKey`, plus a toggle that flips one id's
 * state (against its own `defaultFolded`, default `false`) and persists the result. Reads
 * `localStorage` once, through {@link parseFolds}.
 */
export function useDeviceFolds(
  storageKey: string,
): [folds: string[], toggleFold: (id: string, defaultFolded?: boolean) => void] {
  const [folds, setFolds] = useState<string[]>(() => {
    try {
      return parseFolds(localStorage.getItem(storageKey));
    } catch {
      return [];
    }
  });

  function toggleFold(id: string, defaultFolded = false): void {
    setFolds((was) => {
      const next = toggleStoredFold(was, id, defaultFolded);
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
