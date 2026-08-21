/**
 * Pure view logic for the Personal access tokens pane — copy and sorting, with no DOM. This
 * workspace has no jsdom and no `@testing-library` (`test/shell-parity.test.ts`), so anything
 * worth asserting about the pane has to live in functions like these rather than in a
 * component test.
 */
import type { PersonalAccessToken } from '@tm/protocol/wire';
import { PAT_DEFAULT_EXPIRY_DAYS, PAT_EXPIRY_CHOICES } from '@tm/protocol/wire';

export { PAT_DEFAULT_EXPIRY_DAYS, PAT_EXPIRY_CHOICES };

const DAY_MS = 24 * 60 * 60 * 1000;

/** `'Never expires'`, `'Expired'`, `'Expires today'`, or `'Expires in N days'`. */
export function describeExpiry(pat: Pick<PersonalAccessToken, 'expiresAt'>, now: number): string {
  if (pat.expiresAt === null) return 'Never expires';
  if (pat.expiresAt <= now) return 'Expired';
  const days = Math.ceil((pat.expiresAt - now) / DAY_MS);
  return days <= 1 ? 'Expires today' : `Expires in ${days} days`;
}

/** `'Never used'`, `'Used today'`, or `'Used N days ago'`. */
export function describeLastUsed(
  pat: Pick<PersonalAccessToken, 'lastUsedAt'>,
  now: number,
): string {
  if (pat.lastUsedAt === null) return 'Never used';
  const elapsed = Math.max(0, now - pat.lastUsedAt);
  if (elapsed < DAY_MS) return 'Used today';
  const days = Math.floor(elapsed / DAY_MS);
  return days === 1 ? 'Used 1 day ago' : `Used ${days} days ago`;
}

/** Active tokens first, then newest first within each group — a revoked token sinks to the bottom. */
export function sortTokens(tokens: readonly PersonalAccessToken[]): PersonalAccessToken[] {
  return [...tokens].sort((a, b) => {
    const aActive = a.revokedAt === null;
    const bActive = b.revokedAt === null;
    if (aActive !== bActive) return aActive ? -1 : 1;
    return b.createdAt - a.createdAt;
  });
}

/** Same shape the server enforces (`tokens.controller.ts`'s `cleanName`) — a string or null. */
export function validateTokenName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'A token needs a name.';
  if (trimmed.length > 100) return 'A token name may be at most 100 characters.';
  return null;
}
