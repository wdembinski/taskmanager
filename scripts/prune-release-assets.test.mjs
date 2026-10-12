/**
 * `planPrune`'s decision, exercised without a GitHub token or a release ever existing — the
 * whole point of pulling it out of `prune-release-assets.mjs`'s GraphQL plumbing. See that
 * file's header for why the rule lives here rather than in the workflow YAML.
 *
 * Collected by the root `vitest.config.ts`, the same way `next-version.test.mjs` is — see
 * that config's header for why a bare `.mjs` suite needs no entry of its own.
 */
import { describe, expect, it } from 'vitest';
import { planPrune } from './prune-release-assets.mjs';

describe('planPrune', () => {
  it('leaves the kept tag untouched', () => {
    const releases = [
      { tag: 'v0.120.0', assets: ['VIPPER-Task-Manager-Setup-0.120.0.exe', 'latest.yml'] },
    ];
    expect(planPrune(releases, 'v0.120.0')).toEqual([]);
  });

  it('prunes a draft release just like a published one', () => {
    const releases = [
      { tag: 'v0.119.0', isDraft: true, assets: ['claude-orchestrator-0.119.0.AppImage'] },
    ];
    expect(planPrune(releases, 'v0.120.0')).toEqual([
      { tag: 'v0.119.0', asset: 'claude-orchestrator-0.119.0.AppImage' },
    ]);
  });

  it('ignores a release with no assets', () => {
    const releases = [{ tag: 'v0.118.0', assets: [] }];
    expect(planPrune(releases, 'v0.120.0')).toEqual([]);
  });

  it('is empty for an empty release list', () => {
    expect(planPrune([], 'v0.120.0')).toEqual([]);
  });

  it('pairs every asset of every non-kept release', () => {
    const releases = [
      { tag: 'v0.120.0', assets: ['keep-me.exe'] },
      { tag: 'v0.119.0', assets: ['old-setup.exe', 'latest.yml'] },
      { tag: 'v0.118.0', assets: ['older.AppImage'] },
    ];
    expect(planPrune(releases, 'v0.120.0')).toEqual([
      { tag: 'v0.119.0', asset: 'old-setup.exe' },
      { tag: 'v0.119.0', asset: 'latest.yml' },
      { tag: 'v0.118.0', asset: 'older.AppImage' },
    ]);
  });
});
