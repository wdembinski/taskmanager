import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { MEDIA_TOKEN_QUERY } from '@tm/protocol/wire';
import { MEDIA_READ_SCOPE, MediaTokenRegistry } from './mediaTokens';

/**
 * Authorises `GET /v1/attachments/:id` — and, by construction, nothing else.
 *
 * This is the ONLY guard in the service that accepts a credential from the URL, so the thing
 * worth saying about it is what it deliberately cannot do:
 *
 * - it reads `?mt=` and nothing else — a bearer header is not consulted, so this can never
 *   stand in for {@link IamAuthGuard} on a route that meant to have one;
 * - it demands the `media:read` scope, which only `POST /v1/media-tokens` ever mints;
 * - it has no dev bypass. `IamAuthGuard` short-circuits on `CLOUD_DEV_NO_AUTH=1` because
 *   without it there is no IAM to talk to; here there is nothing to bypass — the mint route
 *   is guarded by that same guard, so a dev checkout gets a real token for the dev account
 *   through the ordinary path, and this guard has one behaviour in every environment.
 *
 * It attaches the resolved account to the request exactly as `IamAuthGuard` does, so
 * `@AccountId()` works on the route behind it and the handler cannot tell (or care) which of
 * the two let the caller in. What the handler must still do is check the blob it found
 * belongs to that account — a token is an account's, not an attachment's.
 */
@Injectable()
export class MediaTokenGuard implements CanActivate {
  constructor(private readonly tokens: MediaTokenRegistry) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { accountId?: string }>();
    const raw = request.query[MEDIA_TOKEN_QUERY];
    const token = typeof raw === 'string' ? raw.trim() : '';
    if (token.length === 0) {
      throw new UnauthorizedException('Missing media token.');
    }

    const accountId = this.tokens.resolve(token, MEDIA_READ_SCOPE);
    if (!accountId) {
      throw new UnauthorizedException('Media token is not valid.');
    }

    request.accountId = accountId;
    return true;
  }
}
