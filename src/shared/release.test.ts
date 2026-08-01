import { describe, expect, it } from 'vitest';
import { autoReleaseOn, RELEASE_DOC } from './release';

const project = (autoRelease: boolean): { autoRelease: boolean } => ({ autoRelease });

describe('autoReleaseOn', () => {
  it('follows the project when the card has said nothing', () => {
    expect(autoReleaseOn({ autoRelease: null }, project(true))).toBe(true);
    expect(autoReleaseOn({ autoRelease: null }, project(false))).toBe(false);
    // `undefined` is the same "has not ruled" — every card that predates the field.
    expect(autoReleaseOn({}, project(true))).toBe(true);
  });

  it('lets the card overrule its project in both directions', () => {
    expect(autoReleaseOn({ autoRelease: false }, project(true))).toBe(false);
    expect(autoReleaseOn({ autoRelease: true }, project(false))).toBe(true);
  });

  it('is off when there is no card and no project to ask', () => {
    expect(autoReleaseOn(null, null)).toBe(false);
    expect(autoReleaseOn(undefined, undefined)).toBe(false);
  });

  it('names the file the repo is expected to carry', () => {
    expect(RELEASE_DOC).toBe('RELEASE.md');
  });
});
