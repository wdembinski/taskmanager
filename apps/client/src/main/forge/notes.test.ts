/**
 * The one rule this module exists to hold in one place: your own comments are not news.
 *
 * Everything below is written against the predicate rather than against either forge's
 * identity cache, because that separation is the point — the shape is shared, the question
 * "is this me" stays with the forge that can answer it.
 */
import { describe, expect, it } from 'vitest';
import { latestForeignNoteAt, type ForgeNote } from './notes';

const MINE = 7;
const isMine = (note: ForgeNote): boolean => note.author?.id === MINE;

const note = (at: string, authorId: number): ForgeNote => ({
  createdAt: at,
  author: { id: authorId },
});

describe('latestForeignNoteAt', () => {
  it('takes the newest note somebody else wrote', () => {
    expect(
      latestForeignNoteAt(
        [
          note('2026-07-01T10:00:00Z', 8),
          note('2026-07-03T10:00:00Z', 9),
          note('2026-07-02T10:00:00Z', 8),
        ],
        isMine,
      ),
    ).toBe(Date.parse('2026-07-03T10:00:00Z'));
  });

  // The whole reason the predicate is threaded through: a reply of your own must not put an
  // unread ring on the merge request you have just answered.
  it('ignores your own, however recent', () => {
    expect(
      latestForeignNoteAt(
        [note('2026-07-01T10:00:00Z', 8), note('2026-07-09T10:00:00Z', MINE)],
        isMine,
      ),
    ).toBe(Date.parse('2026-07-01T10:00:00Z'));
  });

  it('answers null when every note is yours', () => {
    expect(latestForeignNoteAt([note('2026-07-09T10:00:00Z', MINE)], isMine)).toBeNull();
    expect(latestForeignNoteAt([], isMine)).toBeNull();
  });

  /**
   * A note whose timestamp cannot be parsed is skipped rather than read as the epoch: a zero
   * sorts below every real note and would quietly claim the discussion had not moved.
   */
  it('skips an unparseable timestamp instead of reading it as zero', () => {
    expect(
      latestForeignNoteAt([note('not a date', 8), note('2026-07-01T10:00:00Z', 8)], isMine),
    ).toBe(Date.parse('2026-07-01T10:00:00Z'));
    expect(latestForeignNoteAt([note('not a date', 8)], isMine)).toBeNull();
  });

  // An unknown identity matches nobody, which both forges' `…AuthorIsMe` spell as `false`:
  // a merge request that shouts when it needn't is a nuisance, one that stays quiet while a
  // reviewer waits is a missed review.
  it('counts everything as foreign when nothing is known to be yours', () => {
    expect(latestForeignNoteAt([note('2026-07-09T10:00:00Z', MINE)], () => false)).toBe(
      Date.parse('2026-07-09T10:00:00Z'),
    );
  });
});
