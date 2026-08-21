import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';

/**
 * Short-lived tickets that authorise ONE route: `GET /v1/attachments/:id`.
 *
 * WHY A SECOND KIND OF CREDENTIAL EXISTS AT ALL
 * ---------------------------------------------
 * The reader of that route is `<img src="…">`. An `<img>` sets no headers — no
 * `Authorization`, no `X-TM-Client-Id`, nothing — so the bearer token every other `/v1` route
 * is guarded by cannot reach it. The alternatives were: fetch every image as a blob in
 * JavaScript and hand the browser an object URL (a copy of every byte in the tab's heap, and
 * no browser caching at all), or put something in the URL. This is the something.
 *
 * So it is built to be the narrowest thing that can safely live in a URL a browser will paste
 * into a referrer, log, or history entry:
 *
 * - **One scope, `media:read`.** It authorises reading blobs and literally nothing else. It
 *   cannot sync, cannot queue a command, cannot list a board. `MediaTokenGuard` is the only
 *   guard that accepts it and it is on exactly one route.
 * - **Ten minutes.** Long enough for a pane full of images to load and for a human to scroll
 *   back up; short enough that a leaked URL is worthless by the time anybody reads the log it
 *   landed in.
 * - **In memory.** Same call `PresenceRegistry` and the guard's auth caches make: a ticket
 *   that survives a restart is a decision, and this one deliberately does not. A restart
 *   costs one round trip to mint another. It is also, like those two, one more reason the
 *   service runs on a single replica — see docs/09-deploying-the-cloud-service.md.
 *
 * Tokens are 32 random bytes, base64url. Not a JWT: there is nothing to verify offline (the
 * one process that issues them is the one process that checks them), and a signed token
 * cannot be revoked by forgetting it — which is what expiry does here, for free.
 *
 * WHY `GET /v1/attachments/:id?mt=` DELIBERATELY DOES NOT ALSO ACCEPT A PAT
 * ---------------------------------------------------------------------------
 * `MediaTokenGuard` (`mediaToken.guard.ts`) reads `?mt=` and nothing else. A personal access
 * token is exactly the long-lived, full-access credential a query string exists to keep OUT
 * of a URL — referrers, browser history, proxy and server logs, a screenshot of a devtools
 * network tab all see it in plain sight, and none of them expire it in ten minutes the way
 * this ticket does. A PAT holder who wants blob bytes calls `POST /v1/media-tokens` with the
 * PAT as a bearer **header** — already behind `IamAuthGuard`, so a PAT works there for free —
 * and spends the ten-minute ticket this file mints instead. `GET /v1/events` is guarded the
 * same ordinary way and a PAT already works there too; nobody should add a `?pat=` to either
 * route.
 */

/** How long a minted token is good for. */
export const MEDIA_TOKEN_TTL_MS = 10 * 60_000;

/** The one thing a media token may do. Present so the check reads as a scope check, not a lookup. */
export const MEDIA_READ_SCOPE = 'media:read';

interface MintedToken {
  accountId: string;
  scope: string;
  expiresAt: number;
}

@Injectable()
export class MediaTokenRegistry {
  private readonly tokens = new Map<string, MintedToken>();

  /**
   * A fresh ticket for one account.
   *
   * The sweep lives HERE rather than on the read, unlike `PresenceRegistry` — and the
   * difference is which operation makes the map grow. Presence grows on a beat and is read on
   * every poll, so sweeping on the read costs nothing extra. This map grows only when a token
   * is minted (once per tab per ten minutes) and is read once per image, so sweeping on the
   * read would be the hot path paying for the cold one's mess.
   */
  issue(accountId: string, now: number = Date.now()): { token: string; expiresAt: number } {
    this.sweep(now);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + MEDIA_TOKEN_TTL_MS;
    this.tokens.set(token, { accountId, scope: MEDIA_READ_SCOPE, expiresAt });
    return { token, expiresAt };
  }

  /**
   * The account a token speaks for, or null — for an unknown token, an expired one, or one
   * whose scope is not the scope being asked for.
   *
   * Expiry is checked here as well as swept on issue, because a token that is still in the
   * map is not the same thing as a token that is still valid, and only one of those two facts
   * is allowed to be the answer.
   */
  resolve(token: string, scope: string, now: number = Date.now()): string | null {
    const minted = this.tokens.get(token);
    if (!minted) return null;
    if (minted.expiresAt <= now) {
      this.tokens.delete(token);
      return null;
    }
    return minted.scope === scope ? minted.accountId : null;
  }

  /** Drops every expired token. Called on issue; exposed for the tests to pin the sweep. */
  sweep(now: number = Date.now()): void {
    for (const [token, minted] of this.tokens) {
      if (minted.expiresAt <= now) this.tokens.delete(token);
    }
  }

  /** How many tokens are being held. For the tests — nothing in the app asks. */
  size(): number {
    return this.tokens.size;
  }
}
