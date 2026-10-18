/**
 * Merges `ui-shots.mjs`'s `SCREENS` and `uiShotsFixture.mjs`'s `BOOT_CHANNELS` back together
 * from one file per feature under `scripts/shots/screens/` and `scripts/fixtures/shots/` — see
 * the "Split the ui-shots screen list and fixture per feature" plan. Collected by
 * `shotModules.test.mjs` the same way `shotChecks.mjs` is collected by `shotChecks.test.mjs`.
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCREENS_DIR = join(here, '..', 'shots', 'screens');
const DEFAULT_FIXTURES_DIR = join(here, '..', 'fixtures', 'shots');

/** Every `*.mjs` file directly under `dir`, sorted by a plain `<` comparison on the file name
 *  (the numeric prefix each screen/fixture file carries decides the merged order) and skipping
 *  `*.test.mjs` so a module's own test never gets imported as a row/channel source. */
export function listModuleFiles(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
    .sort()
    .map((name) => join(dir, name));
}

/** Concatenates every module's rows, file order then row order — `modules` is
 *  `[{ file, rows }]`. Throws naming both files on a `name` repeated across (or within) a
 *  file, and throws naming the file on a row with no `name` at all. */
export function mergeScreens(modules) {
  const rows = [];
  const fileByName = new Map();
  for (const { file, rows: fileRows } of modules) {
    fileRows.forEach((row, index) => {
      if (!row.name) {
        throw new Error(`${file}: row at index ${index} has no "name"`);
      }
      const otherFile = fileByName.get(row.name);
      if (otherFile) {
        throw new Error(`duplicate screen name "${row.name}" in ${otherFile} and ${file}`);
      }
      fileByName.set(row.name, file);
      rows.push(row);
    });
  }
  return rows;
}

/** Merges every module's `CHANNELS` — `modules` is `[{ file, channels }]`. A channel only one
 *  file defines is copied as-is; a channel several files define is allowed only if every value
 *  is an array, joined in file order; anything else throws, naming the channel and both files. */
export function mergeChannels(modules) {
  const result = {};
  const fileByChannel = new Map();
  for (const { file, channels } of modules) {
    for (const [channel, value] of Object.entries(channels)) {
      if (!fileByChannel.has(channel)) {
        result[channel] = value;
        fileByChannel.set(channel, file);
        continue;
      }
      const otherFile = fileByChannel.get(channel);
      if (!Array.isArray(result[channel]) || !Array.isArray(value)) {
        throw new Error(
          `channel "${channel}" is defined in both ${otherFile} and ${file} but is not an array in both`,
        );
      }
      result[channel] = [...result[channel], ...value];
    }
  }
  return result;
}

/** Loads every screen file under `dir` (default `scripts/shots/screens/`) and merges their
 *  default-exported row arrays with `mergeScreens`. */
export async function loadScreens(dir = DEFAULT_SCREENS_DIR) {
  const files = listModuleFiles(dir);
  const modules = await Promise.all(
    files.map(async (file) => {
      const mod = await import(pathToFileURL(file).href);
      return { file, rows: mod.default };
    }),
  );
  return mergeScreens(modules);
}

/** Loads every fixture file under `dir` (default `scripts/fixtures/shots/`) and merges their
 *  exported `CHANNELS` objects with `mergeChannels`. */
export async function loadFixtureChannels(dir = DEFAULT_FIXTURES_DIR) {
  const files = listModuleFiles(dir);
  const modules = await Promise.all(
    files.map(async (file) => {
      const mod = await import(pathToFileURL(file).href);
      return { file, channels: mod.CHANNELS };
    }),
  );
  return mergeChannels(modules);
}
