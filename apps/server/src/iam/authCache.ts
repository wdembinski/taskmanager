/**
 * A short-TTL, bounded cache for the two IAM round trips `IamAuthGuard` makes per request.
 *
 * WHY
 * ---
 * The guard introspects the bearer AND asks `/authorize` on every single `/v1/*` call — two
 * uncached network hops. The desktop Client polls at up to 2.5s and the web tab at the same
 * cadence, so that was already four hops per second per session. Phase 26 adds a third
 * polled route (`GET /v1/results`, at ~300ms while a call is in flight), which would have
 * tripled it. IAM is not the bottleneck anyone wanted to discover in production.
 *
 * WHY THIS IS SAFE
 * ----------------
 * The TTL is short and the cached fact is not the AUTHORIZATION, it is the *answer IAM gave
 * seconds ago*. A revoked token stays usable for at most {@link AUTH_CACHE_TTL_MS}, which is
 * the same order as the poll interval it exists to protect — a caller whose token is revoked
 * mid-poll gets at most one more tick. Failures are never cached: a 500 from IAM must not
 * become a 500 for the next ten seconds, and a `false` from `/authorize` is a real answer
 * that IS cached (a denied caller retrying in a tight loop is exactly the traffic worth
 * absorbing) while a THROWN error is not.
 *
 * Keyed by the raw token, which is the only thing that identifies the caller before
 * introspection has run. That means the key is a credential held in memory — no worse than
 * the request itself holding one, and it never leaves the process.
 *
 * Bounded by count and swept lazily, because an unbounded map keyed by credential is a leak
 * with a bad name: every rotated token would keep its entry forever.
 */

/** How long an IAM answer is reused. One poll interval's worth, deliberately. */
export const AUTH_CACHE_TTL_MS = 10_000;

/** Above this many live entries, a write sweeps the expired ones first. */
export const AUTH_CACHE_MAX_ENTRIES = 1_000;

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/**
 * The cache itself: `get`-or-compute, with the computation's REJECTION passed straight
 * through uncached.
 *
 * In-flight de-duplication is deliberately not here. It would be a second mechanism (a map
 * of pending promises, plus its own failure semantics) for a case the TTL already covers:
 * the burst this protects against is sequential polls, not a thundering herd, so the second
 * caller almost always arrives after the first has resolved.
 */
export class AuthCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number = AUTH_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string, compute: () => Promise<T>): Promise<T> {
    const at = this.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > at) return hit.value;

    // Not cached inside a try/catch: a rejection must reach the caller AND leave no entry.
    const value = await compute();

    if (this.entries.size >= AUTH_CACHE_MAX_ENTRIES) this.sweep(this.now());
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    return value;
  }

  /** Forget one key — for a caller that has just been told its token is dead. */
  invalidate(key: string): void {
    this.entries.delete(key);
  }

  /** Live entry count, after dropping whatever has expired. Exposed for tests. */
  size(): number {
    this.sweep(this.now());
    return this.entries.size;
  }

  private sweep(at: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= at) this.entries.delete(key);
    }
    // Still over the cap with nothing expired: drop the oldest inserted, which `Map`
    // iteration order gives for free. A cache that refuses to evict is a leak.
    while (this.entries.size >= AUTH_CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}
