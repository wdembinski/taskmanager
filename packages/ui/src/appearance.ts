/**
 * Resolves `appearance`/`transparency` settings plus this machine's environment into the
 * scheme and glass mode a window should actually paint — the one place that decision is
 * made, so the desktop and the web shell can never disagree about what `'system'` means.
 */
import type { AppSettings, AppearanceSetting, TransparencySetting } from '@tm/shared/settings';
import type { ColorScheme } from './tokens';

/**
 * The Theme picker's options and hint, named once so Settings (desktop) and SettingsScreen
 * (web) can never word or order them differently — see each host's "Appearance" section.
 */
export const APPEARANCE_OPTIONS: ReadonlyArray<{ value: AppearanceSetting; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export const APPEARANCE_HINT =
  'System follows the OS’s own light/dark setting and switches live if it changes. Light and Dark override it everywhere this app draws.';

/** The Transparency picker's options and hint — same reasoning as {@link APPEARANCE_OPTIONS}. */
export const TRANSPARENCY_OPTIONS: ReadonlyArray<{ value: TransparencySetting; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'reduced', label: 'Reduced' },
  { value: 'full', label: 'Full' },
];

export const TRANSPARENCY_HINT =
  'System follows the OS’s reduced-transparency setting. Reduced always turns glass off; Full keeps it even when the OS asks for less.';

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

/**
 * The subset of `Window` {@link readAppearanceEnv} needs — named rather than typed as
 * `Window` itself so a test can hand it a plain object instead of standing up a real one.
 */
export interface AppearanceWindow {
  matchMedia(query: string): { matches: boolean };
  CSS?: { supports?(property: string, value: string): boolean };
}

/**
 * Reads this machine's environment into an {@link AppearanceEnv} — the two media queries
 * `resolveAppearance` needs, plus whether this window can even paint `backdrop-filter`.
 *
 * `nativeMaterial` is always `null` here: knowing whether Mica or Acrylic actually took
 * effect means asking the Electron main process, which is desktop-only and a different
 * mechanism than anything a `window` exposes — until F13.7 wires that up, every caller of
 * this function is in the same position a browser tab permanently is.
 *
 * `win.CSS` is optional because `Window` does not guarantee `CSS.supports` in every
 * environment this runs in (older WebViews); treated as unsupported rather than throwing.
 */
export function readAppearanceEnv(win: AppearanceWindow): AppearanceEnv {
  return {
    prefersDark: win.matchMedia('(prefers-color-scheme: dark)').matches,
    prefersReducedTransparency: win.matchMedia('(prefers-reduced-transparency: reduce)').matches,
    backdropFilterSupported: win.CSS?.supports?.('backdrop-filter', 'blur(1px)') ?? false,
    nativeMaterial: null,
  };
}

/**
 * The subset of an `Element` {@link applyDocumentAppearance} needs — named for the same
 * reason as {@link AppearanceWindow}: a test can hand it `{ dataset: {} }` rather than a real
 * DOM node.
 */
export interface AppearanceElement {
  dataset: Record<string, string | undefined>;
}

/**
 * Stamps a resolved appearance onto an element's `data-*` attributes — `useGlobalStyles`
 * (`theme.ts`) reads `data-scheme` to decide which scheme's custom properties apply;
 * `data-glass` is for the glass pane primitive (F13.5) to read once it exists.
 *
 * Always writes `data-scheme` explicitly, even for `'dark'`: `useGlobalStyles` defaults to
 * dark with no attribute at all, so writing `'dark'` here is a no-op for the CSS but keeps
 * the DOM honest about which scheme is actually mounted, for anything else that inspects it.
 */
export function applyDocumentAppearance(el: AppearanceElement, resolved: ResolvedAppearance): void {
  el.dataset.scheme = resolved.scheme;
  el.dataset.glass = resolved.glass;
}
