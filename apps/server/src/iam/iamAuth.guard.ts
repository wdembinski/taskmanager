import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import type { Request } from 'express';
import { devNoAuthEnabled } from '../config/devAuthGate';
import { DEV_ACCOUNT_ID } from '../mirror/devAccount';
import { ensureAccount } from './ensureAccount';
import { IAM_CLIENT } from './iam.tokens';
import type { IamClient } from './iam.client';

/** The resource type every mirror-API request is authorized against — see `@vipper/iam-connector`'s
 * README, where the npm registry's equivalent is `'npm-registry'`. */
const RESOURCE_TYPE = 'taskmanager';

/**
 * Guards every `/v1/*` route (`MirrorController`, `PresenceController`): introspect the
 * bearer, then ask IAM whether the resulting subject may perform this request's action on
 * `{ resourceType: 'taskmanager', identifier: accountId }`. Attaches the resolved `accountId`
 * to the request so `@AccountId()` can hand it to the controller — nothing past this guard
 * touches `DEV_ACCOUNT_ID` directly anymore.
 *
 * `CLOUD_DEV_NO_AUTH=1` still short-circuits straight to {@link DEV_ACCOUNT_ID}, same as
 * `DevNoAuthGuard` used to — but that is now the ONE path this guard special-cases, not a
 * separate guard class standing in for the whole thing. `../config/devAuthGate.ts`'s startup
 * check is what keeps the flag from ever reaching a production deploy.
 */
@Injectable()
export class IamAuthGuard implements CanActivate {
  constructor(
    @Inject(IAM_CLIENT) private readonly iam: IamClient,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { accountId?: string }>();

    if (devNoAuthEnabled()) {
      request.accountId = DEV_ACCOUNT_ID;
      return true;
    }

    const token = bearerToken(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token.');
    }

    const introspection = await this.iam.introspectToken(token);
    if (!introspection.active || !introspection.subject) {
      throw new UnauthorizedException('Token is not active.');
    }
    const accountId = introspection.subject;

    const decision = await this.iam.authorize({
      token,
      resourceType: RESOURCE_TYPE,
      identifier: accountId,
      action: actionFor(request),
    });
    if (!decision.allowed) {
      throw new ForbiddenException('Not authorized for this account.');
    }

    await ensureAccount(this.dataSource.manager, accountId, accountId);
    request.accountId = accountId;
    return true;
  }
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/** A `GET` (`/board`) is a read; every other `/v1/*` route (`/sync`, `/commands`, `/presence`) writes. */
function actionFor(request: Request): 'read' | 'write' {
  return request.method === 'GET' ? 'read' : 'write';
}
