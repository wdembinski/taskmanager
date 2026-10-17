/**
 * Mounts the resolved scheme and glass mode onto `document.documentElement` and keeps them
 * current — the one hook both hosts' `main.tsx` calls so the document never disagrees with
 * the theme a `FluentProvider` is mounting beside it.
 */
import { useEffect, useLayoutEffect, useState } from 'react';
import type { NativeMaterial } from '@tm/shared/canvas';
import type { AppSettings } from '@tm/shared/settings';
import { applyDocumentAppearance, readAppearanceEnv, resolveAppearance } from './appearance';
import type { ResolvedAppearance } from './appearance';

/**
 * Resolves `appearance`/`transparency` against this window's environment, re-resolving
 * whenever either setting changes, the OS flips one of the two media queries
 * `resolveAppearance` reads (dark mode, or reduced transparency), or `nativeMaterial`
 * itself changes. Applies the result to `document.documentElement` in a layout effect, so
 * the DOM never paints a frame with the previous scheme's attributes still on it.
 *
 * `nativeMaterial` is the desktop's own answer for whether Windows is painting Mica/Acrylic
 * behind this window (`main.tsx` asks `window:nativeMaterial` once on mount) — the web never
 * has one to pass, so it stays at the default `null` and always resolves `css` or `opaque`.
 */
export function useResolvedAppearance(
  settings: Pick<AppSettings, 'appearance' | 'transparency'>,
  nativeMaterial?: NativeMaterial | null,
): ResolvedAppearance {
  const [resolved, setResolved] = useState<ResolvedAppearance>(() =>
    resolveAppearance(settings, readAppearanceEnv(window, nativeMaterial)),
  );

  useEffect(() => {
    const recompute = (): void =>
      setResolved(resolveAppearance(settings, readAppearanceEnv(window, nativeMaterial)));
    recompute();

    const schemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const transparencyQuery = window.matchMedia('(prefers-reduced-transparency: reduce)');
    schemeQuery.addEventListener('change', recompute);
    transparencyQuery.addEventListener('change', recompute);
    return () => {
      schemeQuery.removeEventListener('change', recompute);
      transparencyQuery.removeEventListener('change', recompute);
    };
  }, [settings.appearance, settings.transparency, nativeMaterial]);

  useLayoutEffect(() => {
    applyDocumentAppearance(document.documentElement, resolved);
  }, [resolved]);

  return resolved;
}
