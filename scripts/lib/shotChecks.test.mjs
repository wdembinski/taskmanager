/**
 * Collected by the root `vitest.config.ts` the same way `scripts/next-version.test.mjs` is —
 * no `include` glob change needed for a `.mjs` suite next to a `.mjs` module.
 */
import { describe, expect, it } from 'vitest';
import { findDuplicateShots, shotProblems } from './shotChecks.mjs';

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
