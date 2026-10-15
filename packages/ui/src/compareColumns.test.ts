import { describe, expect, it } from 'vitest';
import type { TaskStatus } from '@tm/shared/model';
import type { VariantLabel, VariantSummaryRow } from '@tm/shared/variants';
import { compareColumns } from './compareColumns';

const row = (
  id: string,
  label: VariantLabel | null,
  status: TaskStatus,
  over: Partial<VariantSummaryRow> = {},
): VariantSummaryRow => ({
  id,
  label,
  status,
  costUsd: null,
  diffStat: { files: 0, added: 0, removed: 0 },
  summary: '',
  ...over,
});

describe('compareColumns', () => {
  it('is empty for no rows', () => {
    expect(compareColumns([])).toEqual([]);
  });

  it('orders unlabelled input as A, B, C, unlabelled last', () => {
    const rows = [
      row('3', 'C', 'done'),
      row('u', null, 'done'),
      row('1', 'A', 'done'),
      row('2', 'B', 'done'),
    ];
    expect(compareColumns(rows).map((c) => c.id)).toEqual(['1', '2', '3', 'u']);
  });

  it('headings label A/B/C, and "Variant ?" for an unlabelled row', () => {
    const rows = [row('a', 'A', 'done'), row('u', null, 'done')];
    expect(compareColumns(rows).map((c) => c.heading)).toEqual(['Variant A', 'Variant ?']);
  });

  it('is not pickable with no changes, hinting why', () => {
    const [col] = compareColumns([
      row('a', 'A', 'done', { diffStat: { files: 0, added: 0, removed: 0 } }),
    ]);
    expect(col).toMatchObject({ pickable: false, pickHint: 'No changes to pick' });
  });

  it('is not pickable while still running, even with a diff', () => {
    const [col] = compareColumns([
      row('a', 'A', 'running', { diffStat: { files: 2, added: 5, removed: 1 } }),
    ]);
    expect(col).toMatchObject({ pickable: false, pickHint: 'Still running' });
  });

  it('a failed row with a diff is pickable and reads as failed', () => {
    const [col] = compareColumns([
      row('a', 'A', 'failed', { diffStat: { files: 1, added: 3, removed: 0 } }),
    ]);
    expect(col).toMatchObject({
      pickable: true,
      pickHint: null,
      failed: true,
      statusLabel: 'Failed',
    });
  });

  it('a failed row with no diff is not pickable', () => {
    const [col] = compareColumns([row('a', 'A', 'failed')]);
    expect(col).toMatchObject({ pickable: false, pickHint: 'No changes to pick', failed: true });
  });

  it('shows "—" for a null cost, never a fake $0.00', () => {
    const [col] = compareColumns([row('a', 'A', 'done', { costUsd: null })]);
    expect(col.costText).toBe('—');
  });

  it('formats a real cost', () => {
    const [col] = compareColumns([row('a', 'A', 'done', { costUsd: 1.23 })]);
    expect(col.costText).toBe('$1.23');
  });

  it('singularizes "1 file" and pluralizes otherwise', () => {
    const [one, many] = compareColumns([
      row('a', 'A', 'done', { diffStat: { files: 1, added: 10, removed: 2 } }),
      row('b', 'B', 'done', { diffStat: { files: 3, added: 10, removed: 2 } }),
    ]);
    expect(one!.diffText).toBe('1 file · +10 −2');
    expect(many!.diffText).toBe('3 files · +10 −2');
  });

  it('reads "No changes" for a row that touched nothing', () => {
    const [col] = compareColumns([
      row('a', 'A', 'done', { diffStat: { files: 0, added: 0, removed: 0 } }),
    ]);
    expect(col.diffText).toBe('No changes');
  });

  it('uses the row’s own summary when it has one', () => {
    const [col] = compareColumns([row('a', 'A', 'done', { summary: 'Fixed the parser.' })]);
    expect(col.summary).toBe('Fixed the parser.');
  });

  it.each<[TaskStatus, string]>([
    ['pending', 'No result yet'],
    ['running', 'No result yet'],
    ['waiting-input', 'No result yet'],
    ['blocked-by-limit', 'No result yet'],
    ['done', 'Ended without a result'],
    ['failed', 'Ended without a result'],
    ['stopped', 'Ended without a result'],
    ['cancelled', 'Ended without a result'],
  ])('falls back for an empty summary on %s: %s', (status, expected) => {
    const [col] = compareColumns([row('a', 'A', status, { summary: '' })]);
    expect(col!.summary).toBe(expected);
  });
});
