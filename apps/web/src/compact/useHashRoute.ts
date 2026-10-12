/**
 * The compact shell's own router hook (F3.2), over `compactRoute.ts`'s pure grammar —
 * `location.hash` as the single source of truth, so the phone's hardware/gesture back button
 * works across all four tabs for free, the same way a normal web page's does.
 *
 * ## Design decisions fixed here (do not re-derive in later edits)
 *
 * - **`useSyncExternalStore` over the `hashchange` event** — the same pattern `viewport.ts`'s
 *   `useLayoutMode` already uses over `matchMedia`'s `change` event, for the same reason: the
 *   hash can change from outside this hook's own `navigate` (a manual edit, a restored tab,
 *   the back button itself), and `hashchange` is the one event that fires for all of them.
 * - **An unknown hash renders `DEFAULT_COMPACT_ROUTE` without rewriting history.** The
 *   snapshot is `parseCompactRoute(location.hash) ?? DEFAULT_COMPACT_ROUTE` — read, never
 *   written. Falling back to a default is purely a rendering choice; silently overwriting
 *   whatever odd hash a tab arrived with (a stale bookmark, a share link from a future
 *   version with a route this build doesn't know) would make the back button's next step
 *   land somewhere the user never asked to go.
 * - **`navigate` assigns `location.hash` directly** (`formatCompactRoute(route)`), which is
 *   what makes the back button work in the first place: a hash assignment pushes a new
 *   history entry, unlike `history.replaceState` or a plain bit of React state.
 * - **Returns `[route, navigate]`**, mirroring `useState`'s own tuple shape, since that is
 *   exactly how every caller (`CompactApp`) uses it — read the current route, call a function
 *   to move to a new one.
 */
import { useSyncExternalStore } from 'react';
import {
  DEFAULT_COMPACT_ROUTE,
  formatCompactRoute,
  parseCompactRoute,
  type CompactRoute,
} from '@tm/ui/layout/compactRoute';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function getSnapshot(): CompactRoute {
  return parseCompactRoute(window.location.hash) ?? DEFAULT_COMPACT_ROUTE;
}

export function useHashRoute(): [CompactRoute, (route: CompactRoute) => void] {
  const route = useSyncExternalStore(subscribe, getSnapshot);
  const navigate = (next: CompactRoute) => {
    window.location.hash = formatCompactRoute(next);
  };
  return [route, navigate];
}
