import { describe, expect, it } from 'vitest';
import { buildChainHandbackPrompt, buildChainSummary, type ChainStepSummary } from './chainSummary';

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
});

describe('buildChainHandbackPrompt', () => {
  const prompt = buildChainHandbackPrompt('Add SSO', '- [x] **1. Add the auth guard**');

  it('carries the card and the summary', () => {
    expect(prompt).toContain('“Add SSO”');
    expect(prompt).toContain('Add the auth guard');
  });

  it('says the work is already done and this turn is a review', () => {
    // Without this a fresh agent handed a plan summary reads it as a BRIEF and starts
    // building the thing that was just built.
    // "already written", not "already merged": since Phase 17 the branch usually has NOT
    // been merged when the chain ends, and a prompt that says otherwise would have the
    // review agent looking for the work on the base branch.
    expect(prompt).toContain('already written');
    expect(prompt).toContain('not to implement anything');
    expect(prompt).toContain('Do not start new work unless they ask');
  });
});
