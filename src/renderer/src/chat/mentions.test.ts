import { describe, expect, it } from 'vitest';
import {
  EMPTY_COMPOSER,
  findMentionQuery,
  insertMention,
  reconcileMentions,
  shiftMentions,
  type ComposerValue,
  type MentionRange,
} from './mentions';

const alice = { accountId: 'acc-a', displayName: 'Alice' };
const composer = (text: string, mentions: MentionRange[] = []): ComposerValue => ({
  ...EMPTY_COMPOSER,
  text,
  mentions,
});

describe('findMentionQuery', () => {
  it('finds the query the caret is inside', () => {
    expect(findMentionQuery('hi @al', 6)).toEqual({ start: 3, end: 6, query: 'al' });
  });

  it('opens on a bare @ so the picker can show everyone', () => {
    expect(findMentionQuery('hi @', 4)).toEqual({ start: 3, end: 4, query: '' });
  });

  it('allows one space, because display names have one', () => {
    expect(findMentionQuery('@Ada Lo', 7)).toMatchObject({ query: 'Ada Lo' });
    expect(findMentionQuery('@Ada Lovelace wrote', 19)).toBeNull();
  });

  it('ignores an @ that is part of a word — an email is not a mention', () => {
    expect(findMentionQuery('me@example', 10)).toBeNull();
  });

  it('does not reach across a newline', () => {
    expect(findMentionQuery('@Alice\nhello', 12)).toBeNull();
  });

  it('returns null when there is no @ behind the caret', () => {
    expect(findMentionQuery('plain text', 5)).toBeNull();
    expect(findMentionQuery('hi @al', 2)).toBeNull();
  });
});

describe('insertMention', () => {
  it('replaces the query with the label and records the range', () => {
    const { value, caret } = insertMention(composer('hi @al'), { start: 3, end: 6 }, alice);
    expect(value.text).toBe('hi @Alice ');
    expect(value.mentions).toEqual([
      { start: 3, end: 9, accountId: 'acc-a', displayName: 'Alice' },
    ]);
    expect(value.text.slice(3, 9)).toBe('@Alice');
    expect(caret).toBe(10);
  });

  it('shifts an existing mention that sits after the insertion point', () => {
    // "@Bob hi @al" — Bob occupies [0,4).
    const bob: MentionRange = { start: 0, end: 4, accountId: 'acc-b', displayName: 'Bob' };
    const { value } = insertMention(composer('@Bob hi @al', [bob]), { start: 8, end: 11 }, alice);
    expect(value.text).toBe('@Bob hi @Alice ');
    const [first, second] = value.mentions;
    expect(first).toMatchObject({ displayName: 'Bob', start: 0, end: 4 });
    expect(value.text.slice(second.start, second.end)).toBe('@Alice');
  });

  it('keeps an unresolvable person as a range with no id', () => {
    const { value } = insertMention(
      composer('@no'),
      { start: 0, end: 3 },
      { accountId: null, displayName: 'Nobody' },
    );
    expect(value.text).toBe('@Nobody ');
    expect(value.mentions[0]).toMatchObject({ accountId: null, displayName: 'Nobody' });
  });
});

describe('shiftMentions', () => {
  const at = (start: number, end: number, name = 'Alice'): MentionRange => ({
    start,
    end,
    accountId: 'x',
    displayName: name,
  });

  it('leaves a mention before the edit alone', () => {
    expect(shiftMentions([at(0, 6)], 10, 12, 5)).toEqual([at(0, 6)]);
  });

  it('moves a mention after the edit by the delta, in both directions', () => {
    expect(shiftMentions([at(10, 16)], 0, 2, 5)).toEqual([at(15, 21)]);
    expect(shiftMentions([at(10, 16)], 0, 5, -3)).toEqual([at(7, 13)]);
  });

  it('drops a mention the edit reached into — half a name is not a name', () => {
    expect(shiftMentions([at(0, 6)], 2, 4, 0)).toEqual([]);
    expect(shiftMentions([at(0, 6)], 5, 8, 0)).toEqual([]);
  });
});

describe('reconcileMentions', () => {
  const mentions = (text: string, name: string): MentionRange[] => {
    const start = text.indexOf(`@${name}`);
    return [{ start, end: start + name.length + 1, accountId: 'x', displayName: name }];
  };

  it('survives typing before the mention', () => {
    const before = 'hi @Alice';
    const after = 'hi there @Alice';
    const out = reconcileMentions(mentions(before, 'Alice'), before, after);
    expect(after.slice(out[0].start, out[0].end)).toBe('@Alice');
  });

  it('survives typing after the mention', () => {
    const before = '@Alice';
    const after = '@Alice can you look';
    const out = reconcileMentions(mentions(before, 'Alice'), before, after);
    expect(out[0]).toMatchObject({ start: 0, end: 6 });
  });

  it('survives deleting text before the mention', () => {
    const before = 'hello there @Alice';
    const after = 'hello @Alice';
    const out = reconcileMentions(mentions(before, 'Alice'), before, after);
    expect(after.slice(out[0].start, out[0].end)).toBe('@Alice');
  });

  it('drops the mention when its own text is edited', () => {
    const before = '@Alice hi';
    expect(reconcileMentions(mentions(before, 'Alice'), before, '@Alic hi')).toEqual([]);
    expect(reconcileMentions(mentions(before, 'Alice'), before, 'hi')).toEqual([]);
  });

  it('drops a mention whose offsets survive but whose text no longer matches', () => {
    // A same-length swap the prefix/suffix scan localises inside the name.
    const before = '@Alice hi';
    expect(reconcileMentions(mentions(before, 'Alice'), before, '@Alicz hi')).toEqual([]);
  });

  it('keeps the list unchanged when the text did not change', () => {
    const before = '@Alice';
    expect(reconcileMentions(mentions(before, 'Alice'), before, before)).toEqual(
      mentions(before, 'Alice'),
    );
  });

  it('handles two mentions and an edit between them', () => {
    const before = '@Alice and @Bob';
    const after = '@Alice plus @Bob';
    const list: MentionRange[] = [
      { start: 0, end: 6, accountId: 'a', displayName: 'Alice' },
      { start: 11, end: 15, accountId: 'b', displayName: 'Bob' },
    ];
    const out = reconcileMentions(list, before, after);
    expect(out).toHaveLength(2);
    expect(after.slice(out[0].start, out[0].end)).toBe('@Alice');
    expect(after.slice(out[1].start, out[1].end)).toBe('@Bob');
  });
});
