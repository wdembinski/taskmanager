import { describe, expect, it } from 'vitest';
import { chunkKeys, isIssueKey, keysInJql, withKeysIn } from './jiraJql';

describe('isIssueKey', () => {
  it('accepts real keys, including digits and underscores in the project', () => {
    expect(isIssueKey('AB-1')).toBe(true);
    expect(isIssueKey('PROJ2-1234')).toBe(true);
    expect(isIssueKey('MY_TEAM-7')).toBe(true);
    expect(isIssueKey(' AB-1 ')).toBe(true);
  });

  it('rejects anything else, whatever the store happens to be holding', () => {
    for (const bad of ['', '-1', 'AB-', 'AB', '1AB-2', 'AB-1.5', 'AB 1', null, undefined, 42]) {
      expect(isIssueKey(bad)).toBe(false);
    }
  });
});

describe('keysInJql', () => {
  it('builds the clause and de-duplicates', () => {
    expect(keysInJql(['AB-1', 'AB-2', 'AB-1'])).toBe('key in (AB-1, AB-2)');
  });

  it('returns nothing when there is nothing valid to ask about', () => {
    expect(keysInJql([])).toBe('');
    expect(keysInJql(['nonsense'])).toBe('');
  });
});

describe('withKeysIn', () => {
  it('drops the sort — a membership test over a handful of keys has nothing to order', () => {
    expect(withKeysIn('project = AB ORDER BY rank ASC', ['AB-1'])).toBe(
      '(project = AB) AND key in (AB-1)',
    );
  });

  // A top-level OR would otherwise bind `key in (...)` to the last branch alone, and the
  // query would answer "every issue assigned to me, plus these keys I reported".
  it('parenthesises a filter ending in a top-level OR', () => {
    expect(withKeysIn('assignee = currentUser() OR reporter = currentUser()', ['AB-1'])).toBe(
      '(assignee = currentUser() OR reporter = currentUser()) AND key in (AB-1)',
    );
  });

  it('asks for the bare keys when the board has no filter of its own', () => {
    expect(withKeysIn('', ['AB-1', 'AB-2'])).toBe('key in (AB-1, AB-2)');
    expect(withKeysIn('   ORDER BY updated DESC', ['AB-1'])).toBe('key in (AB-1)');
  });

  // The whole point of validating: a malformed stored key must not become extra JQL.
  it('rejects a malformed key rather than interpolating it', () => {
    const jql = 'project = AB';
    expect(withKeysIn(jql, ['AB-1) OR project = SECRET', 'AB-2'])).toBe(
      '(project = AB) AND key in (AB-2)',
    );
    // No key survives ⇒ no query at all, because the filter alone matches the board.
    expect(withKeysIn(jql, ['AB-1) OR project = SECRET'])).toBe('');
    expect(withKeysIn(jql, [])).toBe('');
  });
});

describe('chunkKeys', () => {
  const keys = (n: number): string[] => Array.from({ length: n }, (_, i) => `AB-${i + 1}`);

  it('chunks at the batch size', () => {
    expect(chunkKeys(keys(0))).toEqual([]);
    expect(chunkKeys(keys(1))).toEqual([['AB-1']]);
    expect(chunkKeys(keys(50)).map((c) => c.length)).toEqual([50]);
    expect(chunkKeys(keys(51)).map((c) => c.length)).toEqual([50, 1]);
    expect(chunkKeys(keys(120)).map((c) => c.length)).toEqual([50, 50, 20]);
  });

  it('keeps every key exactly once, in order', () => {
    const flat = chunkKeys(keys(120)).flat();
    expect(flat).toEqual(keys(120));
  });

  it('takes a custom size and never degenerates to a zero step', () => {
    expect(chunkKeys(keys(5), 2).map((c) => c.length)).toEqual([2, 2, 1]);
    expect(chunkKeys(keys(3), 0)).toEqual([['AB-1'], ['AB-2'], ['AB-3']]);
  });
});
