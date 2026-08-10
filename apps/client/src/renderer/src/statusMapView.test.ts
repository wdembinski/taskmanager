import { describe, expect, it } from 'vitest';
import type { JiraStatusOption } from '@shared/ipc';
import { buildStatusMapRows, reasonLabel } from './statusMapView';

const STATUSES: JiraStatusOption[] = [
  { name: 'To Do', category: 'To Do' },
  { name: 'In Progress', category: 'In Progress' },
  { name: 'Code Review', category: 'In Progress' },
  { name: 'Ready for review', category: 'To Do' },
  // Filed under To Do, as plenty of real schemes do — a ticket nobody can start is not
  // started. Its category is the one thing that must NOT decide where it lands.
  { name: 'Blocked', category: 'To Do' },
  { name: 'Done', category: 'Done' },
];

describe('buildStatusMapRows', () => {
  it('explains every status with the tier that decided it', () => {
    const rows = buildStatusMapRows(STATUSES);
    const by = (name: string) => rows.find((r) => r.name === name);

    expect(by('In Progress')).toMatchObject({ column: 'in-progress', reason: 'category' });
    // The whole point of the viewer: this one is NOT a category answer.
    expect(by('Code Review')).toMatchObject({ column: 'in-review', reason: 'heuristic' });
    // A To-Do-category status that merely mentions review has not been picked up.
    expect(by('Ready for review')).toMatchObject({ column: 'todo', reason: 'category' });
    expect(by('Done')).toMatchObject({ column: 'done', reason: 'category' });
    // The bug this table would have exposed: the name says blocked, the category says
    // To Do, and the category used to win.
    expect(by('Blocked')).toMatchObject({ column: 'blocked', reason: 'heuristic' });
  });

  it('badges a blocked-ish status as a name guess, not a review one', () => {
    const row = buildStatusMapRows(STATUSES).find((r) => r.name === 'Blocked');
    expect(row && reasonLabel(row.reason, row.column)).toBe('Name says blocked');
  });

  it('ignores a stale learned entry that names a blocked-ish status', () => {
    // What every installation that hit the bug is carrying: a drag into IN PROGRESS
    // transitioned the issue to Blocked, and the app remembered that as the truth.
    const rows = buildStatusMapRows(STATUSES, undefined, { blocked: 'in-progress' });
    const row = rows.find((r) => r.name === 'Blocked');
    expect(row).toMatchObject({ column: 'blocked', reason: 'heuristic' });
    expect(row && reasonLabel(row.reason, row.column)).not.toBe('Learned from a move');

    // ...but the human's own mapping still outranks the heuristic, in either direction.
    expect(
      buildStatusMapRows(STATUSES, { Blocked: 'in-progress' }).find((r) => r.name === 'Blocked'),
    ).toMatchObject({ column: 'in-progress', reason: 'explicit' });
  });

  it('shows an explicit mapping as such, outranking the name heuristic', () => {
    const rows = buildStatusMapRows(STATUSES, { 'code review': 'in-progress' });
    expect(rows.find((r) => r.name === 'Code Review')).toMatchObject({
      column: 'in-progress',
      reason: 'explicit',
    });
  });

  it('shows what a drag taught, below an explicit mapping', () => {
    const learned = { 'in progress': 'in-review' as const };
    expect(
      buildStatusMapRows(STATUSES, undefined, learned).find((r) => r.name === 'In Progress'),
    ).toMatchObject({ column: 'in-review', reason: 'learned' });

    const explicit = { 'in progress': 'in-progress' as const };
    expect(
      buildStatusMapRows(STATUSES, explicit, learned).find((r) => r.name === 'In Progress'),
    ).toMatchObject({ column: 'in-progress', reason: 'explicit' });
  });

  it('groups by resolved column in board order, then by name', () => {
    const rows = buildStatusMapRows(STATUSES);
    expect(rows.map((r) => `${r.column}:${r.name}`)).toEqual([
      'todo:Ready for review',
      'todo:To Do',
      'in-progress:In Progress',
      'in-review:Code Review',
      'blocked:Blocked',
      'done:Done',
    ]);
  });

  it('is empty for an instance that reported nothing', () => {
    expect(buildStatusMapRows([])).toEqual([]);
  });
});

describe('reasonLabel', () => {
  it('gives every tier a distinct sentence', () => {
    const labels = (['explicit', 'learned', 'heuristic', 'category'] as const).map((r) =>
      reasonLabel(r, 'in-review'),
    );
    expect(new Set(labels).size).toBe(4);
    expect(labels.every((l) => l.length > 0)).toBe(true);
  });

  it('says which of the two guesses the name heuristic made', () => {
    expect(reasonLabel('heuristic', 'in-review')).toBe('Name says review');
    expect(reasonLabel('heuristic', 'blocked')).toBe('Name says blocked');
    // The column wording belongs to the heuristic tier alone; no other tier changes.
    expect(reasonLabel('learned', 'blocked')).toBe('Learned from a move');
    expect(reasonLabel('explicit', 'blocked')).toBe('Mapped by you');
  });
});
