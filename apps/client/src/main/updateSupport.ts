/**
 * Which installs may update themselves, and how the result reads.
 *
 * Pure on purpose: `Updater` itself talks to `electron-updater` and the network and so
 * can't be tested, but the decision of *whether to talk to it at all* is exactly the
 * part that goes wrong quietly. Getting it wrong is not cosmetic — pointing
 * `electron-updater` at a `.deb` install makes it error on every launch (the package is
 * apt's, not ours), and an AppImage that is not being run as an AppImage has no file to
 * replace, so it fails at the very end of a download the user already waited for.
 */
import type { UpdateMode } from '@shared/update';

/**
 * Decide the update mode for this install.
 *
 * @param platform    `process.platform`.
 * @param env         `process.env` — read for `APPIMAGE`, which the AppImage runtime sets
 *                    to the path of the running .AppImage file. Its absence on Linux is
 *                    what distinguishes a deb/from-source run from a self-replaceable one.
 * @param isPackaged  `app.isPackaged`. A `pnpm dev` run has no installer to update.
 */
export function updateMode(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  isPackaged: boolean,
): UpdateMode {
  // Development: electron-updater would look for a feed next to the electron binary.
  if (!isPackaged) return 'off';
  // NSIS updates apply unsigned; SmartScreen just prompts each time (stated in the UI).
  if (platform === 'win32') return 'auto';
  if (platform === 'linux') return env['APPIMAGE'] ? 'auto' : 'manual';
  // macOS refuses to apply an update that isn't signed and notarized, and we don't sign.
  return 'manual';
}
