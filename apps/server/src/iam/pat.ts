import { createHash, randomBytes } from 'node:crypto';
import { PAT_PREFIX, PAT_SECRET_LENGTH } from '@tm/protocol/wire';

export {
  MAX_PAT_EXPIRY_DAYS,
  PAT_DEFAULT_EXPIRY_DAYS,
  PAT_EXPIRY_CHOICES,
} from '@tm/protocol/wire';

/**
 * Pure helpers for personal access tokens: minting, shape-checking and hashing a secret, and
 * deciding whether a stored row is still usable. No Nest, no TypeORM — `patService.ts` is
 * where these meet a database and a cache.
 *
 * TWO ARGUMENTS A FUTURE READER WILL WANT TO OVERTURN
 * -----------------------------------------------------
 * **SHA-256, not bcrypt/argon2.** A password KDF exists to slow down guessing of low-entropy
 * *human* input — a KDF buys nothing against a secret that is already 32 CSPRNG bytes, because
 * there is no dictionary to run against it. It would also cost real money here: the guard that
 * checks this hash runs on every request (a 2.5s poll per client, plus `/v1/results` at
 * ~300ms while a call is in flight), and a per-row salt would turn an indexed equality lookup
 * into a table scan. No HMAC pepper either — it adds a key-rotation story against a threat the
 * entropy already defeats.
 *
 * **Not a JWT.** Same argument `apps/server/src/attachments/mediaTokens.ts` makes for media
 * tokens: there is nothing to verify offline (the process that issues these is the same one
 * that checks them), and a signed token cannot be revoked by forgetting it. Revocation is half
 * of what this feature is for.
 */

/** What minting produces: the secret to hand back once, and what the database keeps instead. */
export interface MintedPat {
  /** The full bearer value — `PAT_PREFIX` plus the secret. Never stored. */
  token: string;
  /** SHA-256 of `token`, hex, lowercase. What `tokenHash` actually holds. */
  hash: string;
  /** `PAT_PREFIX` plus the first 6 secret characters — enough to recognise a token in a list. */
  hint: string;
}

/** A fresh token: 32 CSPRNG bytes, base64url, prefixed. */
export function mintPatSecret(): MintedPat {
  const secret = randomBytes(32).toString('base64url');
  const token = PAT_PREFIX + secret;
  return { token, hash: hashPat(token), hint: PAT_PREFIX + secret.slice(0, 6) };
}

const BASE64URL_ONLY = /^[A-Za-z0-9_-]+$/;

/**
 * Shape only — prefix, exact length, base64url alphabet. This is what lets the guard route a
 * bearer to the local PAT check without a database hit; the database is what decides whether
 * the token is real.
 */
export function looksLikePat(bearer: string): boolean {
  if (!bearer.startsWith(PAT_PREFIX)) return false;
  if (bearer.length !== PAT_PREFIX.length + PAT_SECRET_LENGTH) return false;
  return BASE64URL_ONLY.test(bearer.slice(PAT_PREFIX.length));
}

/** SHA-256 of the full token — including the prefix — hex, lowercase. */
export function hashPat(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type PatUsability = 'ok' | 'revoked' | 'expired';

/** The columns `patUsable` needs — a subset of the entity, so callers can pass a plain object. */
export interface PatUsabilityRow {
  expiresAt: number | null;
  revokedAt: number | null;
}

/**
 * Whether a stored row may still authorize a request. Revocation wins over expiry — a revoked
 * row that has also expired is reported as `'revoked'`, because that is the reason a caller
 * should be told to stop using it. The expiry boundary is `<=`, matching
 * `mediaTokens.ts`'s own `resolve()`.
 */
export function patUsable(row: PatUsabilityRow, now: number): PatUsability {
  if (row.revokedAt !== null) return 'revoked';
  if (row.expiresAt !== null && row.expiresAt <= now) return 'expired';
  return 'ok';
}

/** `expiresAt` for a freshly minted token — `null` (never) if `days` is `null` or omitted. */
export function expiresAtFor(now: number, days: number | null | undefined): number | null {
  if (days === null || days === undefined) return null;
  return now + days * 24 * 60 * 60 * 1000;
}
