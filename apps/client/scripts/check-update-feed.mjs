/**
 * Release gate: refuse to ship an update feed that no installed client could act on.
 *
 * Checks the files electron-builder just wrote into `dist/`:
 *
 *  - the baked `app-update.yml` contains no unexpanded `${…}` macro;
 *  - it carries no `publisherName` unless something is genuinely signing the build
 *    (Windows only — that key is what makes electron-updater verify the installer's
 *    Authenticode signature, and an unsigned installer then fails ERR_UPDATER_INVALID_SIGNATURE);
 *  - every artifact named by `latest*.yml` actually exists in `dist/`.
 *
 * See `update-feed.mjs` for the two shipped releases that motivated each check.
 *
 * Run by `pnpm package` / `pnpm package:linux` / `pnpm package:local`, and standalone via
 * `pnpm check:feed`. On the publishing scripts it runs AFTER the upload, which is fine and
 * deliberate: `--publish onTagOrDraft` only writes to a **draft**, so nothing reaches a
 * user until the draft is promoted. Failing before promotion is the gate that matters.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  feedArtifactNames,
  findUnexpandedMacros,
  hasPublisherName,
  isSigningConfigured,
} from './update-feed.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(repoRoot, 'dist');

/** Collected so one run reports every problem, rather than one per re-build. */
const problems = [];

const read = (path) => readFileSync(path, 'utf8');

/** The bundled updater config, per platform we may have just packaged. */
const bundles = [
  { platform: 'Windows', path: join(dist, 'win-unpacked', 'resources', 'app-update.yml') },
  { platform: 'Linux', path: join(dist, 'linux-unpacked', 'resources', 'app-update.yml') },
].filter((bundle) => existsSync(bundle.path));

if (bundles.length === 0) {
  console.error(
    `Feed check FAILED: no packaged bundle under\n  ${dist}\n` +
      `Nothing to verify — run this after electron-builder, e.g. via pnpm package:local.`,
  );
  process.exit(1);
}

const builderConfig = read(join(repoRoot, 'electron-builder.yml'));
const signing = isSigningConfigured(process.env, builderConfig);

for (const { platform, path } of bundles) {
  const text = read(path);

  const macros = findUnexpandedMacros(text);
  if (macros.length > 0) {
    problems.push(
      `${platform}: app-update.yml contains unexpanded macro(s) ${macros.join(', ')}\n` +
        `  ${path}\n` +
        `  electron-builder expands macros in artifact names, NOT in this file. Whatever\n` +
        `  put them there wrote a literal string into every client's updater config.`,
    );
  }

  // Windows-only: `publisherName` has no meaning for the AppImage updater, and it is only
  // ever written for Windows in the first place (PublishManager checks Platform.WINDOWS).
  if (platform === 'Windows' && hasPublisherName(text) && !signing) {
    problems.push(
      `${platform}: app-update.yml sets publisherName, but nothing is signing the build\n` +
        `  ${path}\n` +
        `  electron-updater will run Get-AuthenticodeSignature on the installer it\n` +
        `  downloads and reject the unsigned file with ERR_UPDATER_INVALID_SIGNATURE — the\n` +
        `  download completes and the install never happens. This is exactly how every\n` +
        `  Windows auto-update up to v0.33.0 broke.\n` +
        `  Fix: leave win.verifyUpdateCodeSignature at false and set no publisherName until\n` +
        `  a certificate is wired in (see docs/07-packaging-and-release.md).`,
    );
  }
}

for (const feed of ['latest.yml', 'latest-linux.yml']) {
  const feedPath = join(dist, feed);
  if (!existsSync(feedPath)) continue;

  const missing = feedArtifactNames(read(feedPath)).filter((name) => !existsSync(join(dist, name)));
  if (missing.length > 0) {
    problems.push(
      `${feed} names artifact(s) that are not in dist/: ${missing.join(', ')}\n` +
        `  ${feedPath}\n` +
        `  A feed pointing at a file that isn't beside it is a release nobody can update\n` +
        `  to — the updater 404s on the exact name it was told to fetch.`,
    );
  }
}

if (problems.length > 0) {
  console.error(`Feed check FAILED:\n\n${problems.join('\n\n')}\n`);
  console.error(`Do NOT promote a draft release built from this.`);
  process.exit(1);
}

const where = bundles.map((bundle) => bundle.platform).join(' + ');
console.log(
  `Feed check OK (${where}): no unexpanded macros, ` +
    `${signing ? 'publisherName matches a configured certificate' : 'no publisherName while unsigned'}, ` +
    `every artifact the feed names is present.`,
);
