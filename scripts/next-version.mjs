/**
 * Work out which version the next release is — the one piece of logic the release
 * workflow would otherwise have to express in YAML.
 *
 * It lives here, in a file with a unit test beside it, because version arithmetic in a
 * workflow is arithmetic nobody can run before pushing. A wrong `${{ }}` expression is
 * only ever discovered by tagging the wrong thing, and a tag that has been pushed is not
 * something this project moves (CONTRIBUTING.md §4). So the YAML calls this and reads
 * three outputs; every decision it could get wrong is made — and tested — in here.
 *
 * ## The rule
 *
 * `apps/client/package.json`'s `version` is the version of record (CONTRIBUTING.md §4,
 * guarded by `test/repo-invariants.test.ts`), and the house rule is that the bump rides
 * inside the commit that ships the change. So most of the time the branch being released
 * has ALREADY named its version, and the release must use it as-is:
 *
 *   - manifest version is newer than every `v*` tag  →  use it, `needsCommit=false`
 *   - otherwise                                      →  patch-bump the highest RELEASED
 *                                                       version, `needsCommit=true`
 *
 * The second case is RELEASE.md §2's fallback ("if `version` is unchanged since the last
 * tag, bump it yourself and commit just that"), which this repo has had to reach for
 * several times — a merge that drops a branch's bump leaves the manifest at the version
 * already tagged, and a release must not overwrite a tag. Bumping the highest *tag* rather
 * than the manifest matters when the branch is behind: a manifest of 0.80.0 against tags
 * up to 0.82.6 must produce 0.82.7, never 0.80.1, which is already taken.
 *
 * ## Why the comparison is hand-rolled
 *
 * No `semver` dependency, and none is wanted: every version here is a bare `X.Y.Z` with no
 * pre-release or build metadata (the repo invariant test enforces exactly that), so the
 * whole comparison is three integer compares. What it must NOT be is a string compare —
 * `'0.8.0' > '0.82.6'` lexically, and both of those tags exist in this repo.
 *
 * ## Running it
 *
 *   node scripts/next-version.mjs
 *
 * Prints `version=`, `tag=` and `needsCommit=`, and appends the same three lines to
 * `$GITHUB_OUTPUT` when that is set — so it is both the workflow step and a local dry run
 * that tells you what a release would do right now, without doing any of it.
 *
 * Note for the caller: it reads tags from the local repo, so a CI checkout needs the tags
 * fetched (`fetch-depth: 0`, or an explicit `git fetch --tags`). A shallow checkout with no
 * tags is indistinguishable from a repo that has never released, and would happily hand
 * back the manifest version as-is.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A bare `X.Y.Z` — no `v`, no pre-release suffix. The only shape this project ships. */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Split a version into its three numbers, or null if it is not a bare `X.Y.Z`.
 *
 * Anything unparseable is null rather than an exception so that a stray tag — someone's
 * `v1.0.0-beta`, a `vipper-old` — is simply ignored by the callers below instead of
 * failing a release.
 *
 * @param {string} value
 * @returns {[number, number, number] | null}
 */
export function parseVersion(value) {
  const match = VERSION_PATTERN.exec(String(value ?? '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Compare two bare `X.Y.Z` versions numerically: negative if `a` is older, positive if `a`
 * is newer, 0 if they are the same version.
 *
 * Sorts as `Array.prototype.sort` wants, so `versions.sort(compareVersions)` is ascending.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left) throw new Error(`Not a bare X.Y.Z version: ${JSON.stringify(a)}`);
  if (!right) throw new Error(`Not a bare X.Y.Z version: ${JSON.stringify(b)}`);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/**
 * The version a `v*` tag names, or null if the tag does not name one.
 *
 * @param {string} tag e.g. `v0.82.6`
 * @returns {string | null} e.g. `0.82.6`
 */
export function tagVersion(tag) {
  const bare = String(tag ?? '')
    .trim()
    .replace(/^v/, '');
  return parseVersion(bare) ? bare : null;
}

/**
 * The newest version in a list, ignoring anything that is not a bare `X.Y.Z`.
 *
 * @param {string[]} versions
 * @returns {string | null} null when the list contains no usable version
 */
export function highestVersion(versions) {
  let highest = null;
  for (const version of versions) {
    if (!parseVersion(version)) continue;
    if (highest === null || compareVersions(version, highest) > 0) highest = version;
  }
  return highest;
}

/**
 * `X.Y.Z` → `X.Y.(Z+1)`.
 *
 * @param {string} version
 * @returns {string}
 */
export function bumpPatch(version) {
  const parts = parseVersion(version);
  if (!parts) throw new Error(`Not a bare X.Y.Z version: ${JSON.stringify(version)}`);
  const [major, minor, patch] = parts;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Decide the version the next release carries.
 *
 * @param {string} manifestVersion `version` from apps/client/package.json
 * @param {string[]} tags every tag in the repo; non-`vX.Y.Z` ones are ignored
 * @returns {{version: string, tag: string, needsCommit: boolean, released: string | null,
 *   reason: string}}
 *   `needsCommit` is true when the manifest does not already name `version` — i.e. the
 *   caller has to write it into apps/client/package.json and commit that before tagging.
 */
export function resolveNextVersion(manifestVersion, tags) {
  if (!parseVersion(manifestVersion)) {
    throw new Error(
      `apps/client/package.json version must be a bare X.Y.Z (CONTRIBUTING.md §4) — ` +
        `got ${JSON.stringify(manifestVersion)}`,
    );
  }

  const released = highestVersion((tags ?? []).map(tagVersion).filter((v) => v !== null));

  // Nothing released yet, or the branch already bumped past everything that has: the
  // manifest IS the answer and no second commit is needed.
  if (released === null || compareVersions(manifestVersion, released) > 0) {
    return {
      version: manifestVersion,
      tag: `v${manifestVersion}`,
      needsCommit: false,
      released,
      reason:
        released === null
          ? `no v* tag exists yet, so apps/client/package.json's ${manifestVersion} stands`
          : `apps/client/package.json already bumped to ${manifestVersion}, ahead of the ` +
            `highest tag v${released}`,
    };
  }

  // RELEASE.md §2's fallback. Bump the highest RELEASED version, not the manifest's — a
  // manifest left behind by a merge would otherwise produce a version that is already tagged.
  const version = bumpPatch(released);
  return {
    version,
    tag: `v${version}`,
    needsCommit: true,
    released,
    reason:
      `apps/client/package.json is at ${manifestVersion}, not ahead of the highest tag ` +
      `v${released}; patch-bumping to ${version}`,
  };
}

/** Every tag in the repo whose name starts with `v`. */
function readTags(repoRoot) {
  const out = execFileSync('git', ['tag', '--list', 'v*'], { cwd: repoRoot, encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** `version` from the manifest that is the version of record. */
function readManifestVersion(repoRoot) {
  const path = join(repoRoot, 'apps', 'client', 'package.json');
  return JSON.parse(readFileSync(path, 'utf8')).version;
}

// Only when run as a script. The test imports this module, and importing it must not shell
// out to git or write to anyone's $GITHUB_OUTPUT.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const result = resolveNextVersion(readManifestVersion(repoRoot), readTags(repoRoot));

  const lines = [
    `version=${result.version}`,
    `tag=${result.tag}`,
    `needsCommit=${result.needsCommit}`,
  ];

  // Printed either way: in a workflow this is the run log's record of WHY, which the
  // outputs alone never explain.
  console.log(lines.join('\n'));
  console.log(`# ${result.reason}`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  }
}
