import { describe, expect, it } from 'vitest';
import { buildChainSummary, type ChainStepSummary } from './chainSummary';

const step = (over: Partial<ChainStepSummary> & { index: number }): ChainStepSummary => ({
  title: `Step ${over.index}`,
  status: 'done',
  outcome: '',
  ...over,
});

describe('buildChainSummary', () => {
  it('counts the steps and names the card', () => {
    const md = buildChainSummary('Add SSO', [step({ index: 1 }), step({ index: 2 })], null, null);
    expect(md).toContain('**Plan complete** — 2 of 2 steps finished on “Add SSO”.');
  });

  it('lists every step as a ticked checkbox with its outcome', () => {
    const md = buildChainSummary(
      'Add SSO',
      [
        step({ index: 1, title: 'Add the auth guard', outcome: 'Added the guard and its test.' }),
        step({ index: 2, title: 'Wire the callback', outcome: 'Wired /auth/callback.' }),
      ],
      null,
      null,
    );
    expect(md).toContain('- [x] **1. Add the auth guard**');
    expect(md).toContain('  Added the guard and its test.');
    expect(md).toContain('- [x] **2. Wire the callback**');
  });

  it('marks a step that did NOT finish, and says how it ended', () => {
    const md = buildChainSummary(
      'Add SSO',
      [step({ index: 1 }), step({ index: 2, status: 'failed' })],
      null,
      null,
    );
    expect(md).toContain('1 of 2 steps finished');
    expect(md).toContain('- [ ] **2. Step 2** _(failed)_');
  });

  it('keeps a step with no closing words instead of dropping it', () => {
    const md = buildChainSummary('Add SSO', [step({ index: 1, outcome: '   ' })], null, null);
    expect(md).toContain('- [x] **1. Step 1**');
  });

  it('takes the LAST paragraph of a chatty outcome — the conclusion, not the narration', () => {
    const md = buildChainSummary(
      'Add SSO',
      [
        step({
          index: 1,
          outcome:
            'First I read the router.\n\nThen I looked at the guard.\n\nAdded the guard; 4 tests pass.',
        }),
      ],
      null,
      null,
    );
    expect(md).toContain('Added the guard; 4 tests pass.');
    expect(md).not.toContain('First I read the router');
  });

  it('caps a runaway outcome', () => {
    const md = buildChainSummary('x', [step({ index: 1, outcome: 'y'.repeat(2000) })], null, null);
    expect(md).toContain('…');
    expect(md.length).toBeLessThan(1000);
  });

  it('names the merge when there was one, and stays quiet when there wasn’t', () => {
    expect(buildChainSummary('x', [step({ index: 1 })], 'wd/feat/abc-1/add-sso', 'main')).toContain(
      'Merged `wd/feat/abc-1/add-sso` into `main`.',
    );
    expect(buildChainSummary('x', [step({ index: 1 })], null, null)).not.toContain('Merged');
  });

  it('always says the card is still yours to close', () => {
    // The point of the whole phase: nothing auto-reaches Done.
    const md = buildChainSummary('x', [step({ index: 1 })], null, null);
    expect(md).toContain('still **In Progress**');
    expect(md).toContain('move it to Done yourself');
  });

  it('says something coherent for a plan with no steps', () => {
    const md = buildChainSummary('Add SSO', [], null, null);
    expect(md).toContain('0 of 0 steps');
    expect(md).toContain('no steps to run');
  });

  it('names the files the branch touched', () => {
    const md = buildChainSummary(
      'Add SSO',
      [step({ index: 1 })],
      'wd/feat/abc-1/add-sso',
      'main',
      true,
      ['src/auth/guard.ts', 'src/auth/callback.ts'],
    );
    expect(md).toContain('**Files touched:**');
    expect(md).toContain('`src/auth/guard.ts`');
    expect(md).toContain('`src/auth/callback.ts`');
  });

  it('says nothing about files when there are none to name', () => {
    const md = buildChainSummary('Add SSO', [step({ index: 1 })], null, null);
    expect(md).not.toContain('Files touched');
  });

  it('folds a long file list into "and N more" instead of listing every path', () => {
    const files = Array.from({ length: 25 }, (_, i) => `src/file-${i}.ts`);
    const md = buildChainSummary('Add SSO', [step({ index: 1 })], 'br', 'main', true, files);
    expect(md).toContain('`src/file-0.ts`');
    expect(md).toContain('and 5 more');
    expect(md).not.toContain('`src/file-24.ts`');
  });
});
