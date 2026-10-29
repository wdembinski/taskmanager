/**
 * The answer to the preload's synchronous `window:boot` read — pure, unit-tested, and
 * deliberately ignorant of Electron, in the style of `themeSource.ts`. The renderer root
 * seeds its first render from this, so the first frame already resolves the saved scheme,
 * glass and type size instead of a guess that a later async read corrects (the flash of the
 * canvas wash that vanished once `window:nativeMaterial` answered).
 */
import type { BootAppearance } from '@shared/canvas';
import type { AppSettings } from '@shared/settings';
import type { WindowMaterial } from './windowMaterial';

/**
 * Maps the saved appearance settings plus the material the current window was created with
 * onto {@link BootAppearance}. `'none'` — no native material granted — becomes `null`, the
 * value `useResolvedAppearance` already reads as "no native glass".
 */
export function bootAppearanceFor(
  settings: Pick<AppSettings, 'appearance' | 'transparency' | 'fontSizePx'>,
  material: WindowMaterial,
): BootAppearance {
  return {
    appearance: settings.appearance,
    transparency: settings.transparency,
    fontSizePx: settings.fontSizePx,
    nativeMaterial: material === 'none' ? null : material,
  };
}
