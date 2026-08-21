import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  MAX_PAT_EXPIRY_DAYS,
  type CreatedPersonalAccessToken,
  type CreatePatRequest,
  type PersonalAccessTokenList,
} from '@tm/protocol/wire';
import { AccountId } from '../iam/accountId.decorator';
import { IamAuthGuard } from '../iam/iamAuth.guard';
import { InteractiveAuthGuard } from '../iam/interactiveAuth.guard';
import { PatService } from '../iam/patService';

/**
 * `POST /v1/tokens`, `GET /v1/tokens`, `DELETE /v1/tokens/:id` — the web app's Personal access
 * tokens page, and nothing else. Guarded at the controller level by both `IamAuthGuard` AND
 * `InteractiveAuthGuard`: Nest runs guards left to right, so a PAT never gets past the second
 * one. Unlike `AttachmentsController` there is no per-route exception here — every route on
 * this controller needs an interactive sign-in, so controller-level is the honest shape.
 */
@Controller('v1')
@UseGuards(IamAuthGuard, InteractiveAuthGuard)
export class TokensController {
  constructor(private readonly pats: PatService) {}

  /**
   * Mint a token. `no-store` because the response body is the only time the secret exists
   * outside the caller's own process — a cache (browser, proxy, anything in between) holding
   * onto this response is holding onto a live credential. Never logged: whatever request
   * logging exists upstream of this controller must not be given the body to write down.
   */
  @Post('tokens')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  async create(
    @AccountId() accountId: string,
    @Body() body: unknown,
  ): Promise<CreatedPersonalAccessToken> {
    const request = parseCreateRequest(body);
    return this.pats.create(accountId, request);
  }

  @Get('tokens')
  async list(@AccountId() accountId: string): Promise<PersonalAccessTokenList> {
    return this.pats.list(accountId);
  }

  @Delete('tokens/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@AccountId() accountId: string, @Param('id') id: string): Promise<void> {
    await this.pats.revoke(accountId, id);
  }
}

/** A caller-supplied create request, validated into the shape `PatService.create` trusts. */
function parseCreateRequest(body: unknown): CreatePatRequest {
  const raw = (body ?? {}) as Partial<CreatePatRequest>;
  const name = cleanName(raw.name);
  if (name.length === 0) {
    throw new BadRequestException('A token needs a name.');
  }
  if (name.length > 100) {
    throw new BadRequestException('A token name may be at most 100 characters.');
  }

  const expiresInDays = raw.expiresInDays ?? null;
  if (expiresInDays !== null) {
    if (!Number.isFinite(expiresInDays) || expiresInDays <= 0) {
      throw new BadRequestException('expiresInDays must be a positive number, or omitted.');
    }
    if (expiresInDays > MAX_PAT_EXPIRY_DAYS) {
      throw new BadRequestException(`A token may not outlive ${MAX_PAT_EXPIRY_DAYS} days.`);
    }
  }

  return { name, expiresInDays };
}

/** Control characters stripped and trimmed — same shape as `cleanFileName`. Length is the caller's job. */
function cleanName(value: string | undefined): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what must go.
  return (value ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim();
}
