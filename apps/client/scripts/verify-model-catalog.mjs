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
 * A second section drives `discoverModelCatalog` itself — the merge, not just the static
 * sweep `probeModelCatalog` covers above. `claudeModels.test.ts` proves the merge/filter
 * logic against a STUBBED `Available:` line (`ModelField.test.ts`'s `mergeCatalog` tests do
 * the same one layer up, for the picker); neither can prove the real CLI's real line still
 * has the shape that logic assumes. So this section reads the real `Available:` line through
 * the same real `ExecHost` (`localHost()` — real, not the injectable stub the unit tests
 * pass instead) that `discoverModelCatalog` itself calls through, independently of it, then
 * checks:
 *
 *  - every bare alias the line names (`sonnet`, `opus`, …) comes through `discoverModelCatalog`
 *    known and labelled — the merge did not drop or mis-tag a live alias;
 *  - every non-model token the line also names (`best`, `opusplan`, a `[1m]` variant) is
 *    ABSENT from the result — `familyOfAlias`'s filter held against real CLI prose, not just
 *    the fixed reply string the unit tests hand-wrote.
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
 *
 * The discovery section was proved the same way, on 2026-09-28: dropping
 * `alias.family !== null &&` from `discoverModelCatalog`'s `newAliases` filter (so every
 * non-model token on the `Available:` line is treated as a live alias too) turned every
 * "is filtered out" check red — `best`, `opusplan`, `default`, `sonnet[1m]`, `opus[1m]` and
 * `fable[1m]` all showed up as rows — while every other check, including the live-alias
 * ones, stayed green. Reverted afterward with `git status` showing `claudeModels.ts`
 * byte-identical again.
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
import { MODEL_CATALOG, familyOfAlias } from '@shared/model';
import { localHost } from '__REPO__/src/main/exec';
import {
  discoverModelCatalog,
  parseAvailableAliases,
  probeModelCatalog,
} from '__REPO__/src/main/claudeModels';

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

// ---------------------------------------------------------------------------
// discoverModelCatalog against the real CLI: does the merge/filter logic
// claudeModels.test.ts proved against a stub still hold against the real Available: line?
console.log('\nDiscovering the live catalog...');
const discovered = await discoverModelCatalog();

// An INDEPENDENT read of the same Available: line discoverModelCatalog itself reads —
// through the real ExecHost it uses by default (localHost(); a test passes a stub
// instead), so this is ground truth rather than the function grading its own homework.
const groundTruth = await localHost().exec(
  process.cwd(),
  'claude',
  ['--model', 'sonnet', '-p', '/model', '--output-format', 'json'],
  { resolveViaShell: true, timeoutMs: 10000 },
);
check(
  'the independent Available: probe succeeded',
  groundTruth.code === 0,
  groundTruth.stderr || 'exit ' + groundTruth.code,
);
let availableText = null;
try {
  const parsed = JSON.parse(groundTruth.stdout);
  if (typeof parsed.result === 'string') availableText = parsed.result;
} catch {
  // left null — checked below
}
check(
  'its reply parses as JSON carrying a result string',
  availableText !== null,
  groundTruth.stdout,
);

const aliasTokens = availableText === null ? [] : parseAvailableAliases(availableText);
check(
  'the Available: line names at least one token',
  aliasTokens.length > 0,
  availableText ?? '(none)',
);

const liveAliases = aliasTokens.filter((t) => familyOfAlias(t) !== null);
const bogusTokens = aliasTokens.filter((t) => familyOfAlias(t) === null);
check(
  'the Available: line also names at least one non-model token (a mode, or a [1m] variant) — ' +
    'otherwise there is nothing here for the filter to prove',
  bogusTokens.length > 0,
  JSON.stringify(aliasTokens),
);

for (const id of liveAliases) {
  const row = discovered.find((r) => r.id === id);
  check(
    'live alias ' + id + ' comes through the merge, known and labelled by the CLI',
    row !== undefined && row.known === true && row.label !== '' && row.label !== id,
    JSON.stringify(row),
  );
}

for (const token of bogusTokens) {
  check(
    'non-model token ' + token + ' from the Available: line is filtered out, never a row of its own',
    !discovered.some((r) => r.id === token),
    JSON.stringify(discovered.map((r) => r.id)),
  );
}

console.log('');
console.log(
  discovered.length +
    ' discovered row(s); ' +
    liveAliases.length +
    ' live alias(es) and ' +
    bogusTokens.length +
    ' bogus token(s) checked.',
);
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
