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
 * guarded by `test/repo-invariants.test.ts`). Branches no longer carry their own bump — CI
 * derives it from the commits since the last release, so most of the time the manifest is
 * still at the released version and this script has to pick the bump itself:
 *
 *   - manifest version is newer than every `v*` tag  →  use it, `needsCommit=false`
 *     (the deliberate escape hatch for a manual bump, e.g. jumping to `1.0.0`)
 *   - otherwise                                      →  bump the highest RELEASED version,
 *                                                       `needsCommit=true`
 *
 * The bump itself is MINOR when any commit since that release is a `feat` or marks a
 * breaking change, PATCH otherwise — see `classifyBump`. Pre-1.0, a breaking change still
 * only bumps MINOR, never MAJOR; MAJOR stays a manual manifest edit, same as the escape
 * hatch above.
 *
 * The non-ahead case is RELEASE.md §2's fallback, which this repo has had to reach for
 * several times — a merge that drops a branch's bump leaves the manifest at the version
 * already tagged, and a release must not overwrite a tag. Bumping the highest *tag* rather
 * than the manifest matters when the branch is behind: a manifest of 0.80.0 against tags
 * up to 0.82.6 must produce 0.82.7 (or 0.83.0, if a `feat` shipped), never 0.80.1, which is
 * already taken.
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
 * `X.Y.Z` → `X.(Y+1).0`.
 *
 * @param {string} version
 * @returns {string}
 */
export function bumpMinor(version) {
  const parts = parseVersion(version);
  if (!parts) throw new Error(`Not a bare X.Y.Z version: ${JSON.stringify(version)}`);
  const [major, minor] = parts;
  return `${major}.${minor + 1}.0`;
}

/** A `feat` subject, scoped or not, breaking or not: `feat:`, `feat(db):`, `feat(db)!:`. */
const FEAT_SUBJECT_PATTERN = /^feat(\(.+\))?!?:/;
/** Any conventional-commit subject marked breaking with `!:`, regardless of type. */
const BREAKING_SUBJECT_PATTERN = /^\w+(\(.+\))?!:/;
/** The conventional-commit breaking-change footer, anywhere in the body. */
const BREAKING_FOOTER_PATTERN = /BREAKING CHANGE:/;
/** The release workflow's own bump commit — never itself a reason to bump again. */
const CHORE_RELEASE_SUBJECT_PATTERN = /^chore\(release\):/;

/**
 * The subject of the first commit that would decide a MINOR bump, or null if none does.
 * Shared by `classifyBump` (the verdict) and `resolveNextVersion` (the reason it names).
 *
 * @param {string[]} subjects
 * @param {string[]} bodies
 * @returns {string | null}
 */
function decidingSubject(subjects, bodies) {
  for (let i = 0; i < subjects.length; i += 1) {
    const subject = String(subjects[i] ?? '');
    if (CHORE_RELEASE_SUBJECT_PATTERN.test(subject)) continue;
    if (FEAT_SUBJECT_PATTERN.test(subject) || BREAKING_SUBJECT_PATTERN.test(subject)) {
      return subject;
    }
    if (BREAKING_FOOTER_PATTERN.test(String(bodies[i] ?? ''))) return subject;
  }
  return null;
}

/**
 * Classify a commit range as a MINOR or PATCH bump: MINOR for any `feat` subject or any
 * breaking-change marker (`!:` in the subject, `BREAKING CHANGE:` in the body); PATCH for
 * everything else. `chore(release):` commits — the release workflow's own bump commits —
 * never decide either way.
 *
 * Pre-1.0, a breaking change still only bumps MINOR, never MAJOR — MAJOR stays a deliberate
 * manifest edit (see `resolveNextVersion`'s manifest-ahead case).
 *
 * @param {string[]} subjects one commit subject per entry
 * @param {string[]} bodies the matching commit body, same index as `subjects`
 * @returns {'minor' | 'patch'}
 */
export function classifyBump(subjects, bodies) {
  return decidingSubject(subjects, bodies) === null ? 'patch' : 'minor';
}

/**
 * Decide the version the next release carries.
 *
 * @param {string} manifestVersion `version` from apps/client/package.json
 * @param {string[]} tags every tag in the repo; non-`vX.Y.Z` ones are ignored
 * @param {{subject: string, body: string}[]} commits commits since the highest released
 *   tag, oldest or newest first (order does not matter) — only consulted when the manifest
 *   is not already ahead of every tag
 * @returns {{version: string, tag: string, needsCommit: boolean, released: string | null,
 *   reason: string}}
 *   `needsCommit` is true when the manifest does not already name `version` — i.e. the
 *   caller has to write it into apps/client/package.json and commit that before tagging.
 */
export function resolveNextVersion(manifestVersion, tags, commits = []) {
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
  const subjects = commits.map((commit) => commit.subject ?? '');
  const bodies = commits.map((commit) => commit.body ?? '');
  const bump = classifyBump(subjects, bodies);
  const version = bump === 'minor' ? bumpMinor(released) : bumpPatch(released);
  const decided = bump === 'minor' ? decidingSubject(subjects, bodies) : null;

  return {
    version,
    tag: `v${version}`,
    needsCommit: true,
    released,
    reason:
      decided === null
        ? `apps/client/package.json is at ${manifestVersion}, not ahead of the highest tag ` +
          `v${released}; patch-bumping to ${version}`
        : `apps/client/package.json is at ${manifestVersion}, not ahead of the highest tag ` +
          `v${released}; "${decided}" bumps MINOR to ${version}`,
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

/** Field and record separators that cannot appear in a commit subject or body. */
const FIELD_SEPARATOR = '\x1f';
const RECORD_SEPARATOR = '\x1e';

/**
 * Commits since the highest released version, as `classifyBump` reads them. Empty when
 * nothing has been released yet — the manifest-ahead case never consults them anyway.
 *
 * @param {string} repoRoot
 * @param {string | null} highestReleased e.g. `0.116.0`, or null when no `v*` tag exists
 * @returns {{subject: string, body: string}[]}
 */
function readCommits(repoRoot, highestReleased) {
  if (highestReleased === null) return [];
  const out = execFileSync(
    'git',
    ['log', `--format=%s${FIELD_SEPARATOR}%b${RECORD_SEPARATOR}`, `v${highestReleased}..HEAD`],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return out
    .split(RECORD_SEPARATOR)
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.length > 0)
    .map((record) => {
      const separatorAt = record.indexOf(FIELD_SEPARATOR);
      return { subject: record.slice(0, separatorAt), body: record.slice(separatorAt + 1) };
    });
}

// Only when run as a script. The test imports this module, and importing it must not shell
// out to git or write to anyone's $GITHUB_OUTPUT.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const tags = readTags(repoRoot);
  const highestReleased = highestVersion(tags.map(tagVersion).filter((v) => v !== null));
  const commits = readCommits(repoRoot, highestReleased);
  const result = resolveNextVersion(readManifestVersion(repoRoot), tags, commits);

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
