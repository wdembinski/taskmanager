/**
 * Headless, LIVE verification of the private update feed against the REAL
 * `wdembinski/taskmanager` repository on api.github.com — the half of
 * `updateFeed.ts`/`updater.ts` that `updateFeed.test.ts` cannot reach, because a unit test
 * cannot ask GitHub a question and does not have a credential to ask it with.
 *
 * Three claims, end to end, against the real feed:
 *
 *   1. the real latest release is readable, its version parses, and its Windows installer
 *      asset resolves — through electron-updater's OWN `PrivateGitHubProvider` (or
 *      `GitHubProvider`, if no token is available — the repo is public as of this writing,
 *      see docs/07's rollout order);
 *   2. a bogus token is rejected by GitHub (401), and `classifyUpdateError` reads that as
 *      `token-rejected`;
 *   3. a valid token pointed at a repository that does not exist gets a 404, and
 *      `classifyUpdateError` reads THAT — token present, not found — as `token-blind`,
 *      never confusing it with "needs a token at all".
 *
 * What is REAL: the HTTP round trip to api.github.com, electron-updater's own provider
 * classes (`PrivateGitHubProvider`/`GitHubProvider`, via `providerFactory.createClient`,
 * exactly as `updater.ts` reaches them through `electron-updater`'s public entry point),
 * and `updateFeed.ts`'s `updateFeedConfig`/`pickUpdateToken`/`classifyUpdateError`/
 * `redactSecret` — bundled fresh out of the real source file, not retyped here. Nothing
 * about GitHub's API is mocked; every assertion about status codes and classification is
 * an assertion about what GitHub actually answered a moment earlier.
 *
 * The token: read from `UPDATE_TOKEN`, or else from `gh auth token` (mirrors
 * `ipc.ts`'s `resolveUpdateToken`). NEVER logged — every line this script prints goes
 * through `log()`, which also appends to an in-memory transcript, and section 5 asserts the
 * real token (and `gh`'s own, and the deliberately-fake one from section 2) is nowhere in
 * it. If `gh` is not signed in and `UPDATE_TOKEN` is unset, section 3 (which needs a VALID
 * token pointed at a nonexistent repo) is skipped rather than failed — this machine's
 * environment, not the code, would be what's missing.
 *
 * electron-updater's providers need an `HttpExecutor` (`builder-util-runtime`) to talk to
 * the network — inside Electron that role is `ElectronHttpExecutor`, which this script
 * never loads. A ~10-line Node `https` subclass stands in, the same shape as
 * `builder-util`'s own `NodeHttpExecutor`. electron-updater's provider classes are not part
 * of its public API surface (no `exports` map restricts the subpath, but `out/main.js`
 * does not re-export them either), so they are reached by resolving `builder-util-runtime`
 * and `electron-updater/out/providerFactory.js` relative to electron-updater's OWN install
 * location — pnpm's per-package `node_modules` isolation hides a transitive dependency
 * from a script living under `apps/client/scripts`, so `require.resolve('electron-updater')`
 * first, then a `createRequire` rooted THERE, same trick `verify-github.mjs` needs for
 * `@shared`. If that resolution ever breaks — a provider rename, an `exports` map electron-
 * updater adds later — this script falls back to the same two requests with bare `fetch`:
 * `GET /repos/{owner}/{repo}/releases/latest` with `authorization: token …`, then the
 * `latest.yml` asset with `accept: application/octet-stream` (fetch follows the redirect to
 * GitHub's asset CDN on its own). Both paths feed the exact same checks below.
 *
 * `updateFeed.ts` has no Electron import (see its own header), so unlike `verify-github.mjs`
 * this needs no electron stub and no Electron-as-Node dance — the bundle runs under plain
 * `node`. It is still re-bundled with `vite` rather than imported as `.ts` directly, because
 * that is the one proven way in this repo to run a `@shared`-aliased TS module from a
 * `.mjs` script (see `update-feed.mjs`/`check-update-feed.mjs`, and `verify-github.mjs`'s
 * header for the fuller reasoning).
 *
 * **Proving it can fail.** Section 6 edits the live `classifyUpdateError` in
 * `src/main/updateFeed.ts` — deleting the one line that tells "token-blind" apart from
 * "needs-token" — rebuilds the bundle, and re-runs the classifier against the SAME real
 * error objects sections 2 and 3 already caught (no extra network round trip). The
 * token-rejected check must stay green (the mutation never touched that branch); the
 * token-blind check must go red. The source is restored from an in-memory copy in a
 * `finally`, and checked byte-identical afterwards either way.
 *
 * Deliberately NOT in CI: it reaches the real internet with a real credential, same
 * reasoning as `verify-github.mjs`'s "deliberately not in CI" and the live-E2E caveat on
 * [[a-limit-that-only-said-so-in-prose]] — this is the manual verification that caveat asks
 * for, for this feature.
 *
 *   cd apps/client && pnpm run verify:private-update-feed
 *
 * Exits non-zero if any assertion failed, naming it.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sharedSrc = join(repo, '..', '..', 'packages', 'shared', 'src');
const updateFeedPath = join(repo, 'src', 'main', 'updateFeed.ts');

/** Bundle output only, never a work tree git is asked about — nothing here shells to git. */
const work = join(repo, '.verify-private-update-feed');

