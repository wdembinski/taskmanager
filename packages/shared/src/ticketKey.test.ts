import { describe, expect, it } from 'vitest';
import {
  formatTicketKey,
  isTicketKey,
  MAX_TICKET_PREFIX_LENGTH,
  normalizeTicketPrefix,
  parseTicketKey,
  suggestTicketPrefix,
  uniqueTicketPrefix,
} from './ticketKey';

describe('normalizeTicketPrefix', () => {
  it('upper-cases and strips everything that is not a letter or a digit', () => {
    expect(normalizeTicketPrefix('tm')).toBe('TM');
    expect(normalizeTicketPrefix('  plat  ')).toBe('PLAT');
    expect(normalizeTicketPrefix('my-app')).toBe('MYAPP');
    expect(normalizeTicketPrefix('web_2')).toBe('WEB2');
  });

  it('refuses a prefix with nothing left in it', () => {
    expect(normalizeTicketPrefix('')).toBeNull();
    expect(normalizeTicketPrefix('   ')).toBeNull();
    expect(normalizeTicketPrefix('---')).toBeNull();
  });

  // The refusal that keeps `parseTicketKey` exact rather than heuristic: `12-3` has no
  // reading that tells the prefix from the ordinal.
  it('refuses a bare number', () => {
    expect(normalizeTicketPrefix('12')).toBeNull();
    expect(normalizeTicketPrefix('0')).toBeNull();
    expect(normalizeTicketPrefix('1A')).toBe('1A');
  });

  it('truncates to the length bound, and refuses what truncation leaves as a number', () => {
    const long = normalizeTicketPrefix('ABCDEFGHIJKLMNOP');
    expect(long).toHaveLength(MAX_TICKET_PREFIX_LENGTH);
    expect(long).toBe('ABCDEFGHIJ');
    // The letters are cut off by the bound, so what is left is a bare number — refused
    // rather than silently accepted as one.
    expect(normalizeTicketPrefix('1234567890AB')).toBeNull();
  });

  it('is idempotent', () => {
    for (const raw of ['tm', 'my-app!', '  PLAT ', 'ABCDEFGHIJKLMNOP']) {
      const once = normalizeTicketPrefix(raw);
      expect(once && normalizeTicketPrefix(once)).toBe(once);
    }
  });
});

describe('formatTicketKey', () => {
  it('builds the canonical key', () => {
    expect(formatTicketKey('TM', 1)).toBe('TM-1');
    expect(formatTicketKey('TM', 4211)).toBe('TM-4211');
  });

  it('normalizes the prefix on the way in', () => {
    expect(formatTicketKey('tm', 7)).toBe('TM-7');
    expect(formatTicketKey(' my-app ', 7)).toBe('MYAPP-7');
  });

  // Throwing, not returning a broken string: this is the one function that names a thing
  // permanently, and inside the allocator's transaction the throw rolls the insert back —
  // so a refused create never burns a number.
  it('throws rather than emitting a key it cannot make', () => {
    expect(() => formatTicketKey('', 1)).toThrow();
    expect(() => formatTicketKey('12', 1)).toThrow();
    expect(() => formatTicketKey('TM', 0)).toThrow();
    expect(() => formatTicketKey('TM', -3)).toThrow();
    expect(() => formatTicketKey('TM', 1.5)).toThrow();
  });
});

