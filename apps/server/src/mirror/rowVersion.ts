/**
 * SQL Server ROWVERSION columns are 8-byte big-endian binary values, unique
 * and increasing across the whole database. The wire contract
 * (@tm/protocol/wire) carries a cursor as an opaque string — these are the
 * two conversions and the one comparison every place that touches a
 * `rowVersion` column needs, kept in one pure module so a byte-order mistake
 * only has to be caught once.
 */

const HEX_PREFIX = '0x';

/** The lowest possible rowversion — "nothing synced yet". Always 8 bytes of zero. */
export const ZERO_ROWVERSION = Buffer.alloc(8, 0);

/** A rowversion buffer, as the opaque cursor string the wire contract carries. */
export function rowVersionToCursor(value: Buffer): string {
  return HEX_PREFIX + value.toString('hex');
}

/**
 * The inverse of {@link rowVersionToCursor}. Accepts the cursor with or
 * without its `0x` prefix — a caller that stored it verbatim from SQL
 * Server's own `sys.fn_varbintohexstr` output would already have one.
 */
export function cursorToRowVersion(cursor: string): Buffer {
  const hex = cursor.startsWith(HEX_PREFIX) ? cursor.slice(HEX_PREFIX.length) : cursor;
  return Buffer.from(hex, 'hex');
}

/**
 * The later (bytewise-greater) of two rowversions, treating `null` as
 * "no rowversion seen yet" rather than as a value to compare — so folding a
 * possibly-empty table's result into a running max never needs a separate
 * "is this the first one" branch at the call site.
 */
export function maxRowVersion(a: Buffer | null, b: Buffer | null): Buffer | null {
  if (a === null) return b;
  if (b === null) return a;
  return Buffer.compare(a, b) >= 0 ? a : b;
}
