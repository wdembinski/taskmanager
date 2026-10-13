/**
 * The three viewport breakpoints the web and desktop shells agree on, in one place.
 * `COMPACT_MAX_PX` and `MEDIUM_MAX_PX` are derived from the next tier's min, rather
 * than written as their own literals, so a boundary can never drift out of step with
 * itself — there is exactly one number per edge, not two that happen to agree today.
 */
import { useSyncExternalStore } from 'react';

export const MEDIUM_MIN_PX = 640;
export const WIDE_MIN_PX = 1024;
export const COMPACT_MAX_PX = MEDIUM_MIN_PX - 1;
export const MEDIUM_MAX_PX = WIDE_MIN_PX - 1;

export type LayoutMode = 'compact' | 'medium' | 'wide';

export function layoutMode(widthPx: number): LayoutMode {
  if (widthPx < MEDIUM_MIN_PX) return 'compact';
  if (widthPx < WIDE_MIN_PX) return 'medium';
  return 'wide';
}

export const COMPACT_QUERY = `(max-width: ${COMPACT_MAX_PX}px)`;
export const MEDIUM_QUERY = `(min-width: ${MEDIUM_MIN_PX}px) and (max-width: ${MEDIUM_MAX_PX}px)`;
export const WIDE_QUERY = `(min-width: ${WIDE_MIN_PX}px)`;

/** Griffel `makeStyles` keys — `@media ${query}`, ready to use as a style rule's key. */
export const MEDIA = {
  compact: `@media ${COMPACT_QUERY}`,
  medium: `@media ${MEDIUM_QUERY}`,
  wide: `@media ${WIDE_QUERY}`,
} as const;

function subscribe(onChange: () => void): () => void {
  const compact = window.matchMedia(COMPACT_QUERY);
  const wide = window.matchMedia(WIDE_QUERY);
  compact.addEventListener('change', onChange);
  wide.addEventListener('change', onChange);
  return () => {
    compact.removeEventListener('change', onChange);
    wide.removeEventListener('change', onChange);
  };
}

function getSnapshot(): LayoutMode {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'wide';
  if (window.matchMedia(COMPACT_QUERY).matches) return 'compact';
  if (window.matchMedia(WIDE_QUERY).matches) return 'wide';
  return 'medium';
}

function getServerSnapshot(): LayoutMode {
  return 'wide';
}

/** The current {@link LayoutMode}, live-updating as the viewport crosses a breakpoint. */
export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * The on-screen keyboard's own height in px, 0 while it is closed (F3.7) — `CompactShell`'s
 * bottom padding, so a full-screen card's composer is never the part of the screen the
 * keyboard covers. `apps/web/index.html`'s `interactive-widget=resizes-content` is what
 * makes `window.visualViewport` shrink by the keyboard's height at all rather than leaving
 * `100dvh` to silently cover it; this is the arithmetic over that shrink, not the trigger
 * for it.
 *
 * `layoutHeightPx - visualHeightPx - offsetTopPx`, floored at 0 — never negative, since a
 * closed keyboard's rounding can land either side of zero and a negative inset would pad
 * the wrong way. `scale` guards the other false positive: a pinch-zoom shrinks
 * `visualViewport.height` exactly the way an open keyboard does, with nothing else to tell
 * the two apart, so any zoom away from 1 reads as "no keyboard" here rather than guessing.
 */
export function keyboardInset(
  layoutHeightPx: number,
  visualHeightPx: number,
  offsetTopPx: number,
  scale: number,
): number {
  if (scale !== 1) return 0;
  return Math.max(0, layoutHeightPx - visualHeightPx - offsetTopPx);
}

function subscribeViewportInset(onChange: () => void): () => void {
  const vv = typeof window === 'undefined' ? undefined : window.visualViewport;
  if (!vv) return () => {};
  vv.addEventListener('resize', onChange);
  vv.addEventListener('scroll', onChange);
  return () => {
    vv.removeEventListener('resize', onChange);
    vv.removeEventListener('scroll', onChange);
  };
}

function getViewportInsetSnapshot(): number {
  if (typeof window === 'undefined') return 0;
  const vv = window.visualViewport;
  if (!vv) return 0;
  return keyboardInset(window.innerHeight, vv.height, vv.offsetTop, vv.scale);
}

function getViewportInsetServerSnapshot(): number {
  return 0;
}

/** The current {@link keyboardInset}, live-updating as the keyboard opens/closes or the page
 *  is pinch-zoomed. 0 in an environment with no `visualViewport` (older browsers, SSR). */
export function useKeyboardInset(): number {
  return useSyncExternalStore(
    subscribeViewportInset,
    getViewportInsetSnapshot,
    getViewportInsetServerSnapshot,
  );
}
