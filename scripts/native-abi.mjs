/**
 * Native-module ABI helpers, shared by `check-native-abi.mjs` and its test.
 *
 * Why this exists: `better-sqlite3` ships a compiled `.node` addon that is bound to
 * one specific Node ABI ("NODE_MODULE_VERSION"). Electron embeds its OWN Node, whose
 * ABI differs from the Node that runs `pnpm install` — Electron 33 is ABI 130 while
 * Node 22 is ABI 127. If the addon in the bundle was built for the wrong one, the app
 * still launches (the addon loads lazily, inside `new Database()`), throws deep in
 * `createStore()`, and every screen spins forever. v0.25.0 shipped exactly that on
 * Linux, so packaging now verifies the ABI and refuses to build a broken bundle.
 */
import { execFileSync } from 'node:child_process';

/** The addon path, relative to a resolved `better-sqlite3` package root. */
export const ADDON_RELATIVE_PATH = 'build/Release/better_sqlite3.node';

/**
 * Extract the ABI a compiled addon was built for, by finding the registration symbol
 * `node_register_module_v<N>` that the `NODE_MODULE` macro emits. The symbol name is a
 * plain ASCII string in the binary's symbol/export table on every platform, so one
 * scan works for ELF (Linux), PE (Windows) and Mach-O (macOS) alike — no readelf,
 * dumpbin or extra dependency needed.
 *
 * @param {Buffer} buffer contents of the `.node` file
 * @returns {number | null} the ABI number, or null if the symbol is absent
 */
export function readModuleAbi(buffer) {
  // 'latin1' maps every byte to one character, so binary bytes can never combine into
  // a false match and the character offsets stay 1:1 with byte offsets.
  const match = /node_register_module_v(\d+)/.exec(buffer.toString('latin1'));
  return match ? Number(match[1]) : null;
}

/**
 * Ask the installed Electron what ABI it requires, rather than hardcoding a version
 * map that would silently rot the next time Electron is upgraded. `ELECTRON_RUN_AS_NODE`
 * runs the Electron binary as a plain Node interpreter, so this needs no display and
 * works in WSL and CI.
 *
 * @param {string} electronPath absolute path to the Electron executable
 * @returns {number}
 */
export function readElectronAbi(electronPath) {
  const out = execFileSync(electronPath, ['-p', 'process.versions.modules'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  });
  const abi = Number(out.trim());
  if (!Number.isInteger(abi)) {
    throw new Error(`Could not read Electron's ABI — got ${JSON.stringify(out)}`);
  }
  return abi;
}
