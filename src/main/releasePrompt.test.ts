import { describe, expect, it } from 'vitest';
import { buildReleasePrompt } from './releasePrompt';

const base = {
  cardTitle: 'Fix the export dialog',
  branch: 'feat/export-dialog',
  base: 'development',
  releaseDoc: 'RELEASE.md',
};

describe('buildReleasePrompt', () => {
  it('says the work is merged and this turn is the release, not the work', () => {
    const prompt = buildReleasePrompt(base);
    expect(prompt).toContain('feat/export-dialog');
    expect(prompt).toContain('development');
    expect(prompt).toMatch(/this turn is the RELEASE/i);
  });

  it('points at the repo’s own instructions rather than describing a release', () => {
    const prompt = buildReleasePrompt(base);
    expect(prompt).toContain('RELEASE.md');
    expect(prompt).toMatch(/follow it exactly/i);
    // The one thing this prompt must never do is invent a recipe of its own.
    expect(prompt).not.toMatch(/npm publish|git tag -a|gh release/i);
  });

  it('tells the agent to check out base first when the merge only moved the ref', () => {
    const prompt = buildReleasePrompt({ ...base, refMoveOnly: true });
    expect(prompt).toMatch(/only moved the `development` ref/);
    expect(prompt).toMatch(/Check out `development` first/);
    // …and, when the tree is dirty, to ask rather than to tidy someone else's work away.
    expect(prompt).toMatch(/stop and ask/);
  });

  it('says where the code is when the checkout IS on base', () => {
    const prompt = buildReleasePrompt(base);
    expect(prompt).toMatch(/main checkout, which is on `development`/);
    expect(prompt).not.toMatch(/only moved/);
  });

  it('carries the project’s standing instructions, and omits the section without them', () => {
    expect(
      buildReleasePrompt({ ...base, instructions: 'Source oe-init-build-env first.' }),
    ).toContain('Source oe-init-build-env first.');
    expect(buildReleasePrompt({ ...base, instructions: '   ' })).not.toContain(
      'Standing instructions',
    );
  });

  it('makes a failing gate end the release rather than be worked around', () => {
    const prompt = buildReleasePrompt(base);
    expect(prompt).toMatch(/failing[\s\S]*gate ENDS the release/);
  });

  // The rule the feature turned out to need: four green releases piled up unpublished,
  // each one waiting on a platform build that was never going to happen unattended.
  it('requires an automatic release to end published, not as a draft', () => {
    const prompt = buildReleasePrompt(base);
    expect(prompt).toMatch(/Finish it/);
    expect(prompt).toMatch(/a draft[\s\S]*is NOT a complete outcome/);
    expect(prompt).toMatch(/publish it/i);
  });

  // ...without turning "publish" into "publish over a red gate".
  it('still lets a gate or a missing approval stop it short of publishing', () => {
    const prompt = buildReleasePrompt(base);
    expect(prompt).toMatch(/Gates and[\s\S]*missing approvals are the only things that may stop you/);
  });

  // Rule 4 of the repo's own file: uploads cannot go into a published release.
  it('keeps promotion last even while insisting on it', () => {
    expect(buildReleasePrompt(base)).toMatch(/Publishing LAST is still right/);
  });
});
