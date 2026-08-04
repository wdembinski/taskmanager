import { describe, expect, it, vi } from 'vitest';
import { confirmStillMatching, recheckByKey, type IssueSearcher } from './jiraConfirm';
import type { JiraIssue, JiraSearchResult } from './jiraClient';

const issue = (key: string): JiraIssue =>
  ({
    id: key,
    key,
    fields: {
      summary: 'Do a thing',
      status: { name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } },
    },
  }) as unknown as JiraIssue;

/** `n` keys, `AB-1`…`AB-n`. */
const keys = (n: number): string[] => Array.from({ length: n }, (_, i) => `AB-${i + 1}`);

/** The keys named by a composed `key in (...)` clause, in the order they appear. */
const keysOf = (jql: string): string[] =>
  /key in \(([^)]*)\)/
    .exec(jql)?.[1]
    .split(',')
    .map((k) => k.trim()) ?? [];

/**
 * A searcher that answers every batch with the issues its own `key in (...)` names — the
 * "everything still matches" instance — and records what it was asked.
 */
const fakeSearcher = (
  answer: (jql: string, keysAsked: string[]) => JiraSearchResult | Promise<JiraSearchResult> = (
    _jql,
    asked,
  ) => ({ issues: asked.map(issue), truncated: false }),
): IssueSearcher & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    searchAll: (jql: string) => {
      calls.push(jql);
      return Promise.resolve(answer(jql, keysOf(jql)));
    },
  };
};

describe('confirmStillMatching', () => {
  it('asks nothing at all when there are no candidate keys', async () => {
    const client = fakeSearcher();
    const result = await confirmStillMatching(client, 'assignee = currentUser()', []);
    expect(client.calls).toEqual([]);
    expect(result.checked.size).toBe(0);
    expect(result.matching.size).toBe(0);
  });

  it('batches 120 keys into 3 requests of 50, 50 and 20', async () => {
    const client = fakeSearcher();
    const result = await confirmStillMatching(client, 'project = AB', keys(120));
    expect(client.calls).toHaveLength(3);
    expect(client.calls.map((jql) => keysOf(jql).length)).toEqual([50, 50, 20]);
    expect(result.checked.size).toBe(120);
    expect(result.matching.size).toBe(120);
  });

  // The two details that decide whether the composed query answers the question asked:
  // an unparenthesised `OR` filter would bind `key in (...)` to its last branch alone, and
  // a sort is pure cost on a membership test (`ORDER BY rank` is expensive on Server/DC).
  it("parenthesises the user's filter and drops its ORDER BY", async () => {
    const client = fakeSearcher();
    await confirmStillMatching(
      client,
      'assignee = currentUser() OR reporter = currentUser() ORDER BY rank',
      ['AB-1'],
    );
    expect(client.calls[0]).toBe(
      '(assignee = currentUser() OR reporter = currentUser()) AND key in (AB-1)',
    );
    expect(client.calls[0]).not.toMatch(/order\s+by/i);
  });

  // The whole reason each batch stands alone: `key in (...)` is one query, and one key
  // naming an issue this token cannot see 400s every card batched with it.
  it('keeps the other batches when one throws, and concludes nothing about its own keys', async () => {
    const client = fakeSearcher((_jql, asked) => {
      if (asked.includes('AB-51')) throw new Error('JIRA 400: issue does not exist');
      return { issues: asked.map(issue), truncated: false };
    });
    const failed: string[][] = [];
    const result = await confirmStillMatching(client, 'project = AB', keys(120), {
      onBatchFailed: (batch) => failed.push([...batch]),
    });

    expect(client.calls).toHaveLength(3);
    expect(result.checked.size).toBe(70); // the first 50 and the last 20
    expect(result.checked.has('AB-1')).toBe(true);
    expect(result.checked.has('AB-120')).toBe(true);
    // Not one key of the failed batch, so every one of its cards stays on the board.
    for (const key of keys(100).slice(50)) expect(result.checked.has(key)).toBe(false);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toHaveLength(50);
    expect(failed[0][0]).toBe('AB-51');
  });

  it('discards a truncated batch entirely — a short answer is not an answer', async () => {
    const client = fakeSearcher((_jql, asked) =>
      asked.includes('AB-51')
        ? { issues: [issue('AB-51')], truncated: true }
        : { issues: asked.map(issue), truncated: false },
    );
    const truncated: string[][] = [];
    const result = await confirmStillMatching(client, 'project = AB', keys(120), {
      onBatchTruncated: (batch) => truncated.push([...batch]),
    });

    expect(result.checked.size).toBe(70);
    expect(result.checked.has('AB-51')).toBe(false);
    // Not even the issue it did hand back counts, or the batch would half-answer.
    expect(result.matching.has('AB-51')).toBe(false);
    expect(truncated).toHaveLength(1);
    expect(truncated[0]).toHaveLength(50);
  });

  // Asked, and JIRA says no: the only shape that lets a card off the board.
  it('separates "asked and still matching" from "asked and gone"', async () => {
    const client = fakeSearcher(() => ({ issues: [issue('AB-1')], truncated: false }));
    const result = await confirmStillMatching(client, 'project = AB', ['AB-1', 'AB-2']);
    expect([...result.checked].sort()).toEqual(['AB-1', 'AB-2']);
    expect([...result.matching]).toEqual(['AB-1']);
  });

  it("answers in the caller's spelling of a key, not JIRA's", async () => {
    const client = fakeSearcher(() => ({ issues: [issue('AB-1')], truncated: false }));
    const result = await confirmStillMatching(client, 'project = AB', ['ab-1']);
    expect(result.matching.has('ab-1')).toBe(true);
  });

  // Keys come out of our own SQLite, but a key is still a value being pasted into a query.
  it('never asks about a value that is not shaped like an issue key', async () => {
    const client = fakeSearcher();
    const result = await confirmStillMatching(client, 'project = AB', [
      'AB-1',
      'AB-1) OR (project = SECRET',
    ]);
    expect(client.calls[0]).toBe('(project = AB) AND key in (AB-1)');
    // And it is not in `checked` either: nothing may be concluded from its absence.
    expect([...result.checked]).toEqual(['AB-1']);
  });

  it('asks each distinct key once, however many times it was passed', async () => {
    const client = fakeSearcher();
    await confirmStillMatching(client, 'project = AB', ['AB-1', 'AB-1', 'AB-2']);
    expect(keysOf(client.calls[0])).toEqual(['AB-1', 'AB-2']);
  });

  it('asks for a batch with headroom, so a full batch does not read as truncated', async () => {
    const searchAll = vi.fn().mockResolvedValue({ issues: [], truncated: false });
    await confirmStillMatching({ searchAll }, 'project = AB', keys(50));
    expect(searchAll.mock.calls[0][1]).toMatchObject({ limit: 51 });
  });
});

