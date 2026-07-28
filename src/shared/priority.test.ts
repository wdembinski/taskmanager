import { describe, expect, it } from 'vitest';
import { priorityBucket, priorityColor, priorityRank } from './priority';

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
