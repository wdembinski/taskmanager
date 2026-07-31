import { describe, expect, it } from 'vitest';
import {
  priorityBucket,
  priorityColor,
  priorityIndicatorShown,
  priorityRank,
} from './priority';

describe('priorityBucket', () => {
  // The bug this module exists to prevent: "Highest" contains "high", so a naive
  // ordered chain buckets the top rung as the second one.
  it('does not mistake Highest for High', () => {
    expect(priorityBucket('Highest')).toBe('highest');
    expect(priorityBucket('High')).toBe('high');
  });

  it('does not mistake Lowest for Low', () => {
    expect(priorityBucket('Lowest')).toBe('lowest');
    expect(priorityBucket('Low')).toBe('low');
  });

  it('recognises the classic JIRA scale', () => {
    expect(priorityBucket('Blocker')).toBe('highest');
    expect(priorityBucket('Critical')).toBe('highest');
    expect(priorityBucket('Major')).toBe('medium');
    expect(priorityBucket('Minor')).toBe('low');
    expect(priorityBucket('Trivial')).toBe('lowest');
  });

  it('ignores case and surrounding space', () => {
    expect(priorityBucket('  HIGHEST  ')).toBe('highest');
  });

  it('is "none" only when nothing was said', () => {
    expect(priorityBucket(null)).toBe('none');
    expect(priorityBucket(undefined)).toBe('none');
    expect(priorityBucket('')).toBe('none');
    expect(priorityBucket('   ')).toBe('none');
  });

  it('treats an unrecognised name as middling, not as unset', () => {
    expect(priorityBucket('Urgent-ish')).toBe('medium');
  });
});

describe('priorityRank', () => {
  it('orders the scale from most to least urgent', () => {
    const names = ['Lowest', 'Low', 'Medium', 'High', 'Highest'];
    const ranks = names.map(priorityRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(5);
  });

  it('sinks an unprioritised task below every named rung', () => {
    expect(priorityRank(null)).toBeLessThan(priorityRank('Lowest'));
  });
});

describe('priorityColor', () => {
  it('gives every rung its own colour', () => {
    const colors = ['Highest', 'High', 'Medium', 'Low', 'Lowest'].map(priorityColor);
    expect(colors.every((c) => typeof c === 'string')).toBe(true);
    expect(new Set(colors).size).toBe(5);
  });

  it('is null when there is no priority, so the square is not drawn', () => {
    expect(priorityColor(null)).toBeNull();
  });
});

describe('priorityIndicatorShown', () => {
  const RUNGS = ['Highest', 'High', 'Medium', 'Low', 'Lowest'] as const;

  it('shows nothing at all when the indicator is switched off', () => {
    for (const name of RUNGS) expect(priorityIndicatorShown('off', name)).toBe(false);
  });

  it('paints every rung in colour mode — a scale with a hole reads as a bug', () => {
    for (const name of RUNGS) expect(priorityIndicatorShown('color', name)).toBe(true);
  });

  // The point of the colourless mode: medium IS normal, so only an abnormal priority is
  // worth ink. A board where most cards say nothing is one where the cards that do are seen.
  it('skips medium in mono mode, and only medium', () => {
    expect(priorityIndicatorShown('mono', 'Medium')).toBe(false);
    expect(priorityIndicatorShown('mono', 'Highest')).toBe(true);
    expect(priorityIndicatorShown('mono', 'High')).toBe(true);
    expect(priorityIndicatorShown('mono', 'Low')).toBe(true);
    expect(priorityIndicatorShown('mono', 'Lowest')).toBe(true);
  });

  it('shows nothing for an unprioritised task in any mode', () => {
    for (const mode of ['color', 'mono', 'off'] as const) {
      expect(priorityIndicatorShown(mode, null)).toBe(false);
      expect(priorityIndicatorShown(mode, '')).toBe(false);
      expect(priorityIndicatorShown(mode, '   ')).toBe(false);
    }
  });

  // The two modes deliberately disagree here. `priorityBucket` calls a name it cannot place
  // `medium`, which is the right rank to sort it at — but "we couldn't read this one" is not
  // worth a mark, so mono stays quiet where colour still paints the middle square.
  it('treats an unrecognised name as medium: painted in colour, silent in mono', () => {
    expect(priorityBucket('Wibble')).toBe('medium');
    expect(priorityIndicatorShown('color', 'Wibble')).toBe(true);
    expect(priorityIndicatorShown('mono', 'Wibble')).toBe(false);
  });

  // The card's footer row and the glyph inside it ask this same question; if they could
  // disagree, the row would exist holding nothing.
  it('agrees with priorityColor about when colour mode draws', () => {
    for (const name of [...RUNGS, 'Blocker', 'Trivial', 'Wibble', null]) {
      expect(priorityIndicatorShown('color', name)).toBe(priorityColor(name) !== null);
    }
  });
});
