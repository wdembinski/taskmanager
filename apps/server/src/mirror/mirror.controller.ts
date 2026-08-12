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
  type ResultsResponse,
  type SyncRequest,
  type SyncResponse,
} from '@tm/protocol/wire';
import { AccountId } from '../iam/accountId.decorator';
import { IamAuthGuard } from '../iam/iamAuth.guard';
import { MirrorService } from './mirror.service';

/**
 * The mirror API: `SyncRequest`/`SyncResponse`, `CommandRequest` and
 * `BoardResponse` are `@tm/protocol/wire`'s own interfaces, accepted and
 * returned as-is rather than redeclared as NestJS DTO classes — they're
 * plain, framework-agnostic shapes shared with apps/client and apps/web, and
 * a parallel DTO class here would be exactly the kind of copy the wire
 * package exists to prevent.
 *
 * Guarded by {@link IamAuthGuard}, which resolves the caller's `accountId` —
 * read here via `@AccountId()` and threaded into every `MirrorService` call.
 */
@Controller('v1')
@UseGuards(IamAuthGuard)
export class MirrorController {
  constructor(private readonly mirror: MirrorService) {}

  @Post('sync')
  sync(@AccountId() accountId: string, @Body() body: SyncRequest): Promise<SyncResponse> {
    return this.mirror.sync(accountId, body);
  }

  @Post('commands')
  @HttpCode(HttpStatus.ACCEPTED)
  async commands(
    @AccountId() accountId: string,
    @Body() body: CommandRequest,
  ): Promise<{ ok: true }> {
    await this.mirror.enqueueCommand(accountId, body);
    return { ok: true };
  }

  @Get('board')
  board(
    @AccountId() accountId: string,
    @Query('since') since: string | undefined,
    @Headers(BOARD_CLIENT_HEADER) clientId: string | undefined,
    @Headers(BOARD_FOCUS_HEADER) focusHeader: string | undefined,
  ): Promise<BoardResponse> {
    return this.mirror.board(accountId, since, clientId, focusHeader === 'true');
  }

  /**
   * What the desktop answered, for the commands THIS caller issued — the return half of a
   * relayed `ipc-invoke`.
   *
   * The caller identifies itself with the same `X-TM-Client-Id` header `GET /v1/board` uses
   * as its presence beat, and that value is what a command's `issuedBy` was set from, so no
   * new identity is invented for this route. Without it there is no scope to read at all,
   * which is an empty answer rather than an error: a caller that cannot name itself has
   * nothing awaiting it by definition.
   */
  @Get('results')
  results(
    @AccountId() accountId: string,
    @Query('since') since: string | undefined,
    @Headers(BOARD_CLIENT_HEADER) clientId: string | undefined,
  ): Promise<ResultsResponse> {
    if (!clientId) return Promise.resolve({ results: [], cursor: since ?? '' });
    return this.mirror.resultsSince(accountId, clientId, since);
  }
}
