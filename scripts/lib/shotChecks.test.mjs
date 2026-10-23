/**
 * Collected by the root `vitest.config.ts` the same way `scripts/next-version.test.mjs` is —
 * no `include` glob change needed for a `.mjs` suite next to a `.mjs` module.
 */
import { describe, expect, it } from 'vitest';
import { findDuplicateShots, layoutProblems, shotProblems } from './shotChecks.mjs';

describe('layoutProblems', () => {
  const viewport = { top: 0, left: 0, bottom: 900, right: 1440, label: 'the viewport' };
  const cell = { top: 500, left: 400, bottom: 520, right: 1000, label: 'div.cell' };

  it('is empty for a target fully inside every clip and clear of every avoid rect', () => {
    const target = { top: 500, left: 400, bottom: 518, right: 440 };
    const conversation = { top: 600, left: 400, bottom: 800, right: 1000 };
    expect(layoutProblems({ target, clips: [viewport, cell], avoid: [conversation] })).toEqual([]);
  });

  it('reports a target half cut off by an overflow-clipping ancestor', () => {
    const target = { top: 510, left: 400, bottom: 530, right: 440 };
    expect(layoutProblems({ target, clips: [viewport, cell] })).toEqual([
      'clipped by div.cell (bottom by 10px)',
    ]);
  });

  it('reports a target running past the viewport', () => {
    const target = { top: 890, left: 1430, bottom: 910, right: 1450 };
    expect(layoutProblems({ target, clips: [viewport] })).toEqual([
      'clipped by the viewport (bottom by 10px, right by 10px)',
    ]);
  });

  it('reports a target overlapping an avoid rect', () => {
    const target = { top: 500, left: 400, bottom: 520, right: 440 };
    const conversation = { top: 510, left: 400, bottom: 800, right: 1000, label: 'Conversation' };
    expect(layoutProblems({ target, clips: [viewport], avoid: [conversation] })).toEqual([
      'overlaps Conversation',
    ]);
  });

  it('treats touching edges as fine — clip edges and avoid edges alike', () => {
    const target = { top: 500, left: 400, bottom: 520, right: 1000 };
    const below = { top: 520, left: 400, bottom: 800, right: 1000 };
    const beside = { top: 500, left: 1000, bottom: 520, right: 1200 };
    expect(layoutProblems({ target, clips: [viewport, cell], avoid: [below, beside] })).toEqual([]);
  });

  it('ignores sub-pixel rounding past an edge', () => {
    const target = { top: 499.8, left: 400, bottom: 520.3, right: 440 };
    const conversation = { top: 520, left: 400, bottom: 800, right: 1000 };
    expect(layoutProblems({ target, clips: [cell], avoid: [conversation] })).toEqual([]);
  });

  it('names an unlabelled rect by its edges', () => {
    const target = { top: 0, left: 0, bottom: 20, right: 20 };
    expect(
      layoutProblems({ target, avoid: [{ top: 10, left: 10, bottom: 30, right: 30 }] }),
    ).toEqual(['overlaps { top: 10, left: 10, bottom: 30, right: 30 }']);
  });
});

describe('findDuplicateShots', () => {
  it('flags two differently-named shots with the same bytes (same hash)', () => {
    const shots = [
      { name: 'issue-peek', hash: 'aaa' },
      { name: 'issue-full-screen', hash: 'aaa' },
      { name: 'board-light', hash: 'bbb' },
    ];
    expect(findDuplicateShots(shots)).toEqual([
      { hash: 'aaa', names: ['issue-peek', 'issue-full-screen'] },
    ]);
  });

  it('does not flag shots whose bytes differ', () => {
    const shots = [
      { name: 'issue-peek', hash: 'aaa' },
      { name: 'issue-full-screen', hash: 'bbb' },
    ];
    expect(findDuplicateShots(shots)).toEqual([]);
  });

  it('does not flag the same name appearing once, even with others sharing its hash', () => {
    const shots = [{ name: 'board-light', hash: 'aaa' }];
    expect(findDuplicateShots(shots)).toEqual([]);
  });

  it('groups three-or-more differently-named shots sharing one hash together', () => {
    const shots = [
      { name: 'a', hash: 'same' },
      { name: 'b', hash: 'same' },
      { name: 'c', hash: 'same' },
    ];
    expect(findDuplicateShots(shots)).toEqual([{ hash: 'same', names: ['a', 'b', 'c'] }]);
  });
});

describe('shotProblems', () => {
  function okResult(name, hash) {
    return {
      row: { name },
      ok: true,
      error: null,
      selectorMissed: null,
      shotPath: `${name}.png`,
      hash,
    };
  }

  it('reports a failed row', () => {
    const results = [
      {
        row: { name: 'board-light' },
        ok: false,
        error: new Error('boom'),
        selectorMissed: null,
        shotPath: null,
      },
    ];
    expect(shotProblems(results)).toEqual([
      { kind: 'failed', name: 'board-light', message: 'boom' },
    ]);
  });

  it('reports a row whose expect selector never matched', () => {
    const results = [{ ...okResult('settings', 'aaa'), selectorMissed: '[aria-label="x"]' }];
    expect(shotProblems(results)).toEqual([
      { kind: 'selectorMissed', name: 'settings', selector: '[aria-label="x"]' },
    ]);
  });

  it('reports a row whose layoutCheck target is clipped or overlapped', () => {
    const results = [
      {
        ...okResult('ticket-band-empty-dark', 'aaa'),
        layoutProblem: ['clipped by div.cell (bottom by 10px)', 'overlaps Conversation'],
      },
    ];
    expect(shotProblems(results)).toEqual([
      {
        kind: 'layout',
        name: 'ticket-band-empty-dark',
        message: 'clipped by div.cell (bottom by 10px); overlaps Conversation',
      },
    ]);
  });

  it('does not report an empty layoutProblem', () => {
    const results = [{ ...okResult('board-light', 'aaa'), layoutProblem: [] }];
    expect(shotProblems(results)).toEqual([]);
  });

  it('reports duplicate shots found among the ok rows', () => {
    const results = [okResult('issue-peek', 'same'), okResult('issue-full-screen', 'same')];
    expect(shotProblems(results)).toEqual([
      { kind: 'duplicate', name: 'issue-full-screen', otherName: 'issue-peek' },
    ]);
  });

  it('is empty for a clean run', () => {
    const results = [okResult('board-light', 'aaa'), okResult('board-dark', 'bbb')];
    expect(shotProblems(results)).toEqual([]);
  });

  it('merges all three kinds together', () => {
    const results = [
      {
        row: { name: 'failed-row' },
        ok: false,
        error: new Error('x'),
        selectorMissed: null,
        shotPath: null,
      },
      { ...okResult('missed-row', 'aaa'), selectorMissed: '[data-x]' },
      okResult('dup-a', 'same'),
      okResult('dup-b', 'same'),
    ];
    const problems = shotProblems(results);
    expect(problems).toHaveLength(3);
    expect(problems).toEqual(
      expect.arrayContaining([
        { kind: 'failed', name: 'failed-row', message: 'x' },
        { kind: 'selectorMissed', name: 'missed-row', selector: '[data-x]' },
        { kind: 'duplicate', name: 'dup-b', otherName: 'dup-a' },
      ]),
    );
  });
});
