/**
 * Whether to paint the window with Windows' own Mica/Acrylic material instead of the CSS
 * glass pane — pure, unit-tested, and deliberately ignorant of Electron, in the style of
 * `backgroundMode.ts`. The detection rule is F13.6's spike finding (F13.7,
 * `docs/14-design-system.md#glass`): Electron's `backgroundMaterial` is a no-op below
 * Windows build 22621 and is dropped over a Remote Desktop session, and DWM does not withhold
 * Mica/Acrylic on its own when the OS "Transparency effects" switch is off — the app must
 * refuse the material itself in both cases, using signals readable before any window exists.
 */
import type { NativeMaterial } from '@shared/canvas';

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
  transparency: unknown;
}

/** The two signals only available from Electron's main process, read before a window exists. */
export interface WindowMaterialEnv {
  remoteSession: boolean;
  reducedTransparency: boolean;
}

/**
 * Decide what material a new `BrowserWindow` should be given.
 *
 * `'reduced'` always refuses, regardless of the OS; `'system'` additionally refuses when the
 * OS itself reports reduced transparency; `'full'` is the explicit opt-in that overrides the
 * OS signal — same tolerance and precedence as `resolveAppearance` (`@tm/ui/appearance`)
 * applies to the same setting, and any value other than `'reduced'`/`'full'` (an old blob, a
 * hand-edited one) is treated as `'system'`.
 */
export function windowMaterialFor(
  platform: NodeJS.Platform,
  osBuild: number,
  settings: WindowMaterialSettings,
  env: WindowMaterialEnv,
): WindowMaterial {
  if (platform !== 'win32' || osBuild < 22621) return 'none';
  if (env.remoteSession) return 'none';

  const transparency =
    settings.transparency === 'reduced' || settings.transparency === 'full'
      ? settings.transparency
      : 'system';
  if (transparency === 'reduced') return 'none';
  if (transparency === 'system' && env.reducedTransparency) return 'none';

  return 'mica';
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
