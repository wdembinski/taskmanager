/**
 * Headless check: does the CLI actually installed on THIS machine still recognize every
 * model `MODEL_CATALOG` (`@shared/model`) offers?
 *
 * `claudeModels.test.ts` proves `probeModelCatalog`'s PARSING is correct against a stubbed
 * host. It cannot prove the catalog itself is still accurate, because a stub only ever
 * answers what the test wrote — it cannot notice that a real dated snapshot the catalog
 * still lists has since been retired. Only the real `claude` binary on PATH can answer
 * that, and asking it costs nothing: `/model` is a local meta-command
 * (`claudeModels.ts`'s header comment explains why) — zero tokens, zero turns, no network
 * round trip to the model itself.
 *
 * Two claims, checked per catalog entry:
 *
 *  - it RESOLVES — `known: true` — catching an id the catalog lists that the installed CLI
 *    has never heard of at all (a typo, or a model pulled before it shipped);
 *  - for a `kind: 'version'` entry specifically, its label is not its own raw id. This is
 *    the one shape a quiet retirement never produces on its own: a remapped id still comes
 *    back with the REPLACEMENT's friendly name, never with the id you asked about — so this
 *    is what would actually catch a version entry that has quietly stopped meaning what the
 *    catalog says it means. `known` already implies this (see the module's own comment for
 *    why `known := label !== id`), but the point of the catalog is version PINNING, so the
 *    id-shaped failure mode is worth naming for itself rather than folding into "known".
 *
 *   pnpm exec node scripts/verify-model-catalog.mjs
 *
 * Requires a `claude` on PATH that is signed in — the same requirement every other run in
 * this app carries. Exits non-zero on the first entry that fails either claim, naming it.
 *
 * Unlike `verify-model-split.mjs`, this never touches Electron or `better-sqlite3`:
 * `claudeModels.ts` and the `exec` host it calls through are plain Node (`node:child_process`
 * only), so the bundle runs under ordinary `node` — no ABI dance, no stub CLI, no store.
 *
 * **Proving it can fail.** Run on 2026-09-07 with a fifteenth entry appended to
 * MODEL_CATALOG — `claude-totally-bogus-retired-id`, `kind: 'version'` — standing in for a
 * dated snapshot the CLI has quietly stopped recognizing: both checks for that entry go
 * red, the real CLI echoing the id back as its own "label" exactly as an unresolved probe
 * does. Every other entry stayed green. Reverted afterward with `git status` showing
 * `model.ts` byte-identical again.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** `@shared` now lives in the packages/shared workspace package, not under this app. */
const sharedSrc = join(repo, '..', '..', 'packages', 'shared', 'src');

/** Everything this script writes lives here, inside the repo, matching every other
 *  `verify-*.mjs` — `.verify-*` is already `.gitignore`d for exactly this. */
const work = join(repo, '.verify-model-catalog');

function log(message) {
  process.stdout.write(`${message}\n`);
}

/** Bundle the scenario file to a runnable ESM module. No native addon involved, so
 *  nothing needs to stay external and no alias for `electron` is needed either. */
async function bundle(entry, outDir) {
  await build({
    configFile: false,
    logLevel: 'error',
    resolve: { alias: { '@shared': sharedSrc } },
    build: {
      ssr: entry,
      outDir,
      emptyOutDir: true,
      target: 'node20',
      minify: false,
      rollupOptions: { output: { format: 'es', entryFileNames: 'bundle.mjs' } },
    },
  });
  return join(outDir, 'bundle.mjs');
}

/**
 * NO BACKTICKS below: this is a `String.raw` template, and one inside a comment closes it
 * with a SyntaxError pointing at a word in prose.
 */
const SCENARIO = String.raw`
import { MODEL_CATALOG } from '@shared/model';
import { probeModelCatalog } from '__REPO__/src/main/claudeModels';

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log('  PASS  ' + label);
  } else {
    failures += 1;
    console.log('  FAIL  ' + label + (detail === undefined ? '' : ' — ' + detail));
  }
}

const rows = await probeModelCatalog();

for (let i = 0; i < MODEL_CATALOG.length; i += 1) {
  const entry = MODEL_CATALOG[i];
  const row = rows[i];
  check(
    entry.id + ' resolves against the installed CLI',
    row.known,
    JSON.stringify(row) + ' — is claude on PATH and signed in?',
  );
  if (entry.kind === 'version') {
    check(
      entry.id + ' label is not its own raw id (a version entry retired and remapped would trip this)',
      row.label !== entry.id,
      'label: ' + row.label,
    );
  }
}

console.log('');
console.log(MODEL_CATALOG.length + ' catalog entries probed.');
if (failures > 0) {
  console.error(failures + ' check(s) failed.');
  process.exit(1);
}
`;

async function main() {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  try {
    const entry = join(work, 'entry.ts');
    const posix = (p) => p.replace(/\\/g, '/');
    writeFileSync(entry, SCENARIO.replaceAll('__REPO__', posix(repo)), 'utf8');
    log('Probing the installed CLI against every MODEL_CATALOG entry...\n');
    const bundlePath = await bundle(entry, join(work, 'out'));
    const result = spawnSync(process.execPath, [bundlePath], { encoding: 'utf8' });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) {
      throw new Error(`${bundlePath} exited ${result.status ?? `on ${result.signal}`}`);
    }
    log('\nAll catalog entries resolve.');
  } finally {
    if (process.argv.includes('--keep')) log(`\nLeft ${work} in place (--keep).`);
    else rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
}

await main();
