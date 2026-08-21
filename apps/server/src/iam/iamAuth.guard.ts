import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import type { Request } from 'express';
import { devNoAuthEnabled } from '../config/devAuthGate';
import { DEV_ACCOUNT_ID } from '../mirror/devAccount';
import { AuthCache } from './authCache';
import { ensureAccount } from './ensureAccount';
import { IAM_CLIENT } from './iam.tokens';
import type { IamClient, IntrospectionResult } from './iam.client';
import { looksLikePat } from './pat';
import { PatService, type PatResolution } from './patService';

/** The resource type every mirror-API request is authorized against — see `@vipper/iam-connector`'s
 * README, where the npm registry's equivalent is `'npm-registry'`. */
const RESOURCE_TYPE = 'taskmanager';

/**
 * What every route behind `IamAuthGuard` can rely on being set on the request. `tokens.
 * controller.ts` and `InteractiveAuthGuard` both read `authKind` without re-declaring it.
 */
export interface AuthedRequest extends Request {
  accountId?: string;
  authKind?: 'iam' | 'pat';
}

/**
 * Guards almost every `/v1/*` route — `MirrorController`, `PresenceController`,
 * `EventsController`, `TokensController`, and four of `AttachmentsController`'s five.
 * Attaches the resolved `accountId` (and how it was resolved, `authKind`) to the request so
 * `@AccountId()` can hand it to the controller — nothing past this guard touches
 * `DEV_ACCOUNT_ID` directly anymore.
 *
 * THREE WAYS IN, TRIED IN A FIXED ORDER
 * --------------------------------------
 * 1. **A PAT-shaped bearer resolves locally**, via `PatService` — no IAM round trip at all.
 * 2. **`CLOUD_DEV_NO_AUTH=1`** short-circuits to {@link DEV_ACCOUNT_ID}, same as
 *    `DevNoAuthGuard` used to.
 * 3. **Everything else** goes to vipper.iam: introspect the bearer, then ask whether the
 *    resulting subject may perform this request's action on `{ resourceType: 'taskmanager',
 *    identifier: accountId }`.
 *
 * Both orderings above the IAM path are load-bearing, not incidental:
 *
 * - **Route once, commit.** A PAT-shaped bearer that fails to resolve 401s immediately and
 *   never falls through to step 3 — falling through would ship a user's cloud PAT to an
 *   external IAM service as an introspection argument, which is not what that argument is
 *   for and not a request that service should ever see.
 * - **The PAT branch runs before the dev bypass.** `devNoAuthEnabled()` used to short-circuit
 *   before any bearer was even read. Left there, a request carrying a valid PAT would be
 *   silently attributed to `DEV_ACCOUNT_ID` instead of the token's real account — the flag is
 *   for "nothing was presented", not "something was presented and got ignored".
 *
 * The PAT path also skips `ensureAccount`: the FK from `personal_access_tokens.accountId` to
 * `accounts.id` guarantees the row already exists — the token could not have been inserted
 * otherwise. Resist the instinct to "be safe" and upsert on every poll; it is dead weight on
 * the hottest path in the service.
 */
@Injectable()
export class IamAuthGuard implements CanActivate {
  /**
   * Both IAM answers, cached for a few seconds — see `authCache.ts` for the argument.
   *
   * Two caches rather than one because the two calls are keyed differently: introspection
   * depends on the token alone, while authorization depends on the token AND the action, and
   * a read must not be allowed to authorize a write. Both live on the guard instance, which
   * NestJS holds as a singleton per module, so they are per-process and die with it —
   * deliberately not a shared store: a cached authorization is an optimisation, and one that
   * survives a restart is a decision.
   */
  private readonly introspections = new AuthCache<IntrospectionResult>();
  private readonly authorizations = new AuthCache<boolean>();

  constructor(
    @Inject(IAM_CLIENT) private readonly iam: IamClient,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pats: PatService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = bearerToken(request.headers.authorization);

    if (token && looksLikePat(token)) {
      return this.canActivateForPat(request, token);
    }

    if (devNoAuthEnabled()) {
      request.accountId = DEV_ACCOUNT_ID;
      request.authKind = 'iam';
      return true;
    }

    if (!token) {
      throw new UnauthorizedException('Missing bearer token.');
    }

    const introspection = await this.introspections.get(token, () =>
      this.iam.introspectToken(token),
    );
    if (!introspection.active || !introspection.subject) {
      // Drop it rather than serve "not active" for the next ten seconds to a caller who may
      // well be holding a freshly refreshed token by then.
      this.introspections.invalidate(token);
      throw new UnauthorizedException('Token is not active.');
    }
    const accountId = introspection.subject;

    const action = actionFor(request);
    // A NUL between the two parts, not a space: the separator has to be a character that
    // cannot occur in either half, or two different (action, token) pairs could spell one
    // cache key — and this cache decides whether a write is allowed. Written as the ESCAPE
    // rather than the raw character, which is what stood here and reads as a space in every
    // editor: a source file holding a literal NUL is one git calls BINARY, so its diffs come
    // back as `Bin <n> -> <m> bytes` with no line review and no blame — which is exactly
    // what this file did the moment the header above it was edited. Same spelling as
    // `@tm/shared/ipcEventFanout`s KEY_SEPARATOR, for the same reason.
    const allowed = await this.authorizations.get(`${action}\u0000${token}`, async () => {
      const decision = await this.iam.authorize({
        token,
        resourceType: RESOURCE_TYPE,
        identifier: accountId,
        action,
      });
      return decision.allowed;
    });
    if (!allowed) {
      throw new ForbiddenException('Not authorized for this account.');
    }

    await ensureAccount(this.dataSource.manager, accountId, accountId);
    request.accountId = accountId;
    request.authKind = 'iam';
    return true;
  }

  /**
   * The PAT branch. Committed to once entered — see the class docstring's "route once,
   * commit" rule — so a failure here throws rather than returning `false` for the caller to
   * try some other way.
   */
  private async canActivateForPat(request: AuthedRequest, token: string): Promise<boolean> {
    const resolution: PatResolution = await this.pats.resolve(token);
    if (!resolution.ok) {
      throw new UnauthorizedException(patFailureMessage(resolution.reason));
    }

    request.accountId = resolution.accountId;
    request.authKind = 'pat';
    // Fire-and-forget, and only ever on a resolution that just succeeded — see
    // `PatService.touch`'s own docstring for why a rejected resolution must never reach it.
    void this.pats.touch(resolution.tokenId);
    return true;
  }
}

function patFailureMessage(reason: 'unknown' | 'revoked' | 'expired'): string {
  switch (reason) {
    case 'revoked':
      return 'This token has been revoked.';
    case 'expired':
      return 'This token has expired.';
    case 'unknown':
      return 'This token is not recognised.';
  }
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * A `GET` is a read; every other method writes. The rule is the method, not a route list, so
 * it kept holding as routes were added without anybody coming back here: `GET /board` and
 * `GET /events` (the SSE stream — a long-lived read) authorize as reads, and `/sync`,
 * `/commands`, `/presence`, `POST /events` and the upload routes as writes.
 *
 * `GET /v1/attachments/:id` is the one route this never sees: an `<img src>` cannot set an
 * `Authorization` header, so it carries a query-string media token under `MediaTokenGuard`
 * instead — see `attachments/mediaToken.guard.ts`, and `attachments.controller.ts` for why
 * the guards there are per-route rather than one on the controller.
 */
function actionFor(request: Request): 'read' | 'write' {
  return request.method === 'GET' ? 'read' : 'write';
}
