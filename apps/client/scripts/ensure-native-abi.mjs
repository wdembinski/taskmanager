/**
 * Make the compiled `better-sqlite3` addon match Electron's ABI — rebuilding it if it
 * doesn't — and fail the build if it still doesn't afterwards.
 *
 * `electron-builder install-app-deps` is supposed to handle this, and does on Windows.
 * Under pnpm's symlinked `.pnpm` layout on Linux it reports success ("finished
 * moduleName=better-sqlite3") while leaving the Node-ABI binary that `pnpm install`'s
 * own prebuild step fetched. That is how v0.25.0 shipped a Linux .deb whose every
 * screen sat on "Loading" forever.
 *
 * So: check first (cheap), and only when it's wrong, force a from-source build against
 * Electron's headers by setting the `npm_config_*` variables node-gyp reads. That path
 * is deterministic — it compiles rather than resolving a prebuild — at the cost of a
 * couple of minutes, which is only paid when something is actually broken.
 *
 * Run by `pnpm package` / `pnpm package:linux:local`. `pnpm check:abi` is the check alone.
 */
import { execFileSync } from 'node:child_process';
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
const electronVersion = require('electron/package.json').version;

const expected = readElectronAbi(electronPath);

/** Current ABI of the built addon, or null if it is missing/unreadable. */
function currentAbi() {
  try {
    return readModuleAbi(readFileSync(addonPath));
  } catch {
    return null;
  }
}

const before = currentAbi();
if (before === expected) {
  console.log(`ABI OK: better_sqlite3.node and Electron both at ABI ${expected}.`);
  process.exit(0);
}

console.log(
  `better_sqlite3.node is at ABI ${before ?? 'unknown'}, Electron needs ${expected} — ` +
    `rebuilding from source against Electron ${electronVersion} headers…`,
);

try {
  execFileSync('pnpm', ['rebuild', 'better-sqlite3'], {
    stdio: 'inherit',
    shell: process.platform === 'win32', // pnpm is a .cmd shim on Windows
    env: {
      ...process.env,
      // What @electron/rebuild sets internally; setting them here bypasses whatever
      // pnpm's layout does to that code path.
      npm_config_runtime: 'electron',
      npm_config_target: electronVersion,
      npm_config_disturl: 'https://electronjs.org/headers',
      npm_config_build_from_source: 'true',
      npm_config_arch: process.arch,
    },
  });
} catch (err) {
  console.error(`Rebuild failed: ${err.message}`);
  process.exit(1);
}

const after = currentAbi();
if (after !== expected) {
  console.error(
    `ABI check FAILED after rebuild: better_sqlite3.node is at ${after ?? 'unknown'}, ` +
      `Electron requires ${expected}.\n  addon: ${addonPath}\n\n` +
      `Do NOT package this — the app would open and leave every screen on "Loading".\n` +
      `Check that a C++ toolchain and python3 are present for node-gyp.`,
  );
  process.exit(1);
}

console.log(`Rebuilt: better_sqlite3.node now at ABI ${expected}.`);
