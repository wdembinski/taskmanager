/**
 * The codec for a section's fold state as it round-trips through per-device storage
 * (`localStorage`), which only ever holds strings. Kept pure so the "what counts as true"
 * rule is testable without a DOM.
 */

/** `'1'`/`'0'` as booleans; anything else — including a never-written key — is `fallback`. */
export function parseFold(raw: string | null | undefined, fallback: boolean): boolean {
  if (raw === '1') return true;
  if (raw === '0') return false;
  return fallback;
}
