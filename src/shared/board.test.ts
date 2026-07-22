import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from './model';
import { categoryFromKey, categoryToColumn, hasUnreadJira } from './board';

const task = (over: Partial<Task>): Task => ({
  id: 't',
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: 'x',
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'jira',
  isContract: false,
  isScaffold: false,
  externalSource: 'jira',
  ...over,
});

describe('categoryFromKey', () => {
  it('maps stable category keys', () => {
    expect(categoryFromKey('new')).toBe('To Do');
    expect(categoryFromKey('indeterminate')).toBe('In Progress');
    expect(categoryFromKey('done')).toBe('Done');
    expect(categoryFromKey('undefined')).toBe('To Do');
  });
});

describe('categoryToColumn', () => {
  it('maps categories to columns', () => {
    expect(categoryToColumn('To Do')).toBe('todo');
    expect(categoryToColumn('In Progress')).toBe('in-progress');
    expect(categoryToColumn('Done')).toBe('done');
  });
});

describe('hasUnreadJira', () => {
  it('is false for internal (non-JIRA) tasks', () => {
    expect(hasUnreadJira(task({ externalSource: null, latestCommentAt: 100 }))).toBe(false);
  });
  it('is false when there are no comments', () => {
    expect(hasUnreadJira(task({ latestCommentAt: null }))).toBe(false);
  });
  it('is true when a newer comment exists than the last read', () => {
    expect(hasUnreadJira(task({ latestCommentAt: 200, lastReadCommentAt: 100 }))).toBe(true);
  });
  it('is true when nothing has been read yet but a comment exists', () => {
    expect(hasUnreadJira(task({ latestCommentAt: 200, lastReadCommentAt: null }))).toBe(true);
  });
  it('is false when the latest comment has already been read', () => {
    expect(hasUnreadJira(task({ latestCommentAt: 200, lastReadCommentAt: 200 }))).toBe(false);
  });
});
