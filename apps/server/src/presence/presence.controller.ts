import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import type { PresenceRequest, PresenceResponse } from '@tm/protocol/wire';
import { AccountId } from '../iam/accountId.decorator';
import { IamAuthGuard } from '../iam/iamAuth.guard';
import { PresenceService } from './presence.service';

/**
 * `POST /v1/presence` — the web tab's `sendBeacon` release on unload (see
 * `@tm/protocol/wire`'s own docstring on `PresenceRequest`). `POST /v1/sync` and
 * `GET /v1/board` already record a beat on every call; this route exists only for the one
 * signal neither of those carries: "I'm gone," fired outside the normal poll loop.
 *
 * Guarded by {@link IamAuthGuard}, same as the mirror routes.
 */
@Controller('v1/presence')
@UseGuards(IamAuthGuard)
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  @Post()
  beat(@AccountId() accountId: string, @Body() body: PresenceRequest): PresenceResponse {
    const cadence = this.presence.beat(accountId, body.clientId, {
      kind: 'web',
      focused: body.focused,
      at: Date.now(),
    });
    return { cadence };
  }
}
