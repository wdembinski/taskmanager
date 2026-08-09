import { ForbiddenException, Injectable } from '@nestjs/common';
import type { CanActivate } from '@nestjs/common';
import { devNoAuthEnabled } from '../config/devAuthGate';

/**
 * Gates the mirror API (POST /v1/sync, POST /v1/commands, GET /v1/board)
 * behind `CLOUD_DEV_NO_AUTH=1` — an explicit opt-in rather than an implicit
 * "no guard configured" gap, until "Guard the cloud API with vipper.iam"
 * replaces this with the real thing. ../config/devAuthGate.ts's startup check
 * is what keeps that opt-in from ever reaching a production deploy.
 */
@Injectable()
export class DevNoAuthGuard implements CanActivate {
  canActivate(): boolean {
    if (!devNoAuthEnabled()) {
      throw new ForbiddenException(
        'The cloud API has no auth yet outside CLOUD_DEV_NO_AUTH=1 (set it for local ' +
          'development). Real auth lands in a later phase.',
      );
    }
    return true;
  }
}
