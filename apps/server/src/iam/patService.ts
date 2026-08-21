import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { IsNull, type DataSource, type Repository } from 'typeorm';
import type {
  CreatePatRequest,
  CreatedPersonalAccessToken,
  PersonalAccessToken as WirePat,
  PersonalAccessTokenList,
} from '@tm/protocol/wire';
import { PersonalAccessToken } from '../entities/personalAccessToken.entity';
import { AuthCache } from './authCache';
import { expiresAtFor, hashPat, looksLikePat, mintPatSecret, patUsable } from './pat';

/** How long a successful PAT resolution is reused before the database is asked again. */
export const PAT_CACHE_TTL_MS = 5_000;

/** How often `touch` is allowed to actually write `lastUsedAt`. */
export const PAT_LAST_USED_FLUSH_MS = 60_000;

/** Soft ceiling on how many un-revoked tokens one account may hold at once. */
export const PAT_MAX_ACTIVE_TOKENS = 20;

export type PatResolution =
  | { ok: true; accountId: string; tokenId: string }
  | { ok: false; reason: 'unknown' | 'revoked' | 'expired' };

/**
 * Where a bearer meets the database: mint, list, revoke, and — the one on the hot path —
 * resolve a bearer to the account it speaks for.
 *
 * THE CACHE, AND HOW IT DIFFERS FROM `authCache.ts`'S TWO
 * ---------------------------------------------------------
 * `resolve` is backed by an {@link AuthCache}, same class `IamAuthGuard` uses for its IAM
 * round trips, but the case for it here is different in three ways:
 *
 * - **Shorter TTL.** `authCache.ts`'s own justification is network hops to an external
 *   service; a PAT resolution is one indexed `SELECT` against the database the request is
 *   about to hit anyway. Still worth caching — a 2GB Basic-tier database does not want 5-10
 *   extra round trips a second on one hot row — but the case is weaker, so revocation latency
 *   should be cheaper. Hence {@link PAT_CACHE_TTL_MS} rather than `AUTH_CACHE_TTL_MS`.
 * - **Keyed on the hash, never the raw token.** The IAM caches key on the raw token because
 *   they have nothing else to key on before introspection has run. Here the hash IS the
 *   lookup key, so the map is not a bag of live credentials.
 * - **Successes only.** `AuthCache.get` never caches a rejection — see its own docstring —
 *   which is exactly the property this needs: someone who has just revoked a token must not
 *   watch it keep working for `PAT_CACHE_TTL_MS` more. A miss (unknown, revoked, expired)
 *   falls straight through to a cheap indexed query every time, which the `looksLikePat` shape
 *   check ahead of it makes affordable even under a guessing loop.
 *
 * Revoking through THIS process is instant, via `invalidate`. Revoking through another one
 * takes up to `PAT_CACHE_TTL_MS` to be felt on this process — the same single-replica pin
 * already documented in `docs/09-deploying-the-cloud-service.md` for the IAM caches and the
 * media token registry is what keeps that "another process" case from existing at all.
 *
 * `PAT_MAX_ACTIVE_TOKENS` exists for the reason `authCache.ts` names for its own bound:
 * unbounded rows keyed by credential is a leak with a bad name. Twenty is generous for one
 * account's machines and still a wall against a script that mints one token per run.
 */
@Injectable()
export class PatService {
  private readonly logger = new Logger(PatService.name);
  private readonly cache = new AuthCache<CachedPat>(PAT_CACHE_TTL_MS);
  private readonly lastFlush = new Map<string, number>();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private get repo(): Repository<PersonalAccessToken> {
    return this.dataSource.getRepository(PersonalAccessToken);
  }

  /**
   * A bearer to the account it speaks for, or the reason it does not.
   *
   * Order matters and is the whole point: `looksLikePat` first, so a bearer that is not
   * PAT-shaped (an IAM token, garbage) never reaches the cache or the database at all. Then
   * the cache, keyed on the hash. Only on a miss does an indexed `findOne` run, and only then
   * is `patUsable` asked whether the row it found is still good.
   */
  async resolve(bearer: string, now: number = Date.now()): Promise<PatResolution> {
    if (!looksLikePat(bearer)) return { ok: false, reason: 'unknown' };
    const hash = hashPat(bearer);

    try {
      const hit = await this.cache.get(hash, () => this.lookup(hash, now));
      return { ok: true, accountId: hit.accountId, tokenId: hit.tokenId };
    } catch (error) {
      if (error instanceof PatLookupFailure) return { ok: false, reason: error.reason };
      throw error;
    }
  }

