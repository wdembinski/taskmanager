/**
 * The draft store behind `useDraft`.
 *
 * The hook itself needs a DOM to test and this suite has none, so what is pinned here is
 * the store's contract — which is where the behaviour that matters lives:
 *
 *  - a draft is keyed to one card AND one field, so two cards' descriptions, or a card's
 *    description and its reply, can never be handed to each other;
 *  - parking is one decision, not two: a field worth coming back to is stored, and one
 *    that is not actively CLEARS whatever was parked before — otherwise a description you
 *    saved would be restored over the card's own text the next time you opened it;
 *  - the store outlives every component, which is the whole point of it being a module.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { clearDrafts, draftKey, forgetDraft, hasDraft, parkDraft, readDraft } from './drafts';

beforeEach(() => clearDrafts());

describe('draftKey', () => {
  it('separates two fields of the same card', () => {
    expect(draftKey('t1', 'description')).not.toBe(draftKey('t1', 'reply'));
  });

  it('separates the same field of two cards', () => {
    expect(draftKey('t1', 'description')).not.toBe(draftKey('t2', 'description'));
  });
});

describe('parkDraft', () => {
  it('gives back what was parked, under that key alone', () => {
    parkDraft(draftKey('t1', 'description'), 'half a sentence', true);
    expect(readDraft(draftKey('t1', 'description'))).toBe('half a sentence');
    expect(readDraft(draftKey('t1', 'reply'))).toBeUndefined();
    expect(readDraft(draftKey('t2', 'description'))).toBeUndefined();
  });

  it('drops an older draft when there is nothing worth keeping', () => {
    const key = draftKey('t1', 'description');
    parkDraft(key, 'half a sentence', true);
    // The card was opened again, the edit was saved, and the field now matches the card.
    parkDraft(key, 'the saved text', false);
    expect(hasDraft(key)).toBe(false);
  });

  it('parks a value that is falsy but deliberate', () => {
    // Emptying a description IS an edit; `has` is the test, not truthiness.
    const key = draftKey('t1', 'description');
    parkDraft(key, '', true);
    expect(hasDraft(key)).toBe(true);
    expect(readDraft(key)).toBe('');
  });

  it('keeps whatever shape the field holds', () => {
    // The composer's value is an object — text, mentions and files together.
    const key = draftKey('t1', 'comment');
    const value = { text: 'see the log', mentions: [], attachments: ['/tmp/log.txt'] };
    parkDraft(key, value, true);
    expect(readDraft(key)).toEqual(value);
  });
});

describe('forgetDraft', () => {
  it('leaves the other fields of the card alone', () => {
    parkDraft(draftKey('t1', 'description'), 'a', true);
    parkDraft(draftKey('t1', 'reply'), 'b', true);
    forgetDraft(draftKey('t1', 'description'));
    expect(hasDraft(draftKey('t1', 'description'))).toBe(false);
    expect(readDraft(draftKey('t1', 'reply'))).toBe('b');
  });

  it('is silent about a key that never had one', () => {
    expect(() => forgetDraft(draftKey('nobody', 'description'))).not.toThrow();
  });
});
