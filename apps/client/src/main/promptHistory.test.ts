/**
 * Unit tests for the prompt-history cap (token audit, S1).
 *
 * Three things have to hold or the cap is worse than no cap: the entries that survive are
 * the NEWEST, they come back in the order the prompts render them (oldest first), and the
 * number that did not survive is reported truthfully.
 */
import { describe, expect, it } from 'vitest';
import {
  NOTES_CHAR_BUDGET,
  TICKET_COMMENT_CHAR_BUDGET,
  boundEntries,
  boundHistory,
  omissionLine,
} from './promptHistory';

/** `n` entries of exactly `size` chars, labelled so their order is checkable. */
const entries = (n: number, size: number): string[] =>
  Array.from({ length: n }, (_, i) => `${i}`.padEnd(size, '.'));

describe('boundHistory', () => {
  it('keeps everything when the history fits, untouched and in order', () => {
    const history = ['first', 'second', 'third'];
    expect(boundHistory(history, { maxChars: 1_000 })).toEqual({
      kept: ['first', 'second', 'third'],
      omitted: 0,
    });
  });

  it('keeps the NEWEST entries and returns them oldest-first', () => {
    // 10 chars each, budget for 3.
    const bounded = boundHistory(entries(5, 10), { maxChars: 30 });
    expect(bounded.kept).toHaveLength(3);
    expect(bounded.kept.map((e) => e[0])).toEqual(['2', '3', '4']);
    expect(bounded.omitted).toBe(2);
  });

  it('is exact at the boundary: a history summing to the budget loses nothing', () => {
    expect(boundHistory(entries(4, 25), { maxChars: 100 }).omitted).toBe(0);
    // One char over and the oldest goes.
    expect(boundHistory(entries(4, 25), { maxChars: 99 }).omitted).toBe(1);
  });

  it('stops at the first entry that will not fit rather than skipping it', () => {
    // Newest-first the sizes are 10, 60, 10 — the 60 does not fit in the 40 left, and the
    // 10 behind it must NOT be pulled forward: a hole in the middle of a thread is worse.
    const bounded = boundHistory(['old', 'x'.repeat(60), 'y'.repeat(10)], { maxChars: 50 });
    expect(bounded.kept).toEqual(['y'.repeat(10)]);
    expect(bounded.omitted).toBe(2);
  });

  it('keeps the newest entry even when it alone blows the budget', () => {
    // Otherwise the brief says "3 notes omitted" and carries none of them — it would tell
    // the agent there is history and hand it nothing.
    const bounded = boundHistory(['a', 'b', 'c'.repeat(500)], { maxChars: 10 });
    expect(bounded.kept).toEqual(['c'.repeat(500)]);
    expect(bounded.omitted).toBe(2);
  });

  it('handles an empty history and a zero budget without claiming an omission', () => {
    expect(boundHistory([], { maxChars: 100 })).toEqual({ kept: [], omitted: 0 });
    expect(boundHistory([], { maxChars: 0 })).toEqual({ kept: [], omitted: 0 });
  });

  it('never mutates the caller’s array', () => {
    const history = entries(4, 10);
    const copy = [...history];
    boundHistory(history, { maxChars: 20 });
    expect(history).toEqual(copy);
  });
});

describe('boundEntries (anything with a rendered size)', () => {
  const comment = (author: string, body: string) => ({ author, body });
  const size = (c: { author: string; body: string }) => `${c.author}: ${c.body}`.length;

  it('measures what the prompt will actually render, not just the body', () => {
    // Bodies are 10 chars; rendered with "Ada: " each costs 15. Budget 30 => 2 survive.
    const thread = [
      comment('Ada', 'a'.repeat(10)),
      comment('Ada', 'b'.repeat(10)),
      comment('Ada', 'c'.repeat(10)),
    ];
    const bounded = boundEntries(thread, size, { maxChars: 30 });
    expect(bounded.kept.map((c) => c.body[0])).toEqual(['b', 'c']);
    expect(bounded.omitted).toBe(1);
  });
});

describe('omissionLine', () => {
  it('says how many were dropped, and offers a way to get them back', () => {
    expect(omissionLine(42, 'comment')).toEqual([
      '_(42 earlier comments omitted — ask if you need them.)_',
    ]);
  });

  it('reads correctly for a single entry', () => {
    expect(omissionLine(1, 'note')).toEqual(['_(1 earlier note omitted — ask if you need them.)_']);
  });

  it('is nothing at all when nothing was dropped', () => {
    expect(omissionLine(0, 'note')).toEqual([]);
    expect(omissionLine(-1, 'note')).toEqual([]);
  });
});

describe('the budgets', () => {
  it('sit above the heaviest card the audit measured (11,493 chars)', () => {
    expect(NOTES_CHAR_BUDGET).toBeGreaterThan(11_493);
  });

  it('give a tracker thread more room than a card’s notes, which every step re-pays', () => {
    expect(TICKET_COMMENT_CHAR_BUDGET).toBeGreaterThan(NOTES_CHAR_BUDGET);
  });
});
