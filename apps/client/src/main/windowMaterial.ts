/**
 * Whether to paint the window with Windows' own Mica/Acrylic material instead of the CSS
 * glass pane — pure, unit-tested, and deliberately ignorant of Electron, in the style of
 * `backgroundMode.ts`. The detection rule is F13.6's spike finding (F13.7,
 * `docs/14-design-system.md#glass`): Electron's `backgroundMaterial` is a no-op below
 * Windows build 22621 and is dropped over a Remote Desktop session, and DWM does not withhold
 * Mica/Acrylic on its own when the OS "Transparency effects" switch is off — the app must
 * refuse the material itself in both cases, using signals readable before any window exists.
 * With the switch off Windows paints a flat fallback instead — light, whatever the app's Theme
 * — so a dark renderer over it read white text on a light sidebar (v1.86.x). No setting may
 * override that refusal; `'full'` only keeps the CSS glass on (`resolveAppearance`).
 */
import { WINDOW_CANVAS, windowSchemeFor, type NativeMaterial } from '@shared/canvas';

export type WindowMaterial = NativeMaterial | 'none';

/**
 * Parses the numeric build out of `os.release()` (e.g. `'10.0.22631'` → `22631`). Anything
 * that doesn't look like a release string — an empty string, junk, a release with fewer than
 * three dot-separated numbers — resolves to `0`, which `windowMaterialFor`'s `>= 22621` check
 * then naturally refuses.
 */
export function windowsBuildOf(release: string): number {
  const build = Number(release.split('.')[2]);
  return Number.isFinite(build) ? build : 0;
}

/** The subset of settings this decision depends on — tolerant of junk, like `resolveAppearance`. */
export interface WindowMaterialSettings {
  appearance: unknown;
  transparency: unknown;
}

/** The signals only available from Electron's main process (`nativeTheme`, `process.env`). */
export interface WindowMaterialEnv {
  remoteSession: boolean;
  /** `nativeTheme.prefersReducedTransparency` — the OS "Transparency effects" switch is off. */
  reducedTransparency: boolean;
  /** `nativeTheme.shouldUseHighContrastColors` — Electron skips DWM dark mode under it. */
  highContrast: boolean;
  /** `nativeTheme.shouldUseDarkColors`, read after `themeSource` is set. */
  prefersDark: boolean;
}

/** What a `BrowserWindow` is created (or re-applied) with. */
export interface WindowBackdrop {
  material: WindowMaterial;
  backgroundColor: string;
}

/**
 * Decide what material a `BrowserWindow` should be given.
 *
 * Granted only when every one of these holds: win32 at build 22621 or later; not a Remote
 * Desktop session; the setting is not `'reduced'`; the OS "Transparency effects" switch is on;
 * and no high contrast / forced colours. `'full'` no longer overrides the OS switch — Windows
 * cannot draw the material with it off, whatever the app asks for. Any value other than
 * `'reduced'` (an old blob, a hand-edited one, `'system'`, `'full'`) passes the setting check,
 * the same tolerance `resolveAppearance` (`@tm/ui/appearance`) applies to the same setting.
 * The scheme is not an input: Electron keeps DWM dark mode in step with `themeSource`.
 */
export function windowMaterialFor(
  platform: NodeJS.Platform,
  osBuild: number,
  settings: Pick<WindowMaterialSettings, 'transparency'>,
  env: Omit<WindowMaterialEnv, 'prefersDark'>,
): WindowMaterial {
  if (platform !== 'win32' || osBuild < 22621) return 'none';
  if (env.remoteSession) return 'none';
  if (settings.transparency === 'reduced') return 'none';
  if (env.reducedTransparency) return 'none';
  if (env.highContrast) return 'none';

  return 'mica';
}

/**
 * The material and the matching window `backgroundColor`: fully transparent (`'#00000000'`)
 * with a material, because an opaque colour behind it would defeat the material entirely
 * (F13.6's spike finding); otherwise the resolved scheme's canvas, so the first frame is never
 * a flash of the wrong scheme.
 */
export function windowBackdropFor(
  platform: NodeJS.Platform,
  osBuild: number,
  settings: WindowMaterialSettings,
  env: WindowMaterialEnv,
): WindowBackdrop {
  const material = windowMaterialFor(platform, osBuild, settings, env);
  const backgroundColor =
    material === 'none'
      ? WINDOW_CANVAS[windowSchemeFor(settings.appearance, env.prefersDark)]
      : '#00000000';
  return { material, backgroundColor };
}

/**
 * Whether `SESSIONNAME` marks this process as running inside a Remote Desktop session — the
 * only signal available before a window is created, and the one F13.6's spike could not reach
 * a real RDP session to confirm directly. Unset (a normal console session on most machines) or
 * any non-`RDP-` value (e.g. `'Console'`) is not remote.
 */
export function isRemoteSession(env: NodeJS.ProcessEnv): boolean {
  return /^RDP-/i.test(env.SESSIONNAME ?? '');
}
