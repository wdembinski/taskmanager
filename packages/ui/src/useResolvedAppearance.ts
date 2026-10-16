/**
 * Mounts the resolved scheme and glass mode onto `document.documentElement` and keeps them
 * current — the one hook both hosts' `main.tsx` calls so the document never disagrees with
 * the theme a `FluentProvider` is mounting beside it.
 */
import { useEffect, useLayoutEffect, useState } from 'react';
import type { AppSettings } from '@tm/shared/settings';
import { applyDocumentAppearance, readAppearanceEnv, resolveAppearance } from './appearance';
import type { ResolvedAppearance } from './appearance';

/**
 * Resolves `appearance`/`transparency` against this window's environment, re-resolving
 * whenever either setting changes or the OS flips one of the two media queries
 * `resolveAppearance` reads — dark mode, or reduced transparency. Applies the result to
 * `document.documentElement` in a layout effect, so the DOM never paints a frame with the
 * previous scheme's attributes still on it.
 */
export function useResolvedAppearance(
  settings: Pick<AppSettings, 'appearance' | 'transparency'>,
): ResolvedAppearance {
  const [resolved, setResolved] = useState<ResolvedAppearance>(() =>
    resolveAppearance(settings, readAppearanceEnv(window)),
  );

  useEffect(() => {
    const recompute = (): void =>
      setResolved(resolveAppearance(settings, readAppearanceEnv(window)));
    recompute();

    const schemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const transparencyQuery = window.matchMedia('(prefers-reduced-transparency: reduce)');
    schemeQuery.addEventListener('change', recompute);
    transparencyQuery.addEventListener('change', recompute);
    return () => {
      schemeQuery.removeEventListener('change', recompute);
      transparencyQuery.removeEventListener('change', recompute);
    };
  }, [settings.appearance, settings.transparency]);

  useLayoutEffect(() => {
    applyDocumentAppearance(document.documentElement, resolved);
  }, [resolved]);

  return resolved;
}
