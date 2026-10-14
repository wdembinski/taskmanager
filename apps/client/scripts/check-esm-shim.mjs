/**
 * Build gate: refuse a main bundle whose CommonJS shim did not land at the top of the file.
 *
 * Run by `pnpm build` right after `electron-vite build`.
 *
 * The main process is ESM (`"type": "module"`), so electron-vite injects
 * `const __dirname = import.meta.dirname;` and its siblings into the bundle. It places that
 * block after the LAST match of a regex for import statements, and that regex also matches
 * text inside strings. v0.170.0 shipped a skill-import error message worded as the keyword
 * followed by a quoted name, so the shim landed inside that template literal, `__dirname` was
 * never declared, and the app died on launch with "__dirname is not defined in ES module
 * scope" (the tray icon's `?asset` path is the first thing to read it). This check turns
 * that back into a build failure.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundlePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'main', 'index.js');

function fail(message) {
  console.error(`check-esm-shim: ${message}`);
  console.error(
    'A string in the main process probably reads like an import statement ' +
      '(the keyword import followed by a quote); reword it.',
  );
  process.exit(1);
}

if (!existsSync(bundlePath)) fail(`${bundlePath} does not exist — run electron-vite build first.`);

const lines = readFileSync(bundlePath, 'utf8').split('\n');
const shimLine = lines.indexOf('const __dirname = import.meta.dirname;');

if (shimLine === -1) {
  if (lines.some((line) => /\b__dirname\b/.test(line))) {
    fail('the bundle uses __dirname but never declares it.');
  }
  process.exit(0);
}

// Everything before the shim must be import statements or the shim's own first lines.
const header =
  /^(import\s.*from\s*["'][^"']+["'];?|import\s*["'][^"']+["'];?|const __filename = import\.meta\.filename;|\/\/.*|\s*)$/;
for (let i = 0; i < shimLine; i++) {
  if (!header.test(lines[i])) {
    fail(
      `__dirname is declared at line ${shimLine + 1}, after code at line ${i + 1}: ${lines[i].trim().slice(0, 120)}`,
    );
  }
}

console.log(`check-esm-shim: __dirname declared at line ${shimLine + 1}, ahead of all code.`);
