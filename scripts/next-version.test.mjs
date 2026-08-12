/**
 * The release workflow's version arithmetic, exercised without a release.
 *
 * This is the whole point of `next-version.mjs` being a script rather than a YAML
 * expression: the two decisions that matter — "the branch already bumped, use it as-is" and
 * "nothing bumped, fall back to a patch on the highest tag" — are the ones a workflow can
 * only get wrong in production, on a tag this project will not move.
 *
 * Collected by the root `vitest.config.ts`, which sets no `include` and so picks up
 * vitest's default glob. `apps/client/scripts/native-abi.test.mjs` and `update-feed.test.mjs`
 * are `.mjs` suites on the same footing — no config change needed for either.
 */
import { describe, expect, it } from 'vitest';
import {
  bumpPatch,
  compareVersions,
  highestVersion,
  parseVersion,
  resolveNextVersion,
  tagVersion,
} from './next-version.mjs';

/** A slice of this repo's real tag list, in the arbitrary order `git tag --list` prints. */
const TAGS = ['v0.74.3', 'v0.78.7', 'v0.78.14', 'v0.8.0', 'v0.80.2', 'v0.81.0', 'v0.82.6'];

describe('parseVersion', () => {
  it('splits a bare X.Y.Z into numbers', () => {
    expect(parseVersion('0.82.6')).toEqual([0, 82, 6]);
    expect(parseVersion('10.0.123')).toEqual([10, 0, 123]);
  });

  it('tolerates surrounding whitespace, the way a git tag listing arrives', () => {
    expect(parseVersion('  1.2.3\n')).toEqual([1, 2, 3]);
  });

  it('rejects anything that is not a bare X.Y.Z', () => {
    for (const value of ['v1.2.3', '1.2', '1.2.3.4', '1.2.3-rc1', '1.2.x', '', null, undefined]) {
      expect(parseVersion(value), `expected ${JSON.stringify(value)} to be rejected`).toBeNull();
    }
  });
});

describe('compareVersions', () => {
  it('compares numerically, not lexically — the trap a string sort walks into', () => {
    // Both of these tags exist in this repo, and '0.8.0' > '0.82.6' as strings.
    expect(compareVersions('0.82.6', '0.8.0')).toBeGreaterThan(0);
    expect(compareVersions('0.8.0', '0.82.6')).toBeLessThan(0);
    expect(compareVersions('0.78.14', '0.78.7')).toBeGreaterThan(0);
  });

  it('orders by major, then minor, then patch', () => {
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.3.0', '0.2.99')).toBeGreaterThan(0);
    expect(compareVersions('0.3.1', '0.3.0')).toBeGreaterThan(0);
  });

  it('is 0 for the same version', () => {
    expect(compareVersions('0.82.6', '0.82.6')).toBe(0);
  });

  it('sorts a list ascending when handed to Array#sort', () => {
    // 0.8.0 first: minor 8 is older than minor 78, however the strings sort.
    expect(['0.8.0', '0.82.6', '0.78.14', '0.78.7'].sort(compareVersions)).toEqual([
      '0.8.0',
      '0.78.7',
      '0.78.14',
      '0.82.6',
    ]);
  });

  it('refuses to guess at an unparseable version', () => {
    expect(() => compareVersions('v1.2.3', '1.2.3')).toThrow(/bare X\.Y\.Z/);
    expect(() => compareVersions('1.2.3', '1.2')).toThrow(/bare X\.Y\.Z/);
  });
});

describe('tagVersion', () => {
  it('strips the leading v the tag name carries', () => {
    expect(tagVersion('v0.82.6')).toBe('0.82.6');
  });

  it('ignores a tag that does not name a bare version', () => {
    expect(tagVersion('v1.0.0-beta')).toBeNull();
    expect(tagVersion('development')).toBeNull();
    expect(tagVersion('v1.2')).toBeNull();
  });
});

