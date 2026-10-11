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
