import { describe, expect, it } from 'vitest';
import { boardCursor, type ReadPage } from './boardCursor';
import { ZERO_ROWVERSION } from './rowVersion';

/** A rowversion is 8 big-endian bytes; a small integer is enough to order them by. */
function rv(n: number): Buffer {
  const buffer = Buffer.alloc(8, 0);
  buffer.writeUInt32BE(n, 4);
  return buffer;
}

function page(last: number | null, hasMore = false): ReadPage {
  return { last: last === null ? null : rv(last), hasMore };
}

describe('boardCursor', () => {
  it('takes the highest row when every stream was read to the end', () => {
    expect(boardCursor([page(500), page(603), page(12)], null)).toEqual(rv(603));
  });

  it('holds at a truncated stream rather than skipping past its unread rows', () => {
    // The regression this module exists for: 600 tasks on rowversions 1..600 paged at 500,
    // three projects on 601..603 read whole. Taking the max would answer 603, and tasks
    // 501..600 would never be asked for again.
    expect(boardCursor([page(500, true), page(603), page(0)], null)).toEqual(rv(500));
  });

  it('holds at the LOWEST truncated stream when more than one was cut short', () => {
    expect(boardCursor([page(500, true), page(410, true), page(900)], null)).toEqual(rv(410));
  });

  it('is unaffected by a truncated stream that reached further than every other', () => {
    // A ceiling above everything delivered is no constraint in practice, and must not read
    // as one: the answer is still that stream's own last row.
    expect(boardCursor([page(900, true), page(120), page(30)], null)).toEqual(rv(900));
  });

  it('always advances past the `since` it was asked from', () => {
    // A truncated page's rows are all strictly past `since`, so a ceiling can never clamp
    // the cursor back onto the position the caller already had — which would spin its poll.
    const cursor = boardCursor([page(41, true), page(4000)], rv(40));
    expect(Buffer.compare(cursor, rv(40))).toBeGreaterThan(0);
  });

  it('stays where the caller was when nothing has changed', () => {
    expect(boardCursor([page(null), page(null), page(null)], rv(77))).toEqual(rv(77));
  });

  it('answers zero for an empty first read', () => {
    expect(boardCursor([page(null), page(null)], null)).toEqual(ZERO_ROWVERSION);
  });

  it('ignores a truncated stream that delivered nothing, rather than freezing', () => {
    // `rowsSince` cannot produce this (its byte cap always keeps the first row), but a
    // ceiling of "nowhere" would pin the cursor at `since` forever while `hasMore` kept the
    // browser polling straight through — a hot loop is not a safer failure than a re-read.
    expect(boardCursor([page(null, true), page(88)], null)).toEqual(rv(88));
  });
});
