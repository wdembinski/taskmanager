import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@shared/model';
import { importIssue, type ImportIssueDeps } from './importIssue';

const task = (over: Partial<Task>): Task => ({
  id: 'task-1',
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: 'Do a thing',
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'jira',
  isContract: false,
  isScaffold: false,
  externalSource: 'jira',
  externalKey: 'PROJ-1',
  ...over,
});

/**
 * An in-memory fake of everything `importIssue` touches, keyed exactly how the real store
 * would be: `(externalSource, externalKey)` for `findCard`, `id` for everything else. Call
 * counts are what the "importing twice" test asserts against — a second `fetchCard`/`insert`
 * would mean a duplicate card.
 */
function fakeStore(initial: Task[] = []) {
  const byId = new Map(initial.map((t) => [t.id, t]));
  const calls = { fetchCard: 0, insert: 0, unarchive: 0, pin: 0 };

  const deps: ImportIssueDeps = {
    findCard(source, key) {
      for (const t of byId.values()) {
        if (t.externalSource === source && t.externalKey === key) return t;
      }
      return undefined;
    },
    async fetchCard(provider, key) {
      calls.fetchCard++;
      const tracker = provider === 'github' ? 'github' : 'jira';
      return task({
        id: `fetched-${key}`,
        source: tracker,
        externalSource: tracker,
        externalKey: key,
      });
    },
    insert(t) {
      calls.insert++;
      byId.set(t.id, t);
      return t;
    },
    unarchive(id) {
      calls.unarchive++;
      const t = byId.get(id);
      if (t) byId.set(id, { ...t, archivedAt: null, archivedReason: null });
    },
    pin(id) {
      calls.pin++;
      const t = byId.get(id);
      if (!t) throw new Error('not found');
      const pinned = { ...t, pinnedImport: true };
      byId.set(id, pinned);
      return pinned;
    },
  };

  return { deps, byId, calls };
}

describe('importIssue', () => {
  it('fetches and inserts a brand-new issue, pinned', async () => {
    const { deps, calls } = fakeStore();
    const result = await importIssue('jira', 'PROJ-9', deps);
    expect(result.pinnedImport).toBe(true);
    expect(result.externalKey).toBe('PROJ-9');
    expect(calls.fetchCard).toBe(1);
    expect(calls.insert).toBe(1);
    expect(calls.pin).toBe(0);
  });

  it('importing the same issue twice returns one card, with only one insert', async () => {
    const { deps, calls, byId } = fakeStore();
    const first = await importIssue('jira', 'PROJ-9', deps);
    const second = await importIssue('jira', 'PROJ-9', deps);
    expect(second.id).toBe(first.id);
    expect(calls.fetchCard).toBe(1);
    expect(calls.insert).toBe(1);
    expect(byId.size).toBe(1);
  });

  it('pins an existing, on-board card and returns it without fetching', async () => {
    const existing = task({ id: 'task-existing', externalKey: 'PROJ-5' });
    const { deps, calls } = fakeStore([existing]);
    const result = await importIssue('jira', 'PROJ-5', deps);
    expect(result.id).toBe('task-existing');
    expect(result.pinnedImport).toBe(true);
    expect(calls.fetchCard).toBe(0);
    expect(calls.unarchive).toBe(0);
    expect(calls.pin).toBe(1);
  });

  it('restores an archived card before pinning it', async () => {
    const archived = task({
      id: 'task-archived',
      externalKey: 'PROJ-7',
      archivedAt: 1700000000000,
    });
    const { deps, calls } = fakeStore([archived]);
    const result = await importIssue('jira', 'PROJ-7', deps);
    expect(result.id).toBe('task-archived');
    expect(result.archivedAt).toBeNull();
    expect(result.pinnedImport).toBe(true);
    expect(calls.fetchCard).toBe(0);
    expect(calls.unarchive).toBe(1);
    expect(calls.pin).toBe(1);
  });

  it('refuses GitLab without calling any dep', async () => {
    const { deps, calls } = fakeStore();
    await expect(importIssue('gitlab', 'GRP/PROJ!3', deps)).rejects.toThrow(/GitLab/);
    expect(calls.fetchCard).toBe(0);
    expect(calls.insert).toBe(0);
    expect(calls.unarchive).toBe(0);
    expect(calls.pin).toBe(0);
  });

  it('does not match a source/key collision across trackers', async () => {
    const githubCard = task({
      id: 'task-github',
      source: 'github',
      externalSource: 'github',
      externalKey: 'PROJ-9',
    });
    const { deps, calls } = fakeStore([githubCard]);
    const result = await importIssue('jira', 'PROJ-9', deps);
    expect(result.id).not.toBe('task-github');
    expect(calls.fetchCard).toBe(1);
    expect(calls.insert).toBe(1);
  });
});
