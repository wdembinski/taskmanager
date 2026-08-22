import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  AddAgentProfileInput,
  AgentProfile,
  AgentProfilePatch,
  Assignment,
  AssignmentStatus,
  ClaimAssignmentInput,
  CreateAssignmentInput,
  ReportAssignmentInput,
} from '@tm/shared/agent';
import { AccountId } from '../iam/accountId.decorator';
import { IamAuthGuard } from '../iam/iamAuth.guard';
import { AgentsService } from './agents.service';

/**
 * Agent profiles and the assignment queue — `@tm/shared/agent`'s own docstring has the
 * full "why a queue" story. Guarded exactly like every other `/v1/*` route: `GET` reads,
 * everything else writes (`IamAuthGuard`'s `actionFor`).
 */
@Controller('v1')
@UseGuards(IamAuthGuard)
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get('agent-profiles')
  listProfiles(@AccountId() accountId: string): Promise<AgentProfile[]> {
    return this.agents.listProfiles(accountId);
  }

  @Post('agent-profiles')
  createProfile(
    @AccountId() accountId: string,
    @Body() body: AddAgentProfileInput,
  ): Promise<AgentProfile> {
    return this.agents.createProfile(accountId, body);
  }

  @Patch('agent-profiles/:id')
  updateProfile(
    @AccountId() accountId: string,
    @Param('id') id: string,
    @Body() body: AgentProfilePatch,
  ): Promise<AgentProfile> {
    return this.agents.updateProfile(accountId, id, body);
  }

  @Delete('agent-profiles/:id')
  removeProfile(@AccountId() accountId: string, @Param('id') id: string): Promise<void> {
    return this.agents.deleteProfile(accountId, id);
  }

  @Get('assignments')
  listAssignments(
    @AccountId() accountId: string,
    @Query('status') status: AssignmentStatus | undefined,
    @Query('projectId') projectId: string | undefined,
  ): Promise<Assignment[]> {
    return this.agents.listAssignments(accountId, { status, projectId });
  }

  @Post('assignments')
  createAssignment(
    @AccountId() accountId: string,
    @Body() body: CreateAssignmentInput,
  ): Promise<Assignment> {
    return this.agents.createAssignment(accountId, body);
  }

  @Post('assignments/:id/claim')
  claim(
    @AccountId() accountId: string,
    @Param('id') id: string,
    @Body() body: ClaimAssignmentInput,
  ): Promise<Assignment> {
    return this.agents.claim(accountId, id, body);
  }

  @Post('assignments/:id/complete')
  complete(
    @AccountId() accountId: string,
    @Param('id') id: string,
    @Body() body: ReportAssignmentInput,
  ): Promise<Assignment> {
    return this.agents.report(accountId, id, body);
  }
}
