/**
 * The window's own background colour, per scheme — read by `@tm/ui/tokens`'s `SEMANTIC`
 * (the single source for both the Fluent theme and the document background) and by the
 * Electron main process, which picks a window `backgroundColor` before `createWindow` ever
 * mounts a renderer to resolve a scheme the normal way. Shared rather than owned by
 * `packages/ui` because the main process has no Fluent and no DOM to read a token from.
 */
export type WindowScheme = 'light' | 'dark';

export const WINDOW_CANVAS: Record<WindowScheme, string> = {
  light: '#F7F8FA',
  dark: '#202326',
};

/**
 * The scheme a window should paint, from a saved `appearance` setting and whether the OS
 * itself prefers dark. `'system'`, or anything that isn't exactly `'light'`/`'dark'` (an old
 * blob, a hand-edited one), falls through to the OS rather than throwing or defaulting to one
 * scheme outright — the same tolerance `resolveAppearance` (`@tm/ui/appearance`) applies to
 * the same setting.
 */
export function windowSchemeFor(appearance: unknown, osPrefersDark: boolean): WindowScheme {
  if (appearance === 'light') return 'light';
  if (appearance === 'dark') return 'dark';
  return osPrefersDark ? 'dark' : 'light';
}