  private async lookup(hash: string, now: number): Promise<CachedPat> {
    const row = await this.repo.findOne({ where: { tokenHash: hash } });
    if (!row) throw new PatLookupFailure('unknown');

    const usability = patUsable(
      { expiresAt: numOrNull(row.expiresAt), revokedAt: numOrNull(row.revokedAt) },
      now,
    );
    if (usability !== 'ok') throw new PatLookupFailure(usability);

    return { accountId: row.accountId, tokenId: row.id };
  }

  /** Mint a fresh token for this account, refusing past `PAT_MAX_ACTIVE_TOKENS`. */
  async create(
    accountId: string,
    request: CreatePatRequest,
    now: number = Date.now(),
  ): Promise<CreatedPersonalAccessToken> {
    const active = await this.repo.count({ where: { accountId, revokedAt: IsNull() } });
    if (active >= PAT_MAX_ACTIVE_TOKENS) {
      throw new ConflictException(
        `This account already has ${PAT_MAX_ACTIVE_TOKENS} active tokens — revoke one before creating another.`,
      );
    }

    const minted = mintPatSecret();
    const expiresAt = expiresAtFor(now, request.expiresInDays);
    const row: PersonalAccessToken = {
      id: randomUUID(),
      accountId,
      tokenHash: minted.hash,
      name: request.name,
      hint: minted.hint,
      createdAt: new Date(now),
      expiresAt: expiresAt === null ? null : String(expiresAt),
      revokedAt: null,
      lastUsedAt: null,
    };
    const saved = await this.repo.save(row);
    // The secret leaves the process exactly once, on this return value. Nothing past this
    // point ever holds it again — the row carries only `tokenHash`.
    return { token: minted.token, pat: toWire(saved) };
  }

  /** Every token this account holds, newest first — never the secret, never the hash. */
  async list(accountId: string): Promise<PersonalAccessTokenList> {
    const rows = await this.repo.find({ where: { accountId }, order: { createdAt: 'DESC' } });
    return { tokens: rows.map(toWire) };
  }

  /**
   * Revoke one token. An id that exists but belongs to another account is reported the same
   * as an id that does not exist at all — a 404, not a 403 — the same reasoning
   * `attachments.controller.ts` uses for a blob that is not the caller's: confirming that an
   * id EXISTS for somebody else is itself a leak.
   */
  async revoke(accountId: string, id: string, now: number = Date.now()): Promise<void> {
    const row = await this.repo.findOne({ where: { id, accountId } });
    if (!row) throw new NotFoundException('No such token.');

    await this.repo.update({ id }, { revokedAt: String(now) });
    this.invalidate(row.tokenHash);
  }

  /** Forget a cached resolution — called by `revoke`, so this process feels it immediately. */
  invalidate(hash: string): void {
    this.cache.invalidate(hash);
  }

  /**
   * Record that a token just authorized a request, throttled to once per
   * `PAT_LAST_USED_FLUSH_MS`. Fire-and-forget: a slow `UPDATE` must never add latency to the
   * guarded request it is only bookkeeping for.
   *
   * The caller's job, not this method's: never call this on a rejected resolution. The useful
   * question `lastUsedAt` answers is when the legitimate holder last synced, and a revoked
   * token whose `lastUsedAt` keeps creeping forward from an attacker's retries would make the
   * web token list lie about that.
   */
  touch(tokenId: string, now: number = Date.now()): void {
    const last = this.lastFlush.get(tokenId);
    if (last !== undefined && now - last < PAT_LAST_USED_FLUSH_MS) return;
    this.lastFlush.set(tokenId, now);

    void this.repo
      .update({ id: tokenId }, { lastUsedAt: String(now) })
      .catch((error: unknown) =>
        this.logger.warn(`Failed to record a PAT's last-used time: ${String(error)}`),
      );
  }
}

interface CachedPat {
  accountId: string;
  tokenId: string;
}

class PatLookupFailure extends Error {
  constructor(readonly reason: 'unknown' | 'revoked' | 'expired') {
    super(`PAT lookup failed: ${reason}`);
  }
}

function toWire(row: PersonalAccessToken): WirePat {
  return {
    id: row.id,
    name: row.name,
    hint: row.hint,
    createdAt: row.createdAt.getTime(),
    expiresAt: numOrNull(row.expiresAt),
    revokedAt: numOrNull(row.revokedAt),
    lastUsedAt: numOrNull(row.lastUsedAt),
  };
}

function numOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}
