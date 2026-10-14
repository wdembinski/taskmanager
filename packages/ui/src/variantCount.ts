/**
 * The note beside Assign agent's ×N control (F10) — what ×N means before anyone presses it.
 *
 * ×1 is not a variant group at all, it is Assign agent's existing behaviour, so it earns no
 * note. ×2/×3 says how many sessions that starts, and names the one thing the number alone
 * does not: a project whose concurrency is below `count` runs the group one row after
 * another rather than all at once — the exact surprise a human pressing ×3 on a
 * concurrency-1 repo would otherwise only discover by watching two cards sit `pending`.
 */
import type { VariantCount } from '@tm/shared/variants';

/** ×1 is Assign agent as it always was; only ×2/×3 are a variant group. */
export type AssignCount = 1 | VariantCount;

/** The sentence under the ×N control, or null for ×1 — see the file header. */
export function variantCountNote(count: AssignCount, concurrency: number): string | null {
  if (count === 1) return null;
  const sessions = `≈ ${count} sessions`;
  return concurrency < count ? `${sessions} — runs one after another` : sessions;
}
