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
 * - **`navigate(route, { replace })` goes through `history.pushState`/`replaceState`, never
 *   a plain `location.hash` assignment** (F3.7) — every entry it writes is stamped with
 *   `IN_APP_HISTORY_MARK` in `history.state`, which is what lets `cardBackAction`
 *   (`compactRoute.ts`) later tell an in-app navigation from a route the tab merely loaded
 *   on. `replace` is for the cases that must not grow history by one more than they already
 *   would: a section-tab change on the SAME open card, and `goBackFromCard`'s own fallback
 *   when there is no real entry to go back to. Neither `pushState` nor `replaceState` fires
 *   `hashchange` on its own — only back/forward traversal and a plain hash assignment do —
 *   so `navigate` dispatches one itself, which is what makes `useSyncExternalStore` notice
 *   its own call rather than only ever reacting to outside changes.
 * - **`goBackFromCard(fallback)` is `cardBackAction` carried out**: `{kind:'history'}` calls
 *   `history.back()` (a real entry exists — the hardware/gesture back button would have
 *   landed there anyway); `{kind:'replace'}` calls `navigate` with `{replace: true}` on the
 *   action's own route, never `fallback` directly — the two happen to be the same route
 *   today, but going through the action keeps this file ignorant of what `cardBackAction`
 *   actually decided.
 * - **Returns `[route, navigate, goBackFromCard]`**, extending `useState`'s own tuple shape
 *   rather than switching to an object — every existing caller destructures positionally
 *   (`const [route, navigate] = useHashRoute()`), and an object would have made that an
 *   unrelated rename instead of an additive change.
 */
import { useSyncExternalStore } from 'react';
import {
  cardBackAction,
  DEFAULT_COMPACT_ROUTE,
  formatCompactRoute,
  IN_APP_HISTORY_MARK,
  parseCompactRoute,
  type CompactRoute,
} from '@tm/ui/layout/compactRoute';

/** `navigate`'s own options — see the module header. */
export interface NavigateOptions {
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function getSnapshot(): CompactRoute {
  return parseCompactRoute(window.location.hash) ?? DEFAULT_COMPACT_ROUTE;
}

export function useHashRoute(): [
  CompactRoute,
  (route: CompactRoute, options?: NavigateOptions) => void,
  (fallback: CompactRoute) => void,
] {
  const route = useSyncExternalStore(subscribe, getSnapshot);

  const navigate = (next: CompactRoute, options?: NavigateOptions): void => {
    const url = `${window.location.pathname}${window.location.search}${formatCompactRoute(next)}`;
    const state = { [IN_APP_HISTORY_MARK]: true };
    if (options?.replace) {
      window.history.replaceState(state, '', url);
    } else {
      window.history.pushState(state, '', url);
    }
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };

  const goBackFromCard = (fallback: CompactRoute): void => {
    const action = cardBackAction(window.history.state, fallback);
    if (action.kind === 'history') {
      window.history.back();
    } else {
      navigate(action.route, { replace: true });
    }
  };

  return [route, navigate, goBackFromCard];
}
