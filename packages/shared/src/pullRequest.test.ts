import { describe, expect, it } from 'vitest';
import { autoCreatePrOn } from './pullRequest';

const project = (autoCreatePr: boolean): { autoCreatePr: boolean } => ({ autoCreatePr });

describe('autoCreatePrOn', () => {
  it('follows the project when the card has said nothing', () => {
    expect(autoCreatePrOn({ autoCreatePr: null }, project(true))).toBe(true);
    expect(autoCreatePrOn({ autoCreatePr: null }, project(false))).toBe(false);
    // `undefined` is the same "has not ruled" — every card that predates the field.
    expect(autoCreatePrOn({}, project(true))).toBe(true);
  });

  it('lets the card overrule its project in both directions', () => {
    expect(autoCreatePrOn({ autoCreatePr: false }, project(true))).toBe(false);
    expect(autoCreatePrOn({ autoCreatePr: true }, project(false))).toBe(true);
  });

  it('is off when there is no card and no project to ask', () => {
    expect(autoCreatePrOn(null, null)).toBe(false);
    expect(autoCreatePrOn(undefined, undefined)).toBe(false);
  });
});
