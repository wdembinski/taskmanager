import { describe, expect, it } from 'vitest';
import { autoIntegrateOn, projectAutoIntegrate } from './integrate';

const app = (autoIntegrate: boolean): { autoIntegrate: boolean } => ({ autoIntegrate });
const repo = (autoIntegrate: boolean | null): { autoIntegrate: boolean | null } => ({
  autoIntegrate,
});

describe('projectAutoIntegrate', () => {
  it('follows the app-wide default when the project has said nothing', () => {
    expect(projectAutoIntegrate(repo(null), app(true))).toBe(true);
    expect(projectAutoIntegrate(repo(null), app(false))).toBe(false);
    // `undefined` is the same "has not ruled" — every project that predates the field.
    expect(projectAutoIntegrate({}, app(true))).toBe(true);
  });

  it('lets a project overrule the app in both directions', () => {
    expect(projectAutoIntegrate(repo(false), app(true))).toBe(false);
    expect(projectAutoIntegrate(repo(true), app(false))).toBe(true);
  });
});

describe('autoIntegrateOn', () => {
  it('follows the project when the card has said nothing', () => {
    expect(autoIntegrateOn({ autoIntegrate: null }, repo(true), app(false))).toBe(true);
    expect(autoIntegrateOn({ autoIntegrate: null }, repo(false), app(true))).toBe(false);
    expect(autoIntegrateOn({}, repo(true), app(false))).toBe(true);
  });

  it('reaches all the way to the app default when neither card nor project has ruled', () => {
    expect(autoIntegrateOn({}, repo(null), app(true))).toBe(true);
    expect(autoIntegrateOn({}, repo(null), app(false))).toBe(false);
  });

  it('lets the card overrule its project in both directions', () => {
    expect(autoIntegrateOn({ autoIntegrate: false }, repo(true), app(true))).toBe(false);
    expect(autoIntegrateOn({ autoIntegrate: true }, repo(false), app(false))).toBe(true);
  });

  it('is off when there is nothing at all to ask', () => {
    expect(autoIntegrateOn(null, null, null)).toBe(false);
    expect(autoIntegrateOn(undefined, undefined, undefined)).toBe(false);
  });

  // The one that matters for an upgrade: the feature ships with both new fields NULL, so
  // every existing install keeps merging exactly as often as it did yesterday.
  it('changes nothing for an install that has never touched either new switch', () => {
    expect(autoIntegrateOn({}, {}, app(false))).toBe(false);
    expect(autoIntegrateOn({}, {}, app(true))).toBe(true);
  });
});
