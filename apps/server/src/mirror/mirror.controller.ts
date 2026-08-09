import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  BOARD_CLIENT_HEADER,
  BOARD_FOCUS_HEADER,
  type BoardResponse,
  type CommandRequest,
  type SyncRequest,
  type SyncResponse,
} from '@tm/protocol/wire';
import { DevNoAuthGuard } from './devNoAuth.guard';
import { MirrorService } from './mirror.service';

/**
 * The mirror API: `SyncRequest`/`SyncResponse`, `CommandRequest` and
 * `BoardResponse` are `@tm/protocol/wire`'s own interfaces, accepted and
 * returned as-is rather than redeclared as NestJS DTO classes — they're
 * plain, framework-agnostic shapes shared with apps/client and apps/web, and
 * a parallel DTO class here would be exactly the kind of copy the wire
 * package exists to prevent.
 *
 * Guarded by {@link DevNoAuthGuard} until "Guard the cloud API with
 * vipper.iam" lands.
 */
@Controller('v1')
@UseGuards(DevNoAuthGuard)
export class MirrorController {
  constructor(private readonly mirror: MirrorService) {}

  @Post('sync')
  sync(@Body() body: SyncRequest): Promise<SyncResponse> {
    return this.mirror.sync(body);
  }

  @Post('commands')
  @HttpCode(HttpStatus.ACCEPTED)
  async commands(@Body() body: CommandRequest): Promise<{ ok: true }> {
    await this.mirror.enqueueCommand(body);
    return { ok: true };
  }

  @Get('board')
  board(
    @Query('since') since: string | undefined,
    @Headers(BOARD_CLIENT_HEADER) clientId: string | undefined,
    @Headers(BOARD_FOCUS_HEADER) focusHeader: string | undefined,
  ): Promise<BoardResponse> {
    return this.mirror.board(since, clientId, focusHeader === 'true');
  }
}
