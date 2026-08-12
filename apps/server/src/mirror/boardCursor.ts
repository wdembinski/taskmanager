/**
 * Which rowversion a paged `GET /v1/board` may hand back as its cursor — kept pure and
 * tested without a database, the way `rowVersion.ts` and `commandQueue.ts` are, because the
 * decision is arithmetic and the bug it prevents is invisible.
 *
 * WHAT WAS WRONG
 * --------------
 * `MirrorService.board` reads THREE independent streams — task mirrors, project mirrors and
 * tombstones — and pages each one separately against `BOARD_PAGE_LIMIT`. It then returned
 * the MAXIMUM rowversion across all three as the cursor, and the browser sends that straight
 * back as the next `since`.
 *
 * A rowversion is database-global, so those three streams interleave. Take an account whose
 * first backfill wrote 600 tasks and then 3 projects: the tasks land on rowversions 1..600
 * and the projects on 601..603. The first read pages the tasks at 500 (`hasMore`), reads all
 * three projects, and answers with `max(500, 603) = 603`. The next poll asks for everything
 * past 603 — and tasks 501..600 are never sent again. A hundred cards simply missing from
 * the web board, with `hasMore` having faithfully reported that there was more, until
 * somebody happens to edit each one and bump its rowversion.
 *
 * THE RULE
 * --------
 * A cursor is a promise that everything at or below it has been delivered. A stream the cap
 * cut short has only been read as far as its own last row, so the cursor cannot pass that
 * point no matter how far the other streams got. Re-sending the rows above it on the next
 * poll costs a duplicate upsert, which `cloudBoardStore.applyBoardResponse` absorbs; passing
 * it loses rows outright, which nothing ever notices.
 */
import { maxRowVersion, minRowVersion, ZERO_ROWVERSION } from './rowVersion';

/** One entity stream's read, as the cursor rule needs to see it. */
export interface ReadPage {
  /** The highest rowversion this page actually delivered — null when it delivered nothing. */
  last: Buffer | null;
  /** Whether the row or byte cap cut this stream short, leaving rows past `last` unread. */
  hasMore: boolean;
}

/**
 * The cursor for a read made up of `pages`, given the `since` it was asked from.
 *
 * Every fully-read stream contributes its last row to a running maximum; every stream that
 * was cut short imposes a ceiling at its own last row, and the lowest ceiling wins. With no
 * ceiling — nothing was truncated — the maximum stands, which is the behaviour that was
 * always correct and is what an unpaged read gave.
 *
 * Progress is guaranteed: a truncated stream's rows are all strictly past `since` (that is
 * what its query asked for) and it always keeps at least one, so a ceiling is always higher
 * than the `since` it clamps, and the next poll cannot ask the same question twice.
 *
 * A truncated page that delivered NO row would be a stream that cannot advance at all;
 * `rowsSince` never produces one (its byte cap always keeps the first row), so such a page
 * is treated as imposing no ceiling rather than as a reason to freeze the cursor and spin
 * the caller's poll loop.
 */
export function boardCursor(pages: readonly ReadPage[], since: Buffer | null): Buffer {
  let newest: Buffer | null = null;
  let ceiling: Buffer | null = null;

  for (const page of pages) {
    newest = maxRowVersion(newest, page.last);
    if (page.hasMore && page.last !== null) ceiling = minRowVersion(ceiling, page.last);
  }

  return ceiling ?? newest ?? since ?? ZERO_ROWVERSION;
}
