/**
 * Which theme Electron should report to the OS (`nativeTheme.themeSource`) — pure,
 * unit-tested, and deliberately ignorant of Electron, in the style of `windowMaterial.ts`.
 * Windows paints the Mica/Acrylic `backgroundMaterial` in whatever theme Electron reports, not
 * the scheme the renderer resolved: left at its default (`'system'`), the glass follows the OS
 * even under an explicit Theme, so Theme = Light on a dark Windows drew light panes over dark
 * Mica. Forcing `themeSource` also makes `nativeTheme.shouldUseDarkColors` (read for the opaque
 * `backgroundColor`) agree with the setting.
 */
export type ThemeSource = 'system' | 'light' | 'dark';

/**
 * Maps the saved `appearance` setting onto `nativeTheme.themeSource`. `'light'` and `'dark'`
 * force that theme; `'system'` — and any other value (an old blob, a hand-edited one) — leaves
 * it on the OS, the same tolerance `windowSchemeFor` and `windowMaterialFor` apply.
 */
export function themeSourceFor(appearance: unknown): ThemeSource {
  return appearance === 'light' || appearance === 'dark' ? appearance : 'system';
}
