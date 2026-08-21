/**
 * Build gate: refuse to package if the compiled `better-sqlite3` addon targets a
 * different Node ABI than the Electron we ship.
 *
 * Run by `pnpm package` / `pnpm package:linux:local` (and standalone via `pnpm check:abi`)
 * AFTER `electron-builder install-app-deps`, so it verifies the very binary that is
 * about to be copied into `app.asar.unpacked`.
 *
 * Background: v0.25.0's Linux build shipped an addon compiled for Node 22 (ABI 127)
 * against Electron 33 (ABI 130). Because the addon loads lazily inside `new Database()`,
 * the failure surfaced as "every tab shows Loading" rather than a crash. This check
 * turns that class of bug back into a loud, early build failure.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { ADDON_RELATIVE_PATH, readElectronAbi, readModuleAbi } from './native-abi.mjs';

const require = createRequire(import.meta.url);

/** Resolve through the package's own manifest — pnpm symlinks `node_modules` entries. */
const addonPath = join(
  dirname(require.resolve('better-sqlite3/package.json')),
  ADDON_RELATIVE_PATH,
);

/** In a plain Node process the `electron` module exports the path to its binary. */
const electronPath = require('electron');

const expected = readElectronAbi(electronPath);
const actual = readModuleAbi(readFileSync(addonPath));

if (actual === null) {
  console.error(
    `ABI check FAILED: no node_register_module_v* symbol in\n  ${addonPath}\n` +
      `The addon is missing or corrupt. Reinstall with: pnpm install`,
  );
  process.exit(1);
}

if (actual !== expected) {
  console.error(
    `ABI check FAILED: better_sqlite3.node targets NODE_MODULE_VERSION ${actual}, ` +
      `but Electron requires ${expected}.\n` +
      `  addon:    ${addonPath}\n` +
      `  electron: ${electronPath}\n\n` +
      `Packaging this would produce an app that opens but leaves every screen on\n` +
      `"Loading" (the DB fails to open, so no IPC handlers get registered).\n\n` +
      `Fix it with:\n  pnpm exec electron-builder install-app-deps\n` +
      `and if that leaves it unchanged (pnpm's symlinked layout sometimes no-ops the\n` +
      `rebuild), force a source build:\n` +
      `  pnpm rebuild better-sqlite3 --config.runtime=electron ` +
      `--config.target=$(node -p "require('electron/package.json').version")`,
  );
  process.exit(1);
}

console.log(`ABI check OK: better_sqlite3.node and Electron both at ABI ${expected}.`);