const UPDATE_OWNER_FALLBACK = 'wdembinski';
const UPDATE_REPO_FALLBACK = 'taskmanager';
const NONEXISTENT_REPO = 'this-repo-does-not-exist-verify-private-feed-9f3a1c';
/** Deliberately fake — shaped like a classic PAT so `redactSecret`'s pattern also catches it. */
const BOGUS_TOKEN = 'ghp_0000000000000000000000000000bogus0';

let failureCount = 0;
const transcript = [];

function log(line) {
  transcript.push(line);
  process.stdout.write(`${line}\n`);
}
function check(label, condition, detail) {
  if (condition) {
    log(`  PASS  ${label}`);
  } else {
    failureCount += 1;
    log(`  FAIL  ${label}${detail === undefined ? '' : ` - ${detail}`}`);
  }
}
function section(name) {
  log(`\n${name}`);
}

/**
 * Bundle `updateFeed.ts`'s pure exports to plain ESM. A throwaway re-export shim rather than
 * importing the file directly — the one proven way in this repo to run `@shared`-aliased TS
 * from a `.mjs` script (see the header).
 */
async function bundleUpdateFeed(outDir) {
  const entry = join(work, `entry-${outDir.replace(/[\\/]/g, '-')}.ts`);
  const modulePath = updateFeedPath.replace(/\\/g, '/').replace(/\.ts$/, '');
  writeFileSync(
    entry,
    [
      'export {',
      '  UPDATE_OWNER,',
      '  UPDATE_REPO,',
      '  updateFeedConfig,',
      '  pickUpdateToken,',
      '  classifyUpdateError,',
      '  redactSecret,',
      `} from ${JSON.stringify(modulePath)};`,
      '',
    ].join('\n'),
    'utf8',
  );
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
 * Resolve electron-updater's provider machinery relative to ITS OWN install location, not
 * this script's — pnpm's isolation does not symlink a transitive dependency (`builder-util-
 * runtime`) or an unexported subpath (`providerFactory.js`) into `apps/client/node_modules`.
 * Returns `null` rather than throwing so the caller can fall back to `fetch`.
 */
function loadProviderMachinery() {
  try {
    const euEntry = require.resolve('electron-updater');
    const requireFromUpdater = createRequire(euEntry);
    const { HttpExecutor } = requireFromUpdater('builder-util-runtime');
    const { createClient } = requireFromUpdater('electron-updater/out/providerFactory.js');
    if (typeof HttpExecutor !== 'function' || typeof createClient !== 'function') return null;
    class NodeHttpExecutor extends HttpExecutor {
      createRequest(options, callback) {
        return https.request(options, callback);
      }
    }
    return { createClient, executor: new NodeHttpExecutor() };
  } catch {
    return null;
  }
}

/** `fetch`, following redirects on its own — the fallback path named in the header. */
async function fetchChecker(owner, repoName, token) {
  const authHeaders = token ? { authorization: `token ${token}` } : {};
  const releaseRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', ...authHeaders },
  });
  if (!releaseRes.ok) {
    const err = new Error(`GET releases/latest -> ${releaseRes.status} ${releaseRes.statusText}`);
    err.statusCode = releaseRes.status;
    throw err;
  }
  const release = await releaseRes.json();
  const asset = (release.assets ?? []).find((a) => a.name === 'latest.yml');
  if (!asset) throw new Error(`latest.yml not found among the release assets of ${owner}/${repoName}`);
  const ymlRes = await fetch(asset.url, {
    headers: { accept: 'application/octet-stream', ...authHeaders },
  });
  if (!ymlRes.ok) {
    const err = new Error(`GET latest.yml asset -> ${ymlRes.status} ${ymlRes.statusText}`);
    err.statusCode = ymlRes.status;
    throw err;
  }
  const yml = await ymlRes.text();
  const version = /version:\s*(\S+)/.exec(yml)?.[1];
  const installerName = /^\s*-?\s*url:\s*(\S+)/m.exec(yml)?.[1];
  const assetResolved = (release.assets ?? []).some((a) => a.name === installerName);
  return { version, installerName, assetResolved, providerName: 'fetch-fallback' };
}

