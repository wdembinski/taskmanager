import { describe, expect, it } from 'vitest';
import { RELEASE_DOC } from '@tm/shared/release';
import { autoCreatePrTooltip, autoMergeTooltip, autoReleaseTooltip } from './agentAutoToggles';

function expectClean(text: string): void {
  expect(text).not.toMatch(/  /);
  expect(text).toBe(text.trim());
}

describe('autoMergeTooltip', () => {
  it('leads with "on" and explains the auto-merge behavior', () => {
    const text = autoMergeTooltip({
      on: true,
      baseBranch: 'main',
      projectName: 'demo',
      inherited: false,
    });
    expect(text).toMatch(/^Merge when finished — on\./);
    expect(text).toContain('main');
    expectClean(text);
  });

  it('leads with "off" and points at the Merge button', () => {
    const text = autoMergeTooltip({
      on: false,
      baseBranch: 'main',
      projectName: 'demo',
      inherited: false,
    });
    expect(text).toMatch(/^Merge when finished — off\./);
    expect(text).toMatch(/merge with the button above/);
    expectClean(text);
  });

  it('adds the inherited-default clause only when off and the card is the exception', () => {
    const exception = autoMergeTooltip({
      on: false,
      baseBranch: 'main',
      projectName: 'demo',
      inherited: true,
    });
    expect(exception).toMatch(
      /demo merges automatically by default — this card is the exception\./,
    );
    expectClean(exception);

    const notInherited = autoMergeTooltip({
      on: false,
      baseBranch: 'main',
      projectName: 'demo',
      inherited: false,
    });
    expect(notInherited).not.toMatch(/exception/);
    expectClean(notInherited);

    const onInherited = autoMergeTooltip({
      on: true,
      baseBranch: 'main',
      projectName: 'demo',
      inherited: true,
    });
    expect(onInherited).not.toMatch(/exception/);
    expectClean(onInherited);
  });

  it('falls back to generic wording when projectName/baseBranch are missing', () => {
    const text = autoMergeTooltip({
      on: false,
      baseBranch: undefined,
      projectName: undefined,
      inherited: true,
    });
    expect(text).toMatch(
      /This repo merges automatically by default — this card is the exception\./,
    );
    expectClean(text);

    const onText = autoMergeTooltip({
      on: true,
      baseBranch: undefined,
      projectName: undefined,
      inherited: false,
    });
    expect(onText).toContain('the base branch');
    expectClean(onText);
  });
});

describe('autoCreatePrTooltip', () => {
  it('leads with "on" and explains the auto-PR behavior', () => {
    const text = autoCreatePrTooltip({
      on: true,
      prNoun: 'PR',
      projectName: 'demo',
      projectDefaultOn: false,
    });
    expect(text).toMatch(/^Open a PR when finished — on\./);
    expect(text).toMatch(/pushed/);
    expectClean(text);
  });

  it('leads with "off" and explains nothing is pushed', () => {
    const text = autoCreatePrTooltip({
      on: false,
      prNoun: 'PR',
      projectName: 'demo',
      projectDefaultOn: false,
    });
    expect(text).toMatch(/^Open a PR when finished — off\./);
    expect(text).toMatch(/nothing is pushed/);
    expectClean(text);
  });

  it('adds the project-default clause only when off and the project default is on', () => {
    const exception = autoCreatePrTooltip({
      on: false,
      prNoun: 'PR',
      projectName: 'demo',
      projectDefaultOn: true,
    });
    expect(exception).toMatch(/demo opens one by default — this card is the exception\./);
    expectClean(exception);

    const notDefault = autoCreatePrTooltip({
      on: false,
      prNoun: 'PR',
      projectName: 'demo',
      projectDefaultOn: false,
    });
    expect(notDefault).not.toMatch(/exception/);
    expectClean(notDefault);

    const onDefault = autoCreatePrTooltip({
      on: true,
      prNoun: 'PR',
      projectName: 'demo',
      projectDefaultOn: true,
    });
    expect(onDefault).not.toMatch(/exception/);
    expectClean(onDefault);
  });

  it('falls back to generic wording when projectName is missing', () => {
    const text = autoCreatePrTooltip({
      on: false,
      prNoun: 'PR',
      projectName: undefined,
      projectDefaultOn: true,
    });
    expect(text).toMatch(/This repo opens one by default — this card is the exception\./);
    expectClean(text);
  });

  it('uses the given noun in place of "PR"', () => {
    const text = autoCreatePrTooltip({
      on: true,
      prNoun: 'merge request',
      projectName: 'demo',
      projectDefaultOn: false,
    });
    expect(text).toMatch(/^Open a merge request when finished — on\./);
    expect(text).toMatch(/a merge request is opened/);
    expectClean(text);
  });
});

describe('autoReleaseTooltip', () => {
  it('leads with "on" and explains the release behavior', () => {
    const text = autoReleaseTooltip({ on: true, projectName: 'demo', hasReleaseDoc: true });
    expect(text).toMatch(/^Release after merge — on\./);
    expect(text).toContain(RELEASE_DOC);
    expectClean(text);
  });

  it('leads with "off" and explains the branch is left as-is', () => {
    const text = autoReleaseTooltip({ on: false, projectName: 'demo', hasReleaseDoc: true });
    expect(text).toMatch(/^Release after merge — off\./);
    expect(text).toMatch(/merged and left there\./);
    expectClean(text);
  });

  it('produces the "no RELEASE.md yet" sentence when hasReleaseDoc is false, regardless of on/off', () => {
    const off = autoReleaseTooltip({ on: false, projectName: 'demo', hasReleaseDoc: false });
    expect(off).toMatch(new RegExp(`demo has no ${RELEASE_DOC} yet, so nothing would run\\.`));
    expectClean(off);

    const on = autoReleaseTooltip({ on: true, projectName: 'demo', hasReleaseDoc: false });
    expect(on).toMatch(new RegExp(`demo has no ${RELEASE_DOC} yet, so nothing would run\\.`));
    expectClean(on);
  });

  it('falls back to generic wording when projectName is missing', () => {
    const text = autoReleaseTooltip({ on: false, projectName: undefined, hasReleaseDoc: false });
    expect(text).toMatch(new RegExp(`This repo has no ${RELEASE_DOC} yet`));
    expectClean(text);
  });

  it('does NOT produce the "no RELEASE.md yet" sentence while hasReleaseDoc is still loading (null)', () => {
    const off = autoReleaseTooltip({ on: false, projectName: 'demo', hasReleaseDoc: null });
    expect(off).not.toMatch(/no RELEASE\.md yet/);
    expect(off).toMatch(/merged and left there\./);
    expectClean(off);

    const on = autoReleaseTooltip({ on: true, projectName: 'demo', hasReleaseDoc: null });
    expect(on).not.toMatch(/no RELEASE\.md yet/);
    expect(on).toContain(RELEASE_DOC);
    expectClean(on);
  });
});