describe('recheckByKey', () => {
  it('asks by key alone — the board query is not part of the question', async () => {
    const client = fakeSearcher();
    const result = await recheckByKey(client, ['AB-1', 'AB-2'], { extraFields: ['customfield_1'] });
    expect(client.calls).toEqual(['key in (AB-1, AB-2)']);
    expect(result.issues.map((i) => i.key)).toEqual(['AB-1', 'AB-2']);
    expect([...result.checked].sort()).toEqual(['AB-1', 'AB-2']);
  });

  it('makes no request for an empty key list', async () => {
    const client = fakeSearcher();
    const result = await recheckByKey(client, []);
    expect(client.calls).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it('batches at 50 and keeps the surviving batches when one fails', async () => {
    const client = fakeSearcher((_jql, asked) => {
      if (asked.includes('AB-51')) throw new Error('JIRA 400');
      return { issues: asked.map(issue), truncated: false };
    });
    const result = await recheckByKey(client, keys(120));
    expect(client.calls).toHaveLength(3);
    expect(result.checked.size).toBe(70);
    // A key whose batch failed is absent from BOTH sets, which is what stops the reconciler
    // reading "not in the answer" as "deleted in JIRA".
    expect(result.checked.has('AB-51')).toBe(false);
    expect(result.issues.some((i) => i.key === 'AB-51')).toBe(false);
    expect(result.issues).toHaveLength(70);
  });

  it('passes the discovered custom fields through to the search', async () => {
    const searchAll = vi.fn().mockResolvedValue({ issues: [], truncated: false });
    await recheckByKey({ searchAll }, ['AB-1'], { extraFields: ['customfield_9'] });
    expect(searchAll.mock.calls[0][1]).toMatchObject({ extraFields: ['customfield_9'] });
  });
});