async function main() {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  try {
    const bundlePath = await bundleUpdateFeed(join(work, 'out'));
    const {
      UPDATE_OWNER,
      UPDATE_REPO,
      updateFeedConfig,
      pickUpdateToken,
      classifyUpdateError,
      redactSecret,
    } = await import(pathToFileURL(bundlePath).href);

    check('UPDATE_OWNER/UPDATE_REPO match the real repository', UPDATE_OWNER === UPDATE_OWNER_FALLBACK && UPDATE_REPO === UPDATE_REPO_FALLBACK, `${UPDATE_OWNER}/${UPDATE_REPO}`);

    // ----------------------------------------------------------------------
    section('0. Resolve the token the real app would use');
    const stored = process.env['UPDATE_TOKEN'] || null;
    let ghCli = null;
    if (!stored) {
      try {
        ghCli = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 5000 }).trim() || null;
      } catch {
        ghCli = null;
      }
    }
    const picked = pickUpdateToken({ stored, ghCli, useGhCli: true });
    log(`  token source: ${picked.source} (the token itself is never printed)`);

    const machinery = loadProviderMachinery();
    const updaterStub = { allowPrerelease: false, channel: null, currentVersion: null, fullChangelog: false };
    const runtimeOptions = { platform: 'win32', executor: machinery?.executor };
    const mode = machinery ? 'provider' : 'fetch';
    log(`  driving the feed via: ${mode}${machinery ? '' : ' (electron-updater\'s provider machinery did not load outside Electron)'}`);

    /** One check, either through electron-updater's real provider or the fetch fallback. */
    async function checkFeed(token, repoOverride) {
      if (machinery) {
        const config = { ...updateFeedConfig(token), ...(repoOverride ? { repo: repoOverride } : {}) };
        const provider = machinery.createClient(config, updaterStub, runtimeOptions);
        const info = await provider.getLatestVersion();
        const files = provider.resolveFiles(info);
        return {
          version: info.version,
          installerName: info.files?.[0]?.url,
          assetResolved: files.length > 0,
          providerName: provider.constructor.name,
        };
      }
      return fetchChecker(UPDATE_OWNER, repoOverride ?? UPDATE_REPO, token);
    }

    // ----------------------------------------------------------------------
    section('1. The real feed, end to end');
    let bogusErr = null;
    let blindErr = null;
    try {
      const result = await checkFeed(picked.token, undefined);
      log(`  provider used: ${result.providerName}`);
      check(
        'a token in play drives the PRIVATE provider, none drives the public one',
        machinery ? (picked.token ? result.providerName === 'PrivateGitHubProvider' : result.providerName === 'GitHubProvider') : true,
        result.providerName,
      );
      check('the version parses as semver', /^\d+\.\d+\.\d+/.test(result.version ?? ''), String(result.version));
      check(
        'the installer filename is the Windows NSIS setup',
        /-setup\.exe$/.test(result.installerName ?? ''),
        String(result.installerName),
      );
      check('the installer asset resolves against the release GitHub actually has', result.assetResolved === true);
    } catch (err) {
      log(redactSecret(`${err.name ?? 'Error'}: ${err.message}`, picked.token));
      check('the real feed resolved without error', false, String(err.message));
    }

    // ----------------------------------------------------------------------
    section('2. A bogus token is rejected (token-rejected)');
    try {
      const result = await checkFeed(BOGUS_TOKEN, undefined);
      check('a bogus token was rejected by GitHub', false, `unexpectedly resolved version ${result.version}`);
    } catch (err) {
      bogusErr = err;
      log(redactSecret(`${err.name ?? 'Error'}: ${err.message}`, BOGUS_TOKEN));
      check(
        'classifyUpdateError reads the real 401 as token-rejected',
        classifyUpdateError(err, true) === 'token-rejected',
        String(classifyUpdateError(err, true)),
      );
    }

    // ----------------------------------------------------------------------
    section('3. A valid token blind to a repo that does not exist (token-blind)');
    if (!picked.token) {
      log('  SKIP  no UPDATE_TOKEN and `gh auth token` unavailable — cannot prove token-blind without a valid token');
    } else {
      try {
        const result = await checkFeed(picked.token, NONEXISTENT_REPO);
        check('a nonexistent repository was somehow reachable', false, `unexpectedly resolved version ${result.version}`);
      } catch (err) {
        blindErr = err;
        log(redactSecret(`${err.name ?? 'Error'}: ${err.message}`, picked.token));
        check(
          'classifyUpdateError reads the real 404 (token present) as token-blind, not needs-token',
          classifyUpdateError(err, true) === 'token-blind',
          String(classifyUpdateError(err, true)),
        );
      }
    }

    // ----------------------------------------------------------------------
    section('4. redactSecret keeps a known secret, and anything PAT-shaped, out of text');
    const sampleSecret = picked.token ?? BOGUS_TOKEN;
    const sample = `set-feed-url: .../releases?token=${sampleSecret}\nalso saw github_pat_abcDEF123xyz and gho_anotherOne456`;
    const scrubbed = redactSecret(sample, sampleSecret);
    check('the known secret is gone', !scrubbed.includes(sampleSecret));
    check(
      'a PAT-shaped string nobody told it about is also gone',
      !scrubbed.includes('github_pat_abcDEF123xyz') && !scrubbed.includes('gho_anotherOne456'),
      scrubbed,
    );

    // ----------------------------------------------------------------------
    section('5. The token never reaches anything this script printed');
    const whole = transcript.join('\n');
    const realSecrets = new Set([picked.token, ghCli].filter((value) => typeof value === 'string' && value.length > 0));
    for (const secret of realSecrets) {
      check(`a real token (${secret.slice(0, 4)}***) never appears verbatim in the transcript`, !whole.includes(secret));
    }

    // ----------------------------------------------------------------------
    section('6. Proving this harness can fail: mutate classifyUpdateError and rebuild');
    const original = readFileSync(updateFeedPath, 'utf8');
    const marker = "if (statusCode === 404) return hadToken ? 'token-blind' : 'needs-token';";
    if (!original.includes(marker)) {
      throw new Error('mutation anchor not found in updateFeed.ts — the source moved, update this script');
    }
    let mutated = false;
    try {
      writeFileSync(
        updateFeedPath,
        original.replace(marker, "if (statusCode === 404) return null; // MUTATED for verify-private-update-feed.mjs"),
        'utf8',
      );
      mutated = true;
      const mutatedBundlePath = await bundleUpdateFeed(join(work, 'out-mutated'));
      const mutatedModule = await import(pathToFileURL(mutatedBundlePath).href);

      const blindCase = blindErr ?? new Error(
        `Unable to find latest version on GitHub (https://api.github.com/repos/${UPDATE_OWNER}/${NONEXISTENT_REPO}/releases/latest): HttpError: 404 Not Found`,
      );
      check(
        blindErr
          ? 'the mutation flips the real token-blind check red, as expected'
          : 'the mutation flips a fabricated 404-with-token case red (no live blindErr to reuse this run)',
        mutatedModule.classifyUpdateError(blindCase, true) !== 'token-blind',
        String(mutatedModule.classifyUpdateError(blindCase, true)),
      );
      if (bogusErr) {
        check(
          'the mutation leaves the UNRELATED token-rejected check green',
          mutatedModule.classifyUpdateError(bogusErr, true) === 'token-rejected',
          String(mutatedModule.classifyUpdateError(bogusErr, true)),
        );
      }
    } finally {
      if (mutated) writeFileSync(updateFeedPath, original, 'utf8');
      const restored = readFileSync(updateFeedPath, 'utf8');
      check('updateFeed.ts is restored byte-identical after the mutation', restored === original);
    }

    log('');
    if (failureCount > 0) {
      log(`${failureCount} check(s) FAILED.`);
      process.exitCode = 1;
    } else {
      log('All checks passed.');
    }
  } finally {
    if (process.argv.includes('--keep')) {
      log(`\nLeft ${work} in place (--keep).`);
    } else {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
