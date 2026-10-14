import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import type { Skill } from '@tm/shared/skills';
import type { SkillsResponse } from '@tm/protocol/wire';
import { AccountId } from '../iam/accountId.decorator';
import { IamAuthGuard } from '../iam/iamAuth.guard';
import { SkillsService } from './skills.service';

/**
 * The library skills mirror (F7.11) — `SkillMirror`'s own docstring has the full "why its
 * own endpoint" story. Guarded like every other `/v1/*` route: `GET` reads, `PUT`/`DELETE`
 * write (`IamAuthGuard`'s `actionFor`).
 */
@Controller('v1')
@UseGuards(IamAuthGuard)
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get('skills')
  list(@AccountId() accountId: string): Promise<SkillsResponse> {
    return this.skills.list(accountId);
  }

  @Put('skills/:id')
  put(
    @AccountId() accountId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Skill> {
    return this.skills.put(accountId, id, body);
  }

  @Delete('skills/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@AccountId() accountId: string, @Param('id') id: string): Promise<void> {
    return this.skills.remove(accountId, id);
  }
}
