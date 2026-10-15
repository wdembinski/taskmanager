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
import type { WorkflowDoc } from '@tm/shared/workflow';
import type { WorkflowsResponse } from '@tm/protocol/wire';
import { AccountId } from '../iam/accountId.decorator';
import { IamAuthGuard } from '../iam/iamAuth.guard';
import { WorkflowsService } from './workflows.service';

/**
 * The workflow mirror (F8.12) — `WorkflowMirror`'s own docstring has the full "why its own
 * endpoint" story. Guarded like every other `/v1/*` route: `GET` reads, `PUT`/`DELETE`
 * write (`IamAuthGuard`'s `actionFor`).
 */
@Controller('v1')
@UseGuards(IamAuthGuard)
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get('workflows')
  list(@AccountId() accountId: string): Promise<WorkflowsResponse> {
    return this.workflows.list(accountId);
  }

  @Put('workflows/:id')
  put(
    @AccountId() accountId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<WorkflowDoc> {
    return this.workflows.put(accountId, id, body);
  }

  @Delete('workflows/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@AccountId() accountId: string, @Param('id') id: string): Promise<void> {
    return this.workflows.remove(accountId, id);
  }
}
