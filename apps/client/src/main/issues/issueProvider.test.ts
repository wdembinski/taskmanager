import { describe, expect, it } from 'vitest';
import { ISSUE_LABEL_MAX_COUNT, type IssueSummary } from '@shared/issues';
import type { Task } from '@shared/model';
import {
  facetLabels,
  listIssuePage,
  normalizeLabels,
  onBoardIndex,
  type IssueProvider,
  type ProviderPage,
} from './issueProvider';

describe('normalizeLabels', () => {
  it('reads a plain string and an object label the same way', () => {
    expect(normalizeLabels(['bug', { name: 'urgent' }])).toEqual(['bug', 'urgent']);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeLabels([' bug ', { name: '  urgent  ' }])).toEqual(['bug', 'urgent']);
  });

  it('de-duplicates case-insensitively, keeping the first spelling seen', () => {
    expect(normalizeLabels(['Bug', 'bug', { name: 'BUG' }])).toEqual(['Bug']);
  });

  it('drops a label object with no name, and an empty string', () => {
    expect(normalizeLabels(['', '  ', { name: null }, { name: undefined }, {}])).toEqual([]);
  });
});

describe('facetLabels', () => {
  it('unions the page, the scope, and the selection, de-duplicated', () => {
    expect(facetLabels(['bug'], ['bug', 'feature'], [])).toEqual(['bug', 'feature']);
  });

  it('keeps a selected label even when it is in neither the page nor the scope', () => {
    expect(facetLabels(['bug'], ['feature'], ['archived'])).toEqual(['feature', 'bug', 'archived']);
  });

  it('does not duplicate a selected label that is already a facet', () => {
    expect(facetLabels([], ['bug'], ['bug'])).toEqual(['bug']);
  });
});

describe('onBoardIndex', () => {
  const task = (
    over: Partial<Task>,
  ): Pick<Task, 'id' | 'externalSource' | 'externalKey' | 'archivedAt'> => ({
    id: 'task-1',
    externalSource: null,
    externalKey: null,
    archivedAt: null,
    ...over,
  });

  it('resolves a task already on the board by provider and key', () => {
    const resolve = onBoardIndex([
      task({ id: 'task-mirrored', externalSource: 'jira', externalKey: 'AB-1' }),
    ]);
    expect(resolve('jira', 'AB-1')).toBe('task-mirrored');
  });

  it('answers null for an issue with no matching task', () => {
    const resolve = onBoardIndex([
      task({ id: 'task-mirrored', externalSource: 'jira', externalKey: 'AB-1' }),
    ]);
    expect(resolve('jira', 'AB-2')).toBeNull();
  });

  it('ignores an archived task', () => {
    const resolve = onBoardIndex([
      task({
        id: 'task-archived',
        externalSource: 'jira',
        externalKey: 'AB-1',
        archivedAt: 1700000000000,
      }),
    ]);
    expect(resolve('jira', 'AB-1')).toBeNull();
  });

  it('ignores a task mirrored from a different tracker, even with the same key', () => {
    const resolve = onBoardIndex([
      task({ id: 'task-github', externalSource: 'github', externalKey: 'AB-1' }),
    ]);
    expect(resolve('jira', 'AB-1')).toBeNull();
  });
});

describe('listIssuePage', () => {
  const summary = (
    over: Partial<Omit<IssueSummary, 'onBoardTaskId'>>,
  ): Omit<IssueSummary, 'onBoardTaskId'> => ({
    provider: 'jira',
    key: 'AB-1',
    title: 'Fix the thing',
    url: 'https://jira.example.com/browse/AB-1',
    state: 'To Do',
    labels: [],
    updatedAt: 1700000000000,
    ...over,
  });

  const provider = (page: ProviderPage): IssueProvider => ({
    id: 'jira',
    list: async () => page,
  });

  it('fills onBoardTaskId for an issue already on the board, and null otherwise', async () => {
    const page = await listIssuePage(
      provider({
        items: [summary({ key: 'AB-1' }), summary({ key: 'AB-2' })],
        labels: [],
        nextCursor: null,
      }),
      { provider: 'jira' },
      [{ id: 'task-1', externalSource: 'jira', externalKey: 'AB-1', archivedAt: null }],
    );

    expect(page.items.map((i) => [i.key, i.onBoardTaskId])).toEqual([
      ['AB-1', 'task-1'],
      ['AB-2', null],
    ]);
  });

  it('applies the clamp to the page the provider hands back', async () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      summary({
        key: `AB-${i}`,
        labels: Array.from({ length: ISSUE_LABEL_MAX_COUNT + 5 }, (_, j) => `l${j}`),
      }),
    );
    const page = await listIssuePage(
      provider({ items, labels: [], nextCursor: null }),
      { provider: 'jira' },
      [],
    );

    expect(page.items[0]?.labels).toHaveLength(ISSUE_LABEL_MAX_COUNT);
  });
});
