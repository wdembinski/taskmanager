/**
 * Update-feed helpers, shared by `check-update-feed.mjs` and its test.
 *
 * Why this exists: the two files electron-builder writes for the updater — the
 * `app-update.yml` baked into the bundle and the `latest.yml` published beside the
 * installers — are both capable of describing a release that no client can ever install,
 * and neither failure shows up at build time.
 *
 * Both have now happened:
 *
 *  1. `win.signtoolOptions.publisherName` was set to `${author}` on the assumption the
 *     macro would expand. It does not — the literal string `${author}` landed in every
 *     shipped `app-update.yml`, and electron-updater treats the mere presence of
 *     `publisherName` as "verify the downloaded installer's Authenticode signature". The
 *     installer is unsigned, so every Windows auto-update from v0.30.0 to v0.33.0 died with
 *     ERR_UPDATER_INVALID_SIGNATURE right after the download finished.
 *  2. Assets uploaded by hand had their spaces rewritten to dots, so `latest.yml` named a
 *     file that was not on the release and the updater 404'd (see docs/07).
 *
 * Both are one-line mistakes with no symptom until a user's app tries to update, which is
 * the worst possible place to find out. These predicates turn them into build failures.
 *
 * Parsing is deliberately line-based rather than via a YAML library: the two things we
 * assert about are single scalar keys, the files are machine-generated and flat, and the
 * repo has no YAML parser in its dependency tree (`native-abi.mjs` reads binaries with a
 * regex for the same reason).
 */

/** Anything of the form `${…}` — an electron-builder macro that was never expanded. */
export function findUnexpandedMacros(text) {
  return [...new Set(text.match(/\$\{[^}\n]*\}/g) ?? [])];
}

/**
 * Does this `app-update.yml` carry a `publisherName`? Its presence — not its value — is
 * what switches on electron-updater's signature check (`NsisUpdater.verifySignature`).
 */
export function hasPublisherName(text) {
  return /^publisherName\s*:/m.test(text);
}

/**
 * Is anything actually signing the Windows build? A `publisherName` is correct once one of
 * these is in play and a lie otherwise, so the two are checked together.
 *
 * @param {Record<string, string | undefined>} env process environment
 * @param {string} builderConfig contents of electron-builder.yml
 */
export function isSigningConfigured(env, builderConfig) {
  const fromEnv = ['CSC_LINK', 'WIN_CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_KEY_PASSWORD'];
  if (fromEnv.some((name) => (env[name] ?? '') !== '')) return true;
  // Azure Trusted Signing and signtool both declare themselves in the config file.
  return /^\s*(azureSignOptions|certificateFile|certificateSubjectName|certificateSha1)\s*:/m.test(
    builderConfig,
  );
}

/**
 * The artifact filenames a `latest*.yml` feed claims to be published beside it — the
 * top-level `path:` the updater downloads, plus every `url:` under `files:`.
 *
 * Absolute URLs are skipped: a `provider: generic` test feed points at a host, not at a
 * file sitting in `dist/`.
 */
export function feedArtifactNames(text) {
  const names = [];
  for (const [, value] of text.matchAll(/^\s*-?\s*(?:url|path)\s*:\s*(.+?)\s*$/gm)) {
    const name = value.replace(/^['"]|['"]$/g, '');
    if (name && !name.includes('://')) names.push(name);
  }
  return [...new Set(names)];
}