describe('parseTicketKey', () => {
  it('splits a key into its parts', () => {
    expect(parseTicketKey('TM-123')).toEqual({ prefix: 'TM', ticketNumber: 123 });
    expect(parseTicketKey('  TM-1  ')).toEqual({ prefix: 'TM', ticketNumber: 1 });
    expect(parseTicketKey('tm-9')).toEqual({ prefix: 'TM', ticketNumber: 9 });
  });

  it('round-trips whatever formatTicketKey emits', () => {
    for (const [prefix, n] of [
      ['TM', 1],
      ['PLAT', 4211],
      ['A1', 12],
    ] as Array<[string, number]>) {
      expect(parseTicketKey(formatTicketKey(prefix, n))).toEqual({ prefix, ticketNumber: n });
    }
  });

  it('refuses anything that is not a key', () => {
    expect(parseTicketKey('TM')).toBeNull();
    expect(parseTicketKey('')).toBeNull();
    expect(parseTicketKey('-1')).toBeNull();
    expect(parseTicketKey('TM-')).toBeNull();
    expect(parseTicketKey('TM-abc')).toBeNull();
    expect(parseTicketKey('TM-1-2')).toBeNull();
    // A prefix that is not already canonical: accepting it would mean two spellings of
    // one ticket, and only one of them comes back out of formatTicketKey.
    expect(parseTicketKey('my-app-1')).toBeNull();
    expect(parseTicketKey('T M-1')).toBeNull();
    // `12-3` — the case normalizeTicketPrefix exists to make impossible.
    expect(parseTicketKey('12-3')).toBeNull();
  });

  it('refuses a non-canonical ordinal', () => {
    expect(parseTicketKey('TM-007')).toBeNull();
    expect(parseTicketKey('TM-0')).toBeNull();
    expect(parseTicketKey('TM-+1')).toBeNull();
    expect(parseTicketKey('TM-1.5')).toBeNull();
  });
});

describe('isTicketKey', () => {
  it('is the predicate over parseTicketKey', () => {
    expect(isTicketKey('TM-1')).toBe(true);
    expect(isTicketKey('TM-007')).toBe(false);
    expect(isTicketKey('nonsense')).toBe(false);
  });
});

describe('suggestTicketPrefix', () => {
  it('takes initials for a multi-word name', () => {
    expect(suggestTicketPrefix('Task Manager')).toBe('TM');
    expect(suggestTicketPrefix('  the quick brown fox  ')).toBe('TQBF');
  });

  it('takes the first few letters of a single-word name', () => {
    expect(suggestTicketPrefix('platform')).toBe('PLAT');
  });

  it('falls back to empty when the name has nothing usable in it', () => {
    expect(suggestTicketPrefix('')).toBe('');
    expect(suggestTicketPrefix('   ')).toBe('');
    expect(suggestTicketPrefix('123')).toBe('');
  });
});

describe('uniqueTicketPrefix', () => {
  it('uses the normalized base unchanged when it is free', () => {
    expect(uniqueTicketPrefix('Task Manager', [])).toBe(normalizeTicketPrefix('Task Manager'));
    expect(uniqueTicketPrefix('tm', ['PLAT'])).toBe('TM');
  });

  it('appends 2, 3, … until it finds one that is free', () => {
    expect(uniqueTicketPrefix('TM', ['TM'])).toBe('TM2');
    expect(uniqueTicketPrefix('TM', ['TM', 'TM2'])).toBe('TM3');
    expect(uniqueTicketPrefix('TM', ['TM', 'TM2', 'TM3'])).toBe('TM4');
  });

  it('compares case-blind against what is taken', () => {
    expect(uniqueTicketPrefix('tm', ['TM'])).toBe('TM2');
    expect(uniqueTicketPrefix('TM', ['tm'])).toBe('TM2');
  });

  it('re-truncates to the length bound so a suffix never pushes it over', () => {
    const base = 'ABCDEFGHIJ'; // already MAX_TICKET_PREFIX_LENGTH long
    const result = uniqueTicketPrefix(base, [base]);
    expect(result).toHaveLength(MAX_TICKET_PREFIX_LENGTH);
    expect(result).toBe('ABCDEFGHI2');
  });

  it('falls back to a constant when the base is unusable, and still de-dupes it', () => {
    const first = uniqueTicketPrefix('', []);
    expect(first).not.toBe('');
    expect(normalizeTicketPrefix(first)).toBe(first);

    const second = uniqueTicketPrefix('', [first]);
    expect(second).not.toBe(first);
    expect(normalizeTicketPrefix(second)).toBe(second);
  });
});
