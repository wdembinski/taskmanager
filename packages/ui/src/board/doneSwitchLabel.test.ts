/**
 * The Show Done switch's own words. The rule under test is that the numeral appears in
 * exactly one situation — the column is shut AND something is in it — and that the tooltip
 * says how many of the hidden cards ended badly, which is the only reason the count is
 * worth reading at a glance.
 */
import { describe, expect, it } from 'vitest';
import { doneSwitchLabel, doneSwitchTitle } from './doneSwitchLabel';

const hidden = (total: number, notMarkedDone = 0): { total: number; notMarkedDone: number } => ({
  total,
  notMarkedDone,
});

describe('doneSwitchLabel', () => {
  it('says nothing extra when the column is empty', () => {
    expect(doneSwitchLabel(false, hidden(0))).toBe('Show Done');
  });

  it('carries the count while the column is shut', () => {
    expect(doneSwitchLabel(false, hidden(1))).toBe('Show Done (1)');
    expect(doneSwitchLabel(false, hidden(7))).toBe('Show Done (7)');
  });

  it('counts every hidden card, however it got there', () => {
    // A card that failed and a card marked done are both in the column and both hidden;
    // the label's number is the column, not the good news in it.
    expect(doneSwitchLabel(false, hidden(4, 3))).toBe('Show Done (4)');
  });

  it('drops the count once the column is open — you can see them', () => {
    expect(doneSwitchLabel(true, hidden(7))).toBe('Show Done');
    expect(doneSwitchLabel(true, hidden(7, 2))).toBe('Show Done');
  });
});

describe('doneSwitchTitle', () => {
  it('has nothing to say when the label has no count', () => {
    expect(doneSwitchTitle(false, hidden(0))).toBeNull();
    expect(doneSwitchTitle(true, hidden(7, 2))).toBeNull();
  });

  it('speaks of one card in the singular', () => {
    expect(doneSwitchTitle(false, hidden(1))).toBe('1 finished card is hidden');
  });

  it('names the way a single card ended when nobody marked it done', () => {
    expect(doneSwitchTitle(false, hidden(1, 1))).toBe(
      '1 finished card is hidden — it was cancelled, stopped or failed rather than done',
    );
  });

  it('states the plain count when every hidden card was actually finished', () => {
    expect(doneSwitchTitle(false, hidden(5))).toBe('5 finished cards are hidden');
  });

  it('breaks out the ones that failed, stopped or were cancelled', () => {
    // The whole point of the tooltip: the card you are hunting for is far more likely to be
    // one of the three that ended badly than one of the five that finished.
    expect(doneSwitchTitle(false, hidden(5, 3))).toBe(
      '5 finished cards are hidden — 3 of them cancelled, stopped or failed rather than done',
    );
  });

  it('says something different for a column that all failed than for one that all finished', () => {
    expect(doneSwitchTitle(false, hidden(3, 3))).not.toBe(doneSwitchTitle(false, hidden(3, 0)));
  });
});