describe('highestVersion', () => {
  it('finds the newest of an unordered list', () => {
    expect(highestVersion(TAGS.map(tagVersion))).toBe('0.82.6');
  });

  it('skips entries it cannot parse', () => {
    expect(highestVersion(['0.1.0', null, 'nightly', '0.2.0'])).toBe('0.2.0');
  });

  it('is null when nothing is usable', () => {
    expect(highestVersion([])).toBeNull();
    expect(highestVersion(['nightly', null])).toBeNull();
  });
});

describe('bumpPatch', () => {
  it('adds one to the patch and leaves the rest alone', () => {
    expect(bumpPatch('0.82.6')).toBe('0.82.7');
    expect(bumpPatch('0.82.9')).toBe('0.82.10');
    expect(bumpPatch('1.0.0')).toBe('1.0.1');
  });

  it('refuses an unparseable version', () => {
    expect(() => bumpPatch('v0.82.6')).toThrow(/bare X\.Y\.Z/);
  });
});

describe('resolveNextVersion', () => {
  it('reuses the branch bump when the manifest is ahead of every tag', () => {
    const result = resolveNextVersion('0.83.0', TAGS);
    expect(result.version).toBe('0.83.0');
    expect(result.tag).toBe('v0.83.0');
    expect(result.needsCommit).toBe(false);
  });

  it('reuses a MINOR bump, not just a patch one — a feat: range bumps minor', () => {
    expect(resolveNextVersion('0.90.0', TAGS)).toMatchObject({
      version: '0.90.0',
      needsCommit: false,
    });
  });

  it('patch-bumps when the manifest names the version already tagged', () => {
    // The commonest failure this repo has hit: a merge drops the branch's bump, so the
    // manifest still names the released version. RELEASE.md §2's fallback.
    const result = resolveNextVersion('0.82.6', TAGS);
    expect(result.version).toBe('0.82.7');
    expect(result.tag).toBe('v0.82.7');
    expect(result.needsCommit).toBe(true);
  });

  it('bumps the highest TAG, not the manifest, when the branch is behind', () => {
    // 0.80.1 is already released; bumping the manifest would collide with it.
    expect(resolveNextVersion('0.80.0', TAGS)).toMatchObject({
      version: '0.82.7',
      needsCommit: true,
    });
  });

  it('never proposes a version that is already tagged', () => {
    const released = new Set(TAGS);
    for (const manifest of ['0.74.3', '0.8.0', '0.80.2', '0.82.6', '0.78.7']) {
      expect(released.has(resolveNextVersion(manifest, TAGS).tag)).toBe(false);
    }
  });

  it('takes the manifest as-is when nothing has ever been released', () => {
    expect(resolveNextVersion('0.1.0', [])).toMatchObject({
      version: '0.1.0',
      tag: 'v0.1.0',
      needsCommit: false,
      released: null,
    });
  });

  it('ignores tags that are not releases', () => {
    expect(resolveNextVersion('0.82.6', ['v0.82.6', 'v9.9.9-rc1', 'vnext'])).toMatchObject({
      version: '0.82.7',
      released: '0.82.6',
    });
  });

  it('reports which released version it compared against', () => {
    expect(resolveNextVersion('0.83.0', TAGS).released).toBe('0.82.6');
  });

  it('explains itself, so the workflow log says why and not just what', () => {
    expect(resolveNextVersion('0.83.0', TAGS).reason).toContain('0.83.0');
    expect(resolveNextVersion('0.82.6', TAGS).reason).toContain('0.82.7');
  });

  it('refuses a manifest version that is not a bare X.Y.Z', () => {
    // test/repo-invariants.test.ts guards this too; failing loudly here means a release
    // stops before it tags something like `vv1.2.3`.
    expect(() => resolveNextVersion('v0.82.6', TAGS)).toThrow(/CONTRIBUTING\.md/);
    expect(() => resolveNextVersion('0.82.6-rc1', TAGS)).toThrow(/bare X\.Y\.Z/);
  });
});
