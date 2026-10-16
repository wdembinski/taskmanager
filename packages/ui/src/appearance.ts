/**
 * Resolves `appearance`/`transparency` settings plus this machine's environment into the
 * scheme and glass mode a window should actually paint — the one place that decision is
 * made, so the desktop and the web shell can never disagree about what `'system'` means.
 */
import type { AppSettings } from '@tm/shared/settings';
import type { ColorScheme } from './tokens';

export interface AppearanceEnv {
  prefersDark: boolean;
  prefersReducedTransparency: boolean;
  backdropFilterSupported: boolean;
  /** Desktop only; null/absent = no OS material took effect (web, Win10, Linux). */
  nativeMaterial?: 'mica' | 'acrylic' | null;
}

export type GlassMode = 'native' | 'css' | 'opaque';

export interface ResolvedAppearance {
  scheme: ColorScheme;
  glass: GlassMode;
}

/**
 * Resolve the scheme and glass mode to paint, from the user's settings and the environment
 * they're running in.
 *
 * `transparency: 'system'` honours the OS's reduced-transparency media query; `'full'` is
 * the user's explicit opt-in and overrides that query — otherwise `'full'` would mean
 * nothing different from `'system'`, since the OS query is the only way glass would ever
 * turn off under `'system'` in the first place.
 *
 * Tolerates unknown or missing setting values (an old blob, a hand-edited one) by treating
 * them as `'system'`, rather than throwing or painting nothing.
 */
export function resolveAppearance(
  settings: Pick<AppSettings, 'appearance' | 'transparency'>,
  env: AppearanceEnv,
): ResolvedAppearance {
  const scheme: ColorScheme =
    settings.appearance === 'light' || settings.appearance === 'dark'
      ? settings.appearance
      : env.prefersDark
        ? 'dark'
        : 'light';

  const glass: GlassMode = (() => {
    if (settings.transparency === 'reduced') return 'opaque';
    if (settings.transparency !== 'full' && env.prefersReducedTransparency) return 'opaque';
    if (!env.backdropFilterSupported) return 'opaque';
    if (env.nativeMaterial === 'mica' || env.nativeMaterial === 'acrylic') return 'native';
    return 'css';
  })();

  return { scheme, glass };
}
